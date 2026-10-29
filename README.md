# yakrobot-capture-flag

Free, gas-sponsored "capture the flag" rides on yakrobot robots. One page,
`capture-flag.yakrobot.com`, lists every robot. Pick one that's online, sign one message
in your wallet, and drive it for 5 minutes. Each capture is one transaction on Base that
records the ride and moves no tokens; the game's relayer pays the gas.

- `contracts/`: the `CaptureFlag` contract (Foundry).
- `worker/`: the relayer, the index and robot pages, and the admin page behind Cloudflare
  Access (Cloudflare Workers, Hono, viem).

How the pieces fit: [docs/architecture.md](docs/architecture.md).

Robots run on friends' own gateways (`yakrobot-gateway` in capture-flag mode). See its
README, "Running a robot in the capture-flag game", for the friend's side. See
[AGENTS.md](AGENTS.md) for the commands.

## Owner's runbook

### Adding a robot

1. The friend sends a **fixed** gateway hostname and the robot name (e.g.
   `picar_freenove`). The robot's on-chain id is `keccak256(host + "/" + robot)`, so a
   new hostname is a new robot with counters from zero.
2. Add an entry to `ROBOTS` in `worker/wrangler.jsonc`, keyed by a slug of our own (the
   page lives at `/r/<slug>`; `game` is reserved):

   ```json
   {"berlin": {"gateway": "https://<fixed host>", "robot": "picar_freenove",
               "label": "Freenove PiCar", "place": "Berlin"}}
   ```

3. Tell the friend their claim URL, `https://capture-flag.yakrobot.com/r/<slug>`, for
   `TELEOP_CAPTURE_FLAG_CLAIM_URL`.
4. Redeploy the Worker (see Upgrading). The robot starts enabled; it shows as playable
   whenever the friend's gateway is up.

### Pause / Resume, Disable / Enable

Log in to `/admin` and press a button: no wallet, no gas, no transaction. Each change is
logged with the admin's email (`wrangler tail`).

- **Pause / Resume** stops or restarts new captures everywhere. A fresh deploy starts
  **paused**.
- **Disable / Enable** takes one robot out, e.g. if it misbehaves while its friend is away.

Rides already started finish, and a capture made just before the switch can still start
its ride at the gateway within 30 minutes, since the gateway reads the chain, not the
Worker.

### Topping up the relayer

`/admin` shows the relayer's balance. **Top up** claims `TOPUP_CLAIMS` (20) × 0.0001 ETH
(0.002 ETH, about 2,400 new-player rides at 0.006 gwei) from the CDP faucet, at most once a
minute; CDP caps an address at 0.1 ETH a day. 20 is the most that fits one request on the
Workers Free plan (50 outside calls, one of them the Access check). Base Sepolia only. It needs a CDP Secret API Key (Ed25519, the default;
no wallet secret) from portal.cdp.coinbase.com, with the narrowest permissions the portal
offers (it only claims from the faucet), set once:

```bash
cd worker
wrangler secret put CDP_API_KEY_ID
wrangler secret put CDP_API_KEY_SECRET
```

Without the key, the button reads "Faucet key not set" and nothing else changes.

### Upgrading

- **Worker:** Pause → `wrangler deploy` → check `/health` → Resume.
- **Contract replacement** (rare): Pause → the hard stop below on the old contract →
  deploy the new one → set `CONTRACT` and redeploy the Worker → friends update
  `TELEOP_CAPTURE_FLAG_CONTRACT` → Resume. The new contract's counters start from zero;
  the old one keeps its history.

### Hard stop

The owner wallet is used only here and for `setCooldown`, from Basescan or `cast`, never
through the Worker. For a leaked relayer key, a compromised Worker, or before replacing the
contract: from the owner wallet, call `setRelayer(0x0000000000000000000000000000000000000000)` on the
contract (Basescan's "Write Contract" tab works). Every `captureBySig` then reverts,
whatever the Worker does, and `/capture` returns 503. Undo it with
`setRelayer(<relayer address>)`. Each call costs a little gas.

Licensed under Apache-2.0.
