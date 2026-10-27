import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { ANVIL_RPC, CONTRACT_ADDRESS, RELAYER_KEY } from "./test/anvil.ts";
import { testRobots } from "./test/stub-ports.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Robots point at the stub gateways, and the chain at the anvil, that
      // test/global-setup.ts starts.
      miniflare: {
        bindings: {
          ROBOTS: JSON.stringify(testRobots()),
          CONTRACT: CONTRACT_ADDRESS,
          RPC_URL: ANVIL_RPC,
          RELAYER_PRIVATE_KEY: RELAYER_KEY,
        },
      },
    }),
  ],
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // One anvil and one relayer key for every file: capture.test.ts and stuck.test.ts both
    // send from it and toggle automine, so files run one at a time.
    fileParallelism: false,
  },
});
