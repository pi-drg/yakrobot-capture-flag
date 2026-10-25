import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("serves /health", async () => {
  const res = await SELF.fetch("https://capture-flag.test/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, chain: "84532" });
});
