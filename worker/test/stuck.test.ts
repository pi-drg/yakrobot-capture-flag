import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { createPublicClient, defineChain, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, robotIdFor } from "../src/config";
import { checkHealth } from "../src/health";
import { CAPTURE_TYPES, DOMAIN_NAME, DOMAIN_VERSION } from "../src/eip712";
import { type Relayer, RELAYER_NAME } from "../src/relayer";
import { ANVIL_CHAIN_ID, ANVIL_RPC, anvilRpc, CONTRACT_ADDRESS, RELAYER_ADDRESS } from "./anvil";
import { setGamePaused } from "./game";
import { STUB_PORTS, STUB_ROBOT } from "./stub-ports";

const chain = defineChain({
  id: ANVIL_CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});
const client = createPublicClient({ chain, transport: http() });
const relayer = () => env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME));
const ROBOT_ID = robotIdFor(`127.0.0.1:${STUB_PORTS.status}`, STUB_ROBOT);

/** A player's signed capture, deadline `secondsAhead` past the chain's clock. */
async function signed(secondsAhead: number) {
  const key = generatePrivateKey();
  const { timestamp } = await client.getBlock();
  const message = {
    robotId: ROBOT_ID,
    // Lowercase, as the Worker hands it to the DO.
    player: privateKeyToAccount(key).address.toLowerCase() as Hex,
    nonce: BigInt(Date.now()),
    deadline: timestamp + BigInt(secondsAhead),
  };
  const { EIP712Domain: _, ...types } = CAPTURE_TYPES;
  const sig = await privateKeyToAccount(key).signTypedData({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: ANVIL_CHAIN_ID, verifyingContract: CONTRACT_ADDRESS as Hex },
    types,
    primaryType: "Capture",
    message,
  });
  return { message, sig };
}

/** Relay a capture and then lose it from the mempool, as a stuck transaction would be. */
async function sendAndDrop(secondsAhead: number) {
  const { message, sig } = await signed(secondsAhead);
  await anvilRpc("evm_setAutomine", [false]);
  const result = await relayer().capture("status", message, sig, 600);
  if (!result.ok) throw new Error(result.error);
  await anvilRpc("anvil_dropTransaction", [result.txHash]);
  await anvilRpc("evm_setAutomine", [true]);
  return { message, txHash: result.txHash };
}

const sql = <T extends Record<string, SqlStorageValue>>(query: string, ...args: SqlStorageValue[]) =>
  runInDurableObject(relayer(), (_: Relayer, state: DurableObjectState) => state.storage.sql.exec<T>(query, ...args).toArray());

/** What the robot page polls: the capture's current transaction, or 404. */
async function current(message: { player: string; nonce: bigint }) {
  const res = await SELF.fetch(
    `https://capture-flag.test/r/status/capture?player=${message.player}&nonce=${message.nonce}`
  );
  return { code: res.status, body: (await res.json()) as { tx?: string } };
}

beforeAll(() => setGamePaused(false));
afterEach(() => anvilRpc("evm_setAutomine", [true]));

