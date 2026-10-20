import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Bg3ModDiagnosticsSource } from "./engine-logs.js";
import type { Bg3ModSettingsEntry } from "./mod-settings.js";
import type {
  Bg3ProtectedSaves,
  Bg3RuntimeFixture,
  Bg3TestScenarioCatalogDefinition,
  Bg3TestScenarioDefinition,
} from "./scenario-catalog.js";

/** UUID of the harness runtime mod shipped in `mod/`. */
export const BG3_HARNESS_MOD_UUID = "41d551b8-e0c1-4c12-8a29-1be03b5f9054";
export const BG3_HARNESS_CONFIG_FILE = "harness.config.json";

/**
 * Everything machine- or project-specific the runner needs. Nothing here is
 * read from the game; the file is written by the person who owns the fixtures.
 */
export interface Bg3HarnessConfig {
  catalog: Bg3TestScenarioCatalogDefinition;
  modSettings: {
    entries: readonly Bg3ModSettingsEntry[];
    preloadModuleUuids: readonly string[];
  };
  protectedSaves: Bg3ProtectedSaves;
  modDiagnostics: readonly Bg3ModDiagnosticsSource[];
  steamRoot?: string;
  workRoot: string;
}

export class Bg3HarnessConfigError extends Error {
  override readonly name = "Bg3HarnessConfigError";
}

type Json = Record<string, unknown>;

function fail(message: string): never {
  throw new Bg3HarnessConfigError(`Invalid harness config: ${message}`);
}

