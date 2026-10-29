import type { Robot } from "./config";

/**
 * A robot's state as the claim and index pages show it. Read from the
 * robot's gateway `GET /`, which is unauthenticated and the same index payments reads.
 * The Worker asks on the page's behalf because the gateway is another origin.
 *
 * `paused` and `disabled` are decided by the Worker before any gateway is
 * called, so they never come from here.
 */
export type GatewayState =
  | { state: "free" }
  | { state: "busy"; until: number }
  | { state: "offline"; reason: string }
  | { state: "unreachable" };

/** A gateway that hasn't answered in 3 s counts as unreachable. */
export const GATEWAY_TIMEOUT_MS = 3000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map a gateway index to one robot's state. Anything that isn't plainly drivable by a
 * capture is `offline`, with a reason for the operator; the page shows "offline" either
 * way. `now` is unix ms.
 */
export function stateFromIndex(index: unknown, robot: string, now: number): GatewayState {
  if (!isObject(index) || !isObject(index.robots)) {
    return { state: "offline", reason: "gateway index has no robots" };
  }
  // A gateway not in capture-flag mode hands out rides without checking a capture,
  // so relaying one there would spend gas for nothing.
  if (!isObject(index.teleop) || index.teleop.reservation !== "capture_flag") {
    return { state: "offline", reason: "gateway is not in capture-flag mode" };
  }
  const entry = index.robots[robot];
  if (!isObject(entry)) return { state: "offline", reason: "robot is not on this gateway" };
  // No ui_endpoint means no realtime control server: nothing to drive.
  if (typeof entry.ui_endpoint !== "string") {
    return { state: "offline", reason: "robot has no realtime control" };
  }
  if (entry.online !== true) return { state: "offline", reason: "robot is down" };
  const reservation = entry.reservation;
  if (!isObject(reservation) || typeof reservation.reserved !== "boolean") {
    return { state: "offline", reason: "gateway reservation has the wrong shape" };
  }
  if (!reservation.reserved) return { state: "free" };
  const expiresIn = reservation.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn < 0) {
    return { state: "offline", reason: "gateway reservation has the wrong shape" };
  }
  return { state: "busy", until: Math.ceil((now + expiresIn * 1000) / 1000) };
}

/** Ask one robot's gateway for its state. Never throws: every failure is `unreachable`. */
export async function readGatewayState(robot: Robot, now = Date.now()): Promise<GatewayState> {
  let res: Response;
  try {
    res = await fetch(`${robot.gateway}/`, {
      headers: { accept: "application/json", "ngrok-skip-browser-warning": "1" },
      redirect: "manual",
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch {
    return { state: "unreachable" };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return { state: "unreachable" };
  }
  let index: unknown;
  try {
    index = await res.json();
  } catch {
    return { state: "unreachable" };
  }
  return stateFromIndex(index, robot.name, now);
}
