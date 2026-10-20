import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createBg3SteamCloudManager,
  createSteamCloudHelperExecutor,
} from "../src/steam-cloud.js";

const execute = promisify(execFile);
const buildScriptPath = path.resolve("steam-cloud-helper/build.sh");
let root: string;
let helperPath: string;
let libraryPath: string;
let controlPath: string;
let mutationsPath: string;
let harnessRoot: string;

function sdkSource(): string {
  return `
#include <cstdio>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>

static void diagnostic(const char* phase) {
  std::printf("IPC function call fake Steamworks diagnostic: %s\\n", phase);
  std::fflush(stdout);
}
__attribute__((constructor)) static void loaded() { diagnostic("dlopen"); }
__attribute__((destructor)) static void unloaded() { diagnostic("dlclose"); }
struct State { int result; int enabled; };
static State read_state() {
  State state{};
  std::ifstream input(${JSON.stringify(controlPath)});
  if (!(input >> state.result >> state.enabled)) throw std::runtime_error("missing fake SDK state");
  return state;
}
extern "C" int SteamAPI_InitFlat(char* error) {
  diagnostic("init");
  const int result = read_state().result;
  if (result == 2) std::strcpy(error, "Cannot create IPC pipe to Steam client process.");
  else if (result != 0) std::strcpy(error, "unknown fake SDK failure");
  return result;
}
extern "C" void SteamAPI_Shutdown() { diagnostic("shutdown"); }
extern "C" void* SteamAPI_SteamUtils_v011() { static int instance; return &instance; }
extern "C" void* SteamAPI_SteamRemoteStorage_v016() { static int instance; return &instance; }
extern "C" unsigned SteamAPI_ISteamUtils_GetAppID(void*) { return 1086940; }
extern "C" bool SteamAPI_ISteamRemoteStorage_IsCloudEnabledForApp(void*) {
  diagnostic("query");
  return read_state().enabled != 0;
}
extern "C" void SteamAPI_ISteamRemoteStorage_SetCloudEnabledForApp(void*, bool enabled) {
  diagnostic("set");
  std::ifstream journal(${JSON.stringify(path.join(harnessRoot, "steam-cloud-owner.json"))});
  const std::string body((std::istreambuf_iterator<char>(journal)), std::istreambuf_iterator<char>());
  std::ofstream mutations(${JSON.stringify(mutationsPath)}, std::ios::app);
  mutations << (enabled ? "enable" : "disable") << ":"
            << (body.find("\\\"modifiedEnabled\\\": false") != std::string::npos ? "journaled" : "unjournaled") << "\\n";
  mutations.close();
  const auto state = read_state();
  std::ofstream output(${JSON.stringify(controlPath)});
  output << state.result << " " << (enabled ? 1 : 0) << "\\n";
}
`;
}

function executor(startClient: () => Promise<void> = async () => {
  throw new Error("This test must not start Steam");
}) {
  return createSteamCloudHelperExecutor({
    helperPath, buildScriptPath, steamApiLibraryPath: libraryPath, startClient,
    timeoutMs: 2_000, clientStartupTimeoutMs: 3_000, clientPollMs: 10,
  });
}

async function rawHelper(argumentsList: string[], input = "") {
  const child = spawn(helperPath, ["--steam-api", libraryPath, ...argumentsList], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.stdin.once("error", reject);
    });
    child.stdin.end(input);
    return { ...await closed, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-steam-helper-test-"));
  helperPath = path.join(root, "steam-cloud-helper");
  libraryPath = path.join(root, "fake-steam-api.so");
  controlPath = path.join(root, "sdk-state");
  mutationsPath = path.join(root, "mutations");
  harnessRoot = path.join(root, "harness");
  const sourcePath = path.join(root, "fake-steam-api.cpp");
  await writeFile(sourcePath, sdkSource());
  await execute(buildScriptPath, [helperPath], { timeout: 30_000 });
  await execute(process.env.CXX ?? "c++", [
    "-std=c++20", "-shared", "-fPIC", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", libraryPath,
  ], { timeout: 30_000 });
}, 60_000);

beforeEach(async () => {
  await writeFile(controlPath, "0 1\n");
  await writeFile(mutationsPath, "");
  await rm(harnessRoot, { recursive: true, force: true });
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("Steam Cloud native helper protocol", () => {
  it("keeps SDK stdout diagnostics out of JSON through init, abort and shutdown", async () => {
    const result = await rawHelper(["begin-disable"], "abort\n");
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses).toEqual([
      { schemaVersion: 1, appId: 1086940, operation: "begin-disable", phase: "ready", originalEnabled: true },
      { schemaVersion: 1, appId: 1086940, operation: "begin-disable", phase: "aborted", originalEnabled: true, enabled: true },
    ]);
    for (const phase of ["dlopen", "init", "query", "shutdown", "dlclose"]) {
      expect(result.stderr).toContain(`fake Steamworks diagnostic: ${phase}\n`);
    }
    expect(await readFile(mutationsPath, "utf8")).toBe("");
  });

  it("does not mutate Cloud before commit or after an aborted real executor session", async () => {
    const session = await executor().beginDisable();
    try {
      expect(session.originalEnabled).toBe(true);
      expect(await readFile(mutationsPath, "utf8")).toBe("");
      expect(await readFile(controlPath, "utf8")).toBe("0 1\n");
    } finally {
      await session.abort();
    }
    expect(await readFile(mutationsPath, "utf8")).toBe("");
    expect(await readFile(controlPath, "utf8")).toBe("0 1\n");
  });

  it("preserves journal-before-commit and restores with SDK diagnostics on every call", async () => {
    const manager = createBg3SteamCloudManager({ harnessRoot, executor: executor() });
    await manager.prepare("run-sdk-output");
    expect(await readFile(mutationsPath, "utf8")).toBe("disable:journaled\n");
    expect(await readFile(controlPath, "utf8")).toBe("0 0\n");
    expect(await manager.hasPendingTransaction()).toBe(true);
    await expect(manager.restore("run-sdk-output")).resolves.toBe(true);
    expect(await readFile(mutationsPath, "utf8")).toBe("disable:journaled\nenable:journaled\n");
    expect(await readFile(controlPath, "utf8")).toBe("0 1\n");
    expect(await manager.hasPendingTransaction()).toBe(false);
  });

  it("recognizes unavailable Steam despite SDK stdout and starts the client once", async () => {
    await writeFile(controlPath, "2 1\n");
    let starts = 0;
    const session = await executor(async () => {
      starts += 1;
      expect(await readFile(mutationsPath, "utf8")).toBe("");
      await writeFile(controlPath, "0 1\n");
    }).beginDisable();
    try {
      expect(starts).toBe(1);
      expect(session.originalEnabled).toBe(true);
    } finally {
      await session.abort();
    }
    expect(await readFile(mutationsPath, "utf8")).toBe("");
  });

  it("keeps unknown SDK failures fatal without starting Steam or changing Cloud", async () => {
    await writeFile(controlPath, "1 1\n");
    let starts = 0;
    await expect(executor(async () => { starts += 1; }).beginDisable())
      .rejects.toThrow("SteamAPI_InitFlat failed with result 1: unknown fake SDK failure");
    expect(starts).toBe(0);
    expect(await readFile(mutationsPath, "utf8")).toBe("");
  });

  it("rejects an invalid handshake without changing Cloud", async () => {
    const result = await rawHelper(["begin-disable"], "not-commit\n");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ phase: "ready" });
    expect(result.stderr).toContain("Expected commit or abort");
    expect(await readFile(mutationsPath, "utf8")).toBe("");
  });
});
