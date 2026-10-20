import { describe, expect, it } from "vitest";
import {
  createBg3TestScenarioCatalog,
  scenarioMode,
  scenarioSaveId,
  type Bg3RequiredMods,
  type Bg3TestScenario,
  type Bg3TestScenarioDefinition,
  type Bg3RequiredMod,
  type Bg3RuntimeFixture,
} from "../src/scenario-catalog.js";
import { testCatalog, testProtectedSaves } from "./fixtures.js";

const harnessModUuid = "41d551b8-e0c1-4c12-8a29-1be03b5f9054";

const testLsvSha256 = "a".repeat(64);
const secondRequiredMods: Bg3RequiredMods = {
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
      name: "Example Content B",
      uuid: "7f712806-3674-421f-8e7b-dca469e545f5",
    },
  ],
  present: [],
};

function runtimeFixture(
  id: string,
  saveId: string,
  requiredMods: Bg3RequiredMods = secondRequiredMods,
): Bg3RuntimeFixture {
  return { id, saveId, expectedLsvSha256: testLsvSha256, requiredMods };
}

const secondFixture: Bg3TestScenarioDefinition = {
  id: "second.fixture",
  ownerModUuid: "7f712806-3674-421f-8e7b-dca469e545f5",
  savePolicy: "never",
  timeoutMs: 120_000,
  requiredAssertionIds: ["second-ready"],
  launch: {
    kind: "runtime",
    fixtureId: "second",
  },
};

