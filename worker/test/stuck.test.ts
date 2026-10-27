import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createPublicClient, defineChain, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { robotIdFor } from "../src/config";
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
    player: privateKeyToAccount(key).address,
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

    // The next alarm sees the nonce used and points the log at the hash that landed.
    await runDurableObjectAlarm(relayer());
    expect(await sql("SELECT nonce FROM pending")).toHaveLength(0);
    const logged = await sql<{ tx: string }>("SELECT tx FROM captures WHERE player = ?", message.player);
    expect(logged).toEqual([{ tx: second }]);
  });

  it("replaces one that would now revert with a no-op, and takes it out of the log", async () => {
    const { message } = await sendAndDrop(4);
    const before = await sql<{ n: number }>("SELECT COUNT(*) AS n FROM captures");

    // Ten 2 s blocks, as on Base, move the chain's clock past the 4 s deadline.
    await anvilRpc("anvil_mine", ["0xa", "0x2"]);
    await runDurableObjectAlarm(relayer());
    const [row] = await sql<{ hashes: string; seq: number }>("SELECT hashes, seq FROM pending");
    expect(row.seq).toBe(0);
    const noop = await client.getTransaction({ hash: (JSON.parse(row.hashes) as Hex[])[1] });
    expect(noop.to?.toLowerCase()).toBe(RELAYER_ADDRESS.toLowerCase());
    expect(noop.value).toBe(0n);

    expect(await sql("SELECT 1 FROM captures WHERE player = ?", message.player)).toHaveLength(0);
    expect(await sql("SELECT 1 FROM counts WHERE player = ?", message.player)).toHaveLength(0);
    expect(await sql("SELECT 1 FROM totals WHERE player = ?", message.player)).toHaveLength(0);
    expect((await sql<{ n: number }>("SELECT COUNT(*) AS n FROM captures"))[0].n).toBe(before[0].n - 1);

    await runDurableObjectAlarm(relayer());
    expect(await sql("SELECT nonce FROM pending")).toHaveLength(0);

    // The nonce is free again: the next capture goes straight through.
    const next = await signed(300);
    const result = await relayer().capture("status", next.message, next.sig, 600);
    expect(result.ok).toBe(true);
    if (result.ok) expect((await client.waitForTransactionReceipt({ hash: result.txHash })).status).toBe("success");
  });
});
