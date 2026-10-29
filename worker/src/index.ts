import { Hono, type MiddlewareHandler } from "hono";
import { isAddress, isHex, zeroAddress } from "viem";
import { captureFlagAbi } from "./abi";
import { type AccessClaims, AccessError, verifyAccess } from "./access";
import { AdminError, checkSameOrigin, parseAdminCommand } from "./admin";
import { cooldownRemaining, publicClientFor, readCooldown, rpcUrlOf } from "./chain";
import { type Config, findRobot, loadConfig, type Robot } from "./config";
import { CaptureShapeError, DOMAIN_NAME, DOMAIN_VERSION, parseTypedData, recoverPlayer } from "./eip712";
import { type GatewayState, readGatewayState } from "./gateway";
import { FAUCET_CHAIN_ID, FaucetError, faucetConfigured, topUp } from "./faucet";
import { checkHealth } from "./health";
import { ipKey } from "./ip";
import { ensReaderFor, refreshNames } from "./names";
import { RELAYER_NAME, TOPUP_GAP_S } from "./relayer";
import adminPage from "../static/admin.html";
import claimPage from "../static/claim.html";
import indexPage from "../static/index.html";

export { Relayer } from "./relayer";

type AppEnv = { Bindings: Env; Variables: { config: Config; admin: AccessClaims } };
const app = new Hono<AppEnv>();

/** How long after a capture its ride can still start, the gateway's default. */
const VALID_MINUTES = 30;

/** A signature may not be good for more than 10 minutes. */
const MAX_DEADLINE_AHEAD = 600n;
/** ...and must have a minute left, so it can't expire while its transaction is pending. */
const MIN_DEADLINE_LEFT = 60n;

// Vars only change on deploy, so parse them once per isolate; the key is the env object.
const configs = new WeakMap<object, Config>();

function configOf(env: Env): Config {
  let config = configs.get(env);
  if (!config) {
    config = loadConfig(env as unknown as Record<string, string | undefined>);
    configs.set(env, config);
  }
  return config;
}

app.use("*", async (c, next) => {
  c.set("config", configOf(c.env));
  await next();
});

/** 10 a minute per IP, before any gateway, RPC or relayer call. Cloudflare
 * always sets CF-Connecting-IP in production; without it (local dev), all share one key. */
for (const path of ["/capture", "/admin/state", "/admin/topup"]) {
  app.post(path, async (c, next) => {
    const ip = ipKey(c.req.header("cf-connecting-ip") ?? "unknown");
    const { success } = await c.env.IP_LIMIT.limit({ key: `${path}:${ip}` });
    if (!success) {
      c.header("Retry-After", "60");
      return c.json({ error: "too many requests, try again in a minute" }, 429);
    }
    await next();
  });
}

function relayer(env: Env) {
  return env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME));
}

type RobotState = GatewayState | { state: "paused" } | { state: "disabled" };

/** Paused and disabled are ours and checked first; only then is the gateway asked. */
async function robotState(robot: Robot, switches: { paused: boolean; disabled: string[] }): Promise<RobotState> {
  if (switches.paused) return { state: "paused" };
  if (switches.disabled.includes(robot.slug)) return { state: "disabled" };
  return readGatewayState(robot);
}

app.get("/", (c) => c.html(indexPage));

/** The robot page, with its robot's config inlined so it needs no extra fetch. */
app.get("/r/:robot", (c) => {
  const config = c.get("config");
  const robot = findRobot(config, c.req.param("robot"));
  if (!robot) return c.text("unknown robot", 404);
  const data = JSON.stringify({
    slug: robot.slug,
    label: robot.label,
    place: robot.place,
    robotId: robot.robotId,
    chainId: config.chainId,
    contract: config.contract,
    drive: `${robot.gateway}/${robot.name}/ui`,
    validMinutes: VALID_MINUTES,
  }).replace(/</g, "\\u003c");
  // A function replacement, so `$` in a label isn't read as a pattern.
  return c.html(claimPage.replace("__ROBOT__", () => data));
});

/** Everything under /admin is for admins: Cloudflare Access logs them in at the edge, and
 * this checks its JWT (src/access.ts). Both patterns, since "/admin/*" may not match "/admin". */