describe("BG3 test scenario catalog", () => {
  it.each([
    { raceUuid: "Elf" },
    { subRaceUuid: "5a076d0b-9b01-4edd-bafe-1d4469eacfdd" },
    { raceUuid: "ce4b7923-bcdd-495c-b2e5-3810bf6dd9b5", subRaceUuid: "Wood Elf" },
  ])("rejects invalid or orphan species identifiers %o", (species) => {
    const base = testCatalog.get("example.background-creation")!;
    if (base.launch.kind !== "character-creation") throw new Error("Missing creation fixture");
    const plan = base.launch.creationPlan;
    expect(() => createBg3TestScenarioCatalog({ harnessModUuid, protectedSaves: testProtectedSaves, allowedRuntimeSaveIds: [], runtimeFixtures: [], scenarios: [{
      ...base, savePolicy: "create-test-fixture",
      launch: { kind: "character-creation", creationPlan: { ...plan, ...species } },
    }] })).toThrow("invalid creation plan");
  });

  it.each(["A", "HarnessExample_RaceChoice_Wisdom", "a".repeat(150)])(
    "preserves an exact optional race passive and freezes its copy: %s", (racePassiveId) => {
      const base = testCatalog.get("example.background-creation")!;
      if (base.launch.kind !== "character-creation") throw new Error("Missing creation fixture");
      const plan = { ...base.launch.creationPlan, raceUuid: "50b65fcf-0d00-4992-b8a8-de11a44eb1e7", racePassiveId };
      const catalog = createBg3TestScenarioCatalog({ harnessModUuid, protectedSaves: testProtectedSaves, allowedRuntimeSaveIds: [], runtimeFixtures: [], scenarios: [{
        ...base, savePolicy: "create-test-fixture", launch: { kind: "character-creation", creationPlan: plan },
      }] });
      plan.racePassiveId = "changed";
      const result = catalog.get(base.id)!;
      expect(result.launch).toMatchObject({ creationPlan: { racePassiveId } });
      if (result.launch.kind !== "character-creation") throw new Error("Changed launch kind");
      expect(Object.isFrozen(result.launch.creationPlan)).toBe(true);
    },
  );

  it.each(["", "_Passive", "1Passive", "Passive-name", "Passive name", "Passive\n", "é", "A".repeat(151), 123, null, {}])(
    "rejects an invalid race passive identifier %j", (value) => {
      const base = testCatalog.get("example.background-creation")!;
      if (base.launch.kind !== "character-creation") throw new Error("Missing creation fixture");
      const plan = base.launch.creationPlan;
      expect(() => createBg3TestScenarioCatalog({ harnessModUuid, protectedSaves: testProtectedSaves, allowedRuntimeSaveIds: [], runtimeFixtures: [], scenarios: [{
        ...base, savePolicy: "create-test-fixture", launch: { kind: "character-creation", creationPlan: { ...plan,
          raceUuid: "50b65fcf-0d00-4992-b8a8-de11a44eb1e7", racePassiveId: value as string } },
      }] })).toThrow("invalid creation plan");
    },
  );

  it("rejects a race passive without a race UUID", () => {
    const base = testCatalog.get("example.background-creation")!;
    if (base.launch.kind !== "character-creation") throw new Error("Missing creation fixture");
    const plan = base.launch.creationPlan;
    expect(() => createBg3TestScenarioCatalog({ harnessModUuid, protectedSaves: testProtectedSaves, allowedRuntimeSaveIds: [], runtimeFixtures: [], scenarios: [{
      ...base, savePolicy: "create-test-fixture", launch: { kind: "character-creation", creationPlan: { ...plan, racePassiveId: "Example_Race" } },
    }] })).toThrow("invalid creation plan");
  });

  it("derives runtime mode and the exact save from one launch fixture", () => {
    const catalog = createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture("second", "harness-second__AutoSave_0"),
      ],
      scenarios: [secondFixture],
    });
    const scenario = catalog.get("second.fixture");

    expect(scenario).toBeDefined();
    expect(scenarioMode(scenario!)).toBe("runtime");
    expect(scenarioSaveId(scenario!)).toBe(
      "harness-second__AutoSave_0",
    );
  });

  it.each(["ProtectedSave", "777", "777-1000000000__AutoSave_0"])(
    "refuses a protected runtime fixture named %s",
    (saveId) => {
      expect(() =>
        createBg3TestScenarioCatalog({
          harnessModUuid,
          protectedSaves: testProtectedSaves,
          allowedRuntimeSaveIds: [saveId],
          runtimeFixtures: [runtimeFixture("second", saveId)],
          scenarios: [secondFixture],
        }),
      ).toThrow(`Protected BG3 save cannot be a test fixture: ${saveId}`);
    },
  );

  it("shares an exact named fixture across independent scenarios", () => {
    const catalog = createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-fixture__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture(
          "baseline",
          "harness-fixture__AutoSave_0",
        ),
      ],
      scenarios: [
        { ...secondFixture, id: "core.runtime-smoke", launch: {
          kind: "runtime",
          fixtureId: "baseline",
        } },
        { ...secondFixture, id: "example.runtime-mechanic", launch: {
          kind: "runtime",
          fixtureId: "baseline",
        } },
      ],
    });

    expect(scenarioSaveId(catalog.get("core.runtime-smoke")!)).toBe(
      "harness-fixture__AutoSave_0",
    );
    expect(scenarioSaveId(catalog.get("example.runtime-mechanic")!)).toBe(
      "harness-fixture__AutoSave_0",
    );
  });

  it("rejects a safe-looking save that is absent from the exact allowlist", () => {
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-approved__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture("second", "harness-arbitrary__AutoSave_0"),
      ],
      scenarios: [secondFixture],
    })).toThrow(
      "BG3 runtime fixture save is not in the exact allowlist: harness-arbitrary__AutoSave_0",
    );
  });

  it.each(["protectedsave", "PROTECTEDSAVE", "777backup", "777_unsafe", "protectedsave.copy"])(
    "refuses protected save variant %s even if declared in the allowlist",
    (saveId) => {
      expect(() => createBg3TestScenarioCatalog({
        harnessModUuid,
        protectedSaves: testProtectedSaves,
        allowedRuntimeSaveIds: [saveId],
        runtimeFixtures: [runtimeFixture("second", saveId)],
        scenarios: [secondFixture],
      })).toThrow(`Protected BG3 save cannot be a test fixture: ${saveId}`);
    },
  );

  it("clones and freezes fixture, plan, and mod data", () => {
    const mutableRequiredMods: Bg3RequiredMods = {
      ordered: secondRequiredMods.ordered.map((mod) => ({ ...mod })),
      present: [],
    };
    const mutableFixture = runtimeFixture(
      "second",
      "harness-second__AutoSave_0",
      mutableRequiredMods,
    );
    const input: {
      allowedRuntimeSaveIds: string[];
      runtimeFixtures: Bg3RuntimeFixture[];
      scenarios: Bg3TestScenarioDefinition[];
    } = {
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [mutableFixture],
      scenarios: [secondFixture],
    };
    const catalog = createBg3TestScenarioCatalog({ harnessModUuid, protectedSaves: testProtectedSaves, ...input });
    mutableFixture.saveId = "ProtectedSave";
    mutableRequiredMods.ordered[0]!.uuid =
      "00000000-0000-0000-0000-000000000000";

    const scenario = catalog.get("second.fixture")!;
    expect(scenarioSaveId(scenario)).toBe("harness-second__AutoSave_0");
    expect(scenario.requiredMods.ordered[0]!.uuid).toBe(
      "0508cc3f-d202-4ae5-a927-7c837bd40de6",
    );
    expect(scenario.launch.kind).toBe("runtime");
    if (scenario.launch.kind !== "runtime") return;
    expect(scenario.requiredMods).toBe(scenario.launch.fixture.requiredMods);
    expect(() => {
      (scenario.launch as { kind: string }).kind = "character-creation";
    }).toThrow();
    expect(() => {
      (scenario.requiredMods.ordered as Bg3RequiredMod[])[0] = {
        name: "Mutated",
        uuid: "00000000-0000-0000-0000-000000000000",
      };
    }).toThrow();

    const creation = testCatalog.get(
      "example.background-creation",
    )!;
    expect(() => {
      if (creation.launch.kind === "character-creation") {
        (creation.launch.creationPlan as { backgroundName: string })
          .backgroundName = "Acolyte";
      }
    }).toThrow();
  });

  it("requires the harness mod before the owner mod in the fixture module chain", () => {
    const wrongOrder: Bg3RequiredMods = {
      ordered: [
        secondRequiredMods.ordered[0]!,
        secondRequiredMods.ordered[2]!,
        secondRequiredMods.ordered[1]!,
      ],
      present: [],
    };
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture(
          "second",
          "harness-second__AutoSave_0",
          wrongOrder,
        ),
      ],
      scenarios: [secondFixture],
    })).toThrow(
      "Scenario second.fixture must load the harness mod before its owner mod",
    );
  });

  it("accepts technical modules before the harness mod", () => {
    const catalog = createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [runtimeFixture(
        "second",
        "harness-second__AutoSave_0",
        {
          ordered: [
            {
              name: "Example UI Preload",
              uuid: "ef37de74-b87c-4253-a5d2-bfc81073960d",
            },
            secondRequiredMods.ordered[0]!,
            {
              name: "Example Intro Skip",
              uuid: "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c",
            },
            secondRequiredMods.ordered[1]!,
            secondRequiredMods.ordered[2]!,
          ],
          present: [],
        },
      )],
      scenarios: [secondFixture],
    });

    expect(catalog.get("second.fixture")?.requiredMods.ordered.map(
      (mod) => mod.name,
    )).toEqual([
      "Example UI Preload",
      "Example Rules Dependency",
      "Example Intro Skip",
      "BG3 In-Game Harness",
      "Example Content B",
    ]);
  });

  it("rejects an invalid expected fixture LSV SHA-256", () => {
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [{
        ...runtimeFixture("second", "harness-second__AutoSave_0"),
        expectedLsvSha256: "not-a-sha",
      }],
      scenarios: [secondFixture],
    })).toThrow(
      "BG3 runtime fixture has an invalid expected LSV SHA-256: second",
    );
  });

  it("requires the scenario owner in the fixture module chain", () => {
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture("second", "harness-second__AutoSave_0"),
      ],
      scenarios: [{
        ...secondFixture,
        ownerModUuid: "cd639062-7736-457d-aa6a-c364979b8921",
      }],
    })).toThrow(
      "Scenario second.fixture owner mod must be in requiredMods.ordered",
    );
  });

  it("only permits runtime scenarios with a never save policy", () => {
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture("second", "harness-second__AutoSave_0"),
      ],
      scenarios: [{
        ...secondFixture,
        savePolicy: "create-test-fixture",
      } as unknown as Bg3TestScenarioDefinition],
    })).toThrow("Scenario second.fixture runtime save policy must be never");
  });

  it("requires creation scenarios to create and validate a test fixture", () => {
    const creation = testCatalog.get(
      "example.background-creation",
    )!;
    const creationLaunch = creation.launch;
    expect(creationLaunch.kind).toBe("character-creation");
    if (creationLaunch.kind !== "character-creation") return;

    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: [],
      runtimeFixtures: [],
      scenarios: [{
        ...creation,
        savePolicy: "never",
        launch: {
          kind: "character-creation",
          creationPlan: creationLaunch.creationPlan,
        },
      } as unknown as Bg3TestScenarioDefinition],
    })).toThrow(
      "Scenario example.background-creation character-creation save policy must be create-test-fixture or discard-campaign",
    );
  });

  it("permits a creation scenario that discards its new campaign without saving", () => {
    const creation = testCatalog.get(
      "example.background-creation",
    )!;
    if (creation.launch.kind !== "character-creation") throw new Error("Missing creation scenario");
    const catalog = createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: [],
      runtimeFixtures: [],
      scenarios: [{
        ...creation,
        savePolicy: "discard-campaign",
        launch: { kind: "character-creation", creationPlan: creation.launch.creationPlan },
      }],
    });
    const scenario = catalog.get(creation.id)!;
    expect(scenario.savePolicy).toBe("discard-campaign");
    expect(scenarioMode(scenario)).toBe("character-creation");
    expect(scenarioSaveId(scenario)).toBe("__new_campaign__");
  });

  it("keeps the discard policy out of the runtime fixture lane", () => {
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture("second", "harness-second__AutoSave_0"),
      ],
      scenarios: [{
        ...secondFixture,
        savePolicy: "discard-campaign",
      } as unknown as Bg3TestScenarioDefinition],
    })).toThrow("Scenario second.fixture runtime save policy must be never");
  });

  it("bounds the required assertion list to the wire protocol limit", () => {
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture("second", "harness-second__AutoSave_0"),
      ],
      scenarios: [{
        ...secondFixture,
        requiredAssertionIds: Array.from(
          { length: 4_097 },
          (_, index) => `assertion-${index}`,
        ),
      }],
    })).toThrow("Scenario second.fixture requires too many assertions");
  });

  it("rejects duplicate required assertion identifiers", () => {
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture("second", "harness-second__AutoSave_0"),
      ],
      scenarios: [{
        ...secondFixture,
        requiredAssertionIds: ["second-ready", "second-ready"],
      }],
    })).toThrow(
      "Scenario second.fixture has an invalid required assertion ID",
    );
  });

  it("rejects whitespace-only mod and background names", () => {
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        runtimeFixture("second", "harness-second__AutoSave_0", {
          ordered: [
            { ...secondRequiredMods.ordered[0]!, name: "   " },
            ...secondRequiredMods.ordered.slice(1),
          ],
          present: [],
        }),
      ],
      scenarios: [secondFixture],
    })).toThrow("Scenario second.fixture has an invalid required mod");

    const creation = testCatalog.get(
      "example.background-creation",
    )!;
    expect(creation.launch.kind).toBe("character-creation");
    if (creation.launch.kind !== "character-creation") return;
    const creationPlan = creation.launch.creationPlan;
    expect(() => createBg3TestScenarioCatalog({
      harnessModUuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: [],
      runtimeFixtures: [],
      scenarios: [{
        id: "creation.blank-name",
        ownerModUuid: creation.ownerModUuid,
        savePolicy: "create-test-fixture",
        timeoutMs: creation.timeoutMs,
        requiredAssertionIds: creation.requiredAssertionIds,
        requiredMods: creation.requiredMods,
        launch: {
          kind: "character-creation",
          creationPlan: {
            ...creationPlan,
            backgroundName: "   ",
          },
        },
      }],
    })).toThrow("Scenario creation.blank-name has an invalid creation plan");
  });
});
