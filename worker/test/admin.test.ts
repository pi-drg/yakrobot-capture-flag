import { SELF } from "cloudflare:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { robotIdFor } from "../src/config";
import { CAPTURE_TYPES, DOMAIN_NAME, DOMAIN_VERSION } from "../src/eip712";
import { ANVIL_CHAIN_ID, CONTRACT_ADDRESS } from "./anvil";
import { adminHeaders, randomIp } from "./game";
import { accessToken, setStub, STUB_PORTS, STUB_ROBOT, TEST_ADMIN_EMAIL } from "./stub-ports";

const BASE = "https://capture-flag.test";
const now = () => Math.floor(Date.now() / 1000);

async function post(body: unknown, headers?: Record<string, string>) {
  const res = await SELF.fetch(`${BASE}/admin/state`, {
    method: "POST",
    headers: headers ?? adminHeaders(await accessToken()),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { code: res.status, body: (await res.json()) as Record<string, any> };
}

const act = (action: string, target: string) => post({ action, target });

async function state() {
  const res = await SELF.fetch(`${BASE}/admin/state`, { headers: adminHeaders(await accessToken()) });
  return (await res.json()) as {
    paused: boolean;
    admin: { email: string };
    robots: Array<{ slug: string; disabled: boolean }>;
  };
}

async function status(slug: string) {
  return ((await (await SELF.fetch(`${BASE}/r/${slug}/status`)).json()) as { state: string }).state;
}

/** A well-formed capture with a junk signature: a switch refuses it first, or the signature check does. */
async function captureCode(slug: keyof typeof STUB_PORTS): Promise<{ code: number; error: string }> {
  const typedData = {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: ANVIL_CHAIN_ID, verifyingContract: CONTRACT_ADDRESS },
    message: {
      robotId: robotIdFor(`127.0.0.1:${STUB_PORTS[slug]}`, STUB_ROBOT),
      player: privateKeyToAccount(generatePrivateKey()).address,
      nonce: "1",
      deadline: String(now() + 300),
    },
    primaryType: "Capture",
    types: CAPTURE_TYPES,
  };
  const res = await SELF.fetch(`${BASE}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": randomIp() },
    body: JSON.stringify({ typedData, sig: `0x${"11".repeat(65)}` }),
  });
  return { code: res.status, error: ((await res.json()) as { error: string }).error };
}

// Order matters in this file: the first test sees a fresh deploy.
describe("admin switches", () => {
  it("starts paused with every robot enabled, and names the signed-in admin", async () => {
    const s = await state();
    expect(s.paused).toBe(true);
    expect(s.robots.every((r) => !r.disabled)).toBe(true);
    expect(s.admin.email).toBe(TEST_ADMIN_EMAIL);
  });

  it("serves the admin page, with no wallet login", async () => {
    const res = await SELF.fetch(`${BASE}/admin`, { headers: adminHeaders(await accessToken()) });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("they never send a transaction");
    expect(html).not.toContain("Connect wallet");
    expect(html).not.toContain("personal_sign");
  });

  it("while paused: every robot is paused, captures 403, reads still work", async () => {
    expect(await status("status")).toBe("paused");
    expect(await status("dead")).toBe("paused");
    expect(await captureCode("capture")).toEqual({ code: 403, error: "game is paused" });
    expect((await SELF.fetch(`${BASE}/r/capture/drivers`)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/leaderboard`)).status).toBe(200);
  });

  it("resumes and pauses for a signed-in admin", async () => {
    const resumed = await act("resume", "game");
    expect(resumed.code).toBe(200);
    expect(resumed.body.paused).toBe(false);
    await setStub("status", "free");
    expect(await status("status")).toBe("free");

    expect((await act("pause", "game")).body.paused).toBe(true);
    expect(await status("status")).toBe("paused");
    expect((await act("resume", "game")).body.paused).toBe(false);
  });

  it("disables one robot and leaves the others alone", async () => {
    await setStub("status", "free");
    const res = await act("disable", "capture");
    expect(res.code).toBe(200);
    expect(res.body.robots.find((r: { slug: string }) => r.slug === "capture").disabled).toBe(true);
    expect(await status("capture")).toBe("disabled");
    expect(await status("status")).toBe("free");
    expect(await captureCode("capture")).toEqual({ code: 403, error: "robot is disabled" });
    // Another robot gets past the switches, to the signature check.
    expect(await captureCode("status")).toMatchObject({ code: 400 });

    expect((await act("enable", "capture")).code).toBe(200);
    expect(await status("capture")).not.toBe("disabled");
  });

  it("401s a switch without Access, and changes nothing", async () => {
    const res = await post({ action: "pause", target: "game" }, { "content-type": "application/json", "cf-connecting-ip": randomIp() });
    expect(res.code).toBe(401);
    expect((await state()).paused).toBe(false);
  });

  it.each([
    ["pause with a robot target", { action: "pause", target: "capture" }],
    ["resume with a robot target", { action: "resume", target: "capture" }],
    ["disable with the game", { action: "disable", target: "game" }],
    ["disable an unknown robot", { action: "disable", target: "nope" }],
    ["disable by gateway robot name", { action: "disable", target: STUB_ROBOT }],
    ["an unknown action", { action: "delete", target: "game" }],
    ["topup sent to /admin/state", { action: "topup", target: "relayer" }],
    ["a missing target", { action: "pause" }],
    ["an array", ["pause", "game"]],
  ])("400s %s", async (_, body) => {
    expect((await post(body)).code).toBe(400);
  });

  it("400s a body that isn't JSON", async () => {
    expect((await post("not json")).code).toBe(400);
    expect((await state()).paused).toBe(false);
  });
});