const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    c.set("admin", await verifyAccess(c.req.raw, c.env));
  } catch (err) {
    if (err instanceof AccessError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  await next();
};
app.use("/admin", requireAccess);
app.use("/admin/*", requireAccess);

const sameOriginJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    checkSameOrigin(c.req.raw);
  } catch (err) {
    if (err instanceof AdminError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  await next();
};
app.post("/admin/state", sameOriginJson);
app.post("/admin/topup", sameOriginJson);

app.get("/admin", (c) => c.html(adminPage));

/** What the admin page shows: the switches, each robot's counts, the relayer's gas, and who's signed in. */
async function adminState(env: Env, config: Config, admin: AccessClaims) {
  const stub = relayer(env);
  // The balance comes from /health's 30 s cache.
  const [switches, totals, health] = await Promise.all([stub.switches(), stub.robotTotals(), checkHealth(env, config, stub)]);
  return {
    chainId: config.chainId,
    contract: config.contract,
    admin: { email: admin.email },
    paused: switches.paused,
    relayer: {
      address: health.relayer,
      balance_wei: health.balance_wei,
      min_wei: config.relayerMinWei.toString(),
    },
    // Base Sepolia only: CDP has no mainnet faucet.
    faucet: {
      available: config.chainId === FAUCET_CHAIN_ID,
      configured: faucetConfigured(env),
      claims: config.topupClaims,
    },
    robots: config.robots.map((r) => ({
      slug: r.slug,
      label: r.label,
      place: r.place,
      disabled: switches.disabled.includes(r.slug),
      rides: totals[r.robotId]?.rides ?? 0,
      drivers: totals[r.robotId]?.drivers ?? 0,
    })),
  };
}

app.get("/admin/state", async (c) => c.json(await adminState(c.env, c.get("config"), c.get("admin"))));

/** A switch: {action, target}. Logged with the admin's email. */
app.post("/admin/state", async (c) => {
  const config = c.get("config");
  const admin = c.get("admin");
  try {
    const cmd = parseAdminCommand(config, await c.req.json().catch(() => null));
    await relayer(c.env).setSwitch(cmd.target, cmd.action === "pause" || cmd.action === "disable");
    console.log("capture-flag admin", JSON.stringify({ email: admin.email, ...cmd }));
  } catch (err) {
    if (err instanceof AdminError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  return c.json(await adminState(c.env, config, admin));
});

/** Claims TOPUP_CLAIMS times from the CDP faucet for the relayer and returns the hashes,
 * without waiting for them. One a minute (claimTopup). */
app.post("/admin/topup", async (c) => {
  const config = c.get("config");
  if (config.chainId !== FAUCET_CHAIN_ID) return c.json({ error: "the faucet is Base Sepolia only" }, 400);
  if (!faucetConfigured(c.env)) return c.json({ error: "the faucet key isn't set on the Worker" }, 503);
  const address = await relayer(c.env).address();
  if (!address) return c.json({ error: "the relayer key isn't set" }, 503);
  if (!(await relayer(c.env).claimTopup(Math.floor(Date.now() / 1000)))) {
    c.header("Retry-After", String(TOPUP_GAP_S));
    return c.json({ error: "a top-up just ran, wait a minute" }, 429);
  }
  try {
    const result = await topUp(c.env, address, config.topupClaims);
    console.log("capture-flag topup", JSON.stringify({ email: c.get("admin").email, claims: result.hashes.length, error: result.error }));
    return c.json({ claims: result.hashes.length, hashes: result.hashes, error: result.error }, result.hashes.length ? 200 : 502);
  } catch (err) {
    if (err instanceof FaucetError) return c.json({ error: err.message }, 503);
    throw err;
  }
});

/** 503 when the relayer can't pay gas or the contract no longer accepts it. */
app.get("/health", async (c) => {
  const health = await checkHealth(c.env, c.get("config"), relayer(c.env));
  return c.json(health, health.ok ? 200 : 503);
});

/** Every robot's state for the index page, gateways asked in parallel. Readable from any
 * origin: simulator.yakrobot.com polls it to say when a robot is free. Public data and a
 * simple GET, so there is no preflight to answer. */
app.get("/robots", async (c) => {
  const { robots } = c.get("config");
  const switches = await relayer(c.env).switches();
  const states = await Promise.all(robots.map((r) => robotState(r, switches)));
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({
    paused: switches.paused,
    robots: robots.map((r, i) => ({ slug: r.slug, label: r.label, place: r.place, ...states[i] })),
  });
});

app.get("/r/:robot/status", async (c) => {
  const robot = findRobot(c.get("config"), c.req.param("robot"));
  if (!robot) return c.json({ error: "unknown robot" }, 404);
  return c.json(await robotState(robot, await relayer(c.env).switches()));
});

/** Cached names for these players, and a background refresh of any that are stale. */
async function withNames(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, players: string[]): Promise<Record<string, string>> {
  const stub = relayer(env);
  const reader = ensReaderFor(env);
  if (reader) ctx.waitUntil(refreshNames(reader, stub, players).catch(() => undefined));
  return stub.namesFor(players);
}

/** Recent drivers and the ranking from the relayer's log, plus the on-chain leader. */
app.get("/r/:robot/drivers", async (c) => {
  const config = c.get("config");
  const robot = findRobot(config, c.req.param("robot"));
  if (!robot) return c.json({ error: "unknown robot" }, 404);
  const log = await relayer(c.env).drivers(robot.robotId, config.driversShown);
  let leader: { player: string; rides: number } | null = null;
  try {
    const client = publicClientFor(config, rpcUrlOf(c.env));
    const read = { address: config.contract, abi: captureFlagAbi, args: [robot.robotId] } as const;
    const [player, rides] = await Promise.all([
      client.readContract({ ...read, functionName: "topCapturer" }),
      client.readContract({ ...read, functionName: "mostCaptures" }),
    ]);
    if (player !== zeroAddress) leader = { player: player.toLowerCase(), rides: Number(rides) };
  } catch {
    // The page still has the log's ranking; the on-chain leader is a cross-check.
  }
  const players = [...log.recent, ...log.top].map((p) => p.player).concat(leader ? [leader.player] : []);
  const names = await withNames(c.env, c.executionCtx, players);
  return c.json({ ...log, leader, names, contract: config.contract });
});

/** Where a capture's transaction is now: the relayer may have re-sent it with a higher
 * fee (new hash) or given it up (404). The robot page polls this, not the first hash. */
app.get("/r/:robot/capture", async (c) => {
  const robot = findRobot(c.get("config"), c.req.param("robot"));
  if (!robot) return c.json({ error: "unknown robot" }, 404);
  const player = c.req.query("player") ?? "";
  const nonce = c.req.query("nonce") ?? "";
  if (!isAddress(player) || !/^[0-9]{1,78}$/.test(nonce)) {
    return c.json({ error: "player must be an address and nonce a decimal integer" }, 400);
  }
  const found = await relayer(c.env).captureTx(player, nonce);
  return found ? c.json(found) : c.json({ error: "no such capture" }, 404);
});

app.get("/leaderboard", async (c) => {
  const config = c.get("config");
  const top = await relayer(c.env).leaderboard(config.driversShown);
  const names = await withNames(c.env, c.executionCtx, top.map((p) => p.player));
  return c.json({ contract: config.contract, top, names });
});

/** Every check that costs no gas runs here, in order, before the relayer. */
app.post("/capture", async (c) => {
  const config = c.get("config");
  const fail = (status: 400 | 403 | 409 | 429 | 503, error: string, extra: object = {}) =>
    c.json({ error, ...extra }, status);

  // 1. Shape, domain and robot.
  let body: { typedData?: unknown; sig?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "body must be JSON {typedData, sig}");
  }
  let parsed;
  try {
    parsed = parseTypedData(body.typedData);
  } catch (err) {
    if (err instanceof CaptureShapeError) return fail(400, err.message);
    throw err;
  }
  const { domain, message } = parsed;
  if (
    domain.name !== DOMAIN_NAME ||
    domain.version !== DOMAIN_VERSION ||
    domain.chainId !== config.chainId ||
    domain.verifyingContract !== config.contract
  ) {
    return fail(400, "wrong EIP-712 domain for this game");
  }
  const robot = config.robots.find((r) => r.robotId === message.robotId);
  if (!robot) return fail(400, "unknown robot");
  const sig = body.sig;
  if (typeof sig !== "string" || !isHex(sig) || sig.length !== 132) {
    return fail(400, "sig must be a 65-byte hex signature");
  }

  // 1a. Paused or disabled.
  const switches = await relayer(c.env).switches();
  if (switches.paused) return fail(403, "game is paused");
  if (switches.disabled.includes(robot.slug)) return fail(403, "robot is disabled");

  // 2. Deadline.
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (message.deadline < now + MIN_DEADLINE_LEFT) return fail(400, "capture expired, sign again");
  if (message.deadline > now + MAX_DEADLINE_AHEAD) return fail(400, "deadline is too far ahead");

  // 3. Signature.
  let signer: string;
  try {
    signer = await recoverPlayer(domain, message, sig);
  } catch {
    return fail(400, "bad signature");
  }
  if (signer !== message.player) return fail(400, "bad signature");

  // 4. The robot must be free right now. Racy, and that's fine: a capture stays usable
  // at the gateway for VALID_MINUTES.
  const state = await readGatewayState(robot);
  if (state.state !== "free") {
    return fail(409, "robot busy or offline — your capture was not used", { state: state.state });
  }

  // 5. Cooldown, on-chain.
  let cooldown: bigint;
  try {
    const client = publicClientFor(config, rpcUrlOf(c.env));
    const remaining = await cooldownRemaining(client, config, message.robotId, message.player, now);
    if (remaining > 0n) {
      c.header("Retry-After", String(remaining));
      return fail(429, "cooldown", { retry_after: Number(remaining) });
    }
    cooldown = await readCooldown(client, config);
  } catch {
    return fail(503, "chain unavailable, try again shortly");
  }

  // 6. Relay.
  const result = await relayer(c.env).capture(robot.slug, message, sig, Number(cooldown));
  if (!result.ok) {
    if (result.retryAfter !== undefined) c.header("Retry-After", String(result.retryAfter));
    return fail(result.status, result.error, result.retryAfter !== undefined ? { retry_after: result.retryAfter } : {});
  }
  return c.json({
    txHash: result.txHash,
    robot: robot.slug,
    // The page appends #c=&s=&k=&tx=.
    drive: `${robot.gateway}/${robot.name}/ui`,
  });
});

/** Every 15 minutes, flag an unhealthy relayer in the Worker's logs. */
async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const health = await checkHealth(env, configOf(env), relayer(env), { fresh: true });
  if (!health.ok) console.error("capture-flag unhealthy", JSON.stringify(health));
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
