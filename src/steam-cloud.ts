import { randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  access,
  constants,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";

export const BG3_STEAM_APP_ID = 1_086_940;

const OWNER_SCHEMA_VERSION = 1;
const HELPER_SCHEMA_VERSION = 1;
const OWNER_FILE_NAME = "steam-cloud-owner.json";
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_HELPER_TIMEOUT_MS = 15_000;
const DEFAULT_BUILD_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_POLL_MS = 250;

interface SteamCloudOwner {
  schemaVersion: number;
  runId: string;
  appId: number;
  harnessRoot: string;
  ownerPath: string;
  helperPath: string;
  buildScriptPath: string;
  steamApiLibraryPath: string;
  originalEnabled: boolean;
  modifiedEnabled: false;
}

export interface Bg3SteamCloudDisableSession {
  readonly originalEnabled: boolean;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface Bg3SteamCloudExecutor {
  readonly appId: number;
  readonly helperPath: string;
  readonly buildScriptPath: string;
  readonly steamApiLibraryPath: string;
  beginDisable(): Promise<Bg3SteamCloudDisableSession>;
  restoreOriginal(expectedEnabled: boolean): Promise<void>;
}

export interface SteamCloudHelperExecutorOptions {
  helperPath: string;
  buildScriptPath: string;
  steamApiLibraryPath: string;
  startClient: () => Promise<void>;
  timeoutMs?: number;
  buildTimeoutMs?: number;
  clientStartupTimeoutMs?: number;
  clientPollMs?: number;
}

export interface SteamClientSessionWaitOptions<TSession> {
  beginSession(remainingMs: number): Promise<TSession>;
  startClient(): Promise<void>;
  now(): number;
  sleep(durationMs: number): Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

export class SteamClientUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SteamClientUnavailableError";
  }
}

export function isSteamClientUnavailableHelperFailure(
  standardError: string,
): boolean {
  return standardError.split(/\r?\n/).some((line) =>
    line.startsWith(
      "steam-cloud-helper: SteamAPI_InitFlat failed with result 2: Cannot create IPC pipe to Steam client process.",
    ) ||
    line.startsWith(
      "steam-cloud-helper: SteamAPI_InitFlat failed with result 1: ConnectToGlobalUser failed.",
    )
  );
}

export interface Bg3SteamCloudOptions {
  harnessRoot: string;
  executor: Bg3SteamCloudExecutor;
}

export interface Bg3SteamCloudManager {
  hasPendingTransaction(): Promise<boolean>;
  pendingOriginalEnabled(): Promise<boolean | undefined>;
  prepare(runId: string): Promise<void>;
  restore(runId: string): Promise<boolean | undefined>;
  recover(): Promise<boolean | undefined>;
}

interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface RunningHelper {
  child: ChildProcessWithoutNullStreams;
  lines: AsyncIterator<string>;
  readline: ReadlineInterface;
  exit: Promise<HelperExit>;
  stderr(): string;
  outputError(): Error | undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
    throw new Error(`Unsafe BG3 test runId: ${runId}`);
  }
}

