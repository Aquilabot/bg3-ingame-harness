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
import {
  buildBg3ModSettings,
  createBg3ModSettingsManager,
  type Bg3ModSettingsEntry,
} from "../src/mod-settings.js";
import type { Bg3RequiredMods } from "../src/scenario-catalog.js";

const moduleA = {
  name: "Required A",
  uuid: "11111111-1111-1111-1111-111111111111",
} as const;
const moduleB = {
  name: "Required B",
  uuid: "22222222-2222-2222-2222-222222222222",
} as const;
const moduleC = {
  name: "Present C",
  uuid: "33333333-3333-3333-3333-333333333333",
} as const;
const preloadModule = {
  name: "Preload dependency",
  uuid: "ef37de74-b87c-4253-a5d2-bfc81073960d",
} as const;
const moduleDUuid = "44444444-4444-4444-4444-444444444444";
const baseModuleUuid = "cb555efe-2d9e-131f-8195-a89329d218ea";
const foreignAUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const foreignBUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const entries = Object.freeze([
  Object.freeze({
    folder: "Preload_ef37de74-b87c-4253-a5d2-bfc81073960d",
    md5: "",
    name: preloadModule.name,
    packageFile: "Preload.pak",
    publishHandle: "0",
    uuid: preloadModule.uuid,
    version64: "5",
  }),
  Object.freeze({
    folder: "RequiredA_11111111-1111-1111-1111-111111111111",
    md5: "",
    name: moduleA.name,
    packageFile: "RequiredA.pak",
    publishHandle: "0",
    uuid: moduleA.uuid,
    version64: "1",
  }),
  Object.freeze({
    folder: "RequiredB_22222222-2222-2222-2222-222222222222",
    md5: "0123456789abcdef0123456789abcdef",
    name: moduleB.name,
    packageFile: "RequiredB.pak",
    publishHandle: "42",
    uuid: moduleB.uuid,
    version64: "2",
  }),
  Object.freeze({
    folder: "PresentC_33333333-3333-3333-3333-333333333333",
    md5: "",
    name: moduleC.name,
    packageFile: "PresentC.pak",
    publishHandle: "0",
    uuid: moduleC.uuid,
    version64: "3",
  }),
  Object.freeze({
    folder: "ManagedD_44444444-4444-4444-4444-444444444444",
    md5: "",
    name: "Managed but not requested D",
    packageFile: "ManagedD.pak",
    publishHandle: "0",
    uuid: moduleDUuid,
    version64: "4",
  }),
] satisfies readonly Bg3ModSettingsEntry[]);

const requiredMods = Object.freeze({
  ordered: Object.freeze([moduleA, moduleB]),
  present: Object.freeze([moduleC]),
}) satisfies Bg3RequiredMods;

function moduleNode(
  uuid: string,
  name: string,
  indent = "            ",
): string {
  return [
    `${indent}<node id="ModuleShortDesc">`,
    `${indent}    <attribute id="Folder" type="LSString" value="${name.replaceAll(" ", "")}"/>`,
    `${indent}    <attribute id="Name" type="LSString" value="${name}"/>`,
    `${indent}    <attribute id="UUID" type="guid" value="${uuid}"/>`,
    `${indent}    <attribute id="Version64" type="int64" value="99"/>`,
    `${indent}</node>`,
  ].join("\n");
}

function modSettings(
  nodes: readonly string[],
  newline: "\n" | "\r\n" = "\n",
): string {
  const normalizedNodes = nodes.map((node) =>
    node.replaceAll("\r\n", "\n").replaceAll("\n", newline)
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<save>",
    '    <region id="ModuleSettings">',
    '        <node id="root">',
    "            <children>",
    '                <node id="Mods">',
    "                    <children>",
    ...normalizedNodes,
    "                    </children>",
    "                </node>",
    "            </children>",
    "        </node>",
    "    </region>",
    "</save>",
    "",
  ].join(newline);
}

