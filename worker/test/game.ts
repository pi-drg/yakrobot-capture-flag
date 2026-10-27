import { env } from "cloudflare:test";
import { RELAYER_NAME } from "../src/relayer";

/** A fresh deploy starts paused (design W7); tests that play resume it first. */
export async function setGamePaused(paused: boolean): Promise<void> {
  await env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME)).setSwitch("game", paused);
}

/** A fresh documentation-range IPv6 address, so each request gets its own rate-limit key. */
export function randomIp(): string {
  const [a, b] = Array.from(crypto.getRandomValues(new Uint16Array(2)), (n) => n.toString(16));
  return `2001:db8::${a}:${b}`;
}
