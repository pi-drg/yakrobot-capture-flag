import { env, SELF } from "cloudflare:test";
import { createPublicClient, defineChain, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { captureFlagAbi } from "../src/abi";
import { robotIdFor } from "../src/config";
import { CAPTURE_TYPES, DOMAIN_NAME, DOMAIN_VERSION } from "../src/eip712";
import { RELAYER_NAME } from "../src/relayer";
import { ANVIL_CHAIN_ID, ANVIL_RPC, anvilRpc, CONTRACT_ADDRESS, COOLDOWN, RELAYER_ADDRESS } from "./anvil";
import { randomIp, setGamePaused } from "./game";
import { setStub, STUB_PORTS, STUB_ROBOT } from "./stub-ports";

const ROBOT_ID = robotIdFor(`127.0.0.1:${STUB_PORTS.capture}`, STUB_ROBOT);
const DOMAIN = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: ANVIL_CHAIN_ID,
  verifyingContract: CONTRACT_ADDRESS as Hex,
};

const chain = defineChain({
  id: ANVIL_CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});
const client = createPublicClient({ chain, transport: http() });

const relayer = () => env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME));
const now = () => Math.floor(Date.now() / 1000);
const relayerNonce = () => client.getTransactionCount({ address: RELAYER_ADDRESS, blockTag: "pending" });

const STATUS_ID = robotIdFor(`127.0.0.1:${STUB_PORTS.status}`, STUB_ROBOT);

interface Options {
  robotId?: Hex;
  key?: Hex;
  signer?: Hex;
  nonce?: number;
  deadline?: number;
  domain?: Partial<typeof DOMAIN>;
}

/** A player's signed capture of the "capture" stub robot, as the page would post it. */
async function signed(opts: Options = {}) {
  const key = opts.key ?? generatePrivateKey();
  const player = privateKeyToAccount(key);
  const domain = { ...DOMAIN, ...opts.domain };
  const message = {
    robotId: opts.robotId ?? ROBOT_ID,
    player: player.address,
    nonce: BigInt(opts.nonce ?? Date.now()),
    deadline: BigInt(opts.deadline ?? now() + 300),
  };
  const { EIP712Domain: _, ...types } = CAPTURE_TYPES;
  const sig = await privateKeyToAccount(opts.signer ?? key).signTypedData({
    domain,
    types,
    primaryType: "Capture",
    message,
  });
  const typedData = {
    domain,
    types: CAPTURE_TYPES,
    primaryType: "Capture",
    message: { ...message, nonce: String(message.nonce), deadline: String(message.deadline) },
  };
  return { player: player.address.toLowerCase(), body: { typedData, sig } };
}

