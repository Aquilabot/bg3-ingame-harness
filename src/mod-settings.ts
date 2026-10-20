import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import type { Bg3RequiredMod, Bg3RequiredMods } from "./scenario-catalog.js";

const OWNER_SCHEMA_VERSION = 1;
const OWNER_FILE_NAME = "modsettings-owner.json";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MD5_PATTERN = /^(?:|[0-9a-f]{32})$/i;
const UINT_PATTERN = /^(?:0|[1-9][0-9]*)$/;
export const BG3_BASE_MODULE_UUIDS = Object.freeze([
  "cb555efe-2d9e-131f-8195-a89329d218ea",
]);

export interface Bg3ModSettingsEntry {
  folder: string;
  md5: string;
  name: string;
  packageFile: string;
  publishHandle: string;
  uuid: string;
  version64: string;
}

interface Bg3ModSettingsOwner {
  schemaVersion: number;
  runId: string;
  settingsPath: string;
  originalContentsBase64: string;
  originalSha256: string;
  modifiedSha256: string;
  requiredModUuids: string[];
}

export interface Bg3ModSettingsOptions {
  settingsPath: string;
  modsRoot: string;
  harnessRoot: string;
  /** modsettings.lsx descriptors for every mod a scenario may require. */
  entries: readonly Bg3ModSettingsEntry[];
  /** Required mods that must be written before all others, in their required order. */
  preloadModuleUuids?: readonly string[];
}

