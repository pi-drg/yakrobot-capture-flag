import { createPublicClient, http } from "viem";
import { base, mainnet } from "viem/chains";
import { toCoinType } from "viem/ens";

/**
 * Names for the drivers lists: a player's Basename (alice.base.eth) if they set one as
 * their Base primary name, else their mainnet ENS primary name. Both come from the ENS
 * Universal Resolver on Ethereum mainnet (ENSIP-19), which checks the name resolves back
 * to the address, so nobody can show someone else's name.
 *
 * Off unless the `ENS_RPC_URL` secret (an Ethereum mainnet RPC) is set. Lookups never
 * hold up a response: routes serve what's cached and refresh the rest afterwards.
 */

/** A name is re-checked after a day, since primary names can change. */
export const NAME_TTL_S = 86_400;
/** At most this many lookups per request, each with a timeout. */
const BATCH = 20;
const TIMEOUT_MS = 8_000;
/** Names are user-chosen; cap what we store and serve. */
const MAX_LEN = 64;

const BASE_COIN_TYPE = toCoinType(base.id);

/** What a lookup needs; a viem public client, or a fake under test. */
export interface EnsReader {
  getEnsName(args: { address: `0x${string}`; coinType?: bigint }): Promise<string | null>;
}

export function ensReaderFor(env: { ENS_RPC_URL?: string }): EnsReader | null {
  const url = (env.ENS_RPC_URL ?? "").trim();
  if (!url) return null;
  return createPublicClient({ chain: mainnet, transport: http(url, { timeout: TIMEOUT_MS }) });
}

/** The Basename, else the ENS name, else null. Throws if the RPC fails, so a failure
 * isn't cached as "no name". */
export async function lookupName(reader: EnsReader, address: `0x${string}`): Promise<string | null> {
  const name =
    (await reader.getEnsName({ address, coinType: BASE_COIN_TYPE })) ?? (await reader.getEnsName({ address }));
  return name && name.length <= MAX_LEN ? name : null;
}

interface NameStore {
  staleNames(addresses: string[], ttlSeconds: number, limit: number): Promise<string[]>;
  saveNames(entries: Array<{ address: string; name: string | null }>): Promise<void>;
}

/** Look up whichever of `addresses` aren't cached (or are a day old), and store them. */
export async function refreshNames(reader: EnsReader | null, store: NameStore, addresses: string[]): Promise<void> {
  if (!reader || !addresses.length) return;
  const stale = await store.staleNames([...new Set(addresses)], NAME_TTL_S, BATCH);
  const results = await Promise.allSettled(
    stale.map(async (address) => ({ address, name: await lookupName(reader, address as `0x${string}`) }))
  );
  const found = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (found.length) await store.saveNames(found);
}
