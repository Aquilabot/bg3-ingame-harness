import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BG3_HARNESS_MOD_UUID, loadHarnessConfig, parseHarnessConfig } from "../src/config.js";
import { createBg3TestScenarioCatalog, isProtectedBg3SaveId } from "../src/scenario-catalog.js";
import { harnessMod, testModSettingsEntries } from "./fixtures.js";

const example = JSON.parse(await (await import("node:fs/promises")).readFile(
  path.resolve("examples/runtime-smoke/harness.config.example.json"), "utf8",
)) as unknown;

function minimal(overrides: Record<string, unknown> = {}) {
  return {
    allowedRuntimeSaveIds: ["harness-fixture__AutoSave_0"],
    runtimeFixtures: [{
      id: "baseline",
      saveId: "harness-fixture__AutoSave_0",
      expectedLsvSha256: "0".repeat(64),
      requiredMods: { ordered: [harnessMod], present: [] },
    }],
    scenarios: [{
      id: "example.runtime-smoke",
      ownerModUuid: harnessMod.uuid,
      savePolicy: "never",
      timeoutMs: 120_000,
      launch: { kind: "runtime", fixtureId: "baseline" },
      requiredAssertionIds: ["host-entity"],
    }],
    ...overrides,
  };
}

describe("harness config", () => {
  it("parses the shipped example into a valid catalog", () => {
    const config = parseHarnessConfig(example, "/work");
    const catalog = createBg3TestScenarioCatalog(config.catalog);
    expect(catalog.get("example.runtime-smoke")?.launch.kind).toBe("runtime");
    expect(config.workRoot).toBe("/work");
  });

  it("defaults the harness mod UUID and empty optional sections", () => {
    const config = parseHarnessConfig(minimal(), "/work");
    expect(config.catalog.harnessModUuid).toBe(BG3_HARNESS_MOD_UUID);
    expect(config.protectedSaves).toEqual({ ids: [], prefixes: [] });
    expect(config.modSettings).toEqual({ entries: [], preloadModuleUuids: [] });
    expect(config.modDiagnostics).toEqual([]);
    expect(config.steamRoot).toBeUndefined();
  });

  it("lets BG3_HARNESS_STEAM_ROOT override the configured Steam root", () => {
    const config = parseHarnessConfig(minimal({ steamRoot: "/from/config" }), "/work", { BG3_HARNESS_STEAM_ROOT: "/from/env" });
    expect(config.steamRoot).toBe("/from/env");
  });

  it("keeps mod entries and compiles diagnostic patterns", () => {
    const config = parseHarnessConfig(minimal({
      mods: testModSettingsEntries,
      modDiagnostics: [{ directory: "ExampleMod", pattern: "^diag\\.txt$" }],
    }), "/work");
    expect(config.modSettings.entries).toEqual(testModSettingsEntries);
    expect(config.modDiagnostics[0]?.pattern.test("diag.txt")).toBe(true);
  });

  it.each([
    [{ unknownField: true }, "unsupported fields: unknownField"],
    [{ scenarios: [{ ...minimal().scenarios[0], savePolicy: "create-test-fixture" }] }, "runtime scenarios must use savePolicy \"never\""],
    [{ scenarios: [{ ...minimal().scenarios[0], launch: { kind: "arena" } }] }, "launch.kind must be"],
    [{ modDiagnostics: [{ directory: "x", pattern: "(" }] }, "not a valid regular expression"],
    [{ mods: [{ uuid: "x" }] }, "mods[0].folder must be a string"],
    [{ protectedSaves: { ids: [1] } }, "protectedSaves.ids[0] must be a string"],
  ])("rejects malformed config %j", (overrides, message) => {
    expect(() => parseHarnessConfig(minimal(overrides), "/work")).toThrow(message);
  });

  it("loads BG3_HARNESS_CONFIG relative to the working directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-config-"));
    try {
      await writeFile(path.join(directory, "custom.json"), JSON.stringify(minimal()));
      const config = await loadHarnessConfig({ BG3_HARNESS_CONFIG: "custom.json", BG3_HARNESS_WORK_DIR: "work" }, directory);
      expect(config.workRoot).toBe(path.join(directory, "work"));
      await expect(loadHarnessConfig({}, directory)).rejects.toThrow("Cannot read harness config");
      await writeFile(path.join(directory, "harness.config.json"), "{");
      await expect(loadHarnessConfig({}, directory)).rejects.toThrow("not JSON");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("catalog pointer policies and protected saves", () => {
  const base = parseHarnessConfig(minimal(), "/work").catalog;

  it("accepts a runtime pointer policy and freezes it", () => {
    const catalog = createBg3TestScenarioCatalog({ ...base, scenarios: [{
      ...base.scenarios[0]!, pointer: { operation: "preview-target", spellId: "Target_Example", steps: ["one", "two"] },
    }] });
    const pointer = catalog.get("example.runtime-smoke")?.pointer;
    expect(pointer).toEqual({ operation: "preview-target", spellId: "Target_Example", steps: ["one", "two"] });
    expect(Object.isFrozen(pointer) && Object.isFrozen(pointer?.steps)).toBe(true);
  });

  it.each([
    { operation: "click", spellId: "Target_Example", steps: ["one"] },
    { operation: "preview-target", spellId: "Target Example", steps: ["one"] },
    { operation: "preview-target", spellId: "Target_Example", steps: [] },
    { operation: "preview-target", spellId: "Target_Example", steps: ["one", "one"] },
    { operation: "preview-target", spellId: "Target_Example", steps: ["bad step"] },
  ])("rejects an invalid pointer policy %j", (pointer) => {
    expect(() => createBg3TestScenarioCatalog({ ...base, scenarios: [{ ...base.scenarios[0]!, pointer }] }))
      .toThrow("invalid pointer policy");
  });

  it("matches protected IDs exactly or with a separator, and prefixes literally", () => {
    const protectedSaves = { ids: ["MainRun"], prefixes: ["777"] };
    for (const saveId of ["MainRun", "mainrun", "MainRun__AutoSave_0", "MainRun-2", "MainRun.bak", "777", "777anything"]) {
      expect(isProtectedBg3SaveId(saveId, protectedSaves)).toBe(true);
    }
    for (const saveId of ["MainRunner", "OtherMainRun", "7770".slice(1), "harness-fixture__AutoSave_0"]) {
      expect(isProtectedBg3SaveId(saveId, protectedSaves)).toBe(false);
    }
  });

  it("refuses a protected fixture save even when it is allowlisted", () => {
    expect(() => createBg3TestScenarioCatalog({
      ...base,
      protectedSaves: { ids: ["harness-fixture"], prefixes: [] },
    })).toThrow("Protected BG3 save cannot be a test fixture: harness-fixture__AutoSave_0");
  });
});
