# Architecture

Capture the flag lets anyone drive a yakrobot robot for 5 minutes for free. A player
signs one message in their wallet (a "capture"), the game records it on Base and pays the
gas, and the robot's own gateway lets that player drive.

Three parts, run by different people:

| Part | Where | Run by | Holds |
|---|---|---|---|
| `CaptureFlag` contract | Base Sepolia `0xF3F2e69A1b00577d5d6ca1911a3a80132CD08737` (`contracts/`) | the owner wallet | the record of every capture |
| The Worker | `capture-flag.yakrobot.com` (`worker/`, Cloudflare Workers) | the game owner | the relayer key (gas only), an optional CDP faucet key, the pages, the switches |
| A gateway per robot | the friend's fixed hostname (`yakrobot-gateway`, capture-flag mode) | each friend | the robot; **no keys** |

```mermaid
flowchart LR
  P["Player's wallet<br/>(MetaMask, Coinbase Wallet)"]
  subgraph W["Worker · capture-flag.yakrobot.com"]
    Pages["Pages<br/>/ · /r/:robot · /admin"]
    API["API<br/>/capture · /robots · /health …"]
    DO["Relayer Durable Object<br/>relayer key · nonce · log · switches"]
  end
  C["CaptureFlag<br/>(Base)"]
  G["Friend's gateway<br/>(fixed hostname)"]
  R["Robot"]

  P -- "signs Capture (free)" --> Pages
  Pages --> API --> DO
  DO -- "captureBySig (pays gas)" --> C
  API -- "GET / (is it free?)" --> G
  P -- "drive: console + WebSocket" --> G
  G -- "lastCapture (read-only)" --> C
  G --> R
```

## A ride, end to end

```mermaid
sequenceDiagram
  autonumber
  actor P as Player
  participant Page as Robot page (/r/:robot)
  participant W as Worker /capture
  participant DO as Relayer DO
  participant C as CaptureFlag
  participant G as Gateway console

  P->>Page: Capture & drive
  Page->>Page: pick random k, nonce = sha256(k)
  Page->>P: eth_signTypedData_v4 Capture{robotId, player, nonce, deadline}
  P-->>Page: signature (no gas)
  Page->>W: POST /capture {typedData, sig}
  W->>W: rate limit, shape, domain, paused/disabled,<br/>deadline, signature, robot free?, cooldown
  W->>DO: capture()
  DO->>C: simulate, then captureBySig(c, sig)
  DO-->>Page: txHash
  Page->>W: poll GET /r/:robot/capture (current tx)
  Page->>Page: receipt mined
  Page->>G: redirect to /{robot}/ui#c&s&k&tx
  G->>G: verify signature, sha256(k) == nonce
  G->>C: eth_call lastCapture(robotId, player)
  G-->>P: 5-minute free lease, drive
```

The capture is public once relayed (the signature is in the calldata), so it can't be
the ride ticket on its own. The **ride secret `k`** is: the page signs
`nonce = sha256(k)` and hands `k` only to the player's own browser, in the URL fragment.
The gateway needs `sha256(k) == nonce`, so someone watching the chain can't take the
ride. Each capture rides once (the gateway remembers which have started).

## The contract

`CaptureFlag` records captures and moves no tokens.

- `captureBySig(c, sig)`, **only from the relayer**: checks the deadline, the player's
  unused nonce, the cooldown (10 min per robot per player) and the EIP-712 signature,
  then updates the counters and emits `Captured`.
- Public reads: `lastCapture`, `captureCount`, `totalCaptures`, `uniqueCapturers`,
  `playerTotal`, `mostCaptures`/`topCapturer` (ties go to whoever got there first).
- Owner only: `setRelayer` (and `setRelayer(0x0)` is the **hard stop**), `setCooldown`.
  Ownership can't be renounced.
- `robotId = keccak256(host + "/" + robot)`: the gateway's fixed hostname plus its robot
  name. A new hostname is a new robot, with counters from zero.

`contracts/test/vectors.json` pins the EIP-712 hashing that the contract, the Worker and
the gateway each implement. Change it only together with all three.

## The Worker

One Cloudflare Worker (Hono + viem) with one Durable Object.

**Pages** (single HTML files, inlined, no build step):
- `/`: every robot with its state (free, busy until HH:MM, offline, disabled) and the
  network leaderboard.
- `/r/:robot`: one robot. Status, previous drivers and the most-rides leader, the
  Capture button, and a saved Drive button for 30 minutes.
- `/admin`: the switches and the relayer top-up, behind Cloudflare Access.

**API:**

| Route | What |
|---|---|
| `POST /capture` | Every gas-free check, in order, then the relayer. 409 if the robot is busy or offline (no gas spent). |
| `GET /robots`, `GET /r/:robot/status` | The switches first, then each gateway's `GET /` (3 s timeout). `/robots` is readable from any origin (CORS `*`): the simulator's page polls it. |
| `GET /r/:robot/drivers`, `GET /leaderboard` | From the relayer's log, plus the on-chain leader and a `names` map. |
| `GET /r/:robot/capture?player&nonce` | A capture's current transaction (it may have been re-sent), or 404 if it failed. |
| `GET/POST /admin/state` | Access only. The switches and the relayer's balance; POST takes `{action, target}`. |
| `POST /admin/topup` | Access only. `TOPUP_CLAIMS` CDP faucet claims for the relayer, once a minute (Base Sepolia only). |
| `GET /health` | Relayer balance, `relayer() == ours`, unmined sends. 503 when not ok. |

