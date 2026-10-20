import { describe, expect, it } from "vitest";
import {
  BG3_TEST_PROTOCOL_VERSION,
  parseBg3TestClientReady,
  parseBg3TestModLoad,
  parseBg3TestResult,
  parseBg3SaveIntent,
  parseBg3SaveIntentAck,
  parseBg3SaveRequest,
  parseBg3AutosaveGuard,
  parseBg3ServerFinalizing,
  parseBg3ServerReady,
} from "../src/protocol.js";
import type { Bg3RequiredMods } from "../src/scenario-catalog.js";

const expected = {
  runId: "run-protocol",
  scenarioId: "example.runtime-mechanic",
};

function result(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    runId: expected.runId,
    scenarioId: expected.scenarioId,
    status: "passed",
    startedAtEpochMs: 1000,
    completedAtEpochMs: 2000,
    assertions: [],
    ...overrides,
  });
}

describe("BG3 test result protocol", () => {
  it("rejects duplicate assertion identifiers", () => {
    expect(() =>
      parseBg3TestResult(
        result({
          assertions: [
            { id: "damage", passed: true, message: "First" },
            { id: "damage", passed: true, message: "Second" },
          ],
        }),
        expected,
      ),
    ).toThrow("Result assertion identifiers must be unique");
  });

  it("requires a failed assertion when status is failed", () => {
    expect(() =>
      parseBg3TestResult(
        result({ status: "failed", assertions: [] }),
        expected,
      ),
    ).toThrow("Failed result requires a failed assertion");
  });

  it.each([
    ["startedAtEpochMs", -1],
    ["completedAtEpochMs", 1.5],
  ])("rejects invalid %s", (field, value) => {
    expect(() =>
      parseBg3TestResult(result({ [field]: value }), expected),
    ).toThrow(`Result requires a non-negative integer ${field}`);
  });
});

describe("BG3 character-creation client readiness protocol", () => {
  it("accepts an acknowledgement for the active run and scenario", () => {
    expect(
      parseBg3TestClientReady(
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-protocol",
          scenarioId: "example.runtime-mechanic",
          status: "ready",
          readyAtEpochMs: 1500,
        }),
        { ...expected, mode: "character-creation" },
      ),
    ).toEqual({
      schemaVersion: 2,
      runId: "run-protocol",
      scenarioId: "example.runtime-mechanic",
      status: "ready",
      readyAtEpochMs: 1500,
    });
  });

  it("rejects an acknowledgement from another run", () => {
    expect(() =>
      parseBg3TestClientReady(
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-stale",
          scenarioId: "example.runtime-mechanic",
          status: "ready",
          readyAtEpochMs: 1500,
        }),
        { ...expected, mode: "character-creation" },
      ),
    ).toThrow("Client readiness runId does not match active run");
  });
});