export interface Bg3ModSettingsManager {
  prepare(runId: string, requiredMods: Bg3RequiredMods): Promise<void>;
  restore(runId: string): Promise<void>;
  recover(): Promise<void>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
    throw new Error(`Unsafe BG3 test runId: ${runId}`);
  }
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomically(
  destination: string,
  contents: Buffer | string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    const directory = await open(path.dirname(destination), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateEntry(entry: Bg3ModSettingsEntry): void {
  if (
    entry.folder.trim() === "" ||
    entry.folder.length > 200 ||
    entry.folder.includes("/") ||
    entry.folder.includes("\\") ||
    entry.name.trim() === "" ||
    entry.name.length > 200 ||
    !/^[A-Za-z0-9_. -]+\.pak$/i.test(entry.packageFile) ||
    !UUID_PATTERN.test(entry.uuid) ||
    !MD5_PATTERN.test(entry.md5) ||
    !UINT_PATTERN.test(entry.publishHandle) ||
    !UINT_PATTERN.test(entry.version64)
  ) {
    throw new Error(`Invalid BG3 mod settings entry: ${entry.uuid}`);
  }
}

function entryMap(
  entries: readonly Bg3ModSettingsEntry[],
): ReadonlyMap<string, Bg3ModSettingsEntry> {
  const result = new Map<string, Bg3ModSettingsEntry>();
  for (const entry of entries) {
    validateEntry(entry);
    const uuid = entry.uuid.toLowerCase();
    if (result.has(uuid)) {
      throw new Error(`Duplicate BG3 mod settings entry: ${entry.uuid}`);
    }
    result.set(uuid, Object.freeze({ ...entry, uuid }));
  }
  return result;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderEntry(
  entry: Bg3ModSettingsEntry,
  indent: string,
  newline: string,
): string {
  const attributeIndent = `${indent}    `;
  return [
    `${indent}<node id="ModuleShortDesc">`,
    `${attributeIndent}<attribute id="Folder" type="LSString" value="${xmlEscape(entry.folder)}"/>`,
    `${attributeIndent}<attribute id="MD5" type="LSString" value="${entry.md5.toLowerCase()}"/>`,
    `${attributeIndent}<attribute id="Name" type="LSString" value="${xmlEscape(entry.name)}"/>`,
    `${attributeIndent}<attribute id="PublishHandle" type="uint64" value="${entry.publishHandle}"/>`,
    `${attributeIndent}<attribute id="UUID" type="guid" value="${entry.uuid.toLowerCase()}"/>`,
    `${attributeIndent}<attribute id="Version64" type="int64" value="${entry.version64}"/>`,
    `${indent}</node>`,
  ].join(newline);
}

function moduleUuid(node: string): string {
  const attributes = [...node.matchAll(/<attribute\s+([^>]*?)\/>/g)];
  const values: string[] = [];
  for (const match of attributes) {
    const source = match[1];
    if (source === undefined || !/\bid="UUID"(?:\s|$)/.test(source)) continue;
    const value = /\bvalue="([^"]*)"/.exec(source)?.[1];
    if (value !== undefined) values.push(value);
  }
  const uuid = values.length === 1 ? values[0] : undefined;
  if (uuid === undefined || !UUID_PATTERN.test(uuid)) {
    throw new Error("modsettings.lsx contains an invalid ModuleShortDesc UUID");
  }
  return uuid.toLowerCase();
}

interface ParsedModuleNode {
  indent: string;
  raw: string;
  uuid: string;
}

function parseModuleNodes(contents: string): {
  childrenEnd: number;
  childrenStart: number;
  closingIndent: string;
  indent: string;
  newline: string;
  nodes: ParsedModuleNode[];
} {
  const modsMatches = [...contents.matchAll(/<node\s+id="Mods"\s*>/g)];
  if (modsMatches.length !== 1 || modsMatches[0]?.index === undefined) {
    throw new Error("modsettings.lsx must contain exactly one Mods node");
  }
  const modsStart = modsMatches[0].index + modsMatches[0][0].length;
  const childrenMatch = /<children\s*>/.exec(contents.slice(modsStart));
  if (childrenMatch?.index === undefined) {
    throw new Error("modsettings.lsx Mods node has no children container");
  }
  const childrenStart = modsStart + childrenMatch.index + childrenMatch[0].length;
  const childrenEndRelative = contents.slice(childrenStart).indexOf("</children>");
  if (childrenEndRelative < 0) {
    throw new Error("modsettings.lsx Mods children container is not closed");
  }
  const childrenEnd = childrenStart + childrenEndRelative;
  const inner = contents.slice(childrenStart, childrenEnd);
  const nodePattern = /([ \t]*)<node\s+id="ModuleShortDesc"\s*>[\s\S]*?<\/node>/g;
  const nodes: ParsedModuleNode[] = [];
  let match: RegExpExecArray | null;
  while ((match = nodePattern.exec(inner)) !== null) {
    const raw = match[0];
    const indent = match[1];
    if (raw === undefined || indent === undefined) continue;
    nodes.push({ indent, raw, uuid: moduleUuid(raw) });
  }
  if (inner.replace(nodePattern, "").trim() !== "") {
    throw new Error(
      "modsettings.lsx Mods children contain unsupported XML",
    );
  }
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.uuid)) {
      throw new Error(`modsettings.lsx repeats module ${node.uuid}`);
    }
    seen.add(node.uuid);
  }
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const closingIndent = new RegExp(`${newline === "\r\n" ? "\\r\\n" : "\\n"}([ \\t]*)$`)
    .exec(inner)?.[1] ?? "";
  const indent = nodes[0]?.indent ?? `${closingIndent}    `;
  return {
    childrenEnd,
    childrenStart,
    closingIndent,
    indent,
    newline,
    nodes,
  };
}

function uniqueRequiredMods(requiredMods: Bg3RequiredMods): Bg3RequiredMod[] {
  const result: Bg3RequiredMod[] = [];
  const seen = new Set<string>();
  for (const mod of [...requiredMods.ordered, ...requiredMods.present]) {
    const uuid = mod.uuid.toLowerCase();
    if (seen.has(uuid)) {
      throw new Error(`Required BG3 module is repeated: ${mod.uuid}`);
    }
    seen.add(uuid);
    result.push(mod);
  }
  return result;
}

