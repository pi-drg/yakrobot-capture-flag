/**
 * Cloudflare Access for `/admin*`. A self-hosted Access application on the custom domain,
 * scoped to `/admin*`, logs admins in by email before a request reaches the Worker; this
 * file is the Worker's own check of that login. It is required, not belt-and-braces: a
 * Worker gets the identity only as request headers, which anyone reaching it some other
 * way (a workers.dev or preview hostname, a future route) can forge. So the
 * `Cf-Access-Jwt-Assertion` JWT is verified against the team's signing keys: RS256, `kid`,
 * signature, `exp`/`nbf`, `aud`, `iss`. `Cf-Access-Authenticated-User-Email` is never
 * read; the email comes from the verified token. Fails closed: 501 while the vars are
 * blank, 401 for anything else wrong, including an unreachable certs endpoint.
 */

export class AccessError extends Error {
  constructor(
    readonly status: 401 | 501,
    message: string
  ) {
    super(message);
  }
}

export interface AccessClaims {
  email: string;
  exp: number;
}

const MAX_TOKEN_BYTES = 8192;

export function accessConfigured(env: Env): boolean {
  return Boolean(env.CF_ACCESS_TEAM_DOMAIN?.trim() && env.CF_ACCESS_AUD?.trim());
}

function b64urlBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

function b64urlJson(segment: string): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder().decode(b64urlBytes(segment)));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

/** Per request, like the registrar: admin traffic is a handful of requests, and the edge
 * cache (5 min) absorbs repeats. Right after Access rotates its keys, an unknown `kid`
 * can 401 for up to that long. */
async function fetchKeys(env: Env, team: string): Promise<Jwk[]> {
  const url = env.CF_ACCESS_CERTS_URL?.trim() || `https://${team}/cdn-cgi/access/certs`;
  let body: { keys?: unknown };
  try {
    const res = await fetch(url, {
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as { keys?: unknown };
  } catch (err) {
    throw new AccessError(401, `could not reach the Access certs endpoint: ${(err as Error).message}`);
  }
  if (!Array.isArray(body.keys) || !body.keys.length) throw new AccessError(401, "the Access certs endpoint returned no keys");
  return body.keys as Jwk[];
}

export async function verifyAccess(
  request: Request,
  env: Env,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<AccessClaims> {
  if (!accessConfigured(env)) throw new AccessError(501, "Cloudflare Access is not configured (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD)");
  const team = env.CF_ACCESS_TEAM_DOMAIN!.trim();
  const aud = env.CF_ACCESS_AUD!.trim();

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AccessError(401, "missing Cf-Access-Jwt-Assertion header");
  if (token.length > MAX_TOKEN_BYTES) throw new AccessError(401, "token too long");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError(401, "not a JWT");
  const [h, p, s] = parts;

  let header: Record<string, unknown>, claims: Record<string, unknown>, signature: Uint8Array;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
    signature = b64urlBytes(s);
  } catch {
    throw new AccessError(401, "malformed JWT");
  }
  if (header.alg !== "RS256") throw new AccessError(401, "unsupported alg");
  if (typeof header.kid !== "string") throw new AccessError(401, "JWT has no kid");

  const jwk = (await fetchKeys(env, team)).find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new AccessError(401, "no Access key matches this JWT's kid");
  let ok: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${h}.${p}`));
  } catch {
    ok = false;
  }
  if (!ok) throw new AccessError(401, "bad signature");

  if (typeof claims.exp !== "number" || nowSeconds >= claims.exp) throw new AccessError(401, "token expired");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || nowSeconds < claims.nbf)) {
    throw new AccessError(401, "token not yet valid");
  }
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new AccessError(401, "token is for another Access application");
  if (claims.iss !== `https://${team}`) throw new AccessError(401, "token is from another Access team");
  if (typeof claims.email !== "string" || !claims.email) throw new AccessError(401, "token has no email");
  return { email: claims.email, exp: claims.exp };
}
