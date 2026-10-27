import { createExecutionContext, createScheduledController, env, SELF } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { CONTRACT_ADDRESS, RELAYER_ADDRESS } from "./anvil";

afterEach(() => vi.restoreAllMocks());

it("serves /health with the relayer's balance and the contract's relayer", async () => {
  const res = await SELF.fetch("https://capture-flag.test/health");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    ok: true,
    chain: "84532",
    contract: CONTRACT_ADDRESS.toLowerCase(),
    relayer: RELAYER_ADDRESS,
    balance_ok: true,
    relayer_set: true,
    paused: true,
  });
  // Anvil's dev accounts start with 10,000 ETH; the string keeps the bigint exact.
  expect(BigInt(body.balance_wei as string)).toBeGreaterThan(10n ** 18n);
});

it("logs nothing on a healthy cron run", async () => {
  const error = vi.spyOn(console, "error");
  await worker.scheduled(createScheduledController(), env);
  expect(error).not.toHaveBeenCalled();
});

it("flags a relayer below RELAYER_MIN_WEI, on /health and from the cron", async () => {
  const poor = { ...env, RELAYER_MIN_WEI: String(10n ** 30n) } as unknown as Env;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await worker.scheduled(createScheduledController(), poor);
  expect(error).toHaveBeenCalledOnce();
  expect(String(error.mock.calls[0][1])).toContain('"balance_ok":false');

  const res = await worker.fetch(new Request("https://capture-flag.test/health"), poor, createExecutionContext());
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ ok: false, balance_ok: false, relayer_set: true });
});

it("reports the chain unavailable when the RPC is down", async () => {
  const down = { ...env, RPC_URL: "http://127.0.0.1:18559" } as Env;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await worker.scheduled(createScheduledController(), down);
  const res = await worker.fetch(new Request("https://capture-flag.test/health"), down, createExecutionContext());
  // The cron's fresh check filled the cache with the failure.
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ ok: false, error: "chain unavailable" });
});
