import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminHeaders, randomIp } from "./game";
import { accessToken, STUB_PORTS, STUB_ROBOT } from "./stub-ports";

const BASE = "https://capture-flag.test";

async function robotsPost(body: unknown, headers?: Record<string, string>) {
  const res = await SELF.fetch(`${BASE}/admin/robots`, {
    method: "POST",
    headers: headers ?? adminHeaders(await accessToken()),
    body: JSON.stringify(body),
  });
  return { code: res.status, body: (await res.json()) as Record<string, any> };
}

const slugs = async () =>
  ((await (await SELF.fetch(`${BASE}/robots`)).json()) as { robots: Array<{ slug: string }> }).robots.map((r) => r.slug);

/** A gateway robot no seed entry uses: the stub gateway's host with another robot name. */
const fresh = (slug: string, robot = "other_bot") => ({
  action: "add",
  slug,
  gateway: `http://127.0.0.1:${STUB_PORTS.status}`,
  robot,
  label: `Robot ${slug}`,
  place: "Testville",
});

describe("robots on /admin", () => {
  it("starts with the ROBOTS seed, in its order", async () => {
    expect(await slugs()).toEqual(["status", "busy", "down", "no-ui", "not-flag", "error", "hang", "capture", "dead"]);
  }, 10_000);

  it("adds a robot: listed last, with its own page and status", async () => {
    const res = await robotsPost(fresh("added"));
    expect(res.code).toBe(200);
    expect(res.body.robots.at(-1)).toMatchObject({
      slug: "added",
      gateway: `http://127.0.0.1:${STUB_PORTS.status}`,
      name: "other_bot",
      place: "Testville",
    });
    expect((await slugs()).at(-1)).toBe("added");
    expect((await SELF.fetch(`${BASE}/r/added`)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/r/added/status`)).status).toBe(200);
  }, 10_000);

  it("409s a slug that's taken, and the same gateway robot under a new slug", async () => {
    expect((await robotsPost(fresh("added", "third_bot"))).code).toBe(409);
    const same = await robotsPost({ ...fresh("again"), robot: STUB_ROBOT });
    expect(same).toMatchObject({ code: 409, body: { error: "that gateway robot is already listed as status" } });
  });

  it.each([
    ["a bad slug", { slug: "Not OK" }],
    ["the reserved slug", { slug: "game" }],
    ["plain http to a real host", { gateway: "http://robots.example.org" }],
    ["a gateway with a path", { gateway: "https://robots.example.org/x" }],
    ["a bad robot name", { robot: "Bad Name" }],
    ["a missing label", { label: "" }],
    ["an unknown field", { robot_id: "0x12" }],
  ])("400s %s", async (_, override) => {
    expect((await robotsPost({ ...fresh("bad-one", "fourth_bot"), ...override })).code).toBe(400);
  });

  it("removes a robot and its disable switch; adding it back starts enabled", async () => {
    await robotsPost(fresh("temp", "temp_bot"));
    const disabled = await SELF.fetch(`${BASE}/admin/state`, {
      method: "POST",
      headers: adminHeaders(await accessToken()),
      body: JSON.stringify({ action: "disable", target: "temp" }),
    });
    expect(disabled.status).toBe(200);

    expect((await robotsPost({ action: "remove", slug: "temp" })).code).toBe(200);
    expect(await slugs()).not.toContain("temp");
    expect((await SELF.fetch(`${BASE}/r/temp`)).status).toBe(404);

    const back = await robotsPost(fresh("temp", "temp_bot"));
    expect(back.body.robots.find((r: { slug: string }) => r.slug === "temp").disabled).toBe(false);
  }, 10_000);

  it("404s removing a robot that isn't there, and 400s an unknown action", async () => {
    expect((await robotsPost({ action: "remove", slug: "nope" })).code).toBe(404);
    expect((await robotsPost({ action: "rename", slug: "status" })).code).toBe(400);
  });

  it("401s without Access and 403s another origin, changing nothing", async () => {
    const before = await slugs();
    expect((await robotsPost(fresh("sneaky"), { "content-type": "application/json", "cf-connecting-ip": randomIp() })).code).toBe(401);
    expect((await robotsPost(fresh("sneaky"), { ...adminHeaders(await accessToken()), origin: "https://evil.example" })).code).toBe(403);
    expect(await slugs()).toEqual(before);
  }, 10_000);
});
