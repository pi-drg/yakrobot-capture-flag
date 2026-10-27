import { Hono } from "hono";

// Scaffold (F0). Routes arrive in W2–W2a: /, /robots, /r/:robot, /capture, /admin, /health (W6).
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, chain: c.env.CHAIN }));

export default app;