export function buildBg3ModSettings(
  original: Buffer,
  requiredMods: Bg3RequiredMods,
  entries: readonly Bg3ModSettingsEntry[],
  preloadModuleUuidList: readonly string[] = [],
): Buffer {
  const descriptors = entryMap(entries);
  const required = uniqueRequiredMods(requiredMods);
  const preloadModuleUuids = new Set(preloadModuleUuidList.map((uuid) => uuid.toLowerCase()));
  const requestedLoadOrder = [
    ...required.filter((mod) => preloadModuleUuids.has(mod.uuid.toLowerCase())),
    ...required.filter((mod) => !preloadModuleUuids.has(mod.uuid.toLowerCase())),
  ];
  const source = original.toString("utf8");
  const parsed = parseModuleNodes(source);
  const baseModuleUuids = new Set(BG3_BASE_MODULE_UUIDS);
  const outputNodes = parsed.nodes
    .filter((node) => baseModuleUuids.has(node.uuid))
    .map((node) => node.raw);
  for (const uuid of BG3_BASE_MODULE_UUIDS) {
    if (!parsed.nodes.some((node) => node.uuid === uuid)) {
      throw new Error(`modsettings.lsx is missing required base module ${uuid}`);
    }
  }

  for (const mod of requestedLoadOrder) {
    const uuid = mod.uuid.toLowerCase();
    const descriptor = descriptors.get(uuid);
    if (descriptor === undefined) {
      throw new Error(
        `No modsettings.lsx descriptor is registered for ${mod.name} (${mod.uuid})`,
      );
    }
    outputNodes.push(renderEntry(descriptor, parsed.indent, parsed.newline));
  }

  const inner = outputNodes.length === 0
    ? `${parsed.newline}${parsed.closingIndent}`
    : `${parsed.newline}${outputNodes.join(parsed.newline)}${parsed.newline}${parsed.closingIndent}`;
  return Buffer.from(
    `${source.slice(0, parsed.childrenStart)}${inner}${source.slice(parsed.childrenEnd)}`,
    "utf8",
  );
}

function ownerFromJson(
  raw: string,
  options: Bg3ModSettingsOptions,
): Bg3ModSettingsOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("The BG3 mod settings owner file is not valid JSON", {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The BG3 mod settings owner file is invalid");
  }
  const owner = parsed as Record<string, unknown>;
  if (
    owner.schemaVersion !== OWNER_SCHEMA_VERSION ||
    typeof owner.runId !== "string" ||
    typeof owner.settingsPath !== "string" ||
    typeof owner.originalContentsBase64 !== "string" ||
    typeof owner.originalSha256 !== "string" ||
    typeof owner.modifiedSha256 !== "string" ||
    !Array.isArray(owner.requiredModUuids) ||
    !owner.requiredModUuids.every((uuid) =>
      typeof uuid === "string" && UUID_PATTERN.test(uuid)
    )
  ) {
    throw new Error("The BG3 mod settings owner file is invalid");
  }
  validateRunId(owner.runId);
  if (
    owner.settingsPath !== options.settingsPath ||
    !/^[a-f0-9]{64}$/.test(owner.originalSha256) ||
    !/^[a-f0-9]{64}$/.test(owner.modifiedSha256)
  ) {
    throw new Error("The BG3 mod settings owner file targets unexpected data");
  }
  const original = Buffer.from(owner.originalContentsBase64, "base64");
  if (sha256(original) !== owner.originalSha256) {
    throw new Error("The BG3 mod settings backup failed its hash check");
  }
  return owner as unknown as Bg3ModSettingsOwner;
}

