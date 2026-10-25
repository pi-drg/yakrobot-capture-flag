// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CaptureFlag, Capture} from "../src/CaptureFlag.sol";

contract CaptureFlagTest is Test {
    CaptureFlag cf;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address alice;
    uint256 aliceKey;
    address bob;
    uint256 bobKey;

    bytes32 constant ROBOT = keccak256("gateway.yakrobot.example/picar_adeept");
    bytes32 constant OTHER_ROBOT = keccak256("gateway.yakrobot.example/picar_freenove");
    uint256 constant COOLDOWN = 10 minutes;

    event Captured(bytes32 indexed robotId, address indexed player, uint256 nonce, uint256 at);

    function setUp() public {
        // A realistic clock: Foundry starts at timestamp 1.
        vm.warp(1_790_000_000);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        cf = new CaptureFlag(owner, relayer, COOLDOWN);
    }

    // --- helpers ---

    function _capture(bytes32 robotId, address player, uint256 nonce)
        internal
        view
        returns (Capture memory)
    {
        return Capture(robotId, player, nonce, block.timestamp + 10 minutes);
    }

    function _sign(uint256 key, Capture memory c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, cf.hashCapture(c));
        return abi.encodePacked(r, s, v);
    }

    function _relay(Capture memory c, bytes memory sig) internal {
        vm.prank(relayer);
        cf.captureBySig(c, sig);
    }

    function _captureAs(uint256 key, address player, bytes32 robotId, uint256 nonce) internal {
        Capture memory c = _capture(robotId, player, nonce);
        _relay(c, _sign(key, c));
    }

    function _expectRefused(Capture memory c, bytes memory sig, bytes memory err) internal {
        vm.prank(relayer);
        vm.expectRevert(err);
        cf.captureBySig(c, sig);
    }

    // --- happy path ---

    function test_capture_records_and_emits() public {
        Capture memory c = _capture(ROBOT, alice, 7);
        bytes memory sig = _sign(aliceKey, c);

        vm.expectEmit(address(cf));
        emit Captured(ROBOT, alice, 7, block.timestamp);
        _relay(c, sig);

        assertEq(cf.lastCapture(ROBOT, alice), block.timestamp);
        assertTrue(cf.nonceUsed(alice, 7));
    }

    // --- refusals ---

    function test_expired_deadline_reverts() public {
        Capture memory c = _capture(ROBOT, alice, 0);
        c.deadline = block.timestamp - 1;
        _expectRefused(c, _sign(aliceKey, c), abi.encodeWithSelector(CaptureFlag.Expired.selector));
    }

    function test_deadline_is_inclusive() public {
        Capture memory c = _capture(ROBOT, alice, 0);
        c.deadline = block.timestamp;
        _relay(c, _sign(aliceKey, c));
    }

    function test_reused_nonce_reverts() public {
        _captureAs(aliceKey, alice, ROBOT, 0);
        // Nonces are per player, not per robot.
        Capture memory c = _capture(OTHER_ROBOT, alice, 0);
        _expectRefused(
            c, _sign(aliceKey, c), abi.encodeWithSelector(CaptureFlag.NonceUsed.selector)
        );
    }

    function test_signature_from_other_key_reverts() public {
        Capture memory c = _capture(ROBOT, alice, 0);
        _expectRefused(
            c, _sign(bobKey, c), abi.encodeWithSelector(CaptureFlag.BadSignature.selector)
        );
    }

    function test_tampered_fields_revert() public {
        Capture memory signed = _capture(ROBOT, alice, 0);
        bytes memory sig = _sign(aliceKey, signed);
        bytes memory bad = abi.encodeWithSelector(CaptureFlag.BadSignature.selector);

        Capture memory c = Capture(OTHER_ROBOT, signed.player, signed.nonce, signed.deadline);
        _expectRefused(c, sig, bad);
        c = Capture(signed.robotId, bob, signed.nonce, signed.deadline);
        _expectRefused(c, sig, bad);
        c = Capture(signed.robotId, signed.player, signed.nonce + 1, signed.deadline);
        _expectRefused(c, sig, bad);
        c = Capture(signed.robotId, signed.player, signed.nonce, signed.deadline + 1);
        _expectRefused(c, sig, bad);

        _relay(signed, sig);
    }

    function test_malformed_signature_reverts() public {
        Capture memory c = _capture(ROBOT, alice, 0);
        _expectRefused(c, new bytes(64), abi.encodeWithSelector(CaptureFlag.BadSignature.selector));
    }

    function test_cooldown_reports_remaining_then_clears() public {
        _captureAs(aliceKey, alice, ROBOT, 0);

        Capture memory c = _capture(ROBOT, alice, 1);
        _expectRefused(
            c, _sign(aliceKey, c), abi.encodeWithSelector(CaptureFlag.Cooldown.selector, 10 minutes)
        );

        vm.warp(block.timestamp + 9 minutes);
        c = _capture(ROBOT, alice, 1);
        _expectRefused(
            c, _sign(aliceKey, c), abi.encodeWithSelector(CaptureFlag.Cooldown.selector, 1 minutes)
        );

        vm.warp(block.timestamp + 1 minutes);
        _captureAs(aliceKey, alice, ROBOT, 1);
        assertEq(cf.lastCapture(ROBOT, alice), block.timestamp);
    }

    function test_cooldown_is_per_robot() public {
        _captureAs(aliceKey, alice, ROBOT, 0);
        _captureAs(aliceKey, alice, OTHER_ROBOT, 1);
        assertEq(cf.lastCapture(OTHER_ROBOT, alice), block.timestamp);
    }

    // --- roles ---

    function test_only_relayer_may_capture() public {
        Capture memory c = _capture(ROBOT, alice, 0);
        bytes memory sig = _sign(aliceKey, c);
        vm.expectRevert(CaptureFlag.NotRelayer.selector);
        vm.prank(alice);
        cf.captureBySig(c, sig);
    }

    function test_rotate_relayer() public {
        address next = makeAddr("next relayer");
        vm.prank(owner);
        cf.setRelayer(next);

        Capture memory c = _capture(ROBOT, alice, 0);
        bytes memory sig = _sign(aliceKey, c);
        _expectRefused(c, sig, abi.encodeWithSelector(CaptureFlag.NotRelayer.selector));

        vm.prank(next);
        cf.captureBySig(c, sig);
    }

    function test_zero_relayer_pauses_captures() public {
        vm.prank(owner);
        cf.setRelayer(address(0));

        Capture memory c = _capture(ROBOT, alice, 0);
        _expectRefused(
            c, _sign(aliceKey, c), abi.encodeWithSelector(CaptureFlag.NotRelayer.selector)
        );
    }

    function test_setRelayer_is_owner_only() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer)
        );
        vm.prank(relayer);
        cf.setRelayer(relayer);
    }

    function test_setCooldown_is_owner_only_and_applies() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        cf.setCooldown(0);

        _captureAs(aliceKey, alice, ROBOT, 0);
        vm.prank(owner);
        cf.setCooldown(1 minutes);
        assertEq(cf.cooldown(), 1 minutes);

        vm.warp(block.timestamp + 1 minutes);
        _captureAs(aliceKey, alice, ROBOT, 1);
    }

    function test_renounce_ownership_is_disabled() public {
        vm.expectRevert(CaptureFlag.RenounceDisabled.selector);
        vm.prank(owner);
        cf.renounceOwnership();
        assertEq(cf.owner(), owner);
    }

    function test_holds_no_eth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(cf)).call{value: 1 wei}("");
        assertFalse(ok);
        assertEq(address(cf).balance, 0);
    }

    // --- counters ---

    function test_counters() public {
        _captureAs(aliceKey, alice, ROBOT, 0);
        assertEq(cf.captureCount(ROBOT, alice), 1);
        assertEq(cf.totalCaptures(ROBOT), 1);
        assertEq(cf.uniqueCapturers(ROBOT), 1);
        assertEq(cf.playerTotal(alice), 1);

        vm.warp(block.timestamp + COOLDOWN);
        _captureAs(aliceKey, alice, ROBOT, 1);
        assertEq(cf.captureCount(ROBOT, alice), 2);
        assertEq(cf.totalCaptures(ROBOT), 2);
        assertEq(cf.uniqueCapturers(ROBOT), 1, "a repeat player is not new");
        assertEq(cf.playerTotal(alice), 2);

        _captureAs(bobKey, bob, ROBOT, 0);
        assertEq(cf.totalCaptures(ROBOT), 3);
        assertEq(cf.uniqueCapturers(ROBOT), 2);

        _captureAs(aliceKey, alice, OTHER_ROBOT, 2);
        assertEq(cf.playerTotal(alice), 3, "playerTotal spans robots");
        assertEq(cf.totalCaptures(OTHER_ROBOT), 1, "robots count separately");
        assertEq(cf.uniqueCapturers(OTHER_ROBOT), 1);
        assertEq(cf.totalCaptures(ROBOT), 3);
    }

    function test_refused_capture_changes_no_counter() public {
        _captureAs(aliceKey, alice, ROBOT, 0);
        Capture memory c = _capture(ROBOT, alice, 1);
        _expectRefused(
            c, _sign(aliceKey, c), abi.encodeWithSelector(CaptureFlag.Cooldown.selector, 10 minutes)
        );

        assertEq(cf.captureCount(ROBOT, alice), 1);
        assertEq(cf.totalCaptures(ROBOT), 1);
        assertEq(cf.uniqueCapturers(ROBOT), 1);
        assertEq(cf.playerTotal(alice), 1);
        assertEq(cf.mostCaptures(ROBOT), 1);
        assertFalse(cf.nonceUsed(alice, 1));
    }

    // --- leader ---

    function test_first_capture_takes_the_lead() public {
        assertEq(cf.topCapturer(ROBOT), address(0));
        _captureAs(aliceKey, alice, ROBOT, 0);
        assertEq(cf.topCapturer(ROBOT), alice);
        assertEq(cf.mostCaptures(ROBOT), 1);
    }

    function test_a_tie_keeps_the_earlier_leader() public {
        _captureAs(aliceKey, alice, ROBOT, 0);
        _captureAs(bobKey, bob, ROBOT, 0);
        assertEq(cf.topCapturer(ROBOT), alice);
        assertEq(cf.mostCaptures(ROBOT), 1);
    }

    function test_passing_the_leader_takes_the_lead() public {
        _captureAs(aliceKey, alice, ROBOT, 0);
        _captureAs(bobKey, bob, ROBOT, 0);
        vm.warp(block.timestamp + COOLDOWN);
        _captureAs(bobKey, bob, ROBOT, 1);
        assertEq(cf.topCapturer(ROBOT), bob);
        assertEq(cf.mostCaptures(ROBOT), cf.captureCount(ROBOT, bob));

        // The leader extending their own lead stays leader.
        vm.warp(block.timestamp + COOLDOWN);
        _captureAs(bobKey, bob, ROBOT, 2);
        assertEq(cf.topCapturer(ROBOT), bob);
        assertEq(cf.mostCaptures(ROBOT), 3);
    }

    function test_each_robot_has_its_own_leader() public {
        _captureAs(aliceKey, alice, ROBOT, 0);
        _captureAs(bobKey, bob, OTHER_ROBOT, 0);
        assertEq(cf.topCapturer(ROBOT), alice);
        assertEq(cf.topCapturer(OTHER_ROBOT), bob);
    }

    // --- shared vectors (test/vectors.json, written by script/Vectors.s.sol) ---

    function test_vectors_match_the_contract() public {
        string memory json = vm.readFile("test/vectors.json");
        address verifyingContract = vm.parseJsonAddress(json, ".domain.verifyingContract");
        vm.chainId(vm.parseJsonUint(json, ".domain.chainId"));
        deployCodeTo(
            "CaptureFlag.sol:CaptureFlag", abi.encode(owner, relayer, COOLDOWN), verifyingContract
        );
        CaptureFlag at = CaptureFlag(verifyingContract);

        assertEq(at.domainSeparator(), vm.parseJsonBytes32(json, ".domainSeparator"));
        address signer = vm.parseJsonAddress(json, ".signer");
        assertEq(vm.addr(uint256(vm.parseJsonBytes32(json, ".privateKey"))), signer);

        for (uint256 i; i < 3; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            Capture memory c = Capture(
                vm.parseJsonBytes32(json, string.concat(p, ".message.robotId")),
                vm.parseJsonAddress(json, string.concat(p, ".message.player")),
                vm.parseJsonUint(json, string.concat(p, ".message.nonce")),
                vm.parseJsonUint(json, string.concat(p, ".message.deadline"))
            );
            assertEq(
                c.robotId, keccak256(bytes(vm.parseJsonString(json, string.concat(p, ".robotKey"))))
            );
            assertEq(at.hashCapture(c), vm.parseJsonBytes32(json, string.concat(p, ".digest")));

            vm.warp(c.deadline);
            vm.prank(relayer);
            at.captureBySig(c, vm.parseJsonBytes(json, string.concat(p, ".signature")));
            assertEq(at.captureCount(c.robotId, signer), 1);
        }
    }

    // --- gas (snapshots/CaptureFlagTest.json): the call's execution gas inside a test. A
    // real transaction adds 21k intrinsic, calldata and Base's L1 data fee; F2 records
    // real receipts. ---

    function test_gas_first_and_repeat_capture() public {
        Capture memory c = _capture(ROBOT, alice, 0);
        bytes memory sig = _sign(aliceKey, c);
        vm.prank(relayer);
        cf.captureBySig(c, sig);
        vm.snapshotGasLastCall("captureBySig_first");

        vm.warp(block.timestamp + COOLDOWN);
        c = _capture(ROBOT, alice, 1);
        sig = _sign(aliceKey, c);
        vm.prank(relayer);
        cf.captureBySig(c, sig);
        vm.snapshotGasLastCall("captureBySig_repeat");

        // A second player on a robot that already has a leader.
        c = _capture(ROBOT, bob, 0);
        sig = _sign(bobKey, c);
        vm.prank(relayer);
        cf.captureBySig(c, sig);
        vm.snapshotGasLastCall("captureBySig_new_player");
    }
}
