import { type ChildProcess, spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
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
import {
  ACCESS_PORT,
  CDP_TEST_KEY_ID,
  CDP_TEST_KEY_SECRET,
  FAUCET_PORT,
  STUB_PORTS,
  STUB_ROBOT,
  TEST_ADMIN_EMAIL,
  TEST_AUD,
  TEST_TEAM_DOMAIN,
  type TokenOverrides,
} from "./stub-ports";

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

/**
 * The CDP faucet, as far as the Worker uses it: checks the request's JWT the way CDP
 * would (EdDSA over the test key, kid/sub, a uris claim for exactly this request, not
 * expired), then answers a transaction hash. 401 on a bad JWT, so a format slip fails.
 */
function stubFaucet(): Server {
  const raw = Buffer.from(CDP_TEST_KEY_SECRET, "base64");
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(32).toString("base64url") }, format: "jwk" });
  let refuseAfter = Infinity;
  let claims: unknown[] = [];

  function jwtOk(auth: string | undefined): boolean {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const [h, p, sig] = token.split(".");
    if (!sig) return false;
    if (!verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url"))) return false;
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const claim = JSON.parse(Buffer.from(p, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    return (
      header.alg === "EdDSA" && header.kid === CDP_TEST_KEY_ID && /^[0-9a-f]{32}$/.test(header.nonce) &&
      claim.sub === CDP_TEST_KEY_ID && claim.iss === "cdp" && claim.nbf <= now && claim.exp > now &&
      JSON.stringify(claim.uris) === JSON.stringify([`POST 127.0.0.1:${FAUCET_PORT}/platform/v2/evm/faucet`])
    );
  }

  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__state") {
        const state = (JSON.parse(body) as { state: string }).state;
        refuseAfter = state.startsWith("refuse_after:") ? Number(state.slice(13)) : Infinity;
        claims = [];
        return void res.writeHead(204).end();
      }
      if (req.method === "GET" && req.url === "/__claims") {
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(claims));
      }
      if (req.method !== "POST" || req.url !== "/platform/v2/evm/faucet") return void res.writeHead(404).end();
      res.setHeader("content-type", "application/json");
      if (!jwtOk(req.headers.authorization)) {
        return void res.writeHead(401).end(JSON.stringify({ errorType: "unauthorized", errorMessage: "bad JWT" }));
      }
      if (claims.length >= refuseAfter) {
        return void res.writeHead(429).end(JSON.stringify({ errorType: "faucet_limit_exceeded", errorMessage: "daily cap" }));
      }
      claims.push(JSON.parse(body));
      res.writeHead(200).end(JSON.stringify({ transactionHash: `0x${String(claims.length).padStart(64, "0")}` }));
    });
  });
}

/**
 * A Cloudflare Access team: `GET /cdn-cgi/access/certs` publishes one RSA key, and
 * `POST /__token` mints an RS256 JWT with Access's claims (overridable, and signable by a
 * second, unpublished key). Keys are made fresh at each run and never leave Node.
 */
function stubAccess(): Server {
  const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keys: Record<"main" | "other", KeyObject> = { main: pair().privateKey, other: pair().privateKey };
  const main = createPublicKey(keys.main).export({ format: "jwk" });
  const jwks = { keys: [{ ...main, kid: "test-kid", alg: "RS256", use: "sig" }] };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/cdn-cgi/access/certs") {
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jwks));
      }
      if (req.method === "POST" && req.url === "/__token") {
        const o = JSON.parse(body || "{}") as TokenOverrides;
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: o.alg ?? "RS256", kid: o.kid ?? "test-kid", typ: "JWT" };
        const claims = {
          aud: "aud" in o ? o.aud : [TEST_AUD],
          email: "email" in o ? o.email : TEST_ADMIN_EMAIL,
          iss: o.iss ?? `https://${TEST_TEAM_DOMAIN}`,
          iat: now,
          nbf: o.nbf ?? now - 5,
          exp: o.exp ?? now + 300,
          type: "app",
        };
        const input = `${b64(header)}.${b64(claims)}`;
        const signature = sign("sha256", Buffer.from(input), keys[o.key ?? "main"]).toString("base64url");
        return void res.writeHead(200, { "content-type": "text/plain" }).end(`${input}.${signature}`);
      }
      res.writeHead(404).end();
    });
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
  const faucet = stubFaucet();
  servers.push(faucet);
  await new Promise<void>((resolve) => faucet.listen(FAUCET_PORT, "127.0.0.1", resolve));
  const access = stubAccess();
  servers.push(access);
  await new Promise<void>((resolve) => access.listen(ACCESS_PORT, "127.0.0.1", resolve));
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
