import { createServer, type Server } from "node:http";
import { STUB_PORTS, STUB_ROBOT } from "./stub-ports";

/**
 * Runs in Node, outside workerd, before any test file. Starts one stub gateway per port
 * in STUB_PORTS, each serving the robot STUB_ROBOT, which the Worker fetches over real
 * HTTP (the vitest plugin has no fetchMock). One server per robot keeps tests that run
 * in parallel from stepping on each other. A test sets its gateway's behaviour with
 * `POST /__state {state}`.
 */

export type StubState = "free" | "busy" | "down" | "no_ui" | "not_capture_flag" | "error" | "hang";

function indexFor(state: StubState) {
  return {
    service: "Robot Fleet Gateway",
    teleop: { reservation: state === "not_capture_flag" ? "free" : "capture_flag", lease_minutes: 5 },
    robots: {
      [STUB_ROBOT]: {
        mcp_endpoint: `/${STUB_ROBOT}/mcp`,
        ...(state === "no_ui" ? {} : { ui_endpoint: `/${STUB_ROBOT}/ui` }),
        tools: ["robot_move"],
        reservation:
          state === "busy"
            ? { reserved: true, holder: "free:abc", held_seconds: 10, expires_in: 120 }
            : { reserved: false },
        online: state === "no_ui" ? null : state !== "down",
      },
    },
  };
}

function stubGateway(): Server {
  let state: StubState = "free";
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__state") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        state = (JSON.parse(body) as { state: StubState }).state;
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      if (state === "hang") return; // never answers; the Worker's timeout must fire
      if (state === "error") return void res.writeHead(502).end("bad gateway");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(indexFor(state)));
      return;
    }
    res.writeHead(404).end();
  });
}

const servers: Server[] = [];

export async function setup() {
  for (const port of Object.values(STUB_PORTS)) {
    const server = stubGateway();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  }
}

export async function teardown() {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
