import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  Bg3TestInterruptedError,
  Bg3TestTimeoutError,
  type Bg3TestPlatform,
  type Bg3TestDisplayMode,
  type LaunchedGame,
} from "./platform.js";
import {
  BG3_NEW_CAMPAIGN_SAVE_ID,
  Bg3TestProtocolError,
  parseBg3AutosaveGuard,
  parseBg3SaveIntentAck,
  parseBg3SaveRequest,
  parseBg3SaveIntent,
  parseBg3ServerFinalizing,
  parseBg3ServerReady,
  parseBg3TestClientReady,
  parseBg3TestModLoad,
  parseBg3TestResult,
  type Bg3TestArm,
  type Bg3TestCommand,
  type Bg3TestMode,
  type Bg3SaveIntent,
  type Bg3SaveRequest,
} from "./protocol.js";
import {
  isProtectedBg3SaveId,
  isValidBg3RacePassiveId,
  scenarioMode,
  scenarioSaveId,
  type Bg3ProtectedSaves,
  type Bg3RequiredMods,
  type Bg3TestScenario,
  type Bg3TestScenarioCatalog,
} from "./scenario-catalog.js";
import { inspectBg3SaveLoad } from "./network-log.js";
import { createBg3BuiltinBridgeManager } from "./builtin-bridge.js";
import { createBg3ModSettingsManager, type Bg3ModSettingsEntry } from "./mod-settings.js";
import {
  createBg3SteamCloudManager,
  createSteamCloudHelperExecutor,
  type Bg3SteamCloudManager,
} from "./steam-cloud.js";
import { clearBg3ModCrashSanityCheck } from "./crash-sanity.js";
import { withRunLockGuard } from "./run-lock-guard.js";
import { prepareBg3EngineLogArchive, type Bg3EngineLogArchive, type Bg3ModDiagnosticsSource } from "./engine-logs.js";
import { waitForBg3ExitAfterLostValidation } from "./process-exit.js";
import { archiveBg3LaunchEvidence, createBg3LauncherObservation, type Bg3LauncherObservation } from "./launcher-observation.js";
import { environmentHasAppId, validateBg3ProcessIdentity } from "./process-identity.js";
export { environmentHasAppId } from "./process-identity.js";
import { readSteamCloudLogAfter, type SteamCloudLogCursor } from "./steam-cloud-log.js";
import { createBg3PointerSession } from "./pointer.js";
import { harnessPackageRoot } from "./paths.js";
import { checkBg3PointerDependencies, createBg3PointerDriver } from "./pointer-driver.js";

const STEAM_APP_ID = "1086940";
const PROCESS_DISCOVERY_TIMEOUT_MS = 90_000;
const PROCESS_RECOVERY_TIMEOUT_MS = 10_000;
const WINDOW_DISCOVERY_TIMEOUT_MS = 60_000;
const WINDOW_FOCUS_TIMEOUT_MS = 5_000;
const PROCESS_POLL_MS = 250;
const FILE_POLL_MS = 200;
const SERVER_RESULT_GRACE_MS = 500;
export const BG3_SERVER_FINALIZING_DISCOVERY_GRACE_MS = 30_000;
export const BG3_SERVER_RESULT_DRAIN_MS = 31_000;
const TERMINATE_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;
const STEAM_APP_EXIT_TIMEOUT_MS = 30_000;
const STEAM_APP_EXIT_STABILITY_MS = 2_000;
const STEAM_CLOUD_SYNC_TIMEOUT_MS = 120_000;
const STEAM_CLOUD_SAVE_AUDIT_MS = 2_000;
const STEAM_CLOUD_SETTLEMENT_SCHEMA_VERSION = 1;
const STEAM_CLOUD_SETTLEMENT_FILE_NAME = "steam-cloud-settlement.json";
const MAX_RESULT_BYTES = 1_048_576;
const SAVE_STABILITY_MS = 2_000;
const MOD_LOAD_STABILITY_MS = 1_000;
const BG3_HEADLESS_RULE_FINALIZATION_MARGIN_MS = 30_000;
const LEGACY_RECOVERY_CLAIM_STALE_MS = 5 * 60_000;
const UNOWNED_RUN_LOCK_STALE_MS = 5 * 60_000;
const OWNER_TEMPORARY_PATTERN =
  /^owner\.json\.([1-9][0-9]*)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
export const BG3_HEADLESS_OUTPUT_NAME = "BG3-HARNESS";
const BG3_HEADLESS_WORKSPACE_NAME = "bg3-harness";
/** Folder under the Script Extender data directory that carries the JSON channel. Must match the Lua side. */
export const BG3_HARNESS_DIRECTORY = "BG3InGameHarness";

interface NetworkLogIdentity {
  path: string;
  key: string;
  modifiedAtMs: number;
}

interface ActiveLaunch {
  processIdentity: LaunchedGame;
  runId: string;
  mode: Bg3TestMode;
  display?: Bg3TestDisplayMode;
  networkLogsBeforeLaunch: Set<string>;
  builtinBridgePrepared: boolean;
  modSettingsPrepared: boolean;
  steamCloudPrepared: boolean;
  saveSnapshotBeforeLaunch: Bg3SaveIdentitySnapshot;
  saveIntent?: {
    intentId: string;
    snapshotAtAck: Bg3SaveIdentitySnapshot;
    acknowledgedAtEpochMs: number;
  };
  validatedSave?: SaveFileIdentity;
  windowDiagnostics?: ReturnType<typeof createBg3WindowDiagnostics>;
}

interface PendingLaunch {
  runId: string;
  mode: Bg3TestMode;
  networkLogsBeforeLaunch: Set<string>;
  builtinBridgePrepared: boolean;
  modSettingsPrepared: boolean;
  steamCloudPrepared: boolean;
  saveSnapshotBeforeLaunch: Bg3SaveIdentitySnapshot;
  quarantineUntilEpochMs: number;
}

interface ArmedRunLockOwner {
  schemaVersion: 2;
  runId: string;
  pid: number;
  ownerStartTimeTicks: string;
  createdAt: string;
  status: "armed";
  quarantineUntilEpochMs: number;
}

interface PendingRunLockOwner {
  schemaVersion: 2;
  runId: string;
  pid: number;
  ownerStartTimeTicks: string;
  createdAt: string;
  status: "pending-steam";
  quarantineUntilEpochMs: number;
  saveSnapshotBeforeLaunch: SaveFileIdentity[];
}

type RunLockOwner = ArmedRunLockOwner | PendingRunLockOwner;

interface HyprlandWindow {
  address: string;
  stableId: string;
  pid: number;
  mapped: boolean;
  hidden: boolean;
  groupedAddresses: string[];
  workspaceName?: string;
  monitorId?: number;
  className?: string;
  initialClassName?: string;
  acceptsInput?: boolean;
}

interface HyprlandMonitor {
  id: number;
  name: string;
  activeWorkspaceId: number;
  activeWorkspaceName: string;
  focused: boolean;
  physicalWidth: number;
  physicalHeight: number;
}

interface HyprlandWorkspace {
  name: string;
}

interface HeadlessOutput {
  name: string;
  runId: string;
  kind: Bg3TestDisplayMode;
}

export function selectBg3VisibleMonitor(monitors: readonly {
  name: string;
  focused: boolean;
  physicalWidth: number;
  physicalHeight: number;
}[]): string {
  const candidates = monitors.filter((monitor) => monitor.focused
    && Number.isFinite(monitor.physicalWidth) && monitor.physicalWidth > 0
    && Number.isFinite(monitor.physicalHeight) && monitor.physicalHeight > 0
    && monitor.name !== BG3_HEADLESS_OUTPUT_NAME
    && !/^HEADLESS-/i.test(monitor.name));
  if (candidates.length !== 1 || !/^[A-Za-z0-9._-]+$/.test(candidates[0]!.name)) {
    throw new Error("Visible BG3 tests require one focused physical monitor with reported dimensions");
  }
  return candidates[0]!.name;
}

export async function selectBg3LaunchDisplay<T>(
  mode: Bg3TestDisplayMode,
  outputs: { headless(): Promise<T>; visible(): Promise<T> },
): Promise<T> {
  if (mode !== "headless" && mode !== "visible") throw new Error("Invalid BG3 display mode");
  return mode === "visible" ? outputs.visible() : outputs.headless();
}

export type Bg3WindowDiagnosticPhase = "after-placement" | "before-command" | "terminal-observation";
export const BG3_WINDOW_DIAGNOSTIC_LIMITS = {
  readMs: 1_100, queryBytes: 262_144, artifactBytes: 16_384,
  windows: 512, monitors: 32, string: 256, errors: 8, absent: 64,
} as const;

interface Bg3WindowDiagnosticOptions {
  runId: string;
  display: Bg3TestDisplayMode;
  process: LaunchedGame;
  window: { address: string; stableId: string };
  now(): number;
  readProcess(): Promise<LaunchedGame | undefined>;
  readHypr(query: "clients" | "monitors", signal: AbortSignal): Promise<string>;
  warn(message: string): void;
}

// Diagnostic files are independent of protocol inputs and never certify a test result.
export function createBg3WindowDiagnostics(options: Bg3WindowDiagnosticOptions): {
  capture(phase: Bg3WindowDiagnosticPhase, trigger: string): Promise<void>;
  archive(write: (phase: Bg3WindowDiagnosticPhase, contents: string) => Promise<void>): Promise<void>;
} {
  const attempted = new Set<Bg3WindowDiagnosticPhase>();
  const retained = new Map<Bg3WindowDiagnosticPhase, string>();
  const expectedProcess = { pid: options.process.pid, startTimeTicks: options.process.startTimeTicks };
  const expectedWindow = { address: options.window.address, stableId: options.window.stableId };
  const limits = BG3_WINDOW_DIAGNOSTIC_LIMITS;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const bounded = (value: string): string => value.slice(0, limits.string);
  const warn = (message: string): void => {
    try { options.warn(bounded(message)); } catch { /* Diagnostics cannot prevent cleanup. */ }
  };
  const timed = async <T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("diagnostic timeout")); }, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  };
  return {
    async capture(phase, trigger): Promise<void> {
      if (attempted.has(phase)) return;
      attempted.add(phase);
      const errors: string[] = [];
      const absent: string[] = [];
      let errorsOmitted = 0;
      let absentOmitted = 0;
      const error = (value: string): void => {
        if (errors.length < limits.errors) errors.push(bounded(value));
        else errorsOmitted += 1;
      };
      const missing = (value: string): void => {
        if (absent.length < limits.absent) absent.push(value);
        else absentOmitted += 1;
      };
      const now = (): number | undefined => {
        try {
          const value = options.now();
          if (Number.isFinite(value)) return value;
        } catch { /* An unavailable clock must not prevent cleanup. */ }
        error("clock: unavailable or nonfinite");
        return undefined;
      };
      const startedAtEpochMs = now();
      let observation: Record<string, unknown> = {};
      try {
        observation = await timed(limits.readMs, async (signal) => {
          const processState = async (): Promise<"matched" | "unavailable" | "replaced"> => {
            const current = await options.readProcess();
            signal.throwIfAborted();
            if (current === undefined) return "unavailable";
            return current.pid === expectedProcess.pid && current.startTimeTicks === expectedProcess.startTimeTicks
              ? "matched" : "replaced";
          };
          const before = await processState();
          if (before !== "matched") return { processBefore: before };
          const queries = await Promise.allSettled((["clients", "monitors"] as const).map(async (query) => {
            const raw = await options.readHypr(query, signal);
            signal.throwIfAborted();
            if (Buffer.byteLength(raw) > limits.queryBytes) throw new Error("response exceeds byte limit");
            const value: unknown = JSON.parse(raw);
            if (!Array.isArray(value) || value.length > limits[query === "clients" ? "windows" : "monitors"]
              || !value.every(record)) throw new Error("invalid or excessive collection");
            return value as Record<string, unknown>[];
          }));
          signal.throwIfAborted();
          const after = await processState();
          if (after !== "matched") return { processBefore: before, processAfter: after };
          const snapshot: Record<string, unknown> = { processBefore: before, processAfter: after };
          const clients = queries[0]!;
          const monitors = queries[1]!;
          if (clients.status === "rejected") error("clients: read, JSON or collection validation failed");
          if (monitors.status === "rejected") error("monitors: read, JSON or collection validation failed");
          if (clients.status !== "fulfilled") return snapshot;
          const candidates = clients.value.filter((window) => window.pid === expectedProcess.pid);
          if (candidates.length === 0) { missing("window"); return snapshot; }
          const window = candidates[0]!;
          if (candidates.length !== 1 || window.address !== expectedWindow.address || window.stableId !== expectedWindow.stableId
            || (window.class !== "steam_app_1086940" && window.initialClass !== "steam_app_1086940")) {
            error("window identity differs or is ambiguous"); return snapshot;
          }
          const copy = (source: Record<string, unknown>, prefix: string, fields: Record<string, "number" | "string" | "boolean" | "pair">): Record<string, unknown> => {
            const result: Record<string, unknown> = {};
            for (const [key, type] of Object.entries(fields)) {
              const value = source[key];
              if (value === undefined) { missing(`${prefix}.${key}`); continue; }
              const valid = type === "pair"
                ? Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item))
                : typeof value === type && (type !== "number" || Number.isFinite(value))
                  && (type !== "string" || (value as string).length <= limits.string);
              if (!valid) { error(`${prefix}.${key}: invalid value`); continue; }
              result[key] = type === "pair" ? [...value as number[]] : value;
            }
            return result;
          };
          const workspace = (source: Record<string, unknown>, result: Record<string, unknown>, prefix: string, key: string): void => {
            if (source[key] === undefined) missing(`${prefix}.${key}`);
            else if (!record(source[key])) error(`${prefix}.${key}: invalid value`);
            else result[key] = copy(source[key], `${prefix}.${key}`, { id: "number", name: "string" });
          };
          const ownWindow = copy(window, "window", {
            pid: "number", address: "string", stableId: "string", class: "string", initialClass: "string",
            at: "pair", size: "pair", monitor: "number", mapped: "boolean", hidden: "boolean",
            fullscreen: "number", fullscreenClient: "number", xwayland: "boolean",
          });
          workspace(window, ownWindow, "window", "workspace");
          snapshot.window = ownWindow;
          if (typeof window.monitor !== "number" || !Number.isSafeInteger(window.monitor) || monitors.status !== "fulfilled") return snapshot;
          const matches = monitors.value.filter((monitor) => monitor.id === window.monitor);
          if (matches.length === 0) { missing("monitor"); return snapshot; }
          if (matches.length !== 1) { error("monitor identity is ambiguous"); return snapshot; }
          const monitor = matches[0]!;
          const ownMonitor = copy(monitor, "monitor", {
            id: "number", name: "string", x: "number", y: "number", width: "number", height: "number",
            refreshRate: "number", scale: "number", transform: "number", dpmsStatus: "boolean", disabled: "boolean", focused: "boolean",
          });
          workspace(monitor, ownMonitor, "monitor", "activeWorkspace");
          snapshot.monitor = ownMonitor;
          return snapshot;
        });
      } catch {
        // No partial geometry survives an incomplete process identity check or a timeout.
        error("capture: read failed or exceeded deadline");
      }
      try {
        const contents = JSON.stringify({
          schemaVersion: 1, status: "diagnostic", runId: options.runId, phase, trigger: bounded(trigger),
          display: options.display, startedAtEpochMs, completedAtEpochMs: now(),
          expectedProcess, expectedWindow, ...observation, errors, absent, errorsOmitted, absentOmitted,
        }) + "\n";
        if (Buffer.byteLength(contents) > limits.artifactBytes) throw new Error("diagnostic exceeds byte limit");
        retained.set(phase, contents);
      } catch {
        warn(`BG3 window diagnostic ${phase} could not be retained`);
      }
    },
    async archive(write): Promise<void> {
      // The runner calls this after cleanup. Await every write to settlement;
      // aborting fs.writeFile would not guarantee that OS writes have stopped.
      // A runner exit before archival loses these bounded in-memory snapshots.
      const snapshots = [...retained];
      retained.clear();
      for (const [phase, contents] of snapshots) {
        try { await write(phase, contents); }
        catch { warn(`BG3 window diagnostic ${phase} could not be archived`); }
      }
    },
  };
}

interface SteamCloudSettlementOwner {
  schemaVersion: 1;
  runId: string;
  cloudLogPath: string;
  expectAutoCloudUpload: boolean;
  logDevice: number | null;
  logInode: number | null;
  logOffset: number;
  expectedSaveSnapshot: SaveFileIdentity[];
}

export interface SaveFileIdentity {
  id: string;
  lsvPath: string;
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
}

export type Bg3SaveIdentitySnapshot = ReadonlyMap<string, SaveFileIdentity>;

export interface Bg3SaveIdentityChange {
  kind: "created" | "modified" | "deleted";
  id: string;
  lsvPath: string;
  before?: SaveFileIdentity;
  after?: SaveFileIdentity;
}

export interface StableBg3SaveChangeOptions {
  before: Bg3SaveIdentitySnapshot;
  requestedAtEpochMs: number;
  timeoutMs: number;
  stabilityMs: number;
  pollMs: number;
  now(): number;
  sleep(durationMs: number): Promise<void>;
  assertGameRunning(): Promise<void>;
  readSnapshot(): Promise<Bg3SaveIdentitySnapshot>;
  protectedSaves?: Bg3ProtectedSaves;
}

export interface StableNewBg3SaveOptions {
  before: ReadonlySet<string>;
  minimumModifiedAtMs: number;
  timeoutMs: number;
  stabilityMs: number;
  pollMs: number;
  now(): number;
  sleep(durationMs: number): Promise<void>;
  assertGameRunning(): Promise<void>;
  readSaveIds(): Promise<ReadonlySet<string>>;
  inspectSave(saveId: string): Promise<SaveFileIdentity | undefined>;
}

export interface Bg3SavePostconditionAuditOptions {
  durationMs: number;
  pollMs: number;
  now(): number;
  sleep(durationMs: number): Promise<void>;
  readSnapshot(): Promise<Bg3SaveIdentitySnapshot>;
  assertSnapshot(snapshot: Bg3SaveIdentitySnapshot): void;
}

export interface Bg3SteamCloudExitSyncObservation {
  started: boolean;
  autoCloudComplete: boolean;
  uploadComplete: boolean;
  failure?: string;
}

export interface Bg3ClientReadyFile {
  size: number;
  contents: string;
}

export interface Bg3ClientReadyWaitOptions {
  runId: string;
  scenarioId: string;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  timeoutMs: number;
  pollMs: number;
  maxBytes: number;
  now(): number;
  sleep(durationMs: number): Promise<void>;
  assertGameRunning(): Promise<void>;
  readAcknowledgement(): Promise<Bg3ClientReadyFile | undefined>;
}

export interface Bg3ModLoadWaitOptions {
  runId: string;
  scenarioId: string;
  requiredMods: Bg3RequiredMods;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  timeoutMs: number;
  pollMs: number;
  stabilityMs: number;
  maxBytes: number;
  now(): number;
  sleep(durationMs: number): Promise<void>;
  assertGameRunning(): Promise<void>;
  readStartupError(): Promise<Bg3ClientReadyFile | undefined>;
  readAutosaveGuard(): Promise<Bg3ClientReadyFile | undefined>;
  readObservation(): Promise<Bg3ClientReadyFile | undefined>;
}

export type Bg3ResultArtifactName =
  | "result.json"
  | "server-ready.json"
  | "server-finalizing.json"
  | "save-intent.json"
  | "client-error.json"
  | "startup-error.json";

export interface Bg3ResultWaitOptions {
  runId: string;
  scenarioId: string;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  timeoutMs: number;
  pollMs: number;
  maxBytes: number;
  startupGraceMs: number;
  finalizingDiscoveryGraceMs: number;
  resultDrainMs: number;
  assertGameRunning(): Promise<void>;
  now(): number;
  sleep(durationMs: number): Promise<void>;
  readArtifact(
    name: Bg3ResultArtifactName,
  ): Promise<Bg3ClientReadyFile | undefined>;
  onSaveIntent?(intent: Bg3SaveIntent): Promise<void>;
  onClientInput?(): Promise<void>;
  onServerFinalizing?(): Promise<void>;
}

