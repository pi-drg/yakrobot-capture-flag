import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { robotIdFor } from "../src/config";
import { CONTRACT_ADDRESS } from "./anvil";
import { STUB_PORTS, STUB_ROBOT } from "./stub-ports";

it("serves the index page", async () => {
  const res = await SELF.fetch("https://capture-flag.test/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await res.text();
  expect(html).toContain("<title>Capture the Flag · YakRobot</title>");
  expect(html).toContain('fetch("/robots"');
});

it("serves a robot page with its config inlined", async () => {
  const res = await SELF.fetch("https://capture-flag.test/r/capture");
  expect(res.status).toBe(200);
  const html = await res.text();
  const json = html.match(/<script id="robot" type="application\/json">(.*?)<\/script>/)?.[1];
  expect(JSON.parse(json ?? "null")).toEqual({
    slug: "capture",
    label: "capture",
    place: "Test",
    robotId: robotIdFor(`127.0.0.1:${STUB_PORTS.capture}`, STUB_ROBOT),
    chainId: 84532,
    contract: CONTRACT_ADDRESS.toLowerCase(),
    drive: `http://127.0.0.1:${STUB_PORTS.capture}/${STUB_ROBOT}/ui`,
    validMinutes: 30,
  });
  expect(html).not.toContain("__ROBOT__");
});

it("404s the page of an unknown robot", async () => {
  expect((await SELF.fetch("https://capture-flag.test/r/nope")).status).toBe(404);
});