export function createBg3ModSettingsManager(
  options: Bg3ModSettingsOptions,
): Bg3ModSettingsManager {
  const entries = options.entries;
  const preloadModuleUuids = options.preloadModuleUuids ?? [];
  const descriptors = entryMap(entries);
  const ownerPath = path.join(options.harnessRoot, OWNER_FILE_NAME);

  async function loadOwner(): Promise<Bg3ModSettingsOwner | undefined> {
    const contents = await readOptional(ownerPath);
    return contents === undefined
      ? undefined
      : ownerFromJson(contents.toString("utf8"), options);
  }

  async function restoreOwner(owner: Bg3ModSettingsOwner): Promise<void> {
    const current = await readOptional(options.settingsPath);
    if (current === undefined) {
      throw new Error(
        "modsettings.lsx disappeared after the harness prepared its load order",
      );
    }
    const currentSha256 = sha256(current);
    if (currentSha256 !== owner.originalSha256) {
      if (currentSha256 !== owner.modifiedSha256) {
        throw new Error(
          "modsettings.lsx changed after the harness prepared its load order; refusing to overwrite the newer contents",
        );
      }
      const original = Buffer.from(owner.originalContentsBase64, "base64");
      await writeAtomically(options.settingsPath, original);
    }
    const restored = await readFile(options.settingsPath);
    if (sha256(restored) !== owner.originalSha256) {
      throw new Error("modsettings.lsx did not restore to its original hash");
    }
    await rm(ownerPath, { force: true });
  }

  return {
    async prepare(runId, requiredMods): Promise<void> {
      validateRunId(runId);
      const existingOwner = await loadOwner();
      if (existingOwner !== undefined) await restoreOwner(existingOwner);

      const required = uniqueRequiredMods(requiredMods);
      for (const mod of required) {
        const descriptor = descriptors.get(mod.uuid.toLowerCase());
        if (descriptor === undefined) {
          throw new Error(
            `No modsettings.lsx descriptor is registered for ${mod.name} (${mod.uuid})`,
          );
        }
        const packagePath = path.join(options.modsRoot, descriptor.packageFile);
        const packageMetadata = await stat(packagePath).catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") {
            throw new Error(
              `Required BG3 package is not installed: ${descriptor.packageFile}`,
            );
          }
          throw error;
        });
        if (!packageMetadata.isFile() || packageMetadata.size === 0) {
          throw new Error(
            `Required BG3 package is not a non-empty file: ${descriptor.packageFile}`,
          );
        }
      }

      const original = await readOptional(options.settingsPath);
      if (original === undefined) {
        throw new Error(`BG3 mod settings file is missing: ${options.settingsPath}`);
      }
      const modified = buildBg3ModSettings(original, requiredMods, entries, preloadModuleUuids);
      const owner: Bg3ModSettingsOwner = {
        schemaVersion: OWNER_SCHEMA_VERSION,
        runId,
        settingsPath: options.settingsPath,
        originalContentsBase64: original.toString("base64"),
        originalSha256: sha256(original),
        modifiedSha256: sha256(modified),
        requiredModUuids: required.map((mod) => mod.uuid.toLowerCase()),
      };

      try {
        await writeAtomically(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
        if (owner.modifiedSha256 !== owner.originalSha256) {
          const beforeReplace = await readFile(options.settingsPath);
          if (sha256(beforeReplace) !== owner.originalSha256) {
            throw new Error(
              "modsettings.lsx changed while the harness prepared its load order",
            );
          }
          await writeAtomically(options.settingsPath, modified);
        }
        const installed = await readFile(options.settingsPath);
        if (sha256(installed) !== owner.modifiedSha256) {
          throw new Error(
            "modsettings.lsx does not match the load order written by the harness",
          );
        }
      } catch (error) {
        const current = await readOptional(options.settingsPath);
        const currentSha256 = current === undefined ? undefined : sha256(current);
        let ownerCanBeRemoved = currentSha256 === owner.originalSha256;
        if (currentSha256 === owner.modifiedSha256) {
          await writeAtomically(options.settingsPath, original);
          ownerCanBeRemoved = true;
        }
        if (ownerCanBeRemoved) {
          await rm(ownerPath, { force: true });
        }
        throw error;
      }
    },

    async restore(runId): Promise<void> {
      validateRunId(runId);
      const owner = await loadOwner();
      if (owner === undefined) return;
      if (owner.runId !== runId) {
        throw new Error(
          `BG3 mod settings belong to ${owner.runId}, not ${runId}`,
        );
      }
      await restoreOwner(owner);
    },

    async recover(): Promise<void> {
      const owner = await loadOwner();
      if (owner !== undefined) await restoreOwner(owner);
    },
  };
}
