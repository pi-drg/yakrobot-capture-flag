import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cdpJwt, FaucetError, topUp } from "../src/faucet";
import { type Relayer, RELAYER_NAME } from "../src/relayer";
import { RELAYER_ADDRESS } from "./anvil";
import { adminHeaders, randomIp } from "./game";
import { accessToken, faucetClaims, setFaucet } from "./stub-ports";

const BASE = "https://capture-flag.test";
const now = () => Math.floor(Date.now() / 1000);

async function topup(headers?: Record<string, string>) {
  const res = await SELF.fetch(`${BASE}/admin/topup`, {
    method: "POST",
    headers: headers ?? adminHeaders(await accessToken()),
    body: "{}",
  });
  return { code: res.status, retryAfter: res.headers.get("Retry-After"), body: (await res.json()) as Record<string, any> };
}

/** Forget the last top-up, so the one-a-minute guard doesn't carry between tests. */
async function resetGap(): Promise<void> {
  const stub = env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME));
  await runInDurableObject(stub, (_: Relayer, state: DurableObjectState) => {
    state.storage.sql.exec("DELETE FROM kv WHERE key = 'topup_at'");
  });
}

describe("relayer top-up", () => {
  beforeEach(async () => {
    await setFaucet("ok");
    await resetGap();
  });

  it("shows the relayer's address, balance and the faucet on /admin/state", async () => {
    const res = await SELF.fetch(`${BASE}/admin/state`, { headers: adminHeaders(await accessToken()) });
    const s = (await res.json()) as Record<string, any>;
    expect(s.relayer.address).toBe(RELAYER_ADDRESS);
    expect(BigInt(s.relayer.balance_wei)).toBeGreaterThan(0n);
    expect(s.faucet).toEqual({ available: true, configured: true, claims: 20 });
  });

  it("claims TOPUP_CLAIMS times for the relayer", async () => {
    const res = await topup();
    expect(res.code).toBe(200);
    expect(res.body.claims).toBe(20);
    expect(res.body.hashes).toHaveLength(20);
    expect(res.body.error).toBeUndefined();
    const claims = await faucetClaims();
    expect(claims).toHaveLength(20);
    expect(claims.every((c) => c.address === RELAYER_ADDRESS && c.network === "base-sepolia" && c.token === "eth")).toBe(true);
  });

  it("refuses a second top-up within a minute, and claims nothing", async () => {
    expect((await topup()).code).toBe(200);
    await setFaucet("ok");
    const again = await topup();
    expect(again).toMatchObject({ code: 429, retryAfter: "60" });
    expect(await faucetClaims()).toHaveLength(0);
  });

  it("stops at the first refusal and reports how many landed", async () => {
    await setFaucet("refuse_after:3");
    const res = await topup();
    expect(res.code).toBe(200);
    expect(res.body.claims).toBe(3);
    expect(res.body.error).toContain("429");
  });

  it("502s when the faucet refuses the first claim", async () => {
    await setFaucet("refuse_after:0");
    const res = await topup();
    expect(res.code).toBe(502);
    expect(res.body.claims).toBe(0);
  });

  it("401s without Access, and claims nothing", async () => {
    const res = await topup({ "content-type": "application/json", "cf-connecting-ip": randomIp() });
    expect(res.code).toBe(401);
    expect(await faucetClaims()).toHaveLength(0);
  });
});

describe("faucet", () => {
  it("refuses without the CDP key", async () => {
    await expect(topUp({} as Env, RELAYER_ADDRESS, 1)).rejects.toThrow(FaucetError);
  });

  it("refuses a key that isn't a base64 Ed25519 key", async () => {
    const url = new URL("https://api.cdp.coinbase.com/platform/v2/evm/faucet");
    await expect(cdpJwt("id", btoa("short"), "POST", url, now())).rejects.toThrow(FaucetError);
  });
});
