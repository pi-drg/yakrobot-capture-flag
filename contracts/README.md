# contracts

`CaptureFlag`: records gas-sponsored captures of yakrobot robots (design F1–F7 in
`../../plans/2026-10-06-capture-flag.md`). No tokens, no ETH.

Dependencies are git submodules pinned in `foundry.lock`: forge-std v1.17.0 and
OpenZeppelin Contracts v5.7.0.

```bash
git submodule update --init --recursive
forge build
forge test
forge snapshot
```
