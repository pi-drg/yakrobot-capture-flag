// Secrets: `wrangler secret put` in production, `.dev.vars` locally, miniflare bindings
// under test. `wrangler types` only sees vars, so they're declared here.
interface Env {
  RPC_URL?: string;
  RELAYER_PRIVATE_KEY?: string;
  /** Ethereum mainnet RPC for player names (src/names.ts); names are off without it. */
  ENS_RPC_URL?: string;
  /** CDP Secret API Key for the admin page's faucet top-up (src/faucet.ts); off without it. */
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  /** Tests point this at a stub; production uses CDP's own. */
  CDP_API_BASE?: string;
  /** Tests point this at a stub JWKS; production derives it from CF_ACCESS_TEAM_DOMAIN.
   * Never set in wrangler.jsonc: it decides whose keys /admin trusts. */
  CF_ACCESS_CERTS_URL?: string;
}