describe("BG3 mod-load observation protocol", () => {
  const exampleRuntimeMods: Bg3RequiredMods = {
    ordered: [
      {
        name: "Example Rules Dependency",
        uuid: "0508cc3f-d202-4ae5-a927-7c837bd40de6",
      },
      {
        name: "BG3 In-Game Harness",
        uuid: "41d551b8-e0c1-4c12-8a29-1be03b5f9054",
      },
      {
        name: "Harness Example",
        uuid: "cd639062-7736-457d-aa6a-c364979b8921",
      },
    ],
    present: [],
  };
  const creationMods: Bg3RequiredMods = {
    ...exampleRuntimeMods,
    present: [
      {
        name: "Example Intro Skip",
        uuid: "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c",
      },
    ],
  };
  const loadOrder = [
    "b770dfd7-4239-44f0-90f6-656382fb0696",
    "0508cc3f-d202-4ae5-a927-7c837bd40de6",
    "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c",
    "41d551b8-e0c1-4c12-8a29-1be03b5f9054",
    "cd639062-7736-457d-aa6a-c364979b8921",
  ];

  function observation(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 2,
      runId: expected.runId,
      scenarioId: expected.scenarioId,
      status: "observed",
      observedAtEpochMs: 1500,
      loadOrder,
      ...overrides,
    });
  }

  it("accepts the required runtime modules in their dependency order", () => {
    expect(
      parseBg3TestModLoad(observation(), expected, exampleRuntimeMods),
    ).toMatchObject({
      runId: expected.runId,
      scenarioId: expected.scenarioId,
      status: "observed",
      loadOrder,
    });
  });

  it("requires Example Intro Skip only for character creation", () => {
    const withoutSkip = loadOrder.filter(
      (uuid) => uuid !== "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c",
    );

    expect(() =>
      parseBg3TestModLoad(
        observation({ loadOrder: withoutSkip }),
        expected,
        creationMods,
      ),
    ).toThrow(
      "Required BG3 mod is not loaded: Example Intro Skip (bdb30fae-00c7-4cdb-99d3-7c3e00b4380c)",
    );
    expect(() =>
      parseBg3TestModLoad(
        observation({ loadOrder: withoutSkip }),
        expected,
        exampleRuntimeMods,
      ),
    ).not.toThrow();
  });

  it("rejects the example mod loading before the harness mod", () => {
    expect(() =>
      parseBg3TestModLoad(
        observation({
          loadOrder: [
            loadOrder[0],
            loadOrder[1],
            loadOrder[2],
            loadOrder[4],
            loadOrder[3],
          ],
        }),
        expected,
        exampleRuntimeMods,
      ),
    ).toThrow(
      "Required BG3 mods are out of order: BG3 In-Game Harness must load before Harness Example",
    );
  });

  it("rejects malformed and duplicate module UUIDs", () => {
    expect(() =>
      parseBg3TestModLoad(
        observation({ loadOrder: [...loadOrder, "not-a-uuid"] }),
        expected,
        exampleRuntimeMods,
      ),
    ).toThrow("Mod-load observation contains an invalid UUID: not-a-uuid");
    expect(() =>
      parseBg3TestModLoad(
        observation({ loadOrder: [...loadOrder, loadOrder[1]] }),
        expected,
        exampleRuntimeMods,
      ),
    ).toThrow(
      "Mod-load observation contains a duplicate UUID: 0508cc3f-d202-4ae5-a927-7c837bd40de6",
    );
  });

  it("validates a second content scenario without requiring the example mod", () => {
    const secondMods: Bg3RequiredMods = {
      ordered: [
        exampleRuntimeMods.ordered[0]!,
        exampleRuntimeMods.ordered[1]!,
        {
          name: "Example Content B",
          uuid: "7f712806-3674-421f-8e7b-dca469e545f5",
        },
      ],
      present: [],
    };
    const secondOrder = loadOrder
      .filter((uuid) => uuid !== "cd639062-7736-457d-aa6a-c364979b8921")
      .concat("7f712806-3674-421f-8e7b-dca469e545f5");

    expect(() =>
      parseBg3TestModLoad(
        observation({ loadOrder: secondOrder }),
        expected,
        secondMods,
      ),
    ).not.toThrow();
  });

  it("matches required mod UUIDs case-insensitively", () => {
    const uppercaseRequirements: Bg3RequiredMods = {
      ordered: exampleRuntimeMods.ordered.map((mod) => ({
        ...mod,
        uuid: mod.uuid.toUpperCase(),
      })),
      present: [],
    };

    expect(() =>
      parseBg3TestModLoad(
        observation(),
        expected,
        uppercaseRequirements,
      ),
    ).not.toThrow();
  });
});

describe("BG3 protocol version", () => {
  it("uses wire protocol v2", () => {
    expect(BG3_TEST_PROTOCOL_VERSION).toBe(2);
  });
});

