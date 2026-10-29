import { DurableObject } from "cloudflare:workers";
import {
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  createWalletClient,
  TransactionReceiptNotFoundError,
  http,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { captureFlagAbi } from "./abi";
import { chainFor, publicClientFor, rpcUrlOf } from "./chain";
import { type Config, loadConfig } from "./config";
import type { Capture } from "./eip712";

/**
 * The Relayer Durable Object. One named instance ("relayer") is the only
 * holder of RELAYER_PRIVATE_KEY and the only submitter of `captureBySig`, so it can:
 * - keep the relayer's transaction nonce in order when many visitors capture at once;
 * - keep the drivers log and counts, complete because of `onlyRelayer`;
 * - hold the game switches: paused, and disabled per robot.
 *
 * The log is written when a transaction is sent, not when it's mined. Simulation and the
 * in-flight cooldown check below make a later revert rare (a deadline passing while
 * pending is the main case). Each send is also kept in `pending` until mined: an alarm
 * re-sends one stuck for STUCK_BLOCKS with higher fees, or, if it would now revert,
 * replaces it with a no-op so later nonces aren't blocked, and marks it reverted. A
 * reverted row still counts toward the hourly send budget (it cost gas), but not toward
 * rankings or the cooldown.
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
/** Re-send after this many blocks unmined (about 20 s on Base)... */
const STUCK_BLOCKS = 10n;
/** ...with fees up 25%, at most this many times, then give up, log it and leave it for
 * /health to report. */
const MAX_RESENDS = 3;
const ALARM_MS = 30_000;

type PendingRow = {
  nonce: number;
  /** The captures row this send logged; 0 once it was replaced by a no-op. */
  seq: number;
  capture: string;
  sig: string;
  /** JSON array, oldest first: any of them may be the one that gets mined. */
  hashes: string;
  /** -1 if the block number couldn't be read at send time. */
  sent_block: number;
  tries: number;
  /** Unix seconds of the first send. */
  sent_at: number;
};
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
        nonce TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL,
        reverted INTEGER NOT NULL DEFAULT 0
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
      -- Player names (src/names.ts); name is NULL when the address has none.
      CREATE TABLE IF NOT EXISTS names (address TEXT PRIMARY KEY, name TEXT, checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (
        nonce INTEGER PRIMARY KEY, seq INTEGER NOT NULL, capture TEXT NOT NULL, sig TEXT NOT NULL,
        hashes TEXT NOT NULL, sent_block INTEGER NOT NULL, tries INTEGER NOT NULL,
        sent_at INTEGER NOT NULL
      );
    `);
  }

  // ---- switches ----

  /** The game starts paused on a fresh deploy; robots start enabled. */
  switches(): { paused: boolean; disabled: string[] } {
    const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM kv").toArray();
    const kv = new Map(rows.map((r) => [r.key, r.value]));
    return {
      paused: kv.get("paused") !== "0",
      disabled: rows.filter((r) => r.key.startsWith("disabled:") && r.value === "1").map((r) => r.key.slice(9)),
    };
  }

  /** `target` is "game" (pause) or a robot slug (disable). Unchecked: tests use it
   * directly; the admin route goes through `applySwitch`. */
  setSwitch(target: string, on: boolean): void {
    const key = target === "game" ? "paused" : `disabled:${target}`;
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, on ? "1" : "0");
  }

  /** The admin route's switch, after it has checked the owner's signature. `issued` must
   * be newer than the last one applied to this target, so an old "resume" can't be
   * replayed after a "pause". False if it isn't. */
  applySwitch(target: string, on: boolean, issued: number): boolean {
    const key = `issued:${target}`;
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    if (row && issued <= Number(row.value)) return false;
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, String(issued));
    this.setSwitch(target, on);
    return true;
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
    // A ceiling on sends across the whole game, against a swarm of wallets.
    const hour = this.sql
      .exec<{ n: number; first: number | null }>(
        "SELECT COUNT(*) AS n, MIN(at) AS first FROM captures WHERE at > ?",
        now - 3600
      )
      .one();
    if (hour.n >= this.config.sendsPerHour) {
      const retryAfter = Math.max(1, (hour.first ?? now) + 3600 - now);
      return { ok: false, status: 503, error: "the game is at its hourly ride limit", retryAfter };
    }
    const last = this.sql
      .exec<{ at: number }>(
        "SELECT at FROM captures WHERE robot_id = ? AND player = ? AND reverted = 0 ORDER BY seq DESC LIMIT 1",
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
      // Re-sync and retry once.
      if (!NONCE_DRIFT_RE.test(String(err))) throw err;
      nonce = await this.nextNonce(client, account, true);
      txHash = await wallet.writeContract({ ...request, nonce });
    }
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('nonce', ?)", String(nonce + 1));
    const seq = this.record(slug, c, txHash, now);
    let sentBlock = -1;
    try {
      sentBlock = Number(await client.getBlockNumber());
    } catch {
      // The alarm fills it in.
    }
    // A re-sync can hand out a nonce whose earlier send was dropped: that one is gone.
    const earlier = this.sql.exec<{ seq: number }>("SELECT seq FROM pending WHERE nonce = ?", nonce).toArray()[0];
    if (earlier?.seq) this.markReverted(earlier.seq);
    this.sql.exec(
      "INSERT OR REPLACE INTO pending (nonce, seq, capture, sig, hashes, sent_block, tries, sent_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      nonce,
      seq,
      JSON.stringify({ ...c, nonce: String(c.nonce), deadline: String(c.deadline) }),
      signature,
      JSON.stringify([txHash]),
      sentBlock,
      now
    );
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    return { ok: true, txHash };
  }

  // ---- stuck transactions ----

  /** Serialised with captures, since a re-send reuses a nonce. */
  async alarm(): Promise<void> {
    const run = this.lock.then(() => this.checkPending());
    this.lock = run.catch(() => undefined);
    await run;
  }

  private async checkPending(): Promise<void> {
    try {
      await this.checkPendingNow();
    } catch (err) {
      // Logged and retried on the next alarm, not thrown: a throwing alarm is also retried
      // by the runtime, on top of the re-arm below.
      console.error("capture-flag: pending check failed", String(err));
    } finally {
      if (this.sql.exec("SELECT 1 FROM pending LIMIT 1").toArray().length) {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
      }
    }
  }

  private async checkPendingNow(): Promise<void> {
    const rows = this.sql.exec<PendingRow>("SELECT * FROM pending ORDER BY nonce").toArray();
    if (!rows.length) return;
    const account = this.relayerAccount();
    const rpcUrl = rpcUrlOf(this.env);
    const client = publicClientFor(this.config, rpcUrl);
    const wallet = createWalletClient({ account, chain: chainFor(this.config, rpcUrl), transport: http(rpcUrl) });
    const [mined, block] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: "latest" }),
      client.getBlockNumber(),
    ]);
    for (const row of rows) {
      if (row.nonce < mined) {
        await this.settle(client, row);
      } else if (row.sent_block < 0) {
        this.sql.exec("UPDATE pending SET sent_block = ? WHERE nonce = ?", Number(block), row.nonce);
      } else if (block - BigInt(row.sent_block) >= STUCK_BLOCKS) {
        if (row.tries === MAX_RESENDS) {
          // Kept, so a late mine still settles and /health reports it; logged once.
          console.error("capture-flag: giving up on a stuck transaction", JSON.stringify({ nonce: row.nonce, hashes: row.hashes }));
          this.sql.exec("UPDATE pending SET tries = tries + 1 WHERE nonce = ?", row.nonce);
        } else if (row.tries < MAX_RESENDS) {
          await this.resend(client, wallet, account, row, block);
        }
      }
    }
  }

  /** For /health: how many sends are unmined, and the oldest one's age. */
  pendingSummary(): { pending: number; oldestSentAt: number | null } {
    const row = this.sql
      .exec<{ n: number; oldest: number | null }>("SELECT COUNT(*) AS n, MIN(sent_at) AS oldest FROM pending")
      .one();
    return { pending: row.n, oldestSentAt: row.oldest };
  }

  /** The current transaction for a player's capture, which the alarm may have replaced;
   * null if there's none or it never made it on-chain. The robot page polls this. */
  captureTx(player: string, nonce: string): { tx: string; at: number } | null {
    const row = this.sql
      .exec<{ seq: number; tx: string; at: number }>(
        "SELECT seq, tx, at FROM captures WHERE player = ? AND nonce = ? AND reverted = 0",
        player.toLowerCase(),
        nonce
      )
      .toArray()[0];
    if (!row) return null;
    // Unmined: its latest send. The log's tx is fixed up when it settles.
    const pending = this.sql.exec<{ hashes: string }>("SELECT hashes FROM pending WHERE seq = ?", row.seq).toArray()[0];
    const tx = pending ? (JSON.parse(pending.hashes) as string[]).at(-1)! : row.tx;
    return { tx, at: row.at };
  }

  /** The nonce is used: find which of our hashes it was, and fix the log to match. */
  private async settle(client: PublicClient, row: PendingRow): Promise<void> {
    const hashes = JSON.parse(row.hashes) as `0x${string}`[];
    let captured = false;
    for (const hash of [...hashes].reverse()) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (err) {
        // Only "no such receipt" means not this one; any other error leaves the row for
        // the next alarm rather than guessing.
        if (err instanceof BaseError && err.walk((e) => e instanceof TransactionReceiptNotFoundError)) continue;
        throw err;
      }
      const isCapture = receipt.to?.toLowerCase() === this.config.contract.toLowerCase();
      captured = isCapture && receipt.status === "success";
      if (row.seq && captured) this.sql.exec("UPDATE captures SET tx = ? WHERE seq = ?", hash, row.seq);
      if (!row.seq && captured) {
        // The original beat its no-op: on-chain, but out of the log.
        console.warn("capture-flag: a capture marked reverted was mined", JSON.stringify({ nonce: row.nonce, hash }));
      }
      break;
    }
    // Reverted, or the nonce went to a transaction that isn't ours: no capture happened.
    if (row.seq && !captured) this.markReverted(row.seq);
    this.sql.exec("DELETE FROM pending WHERE nonce = ?", row.nonce);
  }

  private async resend(
    client: PublicClient,
    wallet: WalletClient<HttpTransport, Chain, PrivateKeyAccount>,
    account: PrivateKeyAccount,
    row: PendingRow,
    block: bigint
  ): Promise<void> {
    const hashes = JSON.parse(row.hashes) as `0x${string}`[];
    const prev = await client.getTransaction({ hash: hashes.at(-1)! }).catch(() => null);
    const now = await client.estimateFeesPerGas();
    const bump = (x: bigint | undefined) => ((x ?? 0n) * 5n) / 4n;
    const maxPriorityFeePerGas = max(bump(prev?.maxPriorityFeePerGas), now.maxPriorityFeePerGas);
    const maxFeePerGas = max(bump(prev?.maxFeePerGas), now.maxFeePerGas, maxPriorityFeePerGas);
    const fees = { nonce: row.nonce, maxFeePerGas, maxPriorityFeePerGas };

    let seq = row.seq;
    let hash: `0x${string}`;
    const c = JSON.parse(row.capture) as { robotId: `0x${string}`; player: `0x${string}`; nonce: string; deadline: string };
    const capture: Capture = { ...c, nonce: BigInt(c.nonce), deadline: BigInt(c.deadline) };
    try {
      const call = {
        address: this.config.contract,
        abi: captureFlagAbi,
        functionName: "captureBySig",
        args: [capture, row.sig as `0x${string}`],
      } as const;
      await client.simulateContract({ account, ...call });
      hash = await wallet.writeContract({ ...call, ...fees });
    } catch (err) {
      const reverted =
        err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (!reverted) throw err;
      // It would revert now (most likely Expired): free the nonce with a no-op instead.
      hash = await wallet.sendTransaction({ to: account.address, value: 0n, ...fees });
      if (seq) this.markReverted(seq);
      seq = 0;
    }
    this.sql.exec(
      "UPDATE pending SET seq = ?, hashes = ?, sent_block = ?, tries = tries + 1 WHERE nonce = ?",
      seq,
      JSON.stringify([...hashes, hash]),
      Number(block),
      row.nonce
    );
  }

  /** The relayer's public address, for /health; null if the key is missing or malformed. */
  address(): string | null {
    try {
      return this.relayerAccount().address;
    } catch {
      return null;
    }
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

  /** Undo `record`'s counts for a logged capture that never made it on-chain. The row
   * stays, marked, so the hourly budget still counts the send. A count's `reached` is
   * the seq of the capture that brought it there, so it falls back to the latest left. */
  private markReverted(seq: number): void {
    const row = this.sql
      .exec<{ robot_id: string; player: string }>(
        "SELECT robot_id, player FROM captures WHERE seq = ? AND reverted = 0",
        seq
      )
      .toArray()[0];
    if (!row) return;
    this.sql.exec("UPDATE captures SET reverted = 1 WHERE seq = ?", seq);
    const pair = this.sql
      .exec<{ seq: number }>(
        "SELECT seq FROM captures WHERE robot_id = ? AND player = ? AND reverted = 0 ORDER BY seq DESC LIMIT 1",
        row.robot_id,
        row.player
      )
      .toArray()[0];
    if (pair) {
      this.sql.exec(
        "UPDATE counts SET n = n - 1, reached = ? WHERE robot_id = ? AND player = ?",
        pair.seq,
        row.robot_id,
        row.player
      );
    } else {
      this.sql.exec("DELETE FROM counts WHERE robot_id = ? AND player = ?", row.robot_id, row.player);
    }
    const mine = this.sql
      .exec<{ seq: number }>(
        "SELECT seq FROM captures WHERE player = ? AND reverted = 0 ORDER BY seq DESC LIMIT 1",
        row.player
      )
      .toArray()[0];
    if (mine) this.sql.exec("UPDATE totals SET n = n - 1, reached = ? WHERE player = ?", mine.seq, row.player);
    else this.sql.exec("DELETE FROM totals WHERE player = ?", row.player);
  }

  private record(slug: string, c: Capture, tx: string, at: number): number {
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
    return seq;
  }

  // ---- reads ----

  /** Latest captures of one robot, newest first, plus its ranking. Ties go to whoever
   * reached the count first, the contract's rule, so top[0] is `topCapturer`. */
  drivers(robotId: string, limit: number): { recent: Driver[]; top: Ranked[]; rides: number; drivers: number } {
    const recent = this.sql
      .exec<{ player: string; tx: string; at: number }>(
        "SELECT player, tx, at FROM captures WHERE robot_id = ? AND reverted = 0 ORDER BY seq DESC LIMIT ?",
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

  /** Rides and distinct drivers per robot id, for the admin page. */
  robotTotals(): Record<string, { rides: number; drivers: number }> {
    const rows = this.sql
      .exec<{ robot_id: string; rides: number; drivers: number }>(
        "SELECT robot_id, SUM(n) AS rides, COUNT(*) AS drivers FROM counts GROUP BY robot_id"
      )
      .toArray();
    return Object.fromEntries(rows.map((r) => [r.robot_id, { rides: r.rides, drivers: r.drivers }]));
  }

  // ---- player names ----

  /** Cached names for these (lowercase) addresses; addresses with none are left out. */
  namesFor(addresses: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const address of new Set(addresses)) {
      const row = this.sql
        .exec<{ name: string | null }>("SELECT name FROM names WHERE address = ?", address)
        .toArray()[0];
      if (row?.name) out[address] = row.name;
    }
    return out;
  }

  /** Which of these addresses have no name check newer than `ttlSeconds`, up to `limit`. */
  staleNames(addresses: string[], ttlSeconds: number, limit: number): string[] {
    const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;
    return addresses
      .filter((address) => {
        const row = this.sql
          .exec<{ checked_at: number }>("SELECT checked_at FROM names WHERE address = ?", address)
          .toArray()[0];
        return !row || row.checked_at < cutoff;
      })
      .slice(0, limit);
  }

  saveNames(entries: Array<{ address: string; name: string | null }>): void {
    const now = Math.floor(Date.now() / 1000);
    for (const { address, name } of entries) {
      this.sql.exec(
        "INSERT OR REPLACE INTO names (address, name, checked_at) VALUES (?, ?, ?)",
        address.toLowerCase(),
        name,
        now
      );
    }
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

function max(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b > a ? b : a));
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
      // The owner's on-chain hard stop (setRelayer(0)), or a rotated key not yet deployed.
      return { ok: false, status: 503, error: "captures are stopped" };
    default:
      throw err;
  }
}
