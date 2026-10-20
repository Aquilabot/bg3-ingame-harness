import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBg3BuiltinBridgeManager } from "../src/builtin-bridge.js";

const startupSource = [
  'Ext.Utils.Include(nil, "builtin://Startup.lua")',
  'Ext.Utils.Include(nil, "builtin://BuiltinLibraryClient.lua")',
  "return true",
  "",
].join("\n");

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function fixture(initialSettings?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-bridge-"));
  const settingsPath = path.join(root, "game", "bin", "ScriptExtenderSettings.json");
  const harnessRoot = path.join(root, "harness");
  const sourcePath = path.join(root, "source", "ClientStartup.lua");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, startupSource);
  if (initialSettings !== undefined) {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, initialSettings);
  }
  const manager = createBg3BuiltinBridgeManager({
    settingsPath,
    harnessRoot,
    bridgeSourcePath: sourcePath,
    windowsHarnessRoot:
      "C:/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
  });
  return { root, settingsPath, harnessRoot, manager };
}

describe("BG3 Script Extender builtin startup bridge", () => {
  it("installs one run-scoped override and restores the original bytes", async () => {
    const original = '{"LogRuntime":true}\n';
    const test = await fixture(original);
    try {
      await test.manager.prepare("run-character-creation");

      const settings = JSON.parse(await readFile(test.settingsPath, "utf8"));
      expect(settings).toMatchObject({
        LogRuntime: true,
        InsanityCheck: true,
        LuaBuiltinResourceDirectory:
          "C:/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/builtins/run-character-creation",
      });
      const overridePath = path.join(
        test.harnessRoot,
        "builtins",
        "run-character-creation",
        "ClientStartup.lua",
      );
      await expect(readFile(overridePath, "utf8")).resolves.toBe(startupSource);

      await test.manager.restore("run-character-creation");

      await expect(readFile(test.settingsPath, "utf8")).resolves.toBe(original);
      expect(await exists(overridePath)).toBe(false);
      expect(
        await exists(path.join(test.harnessRoot, "builtin-bridge-owner.json")),
      ).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("removes settings that did not exist before the bridge", async () => {
    const test = await fixture();
    try {
      await test.manager.prepare("run-no-settings");
      expect(await exists(test.settingsPath)).toBe(true);

      await test.manager.restore("run-no-settings");

      expect(await exists(test.settingsPath)).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("refuses to replace a user-managed builtin directory", async () => {
    const original = JSON.stringify({
      LogRuntime: true,
      LuaBuiltinResourceDirectory: "C:/user-owned/builtins",
    });
    const test = await fixture(original);
    try {
      await expect(test.manager.prepare("run-conflict")).rejects.toThrow(
        "already configures LuaBuiltinResourceDirectory",
      );
      await expect(readFile(test.settingsPath, "utf8")).resolves.toBe(original);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("does not overwrite settings changed by the user during a run", async () => {
    const test = await fixture('{"LogRuntime":true}\n');
    try {
      await test.manager.prepare("run-user-change");
      await writeFile(
        test.settingsPath,
        '{"LogRuntime":false,"UserChangedThis":true}\n',
      );

      await expect(test.manager.restore("run-user-change")).rejects.toThrow(
        "changed after the harness installed its override",
      );
      await expect(readFile(test.settingsPath, "utf8")).resolves.toContain(
        "UserChangedThis",
      );
      expect(
        await exists(path.join(test.harnessRoot, "builtin-bridge-owner.json")),
      ).toBe(true);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted owned override before another run", async () => {
    const original = '{\n  "LogRuntime": true\n}\n';
    const test = await fixture(original);
    try {
      await test.manager.prepare("run-interrupted");

      await test.manager.recover();

      await expect(readFile(test.settingsPath, "utf8")).resolves.toBe(original);
      expect(
        await exists(path.join(test.harnessRoot, "builtin-bridge-owner.json")),
      ).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
