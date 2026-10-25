// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.31;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice One capture of one robot by one player, signed by the player (EIP-712) and
/// submitted by the relayer, which pays the gas.
struct Capture {
    bytes32 robotId; // keccak256(abi.encodePacked(gatewayHost, "/", robotName))
    address player;
    uint256 nonce;
    uint256 deadline;
}

/// @title CaptureFlag
/// @notice Records gas-sponsored captures of yakrobot robots. It is a log, not a lock:
/// the robot's gateway enforces the ride. No tokens are minted or moved, and the contract
/// holds no ETH. Design: plans/2026-10-06-capture-flag.md (F1–F7).
contract CaptureFlag is EIP712, Ownable {
    bytes32 public constant CAPTURE_TYPEHASH =
        keccak256("Capture(bytes32 robotId,address player,uint256 nonce,uint256 deadline)");

    mapping(bytes32 robotId => mapping(address player => uint256)) public lastCapture;
    mapping(address player => mapping(uint256 nonce => bool)) public nonceUsed;

    // Counters: non-transferable storage, like lastCapture.
    mapping(bytes32 robotId => mapping(address player => uint256)) public captureCount;
    mapping(bytes32 robotId => uint256) public totalCaptures;
    mapping(bytes32 robotId => uint256) public uniqueCapturers;
    mapping(address player => uint256) public playerTotal;

    // The leader only, after Yoink's mostYoinks/topYoinker. The full ranking stays
    // off-chain. On a tie, whoever reached the count first keeps the lead.
    mapping(bytes32 robotId => uint256) public mostCaptures;
    mapping(bytes32 robotId => address) public topCapturer;

    uint256 public cooldown;
    address public relayer;

    event Captured(bytes32 indexed robotId, address indexed player, uint256 nonce, uint256 at);
    event RelayerSet(address indexed previous, address indexed current);
    event CooldownSet(uint256 previous, uint256 current);

    error NotRelayer();
    error Expired();
    error NonceUsed();
    error Cooldown(uint256 remaining);
    error BadSignature();
    error RenounceDisabled();

    constructor(address owner_, address relayer_, uint256 cooldown_)
        EIP712("yakrobot-capture-flag", "1")
        Ownable(owner_)
    {
        relayer = relayer_;
        cooldown = cooldown_;
        emit RelayerSet(address(0), relayer_);
        emit CooldownSet(0, cooldown_);
    }

    /// @notice Record a capture. Only the relayer may call it, so every capture flows
    /// through the Worker (design F2, W5a).
    function captureBySig(Capture calldata c, bytes calldata sig) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (block.timestamp > c.deadline) revert Expired();
        if (nonceUsed[c.player][c.nonce]) revert NonceUsed();

        uint256 last = lastCapture[c.robotId][c.player];
        if (last != 0 && block.timestamp < last + cooldown) {
            revert Cooldown(last + cooldown - block.timestamp);
        }

        // EOA signatures only; smart-contract wallets (ERC-1271) are not supported.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashCapture(c), sig);
        if (err != ECDSA.RecoverError.NoError || signer != c.player) revert BadSignature();

        nonceUsed[c.player][c.nonce] = true;
        lastCapture[c.robotId][c.player] = block.timestamp;

        uint256 n = ++captureCount[c.robotId][c.player];
        if (n == 1) uniqueCapturers[c.robotId]++;
        totalCaptures[c.robotId]++;
        playerTotal[c.player]++;
        if (n > mostCaptures[c.robotId]) {
            mostCaptures[c.robotId] = n;
            if (topCapturer[c.robotId] != c.player) topCapturer[c.robotId] = c.player;
        }

        emit Captured(c.robotId, c.player, c.nonce, block.timestamp);
    }

    /// @notice Rotate a leaked relayer key, or pass address(0) to pause all captures.
    function setRelayer(address relayer_) external onlyOwner {
        emit RelayerSet(relayer, relayer_);
        relayer = relayer_;
    }

    function setCooldown(uint256 cooldown_) external onlyOwner {
        emit CooldownSet(cooldown, cooldown_);
        cooldown = cooldown_;
    }

    /// @dev The owner is the credential for the Worker's admin page (design W7), so
    /// giving it up would leave every robot's claims stuck as they are.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice The EIP-712 digest the player signs. The Worker and the gateway check
    /// their own hashing against this (test/vectors.json).
    function hashCapture(Capture calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(CAPTURE_TYPEHASH, c.robotId, c.player, c.nonce, c.deadline))
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