describe("BG3 protocol run deadlines", () => {
  const window = {
    ...expected,
    createdAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000,
  };
  const requiredMods: Bg3RequiredMods = {
    ordered: [
      {
        name: "Example Rules Dependency",
        uuid: "0508cc3f-d202-4ae5-a927-7c837bd40de6",
      },
      {
        name: "BG3 In-Game Harness",
        uuid: "41d551b8-e0c1-4c12-8a29-1be03b5f9054",
      },
    ],
    present: [],
  };

  it("rejects a mod-load timestamp before the active run", () => {
    expect(() => parseBg3TestModLoad(JSON.stringify({
      schemaVersion: 2,
      runId: expected.runId,
      scenarioId: expected.scenarioId,
      status: "observed",
      observedAtEpochMs: 999,
      loadOrder: requiredMods.ordered.map((mod) => mod.uuid),
    }), window, requiredMods)).toThrow(
      "Mod-load observation predates the active run",
    );
  });

  it("rejects client readiness after the active deadline", () => {
    expect(() => parseBg3TestClientReady(JSON.stringify({
      schemaVersion: 2,
      runId: expected.runId,
      scenarioId: expected.scenarioId,
      status: "ready",
      readyAtEpochMs: 2_001,
    }), { ...window, mode: "character-creation" })).toThrow(
      "Client readiness exceeds the active run deadline",
    );
  });

  it("rejects a result that completes after the active deadline", () => {
    expect(() => parseBg3TestResult(result({
      startedAtEpochMs: 1_500,
      completedAtEpochMs: 2_001,
    }), window)).toThrow("Result completion exceeds the active run deadline");
  });
});

describe("BG3 Server handshake protocol", () => {
  const window = {
    runId: "run-handshake",
    scenarioId: "example.background-creation",
    createdAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000,
  };

  it("parses ready and finalizing artifacts inside the run window", () => {
    expect(parseBg3AutosaveGuard(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "suppressed",
      suppressedAtEpochMs: 1_050,
    }), window)).toMatchObject({
      status: "suppressed",
      suppressedAtEpochMs: 1_050,
    });
    expect(parseBg3ServerReady(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "ready",
      readyAtEpochMs: 1_100,
    }), window)).toMatchObject({ status: "ready", readyAtEpochMs: 1_100 });
    expect(parseBg3ServerFinalizing(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "finalizing",
      finalizingAtEpochMs: 1_900,
    }), window)).toMatchObject({
      status: "finalizing",
      finalizingAtEpochMs: 1_900,
    });
  });

  it("parses one correlated save handshake", () => {
    const intentId = "run-handshake.save1";
    expect(parseBg3SaveIntent(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "intent",
      intentId,
      intentAtEpochMs: 1_400,
    }), window)).toMatchObject({ status: "intent", intentId });
    expect(parseBg3SaveIntentAck(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "acknowledged",
      intentId,
      acknowledgedAtEpochMs: 1_500,
    }), window)).toMatchObject({ status: "acknowledged", intentId });
    expect(parseBg3SaveRequest(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "requested",
      intentId,
      requestedAtEpochMs: 1_600,
    }), window)).toMatchObject({ status: "requested", intentId });
  });

  it("rejects wrong identity, time, status, intent, and extra fields", () => {
    expect(() => parseBg3ServerReady(JSON.stringify({
      schemaVersion: 2,
      runId: "run-other",
      scenarioId: window.scenarioId,
      status: "ready",
      readyAtEpochMs: 1_100,
    }), window)).toThrow("Server readiness runId does not match active run");
    expect(() => parseBg3ServerFinalizing(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "done",
      finalizingAtEpochMs: 1_900,
    }), window)).toThrow("Server finalizing status must be finalizing");
    expect(() => parseBg3SaveIntent(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "intent",
      intentId: "unsafe intent",
      intentAtEpochMs: 1_400,
    }), window)).toThrow("Save intent has an invalid intentId");
    expect(() => parseBg3SaveRequest(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "requested",
      intentId: "run-handshake.save1",
      requestedAtEpochMs: 2_001,
    }), window)).toThrow("Save request exceeds the active run deadline");
    expect(() => parseBg3SaveIntentAck(JSON.stringify({
      schemaVersion: 2,
      runId: window.runId,
      scenarioId: window.scenarioId,
      status: "acknowledged",
      intentId: "run-handshake.save1",
      acknowledgedAtEpochMs: 1_500,
      unexpected: true,
    }), window)).toThrow("Save intent acknowledgement contains unexpected fields");
  });
});
