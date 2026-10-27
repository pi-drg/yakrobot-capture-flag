import { env, runInDurableObject, SELF } from "cloudflare:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { robotIdFor } from "../src/config";
import { type Relayer, RELAYER_NAME } from "../src/relayer";
import { randomIp, setGamePaused } from "./game";
import { STUB_PORTS, STUB_ROBOT } from "./stub-ports";

const relayer = () => env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME));

beforeAll(() => setGamePaused(false));

describe("per-IP rate limit (design W6)", () => {
  it.each(["/capture", "/admin/state"])("allows 10 POST %s a minute from one IP, then 429s", async (path) => {
    const ip = randomIp();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await SELF.fetch(`https://capture-flag.test${path}`, {
        method: "POST",
        headers: { "cf-connecting-ip": ip },
        body: "not json",
      });
      codes.push(res.status);
      if (res.status === 429) expect(res.headers.get("Retry-After")).toBe("60");
    }
    expect(codes).toEqual([...Array(10).fill(400), 429]);

    // Another IP is unaffected.
    const other = await SELF.fetch(`https://capture-flag.test${path}`, {
      method: "POST",
      headers: { "cf-connecting-ip": randomIp() },
      body: "not json",
    });
    expect(other.status).toBe(400);
  });
});

describe("hourly send budget (design W6)", () => {
  it("refuses with 503 and no send once SENDS_PER_HOUR captures are logged", async () => {
    const robotId = robotIdFor(`127.0.0.1:${STUB_PORTS.status}`, STUB_ROBOT);
    const now = Math.floor(Date.now() / 1000);
    const limit = Number(env.SENDS_PER_HOUR);
    // An hour's worth of logged sends, the oldest 50 minutes ago.
    await runInDurableObject(relayer(), (_: Relayer, state: DurableObjectState) => {
      for (let i = 0; i < limit; i++) {
        state.storage.sql.exec(
          "INSERT INTO captures (slug, robot_id, player, nonce, tx, at) VALUES ('status', ?, ?, ?, '0x', ?)",
          robotId,
          `0x${String(i).padStart(40, "0")}`,
          String(i),
          now - 3000 + i
        );
      }
    });
    const player = privateKeyToAccount(generatePrivateKey()).address;
    const result = await relayer().capture(
      "status",
      { robotId, player, nonce: 1n, deadline: BigInt(now + 300) },
      `0x${"11".repeat(65)}`,
      600
    );
    expect(result).toMatchObject({ ok: false, status: 503, error: "the game is at its hourly ride limit" });
    // The oldest leaves the window in about 10 minutes.
    const retryAfter = (result as { retryAfter: number }).retryAfter;
    expect(retryAfter).toBeGreaterThan(590);
    expect(retryAfter).toBeLessThanOrEqual(602);
  });
});
