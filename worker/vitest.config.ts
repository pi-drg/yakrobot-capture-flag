import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { testRobots } from "./test/stub-ports.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Robots point at the stub gateways test/global-setup.ts starts.
      miniflare: { bindings: { ROBOTS: JSON.stringify(testRobots()) } },
    }),
  ],
  test: {
    globalSetup: ["./test/global-setup.ts"],
  },
});
