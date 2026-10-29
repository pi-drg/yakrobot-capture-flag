/**
 * The admin page's "Top up from faucet": claims Base Sepolia ETH for the relayer from the
 * CDP faucet (0.0001 ETH a claim, 0.1 ETH a day per address). Needs a CDP Secret API Key
 * (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`): an Ed25519 key, the CDP default. No wallet
 * secret; nothing here signs a transaction. Not imported from @coinbase/cdp-sdk, which is
 * built for Node: the request's JWT is signed with WebCrypto instead, in the SDK's format.
 */

export const FAUCET_CHAIN_ID = 84532;
const DEFAULT_API_BASE = "https://api.cdp.coinbase.com/platform";
const FAUCET_PATH = "/v2/evm/faucet";
const JWT_TTL_S = 120;

export class FaucetError extends Error {}

export function faucetConfigured(env: Env): boolean {
  return Boolean(env.CDP_API_KEY_ID?.trim() && env.CDP_API_KEY_SECRET?.trim());
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64urlJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * A CDP request JWT: EdDSA, `kid` = key id, a random hex `nonce` in the header, and a
 * `uris` claim of "METHOD host/path" for the one request it authorises.
 */
export async function cdpJwt(
  keyId: string,
  keySecret: string,
  method: string,
  url: URL,
  nowSeconds: number
): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(keySecret.trim()), (ch) => ch.charCodeAt(0));
  } catch {
    throw new FaucetError("CDP_API_KEY_SECRET must be a base64 Ed25519 key");
  }
  // 32 bytes of seed, then the 32-byte public key.
  if (raw.length !== 64) throw new FaucetError("CDP_API_KEY_SECRET must be a base64 Ed25519 key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", d: b64url(raw.slice(0, 32)), x: b64url(raw.slice(32)) },
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
  const claims = {
    sub: keyId,
    iss: "cdp",
    uris: [`${method} ${url.host}${url.pathname}`],
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + JWT_TTL_S,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

export interface TopUp {
  /** One transaction hash per claim that the faucet accepted. */
  hashes: string[];
  /** Why claiming stopped early, e.g. the daily cap; absent if every claim went through. */
  error?: string;
}

/**
 * `claims` faucet requests for `address`, one after another, without waiting for receipts
 * (the faucet sends from its own wallet, not the relayer's nonce). Stops at the first refusal.
 */
export async function topUp(env: Env, address: string, claims: number): Promise<TopUp> {
  if (!faucetConfigured(env)) throw new FaucetError("the faucet key isn't set (CDP_API_KEY_ID, CDP_API_KEY_SECRET)");
  const url = new URL((env.CDP_API_BASE?.trim() || DEFAULT_API_BASE) + FAUCET_PATH);
  const hashes: string[] = [];
  for (let i = 0; i < claims; i++) {
    const jwt = await cdpJwt(env.CDP_API_KEY_ID!, env.CDP_API_KEY_SECRET!, "POST", url, Math.floor(Date.now() / 1000));
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ address, network: "base-sepolia", token: "eth" }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { hashes, error: `faucet unreachable: ${(err as Error).message}` };
    }
    const body = (await res.json().catch(() => ({}))) as { transactionHash?: string; errorMessage?: string };
    if (!res.ok || !body.transactionHash) {
      return { hashes, error: `faucet refused (${res.status}): ${body.errorMessage ?? "no reason given"}` };
    }
    hashes.push(body.transactionHash);
  }
  return { hashes };
}