function moduleOrder(contents: Buffer): string[] {
  return [...contents.toString("utf8").matchAll(
    /<node\s+id="ModuleShortDesc"\s*>[\s\S]*?<attribute\s+[^>]*id="UUID"[^>]*value="([^"]+)"[^>]*\/>[\s\S]*?<\/node>/g,
  )].map((match) => match[1]?.toLowerCase() ?? "");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function fixture(options?: {
  missingPackage?: string;
  original?: Buffer;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-mod-settings-"));
  const settingsPath = path.join(root, "PlayerProfiles", "Public", "modsettings.lsx");
  const modsRoot = path.join(root, "Mods");
  const harnessRoot = path.join(root, "harness");
  const original = options?.original ?? Buffer.from(modSettings([
    moduleNode(baseModuleUuid, "GustavX"),
    moduleNode(foreignAUuid, "Foreign A"),
  ]));

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await mkdir(modsRoot, { recursive: true });
  await writeFile(settingsPath, original);
  for (const entry of entries) {
    if (entry.packageFile !== options?.missingPackage) {
      await writeFile(path.join(modsRoot, entry.packageFile), "pak-data");
    }
  }

  const managerOptions = { settingsPath, modsRoot, harnessRoot, entries };
  return {
    harnessRoot,
    manager: createBg3ModSettingsManager(managerOptions),
    managerOptions,
    original,
    root,
    settingsPath,
  };
}

describe("BG3 modsettings load-order merge", () => {
  it("keeps only the base module and requested modules in declared order", () => {
    const foreignA = moduleNode(foreignAUuid, "Foreign &amp; A");
    const foreignB = moduleNode(foreignBUuid, "Foreign B");
    const existingA = moduleNode(moduleA.uuid, "Existing Required A");
    const existingB = moduleNode(moduleB.uuid, "Existing Required B");
    const existingD = moduleNode(moduleDUuid, "Existing Managed D");
    const original = Buffer.from(modSettings([
      existingB,
      foreignA,
      moduleNode(baseModuleUuid, "GustavX"),
      existingA,
      existingD,
      foreignB,
    ]));

    const modified = buildBg3ModSettings(original, requiredMods, entries);

    expect(moduleOrder(modified)).toEqual([
      baseModuleUuid,
      moduleA.uuid,
      moduleB.uuid,
      moduleC.uuid,
    ]);
    expect(modified.toString("utf8")).not.toContain(foreignA);
    expect(modified.toString("utf8")).not.toContain(foreignB);
    expect(modified.toString("utf8")).not.toContain(existingA);
    expect(modified.toString("utf8")).not.toContain(existingB);
    expect(modified.toString("utf8")).not.toContain(existingD);
    expect(modified.toString("utf8")).toContain(
      'value="RequiredA_11111111-1111-1111-1111-111111111111"',
    );
    expect(modified.toString("utf8")).toContain(
      'id="Version64" type="int64" value="2"',
    );
  });

  it("loads a requested preload dependency before the ordered module chain", () => {
    const modified = buildBg3ModSettings(
      Buffer.from(modSettings([moduleNode(baseModuleUuid, "GustavX")])),
      {
        ordered: [moduleA, moduleB],
        present: [moduleC, preloadModule],
      },
      entries,
      [preloadModule.uuid],
    );

    expect(moduleOrder(modified)).toEqual([
      baseModuleUuid,
      preloadModule.uuid,
      moduleA.uuid,
      moduleB.uuid,
      moduleC.uuid,
    ]);
  });

  it("rejects duplicate module UUIDs", () => {
    const duplicate = Buffer.from(modSettings([
      moduleNode(baseModuleUuid, "GustavX"),
      moduleNode(foreignAUuid, "Foreign A"),
      moduleNode(foreignAUuid.toUpperCase(), "Foreign A Duplicate"),
    ]));

    expect(() => buildBg3ModSettings(duplicate, requiredMods, entries)).toThrow(
      `repeats module ${foreignAUuid}`,
    );
  });

  it("rejects a profile without the required base module", () => {
    const missingBase = Buffer.from(modSettings([
      moduleNode(foreignAUuid, "Foreign A"),
    ]));

    expect(() => buildBg3ModSettings(missingBase, requiredMods, entries))
      .toThrow(`missing required base module ${baseModuleUuid}`);
  });

  it.each([
    ["no Mods node", Buffer.from("<save><node id=\"root\"/></save>")],
    [
      "an unclosed children container",
      Buffer.from(
        '<save><node id="Mods"><children><node id="ModuleShortDesc"></node></save>',
      ),
    ],
    [
      "unsupported contents inside Mods",
      Buffer.from(
        '<save><node id="Mods"><children><bogus/></children></node></save>',
      ),
    ],
  ])("rejects malformed XML with %s", (_label, malformed) => {
    expect(() => buildBg3ModSettings(malformed, requiredMods, entries)).toThrow(
      /modsettings\.lsx/,
    );
  });
});

describe("BG3 modsettings transaction manager", () => {
  it("prepares the requested load order and restores the original bytes exactly", async () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(modSettings([
        moduleNode(baseModuleUuid, "GustavX"),
        moduleNode(foreignAUuid, "Foreign A"),
      ], "\r\n")),
    ]);
    const test = await fixture({ original });
    try {
      await test.manager.prepare("run-exact-restore", requiredMods);

      const prepared = await readFile(test.settingsPath);
      expect(prepared.equals(original)).toBe(false);
      expect(moduleOrder(prepared)).toEqual([
        baseModuleUuid,
        moduleA.uuid,
        moduleB.uuid,
        moduleC.uuid,
      ]);
      expect(
        await exists(path.join(test.harnessRoot, "modsettings-owner.json")),
      ).toBe(true);

      await test.manager.restore("run-exact-restore");

      expect((await readFile(test.settingsPath)).equals(original)).toBe(true);
      expect(
        await exists(path.join(test.harnessRoot, "modsettings-owner.json")),
      ).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("fails before mutation when a required package is missing", async () => {
    const test = await fixture({ missingPackage: "RequiredB.pak" });
    try {
      await expect(
        test.manager.prepare("run-missing-package", requiredMods),
      ).rejects.toThrow("Required BG3 package is not installed: RequiredB.pak");

      expect((await readFile(test.settingsPath)).equals(test.original)).toBe(true);
      expect(
        await exists(path.join(test.harnessRoot, "modsettings-owner.json")),
      ).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a concurrent change and keeps its recovery journal", async () => {
    const test = await fixture();
    const concurrent = Buffer.from(modSettings([
      moduleNode(foreignBUuid, "Concurrent User Module"),
    ]));
    try {
      await test.manager.prepare("run-concurrent-change", requiredMods);
      await writeFile(test.settingsPath, concurrent);

      await expect(
        test.manager.restore("run-concurrent-change"),
      ).rejects.toThrow("refusing to overwrite the newer contents");

      expect((await readFile(test.settingsPath)).equals(concurrent)).toBe(true);
      expect(
        await exists(path.join(test.harnessRoot, "modsettings-owner.json")),
      ).toBe(true);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("recovers the original bytes after an interrupted manager instance", async () => {
    const test = await fixture();
    try {
      await test.manager.prepare("run-interrupted", requiredMods);
      const recoveredManager = createBg3ModSettingsManager(test.managerOptions);

      await recoveredManager.recover();

      expect((await readFile(test.settingsPath)).equals(test.original)).toBe(true);
      expect(
        await exists(path.join(test.harnessRoot, "modsettings-owner.json")),
      ).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
