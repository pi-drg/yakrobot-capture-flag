import { Hono } from "hono";
import { type Config, findRobot, loadConfig } from "./config";
import { readGatewayState } from "./gateway";

// Routes still to come: /, /capture, /r/:robot (page), /admin (W2–W2a), /health (W6).
const app = new Hono<{ Bindings: Env; Variables: { config: Config } }>();

// Vars only change on deploy, so parse them once per isolate; the key is the env object.
const configs = new WeakMap<object, Config>();

app.use("*", async (c, next) => {
  let config = configs.get(c.env);
  if (!config) {
    config = loadConfig(c.env as unknown as Record<string, string | undefined>);
    configs.set(c.env, config);
  }
  c.set("config", config);
  await next();
});

app.get("/health", (c) => c.json({ ok: true, chain: c.env.CHAIN }));

/** Every robot's state for the index page, gateways asked in parallel (design W5b). */
app.get("/robots", async (c) => {
  const { robots } = c.get("config");
  const states = await Promise.all(robots.map((r) => readGatewayState(r)));
  return c.json({
    robots: robots.map((r, i) => ({ slug: r.slug, label: r.label, place: r.place, ...states[i] })),
  });
});

app.get("/r/:robot/status", async (c) => {
  const robot = findRobot(c.get("config"), c.req.param("robot"));
  if (!robot) return c.json({ error: "unknown robot" }, 404);
  return c.json(await readGatewayState(robot));
});

export default app;
