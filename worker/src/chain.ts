import { type Chain, createPublicClient, defineChain, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { captureFlagAbi } from "./abi";
import type { Config } from "./config";

/**
 * Read-side chain access. `RPC_URL` is a Worker secret (it may embed a provider key), so
 * it's read here and never sent to a page.
 */

export class ChainConfigError extends Error {}

/** The viem chain for `CHAIN`, pointed at `RPC_URL` (anvil under test keeps id 84532). */
export function chainFor(config: Config, rpcUrl: string): Chain {
  const known = config.chainId === 8453 ? base : baseSepolia;
  return defineChain({ ...known, rpcUrls: { default: { http: [rpcUrl] } } });
}

export function rpcUrlOf(env: { RPC_URL?: string }): string {
  const url = (env.RPC_URL ?? "").trim();
  if (!url) throw new ChainConfigError("RPC_URL is required (a Worker secret)");
  return url;
}

export function publicClientFor(config: Config, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: chainFor(config, rpcUrl), transport: http(rpcUrl) });
}

/** `cooldown()` changes only by an owner transaction, so a minute's cache is plenty. */
let cooldownCache: { contract: string; value: bigint; at: number } | undefined;

export async function readCooldown(client: PublicClient, config: Config): Promise<bigint> {
  const now = Date.now();
  if (cooldownCache && cooldownCache.contract === config.contract && now - cooldownCache.at < 60_000) {
    return cooldownCache.value;
  }
  const value = await client.readContract({
    address: config.contract,
    abi: captureFlagAbi,
    functionName: "cooldown",
  });
  cooldownCache = { contract: config.contract, value, at: now };
  return value;
}

/** Seconds until `player` may capture `robotId` again; 0 when they may now. */
export async function cooldownRemaining(
  client: PublicClient,
  config: Config,
  robotId: `0x${string}`,
  player: `0x${string}`,
  nowSeconds: bigint
): Promise<bigint> {
  const [last, cooldown] = await Promise.all([
    client.readContract({
      address: config.contract,
      abi: captureFlagAbi,
      functionName: "lastCapture",
      args: [robotId, player],
    }),
    readCooldown(client, config),
  ]);
  if (last === 0n || nowSeconds >= last + cooldown) return 0n;
  return last + cooldown - nowSeconds;
}
