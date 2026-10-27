import { isHex, type PublicClient, recoverMessageAddress } from "viem";
import { captureFlagAbi } from "./abi";
import { type Config, findRobot } from "./config";

/**
 * The owner's game switches — design W7. The owner wallet `personal_sign`s a short text
 * message; there is no admin secret, and nothing here sends a transaction.
 *
 *   yakrobot-capture-flag admin
 *   action: pause|resume|disable|enable
 *   target: game|<robot slug>
 *   chain: <chainId>
 *   contract: <CaptureFlag address>
 *   issued: <unix seconds>
 */

export class AdminError extends Error {
  constructor(
    readonly status: 400 | 403,
    message: string
  ) {
    super(message);
  }
}

export type AdminAction = "pause" | "resume" | "disable" | "enable";

export interface AdminCommand {
  action: AdminAction;
  /** "game" for pause/resume, a `ROBOTS` slug for disable/enable. */
  target: string;
  issued: number;
}

const HEADER = "yakrobot-capture-flag admin";
const FIELDS = ["action", "target", "chain", "contract", "issued"] as const;
/** How far `issued` may be from now, either way. */
export const ISSUED_WINDOW_S = 120;

/** The exact text the admin page asks the wallet to sign. */
export function adminMessage(config: Config, cmd: AdminCommand): string {
  return [
    HEADER,
    `action: ${cmd.action}`,
    `target: ${cmd.target}`,
    `chain: ${config.chainId}`,
    `contract: ${config.contract}`,
    `issued: ${cmd.issued}`,
  ].join("\n");
}

/** Strict: the header and five `key: value` lines, in order, nothing else (step 1). */
export function parseAdminMessage(config: Config, text: unknown, nowSeconds: number): AdminCommand {
  if (typeof text !== "string") throw new AdminError(400, "message must be a string");
  const lines = text.split("\n");
  if (lines.length !== FIELDS.length + 1 || lines[0] !== HEADER) {
    throw new AdminError(400, "not an admin message");
  }
  const values: Record<string, string> = {};
  FIELDS.forEach((field, i) => {
    const prefix = `${field}: `;
    const line = lines[i + 1];
    if (!line.startsWith(prefix)) throw new AdminError(400, `line ${i + 2} must be "${prefix}…"`);
    values[field] = line.slice(prefix.length);
  });

  const action = values.action;
  if (action === "pause" || action === "resume") {
    if (values.target !== "game") throw new AdminError(400, `${action} takes target: game`);
  } else if (action === "disable" || action === "enable") {
    if (!findRobot(config, values.target)) throw new AdminError(400, `${action} takes a robot slug`);
  } else {
    throw new AdminError(400, "unknown action");
  }
  if (values.chain !== String(config.chainId)) throw new AdminError(400, "wrong chain");
  if (values.contract.toLowerCase() !== config.contract.toLowerCase()) {
    throw new AdminError(400, "wrong contract");
  }

  // Step 2, first half; "newer than the last one" is the relayer's, atomically.
  if (!/^[1-9][0-9]{0,11}$/.test(values.issued)) throw new AdminError(400, "issued must be unix seconds");
  const issued = Number(values.issued);
  if (Math.abs(nowSeconds - issued) > ISSUED_WINDOW_S) {
    throw new AdminError(400, "message is stale or from the future, sign again");
  }
  return { action, target: values.target, issued };
}

/** `owner()` changes only by an owner transaction, so a minute's cache is plenty. */
let ownerCache: { contract: string; value: string; at: number } | undefined;

export async function readOwner(client: PublicClient, config: Config): Promise<string> {
  const now = Date.now();
  if (ownerCache && ownerCache.contract === config.contract && now - ownerCache.at < 60_000) {
    return ownerCache.value;
  }
  const value = (
    await client.readContract({ address: config.contract, abi: captureFlagAbi, functionName: "owner" })
  ).toLowerCase();
  ownerCache = { contract: config.contract, value, at: now };
  return value;
}

/** Step 3: the EIP-191 signer must be the contract's owner. */
export async function checkOwner(
  client: PublicClient,
  config: Config,
  message: string,
  signature: unknown
): Promise<void> {
  if (typeof signature !== "string" || !isHex(signature) || signature.length !== 132) {
    throw new AdminError(400, "signature must be a 65-byte hex signature");
  }
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message, signature })).toLowerCase();
  } catch {
    throw new AdminError(400, "bad signature");
  }
  if (signer !== (await readOwner(client, config))) throw new AdminError(403, "not the owner");
}
