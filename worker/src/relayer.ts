import { DurableObject } from "cloudflare:workers";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  http,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { captureFlagAbi } from "./abi";
import { chainFor, publicClientFor, rpcUrlOf } from "./chain";
import { type Config, loadConfig } from "./config";
import type { Capture } from "./eip712";

/**
 * The Relayer Durable Object — design W4. One named instance ("relayer") is the only
 * holder of RELAYER_PRIVATE_KEY and the only submitter of `captureBySig`, so it can:
 * - keep the relayer's transaction nonce in order when many visitors capture at once;
 * - keep the drivers log and counts (design W5a), complete because of `onlyRelayer`;
 * - hold the game switches (design W7): paused, and disabled per robot.
 *
 * The log is written when a transaction is sent, not when it's mined. Simulation and the
 * in-flight cooldown check below make a later revert rare (a deadline passing while
 * pending is the main case), and scripts/rebuild-drivers.ts is the repair if one happens.
 */

export const RELAYER_NAME = "relayer";

export type CaptureResult =
  | { ok: true; txHash: `0x${string}` }
  | { ok: false; status: 400 | 403 | 409 | 429 | 503; error: string; retryAfter?: number };

export interface Driver {
  player: string;
  tx: string;
  at: number;
}

export interface Ranked {
  player: string;
  rides: number;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
// Errors a send can hit when our stored nonce has drifted from the chain's.
const NONCE_DRIFT_RE = /nonce too low|nonce has already been used|replacement transaction underpriced|already known/i;

export class Relayer extends DurableObject<Env> {
  private sql: SqlStorage;
  private config: Config;
  private lock: Promise<unknown> = Promise.resolve();
  private account?: PrivateKeyAccount;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.config = loadConfig(env as unknown as Record<string, string | undefined>);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS captures (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL, robot_id TEXT NOT NULL, player TEXT NOT NULL,
        nonce TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL
      );
      -- The contract's nonceUsed is per player, across robots.
      CREATE UNIQUE INDEX IF NOT EXISTS captures_nonce ON captures (player, nonce);
      CREATE INDEX IF NOT EXISTS captures_robot ON captures (robot_id, seq);
      CREATE INDEX IF NOT EXISTS captures_pair ON captures (robot_id, player, seq);
      -- reached: the seq that brought n to its value, for the contract's tie rule.
      CREATE TABLE IF NOT EXISTS counts (
        robot_id TEXT NOT NULL, player TEXT NOT NULL, n INTEGER NOT NULL, reached INTEGER NOT NULL,
        PRIMARY KEY (robot_id, player)
      );
      CREATE TABLE IF NOT EXISTS totals (
        player TEXT PRIMARY KEY, n INTEGER NOT NULL, reached INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  // ---- switches (design W7) ----

  /** The game starts paused on a fresh deploy; robots start enabled. */
  switches(): { paused: boolean; disabled: string[] } {
    const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM kv").toArray();
    const kv = new Map(rows.map((r) => [r.key, r.value]));
    return {
      paused: kv.get("paused") !== "0",
      disabled: rows.filter((r) => r.key.startsWith("disabled:") && r.value === "1").map((r) => r.key.slice(9)),
    };
  }

  /** `target` is "game" (pause) or a robot slug (disable). The admin route (W2a)
   * authenticates the caller before this is reached. */
  setSwitch(target: string, on: boolean): void {
    const key = target === "game" ? "paused" : `disabled:${target}`;
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, on ? "1" : "0");
  }

  // ---- capture ----

  /** Simulate, then send `captureBySig`, then log it. Serialised: one at a time. */
  capture(
    slug: string,
    c: Capture,
    signature: `0x${string}`,
    cooldownSeconds: number
  ): Promise<CaptureResult> {
    const run = this.lock.then(() => this.captureNow(slug, c, signature, cooldownSeconds));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async captureNow(
    slug: string,
    c: Capture,
    signature: `0x${string}`,
    cooldownSeconds: number
  ): Promise<CaptureResult> {
    const { paused, disabled } = this.switches();
    if (paused) return { ok: false, status: 403, error: "game is paused" };
    if (disabled.includes(slug)) return { ok: false, status: 403, error: "robot is disabled" };

    // The Worker checked lastCapture on-chain, but a capture we sent may not be mined
    // yet; our own log is the only record of it. Likewise a nonce sent for another robot.
    const used = this.sql
      .exec("SELECT 1 FROM captures WHERE player = ? AND nonce = ?", c.player, String(c.nonce))
      .toArray().length;
    if (used) return { ok: false, status: 400, error: "this capture was already used" };
    const now = Math.floor(Date.now() / 1000);
    const last = this.sql
      .exec<{ at: number }>(
        "SELECT at FROM captures WHERE robot_id = ? AND player = ? ORDER BY seq DESC LIMIT 1",
        c.robotId,
        c.player
      )
      .toArray()[0];
    if (last && now < last.at + cooldownSeconds) {
      const retryAfter = last.at + cooldownSeconds - now;
      return { ok: false, status: 429, error: "cooldown", retryAfter };
    }

    const account = this.relayerAccount();
    const rpcUrl = rpcUrlOf(this.env);
    const chain = chainFor(this.config, rpcUrl);
    const client = publicClientFor(this.config, rpcUrl);
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const args = [{ ...c }, signature] as const;

    let request;
    try {
      ({ request } = await client.simulateContract({
        account,
        address: this.config.contract,
        abi: captureFlagAbi,
        functionName: "captureBySig",
        args,
      }));
    } catch (err) {
      return revertResult(err);
    }

    let nonce = await this.nextNonce(client, account, false);
    let txHash: `0x${string}`;
    try {
      txHash = await wallet.writeContract({ ...request, nonce });
    } catch (err) {
      // Re-sync and retry once (design W4).
      if (!NONCE_DRIFT_RE.test(String(err))) throw err;
      nonce = await this.nextNonce(client, account, true);
      txHash = await wallet.writeContract({ ...request, nonce });
    }
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('nonce', ?)", String(nonce + 1));
    this.record(slug, c, txHash, now);
    return { ok: true, txHash };
  }

  private relayerAccount(): PrivateKeyAccount {
    if (!this.account) {
      const key = this.env.RELAYER_PRIVATE_KEY ?? "";
      // Never echo the value, even malformed.
      if (!PRIVATE_KEY_RE.test(key)) throw new Error("RELAYER_PRIVATE_KEY is missing or malformed");
      this.account = privateKeyToAccount(key as `0x${string}`);
    }
    return this.account;
  }

  private storedNonce(): number | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'nonce'").toArray()[0];
    return row ? Number(row.value) : undefined;
  }

