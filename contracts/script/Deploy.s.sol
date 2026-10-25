// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.31;

import {Script, console} from "forge-std/Script.sol";
import {CaptureFlag} from "../src/CaptureFlag.sol";

/// @notice Deploys CaptureFlag. The broadcasting account only pays for the deploy; the
/// owner and relayer come from the environment, so the owner can stay in a browser
/// wallet and never needs importing into Foundry.
///
///   OWNER=0x… RELAYER=0x… [COOLDOWN=600] forge script script/Deploy.s.sol \
///     --account capture-flag-relayer --rpc-url https://sepolia.base.org --broadcast
contract Deploy is Script {
    function run() external returns (CaptureFlag cf) {
        address owner = vm.envAddress("OWNER");
        address relayer = vm.envAddress("RELAYER");
        uint256 cooldown = vm.envOr("COOLDOWN", uint256(10 minutes));
        require(owner != address(0) && relayer != address(0), "OWNER and RELAYER required");
        // F4: the owner is the cold wallet, the relayer the Worker's hot key.
        require(owner != relayer, "OWNER must differ from RELAYER");

        vm.startBroadcast();
        cf = new CaptureFlag(owner, relayer, cooldown);
        vm.stopBroadcast();

        console.log("CaptureFlag:", address(cf));
        console.log("owner:      ", owner);
        console.log("relayer:    ", relayer);
        console.log("cooldown s: ", cooldown);
        console.log("chainId:    ", block.chainid);
    }
}
