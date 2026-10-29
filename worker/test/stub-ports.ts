/**
 * Shared by vitest.config.ts (Node: the ROBOTS binding), test/global-setup.ts (Node: the
 * stub servers) and the tests (workerd: setting stub state). Plain data, no imports.
 */

export const STUB_ROBOT = "picar_freenove";

/** One stub gateway per robot slug. */
export const STUB_PORTS = {
  status: 18550,
  busy: 18551,
  down: 18552,
  "no-ui": 18553,
  "not-flag": 18554,
  error: 18555,
  hang: 18556,
  capture: 18557,
} as const;

/** Nothing listens here: connection refused. */
export const DEAD_PORT = 18559;

/** The ROBOTS binding the Worker sees under test. */
export function testRobots(): Record<string, unknown> {
  const robots: Record<string, unknown> = {};
  for (const [slug, port] of Object.entries(STUB_PORTS)) {
    robots[slug] = { gateway: `http://127.0.0.1:${port}`, robot: STUB_ROBOT, label: slug, place: "Test" };
  }
  robots.dead = { gateway: `http://127.0.0.1:${DEAD_PORT}`, robot: STUB_ROBOT, label: "dead", place: "Test" };
  return robots;
}

/** Set one stub gateway's behaviour (see test/global-setup.ts for the states). */
export async function setStub(slug: keyof typeof STUB_PORTS, state: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${STUB_PORTS[slug]}/__state`, {
    method: "POST",
    body: JSON.stringify({ state }),
  });
  if (res.status !== 204) throw new Error(`stub ${slug}: ${res.status}`);
}

/** The stub CDP faucet (test/global-setup.ts). */
export const FAUCET_PORT = 18560;
export const FAUCET_BASE = `http://127.0.0.1:${FAUCET_PORT}/platform`;
/** A throwaway Ed25519 key, generated for these tests only: seed then public key. */
export const CDP_TEST_KEY_ID = "test-key-id";
export const CDP_TEST_KEY_SECRET = "jcXy4XESuLoq+iN9SyejDTEHZ1Gpc++T4n9r1f4BXNItaocBiLIHpqm5J6fnXnQKR29nI9BRcmn/khimQVTzyQ==";

/** "ok", or "refuse_after:<n>" to accept n claims and then answer 429 like the daily cap. */
export async function setFaucet(state: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${FAUCET_PORT}/__state`, { method: "POST", body: JSON.stringify({ state }) });
  if (res.status !== 204) throw new Error(`faucet stub: ${res.status}`);
}

/** Every claim the stub accepted since the last setFaucet, as its JSON body. */
export async function faucetClaims(): Promise<Array<{ address: string; network: string; token: string }>> {
  return (await (await fetch(`http://127.0.0.1:${FAUCET_PORT}/__claims`)).json()) as never;
}

/** The stub Cloudflare Access team (test/global-setup.ts): its JWKS, and a token minter. */
export const ACCESS_PORT = 18561;
export const ACCESS_CERTS_URL = `http://127.0.0.1:${ACCESS_PORT}/cdn-cgi/access/certs`;
export const TEST_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
export const TEST_AUD = "test-aud-3beb7beb0de5e3bc";
export const TEST_ADMIN_EMAIL = "admin@example.com";

export interface TokenOverrides {
  aud?: unknown;
  exp?: number;
  nbf?: number;
  iss?: string;
  email?: unknown;
  kid?: string;
  alg?: string;
  /** "other": signed by a key the JWKS doesn't publish. */
  key?: "main" | "other";
}

/** A JWT signed the way Access signs one, minted by the stub so no private key is in the repo. */
export async function accessToken(overrides: TokenOverrides = {}): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${ACCESS_PORT}/__token`, { method: "POST", body: JSON.stringify(overrides) });
  if (!res.ok) throw new Error(`access stub: ${res.status}`);
  return res.text();
}
