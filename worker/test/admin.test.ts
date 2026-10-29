import { SELF } from "cloudflare:test";
import { type Hex, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { robotIdFor } from "../src/config";
import { CAPTURE_TYPES, DOMAIN_NAME, DOMAIN_VERSION } from "../src/eip712";
import { ANVIL_CHAIN_ID, CONTRACT_ADDRESS, OWNER_KEY } from "./anvil";
import { randomIp } from "./game";
import { setStub, STUB_PORTS, STUB_ROBOT } from "./stub-ports";

const BASE = "https://capture-flag.test";
const now = () => Math.floor(Date.now() / 1000);

// Each target needs a strictly newer `issued`, and tests run faster than a second apiece.
let clock = now() - 100;
const nextIssued = () => ++clock;

interface Fields {
  action: string;
  target: string;
  chain?: string;
  contract?: string;
  issued?: number;
}

/** Written out here, not with src/admin.ts's adminMessage, to pin the format. */
function text(f: Fields): string {
  return [
    "yakrobot-capture-flag admin",
    `action: ${f.action}`,
    `target: ${f.target}`,
    `chain: ${f.chain ?? ANVIL_CHAIN_ID}`,
    `contract: ${f.contract ?? CONTRACT_ADDRESS}`,
    `issued: ${f.issued ?? nextIssued()}`,
  ].join("\n");
}

async function post(message: string, key: Hex = OWNER_KEY as Hex, signature?: string) {
  const sig = signature ?? (await privateKeyToAccount(key).signMessage({ message }));
  const res = await SELF.fetch(`${BASE}/admin/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": randomIp() },
    body: JSON.stringify({ message, signature: sig }),
  });
  return { code: res.status, body: (await res.json()) as Record<string, any> };
}

const act = (action: string, target: string) => post(text({ action, target }));

async function state() {
  return (await (await SELF.fetch(`${BASE}/admin/state`)).json()) as {
    paused: boolean;
    owner: string;
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
  it("starts paused with every robot enabled, and names the owner", async () => {
    const s = await state();
    expect(s.paused).toBe(true);
    expect(s.robots.every((r) => !r.disabled)).toBe(true);
    expect(s.owner).toBe(privateKeyToAccount(OWNER_KEY as Hex).address.toLowerCase());
  });

  it("serves the admin page", async () => {
    const res = await SELF.fetch(`${BASE}/admin`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("it never sends a transaction");
  });

  it("while paused: every robot is paused, captures 403, reads still work", async () => {
    expect(await status("status")).toBe("paused");
    expect(await status("dead")).toBe("paused");
    expect(await captureCode("capture")).toEqual({ code: 403, error: "game is paused" });
    expect((await SELF.fetch(`${BASE}/r/capture/drivers`)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/leaderboard`)).status).toBe(200);
  });

  it("resumes and pauses on the owner's signature", async () => {
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

  it("403s a signature from anyone but the owner, and changes nothing", async () => {
    const res = await post(text({ action: "pause", target: "game" }), generatePrivateKey());
    expect(res).toMatchObject({ code: 403, body: { error: "not the owner" } });
    expect((await state()).paused).toBe(false);
  });

  it("400s a stale or future issued", async () => {
    for (const issued of [now() - 200, now() + 200]) {
      const res = await post(text({ action: "pause", target: "game", issued }));
      expect(res.code).toBe(400);
    }
    expect((await state()).paused).toBe(false);
  });

  it("400s a replay of an older (or the same) message after a newer one", async () => {
    const older = text({ action: "resume", target: "game" });
    expect((await act("pause", "game")).code).toBe(200);
    expect(await post(older)).toMatchObject({ code: 400 });
    expect((await state()).paused).toBe(true);

    const again = text({ action: "resume", target: "game" });
    expect((await post(again)).code).toBe(200);
    expect((await post(again)).code).toBe(400);
  });

  it("keeps issued per target: a robot's switch doesn't block the game's", async () => {
    const issued = nextIssued();
    expect((await post(text({ action: "disable", target: "busy", issued }))).code).toBe(200);
    expect((await post(text({ action: "pause", target: "game", issued }))).code).toBe(200);
    expect((await act("enable", "busy")).code).toBe(200);
    expect((await act("resume", "game")).code).toBe(200);
  });

  it.each([
    ["pause with a robot target", { action: "pause", target: "capture" }],
    ["resume with a robot target", { action: "resume", target: "capture" }],
    ["disable with the game", { action: "disable", target: "game" }],
    ["disable an unknown robot", { action: "disable", target: "nope" }],
    ["disable by gateway robot name", { action: "disable", target: STUB_ROBOT }],
    ["an unknown action", { action: "delete", target: "game" }],
    ["the wrong chain", { action: "pause", target: "game", chain: "8453" }],
    ["the wrong contract", { action: "pause", target: "game", contract: `0x${"11".repeat(20)}` }],
  ])("400s %s", async (_, fields) => {
    expect((await post(text(fields))).code).toBe(400);
  });

  it("accepts a signature over the UTF-8 hex, as admin.html's personal_sign sends it", async () => {
    const message = text({ action: "pause", target: "game" });
    const signature = await privateKeyToAccount(OWNER_KEY as Hex).signMessage({ message: { raw: toHex(message) } });
    expect((await post(message, undefined, signature)).code).toBe(200);
    expect((await act("resume", "game")).code).toBe(200);
  });

  it("accepts the contract address in any case", async () => {
    const res = await post(text({ action: "pause", target: "game", contract: CONTRACT_ADDRESS.toLowerCase() }));
    expect(res.code).toBe(200);
    expect((await act("resume", "game")).code).toBe(200);
  });

  it.each([
    ["an extra line", (m: string) => m + "\nextra: 1"],
    ["a missing line", (m: string) => m.split("\n").slice(0, -1).join("\n")],
    ["a wrong header", (m: string) => m.replace("admin", "Admin")],
    ["CRLF line ends", (m: string) => m.replace(/\n/g, "\r\n")],
    ["a padded value", (m: string) => m.replace("action: pause", "action:  pause")],
  ])("400s a message with %s", async (_, mangle) => {
    expect((await post(mangle(text({ action: "pause", target: "game" })))).code).toBe(400);
  });

  it("400s a malformed signature or body", async () => {
    expect((await post(text({ action: "pause", target: "game" }), undefined, "0x1234"))).toMatchObject({ code: 400 });
    const res = await SELF.fetch(`${BASE}/admin/state`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect((await state()).paused).toBe(false);
  });
});
