import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const OWNER_SCHEMA_VERSION = 1;
const SETTINGS_KEY = "LuaBuiltinResourceDirectory";
const CRASH_SANITY_SETTINGS_KEY = "InsanityCheck";
const OWNER_FILE_NAME = "builtin-bridge-owner.json";
const BUILTINS_DIRECTORY_NAME = "builtins";
const STARTUP_FILE_NAME = "ClientStartup.lua";
const REQUIRED_STARTUP_PREFIX = [
  'Ext.Utils.Include(nil, "builtin://Startup.lua")',
  'Ext.Utils.Include(nil, "builtin://BuiltinLibraryClient.lua")',
].join("\n");

interface BuiltinBridgeOwner {
  schemaVersion: number;
  runId: string;
  settingsPath: string;
  overrideDirectory: string;
  windowsOverrideDirectory: string;
  originalExists: boolean;
  originalContentsBase64: string;
  originalSha256: string;
  modifiedSha256: string;
}

export interface Bg3BuiltinBridgeOptions {
  settingsPath: string;
  harnessRoot: string;
  bridgeSourcePath: string;
  windowsHarnessRoot: string;
}

export interface Bg3BuiltinBridgeManager {
  prepare(runId: string): Promise<void>;
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
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseSettings(contents: Buffer | undefined): Record<string, unknown> {
  if (contents === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error("ScriptExtenderSettings.json is not valid JSON", {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ScriptExtenderSettings.json must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function ownerFromJson(
  raw: string,
  options: Bg3BuiltinBridgeOptions,
): BuiltinBridgeOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("The BG3 builtin bridge owner file is not valid JSON", {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The BG3 builtin bridge owner file is invalid");
  }
  const owner = parsed as Record<string, unknown>;
  if (
    owner.schemaVersion !== OWNER_SCHEMA_VERSION ||
    typeof owner.runId !== "string" ||
    typeof owner.settingsPath !== "string" ||
    typeof owner.overrideDirectory !== "string" ||
    typeof owner.windowsOverrideDirectory !== "string" ||
    typeof owner.originalExists !== "boolean" ||
    typeof owner.originalContentsBase64 !== "string" ||
    typeof owner.originalSha256 !== "string" ||
    typeof owner.modifiedSha256 !== "string"
  ) {
    throw new Error("The BG3 builtin bridge owner file is invalid");
  }
  validateRunId(owner.runId);
  const expectedOverride = path.join(
    options.harnessRoot,
    BUILTINS_DIRECTORY_NAME,
    owner.runId,
  );
  const expectedWindowsOverride = [
    options.windowsHarnessRoot.replace(/[\\/]+$/, ""),
    BUILTINS_DIRECTORY_NAME,
    owner.runId,
  ].join("/");
  if (
    owner.settingsPath !== options.settingsPath ||
    owner.overrideDirectory !== expectedOverride ||
    owner.windowsOverrideDirectory !== expectedWindowsOverride ||
    !/^[a-f0-9]{64}$/.test(owner.originalSha256) ||
    !/^[a-f0-9]{64}$/.test(owner.modifiedSha256)
  ) {
    throw new Error("The BG3 builtin bridge owner file targets unexpected paths");
  }
  const original = Buffer.from(owner.originalContentsBase64, "base64");
  if (sha256(original) !== owner.originalSha256) {
    throw new Error("The BG3 builtin bridge owner backup failed its hash check");
  }
  return owner as unknown as BuiltinBridgeOwner;
}

export function createBg3BuiltinBridgeManager(
  options: Bg3BuiltinBridgeOptions,
): Bg3BuiltinBridgeManager {
  const ownerPath = path.join(options.harnessRoot, OWNER_FILE_NAME);

  async function loadOwner(): Promise<BuiltinBridgeOwner | undefined> {
    const contents = await readOptional(ownerPath);
    return contents === undefined
      ? undefined
      : ownerFromJson(contents.toString("utf8"), options);
  }

  async function restoreOwner(owner: BuiltinBridgeOwner): Promise<void> {
    const current = await readOptional(options.settingsPath);
    const original = Buffer.from(owner.originalContentsBase64, "base64");
    const currentSha256 = current === undefined ? undefined : sha256(current);
    const settingsAreOriginal = owner.originalExists
      ? currentSha256 === owner.originalSha256
      : current === undefined;

    if (!settingsAreOriginal) {
      if (currentSha256 !== owner.modifiedSha256) {
        throw new Error(
          "ScriptExtenderSettings.json changed after the harness installed its override; refusing to overwrite the newer contents",
        );
      }
      if (owner.originalExists) {
        await writeAtomically(options.settingsPath, original);
      } else {
        await rm(options.settingsPath, { force: true });
      }
    }

    await rm(owner.overrideDirectory, { recursive: true, force: true });
    await rm(ownerPath, { force: true });
  }

  return {
    async prepare(runId): Promise<void> {
      validateRunId(runId);
      const existingOwner = await loadOwner();
      if (existingOwner !== undefined) {
        await restoreOwner(existingOwner);
      }

      const original = await readOptional(options.settingsPath);
      const settings = parseSettings(original);
      if (Object.hasOwn(settings, SETTINGS_KEY)) {
        throw new Error(
          `ScriptExtenderSettings.json already configures ${SETTINGS_KEY}`,
        );
      }

      const source = await readFile(options.bridgeSourcePath);
      if (!source.toString("utf8").startsWith(REQUIRED_STARTUP_PREFIX)) {
        throw new Error(
          `${STARTUP_FILE_NAME} must load the two official Script Extender startup builtins first`,
        );
      }

      const overrideDirectory = path.join(
        options.harnessRoot,
        BUILTINS_DIRECTORY_NAME,
        runId,
      );
      const windowsOverrideDirectory = [
        options.windowsHarnessRoot.replace(/[\\/]+$/, ""),
        BUILTINS_DIRECTORY_NAME,
        runId,
      ].join("/");
      const modified = Buffer.from(
        `${JSON.stringify(
          {
            ...settings,
            [CRASH_SANITY_SETTINGS_KEY]: true,
            [SETTINGS_KEY]: windowsOverrideDirectory,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const originalBytes = original ?? Buffer.alloc(0);
      const owner: BuiltinBridgeOwner = {
        schemaVersion: OWNER_SCHEMA_VERSION,
        runId,
        settingsPath: options.settingsPath,
        overrideDirectory,
        windowsOverrideDirectory,
        originalExists: original !== undefined,
        originalContentsBase64: originalBytes.toString("base64"),
        originalSha256: sha256(originalBytes),
        modifiedSha256: sha256(modified),
      };

      try {
        await mkdir(path.dirname(overrideDirectory), { recursive: true });
        await mkdir(overrideDirectory, { recursive: false });
        await writeAtomically(
          path.join(overrideDirectory, STARTUP_FILE_NAME),
          source,
        );
        await writeAtomically(
          ownerPath,
          `${JSON.stringify(owner, null, 2)}\n`,
        );
        await writeAtomically(options.settingsPath, modified);
      } catch (error) {
        const current = await readOptional(options.settingsPath);
        if (current !== undefined && sha256(current) === owner.modifiedSha256) {
          if (owner.originalExists) {
            await writeAtomically(options.settingsPath, originalBytes);
          } else {
            await rm(options.settingsPath, { force: true });
          }
        }
        await rm(overrideDirectory, { recursive: true, force: true });
        await rm(ownerPath, { force: true });
        throw error;
      }
    },

    async restore(runId): Promise<void> {
      validateRunId(runId);
      const owner = await loadOwner();
      if (owner === undefined) return;
      if (owner.runId !== runId) {
        throw new Error(
          `BG3 builtin bridge belongs to ${owner.runId}, not ${runId}`,
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
