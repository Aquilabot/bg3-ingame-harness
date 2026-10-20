import {
  BG3_NEW_CAMPAIGN_SAVE_ID,
  type Bg3TestMode,
} from "./protocol.js";


export interface Bg3RequiredMod {
  name: string;
  uuid: string;
}

export interface Bg3RequiredMods {
  ordered: readonly Bg3RequiredMod[];
  present: readonly Bg3RequiredMod[];
}

// Each policy belongs to one launch kind. Runtime never saves its fixed fixture.
// A new campaign either creates one test fixture save or is discarded unsaved.
export type Bg3TestSavePolicy = "never" | "create-test-fixture" | "discard-campaign";
export type Bg3CreationSavePolicy = Exclude<Bg3TestSavePolicy, "never">;

export function isBg3CreationSavePolicy(value: unknown): value is Bg3CreationSavePolicy {
  return value === "create-test-fixture" || value === "discard-campaign";
}

export type Bg3CharacterCreationPlan = {
  kind: "background";
  backgroundUuid: string;
  backgroundName: string;
  requiredTransitionModUuid: string;
  classUuid?: string;
  raceUuid?: string;
  subRaceUuid?: string;
  racePassiveId?: string;
};

export interface Bg3RuntimeFixture {
  id: string;
  saveId: string;
  expectedLsvSha256: string;
  requiredMods: Bg3RequiredMods;
}

export type Bg3TestLaunch =
  | {
      kind: "runtime";
      fixture: Bg3RuntimeFixture;
    }
  | {
      kind: "character-creation";
      creationPlan: Bg3CharacterCreationPlan;
    };

/**
 * Authorizes native pointer input for one runtime scenario. The client asks for
 * one hover/leave pair per step, in order: step N uses sequence N. A later step
 * may only start after the previous pair completed on the same caster and target.
 */
export interface Bg3PointerPolicy {
  operation: string;
  spellId: string;
  steps: readonly string[];
}

interface Bg3TestScenarioBase {
  id: string;
  ownerModUuid: string;
  timeoutMs: number;
  requiredMods: Bg3RequiredMods;
  requiredAssertionIds: readonly string[];
  pointer?: Bg3PointerPolicy;
}

interface Bg3TestScenarioDefinitionBase {
  id: string;
  ownerModUuid: string;
  timeoutMs: number;
  requiredAssertionIds: readonly string[];
  pointer?: Bg3PointerPolicy;
}

export type Bg3TestScenario = Bg3TestScenarioBase & (
  | {
      savePolicy: "never";
      launch: Extract<Bg3TestLaunch, { kind: "runtime" }>;
    }
  | {
      savePolicy: Bg3CreationSavePolicy;
      launch: Extract<Bg3TestLaunch, { kind: "character-creation" }>;
    }
);

export type Bg3TestScenarioDefinition = Bg3TestScenarioDefinitionBase & (
  | {
      savePolicy: "never";
      launch: { kind: "runtime"; fixtureId: string };
    }
  | {
      savePolicy: Bg3CreationSavePolicy;
      requiredMods: Bg3RequiredMods;
      launch: {
        kind: "character-creation";
        creationPlan: Bg3CharacterCreationPlan;
      };
    }
);

/**
 * Saves that must never be used as fixtures, compared case-insensitively.
 * An ID matches when it equals an entry of `ids` or starts with `<id>.`,
 * `<id>_` or `<id>-`, or when it starts with an entry of `prefixes`.
 */
export interface Bg3ProtectedSaves {
  ids: readonly string[];
  prefixes: readonly string[];
}

