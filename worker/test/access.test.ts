import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { adminHeaders, randomIp } from "./game";
import { accessToken, TEST_ADMIN_EMAIL, TEST_AUD, type TokenOverrides } from "./stub-ports";

const BASE = "https://capture-flag.test";
const now = () => Math.floor(Date.now() / 1000);

async function stateWith(token: string | null): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": randomIp() };
  if (token !== null) headers["cf-access-jwt-assertion"] = token;
  return SELF.fetch(`${BASE}/admin/state`, { headers });
}

/** A valid token with one part swapped for another's: a signature that doesn't match. */
async function tampered(): Promise<string> {
  const [h, , s] = (await accessToken()).split(".");
  const [, p] = (await accessToken({ email: "intruder@example.com" })).split(".");
  return `${h}.${p}.${s}`;
}

describe("Cloudflare Access on /admin", () => {
  it("lets a valid token through and names its email", async () => {
    const res = await stateWith(await accessToken());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { admin: { email: string } }).admin.email).toBe(TEST_ADMIN_EMAIL);
  });

  it("accepts aud as a bare string too", async () => {
    expect((await stateWith(await accessToken({ aud: TEST_AUD }))).status).toBe(200);
  });

  it.each<[string, TokenOverrides]>([
    ["signed by a key the team doesn't publish", { key: "other" }],
    ["an unknown kid", { kid: "nope" }],
    ["alg none", { alg: "none" }],
    ["alg HS256", { alg: "HS256" }],
    ["expired", { exp: now() - 1 }],
    ["not yet valid", { nbf: now() + 60 }],
    ["for another application", { aud: ["someone-else"] }],
    ["from another team", { iss: "https://evil.cloudflareaccess.com" }],
    ["without an email", { email: "" }],
  ])("401s a token %s", async (_, overrides) => {
    expect((await stateWith(await accessToken(overrides))).status).toBe(401);
  });

  it("401s no token, garbage, and a tampered payload", async () => {
    expect((await stateWith(null)).status).toBe(401);
    expect((await stateWith("not.a.jwt")).status).toBe(401);
    expect((await stateWith(await tampered())).status).toBe(401);
  });

  it("gates the page itself, bare /admin included", async () => {
    expect((await SELF.fetch(`${BASE}/admin`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/admin/`)).status).toBe(401);
  });

  it("never trusts the email header on its own", async () => {
    const res = await SELF.fetch(`${BASE}/admin/state`, {
      headers: { "cf-access-authenticated-user-email": TEST_ADMIN_EMAIL, "cf-connecting-ip": randomIp() },
    });
    expect(res.status).toBe(401);
  });

  it("leaves the public pages public", async () => {
    for (const path of ["/", "/robots", "/leaderboard", "/r/status"]) {
      expect((await SELF.fetch(`${BASE}${path}`)).status).toBe(200);
    }
  });

  it.each(["CF_ACCESS_AUD", "CF_ACCESS_TEAM_DOMAIN"])("501s while %s is blank", async (name) => {
    const ctx = createExecutionContext();
    const req = new Request(`${BASE}/admin/state`, { headers: { "cf-access-jwt-assertion": await accessToken() } });
    const res = await worker.fetch(req, { ...env, [name]: "" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(501);
  });
});

describe("same-origin JSON on admin POSTs", () => {
  async function postWith(extra: Record<string, string>): Promise<number> {
    const res = await SELF.fetch(`${BASE}/admin/state`, {
      method: "POST",
      headers: { ...adminHeaders(await accessToken()), ...extra },
      body: JSON.stringify({ action: "disable", target: "busy" }),
    });
    return res.status;
  }

  it("415s a form-style content type, even with JSON inside", async () => {
    expect(await postWith({ "content-type": "text/plain" })).toBe(415);
    expect(await postWith({ "content-type": "application/x-www-form-urlencoded" })).toBe(415);
  });

  it("403s another origin or a cross-site fetch", async () => {
    expect(await postWith({ origin: "https://evil.example" })).toBe(403);
    expect(await postWith({ origin: "null" })).toBe(403);
    expect(await postWith({ "sec-fetch-site": "cross-site" })).toBe(403);
  });

  it("accepts its own origin, and a charset on the content type", async () => {
    expect(await postWith({ origin: BASE, "sec-fetch-site": "same-origin" })).toBe(200);
    expect(await postWith({ "content-type": "application/json; charset=utf-8" })).toBe(200);
    // Put it back.
    const res = await SELF.fetch(`${BASE}/admin/state`, {
      method: "POST",
      headers: adminHeaders(await accessToken()),
      body: JSON.stringify({ action: "enable", target: "busy" }),
    });
    expect(res.status).toBe(200);
  });
});
