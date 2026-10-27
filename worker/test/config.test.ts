import { describe, expect, it } from "vitest";
import vectors from "../../contracts/test/vectors.json";
import { ConfigError, findRobot, loadConfig, robotIdFor, type RawEnv } from "../src/config";

const ROBOTS = {
  picar_adeept: { gateway: "https://gateway.yakrobot.example", label: "PiCar", place: "India" },
  fakerobot: { gateway: "https://berlin.example:8443/", label: "Fake", place: "Berlin" },
};

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
    const [adeept, fake] = loadConfig(env()).robots;
    expect(adeept).toEqual({
      name: "picar_adeept",
      gateway: "https://gateway.yakrobot.example",
      robotId: vectors.vectors[0].message.robotId,
      label: "PiCar",
      place: "India",
    });
    // The port is part of the host; a trailing slash is not.
    expect(fake.gateway).toBe("https://berlin.example:8443");
    expect(fake.robotId).toBe(robotIdFor("berlin.example:8443", "fakerobot"));
  });

  it("lowercases the host, as the URL standard does", () => {
    const [robot] = loadConfig(
      robots({ picar_adeept: { ...ROBOTS.picar_adeept, gateway: "https://Gateway.Yakrobot.Example" } })
    ).robots;
    expect(robot.robotId).toBe(vectors.vectors[0].message.robotId);
  });

  it("finds a configured robot and not an unknown one", () => {
    const config = loadConfig(env());
    expect(findRobot(config, "fakerobot")?.place).toBe("Berlin");
    expect(findRobot(config, "nope")).toBeUndefined();
  });

  it("allows http only to localhost for local dev", () => {
    const local = { fakerobot: { ...ROBOTS.fakerobot, gateway: "http://127.0.0.1:8000" } };
    expect(loadConfig(robots(local)).robots[0].gateway).toBe("http://127.0.0.1:8000");
  });

  it.each([
    ["a non-https gateway", { gateway: "http://berlin.example" }],
    ["a gateway with a path", { gateway: "https://berlin.example/fakerobot" }],
    ["a gateway with a query", { gateway: "https://berlin.example/?x=1" }],
    ["a gateway with credentials", { gateway: "https://u:p@berlin.example" }],
    ["a gateway that isn't a URL", { gateway: "berlin.example" }],
    ["a missing label", { label: undefined }],
    ["a blank place", { place: "  " }],
    ["a hand-typed robot_id", { robot_id: "0x" + "00".repeat(32) }],
  ])("rejects %s", (_, patch) => {
    expect(() => loadConfig(robots({ fakerobot: { ...ROBOTS.fakerobot, ...patch } }))).toThrow(
      ConfigError
    );
  });

  it.each(["Fakerobot", "fake robot", "fake/robot", "_fake", ""])(
    "rejects the robot key %j",
    (name) => {
      expect(() => loadConfig(robots({ [name]: ROBOTS.fakerobot }))).toThrow(ConfigError);
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