**The Relayer Durable Object** is a single instance named `relayer`, and the only place
the relayer key is read. It:
- sends `captureBySig` one at a time, keeping the relayer's nonce itself;
- logs every send (SQLite: `captures`, `counts`, `totals`), complete because the
  contract only accepts the relayer;
- keeps unmined sends in `pending`. An alarm re-sends one stuck for 10 blocks with fees
  +25% (up to 3 times), or, if it would now revert, sends a no-op to free the nonce and
  marks the capture `reverted`;
- holds the switches: `paused` (the whole game, **on** after a fresh deploy) and
  `disabled:<robot>`;
- caches player names: a Base primary name (`alice.base.eth`), else a mainnet ENS name,
  both looked up through the ENS Universal Resolver on Ethereum mainnet (ENSIP-19), which
  checks the name points back to the address. Re-checked daily; looked up after the
  response, so pages never wait for them.

**Configuration** (`wrangler.jsonc`): `CHAIN`, `CONTRACT`, `ROBOTS` (slug →
`{gateway, robot, label, place}`), `RELAYER_MIN_WEI`, `DRIVERS_SHOWN`, `SENDS_PER_HOUR`,
`TOPUP_CLAIMS`. Secrets: `RELAYER_PRIVATE_KEY`, `RPC_URL`, and optionally `ENS_RPC_URL` (an
Ethereum mainnet RPC; player names are off without it) and `CDP_API_KEY_ID` +
`CDP_API_KEY_SECRET` (a CDP Secret API Key; the admin top-up is off without it). Access:
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` (public vars). Triggers: a cron every 15 minutes
that logs when `/health` fails.

**Admin login.** A self-hosted Cloudflare Access application on
`capture-flag.yakrobot.com/admin*` logs admins in by email. The Worker doesn't trust that
alone: identity reaches a Worker only as request headers, so it verifies the
`Cf-Access-Jwt-Assertion` JWT against the team's keys (RS256, `kid`, signature,
`exp`/`nbf`, `aud`, `iss`) and takes the email from it, 501 while the vars are blank and
401 otherwise. `workers_dev` and `preview_urls` are off, so the custom domain is the only
hostname. Admin POSTs must be same-origin JSON, since the Access cookie would ride along
on a cross-site form. The owner wallet has no part in this: it is for the contract only.

## The gateway

A friend runs `yakrobot-gateway` with `TELEOP_CAPTURE_FLAG_ENABLED=1`. It's the free
reservation mode with one extra check on `/{robot}/lease/reserve`:

1. a valid EIP-712 signature over the capture, for this gateway's own `robotId`
   (from `NGROK_DOMAIN`/`CLOUDFLARE_DOMAIN`, never the `Host` header);
2. `sha256(k) == nonce`;
3. one read-only `eth_call` of `lastCapture`, recent enough (30 min) and not ridden yet.

The gateway holds no key and sends no transaction. If the RPC is down, it refuses new
rides (503); rides already going continue. Safety stays on the robot (deadman timer, one
driver at a time).

## Who can stop what

| Control | Who | How | Effect |
|---|---|---|---|
| Pause / Resume | an admin (Access email) | `/admin`, no gas | No new captures anywhere |
| Disable / Enable a robot | an admin | `/admin` | No new captures of that robot |
| Top up the relayer | an admin | `/admin`, once a minute | `TOPUP_CLAIMS` × 0.0001 ETH from the CDP faucet |
| Hard stop | owner wallet | `setRelayer(0x0)` on the contract, costs gas | Every `captureBySig` reverts, whatever the Worker does |
| Take a robot offline | its friend | stop the gateway | Shows offline; captures 409 |

Rides already started always run to the end of their lease: the gateway owns rides.

## Limits and abuse

- **Per IP:** 10 requests a minute on `POST /capture`, `/admin/state` and `/admin/topup`
  (IPv6 per /64).
- **Per game:** at most `SENDS_PER_HOUR` (60) relayed captures an hour, counting failed
  ones, so many fresh wallets can't drain the relayer.
- **Per player:** the contract's 10-minute cooldown per robot, and one ride per capture.
- **The relayer** holds only gas money. If its key leaks, the owner calls
  `setRelayer(<new>)`.
- **The CDP key** can only claim faucet funds here: the Worker calls nothing else, and
  it pays only the relayer, at most once a minute. If it leaks, delete it in the CDP portal.
- Players need only an ordinary wallet account (EOA): no ETH, no gas. Smart-contract
  wallets can't sign captures yet.

## Further reading

- Owner's runbook: [README](../README.md#owners-runbook).
- Friend's runbook: `yakrobot-gateway` README, "Running a robot in the capture-flag game".