function normalizeAbsolutePath(label: string, value: string): string {
  if (
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function validateTimeout(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new Error(`${label} must be between 1 and 60000 ms`);
  }
  return value;
}

export async function waitForSteamClientSession<TSession>(
  options: SteamClientSessionWaitOptions<TSession>,
): Promise<TSession> {
  const timeoutMs = validateTimeout(
    "Steam client startup timeout",
    options.timeoutMs,
  );
  const pollMs = validateTimeout("Steam client poll interval", options.pollMs);
  const deadline = options.now() + timeoutMs;
  let lastError: unknown;

  const attempt = async (): Promise<TSession | undefined> => {
    const remainingMs = deadline - options.now();
    if (remainingMs <= 0) return undefined;
    try {
      return await options.beginSession(remainingMs);
    } catch (error) {
      if (!(error instanceof SteamClientUnavailableError)) throw error;
      lastError = error;
      return undefined;
    }
  };

  const existingSession = await attempt();
  if (existingSession !== undefined) return existingSession;
  if (options.now() >= deadline) {
    throw new Error(
      `Steam client did not become ready within ${timeoutMs} ms`,
      { cause: lastError },
    );
  }

  await options.startClient();
  while (options.now() < deadline) {
    await options.sleep(Math.min(pollMs, deadline - options.now()));
    const session = await attempt();
    if (session !== undefined) return session;
  }

  throw new Error(
    `Steam client did not become ready within ${timeoutMs} ms`,
    { cause: lastError },
  );
}

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeAtomically(
  destination: string,
  contents: string,
): Promise<void> {
  const directoryPath = path.dirname(destination);
  await mkdir(directoryPath, { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    await syncDirectory(directoryPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeJournal(ownerPath: string): Promise<void> {
  await rm(ownerPath, { force: true });
  await syncDirectory(path.dirname(ownerPath));
}

async function fileIsReady(
  filePath: string,
  executable: boolean,
): Promise<boolean> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size === 0) return false;
    if (executable) await access(filePath, constants.X_OK);
    return true;
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "EACCES")
    ) {
      return false;
    }
    throw error;
  }
}

async function requireReadyFile(
  filePath: string,
  label: string,
  executable: boolean,
): Promise<void> {
  if (!(await fileIsReady(filePath, executable))) {
    throw new Error(`${label} is missing, empty, or unusable: ${filePath}`);
  }
}

