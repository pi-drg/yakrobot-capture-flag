import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { robotIdFor } from "../src/config";
import { type EnsReader, lookupName, NAME_TTL_S, refreshNames } from "../src/names";
import { type Relayer, RELAYER_NAME } from "../src/relayer";
import { STUB_PORTS, STUB_ROBOT } from "./stub-ports";

const relayer = () => env.RELAYER.get(env.RELAYER.idFromName(RELAYER_NAME));
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

/** A fake resolver: Base names by address, ENS names by address; calls are counted. */
function fakeReader(baseNames: Record<string, string>, ensNames: Record<string, string>, fail = new Set<string>()) {
  const calls: string[] = [];
  const reader: EnsReader = {
    async getEnsName({ address, coinType }) {
      calls.push(`${address}:${coinType === undefined ? "ens" : "base"}`);
      if (fail.has(address)) throw new Error("rpc down");
      return (coinType === undefined ? ensNames[address] : baseNames[address]) ?? null;
    },
  };
  return { reader, calls };
}

describe("lookupName", () => {
  it("prefers the Basename, then the ENS name, else null", async () => {
    const { reader } = fakeReader({ [addr(1)]: "alice.base.eth" }, { [addr(1)]: "alice.eth", [addr(2)]: "bob.eth" });
    expect(await lookupName(reader, addr(1))).toBe("alice.base.eth");
    expect(await lookupName(reader, addr(2))).toBe("bob.eth");
    expect(await lookupName(reader, addr(3))).toBeNull();
  });

  it("drops a name over 64 characters", async () => {
    const { reader } = fakeReader({}, { [addr(1)]: `${"a".repeat(61)}.eth` });
    expect(await lookupName(reader, addr(1))).toBeNull();
  });

  it("throws when the RPC fails, so the failure isn't cached as no name", async () => {
    const { reader } = fakeReader({}, {}, new Set([addr(1)]));
    await expect(lookupName(reader, addr(1))).rejects.toThrow("rpc down");
  });
});

describe("refreshNames", () => {
  it("looks up only what isn't cached, keeps no-name answers, and skips failures", async () => {
    const { reader, calls } = fakeReader({ [addr(10)]: "carol.base.eth" }, {}, new Set([addr(12)]));
    await refreshNames(reader, relayer(), [addr(10), addr(11), addr(12), addr(10)]);
    expect(await relayer().namesFor([addr(10), addr(11), addr(12)])).toEqual({ [addr(10)]: "carol.base.eth" });

    // 10 and 11 are cached (11 as "no name"); 12 failed, so it's asked again.
    calls.length = 0;
    await refreshNames(reader, relayer(), [addr(10), addr(11), addr(12)]);
    expect(calls.map((c) => c.split(":")[0])).toEqual([addr(12)]);
  });

  it("re-checks a name after a day", async () => {
    const { reader, calls } = fakeReader({}, { [addr(20)]: "dave.eth" });
    await refreshNames(reader, relayer(), [addr(20)]);
    await runInDurableObject(relayer(), (_: Relayer, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE names SET checked_at = checked_at - ? WHERE address = ?", NAME_TTL_S + 1, addr(20));
    });
    calls.length = 0;
    await refreshNames(reader, relayer(), [addr(20)]);
    expect(calls).toHaveLength(2);
  });

  it("does nothing without a reader (no ENS_RPC_URL)", async () => {
    await refreshNames(null, relayer(), [addr(30)]);
    expect(await relayer().staleNames([addr(30)], NAME_TTL_S, 20)).toEqual([addr(30)]);
  });
});

describe("routes", () => {
  it("serve cached names with /leaderboard and /r/:robot/drivers", async () => {
    const robotId = robotIdFor(`127.0.0.1:${STUB_PORTS.status}`, STUB_ROBOT);
    const named = addr(40), plain = addr(41);
    await runInDurableObject(relayer(), (_: Relayer, state: DurableObjectState) => {
      const sql = state.storage.sql;
      for (const [i, player] of [named, plain].entries()) {
        sql.exec(
          "INSERT INTO captures (slug, robot_id, player, nonce, tx, at) VALUES ('status', ?, ?, ?, '0x01', ?)",
          robotId, player, String(i), 1_000 + i
        );
        sql.exec("INSERT INTO counts (robot_id, player, n, reached) VALUES (?, ?, 1, ?)", robotId, player, i + 1);
        sql.exec("INSERT INTO totals (player, n, reached) VALUES (?, 1, ?)", player, i + 1);
      }
    });
    await relayer().saveNames([{ address: named, name: "erin.base.eth" }, { address: plain, name: null }]);

    const board = (await (await SELF.fetch("https://capture-flag.test/leaderboard")).json()) as { names: Record<string, string> };
    expect(board.names).toEqual({ [named]: "erin.base.eth" });
    const drivers = (await (await SELF.fetch("https://capture-flag.test/r/status/drivers")).json()) as { names: Record<string, string> };
    expect(drivers.names).toEqual({ [named]: "erin.base.eth" });
  });
});
