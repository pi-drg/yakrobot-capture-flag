# AGENTS.md

Capture the flag for yakrobot robots: a visitor signs a free EIP-712 `Capture`, this
repo's Worker relays it to the `CaptureFlag` contract on Base, and the robot's gateway
grants a 5-minute ride. Design: [2026-10-06-capture-flag.md](../plans/2026-10-06-capture-flag.md);
steps: [2026-10-06-capture-flag-execution.md](../plans/2026-10-06-capture-flag-execution.md).

Architecture (contract, Worker, gateway, a ride end to end, controls, limits):
[docs/architecture.md](docs/architecture.md). Keep it current when any of those change.

## Rules

- **Always ask before using `gh` or making any change on GitHub** — creating
  repositories, pushing commits, opening/closing PRs, editing settings. Local
  commits and local file edits are fine; nothing leaves this machine without
  explicit approval.
- **Never run `wrangler login`, `wrangler deploy` or `wrangler secret put`.** Those are
  the user's actions (execution plan W3). Prepare configuration, then stop.
- **Secrets never enter the conversation, a commit, or a log line.** `RELAYER_PRIVATE_KEY`
  lives only in gitignored `worker/.dev.vars`, or as a Worker secret the user types
  themselves. The contract owner key lives in a Foundry encrypted keystore
  (`cast wallet import`), never in a file. Print derived *public addresses* only.
- **This Worker holds one gas-only hot wallet** (the relayer). It pays gas for
  `captureBySig` and nothing else; it never holds tokens or USDC, and the contract has
  no `payable` function.
- **Commits are signed and signed off** (`git commit -S -s`), with short messages.

## Layout

```
yakrobot-capture-flag/
├── contracts/   # Foundry: CaptureFlag.sol, tests, test/vectors.json, Deploy script
├── docs/        # architecture.md
└── worker/      # Cloudflare Worker (Hono + viem): relayer DO, claim + admin pages
```

`contracts/test/vectors.json` pins the EIP-712 hashing shared by the contract, this
Worker and the gateway; change it only together with all three.

## Commands

```bash
cd worker && npm install && npm test     # Worker tests (workerd via @cloudflare/vitest-plugin)
cd worker && npm run dev                 # wrangler dev on :8787
cd contracts && forge test               # contract tests
```
