import { describe, expect, it } from "vitest";
import vectors from "../../contracts/test/vectors.json";
import { ConfigError, findRobot, loadConfig, robotIdFor, type RawEnv } from "../src/config";

const INDIA = {
  gateway: "https://gateway.yakrobot.example",
  robot: "picar_adeept",
  label: "Adeept PiCar",
  place: "India",
};
// Two friends with the same kit: same robot name, different gateways.
const BERLIN = {
  gateway: "https://berlin.example:8443/",
  robot: "picar_freenove",
  label: "Freenove PiCar",
  place: "Berlin",
};
const SEATTLE = { ...BERLIN, gateway: "https://seattle.example", place: "Seattle" };
const ROBOTS = { india: INDIA, berlin: BERLIN, seattle: SEATTLE };

function env(overrides: RawEnv = {}): RawEnv {
  return {
    CHAIN: "84532",
    CONTRACT: "0xF3F2e69A1b00577d5d6ca1911a3a80132CD08737",
    ROBOTS: JSON.stringify(ROBOTS),
    RELAYER_MIN_WEI: "1000000000000000",
    DRIVERS_SHOWN: "50",
    ...overrides,
  };
}

function robots(value: unknown): RawEnv {
  return env({ ROBOTS: JSON.stringify(value) });
}

describe("robotIdFor", () => {
  it("matches the contract's shared vectors", () => {
    for (const v of vectors.vectors) {
      const slash = v.robotKey.indexOf("/");
      expect(robotIdFor(v.robotKey.slice(0, slash), v.robotKey.slice(slash + 1))).toBe(
        v.message.robotId
      );
    }
  });
});

describe("loadConfig", () => {
  it("loads the shipped wrangler vars, with no robots yet", () => {
    const config = loadConfig(env({ ROBOTS: "{}" }));
    expect(config.chainId).toBe(84532);
    expect(config.contract).toBe("0xf3f2e69a1b00577d5d6ca1911a3a80132cd08737");
    expect(config.robots).toEqual([]);
    expect(config.relayerMinWei).toBe(1_000_000_000_000_000n);
    expect(config.driversShown).toBe(50);
  });

  it("derives each robotId from the gateway host and robot name", () => {
    const [india, berlin] = loadConfig(env()).robots;
    expect(india).toEqual({
      slug: "india",
      name: "picar_adeept",
      gateway: "https://gateway.yakrobot.example",
      robotId: vectors.vectors[0].message.robotId,
      label: "Adeept PiCar",
      place: "India",
    });
    // The port is part of the host; a trailing slash is not.
    expect(berlin.gateway).toBe("https://berlin.example:8443");
    expect(berlin.robotId).toBe(robotIdFor("berlin.example:8443", "picar_freenove"));
  });

  it("keeps friends with the same robot name apart by their gateway host", () => {
    const { robots } = loadConfig(env());
    const [, berlin, seattle] = robots;
    expect(berlin.name).toBe(seattle.name);
    expect(berlin.robotId).not.toBe(seattle.robotId);
  });

  it("lowercases the host, as the URL standard does", () => {
    const [robot] = loadConfig(
      robots({ india: { ...INDIA, gateway: "https://Gateway.Yakrobot.Example" } })
    ).robots;
    expect(robot.robotId).toBe(vectors.vectors[0].message.robotId);
  });

  it("rejects two slugs for the same gateway robot", () => {
    expect(() =>
      loadConfig(robots({ india: INDIA, again: { ...INDIA, gateway: "https://GATEWAY.yakrobot.example/" } }))
    ).toThrow(/same gateway robot as ROBOTS.india/);
  });

  it("finds a configured robot by slug and not an unknown one", () => {
    const config = loadConfig(env());
    expect(findRobot(config, "berlin")?.place).toBe("Berlin");
    expect(findRobot(config, "picar_freenove")).toBeUndefined();
  });

  it("allows http only to localhost for local dev", () => {
    const local = { berlin: { ...BERLIN, gateway: "http://127.0.0.1:8000" } };
    expect(loadConfig(robots(local)).robots[0].gateway).toBe("http://127.0.0.1:8000");
  });

  it.each([
    ["a non-https gateway", { gateway: "http://berlin.example" }],
    ["a gateway with a path", { gateway: "https://berlin.example/picar_freenove" }],
    ["a gateway with a query", { gateway: "https://berlin.example/?x=1" }],
    ["a gateway with credentials", { gateway: "https://u:p@berlin.example" }],
    ["a gateway that isn't a URL", { gateway: "berlin.example" }],
    ["a missing robot name", { robot: undefined }],
    ["a robot name with a slash", { robot: "picar/freenove" }],
    ["an uppercase robot name", { robot: "PiCar" }],
    ["a missing label", { label: undefined }],
    ["a blank place", { place: "  " }],
    ["a hand-typed robot_id", { robot_id: "0x" + "00".repeat(32) }],
  ])("rejects %s", (_, patch) => {
    expect(() => loadConfig(robots({ berlin: { ...BERLIN, ...patch } }))).toThrow(ConfigError);
  });

  it.each(["Berlin", "ber lin", "ber/lin", "-berlin", "picar_freenove", "", "game"])(
    "rejects the slug %j",
    (slug) => {
      expect(() => loadConfig(robots({ [slug]: BERLIN }))).toThrow(ConfigError);
    }
  );

  it.each([
    ["ROBOTS that isn't JSON", { ROBOTS: "{" }],
    ["ROBOTS that is an array", { ROBOTS: "[]" }],
    ["a missing CHAIN", { CHAIN: "" }],
    ["an unsupported chain", { CHAIN: "1" }],
    ["a malformed CONTRACT", { CONTRACT: "0x1234" }],
    ["a negative RELAYER_MIN_WEI", { RELAYER_MIN_WEI: "-1" }],
    ["DRIVERS_SHOWN of zero", { DRIVERS_SHOWN: "0" }],
  ])("rejects %s", (_, overrides) => {
    expect(() => loadConfig(env(overrides))).toThrow(ConfigError);
  });
});
