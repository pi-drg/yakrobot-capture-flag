import { captureFlagAbi } from "./abi";
import { publicClientFor, rpcUrlOf } from "./chain";
import type { Config } from "./config";

/**
 * `GET /health` and the 15-minute cron. `balance_ok` (can the relayer pay
 * gas?) and `relayer_set` (does the contract still accept our relayer, or did the owner
 * hard-stop it?) are reported apart, so "out of gas" and "stopped" look different.
 * A send unmined for STUCK_S is unhealthy too: the alarm has given up or is failing, and
 * every later capture queues behind its nonce.
 * Paused is reported but isn't unhealthy: it's the owner's choice.
 */

const STUCK_S = 300;

export interface Health {
  ok: boolean;
  chain: string;
  contract: string;
  /** The relayer's public address, from the DO; null if its key is missing. */
  relayer: string | null;
  /** A decimal string: bigint doesn't survive JSON. */
  balance_wei: string | null;
  balance_ok: boolean;
  relayer_set: boolean;
  paused: boolean;
  /** Sends not yet mined, and how long the oldest has waited. */
  pending: number;
  oldest_pending_s: number | null;
  error?: string;
}

/** Two RPC calls per check on a public route, so a check is reused for 30 s. */
const CACHE_MS = 30_000;
let cache: { contract: string; value: Health; at: number } | undefined;

export async function checkHealth(
  env: Env,
  config: Config,
  relayer: {
    address(): Promise<string | null>;
    switches(): Promise<{ paused: boolean }>;
    pendingSummary(): Promise<{ pending: number; oldestSentAt: number | null }>;
  },
  { fresh = false } = {}
): Promise<Health> {
  const now = Date.now();
  if (!fresh && cache && cache.contract === config.contract && now - cache.at < CACHE_MS) return cache.value;

  const [address, { paused }, { pending, oldestSentAt }] = await Promise.all([
    relayer.address(),
    relayer.switches(),
    relayer.pendingSummary(),
  ]);
  const oldest = oldestSentAt === null ? null : Math.max(0, Math.floor(now / 1000) - oldestSentAt);
  const health: Health = {
    ok: false,
    chain: String(config.chainId),
    contract: config.contract,
    relayer: address,
    balance_wei: null,
    balance_ok: false,
    relayer_set: false,
    paused,
    pending,
    oldest_pending_s: oldest,
  };
  if (!address) {
    health.error = "RELAYER_PRIVATE_KEY is missing or malformed";
  } else {
    try {
      const client = publicClientFor(config, rpcUrlOf(env));
      const [balance, onChain] = await Promise.all([
        client.getBalance({ address: address as `0x${string}` }),
        client.readContract({ address: config.contract, abi: captureFlagAbi, functionName: "relayer" }),
      ]);
      health.balance_wei = String(balance);
      health.balance_ok = balance >= config.relayerMinWei;
      health.relayer_set = onChain.toLowerCase() === address.toLowerCase();
      const stuck = oldest !== null && oldest >= STUCK_S;
      health.ok = health.balance_ok && health.relayer_set && !stuck;
      if (!health.balance_ok) health.error = "relayer balance is below RELAYER_MIN_WEI";
      else if (!health.relayer_set) health.error = "the contract's relayer is not this Worker's (hard stop?)";
      else if (stuck) health.error = `a relayer transaction has been unmined for ${oldest} s`;
    } catch {
      health.error = "chain unavailable";
    }
  }
  cache = { contract: config.contract, value: health, at: now };
  return health;
}