function object(value: unknown, label: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Json;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function optionalArray(value: unknown, label: string): unknown[] {
  return value === undefined ? [] : array(value, label);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  return optionalArray(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function onlyKeys(value: Json, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail(`${label} has unsupported fields: ${unknown.join(", ")}`);
}

function requiredMods(value: unknown, label: string) {
  const mods = object(value, label);
  onlyKeys(mods, ["ordered", "present"], label);
  const list = (key: "ordered" | "present") => optionalArray(mods[key], `${label}.${key}`).map((item, index) => {
    const mod = object(item, `${label}.${key}[${index}]`);
    onlyKeys(mod, ["name", "uuid"], `${label}.${key}[${index}]`);
    return { name: string(mod.name, `${label}.${key}[${index}].name`), uuid: string(mod.uuid, `${label}.${key}[${index}].uuid`) };
  });
  return { ordered: list("ordered"), present: list("present") };
}

function modEntry(value: unknown, index: number): Bg3ModSettingsEntry {
  const label = `mods[${index}]`;
  const entry = object(value, label);
  const keys = ["folder", "md5", "name", "packageFile", "publishHandle", "uuid", "version64"] as const;
  onlyKeys(entry, keys, label);
  const [folder, md5, name, packageFile, publishHandle, uuid, version64] = keys.map((key) => string(entry[key], `${label}.${key}`));
  return { folder: folder!, md5: md5!, name: name!, packageFile: packageFile!, publishHandle: publishHandle!, uuid: uuid!, version64: version64! };
}

function fixture(value: unknown, index: number): Bg3RuntimeFixture {
  const label = `runtimeFixtures[${index}]`;
  const item = object(value, label);
  onlyKeys(item, ["id", "saveId", "expectedLsvSha256", "requiredMods"], label);
  return {
    id: string(item.id, `${label}.id`),
    saveId: string(item.saveId, `${label}.saveId`),
    expectedLsvSha256: string(item.expectedLsvSha256, `${label}.expectedLsvSha256`),
    requiredMods: requiredMods(item.requiredMods, `${label}.requiredMods`),
  };
}

function scenario(value: unknown, index: number): Bg3TestScenarioDefinition {
  const label = `scenarios[${index}]`;
  const item = object(value, label);
  onlyKeys(item, ["id", "ownerModUuid", "timeoutMs", "savePolicy", "requiredAssertionIds", "launch", "requiredMods", "pointer"], label);
  const launch = object(item.launch, `${label}.launch`);
  if (typeof item.timeoutMs !== "number") fail(`${label}.timeoutMs must be a number`);
  const base = {
    id: string(item.id, `${label}.id`),
    ownerModUuid: string(item.ownerModUuid, `${label}.ownerModUuid`),
    timeoutMs: item.timeoutMs,
    requiredAssertionIds: strings(item.requiredAssertionIds, `${label}.requiredAssertionIds`),
  };
  const pointer = item.pointer === undefined ? {} : (() => {
    const policy = object(item.pointer, `${label}.pointer`);
    onlyKeys(policy, ["operation", "spellId", "steps"], `${label}.pointer`);
    return { pointer: {
      operation: string(policy.operation, `${label}.pointer.operation`),
      spellId: string(policy.spellId, `${label}.pointer.spellId`),
      steps: strings(policy.steps, `${label}.pointer.steps`),
    } };
  })();
  if (launch.kind === "runtime") {
    onlyKeys(launch, ["kind", "fixtureId"], `${label}.launch`);
    if (item.savePolicy !== "never") fail(`${label} runtime scenarios must use savePolicy "never"`);
    if (item.requiredMods !== undefined) fail(`${label} runtime scenarios take their mods from the fixture`);
    return { ...base, ...pointer, savePolicy: "never", launch: { kind: "runtime", fixtureId: string(launch.fixtureId, `${label}.launch.fixtureId`) } };
  }
  if (launch.kind === "character-creation") {
    onlyKeys(launch, ["kind", "creationPlan"], `${label}.launch`);
    if (item.savePolicy !== "create-test-fixture" && item.savePolicy !== "discard-campaign") {
      fail(`${label} character-creation scenarios must use savePolicy "create-test-fixture" or "discard-campaign"`);
    }
    const plan = object(launch.creationPlan, `${label}.launch.creationPlan`);
    onlyKeys(plan, ["kind", "backgroundUuid", "backgroundName", "requiredTransitionModUuid", "classUuid", "raceUuid", "subRaceUuid", "racePassiveId"], `${label}.launch.creationPlan`);
    if (plan.kind !== "background") fail(`${label}.launch.creationPlan.kind must be "background"`);
    const optional = (key: "classUuid" | "raceUuid" | "subRaceUuid" | "racePassiveId") =>
      plan[key] === undefined ? {} : { [key]: string(plan[key], `${label}.launch.creationPlan.${key}`) };
    return {
      ...base,
      ...pointer,
      savePolicy: item.savePolicy,
      requiredMods: requiredMods(item.requiredMods, `${label}.requiredMods`),
      launch: {
        kind: "character-creation",
        creationPlan: {
          kind: "background",
          backgroundUuid: string(plan.backgroundUuid, `${label}.launch.creationPlan.backgroundUuid`),
          backgroundName: string(plan.backgroundName, `${label}.launch.creationPlan.backgroundName`),
          requiredTransitionModUuid: string(plan.requiredTransitionModUuid, `${label}.launch.creationPlan.requiredTransitionModUuid`),
          ...optional("classUuid"), ...optional("raceUuid"), ...optional("subRaceUuid"), ...optional("racePassiveId"),
        },
      },
    };
  }
  return fail(`${label}.launch.kind must be "runtime" or "character-creation"`);
}

/** Validates the shape of a parsed config. The catalog itself is validated when it is built. */
export function parseHarnessConfig(value: unknown, workRoot: string, environment: NodeJS.ProcessEnv = {}): Bg3HarnessConfig {
  const root = object(value, "config");
  onlyKeys(root, [
    "$schema", "harnessModUuid", "steamRoot", "protectedSaves", "mods", "preloadModuleUuids",
    "modDiagnostics", "allowedRuntimeSaveIds", "runtimeFixtures", "scenarios",
  ], "config");
  const protectedSaves = root.protectedSaves === undefined ? { ids: [], prefixes: [] } : (() => {
    const saves = object(root.protectedSaves, "protectedSaves");
    onlyKeys(saves, ["ids", "prefixes"], "protectedSaves");
    return { ids: strings(saves.ids, "protectedSaves.ids"), prefixes: strings(saves.prefixes, "protectedSaves.prefixes") };
  })();
  const modDiagnostics = optionalArray(root.modDiagnostics, "modDiagnostics").map((item, index) => {
    const source = object(item, `modDiagnostics[${index}]`);
    onlyKeys(source, ["directory", "pattern"], `modDiagnostics[${index}]`);
    let pattern: RegExp;
    try {
      pattern = new RegExp(string(source.pattern, `modDiagnostics[${index}].pattern`));
    } catch (error) {
      if (error instanceof Bg3HarnessConfigError) throw error;
      return fail(`modDiagnostics[${index}].pattern is not a valid regular expression`);
    }
    return { directory: string(source.directory, `modDiagnostics[${index}].directory`), pattern };
  });
  const steamRoot = environment.BG3_HARNESS_STEAM_ROOT
    ?? (root.steamRoot === undefined ? undefined : string(root.steamRoot, "steamRoot"));
  return {
    catalog: {
      harnessModUuid: root.harnessModUuid === undefined ? BG3_HARNESS_MOD_UUID : string(root.harnessModUuid, "harnessModUuid"),
      protectedSaves,
      allowedRuntimeSaveIds: strings(root.allowedRuntimeSaveIds, "allowedRuntimeSaveIds"),
      runtimeFixtures: optionalArray(root.runtimeFixtures, "runtimeFixtures").map(fixture),
      scenarios: optionalArray(root.scenarios, "scenarios").map(scenario),
    },
    modSettings: {
      entries: optionalArray(root.mods, "mods").map(modEntry),
      preloadModuleUuids: strings(root.preloadModuleUuids, "preloadModuleUuids"),
    },
    protectedSaves,
    modDiagnostics,
    ...(steamRoot === undefined ? {} : { steamRoot }),
    workRoot,
  };
}

/**
 * Reads `BG3_HARNESS_CONFIG`, or `harness.config.json` in the working
 * directory. `BG3_HARNESS_WORK_DIR` moves `.cache/` (default: working directory).
 */
export async function loadHarnessConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<Bg3HarnessConfig> {
  const configPath = path.resolve(cwd, environment.BG3_HARNESS_CONFIG ?? BG3_HARNESS_CONFIG_FILE);
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Bg3HarnessConfigError(`Cannot read harness config ${configPath}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Bg3HarnessConfigError(`Harness config is not JSON: ${configPath}`, { cause: error });
  }
  const workRoot = path.resolve(cwd, environment.BG3_HARNESS_WORK_DIR ?? ".");
  return parseHarnessConfig(value, workRoot, environment);
}
