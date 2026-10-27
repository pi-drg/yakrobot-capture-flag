// Secrets: `wrangler secret put` in production, `.dev.vars` locally, miniflare bindings
// under test. `wrangler types` only sees vars, so they're declared here.
interface Env {
  RPC_URL?: string;
  RELAYER_PRIVATE_KEY?: string;
}
