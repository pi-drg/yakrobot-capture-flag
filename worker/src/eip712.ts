import { isAddress, isHex, recoverTypedDataAddress } from "viem";

/**
 * The EIP-712 `Capture` the player signs (design F2), shaped as `eth_signTypedData_v4`
 * takes it. The same object is posted to `/capture` and later handed to the gateway, so
 * it travels whole rather than as loose fields. `contracts/test/vectors.json` pins the
 * hashing shared with the contract and the gateway.
 */

export const DOMAIN_NAME = "yakrobot-capture-flag";
export const DOMAIN_VERSION = "1";

export const CAPTURE_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Capture: [
    { name: "robotId", type: "bytes32" },
    { name: "player", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface Capture {
  robotId: `0x${string}`;
  player: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

export interface CaptureDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export class CaptureShapeError extends Error {}

const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A uint256 sent as a decimal string, or as a safe integer (MetaMask echoes either). */
function uint(name: string, value: unknown): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !UINT_RE.test(text) || BigInt(text) > MAX_UINT256) {
    throw new CaptureShapeError(`${name} must be a uint256`);
  }
  return BigInt(text);
}

/** Parse `typedData` strictly: exactly the `Capture` types, primary type and fields. */
export function parseTypedData(typedData: unknown): { domain: CaptureDomain; message: Capture } {
  if (!isObject(typedData)) throw new CaptureShapeError("typedData must be an object");
  if (typedData.primaryType !== "Capture") throw new CaptureShapeError("primaryType must be Capture");
  if (JSON.stringify(typedData.types) !== JSON.stringify(CAPTURE_TYPES)) {
    throw new CaptureShapeError("types must be exactly the Capture types");
  }
  const { domain, message } = typedData;
  if (!isObject(domain) || !isObject(message)) {
    throw new CaptureShapeError("domain and message must be objects");
  }
  if (typeof domain.verifyingContract !== "string" || !isAddress(domain.verifyingContract)) {
    throw new CaptureShapeError("domain.verifyingContract must be an address");
  }
  const chainId = uint("domain.chainId", domain.chainId);
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new CaptureShapeError("domain.chainId is too large");
  if (typeof message.robotId !== "string" || !isHex(message.robotId) || message.robotId.length !== 66) {
    throw new CaptureShapeError("message.robotId must be bytes32");
  }
  if (typeof message.player !== "string" || !isAddress(message.player)) {
    throw new CaptureShapeError("message.player must be an address");
  }
  return {
    domain: {
      name: String(domain.name),
      version: String(domain.version),
      chainId: Number(chainId),
      verifyingContract: domain.verifyingContract.toLowerCase() as `0x${string}`,
    },
    message: {
      robotId: message.robotId.toLowerCase() as `0x${string}`,
      player: message.player.toLowerCase() as `0x${string}`,
      nonce: uint("message.nonce", message.nonce),
      deadline: uint("message.deadline", message.deadline),
    },
  };
}

/** The signer of `message` under `domain`, lowercased; throws on a malformed signature. */
export async function recoverPlayer(
  domain: CaptureDomain,
  message: Capture,
  signature: `0x${string}`
): Promise<`0x${string}`> {
  const { EIP712Domain: _, ...types } = CAPTURE_TYPES;
  const signer = await recoverTypedDataAddress({
    domain,
    types,
    primaryType: "Capture",
    message,
    signature,
  });
  return signer.toLowerCase() as `0x${string}`;
}