/** Each post from its own IP, so the per-IP limit (limits.test.ts) stays out of the way. */
async function post(body: unknown) {
  const res = await SELF.fetch("https://capture-flag.test/capture", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": randomIp() },
    body: JSON.stringify(body),
  });
  return { code: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function mined(txHash: unknown) {
  return client.waitForTransactionReceipt({ hash: txHash as Hex });
}

beforeAll(() => setGamePaused(false));
afterEach(() => setStub("capture", "free"));

describe("POST /capture", () => {
  // Runs first: its player is the robot's first capturer, so stays the leader on ties.
  it("relays a capture, logs the driver, and lists them", async () => {
    const { player, body } = await signed();
    const res = await post(body);
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ robot: "capture", drive: `http://127.0.0.1:${STUB_PORTS.capture}/${STUB_ROBOT}/ui` });
    expect((await mined(res.body.txHash)).status).toBe("success");

    const read = { address: CONTRACT_ADDRESS, abi: captureFlagAbi } as const;
    expect(await client.readContract({ ...read, functionName: "captureCount", args: [ROBOT_ID, player as Hex] })).toBe(1n);

    const drivers = (await (await SELF.fetch("https://capture-flag.test/r/capture/drivers")).json()) as {
      recent: Array<{ player: string; tx: string }>;
      top: Array<{ player: string; rides: number }>;
      leader: { player: string; rides: number };
    };
    expect(drivers.recent[0]).toMatchObject({ player, tx: res.body.txHash });
    expect(drivers.top[0]).toEqual({ player, rides: 1 });
    expect(drivers.leader).toEqual({ player, rides: 1 });

    const board = (await (await SELF.fetch("https://capture-flag.test/leaderboard")).json()) as {
      top: Array<{ player: string; rides: number; robots: number }>;
    };
    expect(board.top).toContainEqual({ player, rides: 1, robots: 1 });
  });

  it("429s the same player on the same robot within the cooldown", async () => {
    const key = generatePrivateKey();
    const first = await post((await signed({ key, nonce: 1 })).body);
    await mined(first.body.txHash);
    const again = await post((await signed({ key, nonce: 2 })).body);
    expect(again.code).toBe(429);
    const retry = Number(again.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(COOLDOWN - 10);
    // Anvil keeps block timestamps strictly increasing, so many blocks in one second
    // run chain time ahead of the wall clock the Worker counts from.
    expect(retry).toBeLessThanOrEqual(COOLDOWN + 30);
  });

  it("409s a busy robot without sending a transaction", async () => {
    await setStub("capture", "busy");
    const before = await relayerNonce();
    const res = await post((await signed()).body);
    expect(res).toMatchObject({ code: 409, body: { state: "busy" } });
    expect(await relayerNonce()).toBe(before);
  });

  it.each([
    ["a signature by someone else", { signer: generatePrivateKey() }, "bad signature"],
    ["the wrong chain", { domain: { chainId: 8453 } }, "wrong EIP-712 domain for this game"],
    ["the wrong contract", { domain: { verifyingContract: RELAYER_ADDRESS } }, "wrong EIP-712 domain for this game"],
    ["an expired deadline", { deadline: now() - 1 }, "capture expired, sign again"],
    ["a deadline under a minute away", { deadline: now() + 30 }, "capture expired, sign again"],
    ["a deadline too far ahead", { deadline: now() + 3600 }, "deadline is too far ahead"],
  ] as const)("400s %s", async (_, opts: Options, error) => {
    const before = await relayerNonce();
    const res = await post((await signed(opts)).body);
    expect(res).toMatchObject({ code: 400, body: { error } });
    expect(await relayerNonce()).toBe(before);
  });

  it("400s a nonce already sent for another robot, before it's mined", async () => {
    await setStub("status", "free");
    await anvilRpc("evm_setAutomine", [false]);
    try {
      const key = generatePrivateKey();
      const first = await post((await signed({ key, nonce: 7 })).body);
      expect(first.code).toBe(200);
      const before = await relayerNonce();
      const other = await post((await signed({ key, nonce: 7, robotId: STATUS_ID })).body);
      expect(other).toMatchObject({ code: 400, body: { error: "this capture was already used" } });
      expect(await relayerNonce()).toBe(before);
      await anvilRpc("evm_mine");
      expect((await mined(first.body.txHash)).status).toBe("success");
    } finally {
      await anvilRpc("evm_setAutomine", [true]);
    }
  });

  it("403s while the robot is disabled", async () => {
    await relayer().setSwitch("capture", true);
    try {
      expect(await post((await signed()).body)).toMatchObject({ code: 403, body: { error: "robot is disabled" } });
    } finally {
      await relayer().setSwitch("capture", false);
    }
  });

  it("403s while the game is paused", async () => {
    await setGamePaused(true);
    try {
      expect(await post((await signed()).body)).toMatchObject({ code: 403, body: { error: "game is paused" } });
    } finally {
      await setGamePaused(false);
    }
  });

  it("relays 20 players capturing at once, each mined", async () => {
    const before = await relayerNonce();
    const all = await Promise.all(Array.from({ length: 20 }, async () => post((await signed()).body)));
    expect(all.map((r) => r.code)).toEqual(Array(20).fill(200));
    const receipts = await Promise.all(all.map((r) => mined(r.body.txHash)));
    expect(receipts.every((r) => r.status === "success")).toBe(true);
    expect(await relayerNonce()).toBe(before + 20);

    // Everyone has one ride, so the tie rule decides: the log's top[0] is the contract's.
    const drivers = (await (await SELF.fetch("https://capture-flag.test/r/capture/drivers")).json()) as {
      top: Array<{ player: string }>;
      leader: { player: string };
    };
    expect(drivers.top[0].player).toBe(drivers.leader.player);
  }, 30_000);

  it("429s the second of a same-pair race before the first is mined", async () => {
    await anvilRpc("evm_setAutomine", [false]);
    try {
      const key = generatePrivateKey();
      const [a, b] = await Promise.all([post((await signed({ key, nonce: 1 })).body), post((await signed({ key, nonce: 2 })).body)]);
      expect([a.code, b.code].sort()).toEqual([200, 429]);
      await anvilRpc("evm_mine");
      const sent = a.code === 200 ? a : b;
      expect((await mined(sent.body.txHash)).status).toBe("success");
    } finally {
      await anvilRpc("evm_setAutomine", [true]);
    }
  });
});
