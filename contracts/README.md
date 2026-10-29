# contracts

`CaptureFlag`: records gas-sponsored captures of yakrobot robots. No tokens, no ETH.
See [../docs/architecture.md](../docs/architecture.md).

Dependencies are git submodules pinned in `foundry.lock`: forge-std v1.17.0 and
OpenZeppelin Contracts v5.7.0.

```bash
git submodule update --init --recursive
forge build
forge test
forge snapshot
```

## Deploy to Base Sepolia

Run these yourself, in your own terminal. Each `cast wallet new` asks for a keystore
password and prints only the address; the keys stay encrypted in `~/.foundry/keystores`.
Share only the addresses and transaction hashes.

```bash
# 1. Keys. The relayer pays gas for captures and for this deploy; the owner stays in your
#    browser wallet (MetaMask) and is only an address here. The player is a 0-ETH test wallet.
cast wallet new capture-flag-relayer
cast wallet new capture-flag-player

# 2. Fund the relayer address from a Base Sepolia faucet (0.01 test ETH is plenty).

# 3. Deploy (cooldown defaults to 600 s; set COOLDOWN=… to change it).
OWNER=0x<your MetaMask address> \
RELAYER=$(cast wallet address --account capture-flag-relayer) \
forge script script/Deploy.s.sol --account capture-flag-relayer \
  --rpc-url https://sepolia.base.org --broadcast

# 4. One capture by hand. Use a throwaway ROBOT_KEY so the test doesn't count toward a
#    real robot's totals.
CONTRACT=0x<deployed address> ROBOT_KEY=smoke-test.invalid/robot \
RPC_URL=https://sepolia.base.org \
PLAYER_FLAGS="--account capture-flag-player" \
RELAYER_FLAGS="--account capture-flag-relayer" \
  script/capture.sh
```

Optional source verification without an API key: `forge verify-contract <address>
src/CaptureFlag.sol:CaptureFlag --chain 84532 --verifier sourcify`.

Later, in W3, the relayer key goes into the Worker without being printed:
`cast wallet private-key --account capture-flag-relayer | npx wrangler secret put RELAYER_PRIVATE_KEY`.