export interface NodeBg3TestPlatformOptions {
  catalog: Bg3TestScenarioCatalog;
  /** Descriptors and load-order rules for the mods scenarios may require. */
  modSettings: {
    entries: readonly Bg3ModSettingsEntry[];
    preloadModuleUuids?: readonly string[];
  };
  protectedSaves?: Bg3ProtectedSaves;
  modDiagnostics?: readonly Bg3ModDiagnosticsSource[];
  signal?: AbortSignal;
  userRoot?: string;
  /** Steam installation root. Defaults to `<userRoot>/.local/share/Steam`. */
  steamRoot?: string;
  /**
   * 64-bit Steamworks `libsteam_api.so` exporting `SteamAPI_InitFlat`. Defaults to
   * `BG3_STEAM_API_LIBRARY`, then `<steamRoot>/steamrt64/libsteam_api.so`.
   */
  steamApiLibraryPath?: string;
  /** Directory that receives `.cache/` (Steam helper build, run archives). Defaults to the current directory. */
  workRoot?: string;
  /** Root of this package. Tests may point it elsewhere. */
  packageRoot?: string;
  steamCloudManager?: Bg3SteamCloudManager;
  steamCloudSyncTimeoutMs?: number;
  steamCloudSaveAuditMs?: number;
  readDesktopLocked?(): Promise<boolean>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
    throw new Error(`Unsafe BG3 test runId: ${runId}`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeJsonAtomically(
  destination: string,
  value: unknown,
  beforeCommit?: () => void,
): Promise<void> {
  const directoryPath = path.dirname(destination);
  await mkdir(directoryPath, { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    beforeCommit?.();
    await rename(temporary, destination);
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function processStartTime(statContents: string): string | undefined {
  const commandEnd = statContents.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fieldsFromState = statContents.slice(commandEnd + 1).trim().split(/\s+/);
  return fieldsFromState[19];
}

async function readProcessIdentity(pid: number): Promise<LaunchedGame | undefined> {
  try {
    const [command, startTimeTicks] = await Promise.all([
      readFile(`/proc/${pid}/comm`, "utf8"),
      readProcessStartTimeTicks(pid),
    ]);
    const processName = command.trim();
    if (
      (processName !== "bg3.exe" && processName !== "bg3_dx11.exe") ||
      startTimeTicks === undefined
    ) {
      return undefined;
    }
    return { pid, startTimeTicks };
  } catch (error) {
    if (isNodeError(error) && ["ENOENT", "ESRCH"].includes(error.code ?? "")) {
      return undefined;
    }
    throw error;
  }
}

async function readProcessStartTimeTicks(
  pid: number,
): Promise<string | undefined> {
  try {
    return processStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (isNodeError(error) && ["ENOENT", "ESRCH"].includes(error.code ?? "")) {
      return undefined;
    }
    throw error;
  }
}

export function numericProcessIds(entries: readonly string[]): number[] {
  return entries
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number);
}

export function assertNoBg3ProcessCandidates(
  candidates: readonly LaunchedGame[],
  phase: string,
): void {
  if (candidates.length === 0) return;
  throw new Error(
    `Refusing ${phase} while BG3 PID ${candidates.map(({ pid }) => pid).join(", ")} exists`,
  );
}

async function listGameProcesses(): Promise<LaunchedGame[]> {
  const entries = await readdir("/proc");
  const identities = await Promise.all(
    numericProcessIds(entries).map((pid) => readProcessIdentity(pid)),
  );
  return identities.filter(
    (identity): identity is LaunchedGame => identity !== undefined,
  );
}

async function readSteamAppProcessIdentity(
  pid: number,
): Promise<LaunchedGame | undefined> {
  try {
    const [environment, startTimeTicks] = await Promise.all([
      readFile(`/proc/${pid}/environ`),
      readProcessStartTimeTicks(pid),
    ]);
    if (
      startTimeTicks === undefined ||
      !environmentHasAppId(environment)
    ) {
      return undefined;
    }
    return { pid, startTimeTicks };
  } catch (error) {
    if (
      isNodeError(error) &&
      ["EACCES", "ENOENT", "EPERM", "ESRCH"].includes(error.code ?? "")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function listSteamAppProcesses(): Promise<LaunchedGame[]> {
  const entries = await readdir("/proc");
  const identities = await Promise.all(
    numericProcessIds(entries).map((pid) => readSteamAppProcessIdentity(pid)),
  );
  return identities.filter(
    (identity): identity is LaunchedGame => identity !== undefined,
  );
}

async function validateGameProcess(
  identity: LaunchedGame,
  gameRoot: string,
): Promise<boolean> {
  return validateBg3ProcessIdentity(identity, gameRoot);
}

async function validateScriptExtenderLoaded(
  identity: LaunchedGame,
  gameRoot: string,
): Promise<boolean> {
  if (!(await validateGameProcess(identity, gameRoot))) return false;
  try {
    const maps = await readFile(`/proc/${identity.pid}/maps`, "utf8");
    return maps.toLowerCase().includes("bg3scriptextender.dll");
  } catch (error) {
    if (isNodeError(error) && ["ENOENT", "ESRCH"].includes(error.code ?? "")) {
      return false;
    }
    throw error;
  }
}

async function listNetworkLogs(gameRoot: string): Promise<NetworkLogIdentity[]> {
  const binRoot = path.join(gameRoot, "bin");
  const entries = await readdir(binRoot, { withFileTypes: true });
  const logs = entries.filter(
    (entry) => entry.isFile() && /^network\..+\.log$/.test(entry.name),
  );
  return Promise.all(
    logs.map(async (entry) => {
      const filePath = path.join(binRoot, entry.name);
      const metadata = await stat(filePath);
      return {
        path: filePath,
        key: `${metadata.dev}:${metadata.ino}`,
        modifiedAtMs: metadata.mtimeMs,
      };
    }),
  );
}

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return true;
    await wait(PROCESS_POLL_MS);
  } while (Date.now() < deadline);
  return false;
}

export function bg3SteamLaunchArguments(
  saveId: string | undefined,
): string[] {
  const arguments_ = ["-silent", "-applaunch", STEAM_APP_ID, "--skip-launcher"];
  if (saveId === undefined) {
    return arguments_;
  }
  arguments_.push("-loadSaveGame", saveId);
  return arguments_;
}

export function steamClientStartArguments(): string[] {
  return ["-silent"];
}

export function identifyCreatedHeadlessOutput(
  before: readonly string[],
  after: readonly string[],
): string {
  const beforeNames = new Set(before);
  const added = after.filter(
    (name) => !beforeNames.has(name) && /^HEADLESS-[A-Za-z0-9._-]+$/i.test(name),
  );
  if (added.length !== 1) {
    throw new Error(
      `Expected one new Hyprland headless output, found ${added.length}`,
    );
  }
  return added[0] as string;
}

export function bg3HeadlessOutputCreateArguments(): string[] {
  return ["output", "create", "headless", BG3_HEADLESS_OUTPUT_NAME];
}

export interface Bg3HeadlessOutputObservation {
  id: number;
  name: string;
  activeWorkspaceId: number;
  activeWorkspaceName: string;
}

export function identifyReusableHeadlessOutput(
  monitors: readonly Bg3HeadlessOutputObservation[],
  occupiedMonitorIds: readonly (number | undefined)[],
): Bg3HeadlessOutputObservation | undefined {
  const reserved = monitors.filter(
    ({ name }) => name === BG3_HEADLESS_OUTPUT_NAME,
  );
  if (reserved.length > 1) {
    throw new Error(
      `Expected at most one Hyprland output named ${BG3_HEADLESS_OUTPUT_NAME}, found ${reserved.length}`,
    );
  }
  const workspaceCollision = monitors.find(
    ({ name, activeWorkspaceName }) =>
      name !== BG3_HEADLESS_OUTPUT_NAME &&
      activeWorkspaceName === BG3_HEADLESS_WORKSPACE_NAME,
  );
  if (workspaceCollision !== undefined) {
    throw new Error(
      `Refusing BG3 isolation because workspace ${BG3_HEADLESS_WORKSPACE_NAME} is hosted by ${workspaceCollision.name}`,
    );
  }
  const monitor = reserved[0];
  if (monitor === undefined) return undefined;
  if (occupiedMonitorIds.includes(undefined)) {
    throw new Error(
      `Refusing to reuse Hyprland output ${BG3_HEADLESS_OUTPUT_NAME} because a window has no monitor identity`,
    );
  }
  const windowCount = occupiedMonitorIds.filter(
    (monitorId) => monitorId === monitor.id,
  ).length;
  if (windowCount > 0) {
    throw new Error(
      `Refusing to reuse Hyprland output ${BG3_HEADLESS_OUTPUT_NAME} because it still contains ${windowCount} window${windowCount === 1 ? "" : "s"}`,
    );
  }
  return monitor;
}

export function newBg3SaveIds(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string[] {
  return [...after].filter((saveId) => !before.has(saveId)).sort();
}

export function singleNewBg3SaveId(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string | undefined {
  const added = newBg3SaveIds(before, after);
  if (added.length > 1) {
    throw new Error(
      `Character creation produced ${added.length} new saves: ${added.join(", ")}`,
    );
  }
  return added[0];
}

function sameSaveFileIdentity(
  left: SaveFileIdentity,
  right: SaveFileIdentity,
): boolean {
  return (
    left.id === right.id &&
    left.lsvPath === right.lsvPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs
  );
}

export function changedBg3SaveIdentities(
  before: Bg3SaveIdentitySnapshot,
  after: Bg3SaveIdentitySnapshot,
): Bg3SaveIdentityChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: Bg3SaveIdentityChange[] = [];
  for (const lsvPath of paths) {
    const previous = before.get(lsvPath);
    const current = after.get(lsvPath);
    if (previous === undefined && current !== undefined) {
      changes.push({
        kind: "created",
        id: current.id,
        lsvPath,
        after: current,
      });
    } else if (previous !== undefined && current === undefined) {
      changes.push({
        kind: "deleted",
        id: previous.id,
        lsvPath,
        before: previous,
      });
    } else if (
      previous !== undefined &&
      current !== undefined &&
      !sameSaveFileIdentity(previous, current)
    ) {
      changes.push({
        kind: "modified",
        id: current.id,
        lsvPath,
        before: previous,
        after: current,
      });
    }
  }
  return changes;
}

export function assertNoBg3SaveChanges(
  before: Bg3SaveIdentitySnapshot,
  after: Bg3SaveIdentitySnapshot,
  phase: string,
): void {
  const changes = changedBg3SaveIdentities(before, after);
  if (changes.length === 0) return;
  throw new Error(
    `${changes.length} .lsv identities changed ${phase}: ${changes.map(
      ({ kind, id }) => `${kind}:${id}`,
    ).join(", ")}`,
  );
}

// Only a new campaign that declared create-test-fixture may produce a save.
// discard-campaign and the runtime lane must leave every save unchanged.
export function bg3ArmPermitsTestSave(
  arm: Pick<Bg3TestArm, "mode" | "savePolicy" | "saveId">,
): boolean {
  return arm.mode === "character-creation" &&
    arm.savePolicy === "create-test-fixture" &&
    arm.saveId === BG3_NEW_CAMPAIGN_SAVE_ID;
}

export function assertBg3CreationSavePostcondition(
  before: Bg3SaveIdentitySnapshot,
  after: Bg3SaveIdentitySnapshot,
  validatedSave: SaveFileIdentity | undefined,
  phase: string,
): void {
  if (validatedSave === undefined) {
    assertNoBg3SaveChanges(before, after, phase);
    return;
  }
  const changes = changedBg3SaveIdentities(before, after);
  const change = changes[0];
  if (
    changes.length !== 1 ||
    change?.kind !== "created" ||
    change.after === undefined ||
    !sameSaveFileIdentity(change.after, validatedSave)
  ) {
    throw new Error(
      `Character creation final save state does not match validated fixture ${validatedSave.id}`,
    );
  }
}

export async function auditBg3SavePostconditionForDuration(
  options: Bg3SavePostconditionAuditOptions,
): Promise<void> {
  if (
    !Number.isSafeInteger(options.durationMs) ||
    options.durationMs < 0 ||
    !Number.isSafeInteger(options.pollMs) ||
    options.pollMs < 1
  ) {
    throw new Error("BG3 save audit timing is invalid");
  }
  const startedAt = options.now();
  const deadline = startedAt + options.durationMs;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(deadline)) {
    throw new Error("BG3 save audit clock is invalid");
  }
  while (true) {
    options.assertSnapshot(await options.readSnapshot());
    const remainingMs = deadline - options.now();
    if (remainingMs <= 0) return;
    await options.sleep(Math.min(options.pollMs, remainingMs));
  }
}

export function inspectBg3SteamCloudExitSync(
  logContents: string,
): Bg3SteamCloudExitSyncObservation {
  let started = false;
  let autoCloudComplete = false;
  let uploadComplete = false;
  let failure: string | undefined;
  for (const line of logContents.split(/\r?\n/)) {
    if (!line.includes("[AppID 1086940]")) continue;
    if (/Starting sync \((?:init,)?up,AC Exit,\)/.test(line)) {
      started = true;
      autoCloudComplete = false;
      uploadComplete = false;
      failure = undefined;
      continue;
    }
    if (!started) continue;
    if (line.includes("AutoCloud complete")) {
      autoCloudComplete = true;
      continue;
    }
    if (
      line.includes("Upload complete in build list") ||
      line.includes("Upload complete, result OK")
    ) {
      uploadComplete = true;
      continue;
    }
    const failedUpload = line.match(/Upload complete, result (.+)$/);
    if (failedUpload?.[1] !== undefined) failure = failedUpload[1].trim();
  }
  return {
    started,
    autoCloudComplete,
    uploadComplete,
    ...(failure === undefined ? {} : { failure }),
  };
}

export async function snapshotBg3SaveIdentities(
  saveRoot: string,
): Promise<Map<string, SaveFileIdentity>> {
  const directories = (await readdir(saveRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const identities = new Map<string, SaveFileIdentity>();
  for (const directory of directories) {
    const directoryPath = path.join(saveRoot, directory.name);
    const files = (await readdir(directoryPath, { withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".lsv"),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const file of files) {
      const lsvPath = path.join(directoryPath, file.name);
      const metadata = await stat(lsvPath);
      if (!metadata.isFile()) continue;
      identities.set(lsvPath, {
        id: directory.name,
        lsvPath,
        device: metadata.dev,
        inode: metadata.ino,
        size: metadata.size,
        modifiedAtMs: metadata.mtimeMs,
      });
    }
  }
  return identities;
}

export async function waitForStableBg3SaveChange(
  options: StableBg3SaveChangeOptions,
): Promise<string> {
  const deadline = options.now() + options.timeoutMs;
  let stable:
    | { identity: SaveFileIdentity; observedAtMs: number }
    | undefined;
  do {
    await options.assertGameRunning();
    const changes = changedBg3SaveIdentities(
      options.before,
      await options.readSnapshot(),
    );
    if (changes.length > 1) {
      throw new Error(
        `${changes.length} .lsv identities changed after save request: ${changes.map(
          ({ kind, id }) => `${kind}:${id}`,
        ).join(", ")}`,
      );
    }
    const change = changes[0];
    if (change !== undefined) {
      if (change.kind === "deleted" || change.after === undefined) {
        throw new Error(
          `BG3 deleted .lsv identity after save request: ${change.id}`,
        );
      }
      if (change.kind !== "created") {
        throw new Error(
          `Save request modified an existing .lsv identity: ${change.id}`,
        );
      }
      const identity = change.after;
      if (isProtectedBg3SaveId(identity.id, options.protectedSaves ?? { ids: [], prefixes: [] })) {
        throw new Error(
          `Refusing change to protected BG3 save ${identity.id}`,
        );
      }
      if (
        Math.floor(identity.modifiedAtMs / 1_000) <
        Math.floor(options.requestedAtEpochMs / 1_000)
      ) {
        throw new Error(
          `Changed BG3 save predates save request: ${identity.id}`,
        );
      }
      if (identity.size > 0) {
        const now = options.now();
        if (
          stable !== undefined &&
          sameSaveFileIdentity(stable.identity, identity)
        ) {
          if (now - stable.observedAtMs >= options.stabilityMs) {
            return identity.id;
          }
        } else {
          stable = { identity, observedAtMs: now };
        }
      } else {
        stable = undefined;
      }
    } else {
      stable = undefined;
    }
    await options.sleep(options.pollMs);
  } while (options.now() < deadline);

  throw new Bg3TestTimeoutError(
    `Timed out after ${options.timeoutMs} ms waiting for one stable request-correlated BG3 save`,
  );
}

export function bg3HeadlessWindowCommands(
  outputName: string,
  windowStableId: string,
  grouped: boolean,
): string[][] {
  if (
    (outputName !== BG3_HEADLESS_OUTPUT_NAME &&
      !/^HEADLESS-[A-Za-z0-9._-]+$/i.test(outputName)) ||
    !/^[0-9a-f]+$/i.test(windowStableId)
  ) {
    throw new Error("Unsafe Hyprland target for the BG3 headless window");
  }
  const move = [
    "dispatch",
    `hl.dsp.window.move({ window = "stableid:${windowStableId}", monitor = "${outputName}", follow = false })`,
  ];
  if (!grouped) return [move];
  return [
    [
      "dispatch",
      `hl.dsp.window.move({ window = "stableid:${windowStableId}", out_of_group = true })`,
    ],
    move,
  ];
}

export async function focusBg3VisibleWindowOnce(options: {
  window: HyprlandWindow;
  processId: number;
  validateProcess(): Promise<boolean>;
  readWindows(): Promise<readonly HyprlandWindow[]>;
  readActiveWindow(): Promise<HyprlandWindow | undefined>;
  readWindowProperties(window: HyprlandWindow): Promise<{ noFocus: string; noFollowMouse: string }>;
  readDesktopLocked(): Promise<boolean>;
  dispatch(arguments_: readonly string[]): Promise<string>;
  waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean>;
}): Promise<void> {
  const expected = { ...options.window, groupedAddresses: [...options.window.groupedAddresses] };
  if (!/^[0-9a-f]+$/i.test(expected.stableId) || !/^0x[0-9a-f]+$/i.test(expected.address)
    || !Number.isSafeInteger(options.processId) || options.processId <= 0
    || expected.pid !== options.processId || !expected.mapped || expected.hidden
    || expected.groupedAddresses.length !== 0 || expected.monitorId === undefined) {
    throw new Error("Refusing to focus an unvalidated visible BG3 window");
  }
  const sameWindow = (window: HyprlandWindow | undefined): boolean =>
    window?.pid === options.processId && window.stableId === expected.stableId
    && window.address === expected.address && window.mapped && !window.hidden
    && window.monitorId === expected.monitorId && window.groupedAddresses.length === 0;
  const evidence: { dispatchResponse: string | null; before?: unknown; after?: unknown; finalObservationUnavailable?: boolean } = { dispatchResponse: null };
  const propertySnapshot = async () => {
    try {
      const properties = await options.readWindowProperties(expected);
      return { noFocus: properties.noFocus.slice(0, 1_024), noFollowMouse: properties.noFollowMouse.slice(0, 1_024) };
    } catch {
      // A failed diagnostic query must not replace the focus or identity error.
      return { unavailable: true };
    }
  };
  const desktopSnapshot = async () => {
    try {
      return { locked: await options.readDesktopLocked() };
    } catch {
      return { unavailable: true };
    }
  };
  const observe = async (phase?: "before" | "after"): Promise<boolean> => {
    if (!(await options.validateProcess())) {
      throw new Error("BG3 process identity changed before initial focus was verified");
    }
    const [windows, active, properties, desktop] = await Promise.all([
      options.readWindows(), options.readActiveWindow(), phase === undefined ? undefined : propertySnapshot(),
      phase === undefined ? undefined : desktopSnapshot(),
    ]);
    const candidates = windows.filter((window) => isMappedBg3WindowCandidate(window, options.processId));
    if (candidates.length !== 1 || !sameWindow(candidates[0])) {
      throw new Error("BG3 visible window identity changed before initial focus was verified");
    }
    // The process can exit or its PID be reused while compositor queries run.
    if (!(await options.validateProcess())) {
      throw new Error("BG3 process identity changed before initial focus was verified");
    }
    const current = candidates[0]!;
    // Only the owned window's focus-related fields enter the diagnostic.
    // Other windows contribute identity only, never titles or arbitrary data.
    const snapshot = {
      window: { pid: current.pid, stableId: current.stableId, address: current.address,
        mapped: current.mapped, hidden: current.hidden, monitorId: current.monitorId,
        groupedAddresses: [...current.groupedAddresses], className: current.className,
        initialClassName: current.initialClassName, acceptsInput: current.acceptsInput },
      active: active === undefined ? null : { pid: active.pid, stableId: active.stableId, address: active.address },
      ...(properties === undefined ? {} : { properties }),
      ...(desktop === undefined ? {} : { desktop }),
    };
    if (phase === "before") evidence.before = snapshot;
    else evidence.after = snapshot;
    return sameWindow(active);
  };
  try {
    if (await observe("before")) return;
    // Launch owns one focus action for this exact stable window. Subsequent
    // polls only observe it; later pointer guards retain authority over focus.
    evidence.dispatchResponse = (await options.dispatch([
      "dispatch",
      `hl.dsp.focus({ window = "stableid:${expected.stableId}" })`,
    ])).slice(0, 1_024);
    if (!(await options.waitUntil(() => observe(), WINDOW_FOCUS_TIMEOUT_MS))) {
      try { await observe("after"); } catch { evidence.finalObservationUnavailable = true; }
      throw new Bg3TestTimeoutError(
        `BG3 window ${expected.stableId} did not receive initial focus within ${WINDOW_FOCUS_TIMEOUT_MS} ms`,
      );
    }
  } catch (error) {
    const message = `${error instanceof Error ? error.message : "Initial BG3 focus failed"}; focus evidence: ${JSON.stringify(evidence)}`;
    if (error instanceof Bg3TestTimeoutError) throw new Bg3TestTimeoutError(message);
    throw new Error(message, { cause: error });
  }
}

const BG3_HEADLESS_RULE_GLOBAL = "bg3_harness_window_rule";
const BG3_STEAM_RULE_GLOBAL = "bg3_harness_steam_rule";
const BG3_HEADLESS_RULE_OWNER_GLOBAL = "bg3_harness_window_rule_owner";
const BG3_HEADLESS_RULE_TIMER_GLOBAL = "bg3_harness_window_rule_timer";
const BG3_WINDOW_RULE_PROFILES_GLOBAL = "bg3_harness_window_rule_profiles";

export function assertBg3HeadlessWorkspaceAvailable(
  workspaceNames: readonly string[],
): void {
  if (workspaceNames.includes(BG3_HEADLESS_WORKSPACE_NAME)) {
    throw new Error(
      `Refusing to reuse existing Hyprland workspace ${BG3_HEADLESS_WORKSPACE_NAME}`,
    );
  }
}

export function bg3HeadlessWorkspaceRenameExpression(
  workspaceId: number,
): string {
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 0) {
    throw new Error(`Unsafe Hyprland workspace ID: ${workspaceId}`);
  }
  return `hl.dsp.workspace.rename({ workspace = "${workspaceId}", name = "${BG3_HEADLESS_WORKSPACE_NAME}" })`;
}

export function bg3HeadlessWindowRuleInstallExpression(
  runId: string,
  remainingMs: number,
  visibleMonitorName?: string,
): string {
  validateRunId(runId);
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
    throw new Error(`Invalid BG3 headless rule watchdog timeout: ${remainingMs}`);
  }
  if (visibleMonitorName !== undefined && (
    !/^[A-Za-z0-9._-]+$/.test(visibleMonitorName)
    || visibleMonitorName === BG3_HEADLESS_OUTPUT_NAME
    || /^HEADLESS-/i.test(visibleMonitorName)
  )) throw new Error("Invalid visible BG3 monitor");
  const profile = visibleMonitorName === undefined ? "headless" : `visible-${visibleMonitorName}`;
  const gameRules = visibleMonitorName === undefined ? [
    `workspace = "name:${BG3_HEADLESS_WORKSPACE_NAME} silent",`,
    "no_initial_focus = true,", "no_focus = true,",
    "no_follow_mouse = true,", "focus_on_activate = false,",
  ] : [
    `monitor = "${visibleMonitorName}",`,
    "float = true,", "center = true,",
    "no_initial_focus = false,", "no_focus = false,",
    "no_follow_mouse = false,", "focus_on_activate = true,",
  ];
  return [
    `if ${BG3_HEADLESS_RULE_TIMER_GLOBAL} ~= nil then ${BG3_HEADLESS_RULE_TIMER_GLOBAL}:set_timeout(1) end`,
    `if ${BG3_HEADLESS_RULE_GLOBAL} ~= nil then ${BG3_HEADLESS_RULE_GLOBAL}:set_enabled(false) end`,
    `${BG3_WINDOW_RULE_PROFILES_GLOBAL} = ${BG3_WINDOW_RULE_PROFILES_GLOBAL} or {}`,
    `${BG3_HEADLESS_RULE_GLOBAL} = ${BG3_WINDOW_RULE_PROFILES_GLOBAL}["${profile}"]`,
    `local watchdog_owner = "${runId}"`,
    `${BG3_HEADLESS_RULE_OWNER_GLOBAL} = watchdog_owner`,
    `if ${BG3_HEADLESS_RULE_GLOBAL} == nil or ${BG3_HEADLESS_RULE_GLOBAL}:is_enabled() == nil then`,
    `${BG3_HEADLESS_RULE_GLOBAL} = hl.window_rule({`,
    `name = "bg3-harness-display-${profile}",`,
    'match = { initial_class = "^steam_app_1086940$" },',
    ...gameRules,
    "render_unfocused = true,",
    'group = "barred"',
    "}) else",
    `${BG3_HEADLESS_RULE_GLOBAL}:set_enabled(true) end`,
    `${BG3_WINDOW_RULE_PROFILES_GLOBAL}["${profile}"] = ${BG3_HEADLESS_RULE_GLOBAL}`,
    `if ${BG3_STEAM_RULE_GLOBAL} == nil or ${BG3_STEAM_RULE_GLOBAL}:is_enabled() == nil then`,
    `${BG3_STEAM_RULE_GLOBAL} = hl.window_rule({`,
    'name = "bg3-harness-steam-launch-guard",',
    'match = { initial_class = "^steam$" },',
    "no_initial_focus = true,",
    "no_focus = true,",
    "no_follow_mouse = true,",
    "focus_on_activate = false",
    "}) else",
    `${BG3_STEAM_RULE_GLOBAL}:set_enabled(true) end`,
    `${BG3_HEADLESS_RULE_TIMER_GLOBAL} = hl.timer(function()`,
    `if ${BG3_HEADLESS_RULE_OWNER_GLOBAL} == watchdog_owner then`,
    `if ${BG3_HEADLESS_RULE_GLOBAL} ~= nil then ${BG3_HEADLESS_RULE_GLOBAL}:set_enabled(false) end`,
    `if ${BG3_STEAM_RULE_GLOBAL} ~= nil then ${BG3_STEAM_RULE_GLOBAL}:set_enabled(false) end`,
    `${BG3_HEADLESS_RULE_OWNER_GLOBAL} = nil`,
    `${BG3_HEADLESS_RULE_TIMER_GLOBAL} = nil`,
    "end end,",
    `{ timeout = ${remainingMs}, type = "oneshot" })`,
  ].join(" ");
}

export function bg3HeadlessWindowRuleCleanupExpression(runId: string): string {
  validateRunId(runId);
  return [
    `if ${BG3_HEADLESS_RULE_OWNER_GLOBAL} == "${runId}" then`,
    `if ${BG3_HEADLESS_RULE_GLOBAL} ~= nil then ${BG3_HEADLESS_RULE_GLOBAL}:set_enabled(false) end`,
    `if ${BG3_STEAM_RULE_GLOBAL} ~= nil then ${BG3_STEAM_RULE_GLOBAL}:set_enabled(false) end`,
    `if ${BG3_HEADLESS_RULE_TIMER_GLOBAL} ~= nil then ${BG3_HEADLESS_RULE_TIMER_GLOBAL}:set_timeout(1); ${BG3_HEADLESS_RULE_TIMER_GLOBAL} = nil end`,
    `${BG3_HEADLESS_RULE_OWNER_GLOBAL} = nil`,
    "end",
  ].join(" ");
}

export function bg3HeadlessQuarantineUntilEpochMs(
  expiresAtEpochMs: number,
): number {
  if (!Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs < 0) {
    throw new Error(`Invalid BG3 arm expiry: ${expiresAtEpochMs}`);
  }
  return expiresAtEpochMs +
    BG3_SERVER_FINALIZING_DISCOVERY_GRACE_MS +
    BG3_SERVER_RESULT_DRAIN_MS +
    BG3_HEADLESS_RULE_FINALIZATION_MARGIN_MS;
}

export interface Bg3HeadlessLaunchPreparation<TOutput> {
  createOutput(): Promise<TOutput>;
  installRule(output: TOutput): Promise<void>;
  beforeSpawn(output: TOutput): Promise<void>;
  spawn(output: TOutput): Promise<void>;
  cleanup(output: TOutput): Promise<void>;
}

export async function prepareBg3HeadlessLaunch<TOutput>(
  preparation: Bg3HeadlessLaunchPreparation<TOutput>,
): Promise<TOutput> {
  const output = await preparation.createOutput();
  try {
    await preparation.installRule(output);
    await preparation.beforeSpawn(output);
    await preparation.spawn(output);
    return output;
  } catch (launchError) {
    try {
      await preparation.cleanup(output);
    } catch (cleanupError) {
      throw new AggregateError(
        [launchError, cleanupError],
        "BG3 headless launch preparation and cleanup both failed",
      );
    }
    throw launchError;
  }
}

export async function waitForStableNewBg3Save(
  options: StableNewBg3SaveOptions,
): Promise<string> {
  const deadline = options.now() + options.timeoutMs;
  let stable:
    | { identity: SaveFileIdentity; observedAtMs: number }
    | undefined;
  do {
    await options.assertGameRunning();
    const saveId = singleNewBg3SaveId(
      options.before,
      await options.readSaveIds(),
    );
    if (saveId !== undefined) {
      const identity = await options.inspectSave(saveId);
      if (identity !== undefined) {
        if (identity.modifiedAtMs < options.minimumModifiedAtMs) {
          throw new Error(`New BG3 save predates the test launch: ${saveId}`);
        }
        const now = options.now();
        if (
          stable?.identity.id === identity.id &&
          stable.identity.lsvPath === identity.lsvPath &&
          stable.identity.size === identity.size &&
          stable.identity.modifiedAtMs === identity.modifiedAtMs
        ) {
          if (now - stable.observedAtMs >= options.stabilityMs) {
            return identity.id;
          }
        } else {
          stable = { identity, observedAtMs: now };
        }
      } else {
        stable = undefined;
      }
    } else {
      stable = undefined;
    }
    await options.sleep(options.pollMs);
  } while (options.now() < deadline);

  throw new Bg3TestTimeoutError(
    `Timed out after ${options.timeoutMs} ms waiting for one stable new BG3 save`,
  );
}

export function assertBg3SaveRequestMatchesAcknowledgement(
  request: Bg3SaveRequest,
  acknowledgement: { intentId: string; acknowledgedAtEpochMs: number },
): void {
  if (request.intentId !== acknowledgement.intentId) {
    throw new Bg3TestProtocolError(
      "BG3 save request does not match acknowledged intent",
    );
  }
  if (request.requestedAtEpochMs < acknowledgement.acknowledgedAtEpochMs) {
    throw new Bg3TestProtocolError(
      "BG3 save request predates its acknowledgement",
    );
  }
}

export async function waitForBg3ClientReady(
  options: Bg3ClientReadyWaitOptions,
): Promise<void> {
  const deadline = options.now() + options.timeoutMs;
  do {
    await options.assertGameRunning();
    const acknowledgement = await options.readAcknowledgement();
    if (acknowledgement !== undefined) {
      if (acknowledgement.size > options.maxBytes) {
        throw new Error(
          `BG3 client readiness exceeds ${options.maxBytes} bytes`,
        );
      }
      if (acknowledgement.size > 0) {
        parseBg3TestClientReady(acknowledgement.contents, {
          runId: options.runId,
          scenarioId: options.scenarioId,
          mode: "character-creation",
          createdAtEpochMs: options.createdAtEpochMs,
          expiresAtEpochMs: options.expiresAtEpochMs,
        });
        return;
      }
    }
    await options.sleep(options.pollMs);
  } while (options.now() < deadline);

  throw new Bg3TestTimeoutError(
    `Timed out after ${options.timeoutMs} ms waiting for the character-creation client`,
  );
}

export async function waitForBg3ModLoad(
  options: Bg3ModLoadWaitOptions,
): Promise<void> {
  const deadline = options.now() + options.timeoutMs;
  let lastProtocolError: Bg3TestProtocolError | undefined;
  let autosaveGuardValidated = false;
  let modLoadValidated = false;
  let stableModLoad: {
    firstObservedAtEpochMs: number;
    lastObservedAtEpochMs: number;
    signature: string;
  } | undefined;
  do {
    const startupError = await options.readStartupError();
    if (startupError !== undefined) {
      if (startupError.size > options.maxBytes) {
        throw new Error(
          `BG3 startup error result exceeds ${options.maxBytes} bytes`,
        );
      }
      if (startupError.size > 0 && containsValidJson(startupError.contents)) {
        try {
          const result = parseBg3TestResult(startupError.contents, {
            runId: options.runId,
            scenarioId: options.scenarioId,
            createdAtEpochMs: options.createdAtEpochMs,
            expiresAtEpochMs: options.expiresAtEpochMs,
          });
          if (
            result.error?.code === "autosave-guard-unavailable" ||
            result.error?.code === "autosave-guard-lost"
          ) {
            throw new Bg3TestProtocolError(
              `BG3 autosave guard failed closed: ${result.error.code}: ${result.error.message}`,
            );
          }
        } catch (error) {
          if (
            error instanceof Bg3TestProtocolError &&
            error.message.startsWith("BG3 autosave guard failed closed:")
          ) {
            throw error;
          }
        }
      }
    }
    await options.assertGameRunning();
    const guard = autosaveGuardValidated
      ? undefined
      : await options.readAutosaveGuard();
    if (guard !== undefined) {
      if (guard.size > options.maxBytes) {
        throw new Error(
          `BG3 autosave guard exceeds ${options.maxBytes} bytes`,
        );
      }
      if (guard.size > 0) {
        try {
          parseBg3AutosaveGuard(guard.contents, {
            runId: options.runId,
            scenarioId: options.scenarioId,
            createdAtEpochMs: options.createdAtEpochMs,
            expiresAtEpochMs: options.expiresAtEpochMs,
          });
          autosaveGuardValidated = true;
        } catch (error) {
          if (!(error instanceof Bg3TestProtocolError)) throw error;
          lastProtocolError = error;
        }
      }
    }

    const observation = modLoadValidated
      ? undefined
      : await options.readObservation();
    if (observation !== undefined) {
      if (observation.size > options.maxBytes) {
        throw new Error(
          `BG3 mod-load observation exceeds ${options.maxBytes} bytes`,
        );
      }
      if (observation.size > 0) {
        try {
          const parsed = parseBg3TestModLoad(
            observation.contents,
            {
              runId: options.runId,
              scenarioId: options.scenarioId,
              createdAtEpochMs: options.createdAtEpochMs,
              expiresAtEpochMs: options.expiresAtEpochMs,
            },
            options.requiredMods,
          );
          const signature = parsed.loadOrder.join(",");
          if (stableModLoad?.signature !== signature) {
            stableModLoad = {
              firstObservedAtEpochMs: parsed.observedAtEpochMs,
              lastObservedAtEpochMs: parsed.observedAtEpochMs,
              signature,
            };
          } else if (
            parsed.observedAtEpochMs > stableModLoad.lastObservedAtEpochMs
          ) {
            stableModLoad.lastObservedAtEpochMs = parsed.observedAtEpochMs;
          }
          if (
            stableModLoad.lastObservedAtEpochMs -
                stableModLoad.firstObservedAtEpochMs >= options.stabilityMs
          ) {
            modLoadValidated = true;
          }
          lastProtocolError = undefined;
        } catch (error) {
          if (!(error instanceof Bg3TestProtocolError)) throw error;
          lastProtocolError = error;
        }
      }
    }
    if (autosaveGuardValidated && modLoadValidated) return;
    await options.sleep(options.pollMs);
  } while (options.now() < deadline);

  if (lastProtocolError !== undefined) throw lastProtocolError;
  throw new Bg3TestTimeoutError(
    `Timed out after ${options.timeoutMs} ms waiting for the builtin mod-load observation`,
  );
}

function containsValidJson(contents: string): boolean {
  try {
    JSON.parse(contents);
    return true;
  } catch {
    return false;
  }
}

type DeferredArtifact =
  | { kind: "contents"; contents: string }
  | { kind: "error"; error: unknown };

export async function waitForBg3Result(
  options: Bg3ResultWaitOptions,
): Promise<string> {
  const startedAt = options.now();
  const baseDeadline = Math.min(
    startedAt + options.timeoutMs,
    options.expiresAtEpochMs,
  );
  const discoveryDeadline =
    baseDeadline + options.finalizingDiscoveryGraceMs;
  const fallbackNotBefore = Math.min(
    baseDeadline,
    startedAt + Math.max(0, options.startupGraceMs),
  );
  const expected = {
    runId: options.runId,
    scenarioId: options.scenarioId,
    createdAtEpochMs: options.createdAtEpochMs,
    expiresAtEpochMs: options.expiresAtEpochMs,
  };
  let finalizingObservedAt: number | undefined;
  let serverObserved = false;
  let serverReadyValidated = false;
  let lastServerError: unknown;
  let pendingFallback: DeferredArtifact | undefined;
  let observedIntentId: string | undefined;
  let intentHandled = false;

  const observeServerArtifact = async (
    name: "server-ready.json" | "server-finalizing.json",
  ): Promise<Bg3ClientReadyFile | undefined> => {
    try {
      const artifact = await options.readArtifact(name);
      if (artifact === undefined) return undefined;
      serverObserved = true;
      if (artifact.size > options.maxBytes) {
        lastServerError = new Error(
          `BG3 ${name} exceeds ${options.maxBytes} bytes`,
        );
        return undefined;
      }
      return artifact;
    } catch (error) {
      serverObserved = true;
      lastServerError = error;
      return undefined;
    }
  };

  const readFallback = async (
    name: "client-error.json" | "startup-error.json",
  ): Promise<DeferredArtifact | undefined> => {
    try {
      const artifact = await options.readArtifact(name);
      if (artifact === undefined) return undefined;
      if (artifact.size > options.maxBytes) {
        const label = name === "client-error.json"
          ? "BG3 client error result"
          : "BG3 startup error result";
        return {
          kind: "error",
          error: new Error(
            `${label} exceeds ${options.maxBytes} bytes`,
          ),
        };
      }
      return { kind: "contents", contents: artifact.contents };
    } catch (error) {
      return { kind: "error", error };
    }
  };

  const observeFinalizing = async (): Promise<void> => {
    const finalizing = await observeServerArtifact("server-finalizing.json");
    if (finalizing === undefined || !containsValidJson(finalizing.contents)) {
      return;
    }
    try {
      parseBg3ServerFinalizing(finalizing.contents, expected);
      if (finalizingObservedAt === undefined) {
        finalizingObservedAt = options.now();
        try { await options.onServerFinalizing?.(); } catch { /* Observations cannot alter result acceptance. */ }
      }
    } catch (error) {
      lastServerError = error;
    }
  };

  const readPrimary = async (): Promise<string | undefined> => {
    let primary: Bg3ClientReadyFile | undefined;
    try {
      primary = await options.readArtifact("result.json");
    } catch (error) {
      serverObserved = true;
      lastServerError = error;
      return undefined;
    }
    if (primary === undefined) return undefined;
    serverObserved = true;
    if (primary.size > options.maxBytes) {
      throw new Error(
        `BG3 test result exceeds ${options.maxBytes} bytes`,
      );
    }
    if (containsValidJson(primary.contents)) return primary.contents;
    lastServerError = new Bg3TestProtocolError(
      "BG3 test result is not valid JSON",
    );
    return undefined;
  };

  while (true) {
    const primary = await readPrimary();
    if (primary !== undefined) return primary;

    let now = options.now();
    if (now >= baseDeadline) {
      if (finalizingObservedAt === undefined && now <= discoveryDeadline) {
        await observeFinalizing();
        now = options.now();
      }
      const drainAnchor = Math.max(
        discoveryDeadline,
        finalizingObservedAt ?? discoveryDeadline,
      );
      const activeDeadline = drainAnchor + options.resultDrainMs;
      if (now >= activeDeadline) break;
      await options.sleep(Math.min(options.pollMs, activeDeadline - now));
      continue;
    }

    const ready = await observeServerArtifact("server-ready.json");
    if (ready !== undefined && containsValidJson(ready.contents)) {
      try {
        parseBg3ServerReady(ready.contents, expected);
        serverReadyValidated = true;
      } catch (error) {
        lastServerError = error;
      }
    }

    await observeFinalizing();

    try {
      const saveIntentArtifact = await options.readArtifact("save-intent.json");
      if (saveIntentArtifact !== undefined) {
        serverObserved = true;
        if (saveIntentArtifact.size > options.maxBytes) {
          throw new Error(
            `BG3 save-intent.json exceeds ${options.maxBytes} bytes`,
          );
        }
        if (containsValidJson(saveIntentArtifact.contents)) {
          const intent = parseBg3SaveIntent(
            saveIntentArtifact.contents,
            expected,
          );
          if (
            observedIntentId !== undefined &&
            observedIntentId !== intent.intentId
          ) {
            throw new Bg3TestProtocolError(
              `Run ${options.runId} produced more than one save intent`,
            );
          }
          observedIntentId ??= intent.intentId;
          if (!intentHandled) {
            await options.onSaveIntent?.(intent);
            intentHandled = true;
          }
        }
      }
    } catch (error) {
      serverObserved = true;
      lastServerError = error;
    }

    if (!serverObserved) {
      const fallback = await readFallback("client-error.json") ??
        await readFallback("startup-error.json");
      if (fallback !== undefined) pendingFallback = fallback;
    } else {
      pendingFallback = undefined;
    }

    try {
      await options.assertGameRunning();
    } catch (processError) {
      if (!serverObserved && pendingFallback !== undefined) {
        const exitObservedAt = options.now();
        if (exitObservedAt >= fallbackNotBefore) {
          if (pendingFallback.kind === "error") throw pendingFallback.error;
          return pendingFallback.contents;
        }
        await options.sleep(
          Math.min(options.pollMs, fallbackNotBefore - exitObservedAt),
        );
        continue;
      }
      throw lastServerError ?? processError;
    }

    if (serverReadyValidated && finalizingObservedAt === undefined && options.now() < baseDeadline) {
      await options.onClientInput?.();
    }
    now = options.now();
    if (now >= baseDeadline) continue;
    await options.sleep(Math.min(options.pollMs, baseDeadline - now));
  }

  if (!serverObserved && pendingFallback !== undefined) {
    if (pendingFallback.kind === "error") throw pendingFallback.error;
    return pendingFallback.contents;
  }
  if (lastServerError !== undefined) throw lastServerError;
  throw new Bg3TestTimeoutError(
    `Timed out after ${options.timeoutMs} ms waiting for result for ${options.runId}`,
  );
}

async function spawnDetachedCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [...arguments_],
      {
        detached: false,
        shell: false,
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function spawnSteamClient(steamBinary: string): Promise<void> {
  await spawnDetachedCommand(steamBinary, steamClientStartArguments());
}

export interface Bg3SteamCloudPreparationState {
  prepared: boolean;
}

export async function prepareBg3SteamCloudForLaunch(
  steamCloud: Bg3SteamCloudManager,
  runId: string,
  state: Bg3SteamCloudPreparationState,
): Promise<void> {
  try {
    await steamCloud.prepare(runId);
    state.prepared = true;
  } catch (preparationError) {
    try {
      state.prepared = await steamCloud.hasPendingTransaction();
    } catch (inspectionError) {
      throw new AggregateError(
        [preparationError, inspectionError],
        "Steam Cloud preparation failed and its recovery state could not be inspected",
      );
    }
    throw preparationError;
  }
}

async function runHyprctl(arguments_: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "hyprctl",
      [...arguments_],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        timeout: WINDOW_FOCUS_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(
            new Error(`hyprctl ${arguments_[0] ?? "command"} failed`, {
              cause: error,
            }),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseHyprlandWindow(value: unknown): HyprlandWindow | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.address !== "string" ||
    !/^0x[0-9a-f]+$/i.test(candidate.address) ||
    typeof candidate.stableId !== "string" ||
    !/^[0-9a-f]+$/i.test(candidate.stableId) ||
    typeof candidate.pid !== "number" ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0
  ) {
    return undefined;
  }
  const workspace = candidate.workspace;
  const workspaceName =
    workspace !== null &&
    typeof workspace === "object" &&
    typeof (workspace as Record<string, unknown>).name === "string"
      ? (workspace as Record<string, unknown>).name as string
      : undefined;
  const monitorId =
    typeof candidate.monitor === "number" &&
    Number.isSafeInteger(candidate.monitor)
      ? candidate.monitor
      : undefined;
  const groupedAddresses = Array.isArray(candidate.grouped)
    ? candidate.grouped.filter(
        (address): address is string =>
          typeof address === "string" && /^0x[0-9a-f]+$/i.test(address),
      )
    : [];
  return {
    address: candidate.address,
    stableId: candidate.stableId,
    pid: candidate.pid,
    mapped: candidate.mapped !== false,
    hidden: candidate.hidden === true,
    groupedAddresses,
    ...(workspaceName === undefined ? {} : { workspaceName }),
    ...(monitorId === undefined ? {} : { monitorId }),
    ...(typeof candidate.class === "string" ? { className: candidate.class } : {}),
    ...(typeof candidate.initialClass === "string" ? { initialClassName: candidate.initialClass } : {}),
    ...(typeof candidate.acceptsInput === "boolean" ? { acceptsInput: candidate.acceptsInput } : {}),
  };
}

function parseHyprlandMonitors(raw: string): HyprlandMonitor[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("hyprctl monitors returned an unexpected response");
  }
  return parsed.map((value) => {
    if (value === null || typeof value !== "object") {
      throw new Error("hyprctl monitors returned an invalid monitor");
    }
    const candidate = value as Record<string, unknown>;
    const activeWorkspace = candidate.activeWorkspace;
    if (
      typeof candidate.id !== "number" ||
      !Number.isSafeInteger(candidate.id) ||
      typeof candidate.name !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(candidate.name) ||
      activeWorkspace === null ||
      typeof activeWorkspace !== "object" ||
      typeof (activeWorkspace as Record<string, unknown>).id !== "number" ||
      !Number.isSafeInteger(
        (activeWorkspace as Record<string, unknown>).id as number,
      ) ||
      typeof (activeWorkspace as Record<string, unknown>).name !== "string"
    ) {
      throw new Error("hyprctl monitors returned an invalid monitor");
    }
    return {
      id: candidate.id,
      name: candidate.name,
      activeWorkspaceId:
        (activeWorkspace as Record<string, unknown>).id as number,
      activeWorkspaceName:
        (activeWorkspace as Record<string, unknown>).name as string,
      focused: candidate.focused === true,
      physicalWidth: typeof candidate.physicalWidth === "number" ? candidate.physicalWidth : 0,
      physicalHeight: typeof candidate.physicalHeight === "number" ? candidate.physicalHeight : 0,
    };
  });
}

async function hyprlandWindows(): Promise<HyprlandWindow[]> {
  const raw = await runHyprctl(["clients", "-j"]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("hyprctl clients returned an unexpected response");
  }
  return parsed
    .map((value) => parseHyprlandWindow(value))
    .filter((value): value is HyprlandWindow => value !== undefined);
}

async function hyprlandMonitors(): Promise<HyprlandMonitor[]> {
  return parseHyprlandMonitors(await runHyprctl(["monitors", "-j"]));
}

export function parseHyprlandDesktopLocked(raw: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("hyprctl locked returned an invalid JSON response");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || typeof (value as Record<string, unknown>).locked !== "boolean") {
    throw new Error("hyprctl locked returned an invalid desktop lock state");
  }
  return (value as { locked: boolean }).locked;
}

async function hyprlandDesktopLocked(): Promise<boolean> {
  return parseHyprlandDesktopLocked(await runHyprctl(["locked", "-j"]));
}

async function hyprlandWorkspaces(): Promise<HyprlandWorkspace[]> {
  const raw = await runHyprctl(["workspaces", "-j"]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("hyprctl workspaces returned an unexpected response");
  }
  return parsed.map((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as Record<string, unknown>).name !== "string"
    ) {
      throw new Error("hyprctl workspaces returned an invalid workspace");
    }
    return { name: (value as Record<string, unknown>).name as string };
  });
}

export function isMappedBg3WindowCandidate(
  window: { pid: number; mapped: boolean; acceptsInput?: boolean },
  processId: number,
): boolean {
  return window.pid === processId && window.mapped;
}

function creationPlanMatches(
  actual: Bg3TestArm | Bg3TestCommand,
  scenario: Bg3TestScenario,
): boolean {
  if (scenario.launch.kind === "runtime") {
    return !("creationPlan" in actual);
  }
  if (!("creationPlan" in actual)) return false;
  const expected = scenario.launch.creationPlan;
  const plan = actual.creationPlan;
  return (
    plan.kind === expected.kind &&
    plan.backgroundUuid === expected.backgroundUuid &&
    plan.backgroundName === expected.backgroundName &&
    plan.classUuid === expected.classUuid &&
    plan.raceUuid === expected.raceUuid &&
    plan.subRaceUuid === expected.subRaceUuid &&
    plan.racePassiveId === expected.racePassiveId &&
    (plan.racePassiveId === undefined ||
      (plan.raceUuid !== undefined && isValidBg3RacePassiveId(plan.racePassiveId))) &&
    plan.requiredTransitionModUuid === expected.requiredTransitionModUuid
  );
}

function sameStringArray(
  actual: unknown,
  expected: readonly string[],
): boolean {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) =>
      typeof value === "string" && value === expected[index]
    );
}

function wireTargetMatchesScenario(
  target: Bg3TestArm | Bg3TestCommand,
  scenario: Bg3TestScenario,
): boolean {
  return (
    target.schemaVersion === 2 &&
    Number.isSafeInteger(target.createdAtEpochMs) &&
    Number.isSafeInteger(target.expiresAtEpochMs) &&
    Number.isSafeInteger(target.timeoutMs) &&
    target.timeoutMs > 0 &&
    target.expiresAtEpochMs - target.createdAtEpochMs === target.timeoutMs &&
    Date.parse(target.createdAt) === target.createdAtEpochMs &&
    Date.parse(target.expiresAt) === target.expiresAtEpochMs &&
    target.scenarioId === scenario.id &&
    target.mode === scenarioMode(scenario) &&
    target.saveId === scenarioSaveId(scenario) &&
    target.savePolicy === scenario.savePolicy &&
    sameStringArray(
      target.requiredAssertionIds,
      scenario.requiredAssertionIds,
    ) &&
    creationPlanMatches(target, scenario)
  );
}

export async function inspectNewBg3Save(
  saveRoot: string,
  saveId: string,
): Promise<SaveFileIdentity | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(saveId)) {
    throw new Error(`Unsafe new BG3 save ID: ${saveId}`);
  }
  const saveDirectory = path.join(saveRoot, saveId);
  const files = await readdir(saveDirectory, { withFileTypes: true });
  const lsvFiles = files.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".lsv"),
  );
  if (lsvFiles.length !== 1) return undefined;
  const lsvFile = lsvFiles[0];
  if (lsvFile === undefined) return undefined;
  const lsvPath = path.join(saveDirectory, lsvFile.name);
  const metadata = await stat(lsvPath);
  if (!metadata.isFile() || metadata.size <= 0) return undefined;
  return {
    id: saveId,
    lsvPath,
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedAtMs: metadata.mtimeMs,
  };
}

