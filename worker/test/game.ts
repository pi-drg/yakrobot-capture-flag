import { env } from "cloudflare:test";
import { RELAYER_NAME } from "../src/relayer";

/** A fresh deploy starts paused (design W7); tests that play resume it first. */
export async function setGamePaused(paused: boolean): Promise<void> {
  await env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME)).setSwitch("game", paused);
}
