import { Hono } from "hono";
import { isHex, zeroAddress } from "viem";
import { captureFlagAbi } from "./abi";
import { cooldownRemaining, publicClientFor, readCooldown, rpcUrlOf } from "./chain";
import { type Config, findRobot, loadConfig, type Robot } from "./config";
import { CaptureShapeError, DOMAIN_NAME, DOMAIN_VERSION, parseTypedData, recoverPlayer } from "./eip712";
import { type GatewayState, readGatewayState } from "./gateway";
import { RELAYER_NAME } from "./relayer";
import indexPage from "../static/index.html";

export { Relayer } from "./relayer";

// Routes still to come: /r/:robot (page), /admin (W2a), /health (W6).
const app = new Hono<{ Bindings: Env; Variables: { config: Config } }>();

/** design W3 step 2: a signature may not be good for more than 10 minutes. */
const MAX_DEADLINE_AHEAD = 600n;
/** ...and must have a minute left, so it can't expire while its transaction is pending. */
const MIN_DEADLINE_LEFT = 60n;

// Vars only change on deploy, so parse them once per isolate; the key is the env object.
const configs = new WeakMap<object, Config>();

app.use("*", async (c, next) => {
  let config = configs.get(c.env);
  if (!config) {
    config = loadConfig(c.env as unknown as Record<string, string | undefined>);
    configs.set(c.env, config);
  }
  c.set("config", config);
  await next();
});

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

app.get("/health", (c) => c.json({ ok: true, chain: c.env.CHAIN }));

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

export default app;