  /** Our next nonce; synced from the chain's pending count at first use or on drift. */
  private async nextNonce(client: PublicClient, account: PrivateKeyAccount, resync: boolean): Promise<number> {
    let nonce = resync ? undefined : this.storedNonce();
    if (nonce === undefined) {
      nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('nonce', ?)", String(nonce));
    }
    return nonce;
  }

  private record(slug: string, c: Capture, tx: string, at: number): void {
    const { robotId, player } = c;
    const seq = this.sql
      .exec<{ seq: number }>(
        "INSERT INTO captures (slug, robot_id, player, nonce, tx, at) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
        slug,
        robotId,
        player,
        String(c.nonce),
        tx,
        at
      )
      .one().seq;
    this.sql.exec(
      `INSERT INTO counts (robot_id, player, n, reached) VALUES (?, ?, 1, ?)
       ON CONFLICT (robot_id, player) DO UPDATE SET n = n + 1, reached = excluded.reached`,
      robotId,
      player,
      seq
    );
    this.sql.exec(
      `INSERT INTO totals (player, n, reached) VALUES (?, 1, ?)
       ON CONFLICT (player) DO UPDATE SET n = n + 1, reached = excluded.reached`,
      player,
      seq
    );
  }

  // ---- reads (design W5a) ----

  /** Latest captures of one robot, newest first, plus its ranking. Ties go to whoever
   * reached the count first, the contract's rule, so top[0] is `topCapturer`. */
  drivers(robotId: string, limit: number): { recent: Driver[]; top: Ranked[]; rides: number; drivers: number } {
    const recent = this.sql
      .exec<{ player: string; tx: string; at: number }>(
        "SELECT player, tx, at FROM captures WHERE robot_id = ? ORDER BY seq DESC LIMIT ?",
        robotId,
        limit
      )
      .toArray()
      .map((r) => ({ player: r.player, tx: r.tx, at: r.at }));
    const top = this.sql
      .exec<{ player: string; n: number }>(
        "SELECT player, n FROM counts WHERE robot_id = ? ORDER BY n DESC, reached ASC LIMIT ?",
        robotId,
        limit
      )
      .toArray()
      .map((r) => ({ player: r.player, rides: r.n }));
    const totals = this.sql
      .exec<{ rides: number; drivers: number }>(
        "SELECT COALESCE(SUM(n), 0) AS rides, COUNT(*) AS drivers FROM counts WHERE robot_id = ?",
        robotId
      )
      .one();
    return { recent, top, rides: totals.rides, drivers: totals.drivers };
  }

  /** The network leaderboard: rides across every robot, and how many robots driven. */
  leaderboard(limit: number): Array<Ranked & { robots: number }> {
    return this.sql
      .exec<{ player: string; n: number; robots: number }>(
        `SELECT t.player, t.n, (SELECT COUNT(*) FROM counts c WHERE c.player = t.player) AS robots
         FROM totals t ORDER BY t.n DESC, t.reached ASC LIMIT ?`,
        limit
      )
      .toArray()
      .map((r) => ({ player: r.player, rides: r.n, robots: r.robots }));
  }
}

/** Map a simulation revert to the response the visitor sees; anything else rethrows. */
function revertResult(err: unknown): CaptureResult {
  const revert =
    err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
  if (!(revert instanceof ContractFunctionRevertedError)) throw err;
  switch (revert.data?.errorName) {
    case "Cooldown":
      return { ok: false, status: 429, error: "cooldown", retryAfter: Number(revert.data.args?.[0] ?? 0) };
    case "Expired":
      return { ok: false, status: 400, error: "capture expired, sign again" };
    case "NonceUsed":
      return { ok: false, status: 400, error: "this capture was already used" };
    case "BadSignature":
      return { ok: false, status: 400, error: "bad signature" };
    case "NotRelayer":
      // The owner's on-chain hard stop (design F8), or a rotated key not yet deployed.
      return { ok: false, status: 503, error: "captures are stopped" };
    default:
      throw err;
  }
}
