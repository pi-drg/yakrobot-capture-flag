import { Hono } from "hono";
import { isHex, zeroAddress } from "viem";
import { captureFlagAbi } from "./abi";
import { AdminError, checkOwner, parseAdminMessage, readOwner } from "./admin";
import { cooldownRemaining, publicClientFor, readCooldown, rpcUrlOf } from "./chain";
import { type Config, findRobot, loadConfig, type Robot } from "./config";
import { CaptureShapeError, DOMAIN_NAME, DOMAIN_VERSION, parseTypedData, recoverPlayer } from "./eip712";
import { type GatewayState, readGatewayState } from "./gateway";
import { checkHealth } from "./health";
import { RELAYER_NAME } from "./relayer";
import adminPage from "../static/admin.html";
import claimPage from "../static/claim.html";
import indexPage from "../static/index.html";

export { Relayer } from "./relayer";

const app = new Hono<{ Bindings: Env; Variables: { config: Config } }>();

/** design G3: how long after a capture its ride can still start, the gateway's default. */
const VALID_MINUTES = 30;

/** design W3 step 2: a signature may not be good for more than 10 minutes. */
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

/** design W6: 10 a minute per IP, before any gateway, RPC or relayer call. Cloudflare
 * always sets CF-Connecting-IP in production; without it (local dev), all share one key. */
for (const path of ["/capture", "/admin/state"]) {
  app.post(path, async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
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

/** Paused and disabled are ours and checked first; only then is the gateway asked (W5b). */
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

app.get("/admin", (c) => c.html(adminPage));

/** What the admin page shows: the switches and each robot's counts (design W7). */
async function adminState(env: Env, config: Config) {
  const stub = relayer(env);
  const [switches, totals] = await Promise.all([stub.switches(), stub.robotTotals()]);
  return {
    chainId: config.chainId,
    contract: config.contract,
    paused: switches.paused,
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

app.get("/admin/state", async (c) => {
  const config = c.get("config");
  let owner: string | null = null;
  try {
    owner = await readOwner(publicClientFor(config, rpcUrlOf(c.env)), config);
  } catch {
    // The page can still show the state; signing will tell it the chain is down.
  }
  return c.json({ ...(await adminState(c.env, config)), owner });
});

/** design W7: parse, check the time, check the owner's signature, then switch. */
app.post("/admin/state", async (c) => {
  const config = c.get("config");
  let body: { message?: unknown; signature?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON {message, signature}" }, 400);
  }
  try {
    const cmd = parseAdminMessage(config, body.message, Math.floor(Date.now() / 1000));
    try {
      await checkOwner(publicClientFor(config, rpcUrlOf(c.env)), config, body.message as string, body.signature);
    } catch (err) {
      if (err instanceof AdminError) throw err;
      return c.json({ error: "chain unavailable, try again shortly" }, 503);
    }
    const on = cmd.action === "pause" || cmd.action === "disable";
    if (!(await relayer(c.env).applySwitch(cmd.target, on, cmd.issued))) {
      throw new AdminError(400, "a newer change was already applied, sign again");
    }
  } catch (err) {
    if (err instanceof AdminError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  return c.json(await adminState(c.env, config));
});

/** design W6: 503 when the relayer can't pay gas or the contract no longer accepts it. */
app.get("/health", async (c) => {
  const health = await checkHealth(c.env, c.get("config"), relayer(c.env));
  return c.json(health, health.ok ? 200 : 503);
});

/** Every robot's state for the index page, gateways asked in parallel (design W5b). */
app.get("/robots", async (c) => {
  const { robots } = c.get("config");
  const switches = await relayer(c.env).switches();
  const states = await Promise.all(robots.map((r) => robotState(r, switches)));
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
  return c.json({ ...log, leader, contract: config.contract });
});

app.get("/leaderboard", async (c) => {
  const config = c.get("config");
  return c.json({
    contract: config.contract,
    top: await relayer(c.env).leaderboard(config.driversShown),
  });
});

/** design W3: every check that costs no gas runs here, in order, before the relayer. */
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
  // at the gateway for VALID_MINUTES (design G3).
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
    // The page appends #c=&s=&tx= (design W5).
    drive: `${robot.gateway}/${robot.name}/ui`,
  });
});

/** design W6: every 15 minutes, flag an unhealthy relayer in the Worker's logs. */
async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const health = await checkHealth(env, configOf(env), relayer(env), { fresh: true });
  if (!health.ok) console.error("capture-flag unhealthy", JSON.stringify(health));
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
