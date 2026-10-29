import { ConfigError, findRobot, parseRobot, type Robot } from "./config";

/**
 * The admins' game switches and robot list. Who may use them is Cloudflare Access's call
 * (src/access.ts); this only checks the command's shape. The owner wallet isn't involved:
 * it is for the contract alone (setRelayer, setCooldown), and nothing here sends a
 * transaction.
 *
 *   POST /admin/state   {"action": "pause"|"resume", "target": "game"}
 *                       {"action": "disable"|"enable", "target": "<robot slug>"}
 *   POST /admin/robots  {"action": "add", "slug", "gateway", "robot", "label", "place"}
 *                       {"action": "remove", "slug"}
 */

export class AdminError extends Error {
  constructor(
    readonly status: 400 | 403 | 415,
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
}

export function parseAdminCommand(robots: Robot[], body: unknown): AdminCommand {
  if (typeof body !== "object" || body === null) throw new AdminError(400, "body must be JSON {action, target}");
  const { action, target } = body as { action?: unknown; target?: unknown };
  if (typeof target !== "string") throw new AdminError(400, "target must be a string");
  if (action === "pause" || action === "resume") {
    if (target !== "game") throw new AdminError(400, `${action} takes target: game`);
  } else if (action === "disable" || action === "enable") {
    if (!findRobot(robots, target)) throw new AdminError(400, `${action} takes a robot slug`);
  } else {
    throw new AdminError(400, "unknown action");
  }
  return { action, target };
}

export type RobotCommand = { action: "add"; robot: Robot } | { action: "remove"; slug: string };

/** Add takes the same fields as a `ROBOTS` entry, checked the same way (`parseRobot`). */
export function parseRobotCommand(body: unknown): RobotCommand {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AdminError(400, "body must be a JSON object");
  const { action, slug, ...fields } = body as Record<string, unknown>;
  if (action === "remove") {
    if (typeof slug !== "string" || !slug) throw new AdminError(400, "remove takes a slug");
    return { action, slug };
  }
  if (action !== "add") throw new AdminError(400, "unknown action");
  try {
    return { action, robot: parseRobot(slug, fields) };
  } catch (err) {
    if (err instanceof ConfigError) throw new AdminError(400, err.message);
    throw err;
  }
}

/**
 * Same-origin JSON only, for the admin POSTs. The Access cookie rides along on a
 * cross-site form post, and Hono's `c.req.json()` parses any content type, so: a JSON
 * content type (a form can't send one, and a cross-origin fetch that does needs a
 * preflight this Worker never answers), and an `Origin` / `Sec-Fetch-Site` that, when
 * present, say same origin.
 */
export function checkSameOrigin(request: Request): void {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) throw new AdminError(415, "content-type must be application/json");
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) throw new AdminError(403, "cross-origin request");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") throw new AdminError(403, "cross-site request");
}
