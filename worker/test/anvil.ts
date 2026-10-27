/**
 * The local chain under test, shared like test/stub-ports.ts: vitest.config.ts (Node:
 * bindings), test/global-setup.ts (Node: spawn and deploy) and the tests (workerd).
 * Plain data, no imports. The keys are anvil's public dev keys; never fund them.
 */

export const ANVIL_PORT = 18545;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
/** Base Sepolia's id, so the Worker's CHAIN and the EIP-712 domain match production. */
export const ANVIL_CHAIN_ID = 84532;

/** Anvil account 0: the deployer and the contract's owner. */
export const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** Anvil account 1: the relayer, the Worker's RELAYER_PRIVATE_KEY under test. */
export const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const RELAYER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** Account 0's first deployment, at nonce 0. */
export const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const COOLDOWN = 600;

/** Send one JSON-RPC call to anvil (evm_setAutomine, evm_mine, …). */
export async function anvilRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
