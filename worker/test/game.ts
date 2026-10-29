import { env } from "cloudflare:test";
import { RELAYER_NAME } from "../src/relayer";

/** A fresh deploy starts paused; tests that play resume it first. */
export async function setGamePaused(paused: boolean): Promise<void> {
  await env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME)).setSwitch("game", paused);
}

/** An address in a fresh documentation-range /64, so each request gets its own
 * rate-limit key (IPv6 is limited per /64). */
export function randomIp(): string {
  const [a, b] = Array.from(crypto.getRandomValues(new Uint16Array(2)), (n) => n.toString(16));
  return `2001:db8:${a}:${b}::1`;
}

/** What the admin page's fetches carry: a JSON body, and the Access JWT the edge adds. */
export function adminHeaders(token: string): Record<string, string> {
  return { "content-type": "application/json", "cf-connecting-ip": randomIp(), "cf-access-jwt-assertion": token };
}