describe("stuck transactions (design W4)", () => {
  it("leaves a fresh send alone, then settles it once mined", async () => {
    const { message, sig } = await signed(300);
    const result = await relayer().capture("status", message, sig, 600);
    expect(result.ok).toBe(true);
    expect(await sql("SELECT nonce FROM pending")).toHaveLength(1);
    expect(await runDurableObjectAlarm(relayer())).toBe(true);
    expect(await sql("SELECT nonce FROM pending")).toHaveLength(0);
    // Nothing pending, so no alarm is left.
    expect(await runDurableObjectAlarm(relayer())).toBe(false);
  });

  it("waits 10 blocks, then re-sends with the same nonce and 25% more fee", async () => {
    const { message, txHash } = await sendAndDrop(300);
    const [{ nonce }] = await sql<{ nonce: number }>("SELECT nonce FROM pending");

    await anvilRpc("anvil_mine", ["0x5"]);
    await runDurableObjectAlarm(relayer());
    expect(await sql<{ tries: number }>("SELECT tries FROM pending")).toEqual([{ tries: 0 }]);

    await anvilRpc("anvil_mine", ["0x5"]);
    await runDurableObjectAlarm(relayer());
    const [row] = await sql<{ hashes: string; tries: number }>("SELECT hashes, tries FROM pending");
    expect(row.tries).toBe(1);
    const [first, second] = JSON.parse(row.hashes) as Hex[];
    expect(first).toBe(txHash);
    const resent = await client.getTransaction({ hash: second });
    expect(resent.nonce).toBe(nonce);
    expect(resent.from.toLowerCase()).toBe(RELAYER_ADDRESS.toLowerCase());
    expect((await client.waitForTransactionReceipt({ hash: second })).status).toBe("success");
    // The page is pointed at the new hash before the log is settled.
    expect(await current(message)).toEqual({ code: 200, body: { tx: second, at: expect.any(Number) } });

    // The next alarm sees the nonce used and points the log at the hash that landed.
    await runDurableObjectAlarm(relayer());
    expect(await sql("SELECT nonce FROM pending")).toHaveLength(0);
    const logged = await sql<{ tx: string }>("SELECT tx FROM captures WHERE player = ?", message.player);
    expect(logged).toEqual([{ tx: second }]);
  });

  it("replaces one that would now revert with a no-op, and takes it out of the rankings", async () => {
    const { message } = await sendAndDrop(4);
    expect((await current(message)).code).toBe(200);

    // Ten 2 s blocks, as on Base, move the chain's clock past the 4 s deadline.
    await anvilRpc("anvil_mine", ["0xa", "0x2"]);
    await runDurableObjectAlarm(relayer());
    const [row] = await sql<{ hashes: string; seq: number }>("SELECT hashes, seq FROM pending");
    expect(row.seq).toBe(0);
    const noop = await client.getTransaction({ hash: (JSON.parse(row.hashes) as Hex[])[1] });
    expect(noop.to?.toLowerCase()).toBe(RELAYER_ADDRESS.toLowerCase());
    expect(noop.value).toBe(0n);

    // Still logged, so the hourly budget counts the gas spent, but marked reverted.
    expect(await sql("SELECT reverted FROM captures WHERE player = ?", message.player)).toEqual([{ reverted: 1 }]);
    expect(await sql("SELECT 1 FROM counts WHERE player = ?", message.player)).toHaveLength(0);
    expect(await sql("SELECT 1 FROM totals WHERE player = ?", message.player)).toHaveLength(0);
    const drivers = (await (await SELF.fetch("https://capture-flag.test/r/status/drivers")).json()) as {
      recent: Array<{ player: string }>;
    };
    expect(drivers.recent.map((r) => r.player)).not.toContain(message.player);
    // The page stops waiting and says it didn't go through.
    expect((await current(message)).code).toBe(404);

    await runDurableObjectAlarm(relayer());
    expect(await sql("SELECT nonce FROM pending")).toHaveLength(0);

    // The nonce is free again: the next capture goes straight through.
    const next = await signed(300);
    const result = await relayer().capture("status", next.message, next.sig, 600);
    expect(result.ok).toBe(true);
    if (result.ok) expect((await client.waitForTransactionReceipt({ hash: result.txHash })).status).toBe("success");
  });

  // Last in the file: it leaves the relayer's nonce stuck on purpose.
  it("gives up after 3 re-sends, logs once, and /health reports it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runDurableObjectAlarm(relayer()); // settle the last test's capture
    await sendAndDrop(300);
    await anvilRpc("evm_setAutomine", [false]);
    for (let i = 0; i < 3; i++) {
      await anvilRpc("anvil_mine", ["0xa", "0x2"]);
      await runDurableObjectAlarm(relayer());
      const [row] = await sql<{ hashes: string }>("SELECT hashes FROM pending");
      await anvilRpc("anvil_dropTransaction", [(JSON.parse(row.hashes) as Hex[]).at(-1)]);
    }
    expect(await sql<{ tries: number }>("SELECT tries FROM pending")).toEqual([{ tries: 3 }]);
    await anvilRpc("anvil_mine", ["0xa", "0x2"]);
    await runDurableObjectAlarm(relayer());
    await anvilRpc("anvil_mine", ["0xa", "0x2"]);
    await runDurableObjectAlarm(relayer());
    const giveUps = error.mock.calls.filter((call) => String(call[0]).includes("giving up"));
    expect(giveUps).toHaveLength(1);
    expect(await sql("SELECT nonce FROM pending")).toHaveLength(1);

    // Pretend it has waited 10 minutes.
    await sql("UPDATE pending SET sent_at = sent_at - 600");
    const config = loadConfig(env as unknown as Record<string, string | undefined>);
    const health = await checkHealth(env, config, relayer(), { fresh: true });
    expect(health).toMatchObject({ ok: false, balance_ok: true, relayer_set: true, pending: 1 });
    expect(health.oldest_pending_s).toBeGreaterThanOrEqual(600);
    expect(health.error).toMatch(/unmined/);
  });
});
