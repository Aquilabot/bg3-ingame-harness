// Shared, neutral test data: a harness mod, an example content mod and three
// stand-in dependencies. None of these UUIDs belong to a published mod.
import type { Bg3ModSettingsEntry } from "../src/mod-settings.js";
import type { NodeBg3TestPlatformOptions } from "../src/node-platform.js";
import {
  createBg3TestScenarioCatalog,
  type Bg3ProtectedSaves,
  type Bg3TestScenarioCatalogDefinition,
} from "../src/scenario-catalog.js";

export const harnessMod = { name: "BG3 In-Game Harness", uuid: "41d551b8-e0c1-4c12-8a29-1be03b5f9054" } as const;
export const exampleMod = { name: "Harness Example", uuid: "cd639062-7736-457d-aa6a-c364979b8921" } as const;
export const contentBMod = { name: "Example Content B", uuid: "7f712806-3674-421f-8e7b-dca469e545f5" } as const;
export const rulesMod = { name: "Example Rules Dependency", uuid: "0508cc3f-d202-4ae5-a927-7c837bd40de6" } as const;
export const uiPreloadMod = { name: "Example UI Preload", uuid: "ef37de74-b87c-4253-a5d2-bfc81073960d" } as const;
export const introSkipMod = { name: "Example Intro Skip", uuid: "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c" } as const;

export const FIXTURE_SAVE_ID = "harness-fixture__AutoSave_0";
export const FIXTURE_LSV_SHA256 = "5f2b1c0e9d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c";

export const testProtectedSaves: Bg3ProtectedSaves = { ids: ["ProtectedSave"], prefixes: ["777"] };

export const creationMods = { ordered: [uiPreloadMod, rulesMod, introSkipMod, harnessMod, exampleMod], present: [] };

export const testCatalogDefinition: Bg3TestScenarioCatalogDefinition = {
  harnessModUuid: harnessMod.uuid,
  protectedSaves: testProtectedSaves,
  allowedRuntimeSaveIds: [FIXTURE_SAVE_ID],
  runtimeFixtures: [{
    id: "baseline",
    saveId: FIXTURE_SAVE_ID,
    expectedLsvSha256: FIXTURE_LSV_SHA256,
    requiredMods: {
      ordered: [uiPreloadMod, rulesMod, introSkipMod, harnessMod, exampleMod, contentBMod],
      present: [],
    },
  }],
  scenarios: [
    {
      id: "core.runtime-smoke",
      ownerModUuid: harnessMod.uuid,
      savePolicy: "never",
      timeoutMs: 360_000,
      launch: { kind: "runtime", fixtureId: "baseline" },
      requiredAssertionIds: ["host-entity", "host-party-member"],
    },
    {
      id: "example.runtime-mechanic",
      ownerModUuid: exampleMod.uuid,
      savePolicy: "never",
      timeoutMs: 360_000,
      launch: { kind: "runtime", fixtureId: "baseline" },
      requiredAssertionIds: [
        "fixture-feature-origin", "fixture-features-ready", "fixture-gameplay-ready",
        "mechanic-cost", "mechanic-effect", "mechanic-cleanup",
      ],
    },
    {
      id: "example.background-creation",
      ownerModUuid: exampleMod.uuid,
      savePolicy: "create-test-fixture",
      timeoutMs: 600_000,
      launch: {
        kind: "character-creation",
        creationPlan: {
          kind: "background",
          backgroundUuid: "56c19b4a-f7b7-4aba-ba1f-0ade44a98560",
          backgroundName: "Example Background",
          requiredTransitionModUuid: introSkipMod.uuid,
        },
      },
      requiredMods: creationMods,
      requiredAssertionIds: [
        "character-creation-started", "character-selected-for-user", "character-creation-finished",
        "creation-profile-recorded", "selected-avatar-is-host", "host-profile-recorded",
        "creation-profile-matches", "host-is-player", "world-region",
        "example-background-background",
        "example-background-passive-HarnessExample_PassiveA",
        "example-background-passive-HarnessExample_PassiveB",
        "example-background-passive-HarnessExample_SkillSelection",
        "runtime-mechanic-spell",
      ],
    },
    {
      id: "example.species-creation-control",
      ownerModUuid: exampleMod.uuid,
      savePolicy: "create-test-fixture",
      timeoutMs: 600_000,
      launch: {
        kind: "character-creation",
        creationPlan: {
          kind: "background",
          backgroundUuid: "d77456ba-31be-461c-8843-00dbd4ffaf84",
          backgroundName: "Example Species Background",
          requiredTransitionModUuid: introSkipMod.uuid,
          raceUuid: "ce4b7923-bcdd-495c-b2e5-3810bf6dd9b5",
          subRaceUuid: "5a076d0b-9b01-4edd-bafe-1d4469eacfdd",
        },
      },
      requiredMods: creationMods,
      requiredAssertionIds: [
        "character-creation-started", "character-selected-for-user", "character-creation-finished",
        "creation-profile-recorded", "selected-avatar-is-host", "host-profile-recorded",
        "creation-profile-matches", "host-is-player", "world-region", "species-control-background",
        "species-control-skill-selector", "species-control-feat-selector",
        "created-species-race", "created-species-subrace",
      ],
    },
  ],
};

export const testCatalog = createBg3TestScenarioCatalog(testCatalogDefinition);

function entry(folderName: string, mod: { name: string; uuid: string }, md5: string, publishHandle: string, version64: string): Bg3ModSettingsEntry {
  return {
    folder: `${folderName}_${mod.uuid}`, md5, name: mod.name, packageFile: `${folderName}.pak`,
    publishHandle, uuid: mod.uuid, version64,
  };
}

export const testModSettingsEntries: readonly Bg3ModSettingsEntry[] = [
  entry("ExampleUiPreload", uiPreloadMod, "0123456789abcdef0123456789abcdef", "1000001", "72198331526283346"),
  entry("ExampleRules", rulesMod, "fedcba9876543210fedcba9876543210", "1000002", "145804076590825474"),
  entry("BG3InGameHarness", harnessMod, "", "0", "36028797018963968"),
  entry("HarnessExample", exampleMod, "", "0", "36028797018963969"),
  entry("ExampleContentB", contentBMod, "", "0", "36028797018963968"),
  entry("ExampleIntroSkip", introSkipMod, "00112233445566778899aabbccddeeff", "1000003", "36028799166447619"),
];

export const testPreloadModuleUuids: readonly string[] = [uiPreloadMod.uuid];

/** The platform options every test shares; spread first, then override. */
export const testPlatformOptions: NodeBg3TestPlatformOptions = {
  catalog: testCatalog,
  modSettings: { entries: testModSettingsEntries, preloadModuleUuids: testPreloadModuleUuids },
  protectedSaves: testProtectedSaves,
};