async function assertRuntimeFixtureLsvHash(
  saveRoot: string,
  saveId: string,
  expectedSha256: string,
): Promise<void> {
  let identity: SaveFileIdentity | undefined;
  try {
    identity = await inspectNewBg3Save(saveRoot, saveId);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `BG3 runtime fixture is missing: ${saveId}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (identity === undefined) {
    throw new Error(
      `BG3 runtime fixture must contain exactly one non-empty LSV: ${saveId}`,
    );
  }

  const contents = await readFile(identity.lsvPath);
  const verifiedIdentity = await inspectNewBg3Save(saveRoot, saveId);
  if (
    verifiedIdentity === undefined ||
    !sameSaveFileIdentity(identity, verifiedIdentity)
  ) {
    throw new Error(
      `BG3 runtime fixture changed while its hash was verified: ${saveId}`,
    );
  }
  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `BG3 runtime fixture hash mismatch for ${saveId}: expected ${expectedSha256}, observed ${actualSha256}`,
    );
  }
}

export function createNodeBg3TestPlatform(
  options: NodeBg3TestPlatformOptions,
): Bg3TestPlatform {
  const catalog = options.catalog;
  const protectedSaves = options.protectedSaves ?? { ids: [], prefixes: [] };
  const steamCloudSyncTimeoutMs =
    options.steamCloudSyncTimeoutMs ?? STEAM_CLOUD_SYNC_TIMEOUT_MS;
  const steamCloudSaveAuditMs =
    options.steamCloudSaveAuditMs ?? STEAM_CLOUD_SAVE_AUDIT_MS;
  if (
    !Number.isSafeInteger(steamCloudSyncTimeoutMs) ||
    steamCloudSyncTimeoutMs < 1 ||
    steamCloudSyncTimeoutMs > STEAM_CLOUD_SYNC_TIMEOUT_MS ||
    !Number.isSafeInteger(steamCloudSaveAuditMs) ||
    steamCloudSaveAuditMs < 0 ||
    steamCloudSaveAuditMs > STEAM_CLOUD_SAVE_AUDIT_MS
  ) {
    throw new Error("Steam Cloud settlement timing options are invalid");
  }
  const userRoot = options.userRoot ?? os.homedir();
  const workRoot = options.workRoot ?? process.cwd();
  const packageRoot = options.packageRoot ?? harnessPackageRoot;
  const readDesktopLocked = options.readDesktopLocked ?? hyprlandDesktopLocked;
  const steamRoot = options.steamRoot ?? path.join(userRoot, ".local", "share", "Steam");
  const gameRoot = path.join(
    steamRoot,
    "steamapps",
    "common",
    "Baldurs Gate 3",
  );
  const localAppData = path.join(
    steamRoot,
    "steamapps",
    "compatdata",
    STEAM_APP_ID,
    "pfx",
    "drive_c",
    "users",
    "steamuser",
    "AppData",
    "Local",
    "Larian Studios",
    "Baldur's Gate 3",
  );
  const harnessRoot = path.join(
    localAppData,
    "Script Extender",
    BG3_HARNESS_DIRECTORY,
    "TestHarness",
  );
  const builtinBridge = createBg3BuiltinBridgeManager({
    settingsPath: path.join(gameRoot, "bin", "ScriptExtenderSettings.json"),
    harnessRoot,
    bridgeSourcePath: path.join(
      packageRoot,
      "bridge",
      "client-startup-bridge.lua",
    ),
    windowsHarnessRoot:
      `C:/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/${BG3_HARNESS_DIRECTORY}/TestHarness`,
  });
  const modSettings = createBg3ModSettingsManager({
    settingsPath: path.join(
      localAppData,
      "PlayerProfiles",
      "Public",
      "modsettings.lsx",
    ),
    modsRoot: path.join(localAppData, "Mods"),
    harnessRoot,
    entries: options.modSettings.entries,
    ...(options.modSettings.preloadModuleUuids === undefined
      ? {}
      : { preloadModuleUuids: options.modSettings.preloadModuleUuids }),
  });
  const steamCloud = options.steamCloudManager ?? createBg3SteamCloudManager({
    harnessRoot,
    executor: createSteamCloudHelperExecutor({
      helperPath: path.join(
        workRoot,
        ".cache",
        "tools",
        "steam-cloud-helper",
      ),
      buildScriptPath: path.join(
        packageRoot,
        "steam-cloud-helper",
        "build.sh",
      ),
      // Steam stopped shipping steamrt64/libsteam_api.so in its October 2026
      // client update; BG3_STEAM_API_LIBRARY points at a Steamworks copy.
      steamApiLibraryPath:
        options.steamApiLibraryPath ||
        process.env.BG3_STEAM_API_LIBRARY ||
        path.join(steamRoot, "steamrt64", "libsteam_api.so"),
      startClient: async () => spawnSteamClient("steam"),
    }),
  });
  const armPath = path.join(harnessRoot, "arm.json");
  const lockRoot = path.join(harnessRoot, "active.lock");
  const lockGuardPath = path.join(harnessRoot, "active.lock.guard");
  const saveRoot = path.join(
    localAppData,
    "PlayerProfiles",
    "Public",
    "Savegames",
    "Story",
  );
  const steamCloudLogPath = path.join(steamRoot, "logs", "cloud_log.txt");
  const steamCloudSettlementPath = path.join(
    harnessRoot,
    STEAM_CLOUD_SETTLEMENT_FILE_NAME,
  );
  const modCrashSanityCheckPath = path.join(
    localAppData,
    "ModCrashSanityCheck",
  );
  let activeLaunch: ActiveLaunch | undefined;
  let pendingLaunch: PendingLaunch | undefined;
  let headlessOutput: HeadlessOutput | undefined;
  let headlessRuleRunId: string | undefined;
  let armedRun: Bg3TestArm | undefined;
  let issuedCommand: Bg3TestCommand | undefined;
  let lockOwnerStartTimeTicks: string | undefined;
  const engineLogArchives = new Map<string, Bg3EngineLogArchive>();
  const launcherObservations = new Map<string, Bg3LauncherObservation>();
  const windowDiagnostics = new Map<string, ReturnType<typeof createBg3WindowDiagnostics>>();

  function throwIfInterrupted(): void {
    if (options.signal?.aborted !== true) return;
    const reason = options.signal.reason;
    throw new Bg3TestInterruptedError(
      typeof reason === "string" && reason !== ""
        ? `BG3 test interrupted by ${reason}`
        : "BG3 test interrupted",
    );
  }

  async function waitForSteamAppSessionExit(phase: string): Promise<void> {
    let emptySinceEpochMs: number | undefined;
    let latestProcesses: LaunchedGame[] = [];
    const settled = await waitUntil(async () => {
      latestProcesses = await listSteamAppProcesses();
      if (latestProcesses.length > 0) {
        emptySinceEpochMs = undefined;
        return false;
      }
      emptySinceEpochMs ??= Date.now();
      return Date.now() - emptySinceEpochMs >= STEAM_APP_EXIT_STABILITY_MS;
    }, STEAM_APP_EXIT_TIMEOUT_MS);
    if (!settled) {
      throw new Bg3TestTimeoutError(
        `Timed out after ${STEAM_APP_EXIT_TIMEOUT_MS} ms waiting for Steam AppID ${STEAM_APP_ID} to exit before ${phase}; remaining PIDs: ${latestProcesses.map(({ pid }) => pid).join(", ") || "unknown"}`,
      );
    }
  }

  async function captureSteamCloudLogCursor(): Promise<SteamCloudLogCursor> {
    try {
      const metadata = await stat(steamCloudLogPath);
      if (!metadata.isFile()) {
        throw new Error(`Steam Cloud log is not a file: ${steamCloudLogPath}`);
      }
      return {
        device: metadata.dev,
        inode: metadata.ino,
        size: metadata.size,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { size: 0 };
      throw error;
    }
  }

  async function waitForSteamCloudExitSync(
    cursor: SteamCloudLogCursor,
    phase: string,
    expectedSaveSnapshot: Bg3SaveIdentitySnapshot,
  ): Promise<void> {
    let observation: Bg3SteamCloudExitSyncObservation = {
      started: false,
      autoCloudComplete: false,
      uploadComplete: false,
    };
    const completed = await waitUntil(async () => {
      assertNoBg3SaveChanges(
        expectedSaveSnapshot,
        await snapshotBg3SaveIdentities(saveRoot),
        `while Steam AutoCloud ran during ${phase}`,
      );
      observation = inspectBg3SteamCloudExitSync(
        await readSteamCloudLogAfter(steamCloudLogPath, cursor),
      );
      if (observation.failure !== undefined) {
        throw new Error(
          `Steam AutoCloud failed during ${phase}: ${observation.failure}`,
        );
      }
      return observation.started &&
        observation.autoCloudComplete &&
        observation.uploadComplete;
    }, steamCloudSyncTimeoutMs);
    if (!completed) {
      throw new Bg3TestTimeoutError(
        `Timed out after ${steamCloudSyncTimeoutMs} ms waiting for the BG3 Steam AutoCloud exit upload during ${phase}; observed start=${String(observation.started)}, autocloud=${String(observation.autoCloudComplete)}, upload=${String(observation.uploadComplete)}`,
      );
    }
  }

  function parseSteamCloudSettlement(
    raw: string,
  ): SteamCloudSettlementOwner {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("Steam Cloud settlement journal is not valid JSON", {
        cause: error,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Steam Cloud settlement journal is invalid");
    }
    const owner = parsed as Record<string, unknown>;
    if (
      Object.keys(owner).sort().join(",") !==
        "cloudLogPath,expectAutoCloudUpload,expectedSaveSnapshot,logDevice,logInode,logOffset,runId,schemaVersion" ||
      owner.schemaVersion !== STEAM_CLOUD_SETTLEMENT_SCHEMA_VERSION ||
      typeof owner.runId !== "string" ||
      owner.cloudLogPath !== steamCloudLogPath ||
      typeof owner.expectAutoCloudUpload !== "boolean" ||
      !(
        owner.logDevice === null ||
        (typeof owner.logDevice === "number" &&
          Number.isSafeInteger(owner.logDevice) &&
          owner.logDevice >= 0)
      ) ||
      !(
        owner.logInode === null ||
        (typeof owner.logInode === "number" &&
          Number.isSafeInteger(owner.logInode) &&
          owner.logInode >= 0)
      ) ||
      (owner.logDevice === null) !== (owner.logInode === null) ||
      typeof owner.logOffset !== "number" ||
      !Number.isSafeInteger(owner.logOffset) ||
      owner.logOffset < 0 ||
      !Array.isArray(owner.expectedSaveSnapshot) ||
      owner.expectedSaveSnapshot.length > 10_000
    ) {
      throw new Error("Steam Cloud settlement journal is invalid");
    }
    validateRunId(owner.runId);
    const seenPaths = new Set<string>();
    for (const value of owner.expectedSaveSnapshot) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Steam Cloud settlement save snapshot is invalid");
      }
      const identity = value as Record<string, unknown>;
      if (
        Object.keys(identity).sort().join(",") !==
          "device,id,inode,lsvPath,modifiedAtMs,size" ||
        typeof identity.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(identity.id) ||
        typeof identity.lsvPath !== "string" ||
        !path.isAbsolute(identity.lsvPath) ||
        typeof identity.device !== "number" ||
        !Number.isSafeInteger(identity.device) ||
        identity.device < 0 ||
        typeof identity.inode !== "number" ||
        !Number.isSafeInteger(identity.inode) ||
        identity.inode < 0 ||
        typeof identity.size !== "number" ||
        !Number.isSafeInteger(identity.size) ||
        identity.size < 0 ||
        typeof identity.modifiedAtMs !== "number" ||
        !Number.isFinite(identity.modifiedAtMs)
      ) {
        throw new Error("Steam Cloud settlement save snapshot is invalid");
      }
      const relative = path.relative(saveRoot, identity.lsvPath);
      if (
        relative === "" ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !identity.lsvPath.toLowerCase().endsWith(".lsv") ||
        seenPaths.has(identity.lsvPath)
      ) {
        throw new Error("Steam Cloud settlement save snapshot is unsafe");
      }
      seenPaths.add(identity.lsvPath);
    }
    return owner as unknown as SteamCloudSettlementOwner;
  }

  async function loadSteamCloudSettlement(): Promise<
    SteamCloudSettlementOwner | undefined
  > {
    try {
      const metadata = await stat(steamCloudSettlementPath);
      if (!metadata.isFile() || metadata.size > MAX_RESULT_BYTES) {
        throw new Error("Steam Cloud settlement journal has an invalid size");
      }
      return parseSteamCloudSettlement(
        await readFile(steamCloudSettlementPath, "utf8"),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  function settlementSnapshot(
    owner: SteamCloudSettlementOwner,
  ): Bg3SaveIdentitySnapshot {
    return new Map(
      owner.expectedSaveSnapshot.map((identity) => [identity.lsvPath, identity]),
    );
  }

  async function prepareSteamCloudSettlement(
    runId: string,
    expectedSaveSnapshot: Bg3SaveIdentitySnapshot,
  ): Promise<SteamCloudSettlementOwner> {
    const existing = await loadSteamCloudSettlement();
    if (existing !== undefined) {
      if (existing.runId !== runId) {
        throw new Error(
          `Steam Cloud settlement belongs to ${existing.runId}, not ${runId}`,
        );
      }
      return existing;
    }
    const originalEnabled = await steamCloud.pendingOriginalEnabled();
    if (originalEnabled === undefined) {
      throw new Error(
        "Steam Cloud has no pending transaction for settlement preparation",
      );
    }
    const cursor = await captureSteamCloudLogCursor();
    const owner: SteamCloudSettlementOwner = {
      schemaVersion: STEAM_CLOUD_SETTLEMENT_SCHEMA_VERSION,
      runId,
      cloudLogPath: steamCloudLogPath,
      expectAutoCloudUpload: originalEnabled,
      logDevice: cursor.device ?? null,
      logInode: cursor.inode ?? null,
      logOffset: cursor.size,
      expectedSaveSnapshot: serializeSaveSnapshot(expectedSaveSnapshot),
    };
    await writeJsonAtomically(steamCloudSettlementPath, owner);
    return owner;
  }

  async function finishSteamCloudSettlement(
    owner: SteamCloudSettlementOwner,
    phase: string,
    recovery: boolean,
  ): Promise<void> {
    const expectedSaveSnapshot = settlementSnapshot(owner);
    assertNoBg3SaveChanges(
      expectedSaveSnapshot,
      await snapshotBg3SaveIdentities(saveRoot),
      `before ${phase}`,
    );
    const cloudTransactionIsPending =
      await steamCloud.hasPendingTransaction();
    if (cloudTransactionIsPending) {
      await waitForSteamAppSessionExit(phase);
    }
    assertNoBg3ProcessCandidates(
      await listGameProcesses(),
      `${phase} final check`,
    );
    if (cloudTransactionIsPending) {
      const originalEnabled = recovery
        ? await steamCloud.recover()
        : await steamCloud.restore(owner.runId);
      if (originalEnabled !== owner.expectAutoCloudUpload) {
        throw new Error(
          "Steam Cloud restored a state that does not match its settlement journal",
        );
      }
    }
    if (owner.expectAutoCloudUpload) {
      await waitForSteamCloudExitSync({
        ...(owner.logDevice === null ? {} : { device: owner.logDevice }),
        ...(owner.logInode === null ? {} : { inode: owner.logInode }),
        size: owner.logOffset,
      }, phase, expectedSaveSnapshot);
    }
    await auditUnchangedSavesAfterCloud(
      expectedSaveSnapshot,
      `while Steam AutoCloud settled after ${phase}`,
    );
    await rm(steamCloudSettlementPath, { force: true });
    const directory = await open(path.dirname(steamCloudSettlementPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async function restoreSteamCloud(
    runId: string,
    phase: string,
    expectedSaveSnapshot: Bg3SaveIdentitySnapshot,
  ): Promise<void> {
    const owner = await prepareSteamCloudSettlement(
      runId,
      expectedSaveSnapshot,
    );
    await finishSteamCloudSettlement(owner, phase, false);
  }

  async function recoverSteamCloud(
    runId: string,
    phase: string,
    expectedSaveSnapshot: Bg3SaveIdentitySnapshot,
  ): Promise<boolean> {
    const existing = await loadSteamCloudSettlement();
    if (
      existing === undefined &&
      !(await steamCloud.hasPendingTransaction())
    ) {
      return false;
    }
    const owner = existing ?? await prepareSteamCloudSettlement(
      runId,
      expectedSaveSnapshot,
    );
    await finishSteamCloudSettlement(owner, phase, true);
    return true;
  }

  async function auditUnchangedSavesAfterCloud(
    before: Bg3SaveIdentitySnapshot,
    phase: string,
  ): Promise<void> {
    await auditBg3SavePostconditionForDuration({
      durationMs: steamCloudSaveAuditMs,
      pollMs: PROCESS_POLL_MS,
      now: Date.now,
      sleep: async (durationMs) => wait(durationMs),
      readSnapshot: async () => snapshotBg3SaveIdentities(saveRoot),
      assertSnapshot: (snapshot) => {
        assertNoBg3SaveChanges(before, snapshot, phase);
      },
    });
  }

  async function verifiedActiveSaveSnapshot(
    launch: ActiveLaunch,
    phase: string,
  ): Promise<Bg3SaveIdentitySnapshot> {
    const snapshot = await snapshotBg3SaveIdentities(saveRoot);
    if (launch.mode === "runtime") {
      assertNoBg3SaveChanges(
        launch.saveSnapshotBeforeLaunch,
        snapshot,
        phase,
      );
    } else {
      assertBg3CreationSavePostcondition(
        launch.saveSnapshotBeforeLaunch,
        snapshot,
        launch.validatedSave,
        phase,
      );
    }
    return snapshot;
  }

  function runRoot(runId: string): string {
    validateRunId(runId);
    return path.join(harnessRoot, "runs", runId);
  }

  async function assertLaunchRunning(
    launch: ActiveLaunch,
    message: string,
  ): Promise<void> {
    throwIfInterrupted();
    await engineLogArchives.get(launch.runId)?.assertNoCrash();
    const current = await readProcessIdentity(launch.processIdentity.pid);
    if (current?.startTimeTicks !== launch.processIdentity.startTimeTicks) {
      await launch.windowDiagnostics?.capture("terminal-observation", "process-identity-unavailable");
      throw new Error(message);
    }
  }

  async function assertOnlyActiveGameProcess(
    launch: ActiveLaunch,
    phase: string,
  ): Promise<void> {
    const candidates = await listGameProcesses();
    if (
      candidates.length !== 1 ||
      candidates[0]?.pid !== launch.processIdentity.pid ||
      candidates[0]?.startTimeTicks !== launch.processIdentity.startTimeTicks
    ) {
      throw new Error(
        `Refusing ${phase} unless registered BG3 PID ${launch.processIdentity.pid} is the only BG3 process; observed ${candidates.map(({ pid }) => pid).join(", ") || "none"}`,
      );
    }
  }

  async function readRunArtifact(
    runId: string,
    name: string,
  ): Promise<Bg3ClientReadyFile | undefined> {
    const filePath = path.join(runRoot(runId), name);
    try {
      const metadata = await stat(filePath);
      if (metadata.size > MAX_RESULT_BYTES) {
        return { size: metadata.size, contents: "" };
      }
      if (metadata.size === 0) return { size: 0, contents: "" };
      const contents = await readFile(filePath);
      if (contents.byteLength > MAX_RESULT_BYTES) {
        return { size: contents.byteLength, contents: "" };
      }
      return { size: contents.byteLength, contents: contents.toString("utf8") };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function acknowledgeSaveIntent(intent: Bg3SaveIntent): Promise<void> {
    const launch = activeLaunch;
    const arm = armedRun;
    if (arm !== undefined && !bg3ArmPermitsTestSave(arm)) {
      throw new Bg3TestProtocolError(
        `Refusing to acknowledge a save intent for run ${arm.runId}, which never saves`,
      );
    }
    if (
      launch === undefined ||
      launch.runId !== intent.runId ||
      launch.mode !== "character-creation" ||
      arm === undefined ||
      arm.runId !== intent.runId ||
      arm.scenarioId !== intent.scenarioId ||
      arm.mode !== "character-creation"
    ) {
      throw new Error("Cannot acknowledge save intent outside character creation");
    }
    if (launch.saveIntent !== undefined) {
      if (launch.saveIntent.intentId !== intent.intentId) {
        throw new Bg3TestProtocolError(
          `Run ${intent.runId} produced more than one save intent`,
        );
      }
      return;
    }

    const snapshotAtAck = await snapshotBg3SaveIdentities(saveRoot);
    assertNoBg3SaveChanges(
      launch.saveSnapshotBeforeLaunch,
      snapshotAtAck,
      "before save intent",
    );
    const acknowledgedAtEpochMs = Date.now();
    const acknowledgement = {
      schemaVersion: 2 as const,
      runId: intent.runId,
      scenarioId: intent.scenarioId,
      status: "acknowledged" as const,
      intentId: intent.intentId,
      acknowledgedAtEpochMs,
    };
    parseBg3SaveIntentAck(JSON.stringify(acknowledgement), {
      runId: arm.runId,
      scenarioId: arm.scenarioId,
      createdAtEpochMs: arm.createdAtEpochMs,
      expiresAtEpochMs: arm.expiresAtEpochMs,
    });
    await writeJsonAtomically(
      path.join(runRoot(intent.runId), "save-intent-ack.json"),
      acknowledgement,
    );
    launch.saveIntent = {
      intentId: intent.intentId,
      snapshotAtAck,
      acknowledgedAtEpochMs,
    };
  }

  async function waitForSaveRequest(
    launch: ActiveLaunch,
    arm: Bg3TestArm,
    timeoutMs: number,
  ): Promise<Bg3SaveRequest> {
    const deadline = Date.now() + timeoutMs;
    let lastProtocolError: Bg3TestProtocolError | undefined;
    do {
      await assertLaunchRunning(
        launch,
        "BG3 exited before the save request could be validated",
      );
      const artifact = await readRunArtifact(launch.runId, "save-request.json");
      if (artifact !== undefined) {
        if (artifact.size > MAX_RESULT_BYTES) {
          throw new Error(
            `BG3 save-request.json exceeds ${MAX_RESULT_BYTES} bytes`,
          );
        }
        if (artifact.size > 0) {
          let request: Bg3SaveRequest | undefined;
          try {
            request = parseBg3SaveRequest(artifact.contents, {
              runId: arm.runId,
              scenarioId: arm.scenarioId,
              createdAtEpochMs: arm.createdAtEpochMs,
              expiresAtEpochMs: arm.expiresAtEpochMs,
            });
          } catch (error) {
            if (!(error instanceof Bg3TestProtocolError)) throw error;
            lastProtocolError = error;
          }
          if (request !== undefined) {
            if (launch.saveIntent === undefined) {
              throw new Bg3TestProtocolError(
                "BG3 save request has no acknowledged intent",
              );
            }
            assertBg3SaveRequestMatchesAcknowledgement(
              request,
              launch.saveIntent,
            );
            return request;
          }
        }
      }
      await wait(FILE_POLL_MS);
    } while (Date.now() < deadline);

    if (lastProtocolError !== undefined) throw lastProtocolError;
    throw new Bg3TestTimeoutError(
      `Timed out after ${timeoutMs} ms waiting for save request for ${launch.runId}`,
    );
  }

  async function createHeadlessOutput(runId: string): Promise<HeadlessOutput> {
    if ((process.env.HYPRLAND_INSTANCE_SIGNATURE ?? "") === "") {
      throw new Error("BG3 tests require an active Hyprland session");
    }
    let [monitors, windows, workspaces] = await Promise.all([
      hyprlandMonitors(),
      hyprlandWindows(),
      hyprlandWorkspaces(),
    ]);
    let monitor = identifyReusableHeadlessOutput(
      monitors,
      windows.map(({ monitorId }) => monitorId),
    );
    if (monitor === undefined) {
      assertBg3HeadlessWorkspaceAvailable(
        workspaces.map(({ name }) => name),
      );
      await runHyprctl(bg3HeadlessOutputCreateArguments());
      [monitors, windows, workspaces] = await Promise.all([
        hyprlandMonitors(),
        hyprlandWindows(),
        hyprlandWorkspaces(),
      ]);
      monitor = identifyReusableHeadlessOutput(
        monitors,
        windows.map(({ monitorId }) => monitorId),
      );
      if (monitor === undefined) {
        throw new Error(
          `Hyprland did not create reserved output ${BG3_HEADLESS_OUTPUT_NAME}`,
        );
      }
    }

    if (monitor.activeWorkspaceName !== BG3_HEADLESS_WORKSPACE_NAME) {
      assertBg3HeadlessWorkspaceAvailable(
        workspaces.map(({ name }) => name),
      );
      await runHyprctl([
        "dispatch",
        bg3HeadlessWorkspaceRenameExpression(monitor.activeWorkspaceId),
      ]);
      const [verifiedMonitors, verifiedWindows] = await Promise.all([
        hyprlandMonitors(),
        hyprlandWindows(),
      ]);
      monitor = identifyReusableHeadlessOutput(
        verifiedMonitors,
        verifiedWindows.map(({ monitorId }) => monitorId),
      );
      if (monitor?.activeWorkspaceName !== BG3_HEADLESS_WORKSPACE_NAME) {
        throw new Error(
          `Hyprland output ${BG3_HEADLESS_OUTPUT_NAME} did not retain workspace ${BG3_HEADLESS_WORKSPACE_NAME}`,
        );
      }
    }
    const created = {
      name: monitor.name,
      runId,
      kind: "headless" as const,
    };
    headlessOutput = created;
    return created;
  }

  async function installHeadlessRule(output: HeadlessOutput): Promise<void> {
    headlessRuleRunId = output.runId;
    const arm = armedRun;
    if (arm?.runId !== output.runId) {
      throw new Error("Cannot install BG3 headless rule without matching arm");
    }
    const watchdogDeadline = bg3HeadlessQuarantineUntilEpochMs(
      arm.expiresAtEpochMs,
    );
    const remainingMs = Math.max(1, watchdogDeadline - Date.now());
    await runHyprctl([
      "eval",
      bg3HeadlessWindowRuleInstallExpression(
        output.runId, remainingMs, output.kind === "visible" ? output.name : undefined,
      ),
    ]);
  }

  async function removeHeadlessRule(runId: string): Promise<void> {
    if (headlessRuleRunId !== runId) return;
    await runHyprctl([
      "eval",
      bg3HeadlessWindowRuleCleanupExpression(runId),
    ]);
    headlessRuleRunId = undefined;
  }

  async function cleanupHeadlessIsolation(runId: string): Promise<void> {
    await removeHeadlessRule(runId);
    if (headlessOutput?.runId === runId) headlessOutput = undefined;
  }

  async function observeSingleGameProcess(): Promise<LaunchedGame | undefined> {
    const valid = [];
    for (const candidate of await listGameProcesses()) {
      if (await validateGameProcess(candidate, gameRoot)) valid.push(candidate);
    }
    if (valid.length > 1) {
      throw new Error(
        `More than one BG3 process passed validation: ${valid.map(({ pid }) => pid).join(", ")}`,
      );
    }
    return valid[0];
  }

  async function discoverSingleGameProcess(
    timeoutMs: number,
  ): Promise<LaunchedGame | undefined> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const discoveredProcess = await observeSingleGameProcess();
      if (discoveredProcess !== undefined || Date.now() >= deadline) {
        return discoveredProcess;
      }
      await wait(Math.min(PROCESS_POLL_MS, deadline - Date.now()));
    }
  }

  async function moveGameToHeadless(
    processIdentity: LaunchedGame,
    output: HeadlessOutput,
  ): Promise<HyprlandWindow> {
    const deadline = Date.now() + WINDOW_DISCOVERY_TIMEOUT_MS;
    let gameWindow: HyprlandWindow | undefined;
    do {
      throwIfInterrupted();
      if (!(await validateGameProcess(processIdentity, gameRoot))) {
        throw new Error("BG3 exited before its window could move to the headless output");
      }
      gameWindow = (await hyprlandWindows()).find(
        (window) => isMappedBg3WindowCandidate(
          window,
          processIdentity.pid,
        ),
      );
      if (gameWindow !== undefined) break;
      await wait(PROCESS_POLL_MS);
    } while (Date.now() < deadline);

    if (gameWindow === undefined) {
      throw new Bg3TestTimeoutError(
        `Timed out after ${WINDOW_DISCOVERY_TIMEOUT_MS} ms waiting for the BG3 window`,
      );
    }
    if (!(await validateGameProcess(processIdentity, gameRoot))) {
      throw new Error("BG3 process identity changed before moving its window");
    }
    const grouped = gameWindow.groupedAddresses.length > 0;
    const groupedPeerAddresses = new Set(
      gameWindow.groupedAddresses.filter(
        (address) => address !== gameWindow.address,
      ),
    );
    const groupedPeers = grouped
      ? (await hyprlandWindows()).filter((window) =>
          groupedPeerAddresses.has(window.address),
        )
      : [];
    if (grouped && groupedPeers.length !== groupedPeerAddresses.size) {
      throw new Error(
        "Refusing to detach BG3 from an incompletely observed Hyprland group",
      );
    }

    const commands = bg3HeadlessWindowCommands(
      output.name,
      gameWindow.stableId,
      grouped,
    );
    for (const [index, command] of commands.entries()) {
      await runHyprctl(command);
      if (grouped && index === 0) {
        const detachedWithoutMovingPeers = await waitUntil(async () => {
          throwIfInterrupted();
          if (!(await validateGameProcess(processIdentity, gameRoot))) return false;
          const windows = await hyprlandWindows();
          const currentGame = windows.find(
            (window) =>
              window.address === gameWindow.address &&
              window.pid === processIdentity.pid,
          );
          if (currentGame?.groupedAddresses.length !== 0) return false;
          return groupedPeers.every((peer) => {
            const currentPeer = windows.find(
              (window) =>
                window.address === peer.address &&
                window.stableId === peer.stableId &&
                window.pid === peer.pid,
            );
            return (
              currentPeer?.workspaceName === peer.workspaceName &&
              currentPeer?.monitorId === peer.monitorId
            );
          });
        }, WINDOW_FOCUS_TIMEOUT_MS);
        if (!detachedWithoutMovingPeers) {
          throw new Bg3TestTimeoutError(
            "Refusing to move BG3 because it could not be isolated from its Hyprland window group",
          );
        }
      }
    }

    let placedWindow: HyprlandWindow | undefined;
    const moved = await waitUntil(async () => {
      throwIfInterrupted();
      if (!(await validateGameProcess(processIdentity, gameRoot))) return false;
      const [windows, monitors] = await Promise.all([
        hyprlandWindows(),
        hyprlandMonitors(),
      ]);
      const monitor = monitors.find((candidate) => candidate.name === output.name);
      const current = windows.find(
        (window) =>
          window.address === gameWindow.address &&
          window.pid === processIdentity.pid,
      );
      const matches = monitor !== undefined && current?.monitorId === monitor.id;
      if (matches) placedWindow = current;
      return matches;
    }, WINDOW_FOCUS_TIMEOUT_MS);
    if (!moved) {
      throw new Bg3TestTimeoutError(
        `Timed out after ${WINDOW_FOCUS_TIMEOUT_MS} ms moving BG3 to ${output.name}`,
      );
    }
    return placedWindow!;
  }

  async function verifyVisibleGameWindow(
    processIdentity: LaunchedGame,
    output: HeadlessOutput,
  ): Promise<HyprlandWindow> {
    let visibleWindow: HyprlandWindow | undefined;
    const visible = await waitUntil(async () => {
      throwIfInterrupted();
      if (!(await validateGameProcess(processIdentity, gameRoot))) {
        throw new Error("BG3 exited before its visible window became available");
      }
      const [windows, monitors] = await Promise.all([hyprlandWindows(), hyprlandMonitors()]);
      const monitor = monitors.find(({ name }) => name === output.name);
      if (monitor === undefined || monitor.physicalWidth <= 0 || monitor.physicalHeight <= 0) {
        throw new Error("The physical monitor selected for BG3 is no longer available");
      }
      const candidates = windows.filter((candidate) => isMappedBg3WindowCandidate(candidate, processIdentity.pid));
      if (candidates.length > 1) throw new Error("More than one mapped window belongs to the visible BG3 process");
      const window = candidates[0];
      if (window === undefined) return false;
      if (window.groupedAddresses.length > 0) {
        throw new Error("Refusing a visible BG3 window that joined an existing window group");
      }
      if (window.monitorId !== monitor.id || window.hidden) return false;
      visibleWindow = window;
      return true;
    }, WINDOW_DISCOVERY_TIMEOUT_MS);
    if (!visible || visibleWindow === undefined) {
      throw new Bg3TestTimeoutError(`BG3 did not open visibly on ${output.name}`);
    }
    await focusBg3VisibleWindowOnce({
      window: visibleWindow,
      processId: processIdentity.pid,
      validateProcess: async () => {
        throwIfInterrupted();
        return validateGameProcess(processIdentity, gameRoot);
      },
      readWindows: hyprlandWindows,
      readActiveWindow: async () => parseHyprlandWindow(JSON.parse(await runHyprctl(["activewindow", "-j"]))),
      readDesktopLocked,
      readWindowProperties: async (window) => {
        const [noFocus, noFollowMouse] = await Promise.all([
          runHyprctl(["getprop", `stableid:${window.stableId}`, "no_focus"]),
          runHyprctl(["getprop", `stableid:${window.stableId}`, "no_follow_mouse"]),
        ]);
        return { noFocus, noFollowMouse };
      },
      dispatch: runHyprctl,
      waitUntil,
    });
    return visibleWindow;
  }

  async function terminateExactGame(
    processIdentity: LaunchedGame,
  ): Promise<void> {
    const current = await readProcessIdentity(processIdentity.pid);
    if (current === undefined) return;
    if (current.startTimeTicks !== processIdentity.startTimeTicks) {
      throw new Error(
        `Refusing to terminate PID ${processIdentity.pid} because its identity changed`,
      );
    }
    if (!(await validateGameProcess(processIdentity, gameRoot))) {
      const exited = await waitForBg3ExitAfterLostValidation(
        processIdentity, async () => readProcessIdentity(processIdentity.pid), waitUntil,
      );
      if (exited) {
        console.log(`BG3 PID ${processIdentity.pid} exited during final identity validation`);
        return;
      }
      throw new Error(`Refusing to terminate PID ${processIdentity.pid} because its identity changed`);
    }

    process.kill(processIdentity.pid, "SIGTERM");
    const exited = await waitUntil(
      async () => {
        const identity = await readProcessIdentity(processIdentity.pid);
        return identity?.startTimeTicks !== processIdentity.startTimeTicks;
      },
      TERMINATE_TIMEOUT_MS,
    );
    if (exited) return;

    if (!(await validateGameProcess(processIdentity, gameRoot))) {
      throw new Error(
        `Refusing to force-terminate PID ${processIdentity.pid} because its identity changed`,
      );
    }
    process.kill(processIdentity.pid, "SIGKILL");
    const killed = await waitUntil(
      async () => {
        const identity = await readProcessIdentity(processIdentity.pid);
        return identity?.startTimeTicks !== processIdentity.startTimeTicks;
      },
      KILL_TIMEOUT_MS,
    );
    if (!killed) {
      throw new Error(`BG3 PID ${processIdentity.pid} did not exit after SIGKILL`);
    }
  }

  async function finalizeActiveGame(
    processIdentity: LaunchedGame,
  ): Promise<void> {
    const launch = activeLaunch;
    if (
      launch === undefined ||
      launch.processIdentity.pid !== processIdentity.pid ||
      launch.processIdentity.startTimeTicks !== processIdentity.startTimeTicks
    ) {
      throw new Error("BG3 process does not match the active harness launch");
    }
    const finalizationErrors: unknown[] = [];
    let saveStateIsSafe = true;
    const record = async (operation: () => Promise<void>): Promise<boolean> => {
      try {
        await operation();
        return true;
      } catch (error) {
        finalizationErrors.push(error);
        return false;
      }
    };
    const throwRecorded = (message: string): never => {
      if (finalizationErrors.length === 1) throw finalizationErrors[0];
      throw new AggregateError(finalizationErrors, message);
    };

    if (launch.mode === "runtime") {
      saveStateIsSafe = await record(async () => {
        assertNoBg3SaveChanges(
          launch.saveSnapshotBeforeLaunch,
          await snapshotBg3SaveIdentities(saveRoot),
          "during runtime scenario",
        );
      });
    }

    await launch.windowDiagnostics?.capture("terminal-observation", "before-teardown");
    const processTerminated = await record(async () => {
      await terminateExactGame(processIdentity);
    });
    if (!processTerminated) {
      if (finalizationErrors.length === 1) throw finalizationErrors[0];
      throw new AggregateError(
        finalizationErrors,
        `BG3 run ${launch.runId} failed save checks and process termination`,
      );
    }

    if (launch.mode === "runtime") {
      const unchanged = await record(async () => {
        assertNoBg3SaveChanges(
          launch.saveSnapshotBeforeLaunch,
          await snapshotBg3SaveIdentities(saveRoot),
          "during runtime process termination",
        );
      });
      saveStateIsSafe &&= unchanged;
    }
    if (launch.mode === "character-creation") {
      const validCreationState = await record(async () => {
        assertBg3CreationSavePostcondition(
          launch.saveSnapshotBeforeLaunch,
          await snapshotBg3SaveIdentities(saveRoot),
          launch.validatedSave,
          launch.validatedSave === undefined
            ? "during failed character creation"
            : "after validated character creation",
        );
      });
      saveStateIsSafe &&= validCreationState;
    }

    const sharedCleanupIsSafe = await record(async () => {
      assertNoBg3ProcessCandidates(
        await listGameProcesses(),
        "active launch shared cleanup",
      );
    });
    if (!sharedCleanupIsSafe) {
      throwRecorded(
        `BG3 run ${launch.runId} cannot restore shared state while another BG3 process exists`,
      );
    }

    if (launch.builtinBridgePrepared) {
      const restored = await record(async () => {
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "active launch bridge restore",
        );
        await builtinBridge.restore(launch.runId);
      });
      if (!restored) {
        throwRecorded(
          `BG3 run ${launch.runId} cannot restore its bridge while another BG3 process exists`,
        );
      }
      launch.builtinBridgePrepared = false;
    }
    if (launch.modSettingsPrepared) {
      const restored = await record(async () => {
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "active launch mod settings restore",
        );
        await modSettings.restore(launch.runId);
      });
      if (!restored) {
        throwRecorded(
          `BG3 run ${launch.runId} cannot restore modsettings.lsx while another BG3 process exists`,
        );
      }
      launch.modSettingsPrepared = false;
    }
    if (launch.steamCloudPrepared) {
      if (
        !saveStateIsSafe ||
        launch.builtinBridgePrepared ||
        launch.modSettingsPrepared
      ) {
        finalizationErrors.push(new Error(
          "Steam Cloud remains disabled because the save audit or shared-state restoration failed",
        ));
      } else {
        const restored = await record(async () => {
          const expectedSaveSnapshot = await verifiedActiveSaveSnapshot(
            launch,
            "immediately before active launch Steam Cloud restore",
          );
          await restoreSteamCloud(
            launch.runId,
            "active launch Steam Cloud restore",
            expectedSaveSnapshot,
          );
        });
        if (restored) {
          launch.steamCloudPrepared = false;
        }
      }
    }
    const isolationCleanupIsSafe = await record(async () => {
      assertNoBg3ProcessCandidates(
        await listGameProcesses(),
        "active launch isolation cleanup",
      );
    });
    if (!isolationCleanupIsSafe) {
      throwRecorded(
        `BG3 run ${launch.runId} cannot disable isolation while another BG3 process exists`,
      );
    }
    const isolationRemoved = await record(async () => {
      await cleanupHeadlessIsolation(launch.runId);
    });
    if (
      isolationRemoved &&
      !launch.builtinBridgePrepared &&
      !launch.modSettingsPrepared &&
      !launch.steamCloudPrepared
    ) {
      activeLaunch = undefined;
    }

    if (finalizationErrors.length === 1) throw finalizationErrors[0];
    if (finalizationErrors.length > 1) {
      throw new AggregateError(
        finalizationErrors,
        `BG3 run ${launch.runId} failed multiple finalization checks`,
      );
    }
  }

  async function finalizePendingLaunch(
    runId: string,
  ): Promise<void> {
    const pending = pendingLaunch;
    if (pending?.runId !== runId) return;
    const processIdentity = await discoverSingleGameProcess(
      Math.max(0, pending.quarantineUntilEpochMs - Date.now()),
    );
    if (processIdentity !== undefined) {
      activeLaunch = {
        processIdentity,
        runId: pending.runId,
        mode: pending.mode,
        networkLogsBeforeLaunch: pending.networkLogsBeforeLaunch,
        builtinBridgePrepared: pending.builtinBridgePrepared,
        modSettingsPrepared: pending.modSettingsPrepared,
        steamCloudPrepared: pending.steamCloudPrepared,
        saveSnapshotBeforeLaunch: pending.saveSnapshotBeforeLaunch,
      };
      pendingLaunch = undefined;
      await finalizeActiveGame(processIdentity);
      return;
    }

    assertNoBg3ProcessCandidates(
      await listGameProcesses(),
      "pending launch save audit",
    );
    assertNoBg3SaveChanges(
      pending.saveSnapshotBeforeLaunch,
      await snapshotBg3SaveIdentities(saveRoot),
      "during quarantined Steam launch without a BG3 process",
    );
    assertNoBg3ProcessCandidates(
      await listGameProcesses(),
      "pending launch bridge recovery after save audit",
    );
    if (pending.builtinBridgePrepared) {
      assertNoBg3ProcessCandidates(
        await listGameProcesses(),
        "pending launch bridge recovery",
      );
      await builtinBridge.restore(runId);
      pending.builtinBridgePrepared = false;
      assertNoBg3ProcessCandidates(
        await listGameProcesses(),
        "pending launch completion",
      );
    }
    if (pending.modSettingsPrepared) {
      assertNoBg3ProcessCandidates(
        await listGameProcesses(),
        "pending launch mod settings recovery",
      );
      await modSettings.restore(runId);
      pending.modSettingsPrepared = false;
      assertNoBg3ProcessCandidates(
        await listGameProcesses(),
        "pending launch completion",
      );
    }
    if (pending.steamCloudPrepared) {
      assertNoBg3ProcessCandidates(
        await listGameProcesses(),
        "pending launch Steam Cloud recovery",
      );
      await restoreSteamCloud(
        runId,
        "pending launch Steam Cloud recovery",
        pending.saveSnapshotBeforeLaunch,
      );
      pending.steamCloudPrepared = false;
      assertNoBg3ProcessCandidates(
        await listGameProcesses(),
        "pending launch completion",
      );
    }
    assertNoBg3SaveChanges(
      pending.saveSnapshotBeforeLaunch,
      await snapshotBg3SaveIdentities(saveRoot),
      "at the end of quarantined Steam launch",
    );
    assertNoBg3ProcessCandidates(
      await listGameProcesses(),
      "pending launch isolation cleanup",
    );
    await cleanupHeadlessIsolation(runId);
    assertNoBg3SaveChanges(
      pending.saveSnapshotBeforeLaunch,
      await snapshotBg3SaveIdentities(saveRoot),
      "after quarantined Steam launch cleanup",
    );
    assertNoBg3ProcessCandidates(
      await listGameProcesses(),
      "pending launch exit",
    );
    pendingLaunch = undefined;
  }

  function serializeSaveSnapshot(
    snapshot: Bg3SaveIdentitySnapshot,
  ): SaveFileIdentity[] {
    return [...snapshot.values()].sort((left, right) =>
      left.lsvPath.localeCompare(right.lsvPath)
    );
  }

  function parseRunLockOwner(raw: string): RunLockOwner {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("BG3 run lock owner is not valid JSON", { cause: error });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("BG3 run lock owner is invalid");
    }
    const owner = parsed as Record<string, unknown>;
    if (
      owner.schemaVersion !== 2 ||
      typeof owner.runId !== "string" ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.ownerStartTimeTicks !== "string" ||
      !/^[0-9]+$/.test(owner.ownerStartTimeTicks) ||
      typeof owner.createdAt !== "string" ||
      !Number.isFinite(Date.parse(owner.createdAt)) ||
      typeof owner.quarantineUntilEpochMs !== "number" ||
      !Number.isSafeInteger(owner.quarantineUntilEpochMs) ||
      owner.quarantineUntilEpochMs < 0 ||
      (owner.status !== "armed" && owner.status !== "pending-steam")
    ) {
      throw new Error("BG3 run lock owner is invalid");
    }
    validateRunId(owner.runId);
    if (owner.status === "armed") {
      if (Object.keys(owner).sort().join(",") !==
        "createdAt,ownerStartTimeTicks,pid,quarantineUntilEpochMs,runId,schemaVersion,status") {
        throw new Error("BG3 armed run lock owner has unexpected fields");
      }
      return owner as unknown as ArmedRunLockOwner;
    }
    if (
      Object.keys(owner).sort().join(",") !==
        "createdAt,ownerStartTimeTicks,pid,quarantineUntilEpochMs,runId,saveSnapshotBeforeLaunch,schemaVersion,status" ||
      !Array.isArray(owner.saveSnapshotBeforeLaunch) ||
      owner.saveSnapshotBeforeLaunch.length > 10_000
    ) {
      throw new Error("BG3 pending run lock owner is invalid");
    }
    const snapshot = owner.saveSnapshotBeforeLaunch;
    const seenPaths = new Set<string>();
    for (const value of snapshot) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("BG3 pending save snapshot is invalid");
      }
      const identity = value as Record<string, unknown>;
      if (
        Object.keys(identity).sort().join(",") !==
          "device,id,inode,lsvPath,modifiedAtMs,size" ||
        typeof identity.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(identity.id) ||
        typeof identity.lsvPath !== "string" ||
        !path.isAbsolute(identity.lsvPath) ||
        typeof identity.device !== "number" ||
        !Number.isSafeInteger(identity.device) ||
        identity.device < 0 ||
        typeof identity.inode !== "number" ||
        !Number.isSafeInteger(identity.inode) ||
        identity.inode < 0 ||
        typeof identity.size !== "number" ||
        !Number.isSafeInteger(identity.size) ||
        identity.size < 0 ||
        typeof identity.modifiedAtMs !== "number" ||
        !Number.isFinite(identity.modifiedAtMs)
      ) {
        throw new Error("BG3 pending save snapshot is invalid");
      }
      const relative = path.relative(saveRoot, identity.lsvPath);
      if (
        relative === "" ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !identity.lsvPath.toLowerCase().endsWith(".lsv") ||
        seenPaths.has(identity.lsvPath)
      ) {
        throw new Error("BG3 pending save snapshot targets an unsafe path");
      }
      seenPaths.add(identity.lsvPath);
    }
    return owner as unknown as PendingRunLockOwner;
  }

  function snapshotFromLockOwner(
    owner: PendingRunLockOwner,
  ): Bg3SaveIdentitySnapshot {
    return new Map(
      owner.saveSnapshotBeforeLaunch.map((identity) => [
        identity.lsvPath,
        identity,
      ]),
    );
  }

  async function readRunLockOwner(): Promise<RunLockOwner> {
    const ownerPath = path.join(lockRoot, "owner.json");
    const metadata = await stat(ownerPath);
    if (metadata.size > MAX_RESULT_BYTES) {
      throw new Error(`BG3 run lock owner exceeds ${MAX_RESULT_BYTES} bytes`);
    }
    return parseRunLockOwner(await readFile(ownerPath, "utf8"));
  }

  async function writeRunLockOwner(owner: RunLockOwner): Promise<void> {
    await writeJsonAtomically(path.join(lockRoot, "owner.json"), owner);
  }

  async function clearLegacyRecoveryClaim(): Promise<void> {
    const claimRoot = path.join(lockRoot, "recovery.claim");
    let metadata;
    try {
      metadata = await lstat(claimRoot);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        `BG3 legacy recovery claim is not a real directory: ${claimRoot}`,
      );
    }
    if (Date.now() - metadata.mtimeMs < LEGACY_RECOVERY_CLAIM_STALE_MS) {
      throw new Error(`BG3 run lock ${lockRoot} is already being recovered`);
    }
    const entries = await readdir(claimRoot);
    if (entries.length > 0) {
      throw new Error(
        `BG3 legacy recovery claim is not empty: ${claimRoot}`,
      );
    }
    const current = await lstat(claimRoot);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino
    ) {
      throw new Error(
        `BG3 legacy recovery claim changed during cleanup: ${claimRoot}`,
      );
    }
    await rmdir(claimRoot);
  }

  async function clearAbandonedUnownedRunLock(): Promise<boolean> {
    const metadata = await lstat(lockRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`BG3 run lock is not a real directory: ${lockRoot}`);
    }
    const entries = await readdir(lockRoot);
    if (entries.includes("owner.json")) {
      return false;
    }
    if (entries.includes("recovery.claim")) {
      if (entries.length !== 1) {
        throw new Error(
          `BG3 run lock has no owner and contains unexpected entries: ${lockRoot}`,
        );
      }
      await clearLegacyRecoveryClaim();
      const current = await lstat(lockRoot);
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev !== metadata.dev ||
        current.ino !== metadata.ino ||
        (await readdir(lockRoot)).length !== 0
      ) {
        throw new Error(`BG3 run lock changed during cleanup: ${lockRoot}`);
      }
      await rmdir(lockRoot);
      return true;
    }
    if (Date.now() - metadata.mtimeMs < UNOWNED_RUN_LOCK_STALE_MS) {
      throw new Error(
        `BG3 run lock has no owner and is too recent to recover: ${lockRoot}`,
      );
    }

    let temporary:
      | { path: string; device: number; inode: number }
      | undefined;
    if (entries.length > 0) {
      if (entries.length !== 1) {
        throw new Error(
          `BG3 run lock has no owner and contains unexpected entries: ${lockRoot}`,
        );
      }
      const temporaryName = entries[0];
      if (temporaryName === undefined) {
        throw new Error(`BG3 run lock changed during cleanup: ${lockRoot}`);
      }
      const match = OWNER_TEMPORARY_PATTERN.exec(temporaryName);
      const writerPid = match === null ? Number.NaN : Number(match[1]);
      if (!Number.isSafeInteger(writerPid) || writerPid <= 0) {
        throw new Error(
          `BG3 run lock has no owner and contains an unsafe entry: ${path.join(lockRoot, temporaryName)}`,
        );
      }
      const temporaryPath = path.join(lockRoot, temporaryName);
      const temporaryMetadata = await lstat(temporaryPath);
      if (
        temporaryMetadata.isSymbolicLink() ||
        !temporaryMetadata.isFile()
      ) {
        throw new Error(
          `BG3 run lock owner temporary is not a real file: ${temporaryPath}`,
        );
      }
      if (
        Date.now() - temporaryMetadata.mtimeMs < UNOWNED_RUN_LOCK_STALE_MS
      ) {
        throw new Error(
          `BG3 run lock owner temporary is too recent to recover: ${temporaryPath}`,
        );
      }
      if (await readProcessStartTimeTicks(writerPid) !== undefined) {
        throw new Error(
          `Refusing to recover BG3 run lock while owner writer PID ${writerPid} is alive`,
        );
      }
      temporary = {
        path: temporaryPath,
        device: temporaryMetadata.dev,
        inode: temporaryMetadata.ino,
      };
    }

    const current = await lstat(lockRoot);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino
    ) {
      throw new Error(`BG3 run lock changed during cleanup: ${lockRoot}`);
    }
    const currentEntries = await readdir(lockRoot);
    if (
      currentEntries.length !== entries.length ||
      currentEntries.some((entry, index) => entry !== entries[index])
    ) {
      throw new Error(`BG3 run lock changed during cleanup: ${lockRoot}`);
    }
    if (temporary !== undefined) {
      const currentTemporary = await lstat(temporary.path);
      if (
        currentTemporary.isSymbolicLink() ||
        !currentTemporary.isFile() ||
        currentTemporary.dev !== temporary.device ||
        currentTemporary.ino !== temporary.inode
      ) {
        throw new Error(
          `BG3 run lock owner temporary changed during cleanup: ${temporary.path}`,
        );
      }
      await unlink(temporary.path);
    }
    await rmdir(lockRoot);
    return true;
  }

  async function recoverExpiredRunLock(
    owner: RunLockOwner,
  ): Promise<void> {
    if (Date.now() < owner.quarantineUntilEpochMs) {
      throw new Error(
        `Another BG3 test run holds ${lockRoot}: ${owner.runId} is quarantined until ${owner.quarantineUntilEpochMs}`,
      );
    }
    const ownerProcessStartTimeTicks =
      await readProcessStartTimeTicks(owner.pid);
    if (ownerProcessStartTimeTicks === owner.ownerStartTimeTicks) {
      throw new Error(
        `Refusing to recover expired BG3 run ${owner.runId} while its runner PID ${owner.pid} is alive`,
      );
    }
    const gameProcesses = await listGameProcesses();
    if (gameProcesses.length > 0) {
      throw new Error(
        `Refusing to recover expired BG3 run ${owner.runId} while BG3 PID ${gameProcesses.map(({ pid }) => pid).join(", ")} is alive`,
      );
    }
    const recoverySaveSnapshot = owner.status === "pending-steam"
      ? snapshotFromLockOwner(owner)
      : await snapshotBg3SaveIdentities(saveRoot);
    if (owner.status === "pending-steam") {
      assertNoBg3SaveChanges(
        recoverySaveSnapshot,
        await snapshotBg3SaveIdentities(saveRoot),
        "during expired pending Steam launch",
      );
    }
    const processesBeforeRestore = await listGameProcesses();
    if (processesBeforeRestore.length > 0) {
      throw new Error(
        `Refusing to restore expired BG3 run ${owner.runId} because BG3 appeared during recovery`,
      );
    }
    await builtinBridge.restore(owner.runId);
    assertNoBg3ProcessCandidates(
      await listGameProcesses(),
      "expired run mod settings recovery",
    );
    await modSettings.restore(owner.runId);
    const processesBeforeCloudRestore = await listGameProcesses();
    if (processesBeforeCloudRestore.length > 0) {
      throw new Error(
        `Refusing to restore Steam Cloud for expired BG3 run ${owner.runId} because BG3 appeared during recovery`,
      );
    }
    await recoverSteamCloud(
      owner.runId,
      "expired run Steam Cloud recovery",
      recoverySaveSnapshot,
    );
    const processesBeforeRelease = await listGameProcesses();
    if (processesBeforeRelease.length > 0) {
      throw new Error(
        `Refusing to release expired BG3 run ${owner.runId} because BG3 appeared during recovery`,
      );
    }
    if ((process.env.HYPRLAND_INSTANCE_SIGNATURE ?? "") !== "") {
      await runHyprctl([
        "eval",
        bg3HeadlessWindowRuleCleanupExpression(owner.runId),
      ]);
    }
    try {
      const raw = await readFile(armPath, "utf8");
      const arm = JSON.parse(raw) as { runId?: unknown };
      if (arm.runId === owner.runId) await rm(armPath, { force: true });
    } catch (error) {
      if (
        !(isNodeError(error) && error.code === "ENOENT") &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
    }
    await rm(runRoot(owner.runId), { recursive: true, force: true });
  }

  async function acquireRunLock(arm: Bg3TestArm): Promise<void> {
    await mkdir(harnessRoot, { recursive: true });
    await withRunLockGuard(lockGuardPath, async () => {
      let createdLock = false;
      let recoveredLock = false;
      try {
        await mkdir(lockRoot);
        createdLock = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (await clearAbandonedUnownedRunLock()) {
          await mkdir(lockRoot);
          createdLock = true;
        } else {
          await clearLegacyRecoveryClaim();
          const owner = await readRunLockOwner();
          await recoverExpiredRunLock(owner);
          recoveredLock = true;
        }
      }

      const runnerStartTimeTicks = await readProcessStartTimeTicks(process.pid);
      if (runnerStartTimeTicks === undefined) {
        if (createdLock) {
          await rm(lockRoot, { recursive: true, force: true });
        }
        throw new Error("Cannot establish the BG3 harness runner identity");
      }
      lockOwnerStartTimeTicks = runnerStartTimeTicks;
      if (recoveredLock) {
        const gamesBeforeOwnership = await listGameProcesses();
        if (gamesBeforeOwnership.length > 0) {
          lockOwnerStartTimeTicks = undefined;
          throw new Error(
            `Refusing to claim recovered BG3 lock because PID ${gamesBeforeOwnership.map(({ pid }) => pid).join(", ")} appeared`,
          );
        }
      }
      try {
        await writeRunLockOwner({
          schemaVersion: 2,
          runId: arm.runId,
          pid: process.pid,
          ownerStartTimeTicks: runnerStartTimeTicks,
          createdAt: arm.createdAt,
          status: "armed",
          quarantineUntilEpochMs: bg3HeadlessQuarantineUntilEpochMs(
            arm.expiresAtEpochMs,
          ),
        });
      } catch (error) {
        lockOwnerStartTimeTicks = undefined;
        if (createdLock) {
          await rm(lockRoot, { recursive: true, force: true });
        }
        throw error;
      }
    });
  }

  async function releaseRunLock(runId: string): Promise<void> {
    try {
      const raw = await readFile(path.join(lockRoot, "owner.json"), "utf8");
      const owner = JSON.parse(raw) as { runId?: unknown };
      if (owner.runId === runId) {
        await rm(lockRoot, { recursive: true, force: true });
        lockOwnerStartTimeTicks = undefined;
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      if (error instanceof SyntaxError) return;
      throw error;
    }
  }

  return {
    now: () => new Date(),
    runId: () => `run-${randomUUID()}`,

    async armRun(arm): Promise<void> {
      validateRunId(arm.runId);
      const scenario = catalog.get(arm.scenarioId);
      if (
        scenario === undefined ||
        !wireTargetMatchesScenario(arm, scenario) ||
        arm.timeoutMs !== scenario.timeoutMs
      ) {
        throw new Error(
          `Refusing to arm disallowed ${arm.mode} save: ${arm.saveId}`,
        );
      }
      await acquireRunLock(arm);
      try {
        const existingGames = await listGameProcesses();
        if (existingGames.length > 0) {
          throw new Error(
            `Refusing to recover the BG3 builtin bridge while BG3 PID ${existingGames.map(({ pid }) => pid).join(", ")} is alive`,
          );
        }
        await builtinBridge.recover();
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "orphaned mod settings recovery",
        );
        await modSettings.recover();
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "orphaned Steam Cloud recovery",
        );
        if (
          (await loadSteamCloudSettlement()) !== undefined ||
          await steamCloud.hasPendingTransaction()
        ) {
          const recoverySaveSnapshot =
            await snapshotBg3SaveIdentities(saveRoot);
          await recoverSteamCloud(
            arm.runId,
            "orphaned Steam Cloud recovery",
            recoverySaveSnapshot,
          );
        }
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "orphaned recovery completion",
        );
        await clearBg3ModCrashSanityCheck(modCrashSanityCheckPath);
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "run arming after mod crash marker removal",
        );
        await mkdir(runRoot(arm.runId), { recursive: true });
        await writeJsonAtomically(armPath, arm);
        armedRun = arm;
        issuedCommand = undefined;
      } catch (error) {
        await rm(runRoot(arm.runId), { recursive: true, force: true });
        await releaseRunLock(arm.runId);
        throw error;
      }
    },

    async cleanupRun(runId): Promise<void> {
      validateRunId(runId);
      // Orphan recovery belongs to armRun after it acquires the run lock.
      // Pre-arm cleanup and cleanup after rejected arming own no shared state.
      if (armedRun?.runId !== runId) return;
      const cleanupErrors: unknown[] = [];
      const attempt = async (operation: () => Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      if (activeLaunch?.runId === runId) {
        await finalizeActiveGame(activeLaunch.processIdentity);
      }
      if (pendingLaunch?.runId === runId) {
        await finalizePendingLaunch(runId);
      }
      await attempt(async () => {
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "run cleanup mod crash marker removal",
        );
        await clearBg3ModCrashSanityCheck(modCrashSanityCheckPath);
      });
      if (
        (await loadSteamCloudSettlement()) !== undefined ||
        await steamCloud.hasPendingTransaction()
      ) {
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "run cleanup shared-state recovery",
        );
        await builtinBridge.restore(runId);
        assertNoBg3ProcessCandidates(
          await listGameProcesses(),
          "run cleanup mod settings recovery",
        );
        await modSettings.restore(runId);
        const recoverySaveSnapshot =
          await snapshotBg3SaveIdentities(saveRoot);
        await recoverSteamCloud(
          runId,
          "run cleanup Steam Cloud recovery",
          recoverySaveSnapshot,
        );
      }

      await attempt(async () => cleanupHeadlessIsolation(runId));
      await attempt(async () => {
        await rm(runRoot(runId), { recursive: true, force: true });
        if (await pathExists(runRoot(runId))) {
          throw new Error(`BG3 run channel still exists after cleanup: ${runId}`);
        }
      });
      await attempt(async () => {
        try {
          const raw = await readFile(armPath, "utf8");
          const arm = JSON.parse(raw) as { runId?: unknown };
          if (arm.runId !== runId) {
            throw new Error(
              `BG3 arm belongs to ${String(arm.runId)}, not ${runId}`,
            );
          }
          await rm(armPath, { force: true });
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") return;
          throw error;
        }
        if (await pathExists(armPath)) {
          throw new Error(`BG3 arm still exists after cleanup: ${runId}`);
        }
      });

      if (cleanupErrors.length === 0) {
        await attempt(async () => releaseRunLock(runId));
        if (cleanupErrors.length === 0 && armedRun?.runId === runId) {
          armedRun = undefined;
          issuedCommand = undefined;
        }
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          `Failed to complete every cleanup stage for BG3 run ${runId}`,
        );
      }
    },

    async archiveRunArtifacts(runId): Promise<void> {
      validateRunId(runId);
      const source = runRoot(runId);
      const destination = path.join(
        workRoot,
        ".cache",
        "bg3-test-runs",
        runId,
      );
      await archiveBg3LaunchEvidence(destination, [
        async () => {
          const sourceMetadata = await stat(source);
          if (!sourceMetadata.isDirectory()) {
            throw new Error(`BG3 run channel is not a directory: ${source}`);
          }
          // The run directory is already reserved exclusively. Copy its children
          // without asking cp to replace that existing destination directory.
          for (const name of await readdir(source)) {
            await cp(path.join(source, name), path.join(destination, name), {
              recursive: true,
              force: false,
              errorOnExist: true,
            });
          }
        },
        async () => {
          const archiveLogs = engineLogArchives.get(runId);
          if (archiveLogs !== undefined) {
            await archiveLogs.archive(destination);
            engineLogArchives.delete(runId);
          }
        },
        async () => {
          const launcher = launcherObservations.get(runId);
          if (launcher !== undefined) {
            await launcher.archive(destination);
            launcherObservations.delete(runId);
          }
        },
        async () => {
          const diagnostic = windowDiagnostics.get(runId);
          if (diagnostic === undefined) return;
          try {
            await diagnostic.archive(async (phase, contents) => writeFile(
              path.join(destination, `window-diagnostic-${phase}.json`), contents,
              { encoding: "utf8", flag: "wx", mode: 0o600 },
            ));
          } finally { windowDiagnostics.delete(runId); }
        },
      ]);
    },

    async writeCommand(command): Promise<void> {
      validateRunId(command.runId);
      const scenario = catalog.get(command.scenarioId);
      if (
        scenario === undefined ||
        !wireTargetMatchesScenario(command, scenario) ||
        armedRun?.runId !== command.runId ||
        armedRun.scenarioId !== command.scenarioId ||
        armedRun.mode !== command.mode ||
        armedRun.saveId !== command.saveId ||
        armedRun.savePolicy !== command.savePolicy ||
        !sameStringArray(
          command.requiredAssertionIds,
          armedRun.requiredAssertionIds,
        ) ||
        !creationPlanMatches(command, scenario) ||
        command.createdAtEpochMs < armedRun.createdAtEpochMs ||
        command.expiresAtEpochMs > armedRun.expiresAtEpochMs
      ) {
        throw new Error("Refusing to write a command that does not match the armed run");
      }
      if (activeLaunch?.runId === command.runId) {
        await activeLaunch.windowDiagnostics?.capture("before-command", "command-write");
        throwIfInterrupted();
      }
      await writeJsonAtomically(
        path.join(runRoot(command.runId), "command.json"),
        command,
      );
      issuedCommand = command;
    },

    async launchGame(saveId, runId, mode, display = "headless"): Promise<LaunchedGame> {
      validateRunId(runId);
      if (display !== "headless" && display !== "visible") throw new Error("Invalid BG3 display mode");
      const scenario = armedRun === undefined
        ? undefined
        : catalog.get(armedRun.scenarioId);
      if (
        scenario === undefined ||
        mode !== scenarioMode(scenario) ||
        (mode === "runtime" && saveId !== scenarioSaveId(scenario)) ||
        (mode === "character-creation" && saveId !== undefined) ||
        armedRun?.runId !== runId ||
        armedRun.mode !== mode
      ) {
        throw new Error(`Refusing to launch disallowed ${mode} test`);
      }
      if (display === "visible") {
        let locked: boolean;
        try {
          locked = await readDesktopLocked();
        } catch {
          throw new Error("Cannot verify the desktop lock state. Visible BG3 tests require an unlocked desktop.");
        }
        if (locked) {
          throw new Error("The desktop is locked. Unlock it before starting a visible BG3 test.");
        }
      }
      const launchArm = armedRun;
      if (scenario.pointer !== undefined) {
        if (display !== "visible") throw new Error("Native pointer scenarios require --display visible");
        await checkBg3PointerDependencies(packageRoot);
      }
      if (
        mode === "character-creation" &&
        !(await pathExists(path.join(runRoot(runId), "command.json")))
      ) {
        throw new Error(
          "Character-creation command must exist before BG3 launches",
        );
      }
      if (scenario.launch.kind === "runtime") {
        await assertRuntimeFixtureLsvHash(
          saveRoot,
          scenario.launch.fixture.saveId,
          scenario.launch.fixture.expectedLsvSha256,
        );
      }
      if (!(await pathExists(path.join(gameRoot, "bin", "bg3.exe")))) {
        throw new Error(`BG3 executable is missing under ${gameRoot}`);
      }

      const existingProcesses = await listGameProcesses();
      if (existingProcesses.length > 0) {
        throw new Error(
          `BG3 is already running with PID ${existingProcesses.map(({ pid }) => pid).join(", ")}`,
        );
      }
      const networkLogsBeforeLaunch = new Set(
        (await listNetworkLogs(gameRoot)).map((log) => log.key),
      );
      engineLogArchives.set(runId, await prepareBg3EngineLogArchive(gameRoot, localAppData, Date.now, options.modDiagnostics ?? []));

      const saveSnapshotBeforeLaunch =
        await snapshotBg3SaveIdentities(saveRoot);
      let output: HeadlessOutput | undefined;
      let launchedProcess: LaunchedGame | undefined;
      let steamSpawned = false;
      let builtinBridgePrepared = false;
      let modSettingsPrepared = false;
      const steamCloudPreparation = { prepared: false };
      try {
        output = await prepareBg3HeadlessLaunch({
          createOutput: async () => selectBg3LaunchDisplay<HeadlessOutput>(display, {
            headless: async () => createHeadlessOutput(runId),
            visible: async () => ({
              kind: "visible",
              name: selectBg3VisibleMonitor(await hyprlandMonitors()),
              runId,
            }),
          }),
          installRule: async (createdOutput) => {
            await installHeadlessRule(createdOutput);
          },
          beforeSpawn: async () => {
            assertNoBg3ProcessCandidates(
              await listGameProcesses(),
              "launch preparation before Steam Cloud mutation",
            );
            await prepareBg3SteamCloudForLaunch(
              steamCloud,
              runId,
              steamCloudPreparation,
            );
            assertNoBg3ProcessCandidates(
              await listGameProcesses(),
              "launch preparation before mod settings mutation",
            );
            modSettingsPrepared = true;
            await modSettings.prepare(runId, scenario.requiredMods);
            assertNoBg3ProcessCandidates(
              await listGameProcesses(),
              "launch preparation before builtin bridge mutation",
            );
            builtinBridgePrepared = true;
            await builtinBridge.prepare(runId);
          },
          spawn: async () => {
            assertNoBg3ProcessCandidates(
              await listGameProcesses(),
              "Steam launch",
            );
            if (scenario.launch.kind === "runtime") {
              await assertRuntimeFixtureLsvHash(
                saveRoot,
                scenario.launch.fixture.saveId,
                scenario.launch.fixture.expectedLsvSha256,
              );
              assertNoBg3ProcessCandidates(
                await listGameProcesses(),
                "Steam launch after runtime fixture verification",
              );
            }
            const ownerStartTimeTicks = lockOwnerStartTimeTicks;
            if (ownerStartTimeTicks === undefined) {
              throw new Error("BG3 run lock has no runner identity");
            }
            const quarantineUntilEpochMs =
              bg3HeadlessQuarantineUntilEpochMs(launchArm.expiresAtEpochMs);
            pendingLaunch = {
              runId,
              mode,
              networkLogsBeforeLaunch,
              builtinBridgePrepared,
              modSettingsPrepared,
              steamCloudPrepared: steamCloudPreparation.prepared,
              saveSnapshotBeforeLaunch,
              quarantineUntilEpochMs,
            };
            await writeRunLockOwner({
              schemaVersion: 2,
              runId,
              pid: process.pid,
              ownerStartTimeTicks,
              createdAt: launchArm.createdAt,
              status: "pending-steam",
              quarantineUntilEpochMs,
              saveSnapshotBeforeLaunch:
                serializeSaveSnapshot(saveSnapshotBeforeLaunch),
            });
            try {
              const launcher = createBg3LauncherObservation(runId, "steam", bg3SteamLaunchArguments(saveId));
              launcherObservations.set(runId, launcher);
              await launcher.launch();
              steamSpawned = true;
            } catch (error) {
              pendingLaunch = undefined;
              await writeRunLockOwner({
                schemaVersion: 2,
                runId,
                pid: process.pid,
                ownerStartTimeTicks,
                createdAt: launchArm.createdAt,
                status: "armed",
                quarantineUntilEpochMs,
              });
              throw error;
            }
          },
          cleanup: async () => cleanupHeadlessIsolation(runId),
        });
        launchedProcess = await discoverSingleGameProcess(
          PROCESS_DISCOVERY_TIMEOUT_MS,
        );
        if (launchedProcess === undefined) {
          throw new Bg3TestTimeoutError(
            `Timed out after ${PROCESS_DISCOVERY_TIMEOUT_MS} ms waiting for the BG3 process`,
          );
        }

        activeLaunch = {
          processIdentity: launchedProcess,
          runId,
          mode,
          display,
          networkLogsBeforeLaunch,
          builtinBridgePrepared,
          modSettingsPrepared,
          steamCloudPrepared: steamCloudPreparation.prepared,
          saveSnapshotBeforeLaunch,
        };
        pendingLaunch = undefined;
        const placedWindow = output.kind === "headless"
          ? await moveGameToHeadless(launchedProcess, output)
          : await verifyVisibleGameWindow(launchedProcess, output);
        const diagnosticProcess = launchedProcess;
        activeLaunch.windowDiagnostics = createBg3WindowDiagnostics({
          runId, display, process: diagnosticProcess, window: placedWindow, now: Date.now,
          readProcess: async () => readProcessIdentity(diagnosticProcess.pid),
          readHypr: async (query, signal) => new Promise<string>((resolve, reject) => {
            execFile("hyprctl", [query, "-j"], {
              encoding: "utf8", timeout: 750, killSignal: "SIGKILL", signal,
              maxBuffer: BG3_WINDOW_DIAGNOSTIC_LIMITS.queryBytes,
            }, (error, stdout) => error === null ? resolve(stdout) : reject(error));
          }),
          warn: (message) => console.warn(message),
        });
        windowDiagnostics.set(runId, activeLaunch.windowDiagnostics);
        await activeLaunch.windowDiagnostics.capture("after-placement", "placement-verified");
        throwIfInterrupted();
        return launchedProcess;
      } catch (launchError) {
        const cleanupErrors: unknown[] = [];
        const recordCleanup = async (
          operation: () => Promise<void>,
        ): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            cleanupErrors.push(error);
          }
        };
        try {
          if (steamSpawned && launchedProcess === undefined) {
            launchedProcess = await discoverSingleGameProcess(
              PROCESS_RECOVERY_TIMEOUT_MS,
            );
          }
        } catch (error) {
          cleanupErrors.push(error);
        }

        if (launchedProcess !== undefined) {
          const recoveredProcess = launchedProcess;
          activeLaunch ??= {
            processIdentity: recoveredProcess,
            runId,
            mode,
            networkLogsBeforeLaunch,
            builtinBridgePrepared,
            modSettingsPrepared,
            steamCloudPrepared: steamCloudPreparation.prepared,
            saveSnapshotBeforeLaunch,
          };
          pendingLaunch = undefined;
          await recordCleanup(async () => finalizeActiveGame(recoveredProcess));
        } else if (!steamSpawned) {
          if (builtinBridgePrepared) {
            await recordCleanup(async () => {
              assertNoBg3ProcessCandidates(
                await listGameProcesses(),
                "failed launch preparation builtin bridge restore",
              );
              await builtinBridge.restore(runId);
              builtinBridgePrepared = false;
            });
          }
          if (modSettingsPrepared) {
            await recordCleanup(async () => {
              assertNoBg3ProcessCandidates(
                await listGameProcesses(),
                "failed launch preparation mod settings restore",
              );
              await modSettings.restore(runId);
              modSettingsPrepared = false;
            });
          }
          if (steamCloudPreparation.prepared && !modSettingsPrepared) {
            await recordCleanup(async () => {
              assertNoBg3ProcessCandidates(
                await listGameProcesses(),
                "failed launch preparation Steam Cloud restore",
              );
              await restoreSteamCloud(
                runId,
                "failed launch preparation Steam Cloud restore",
                saveSnapshotBeforeLaunch,
              );
              steamCloudPreparation.prepared = false;
            });
          } else if (steamCloudPreparation.prepared) {
            cleanupErrors.push(new Error(
              "Steam Cloud remains disabled because modsettings.lsx could not be restored after launch preparation failed",
            ));
          }
          await recordCleanup(async () => cleanupHeadlessIsolation(runId));
        }

        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [launchError, ...cleanupErrors],
            "BG3 launch failed and its owned process could not be cleaned up",
          );
        }
        throw launchError;
      }
    },

    async waitForSaveLoaded(saveId, launchedAt, timeoutMs): Promise<void> {
      const launch = activeLaunch;
      if (launch === undefined) {
        throw new Error("Cannot verify a save before BG3 has launched");
      }
      const deadline = Date.now() + timeoutMs;

      do {
        throwIfInterrupted();
        await engineLogArchives.get(launch.runId)?.assertNoCrash();
        const current = await readProcessIdentity(launch.processIdentity.pid);
        if (current?.startTimeTicks !== launch.processIdentity.startTimeTicks) {
          throw new Error("BG3 exited before the requested save finished loading");
        }
        if (!(await validateScriptExtenderLoaded(launch.processIdentity, gameRoot))) {
          await wait(FILE_POLL_MS);
          continue;
        }

        const currentLogs = await listNetworkLogs(gameRoot);
        for (const log of currentLogs) {
          if (
            launch.networkLogsBeforeLaunch.has(log.key) ||
            log.modifiedAtMs < launchedAt.getTime() - 2_000
          ) {
            continue;
          }
          const contents = await readFile(log.path, "utf8");
          const inspection = inspectBg3SaveLoad(contents, saveId);
          if (inspection.unexpectedSaveId !== undefined) {
            throw new Error(
              `BG3 requested unexpected save ${inspection.unexpectedSaveId} in ${log.path}`,
            );
          }
          if (inspection.loaded) return;
        }
        await wait(FILE_POLL_MS);
      } while (Date.now() < deadline);

      throw new Bg3TestTimeoutError(
        `Timed out after ${timeoutMs} ms waiting for BG3 to load ${saveId}`,
      );
    },

    async waitForClientReady(runId, scenarioId, timeoutMs): Promise<void> {
      validateRunId(runId);
      const launch = activeLaunch;
      const arm = armedRun;
      if (
        launch === undefined ||
        launch.runId !== runId ||
        launch.mode !== "character-creation" ||
        arm === undefined ||
        arm.runId !== runId ||
        arm.scenarioId !== scenarioId ||
        arm.mode !== "character-creation"
      ) {
        throw new Error(
          "Cannot wait for character-creation readiness before its BG3 launch",
        );
      }
      const readyPath = path.join(runRoot(runId), "client-ready.json");
      await waitForBg3ClientReady({
        runId,
        scenarioId,
        createdAtEpochMs: arm.createdAtEpochMs,
        expiresAtEpochMs: arm.expiresAtEpochMs,
        timeoutMs,
        pollMs: FILE_POLL_MS,
        maxBytes: MAX_RESULT_BYTES,
        now: Date.now,
        sleep: async (durationMs) => wait(durationMs),
        assertGameRunning: async () => {
          throwIfInterrupted();
          await engineLogArchives.get(launch.runId)?.assertNoCrash();
          const current = await readProcessIdentity(launch.processIdentity.pid);
          if (current?.startTimeTicks !== launch.processIdentity.startTimeTicks) {
            throw new Error(
              "BG3 exited before the character-creation client became ready",
            );
          }
        },
        readAcknowledgement: async () => {
          try {
            const metadata = await stat(readyPath);
            return {
              size: metadata.size,
              contents: metadata.size > 0
                ? await readFile(readyPath, "utf8")
                : "",
            };
          } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return undefined;
            throw error;
          }
        },
      });
      await assertOnlyActiveGameProcess(
        launch,
        "builtin bridge restore during client startup",
      );
      await builtinBridge.restore(runId);
      launch.builtinBridgePrepared = false;
    },

    async waitForModLoad(runId, scenarioId, mode, timeoutMs): Promise<void> {
      validateRunId(runId);
      const launch = activeLaunch;
      const scenario = catalog.get(scenarioId);
      const arm = armedRun;
      if (
        scenario === undefined ||
        scenarioMode(scenario) !== mode ||
        launch === undefined ||
        launch.runId !== runId ||
        launch.mode !== mode ||
        launch.builtinBridgePrepared !== true ||
        arm === undefined ||
        arm.runId !== runId ||
        arm.scenarioId !== scenarioId
      ) {
        throw new Error(
          "Cannot observe loaded mods before the matching BG3 launch",
        );
      }
      const observationPath = path.join(runRoot(runId), "mod-load.json");
      const autosaveGuardPath = path.join(
        runRoot(runId),
        "autosave-guard.json",
      );
      const startupErrorPath = path.join(
        runRoot(runId),
        "startup-error.json",
      );
      const readObservedFile = async (
        filePath: string,
      ): Promise<Bg3ClientReadyFile | undefined> => {
        try {
          const metadata = await stat(filePath);
          return {
            size: metadata.size,
            contents: metadata.size > 0
              ? await readFile(filePath, "utf8")
              : "",
          };
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") return undefined;
          throw error;
        }
      };
      await waitForBg3ModLoad({
        runId,
        scenarioId,
        requiredMods: scenario.requiredMods,
        createdAtEpochMs: arm.createdAtEpochMs,
        expiresAtEpochMs: arm.expiresAtEpochMs,
        timeoutMs,
        pollMs: FILE_POLL_MS,
        stabilityMs: MOD_LOAD_STABILITY_MS,
        maxBytes: MAX_RESULT_BYTES,
        now: Date.now,
        sleep: async (durationMs) => wait(durationMs),
        assertGameRunning: async () => {
          throwIfInterrupted();
          await engineLogArchives.get(launch.runId)?.assertNoCrash();
          const current = await readProcessIdentity(launch.processIdentity.pid);
          if (current?.startTimeTicks !== launch.processIdentity.startTimeTicks) {
            throw new Error(
              "BG3 exited before the builtin bridge observed loaded mods",
            );
          }
        },
        readStartupError: async () => readObservedFile(startupErrorPath),
        readAutosaveGuard: async () => readObservedFile(autosaveGuardPath),
        readObservation: async () => readObservedFile(observationPath),
      });
    },

    async validateNewSave(runId, timeoutMs): Promise<string> {
      validateRunId(runId);
      const launch = activeLaunch;
      const arm = armedRun;
      if (arm !== undefined && arm.runId === runId && !bg3ArmPermitsTestSave(arm)) {
        throw new Error("Refusing to validate a save for a run that never saves");
      }
      if (
        launch === undefined ||
        launch.runId !== runId ||
        launch.mode !== "character-creation" ||
        launch.saveIntent === undefined ||
        arm === undefined ||
        arm.runId !== runId ||
        arm.mode !== "character-creation"
      ) {
        throw new Error("Cannot validate a new save outside character creation");
      }

      const requestStartedAt = Date.now();
      const request = await waitForSaveRequest(launch, arm, timeoutMs);
      const remainingMs = timeoutMs - (Date.now() - requestStartedAt);
      if (remainingMs <= 0) {
        throw new Bg3TestTimeoutError(
          `Timed out after ${timeoutMs} ms before validating the requested save`,
        );
      }
      const saveId = await waitForStableBg3SaveChange({
        before: launch.saveIntent.snapshotAtAck,
        requestedAtEpochMs: request.requestedAtEpochMs,
        timeoutMs: remainingMs,
        stabilityMs: SAVE_STABILITY_MS,
        pollMs: FILE_POLL_MS,
        now: Date.now,
        sleep: async (durationMs) => wait(durationMs),
        assertGameRunning: async () => assertLaunchRunning(
          launch,
          "BG3 exited before the new save could be validated",
        ),
        readSnapshot: async () => snapshotBg3SaveIdentities(saveRoot),
        protectedSaves,
      });
      const validatedSnapshot = await snapshotBg3SaveIdentities(saveRoot);
      const changes = changedBg3SaveIdentities(
        launch.saveIntent.snapshotAtAck,
        validatedSnapshot,
      );
      const change = changes[0];
      if (
        changes.length !== 1 ||
        change?.kind !== "created" ||
        change.after === undefined ||
        change.id !== saveId
      ) {
        throw new Error(
          "BG3 save state changed while recording the validated fixture",
        );
      }
      launch.validatedSave = change.after;
      return saveId;
    },

    async readResult(runId, timeoutMs): Promise<string> {
      validateRunId(runId);
      const launch = activeLaunch;
      const arm = armedRun?.runId === runId ? armedRun : undefined;
      const command = issuedCommand?.runId === runId ? issuedCommand : undefined;
      const pointerPolicy = arm === undefined ? undefined : catalog.get(arm.scenarioId)?.pointer;
      const needsPointer = pointerPolicy !== undefined;
      if (needsPointer && (launch?.runId !== runId || launch.display !== "visible" || command === undefined)) {
        throw new Error("Native pointer input requires an owned visible launch and command");
      }
      const driver = pointerPolicy && launch && arm && command
        ? createBg3PointerDriver({ packageRoot, runDirectory: runRoot(runId),
          processIdentity: launch.processIdentity, saveId: arm.saveId,
          scenarioId: arm.scenarioId, policy: pointerPolicy,
          ...(options.signal ? { signal: options.signal } : {}) })
        : undefined;
      const pointer = driver && pointerPolicy && launch && arm && command ? createBg3PointerSession({
        arm, command, policy: pointerPolicy, now: Date.now,
        readRequest: async () => readRunArtifact(runId, "spell-pointer.json"),
        assertInputAllowed: () => {
          throwIfInterrupted();
          driver.assertHealthy();
          if (activeLaunch !== launch || armedRun !== arm || issuedCommand !== command) {
            throw new Error("BG3 pointer run ownership changed before acknowledgment");
          }
        },
        assertActive: async () => {
          await assertLaunchRunning(launch, "BG3 exited before native pointer input");
          await assertOnlyActiveGameProcess(launch, "native pointer input");
          const currentArm = JSON.parse(await readFile(path.join(harnessRoot, "arm.json"), "utf8")) as unknown;
          const currentCommand = JSON.parse(await readFile(path.join(runRoot(runId), "command.json"), "utf8")) as unknown;
          if (JSON.stringify(currentArm) !== JSON.stringify(arm) || JSON.stringify(currentCommand) !== JSON.stringify(command)
            || await pathExists(path.join(runRoot(runId), "server-finalizing.json"))
            || await pathExists(path.join(runRoot(runId), "result.json"))) {
            throw new Error("BG3 pointer authorization changed during input");
          }
          throwIfInterrupted();
          driver.assertHealthy();
        },
        move: async (request) => driver.move(request),
        writeAck: async (value, beforeCommit) => {
          const phase = (value as { phase: "hover" | "leave" }).phase;
          await writeJsonAtomically(path.join(runRoot(runId), `spell-pointer-${phase}-ack.json`), value, beforeCommit);
          await writeJsonAtomically(path.join(runRoot(runId), "spell-pointer-ack.json"), value, beforeCommit);
        },
      }) : undefined;
      try {
        return await waitForBg3Result({
        runId,
        scenarioId: arm?.scenarioId ?? "unarmed-run",
        createdAtEpochMs: arm?.createdAtEpochMs ?? 0,
        expiresAtEpochMs:
          arm?.expiresAtEpochMs ?? Date.now() + timeoutMs,
        timeoutMs,
        pollMs: FILE_POLL_MS,
        maxBytes: MAX_RESULT_BYTES,
        startupGraceMs: SERVER_RESULT_GRACE_MS,
        finalizingDiscoveryGraceMs:
          launch?.runId === runId
            ? BG3_SERVER_FINALIZING_DISCOVERY_GRACE_MS
            : 1_000,
        resultDrainMs: launch?.runId === runId
          ? BG3_SERVER_RESULT_DRAIN_MS
          : 0,
        now: Date.now,
        sleep: async (durationMs) => wait(durationMs),
        assertGameRunning: async () => {
          throwIfInterrupted();
          if (launch === undefined || launch.runId !== runId) return;
          await assertLaunchRunning(
            launch,
            "BG3 exited before the Server result was available",
          );
        },
        onServerFinalizing: async () => {
          if (launch?.runId === runId) await launch.windowDiagnostics?.capture("terminal-observation", "server-finalizing");
        },
        readArtifact: async (name) => readRunArtifact(runId, name),
        onSaveIntent: async (intent) => acknowledgeSaveIntent(intent),
        ...(pointer ? { onClientInput: async () => pointer.poll() } : {}),
        });
      } finally {
        await driver?.close();
      }
    },

    async terminateGame(processIdentity): Promise<void> {
      await finalizeActiveGame(processIdentity);
    },

    writeOutput(line): void {
      console.log(line);
    },
  };
}
