import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { stateFromIndex } from "../src/gateway";
import { setStub } from "./stub-ports";

async function status(slug: string) {
  const res = await SELF.fetch(`https://capture-flag.test/r/${slug}/status`);
  return { code: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /r/:robot/status", () => {
  it("reports a free robot", async () => {
    await setStub("status", "free");
    expect(await status("status")).toEqual({ code: 200, body: { state: "free" } });
  });

  it("reports a busy robot with the ride's end in unix seconds", async () => {
    await setStub("busy", "busy");
    const before = Math.floor(Date.now() / 1000);
    const { body } = await status("busy");
    expect(body.state).toBe("busy");
    // The stub's reservation expires in 120 s.
    expect(body.until).toBeGreaterThanOrEqual(before + 120);
    expect(body.until).toBeLessThanOrEqual(before + 122);
  });

  it.each([
    ["down", "down", "robot is down"],
    ["no-ui", "no_ui", "robot has no realtime control"],
    ["not-flag", "not_capture_flag", "gateway is not in capture-flag mode"],
  ] as const)("reports %s as offline", async (slug, state, reason) => {
    await setStub(slug, state);
    expect((await status(slug)).body).toEqual({ state: "offline", reason });
  });

  it("reports a gateway that errors as unreachable", async () => {
    await setStub("error", "error");
    expect((await status("error")).body).toEqual({ state: "unreachable" });
  });

  it("reports a refused connection as unreachable", async () => {
    expect((await status("dead")).body).toEqual({ state: "unreachable" });
  });

  it("gives up on a hanging gateway after about 3 s", async () => {
    await setStub("hang", "hang");
    const started = Date.now();
    expect((await status("hang")).body).toEqual({ state: "unreachable" });
    expect(Date.now() - started).toBeLessThan(4500);
  }, 10_000);

  it("404s an unknown robot, including a gateway robot name", async () => {
    expect((await status("picar_freenove")).code).toBe(404);
  });
});

describe("GET /robots", () => {
  it("lists every robot with its state, in config order", async () => {
    await setStub("status", "free");
    await setStub("busy", "busy");
    const res = await SELF.fetch("https://capture-flag.test/robots");
    const { robots } = (await res.json()) as { robots: Array<Record<string, unknown>> };
    expect(robots.map((r) => r.slug)).toEqual([
      "status", "busy", "down", "no-ui", "not-flag", "error", "hang", "capture", "dead",
    ]);
    expect(robots[0]).toEqual({ slug: "status", label: "status", place: "Test", state: "free" });
    expect(robots[1].state).toBe("busy");
    expect(robots.at(-1)).toMatchObject({ slug: "dead", state: "unreachable" });
  }, 10_000);
});

describe("stateFromIndex", () => {
  const index = (robot: unknown) => ({
    teleop: { reservation: "capture_flag" },
    robots: { r: robot },
  });

  it.each([
    ["not an object", null],
    ["missing robots", { teleop: { reservation: "capture_flag" } }],
  ])("is offline for an index %s", (_, value) => {
    expect(stateFromIndex(value, "r", 0).state).toBe("offline");
  });

  it("is offline for a reservation of the wrong shape", () => {
    const robot = { ui_endpoint: "/r/ui", online: true, reservation: { reserved: true } };
    expect(stateFromIndex(index(robot), "r", 0)).toEqual({
      state: "offline",
      reason: "gateway reservation has the wrong shape",
    });
  });

  it("is offline for a robot the gateway doesn't have", () => {
    expect(stateFromIndex(index({}), "other", 0)).toEqual({
      state: "offline",
      reason: "robot is not on this gateway",
    });
  });
});
