import { keccak256, toBytes } from "viem";

/**
 * Read and validate the Worker's configuration — design W1. Each robot's `robotId` is
 * derived here from its gateway host and robot name (design F3), so a friend running a
 * robot only hands over a host and a name, and no hand-typed id can be wrong.
 *
 * `ROBOTS` is keyed by a slug of our own (`berlin`), not by the gateway's robot name:
 * friends running the same kit all have a `picar_freenove`.
 */

export class ConfigError extends Error {}

export interface Robot {
  /** The `ROBOTS` key, used in this Worker's URLs (`/r/berlin`). */
  slug: string;
  /** The gateway's robot (plugin) name, its `/{robot}` route segment. */
  name: string;
  /** Gateway origin, no trailing slash, e.g. `https://robots.example.org`. */
  gateway: string;
  /** `keccak256(host + "/" + name)`, as the contract and the gateway compute it. */
  robotId: `0x${string}`;
  label: string;
  place: string;
}

export interface Config {
  chainId: 84532 | 8453;
  contract: `0x${string}`;
  /** In `ROBOTS` order, which is the order the index page lists them in. */
  robots: Robot[];
  relayerMinWei: bigint;
  driversShown: number;
}

/** Whatever shape env vars arrive in — a Worker's `Env`, or a plain object in tests. */
export type RawEnv = Record<string, string | undefined>;

const CHAINS = new Set([84532, 8453]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Gateway plugin names (picar_freenove, fakerobot_picar): in the gateway's URL path and in robotId.
const ROBOT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROBOT_FIELDS = new Set(["gateway", "robot", "label", "place"]);

/** Read `env[name]`, trimmed; throws `ConfigError` if missing or blank. */
function requireVar(env: RawEnv, name: string): string {
  const value = (env[name] ?? "").trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

/** Must parse as a positive integer. */
function validatePositiveInt(name: string, value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return Number(value);
}

/** `keccak256(host + "/" + robot)` — design F3; `host` is lowercase and keeps any port. */
export function robotIdFor(host: string, robot: string): `0x${string}` {
  return keccak256(toBytes(`${host}/${robot}`));
}

/** A bare origin: `https://`, or `http://` to `127.0.0.1`/`localhost` for local dev; no
 * path, query, fragment or credentials, since the host is hashed into `robotId`. */
function validateGateway(name: string, value: unknown): URL {
  if (typeof value !== "string") throw new ConfigError(`${name}.gateway must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name}.gateway is not a URL`);
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError(
      `${name}.gateway must start with https:// (http://127.0.0.1 or http://localhost allowed for local dev)`
    );
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`${name}.gateway must be an origin only, with no path, query or credentials`);
  }
  return url;
}

/** A non-empty string of at most 80 characters, trimmed. */
function validateText(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new ConfigError(`${name} must be a non-empty string of at most 80 characters`);
  }
  return value.trim();
}

/** `ROBOTS` JSON: `{"<slug>": {"gateway", "robot", "label", "place"}}`. Empty is allowed:
 * the index page then lists no robots until a friend's gateway is added. */
function parseRobots(value: string): Robot[] {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new ConfigError("ROBOTS must be JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("ROBOTS must be a JSON object keyed by slug");
  }
  const robots: Robot[] = [];
  const ids = new Map<string, string>();
  for (const [slug, entry] of Object.entries(raw)) {
    if (!SLUG_RE.test(slug)) {
      throw new ConfigError(`ROBOTS key ${JSON.stringify(slug)} must match ${SLUG_RE}`);
    }
    // The admin message's game-wide target (design W7).
    if (slug === "game") throw new ConfigError('ROBOTS key "game" is reserved');
    const at = `ROBOTS.${slug}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${at} must be an object`);
    }
    const extra = Object.keys(entry).filter((k) => !ROBOT_FIELDS.has(k));
    if (extra.length) {
      // Catches a leftover hand-typed robot_id, which is now derived.
      throw new ConfigError(`${at} has unknown fields: ${extra.join(", ")}`);
    }
    const e = entry as Record<string, unknown>;
    const url = validateGateway(at, e.gateway);
    if (typeof e.robot !== "string" || !ROBOT_NAME_RE.test(e.robot)) {
      throw new ConfigError(`${at}.robot must match ${ROBOT_NAME_RE}`);
    }
    const robotId = robotIdFor(url.host, e.robot);
    const clash = ids.get(robotId);
    if (clash) throw new ConfigError(`${at} is the same gateway robot as ROBOTS.${clash}`);
    ids.set(robotId, slug);
    robots.push({
      slug,
      name: e.robot,
      gateway: url.origin,
      robotId,
      label: validateText(`${at}.label`, e.label),
      place: validateText(`${at}.place`, e.place),
    });
  }
  return robots;
}

/** Validate every W1 var and assemble the `Config`, or throw `ConfigError` naming the
 * first problem found. Secrets (`RELAYER_PRIVATE_KEY`, `RPC_URL`) are read where used. */
export function loadConfig(env: RawEnv): Config {
  const chainId = validatePositiveInt("CHAIN", requireVar(env, "CHAIN"));
  if (!CHAINS.has(chainId)) throw new ConfigError("CHAIN must be 84532 or 8453");
  const contract = requireVar(env, "CONTRACT");
  if (!ADDRESS_RE.test(contract)) throw new ConfigError(`CONTRACT must match ${ADDRESS_RE}`);
  const relayerMinWei = requireVar(env, "RELAYER_MIN_WEI");
  if (!/^[0-9]+$/.test(relayerMinWei)) {
    throw new ConfigError("RELAYER_MIN_WEI must be a non-negative integer (wei)");
  }
  return {
    chainId: chainId as 84532 | 8453,
    contract: contract.toLowerCase() as `0x${string}`,
    robots: parseRobots(requireVar(env, "ROBOTS")),
    relayerMinWei: BigInt(relayerMinWei),
    driversShown: validatePositiveInt("DRIVERS_SHOWN", requireVar(env, "DRIVERS_SHOWN")),
  };
}

/** The configured robot by slug, or `undefined` for an unknown one (the route's 404). */
export function findRobot(config: Config, slug: string): Robot | undefined {
  return config.robots.find((r) => r.slug === slug);
}
