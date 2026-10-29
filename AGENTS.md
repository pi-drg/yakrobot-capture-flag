# AGENTS.md

Capture the flag for yakrobot robots: a visitor signs a free EIP-712 `Capture`, this
repo's Worker relays it to the `CaptureFlag` contract on Base, and the robot's gateway
grants a 5-minute ride.

Architecture (contract, Worker, gateway, a ride end to end, controls, limits):
[docs/architecture.md](docs/architecture.md). Keep it current when any of those change.

## Rules

- **Always ask before using `gh` or making any change on GitHub** — creating
  repositories, pushing commits, opening/closing PRs, editing settings. Local
  commits and local file edits are fine; nothing leaves this machine without
  explicit approval.
- **Never run `wrangler login`, `wrangler deploy` or `wrangler secret put`.** Those are
  the user's actions. Prepare configuration, then stop.
- **Secrets never enter the conversation, a commit, or a log line.** `RELAYER_PRIVATE_KEY`
  lives only in gitignored `worker/.dev.vars`, or as a Worker secret the user types
  themselves. The contract owner key lives in a Foundry encrypted keystore
  (`cast wallet import`), never in a file. Print derived *public addresses* only.
- **This Worker holds one gas-only hot wallet** (the relayer). It pays gas for
  `captureBySig` and nothing else; it never holds tokens or USDC, and the contract has
  no `payable` function. Its only other key is an optional CDP Secret API Key, used for
  the faucet top-up and nothing else (`src/faucet.ts`), set by the user as a secret.
- **`/admin` is behind Cloudflare Access** (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` in
  `wrangler.jsonc`, public constants). The Worker verifies the Access JWT itself
  (`src/access.ts`); keep `workers_dev` and `preview_urls` `false`, and never set
  `CF_ACCESS_CERTS_URL` outside tests. Access policies are the user's dashboard action,
  like deploys. The owner wallet is for the contract only, never the Worker.
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