async function runBoundedCommand(
  executable: string,
  argumentsList: readonly string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, argumentsList, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`${label} produced too much output`)));
        return;
      }
      output += chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${label} timed out`)));
    }, timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0) resolve();
        else {
          const detail = output.trim();
          reject(new Error(
            `${label} failed with ${signal ?? `exit code ${String(code)}`}${
              detail === "" ? "" : `: ${detail}`
            }`,
          ));
        }
      });
    });
  });
}

function startHelper(
  helperPath: string,
  argumentsList: readonly string[],
): RunningHelper {
  const child = spawn(helperPath, argumentsList, {
    env: {
      ...process.env,
      SteamAppId: String(BG3_STEAM_APP_ID),
      SteamGameId: String(BG3_STEAM_APP_ID),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let standardError = "";
  let outputBytes = 0;
  let outputError: Error | undefined;
  const countOutput = (chunk: Buffer): void => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_HELPER_OUTPUT_BYTES && outputError === undefined) {
      outputError = new Error("The Steam Cloud helper produced too much output");
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", countOutput);
  child.stderr.on("data", (chunk: Buffer) => {
    countOutput(chunk);
    standardError += chunk.toString("utf8");
  });
  const readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = readline[Symbol.asyncIterator]();
  const exit = new Promise<HelperExit>((resolve) => {
    let resolved = false;
    const finish = (result: HelperExit): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
  return {
    child,
    lines,
    readline,
    exit,
    stderr: () => standardError,
    outputError: () => outputError,
  };
}

async function withHelperTimeout<T>(
  helper: RunningHelper,
  timeoutMs: number,
  operation: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          helper.child.kill("SIGKILL");
          reject(new Error("The Steam Cloud helper timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function assertCleanExit(helper: RunningHelper): Promise<void> {
  const result = await helper.exit;
  helper.readline.close();
  const outputError = helper.outputError();
  if (outputError !== undefined) throw outputError;
  if (result.error !== undefined) throw result.error;
  if (result.code !== 0) {
    const detail = helper.stderr().trim();
    const message =
      `Steam Cloud helper failed with ${result.signal ?? `exit code ${String(result.code)}`}${
        detail === "" ? "" : `: ${detail}`
      }`;
    if (isSteamClientUnavailableHelperFailure(detail)) {
      throw new SteamClientUnavailableError(message);
    }
    throw new Error(message);
  }
}

async function nextHelperLine(
  helper: RunningHelper,
  timeoutMs: number,
): Promise<string> {
  const next = await withHelperTimeout(helper, timeoutMs, helper.lines.next());
  if (next.done) {
    await assertCleanExit(helper);
    throw new Error("The Steam Cloud helper exited without a response");
  }
  return next.value;
}

function parseObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("The Steam Cloud helper returned invalid JSON", {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Steam Cloud helper returned an invalid response");
  }
  return parsed as Record<string, unknown>;
}

function validateCommonResponse(
  response: Record<string, unknown>,
  operation: "begin-disable" | "restore",
): void {
  if (
    response.schemaVersion !== HELPER_SCHEMA_VERSION ||
    response.appId !== BG3_STEAM_APP_ID ||
    response.operation !== operation
  ) {
    throw new Error(
      "The Steam Cloud helper response does not describe the requested BG3 operation",
    );
  }
}

async function writeHandshake(
  helper: RunningHelper,
  command: "commit" | "abort",
): Promise<void> {
  if (!helper.child.stdin.write(`${command}\n`)) {
    await new Promise<void>((resolve, reject) => {
      helper.child.stdin.once("drain", resolve);
      helper.child.stdin.once("error", reject);
    });
  }
  helper.child.stdin.end();
}

export function createSteamCloudHelperExecutor(
  options: SteamCloudHelperExecutorOptions,
): Bg3SteamCloudExecutor {
  const helperPath = normalizeAbsolutePath("helperPath", options.helperPath);
  const buildScriptPath = normalizeAbsolutePath(
    "buildScriptPath",
    options.buildScriptPath,
  );
  const steamApiLibraryPath = normalizeAbsolutePath(
    "steamApiLibraryPath",
    options.steamApiLibraryPath,
  );
  const timeoutMs = validateTimeout(
    "Steam Cloud helper timeout",
    options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
  );
  const buildTimeoutMs = validateTimeout(
    "Steam Cloud helper build timeout",
    options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
  );
  const clientStartupTimeoutMs = validateTimeout(
    "Steam client startup timeout",
    options.clientStartupTimeoutMs ?? DEFAULT_CLIENT_STARTUP_TIMEOUT_MS,
  );
  const clientPollMs = validateTimeout(
    "Steam client poll interval",
    options.clientPollMs ?? DEFAULT_CLIENT_POLL_MS,
  );
  let buildInProgress: Promise<void> | undefined;

  async function ensureHelper(): Promise<void> {
    const sourcePath = path.join(path.dirname(buildScriptPath), "main.cpp");
    await requireReadyFile(
      buildScriptPath,
      "Steam Cloud helper build script",
      true,
    );
    await requireReadyFile(sourcePath, "Steam Cloud helper source", false);
    const helperReady = await fileIsReady(helperPath, true);
    const helperMetadata = helperReady ? await stat(helperPath) : undefined;
    const buildMetadata = await stat(buildScriptPath);
    const sourceMetadata = await stat(sourcePath);
    if (
      helperMetadata !== undefined &&
      helperMetadata.mtimeMs >= buildMetadata.mtimeMs &&
      helperMetadata.mtimeMs >= sourceMetadata.mtimeMs
    ) {
      return;
    }
    if (buildInProgress === undefined) {
      buildInProgress = (async () => {
        await runBoundedCommand(
          buildScriptPath,
          [helperPath],
          buildTimeoutMs,
          "Steam Cloud helper build",
        );
        await requireReadyFile(helperPath, "Steam Cloud helper", true);
      })();
    }
    try {
      await buildInProgress;
    } finally {
      buildInProgress = undefined;
    }
  }

  async function validateRuntime(): Promise<void> {
    await ensureHelper();
    await requireReadyFile(
      steamApiLibraryPath,
      "Steamworks API library",
      false,
    );
  }

  async function beginDisableSession(
    startupBudgetMs: number,
  ): Promise<Bg3SteamCloudDisableSession> {
    const helper = startHelper(helperPath, [
      "--steam-api",
      steamApiLibraryPath,
      "begin-disable",
    ]);
    let ready: Record<string, unknown>;
    try {
      ready = parseObject(await nextHelperLine(
        helper,
        Math.min(timeoutMs, startupBudgetMs),
      ));
      validateCommonResponse(ready, "begin-disable");
      if (ready.phase !== "ready" || typeof ready.originalEnabled !== "boolean") {
        throw new Error("The Steam Cloud helper returned an invalid ready response");
      }
    } catch (error) {
      helper.child.kill("SIGKILL");
      await helper.exit;
      throw error;
    }
    const originalEnabled = ready.originalEnabled as boolean;
    let completed = false;

    async function finish(command: "commit" | "abort"): Promise<void> {
      if (completed) {
        throw new Error("The Steam Cloud disable handshake already finished");
      }
      completed = true;
      await writeHandshake(helper, command);
      const response = parseObject(await nextHelperLine(helper, timeoutMs));
      validateCommonResponse(response, "begin-disable");
      const expectedPhase = command === "commit" ? "complete" : "aborted";
      const expectedEnabled = command === "commit" ? false : originalEnabled;
      if (
        response.phase !== expectedPhase ||
        response.originalEnabled !== originalEnabled ||
        response.enabled !== expectedEnabled
      ) {
        helper.child.kill("SIGKILL");
        await helper.exit;
        throw new Error(
          "The Steam Cloud helper did not verify the disable handshake",
        );
      }
      await withHelperTimeout(helper, timeoutMs, assertCleanExit(helper));
    }

    return Object.freeze({
      originalEnabled,
      commit: () => finish("commit"),
      abort: () => finish("abort"),
    });
  }

  return Object.freeze({
    appId: BG3_STEAM_APP_ID,
    helperPath,
    buildScriptPath,
    steamApiLibraryPath,

    async beginDisable(): Promise<Bg3SteamCloudDisableSession> {
      await validateRuntime();
      return waitForSteamClientSession({
        beginSession: beginDisableSession,
        startClient: options.startClient,
        now: Date.now,
        sleep: async (durationMs) => wait(durationMs),
        timeoutMs: clientStartupTimeoutMs,
        pollMs: clientPollMs,
      });
    },

    async restoreOriginal(expectedEnabled: boolean): Promise<void> {
      await validateRuntime();
      const helper = startHelper(helperPath, [
        "--steam-api",
        steamApiLibraryPath,
        "restore",
        "--expected-original",
        expectedEnabled ? "true" : "false",
      ]);
      try {
        const response = parseObject(await nextHelperLine(helper, timeoutMs));
        validateCommonResponse(response, "restore");
        if (
          response.previousEnabled !== false ||
          response.enabled !== expectedEnabled
        ) {
          throw new Error(
            "The Steam Cloud helper did not verify the restored BG3 state",
          );
        }
        await withHelperTimeout(helper, timeoutMs, assertCleanExit(helper));
      } catch (error) {
        helper.child.kill("SIGKILL");
        await helper.exit;
        throw error;
      }
    },
  });
}

function ownerFromJson(
  raw: string,
  expected: {
    harnessRoot: string;
    ownerPath: string;
    executor: Bg3SteamCloudExecutor;
  },
): SteamCloudOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("The Steam Cloud owner file is not valid JSON", {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Steam Cloud owner file is invalid");
  }
  const owner = parsed as Record<string, unknown>;
  if (
    owner.schemaVersion !== OWNER_SCHEMA_VERSION ||
    typeof owner.runId !== "string" ||
    owner.appId !== BG3_STEAM_APP_ID ||
    typeof owner.harnessRoot !== "string" ||
    typeof owner.ownerPath !== "string" ||
    typeof owner.helperPath !== "string" ||
    typeof owner.buildScriptPath !== "string" ||
    typeof owner.steamApiLibraryPath !== "string" ||
    typeof owner.originalEnabled !== "boolean" ||
    owner.modifiedEnabled !== false
  ) {
    throw new Error("The Steam Cloud owner file is invalid");
  }
  validateRunId(owner.runId);
  if (
    owner.harnessRoot !== expected.harnessRoot ||
    owner.ownerPath !== expected.ownerPath ||
    owner.helperPath !== expected.executor.helperPath ||
    owner.buildScriptPath !== expected.executor.buildScriptPath ||
    owner.steamApiLibraryPath !== expected.executor.steamApiLibraryPath
  ) {
    throw new Error("The Steam Cloud owner file targets unexpected paths");
  }
  return owner as unknown as SteamCloudOwner;
}

export function createBg3SteamCloudManager(
  options: Bg3SteamCloudOptions,
): Bg3SteamCloudManager {
  const harnessRoot = normalizeAbsolutePath("harnessRoot", options.harnessRoot);
  if (options.executor.appId !== BG3_STEAM_APP_ID) {
    throw new Error(
      `The Steam Cloud executor targets AppID ${options.executor.appId}, expected ${BG3_STEAM_APP_ID}`,
    );
  }
  normalizeAbsolutePath("executor.helperPath", options.executor.helperPath);
  normalizeAbsolutePath(
    "executor.buildScriptPath",
    options.executor.buildScriptPath,
  );
  normalizeAbsolutePath(
    "executor.steamApiLibraryPath",
    options.executor.steamApiLibraryPath,
  );
  const ownerPath = path.join(harnessRoot, OWNER_FILE_NAME);
  const expectedOwner = {
    harnessRoot,
    ownerPath,
    executor: options.executor,
  };

  async function loadOwner(): Promise<SteamCloudOwner | undefined> {
    const contents = await readOptional(ownerPath);
    return contents === undefined
      ? undefined
      : ownerFromJson(contents.toString("utf8"), expectedOwner);
  }

  async function restoreOwner(owner: SteamCloudOwner): Promise<boolean> {
    await options.executor.restoreOriginal(owner.originalEnabled);
    await removeJournal(ownerPath);
    return owner.originalEnabled;
  }

  return {
    async hasPendingTransaction(): Promise<boolean> {
      return (await loadOwner()) !== undefined;
    },

    async pendingOriginalEnabled(): Promise<boolean | undefined> {
      return (await loadOwner())?.originalEnabled;
    },

    async prepare(runId): Promise<void> {
      validateRunId(runId);
      const existingOwner = await loadOwner();
      if (existingOwner !== undefined) {
        throw new Error(
          "Steam Cloud has an unfinished transaction; recover modsettings before Steam Cloud",
        );
      }

      const session = await options.executor.beginDisable();
      if (typeof session.originalEnabled !== "boolean") {
        await session.abort();
        throw new Error(
          "The Steam Cloud executor returned a non-boolean original state",
        );
      }
      const owner: SteamCloudOwner = {
        schemaVersion: OWNER_SCHEMA_VERSION,
        runId,
        appId: BG3_STEAM_APP_ID,
        harnessRoot,
        ownerPath,
        helperPath: options.executor.helperPath,
        buildScriptPath: options.executor.buildScriptPath,
        steamApiLibraryPath: options.executor.steamApiLibraryPath,
        originalEnabled: session.originalEnabled,
        modifiedEnabled: false,
      };

      try {
        await writeAtomically(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
      } catch (error) {
        try {
          await session.abort();
          await removeJournal(ownerPath);
        } catch (abortError) {
          throw new AggregateError(
            [error, abortError],
            "Steam Cloud journaling failed and the disable handshake could not be aborted",
          );
        }
        throw error;
      }

      try {
        await session.commit();
      } catch (error) {
        try {
          await restoreOwner(owner);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Steam Cloud preparation failed and its original state could not be restored; the recovery journal was kept",
          );
        }
        throw error;
      }
    },

    async restore(runId): Promise<boolean | undefined> {
      validateRunId(runId);
      const owner = await loadOwner();
      if (owner === undefined) return;
      if (owner.runId !== runId) {
        throw new Error(
          `Steam Cloud ownership belongs to ${owner.runId}, not ${runId}`,
        );
      }
      return restoreOwner(owner);
    },

    async recover(): Promise<boolean | undefined> {
      const owner = await loadOwner();
      return owner === undefined ? undefined : restoreOwner(owner);
    },
  };
}