export function isProtectedBg3SaveId(saveId: string, protectedSaves: Bg3ProtectedSaves): boolean {
  const normalized = saveId.toLowerCase();
  return protectedSaves.ids.some((id) => {
    const protectedId = id.toLowerCase();
    return normalized === protectedId
      || (normalized.startsWith(protectedId) && /^[._-]/.test(normalized.slice(protectedId.length)));
  }) || protectedSaves.prefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

export interface Bg3TestScenarioCatalogDefinition {
  /** UUID of the harness runtime mod. Every scenario must load it before its owner mod. */
  harnessModUuid: string;
  protectedSaves?: Bg3ProtectedSaves;
  allowedRuntimeSaveIds: readonly string[];
  runtimeFixtures: readonly Bg3RuntimeFixture[];
  scenarios: readonly Bg3TestScenarioDefinition[];
}

export interface Bg3TestScenarioCatalog {
  get(scenarioId: string): Bg3TestScenario | undefined;
}

export function isValidBg3RacePassiveId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 150 &&
    /^[A-Za-z]/.test(value) && !/[^A-Za-z0-9_]/.test(value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_SCENARIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SAFE_SAVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function validateMod(mod: Bg3RequiredMod, scenarioId: string): void {
  if (
    mod.name.trim() === "" ||
    mod.name.length > 200 ||
    !UUID_PATTERN.test(mod.uuid)
  ) {
    throw new Error(`Scenario ${scenarioId} has an invalid required mod`);
  }
}

function validateScenario(
  scenario: Bg3TestScenario,
  harnessModUuid: string,
  protectedSaves: Bg3ProtectedSaves,
): void {
  const launchKind: string = scenario.launch.kind;
  const savePolicy: string = scenario.savePolicy;
  if (!SAFE_SCENARIO_ID_PATTERN.test(scenario.id)) {
    throw new Error(`Unsafe BG3 test scenario ID: ${scenario.id}`);
  }
  if (
    !Number.isSafeInteger(scenario.timeoutMs) ||
    scenario.timeoutMs < 1_000 ||
    scenario.timeoutMs > 1_800_000
  ) {
    throw new Error(
      `Scenario ${scenario.id} timeout must be between 1000 and 1800000 ms`,
    );
  }

  const requiredUuids = new Set<string>();
  for (const mod of [
    ...scenario.requiredMods.ordered,
    ...scenario.requiredMods.present,
  ]) {
    validateMod(mod, scenario.id);
    const uuid = mod.uuid.toLowerCase();
    if (requiredUuids.has(uuid)) {
      throw new Error(
        `Scenario ${scenario.id} repeats required mod ${mod.uuid}`,
      );
    }
    requiredUuids.add(uuid);
  }
  const orderedIndex = (uuid: string) => scenario.requiredMods.ordered.findIndex((mod) =>
    mod.uuid.toLowerCase() === uuid.toLowerCase()
  );
  const harnessIndex = orderedIndex(harnessModUuid);
  const ownerIndex = orderedIndex(scenario.ownerModUuid);
  if (harnessIndex < 0 || (ownerIndex >= 0 && ownerIndex < harnessIndex)) {
    throw new Error(
      `Scenario ${scenario.id} must load the harness mod before its owner mod`,
    );
  }
  if (
    scenario.requiredMods.ordered.length > 64 ||
    scenario.requiredMods.present.length > 64
  ) {
    throw new Error(`Scenario ${scenario.id} requires too many mods`);
  }
  if (!UUID_PATTERN.test(scenario.ownerModUuid)) {
    throw new Error(`Scenario ${scenario.id} has an invalid owner mod UUID`);
  }
  const orderedUuids = new Set(
    scenario.requiredMods.ordered.map((mod) => mod.uuid.toLowerCase()),
  );
  if (!orderedUuids.has(scenario.ownerModUuid.toLowerCase())) {
    throw new Error(
      `Scenario ${scenario.id} owner mod must be in requiredMods.ordered`,
    );
  }
  if (savePolicy !== "never" && !isBg3CreationSavePolicy(savePolicy)) {
    throw new Error(`Scenario ${scenario.id} has an invalid save policy`);
  }
  if (
    launchKind === "runtime" &&
    savePolicy !== "never"
  ) {
    throw new Error(`Scenario ${scenario.id} runtime save policy must be never`);
  }
  if (
    launchKind === "character-creation" &&
    !isBg3CreationSavePolicy(savePolicy)
  ) {
    throw new Error(
      `Scenario ${scenario.id} character-creation save policy must be create-test-fixture or discard-campaign`,
    );
  }
  if (scenario.requiredAssertionIds.length > 4_096) {
    throw new Error(`Scenario ${scenario.id} requires too many assertions`);
  }
  const assertionIds = new Set<string>();
  for (const assertionId of scenario.requiredAssertionIds) {
    if (
      typeof assertionId !== "string" ||
      assertionId.trim() === "" ||
      assertionId.length > 100 ||
      assertionIds.has(assertionId)
    ) {
      throw new Error(
        `Scenario ${scenario.id} has an invalid required assertion ID`,
      );
    }
    assertionIds.add(assertionId);
  }
  if (assertionIds.size === 0) {
    throw new Error(`Scenario ${scenario.id} requires at least one assertion`);
  }

  if (scenario.launch.kind === "runtime") {
    const { saveId } = scenario.launch.fixture;
    if (isProtectedBg3SaveId(saveId, protectedSaves)) {
      throw new Error(`Protected BG3 save cannot be a test fixture: ${saveId}`);
    }
    if (!SAFE_SAVE_ID_PATTERN.test(saveId)) {
      throw new Error(`Unsafe BG3 test fixture save ID: ${saveId}`);
    }
    return;
  }

  const plan = scenario.launch.creationPlan;
  if (
    plan.kind !== "background" ||
    plan.backgroundName.trim() === "" ||
    plan.backgroundName.length > 200 ||
    !UUID_PATTERN.test(plan.backgroundUuid) ||
    !UUID_PATTERN.test(plan.requiredTransitionModUuid) ||
    (plan.classUuid !== undefined && !UUID_PATTERN.test(plan.classUuid)) ||
    (plan.raceUuid !== undefined && !UUID_PATTERN.test(plan.raceUuid)) ||
    (plan.subRaceUuid !== undefined &&
      (plan.raceUuid === undefined || !UUID_PATTERN.test(plan.subRaceUuid))) ||
    (plan.racePassiveId !== undefined &&
      (plan.raceUuid === undefined || !isValidBg3RacePassiveId(plan.racePassiveId)))
  ) {
    throw new Error(`Scenario ${scenario.id} has an invalid creation plan`);
  }
  const requiredModUuids = new Set(
    [
      ...scenario.requiredMods.ordered,
      ...scenario.requiredMods.present,
    ].map((mod) => mod.uuid.toLowerCase()),
  );
  if (!requiredModUuids.has(plan.requiredTransitionModUuid.toLowerCase())) {
    throw new Error(
      `Scenario ${scenario.id} creation transition mod must be required`,
    );
  }
}

function freezeRequiredMods(requiredMods: Bg3RequiredMods): Bg3RequiredMods {
  return Object.freeze({
    ordered: Object.freeze(requiredMods.ordered.map((mod) =>
      Object.freeze({ ...mod })
    )),
    present: Object.freeze(requiredMods.present.map((mod) =>
      Object.freeze({ ...mod })
    )),
  });
}

function freezePointer(pointer: Bg3PointerPolicy): Bg3PointerPolicy {
  return Object.freeze({ ...pointer, steps: Object.freeze([...pointer.steps]) });
}

const POINTER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const POINTER_SPELL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,199}$/;
const POINTER_OPERATIONS = new Set([
  "preview-target", "cast-target", "cast-selected-target", "inspect-target-validation",
]);

function validatePointer(scenario: Bg3TestScenario): void {
  const pointer = scenario.pointer;
  if (pointer === undefined) return;
  if (scenario.launch.kind !== "runtime") {
    throw new Error(`Scenario ${scenario.id} pointer input requires a runtime scenario`);
  }
  if (
    !POINTER_OPERATIONS.has(pointer.operation) ||
    !POINTER_SPELL_PATTERN.test(pointer.spellId) ||
    pointer.steps.length < 1 || pointer.steps.length > 8 ||
    new Set(pointer.steps).size !== pointer.steps.length ||
    !pointer.steps.every((step) => POINTER_IDENTIFIER_PATTERN.test(step))
  ) {
    throw new Error(`Scenario ${scenario.id} has an invalid pointer policy`);
  }
}

export function createBg3TestScenarioCatalog(
  definition: Bg3TestScenarioCatalogDefinition,
): Bg3TestScenarioCatalog {
  if (!UUID_PATTERN.test(definition.harnessModUuid)) {
    throw new Error("BG3 scenario catalog has an invalid harness mod UUID");
  }
  const protectedSaves = definition.protectedSaves ?? { ids: [], prefixes: [] };
  const allowedRuntimeSaveIds = new Set(definition.allowedRuntimeSaveIds);
  const fixtures = new Map<string, Bg3RuntimeFixture>();
  for (const inputFixture of definition.runtimeFixtures) {
    const fixture = Object.freeze({
      ...inputFixture,
      requiredMods: freezeRequiredMods(inputFixture.requiredMods),
    });
    if (!SAFE_SCENARIO_ID_PATTERN.test(fixture.id)) {
      throw new Error(`Unsafe BG3 runtime fixture ID: ${fixture.id}`);
    }
    if (isProtectedBg3SaveId(fixture.saveId, protectedSaves)) {
      throw new Error(
        `Protected BG3 save cannot be a test fixture: ${fixture.saveId}`,
      );
    }
    if (!SAFE_SAVE_ID_PATTERN.test(fixture.saveId)) {
      throw new Error(`Unsafe BG3 test fixture save ID: ${fixture.saveId}`);
    }
    if (!SHA256_PATTERN.test(fixture.expectedLsvSha256)) {
      throw new Error(
        `BG3 runtime fixture has an invalid expected LSV SHA-256: ${fixture.id}`,
      );
    }
    if (!allowedRuntimeSaveIds.has(fixture.saveId)) {
      throw new Error(
        `BG3 runtime fixture save is not in the exact allowlist: ${fixture.saveId}`,
      );
    }
    if (fixtures.has(fixture.id)) {
      throw new Error(`Duplicate BG3 runtime fixture: ${fixture.id}`);
    }
    fixtures.set(fixture.id, fixture);
  }

  const byId = new Map<string, Bg3TestScenario>();
  for (const candidate of definition.scenarios) {
    const candidateLaunchKind: string = candidate.launch.kind;
    const candidateSavePolicy: string = candidate.savePolicy;
    if (
      candidateLaunchKind === "runtime" &&
      candidateSavePolicy !== "never"
    ) {
      throw new Error(
        `Scenario ${candidate.id} runtime save policy must be never`,
      );
    }
    if (
      candidateLaunchKind === "character-creation" &&
      !isBg3CreationSavePolicy(candidateSavePolicy)
    ) {
      throw new Error(
        `Scenario ${candidate.id} character-creation save policy must be create-test-fixture or discard-campaign`,
      );
    }
    const requiredAssertionIds = Object.freeze([
      ...candidate.requiredAssertionIds,
    ]);
    let scenario: Bg3TestScenario;
    if (candidate.savePolicy === "never") {
      const fixture = fixtures.get(candidate.launch.fixtureId);
      if (fixture === undefined) {
        throw new Error(
          `Scenario ${candidate.id} references unknown runtime fixture ${candidate.launch.fixtureId}`,
        );
      }
      const requiredMods = fixture.requiredMods;
      scenario = Object.freeze({
        id: candidate.id,
        ownerModUuid: candidate.ownerModUuid,
        savePolicy: candidate.savePolicy,
        timeoutMs: candidate.timeoutMs,
        requiredMods,
        requiredAssertionIds,
        launch: Object.freeze({ kind: "runtime", fixture }),
        ...(candidate.pointer === undefined ? {} : { pointer: freezePointer(candidate.pointer) }),
      });
    } else {
      const requiredMods = freezeRequiredMods(candidate.requiredMods);
      scenario = Object.freeze({
        id: candidate.id,
        ownerModUuid: candidate.ownerModUuid,
        savePolicy: candidate.savePolicy,
        timeoutMs: candidate.timeoutMs,
        requiredMods,
        requiredAssertionIds,
        launch: Object.freeze({
          kind: "character-creation",
          creationPlan: Object.freeze({ ...candidate.launch.creationPlan }),
        }),
        ...(candidate.pointer === undefined ? {} : { pointer: freezePointer(candidate.pointer) }),
      });
    }
    validateScenario(scenario, definition.harnessModUuid, protectedSaves);
    validatePointer(scenario);
    if (byId.has(scenario.id)) {
      throw new Error(`Duplicate BG3 test scenario: ${scenario.id}`);
    }
    byId.set(scenario.id, scenario);
  }
  return Object.freeze({ get: (scenarioId: string) => byId.get(scenarioId) });
}

export function scenarioMode(scenario: Bg3TestScenario): Bg3TestMode {
  return scenario.launch.kind;
}

export function scenarioSaveId(scenario: Bg3TestScenario): string {
  return scenario.launch.kind === "runtime"
    ? scenario.launch.fixture.saveId
    : BG3_NEW_CAMPAIGN_SAVE_ID;
}

