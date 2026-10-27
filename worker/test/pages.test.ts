import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("serves the index page", async () => {
  const res = await SELF.fetch("https://capture-flag.test/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await res.text();
  expect(html).toContain("<title>Capture the Flag · YakRobot</title>");
  expect(html).toContain('fetch("/robots"');
});
