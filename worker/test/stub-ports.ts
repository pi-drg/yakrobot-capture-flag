/**
 * Shared by vitest.config.ts (Node: the ROBOTS binding), test/global-setup.ts (Node: the
 * stub servers) and the tests (workerd: setting stub state). Plain data, no imports.
 */

export const STUB_ROBOT = "picar_freenove";

/** One stub gateway per robot slug. */
export const STUB_PORTS = {
  status: 18550,
  busy: 18551,
  down: 18552,
  "no-ui": 18553,
  "not-flag": 18554,
  error: 18555,
  hang: 18556,
  capture: 18557,
} as const;

/** Nothing listens here: connection refused. */
export const DEAD_PORT = 18559;

/** The ROBOTS binding the Worker sees under test. */
export function testRobots(): Record<string, unknown> {
  const robots: Record<string, unknown> = {};
  for (const [slug, port] of Object.entries(STUB_PORTS)) {
    robots[slug] = { gateway: `http://127.0.0.1:${port}`, robot: STUB_ROBOT, label: slug, place: "Test" };
  }
  robots.dead = { gateway: `http://127.0.0.1:${DEAD_PORT}`, robot: STUB_ROBOT, label: "dead", place: "Test" };
  return robots;
}

/** Set one stub gateway's behaviour (see test/global-setup.ts for the states). */
export async function setStub(slug: keyof typeof STUB_PORTS, state: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${STUB_PORTS[slug]}/__state`, {
    method: "POST",
    body: JSON.stringify({ state }),
  });
  if (res.status !== 204) throw new Error(`stub ${slug}: ${res.status}`);
}
