# yakrobot-capture-flag

Free, gas-sponsored "capture the flag" rides for yakrobot robots. Scan the QR sticker on
a robot, sign one message in your wallet, and drive it for 5 minutes. Each capture is one
transaction on Base that records the ride and moves no tokens.

- `contracts/`: the `CaptureFlag` contract (Foundry).
- `worker/`: the relayer and claim-page Worker (Cloudflare Workers, Hono, viem).

Status: scaffold. See [AGENTS.md](AGENTS.md) for the plan links and commands.

Licensed under Apache-2.0.
