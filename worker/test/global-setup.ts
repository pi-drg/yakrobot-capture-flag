import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ANVIL_CHAIN_ID,
  ANVIL_PORT,
  ANVIL_RPC,
  anvilRpc,
  CONTRACT_ADDRESS,
  COOLDOWN,
  OWNER_KEY,
  RELAYER_ADDRESS,
} from "./anvil";
import { STUB_PORTS, STUB_ROBOT } from "./stub-ports";

/**
 * Runs in Node, outside workerd, before any test file. Starts one stub gateway per port
 * in STUB_PORTS, each serving the robot STUB_ROBOT, which the Worker fetches over real
 * HTTP (the vitest plugin has no fetchMock). One server per robot keeps tests that run
 * in parallel from stepping on each other. A test sets its gateway's behaviour with
 * `POST /__state {state}`.
 *
 * It also starts anvil and deploys CaptureFlag from the forge artifact, so /capture runs
 * against a real contract. Not through Deploy.s.sol: that refuses dev keys off chain 31337.
 */

export type StubState = "free" | "busy" | "down" | "no_ui" | "not_capture_flag" | "error" | "hang";

function indexFor(state: StubState) {
  return {
    service: "Robot Fleet Gateway",
    teleop: { reservation: state === "not_capture_flag" ? "free" : "capture_flag", lease_minutes: 5 },
    robots: {
      [STUB_ROBOT]: {
        mcp_endpoint: `/${STUB_ROBOT}/mcp`,
        ...(state === "no_ui" ? {} : { ui_endpoint: `/${STUB_ROBOT}/ui` }),
        tools: ["robot_move"],
        reservation:
          state === "busy"
            ? { reserved: true, holder: "free:abc", held_seconds: 10, expires_in: 120 }
            : { reserved: false },
        online: state === "no_ui" ? null : state !== "down",
      },
    },
  };
}

function stubGateway(): Server {
  let state: StubState = "free";
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__state") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        state = (JSON.parse(body) as { state: StubState }).state;
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      if (state === "hang") return; // never answers; the Worker's timeout must fire
      if (state === "error") return void res.writeHead(502).end("bad gateway");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(indexFor(state)));
      return;
    }
    res.writeHead(404).end();
  });
}

const servers: Server[] = [];
let anvil: ChildProcess | undefined;

const ANVIL_BIN = join(homedir(), ".foundry/bin/anvil");
const ARTIFACT = join(import.meta.dirname, "../../contracts/out/CaptureFlag.sol/CaptureFlag.json");

async function startAnvil(): Promise<void> {
  if (!existsSync(ANVIL_BIN)) throw new Error(`anvil not found at ${ANVIL_BIN}; run foundryup`);
  anvil = spawn(ANVIL_BIN, ["--port", String(ANVIL_PORT), "--chain-id", String(ANVIL_CHAIN_ID), "--silent"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited with ${anvil.exitCode}; is port ${ANVIL_PORT} taken?`);
    try {
      await anvilRpc("eth_chainId");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("anvil did not start within 10 s");
}

async function deployCaptureFlag(): Promise<void> {
  if (!existsSync(ARTIFACT)) throw new Error("contracts/out has no CaptureFlag artifact; run forge build in contracts/");
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
  const chain = defineChain({
    id: ANVIL_CHAIN_ID,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_RPC] } },
  });
  const account = privateKeyToAccount(OWNER_KEY);
  const wallet = createWalletClient({ account, chain, transport: http() });
  const client = createPublicClient({ chain, transport: http() });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [account.address, RELAYER_ADDRESS, BigInt(COOLDOWN)],
  });
  const { contractAddress } = await client.waitForTransactionReceipt({ hash });
  if (!contractAddress || getAddress(contractAddress) !== CONTRACT_ADDRESS) {
    throw new Error(`CaptureFlag deployed at ${contractAddress}, expected ${CONTRACT_ADDRESS}`);
  }
}

export async function setup() {
  for (const port of Object.values(STUB_PORTS)) {
    const server = stubGateway();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  }
  await startAnvil();
  await deployCaptureFlag();
}

export async function teardown() {
  anvil?.kill();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
