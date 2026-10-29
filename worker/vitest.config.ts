import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { ANVIL_RPC, CONTRACT_ADDRESS, RELAYER_KEY } from "./test/anvil.ts";
import {
  ACCESS_CERTS_URL,
  CDP_TEST_KEY_ID,
  CDP_TEST_KEY_SECRET,
  FAUCET_BASE,
  TEST_AUD,
  TEST_TEAM_DOMAIN,
  testRobots,
} from "./test/stub-ports.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Robots point at the stub gateways, the faucet at the stub CDP, Access at a stub team, and
      // the chain at the anvil, that
      // test/global-setup.ts starts.
      miniflare: {
        bindings: {
          ROBOTS: JSON.stringify(testRobots()),
          CONTRACT: CONTRACT_ADDRESS,
          RPC_URL: ANVIL_RPC,
          RELAYER_PRIVATE_KEY: RELAYER_KEY,
          CDP_API_BASE: FAUCET_BASE,
          CDP_API_KEY_ID: CDP_TEST_KEY_ID,
          CDP_API_KEY_SECRET: CDP_TEST_KEY_SECRET,
          CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
          CF_ACCESS_AUD: TEST_AUD,
          CF_ACCESS_CERTS_URL: ACCESS_CERTS_URL,
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
