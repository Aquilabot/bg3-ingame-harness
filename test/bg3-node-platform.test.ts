import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bg3SteamLaunchArguments,
  BG3_SERVER_FINALIZING_DISCOVERY_GRACE_MS,
  BG3_SERVER_RESULT_DRAIN_MS,
  bg3HeadlessOutputCreateArguments,
  bg3HeadlessWindowCommands,
  bg3HeadlessWindowRuleCleanupExpression,
  bg3HeadlessWindowRuleInstallExpression,
  bg3HeadlessWorkspaceRenameExpression,
  assertBg3CreationSavePostcondition,
  bg3ArmPermitsTestSave,
  assertBg3HeadlessWorkspaceAvailable,
  assertNoBg3ProcessCandidates,
  assertBg3SaveRequestMatchesAcknowledgement,
  assertNoBg3SaveChanges,
  auditBg3SavePostconditionForDuration,
  changedBg3SaveIdentities,
  createNodeBg3TestPlatform,
  environmentHasAppId,
  focusBg3VisibleWindowOnce,
  identifyCreatedHeadlessOutput,
  identifyReusableHeadlessOutput,
  inspectBg3SteamCloudExitSync,
  isMappedBg3WindowCandidate,
  inspectNewBg3Save,
  newBg3SaveIds,
  numericProcessIds,
  parseHyprlandDesktopLocked,
  prepareBg3SteamCloudForLaunch,
  prepareBg3HeadlessLaunch,
  singleNewBg3SaveId,
  snapshotBg3SaveIdentities,
  steamClientStartArguments,
  selectBg3LaunchDisplay,
  selectBg3VisibleMonitor,
  waitForStableBg3SaveChange,
  waitForStableNewBg3Save,
  waitForBg3ClientReady,
  waitForBg3ModLoad,
  waitForBg3Result,
} from "../src/node-platform.js";
import type { Bg3TestCommand } from "../src/protocol.js";
import type { Bg3SteamCloudManager } from "../src/steam-cloud.js";
import { runBg3Test } from "../src/runner.js";
import { harnessMod, testCatalog, testPlatformOptions, testProtectedSaves } from "./fixtures.js";
import { createBg3TestScenarioCatalog } from "../src/scenario-catalog.js";

const runtimeWireRequirements = {
  savePolicy: "never",
  requiredAssertionIds: ["host-entity", "host-party-member"],
} as const;

const creationWireRequirements = {
  savePolicy: "create-test-fixture",
  requiredAssertionIds: [
    "character-creation-started",
    "character-selected-for-user",
    "character-creation-finished",
    "creation-profile-recorded",
    "selected-avatar-is-host",
    "host-profile-recorded",
    "creation-profile-matches",
    "host-is-player",
    "world-region",
    "example-background-background",
    "example-background-passive-HarnessExample_PassiveA",
    "example-background-passive-HarnessExample_PassiveB",
    "example-background-passive-HarnessExample_SkillSelection",
    "runtime-mechanic-spell",
  ],
} as const;

describe("Node BG3 platform", () => {
  it.each([false, true])(
    "tracks Cloud recovery state after a failed preparation with pending=%s",
    async (pending) => {
      const state = { prepared: false };
      const manager: Bg3SteamCloudManager = {
        hasPendingTransaction: async () => pending,
        pendingOriginalEnabled: async () => undefined,
        prepare: async () => {
          throw new Error("Steam IPC unavailable");
        },
        restore: async () => undefined,
        recover: async () => undefined,
      };

      await expect(prepareBg3SteamCloudForLaunch(
        manager,
        "run-cloud-prepare-failure",
        state,
      )).rejects.toThrow("Steam IPC unavailable");
      expect(state.prepared).toBe(pending);
    },
  );

  it("lets an observed Server bypass broken fallback artifacts", async () => {
    let nowMs = 0;
    let fallbackReads = 0;
    const serverResult = '{"source":"server"}\n';

    await expect(waitForBg3Result({
      runId: "run-server-marker",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs: 100,
      resultDrainMs: 1_000,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) => {
        if (name === "result.json") {
          return nowMs >= 400
            ? { size: serverResult.length, contents: serverResult }
            : undefined;
        }
        if (name === "server-ready.json") {
          return { size: 1_025, contents: "" };
        }
        if (name === "client-error.json" || name === "startup-error.json") {
          fallbackReads += 1;
          throw new Error("Fallback should not be read while Server is active");
        }
        return undefined;
      },
    })).resolves.toBe(serverResult);
    expect(fallbackReads).toBe(0);
  });

  it("discovers finalizing at the deadline and drains only result retries", async () => {
    let nowMs = 0;
    const serverResult = '{"source":"server"}\n';

    await expect(waitForBg3Result({
      runId: "run-server-drain",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs: 200,
      resultDrainMs: 31_000,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) => {
        if (name === "result.json") {
          return nowMs >= 32_050
            ? { size: serverResult.length, contents: serverResult }
            : { size: 10, contents: '{"source":' };
        }
        if (name === "server-ready.json") {
          const contents = JSON.stringify({
            schemaVersion: 2,
            runId: "run-server-drain",
            scenarioId: "core.runtime-smoke",
            status: "ready",
            readyAtEpochMs: 100,
          });
          return { size: contents.length, contents };
        }
        if (name === "server-finalizing.json" && nowMs >= 1_100) {
          const contents = JSON.stringify({
            schemaVersion: 2,
            runId: "run-server-drain",
            scenarioId: "core.runtime-smoke",
            status: "finalizing",
            finalizingAtEpochMs: 900,
          });
          return { size: contents.length, contents };
        }
        return undefined;
      },
    })).resolves.toBe(serverResult);
    expect(nowMs).toBeGreaterThanOrEqual(32_050);
  });

  it("anchors result drain after the complete finalizing discovery window", async () => {
    let nowMs = 0;
    const serverResult = '{"source":"server-after-early-marker"}\n';

    await expect(waitForBg3Result({
      runId: "run-early-finalizing",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs: 200,
      resultDrainMs: 1_000,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) => {
        if (name === "result.json" && nowMs >= 1_500) {
          return { size: serverResult.length, contents: serverResult };
        }
        if (name === "server-finalizing.json" && nowMs >= 100) {
          const contents = JSON.stringify({
            schemaVersion: 2,
            runId: "run-early-finalizing",
            scenarioId: "core.runtime-smoke",
            status: "finalizing",
            finalizingAtEpochMs: 100,
          });
          return { size: contents.length, contents };
        }
        return undefined;
      },
    })).resolves.toBe(serverResult);
    expect(nowMs).toBe(1_500);
  });

  it("does not use invalid finalizing to start the drain early", async () => {
    let nowMs = 0;

    await expect(waitForBg3Result({
      runId: "run-no-drain",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs: 200,
      resultDrainMs: 31_000,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) => {
        if (name === "server-ready.json") {
          const contents = JSON.stringify({
            schemaVersion: 2,
            runId: "run-no-drain",
            scenarioId: "core.runtime-smoke",
            status: "ready",
            readyAtEpochMs: 100,
          });
          return { size: contents.length, contents };
        }
        if (name === "server-finalizing.json" && nowMs >= 1_000) {
          const contents = JSON.stringify({
            schemaVersion: 2,
            runId: "run-no-drain",
            scenarioId: "core.runtime-smoke",
            status: "done",
            finalizingAtEpochMs: 900,
          });
          return { size: contents.length, contents };
        }
        return undefined;
      },
    })).rejects.toThrow("Server finalizing status must be finalizing");
    expect(nowMs).toBe(1_000 + 200 + BG3_SERVER_RESULT_DRAIN_MS);
  });

  it("discovers finalizing throughout the 30 second discovery window", async () => {
    let nowMs = 0;
    const serverResult = '{"source":"late-server"}';

    await expect(waitForBg3Result({
      runId: "run-late-finalizing",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 1_000,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs:
        BG3_SERVER_FINALIZING_DISCOVERY_GRACE_MS,
      resultDrainMs: BG3_SERVER_RESULT_DRAIN_MS,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) => {
        if (name === "result.json" && nowMs >= 60_500) {
          return { size: serverResult.length, contents: serverResult };
        }
        if (name === "server-finalizing.json" && nowMs >= 30_950) {
          const contents = JSON.stringify({
            schemaVersion: 2,
            runId: "run-late-finalizing",
            scenarioId: "core.runtime-smoke",
            status: "finalizing",
            finalizingAtEpochMs: 900,
          });
          return { size: contents.length, contents };
        }
        return undefined;
      },
    })).resolves.toBe(serverResult);
    expect(BG3_SERVER_FINALIZING_DISCOVERY_GRACE_MS).toBe(30_000);
    expect(nowMs).toBeGreaterThanOrEqual(60_500);
  });

  it("drains Server result retries after discovery without finalizing", async () => {
    let nowMs = 0;
    const serverResult = '{"source":"ready-server"}';
    const ready = JSON.stringify({
      schemaVersion: 2,
      runId: "run-ready-drain",
      scenarioId: "core.runtime-smoke",
      status: "ready",
      readyAtEpochMs: 100,
    });

    await expect(waitForBg3Result({
      runId: "run-ready-drain",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs: 200,
      resultDrainMs: 31_000,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) => {
        if (name === "result.json" && nowMs >= 5_000) {
          return { size: serverResult.length, contents: serverResult };
        }
        if (name === "server-ready.json") {
          return { size: ready.length, contents: ready };
        }
        return undefined;
      },
    })).resolves.toBe(serverResult);
    expect(nowMs).toBe(5_000);
  });

  it("reserves invalid fallback JSON until the deadline while BG3 lives", async () => {
    let nowMs = 0;
    const invalidFallback = '{"source":';

    await expect(waitForBg3Result({
      runId: "run-invalid-fallback",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs:
        BG3_SERVER_FINALIZING_DISCOVERY_GRACE_MS,
      resultDrainMs: BG3_SERVER_RESULT_DRAIN_MS,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) =>
        name === "client-error.json"
          ? { size: invalidFallback.length, contents: invalidFallback }
          : undefined,
    })).resolves.toBe(invalidFallback);
    expect(nowMs).toBe(
      1_000 +
        BG3_SERVER_FINALIZING_DISCOVERY_GRACE_MS +
        BG3_SERVER_RESULT_DRAIN_MS,
    );
  });

  it("releases a fallback early only after BG3 exit is confirmed", async () => {
    let nowMs = 0;
    let runningChecks = 0;
    const fallback = '{"source":"client"}';

    await expect(waitForBg3Result({
      runId: "run-dead-fallback",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs: 100,
      resultDrainMs: 31_000,
      assertGameRunning: async () => {
        runningChecks += 1;
        if (nowMs >= 100) throw new Error("BG3 exited");
      },
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) =>
        name === "client-error.json"
          ? { size: fallback.length, contents: fallback }
          : undefined,
    })).resolves.toBe(fallback);
    expect(nowMs).toBe(200);
    expect(runningChecks).toBeGreaterThan(1);
  });

  it("does not handle save intent discovered after the scenario deadline", async () => {
    let nowMs = 0;
    let handlerCalls = 0;

    await expect(waitForBg3Result({
      runId: "run-late-intent",
      scenarioId: "example.background-creation",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs: 200,
      resultDrainMs: 31_000,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) => {
        if (name === "save-intent.json" && nowMs >= 1_000) {
          const contents = JSON.stringify({
            schemaVersion: 2,
            runId: "run-late-intent",
            scenarioId: "example.background-creation",
            status: "intent",
            intentId: "run-late-intent.save1",
            intentAtEpochMs: 900,
          });
          return { size: contents.length, contents };
        }
        return undefined;
      },
      onSaveIntent: async () => {
        handlerCalls += 1;
      },
    })).rejects.toThrow("Timed out after 1000 ms");
    expect(handlerCalls).toBe(0);
  });

  it("handles one save intent idempotently before returning Server result", async () => {
    let nowMs = 0;
    const handledIntentIds: string[] = [];
    const serverResult = '{"source":"server"}';
    const saveIntent = JSON.stringify({
      schemaVersion: 2,
      runId: "run-save-intent",
      scenarioId: "example.background-creation",
      status: "intent",
      intentId: "run-save-intent.save1",
      intentAtEpochMs: 100,
    });

    await expect(waitForBg3Result({
      runId: "run-save-intent",
      scenarioId: "example.background-creation",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      timeoutMs: 1_000,
      pollMs: 100,
      maxBytes: 1_024,
      startupGraceMs: 200,
      finalizingDiscoveryGraceMs: 100,
      resultDrainMs: 31_000,
      assertGameRunning: async () => undefined,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      readArtifact: async (name) => {
        if (name === "result.json" && nowMs >= 300) {
          return { size: serverResult.length, contents: serverResult };
        }
        if (name === "save-intent.json") {
          return { size: saveIntent.length, contents: saveIntent };
        }
        return undefined;
      },
      onSaveIntent: async (intent) => {
        handledIntentIds.push(intent.intentId);
      },
    })).resolves.toBe(serverResult);
    expect(handledIntentIds).toEqual(["run-save-intent.save1"]);
  });
  it("filters procfs names without statting transient process entries", () => {
    expect(numericProcessIds(["1", "4002973", "self", "thread-self", "12x"]))
      .toEqual([1, 4_002_973]);
  });

  it("recognizes every Steam AppID marker used by the BG3 process tree", () => {
    for (const key of ["SteamAppId", "SteamGameId", "SteamOverlayGameId"]) {
      expect(environmentHasAppId(Buffer.from(
        `PATH=/usr/bin\0${key}=1086940\0`,
      ))).toBe(true);
    }
    expect(environmentHasAppId(Buffer.from(
      "SteamAppId=241100\0SteamGameId=241100\0",
    ))).toBe(false);
  });

  it("recognizes only a complete new BG3 AutoCloud exit upload", () => {
    expect(inspectBg3SteamCloudExitSync([
      "[AppID 1086940] Upload complete in build list",
      "[AppID 241100] Starting sync (up,AC Exit,)",
      "[AppID 241100] AutoCloud complete",
      "[AppID 241100] Upload complete in build list",
      "[AppID 1086940] Starting sync (up,AC Exit,)",
      "[AppID 1086940] AutoCloud complete",
      "[AppID 1086940] Upload complete, result OK",
    ].join("\n"))).toEqual({
      started: true,
      autoCloudComplete: true,
      uploadComplete: true,
    });
  });

  it("does not treat AutoCloud scanning as completed upload", () => {
    expect(inspectBg3SteamCloudExitSync([
      "[AppID 1086940] Starting sync (up,AC Exit,)",
      "[AppID 1086940] AutoCloud complete",
    ].join("\n"))).toEqual({
      started: true,
      autoCloudComplete: true,
      uploadComplete: false,
    });
  });

  it("recognizes an exit upload after Steam restarts, with the same completion requirements", () => {
    const start = "[AppID 1086940] Starting sync (init,up,AC Exit,)";
    const scan = "[AppID 1086940] AutoCloud complete";
    expect(inspectBg3SteamCloudExitSync([start, scan].join("\n"))).toEqual({
      started: true, autoCloudComplete: true, uploadComplete: false,
    });
    expect(inspectBg3SteamCloudExitSync([
      start,
      "[AppID 1086940] No launch record found. Skipping looking for files added/removed while the game was running",
      scan,
      "[AppID 1086940] Upload complete in build list",
    ].join("\n"))).toEqual({ started: true, autoCloudComplete: true, uploadComplete: true });
    expect(inspectBg3SteamCloudExitSync([
      start, scan, "[AppID 1086940] Upload complete, result Fail",
    ].join("\n"))).toEqual({ started: true, autoCloudComplete: true, uploadComplete: false, failure: "Fail" });
    for (const flags of ["init,", "init,up,", "init,down,AC Exit,", "up,AC Launch,"]) {
      expect(inspectBg3SteamCloudExitSync([
        `[AppID 1086940] Starting sync (${flags})`, scan,
        "[AppID 1086940] Upload complete in build list",
      ].join("\n"))).toEqual({ started: false, autoCloudComplete: false, uploadComplete: false });
    }
  });

  it("fails shared cleanup when a second raw BG3 candidate appears", () => {
    expect(() => assertNoBg3ProcessCandidates([
      { pid: 4_002_973, startTimeTicks: "100" },
    ], "active launch bridge restore")).toThrow(
      "Refusing active launch bridge restore while BG3 PID 4002973 exists",
    );
  });

  it("audits saves through the complete post-Cloud stability window", async () => {
    let now = 1_000;
    const observations: number[] = [];

    await auditBg3SavePostconditionForDuration({
      durationMs: 500,
      pollMs: 200,
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      readSnapshot: async () => new Map(),
      assertSnapshot: () => {
        observations.push(now);
      },
    });

    expect(observations).toEqual([1_000, 1_200, 1_400, 1_500]);
  });

  it("detects a save change delayed until after Cloud restoration", async () => {
    let now = 1_000;

    await expect(auditBg3SavePostconditionForDuration({
      durationMs: 500,
      pollMs: 200,
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      readSnapshot: async () => new Map(),
      assertSnapshot: () => {
        if (now >= 1_400) throw new Error("delayed Steam Cloud save change");
      },
    })).rejects.toThrow("delayed Steam Cloud save change");
  });

  it("launches character creation through normal profile initialization", () => {
    expect(bg3SteamLaunchArguments(undefined)).toEqual([
      "-silent",
      "-applaunch",
      "1086940",
      "--skip-launcher",
    ]);
  });

  it("starts the Steam client silently without launching BG3", () => {
    expect(steamClientStartArguments()).toEqual(["-silent"]);
  });

  it("launches runtime tests with only the exact save argument", () => {
    expect(
      bg3SteamLaunchArguments("harness-fixture__AutoSave_0"),
    ).toEqual([
      "-silent",
      "-applaunch",
      "1086940",
      "--skip-launcher",
      "-loadSaveGame",
      "harness-fixture__AutoSave_0",
    ]);
  });

  it("records the one headless output added by the runner", () => {
    expect(
      identifyCreatedHeadlessOutput(
        ["DP-2"],
        ["DP-2", "HEADLESS-1"],
      ),
    ).toBe("HEADLESS-1");
  });

  it("creates the session output with its reserved stable name", () => {
    expect(bg3HeadlessOutputCreateArguments()).toEqual([
      "output",
      "create",
      "headless",
      "BG3-HARNESS",
    ]);
  });

  it("reuses the reserved session output when it has no windows", () => {
    expect(identifyReusableHeadlessOutput([
      {
        id: 0,
        name: "DP-2",
        activeWorkspaceId: 3,
        activeWorkspaceName: "3",
      },
      {
        id: 4,
        name: "BG3-HARNESS",
        activeWorkspaceId: 8,
        activeWorkspaceName: "bg3-harness",
      },
    ], [])).toMatchObject({ name: "BG3-HARNESS" });
  });

  it("recovers the reserved output when its workspace rename was interrupted", () => {
    expect(identifyReusableHeadlessOutput([
      {
        id: 4,
        name: "BG3-HARNESS",
        activeWorkspaceId: 8,
        activeWorkspaceName: "8",
      },
    ], [])).toMatchObject({
      name: "BG3-HARNESS",
      activeWorkspaceName: "8",
    });
  });

  it("refuses to reuse the reserved output while it contains a window", () => {
    expect(() => identifyReusableHeadlessOutput([
      {
        id: 4,
        name: "BG3-HARNESS",
        activeWorkspaceId: 8,
        activeWorkspaceName: "bg3-harness",
      },
    ], [4])).toThrow("still contains 1 window");
  });

  it("refuses a dedicated workspace collision on another output", () => {
    expect(() => identifyReusableHeadlessOutput([
      {
        id: 0,
        name: "DP-2",
        activeWorkspaceId: 3,
        activeWorkspaceName: "bg3-harness",
      },
    ], [])).toThrow("workspace bg3-harness is hosted by DP-2");
  });

  it("finds saves created after character creation without changing old saves", () => {
    expect(
      newBg3SaveIds(
        new Set(["ProtectedSave", "777-1__AutoSave_0"]),
        new Set([
          "ProtectedSave",
          "777-1__AutoSave_0",
          "harness-created__AutoSave_0",
        ]),
      ),
    ).toEqual(["harness-created__AutoSave_0"]);
  });

  it("rejects more than one new save", () => {
    expect(() =>
      singleNewBg3SaveId(
        new Set(["ProtectedSave"]),
        new Set([
          "ProtectedSave",
          "harness-one__AutoSave_0",
          "harness-one__AutoSave_1",
        ]),
      ),
    ).toThrow(
      "Character creation produced 2 new saves: harness-one__AutoSave_0, harness-one__AutoSave_1",
    );
  });

  it("binds both species UUIDs to the armed creation scenario", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-species-"));
    try {
      const scenario = testCatalog.get("example.species-creation-control")!;
      if (scenario.launch.kind !== "character-creation") throw new Error("Missing species creation scenario");
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      const target: Bg3TestCommand = {
        schemaVersion: 2, runId: "run-species-plan", scenarioId: scenario.id,
        mode: "character-creation", savePolicy: "create-test-fixture", saveId: "__new_campaign__",
        requiredAssertionIds: scenario.requiredAssertionIds, creationPlan: scenario.launch.creationPlan,
        createdAt: "2026-09-08T10:00:00.000Z", expiresAt: "2026-09-08T10:10:00.000Z",
        createdAtEpochMs: 1788861600000, expiresAtEpochMs: 1788862200000, timeoutMs: 600_000,
      };
      for (const field of ["raceUuid", "subRaceUuid", "classUuid"] as const) {
        await expect(platform.armRun({ ...target, creationPlan: {
          ...target.creationPlan, [field]: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        } })).rejects.toThrow("Refusing to arm");
      }
      await platform.armRun(target);
      for (const field of ["raceUuid", "subRaceUuid", "classUuid"] as const) {
        await expect(platform.writeCommand({ ...target, creationPlan: {
          ...target.creationPlan, [field]: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        } })).rejects.toThrow("does not match the armed run");
      }
      await platform.writeCommand(target);
      await platform.cleanupRun(target.runId);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("arms a discard-campaign creation but never treats it as a run that may save", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-discard-"));
    try {
      const base = testCatalog.get("example.species-creation-control")!;
      if (base.launch.kind !== "character-creation") throw new Error("Missing creation fixture");
      const catalog = createBg3TestScenarioCatalog({ harnessModUuid: harnessMod.uuid, protectedSaves: testProtectedSaves, allowedRuntimeSaveIds: [], runtimeFixtures: [], scenarios: [{
        ...base, savePolicy: "discard-campaign",
        launch: { kind: "character-creation", creationPlan: base.launch.creationPlan },
      }] });
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot, catalog });
      const target: Bg3TestCommand = {
        schemaVersion: 2, runId: "run-discard-campaign", scenarioId: base.id,
        mode: "character-creation", savePolicy: "discard-campaign", saveId: "__new_campaign__",
        requiredAssertionIds: base.requiredAssertionIds, creationPlan: base.launch.creationPlan,
        createdAt: "2026-09-08T10:00:00.000Z", expiresAt: "2026-09-08T10:10:00.000Z",
        createdAtEpochMs: 1788861600000, expiresAtEpochMs: 1788862200000, timeoutMs: 600_000,
      };
      const fixturePolicy: Bg3TestCommand = { ...target, savePolicy: "create-test-fixture" };
      await expect(platform.armRun(fixturePolicy)).rejects.toThrow("Refusing to arm");
      await platform.armRun(target);
      await expect(platform.writeCommand(fixturePolicy)).rejects.toThrow("does not match the armed run");
      await platform.writeCommand(target);
      await expect(platform.validateNewSave!(target.runId, 1_000)).rejects.toThrow(
        "Refusing to validate a save for a run that never saves",
      );
      expect(bg3ArmPermitsTestSave(target)).toBe(false);
      expect(bg3ArmPermitsTestSave(fixturePolicy)).toBe(true);
      expect(bg3ArmPermitsTestSave({ ...target, mode: "runtime", saveId: "harness-fixture__AutoSave_0",
        savePolicy: "never", creationPlan: undefined } as unknown as Bg3TestCommand)).toBe(false);
      await platform.cleanupRun(target.runId);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("binds and writes the exact authorized race passive in arm and command", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-race-passive-"));
    try {
      const base = testCatalog.get("example.species-creation-control")!;
      if (base.launch.kind !== "character-creation") throw new Error("Missing creation fixture");
      const plan = { ...base.launch.creationPlan, racePassiveId: "HarnessExample_TestPassive_Wisdom" };
      const catalog = createBg3TestScenarioCatalog({ harnessModUuid: harnessMod.uuid, protectedSaves: testProtectedSaves, allowedRuntimeSaveIds: [], runtimeFixtures: [], scenarios: [{
        ...base, savePolicy: "create-test-fixture", launch: { kind: "character-creation", creationPlan: plan },
      }] });
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot, catalog });
      const target: Bg3TestCommand = {
        schemaVersion: 2, runId: "run-race-passive-plan", scenarioId: base.id,
        mode: "character-creation", savePolicy: "create-test-fixture", saveId: "__new_campaign__",
        requiredAssertionIds: base.requiredAssertionIds, creationPlan: plan,
        createdAt: "2026-09-08T10:00:00.000Z", expiresAt: "2026-09-08T10:10:00.000Z",
        createdAtEpochMs: 1788861600000, expiresAtEpochMs: 1788862200000, timeoutMs: 600_000,
      };
      const { racePassiveId: omittedPassive, ...withoutPassive } = plan;
      const { raceUuid: omittedRace, ...withoutRace } = plan;
      const invalid = [
        { ...plan, racePassiveId: plan.racePassiveId.toLowerCase() },
        { ...plan, racePassiveId: "HarnessExample_AnotherPassive" },
        withoutPassive,
        withoutRace,
      ];
      for (const creationPlan of invalid) {
        await expect(platform.armRun({ ...target, creationPlan })).rejects.toThrow("Refusing to arm");
      }
      await platform.armRun(target);
      for (const creationPlan of invalid) {
        await expect(platform.writeCommand({ ...target, creationPlan })).rejects.toThrow("does not match the armed run");
      }
      await platform.writeCommand(target);
      const channel = path.join(userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness");
      for (const name of ["arm.json", `runs/${target.runId}/command.json`]) {
        const written = JSON.parse(await readFile(path.join(channel, name), "utf8"));
        expect(written.creationPlan.racePassiveId).toBe(plan.racePassiveId);
      }
      await platform.cleanupRun(target.runId);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("arms a new campaign only with the explicit mode and sentinel", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-new-campaign",
        scenarioId: "example.background-creation",
        ...creationWireRequirements,
        mode: "character-creation",
        saveId: "__new_campaign__",
        creationPlan: {
          kind: "background",
          backgroundUuid: "56c19b4a-f7b7-4aba-ba1f-0ade44a98560",
          backgroundName: "Example Background",
          requiredTransitionModUuid:
            "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c",
        },
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:10:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839800000,
        timeoutMs: 600_000,
      });

      const armPath = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/arm.json",
      );
      expect(JSON.parse(await readFile(armPath, "utf8"))).toMatchObject({
        mode: "character-creation",
        saveId: "__new_campaign__",
        creationPlan: {
          kind: "background",
          backgroundUuid: "56c19b4a-f7b7-4aba-ba1f-0ade44a98560",
          backgroundName: "Example Background",
          requiredTransitionModUuid:
            "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c",
        },
      });
      await platform.cleanupRun("run-new-campaign");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("creates the run directory before a runtime observer can report", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-runtime-observer",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });

      const runDirectory = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs/run-runtime-observer",
      );
      expect((await stat(runDirectory)).isDirectory()).toBe(true);
      await platform.cleanupRun("run-runtime-observer");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("rejects a runtime fixture whose LSV hash does not match the catalog", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const saveId = "harness-fixture__AutoSave_0";
    const saveDirectory = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story",
      saveId,
    );
    try {
      await mkdir(saveDirectory, { recursive: true });
      await writeFile(path.join(saveDirectory, `${saveId}.lsv`), "wrong-save");
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-wrong-runtime-fixture",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId,
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });

      await expect(platform.launchGame(
        saveId,
        "run-wrong-runtime-fixture",
        "runtime",
      )).rejects.toThrow(
        `BG3 runtime fixture hash mismatch for ${saveId}`,
      );
      await platform.cleanupRun("run-wrong-runtime-fixture");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { display: "visible", locked: true, queryFails: false, expected: "The desktop is locked. Unlock it", reads: 1 },
    { display: "visible", locked: false, queryFails: true, expected: "Cannot verify the desktop lock state", reads: 1 },
    { display: "visible", locked: false, queryFails: false, expected: "BG3 runtime fixture hash mismatch", reads: 1 },
    { display: "headless", locked: true, queryFails: true, expected: "BG3 runtime fixture hash mismatch", reads: 0 },
  ] as const)(
    "checks the desktop before visible launch preparation: $display locked=$locked queryFails=$queryFails",
    async ({ display, locked, queryFails, expected, reads }) => {
      const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-lock-preflight-"));
      const saveId = "harness-fixture__AutoSave_0";
      const saveDirectory = path.join(userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story", saveId);
      let lockReads = 0;
      try {
        await mkdir(saveDirectory, { recursive: true });
        await writeFile(path.join(saveDirectory, `${saveId}.lsv`), "wrong-save");
        const platform = createNodeBg3TestPlatform({
          ...testPlatformOptions,
          userRoot,
          readDesktopLocked: async () => {
            lockReads += 1;
            if (queryFails) throw new Error("private compositor diagnostic");
            return locked;
          },
        });
        await platform.armRun({
          schemaVersion: 2, runId: "run-desktop-lock-preflight", scenarioId: "core.runtime-smoke",
          ...runtimeWireRequirements, mode: "runtime", saveId,
          createdAt: "2026-08-27T14:00:00.000Z", expiresAt: "2026-08-27T14:06:00.000Z",
          createdAtEpochMs: 1787839200000, expiresAtEpochMs: 1787839560000, timeoutMs: 360_000,
        });
        // The invalid fixture stops permitted paths before any compositor mutation
        // or process launch. Locked paths must fail before even reaching it.
        await expect(platform.launchGame(saveId, "run-desktop-lock-preflight", "runtime", display))
          .rejects.toThrow(expected);
        expect(lockReads).toBe(reads);
        expect(await readFile(path.join(saveDirectory, `${saveId}.lsv`), "utf8")).toBe("wrong-save");
        await platform.cleanupRun("run-desktop-lock-preflight");
      } finally {
        await rm(userRoot, { recursive: true, force: true });
      }
    },
  );

  it("clears a residual mod crash marker while arming a run", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const markerPath = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/ModCrashSanityCheck",
    );
    try {
      await mkdir(markerPath, { recursive: true });
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

      await platform.armRun({
        schemaVersion: 2,
        runId: "run-clear-crash-marker",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });

      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      await platform.cleanupRun("run-clear-crash-marker");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("recovers shared state before rejecting an unsafe crash marker", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const localAppData = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3",
    );
    const markerPath = path.join(localAppData, "ModCrashSanityCheck");
    const saveRoot = path.join(
      localAppData,
      "PlayerProfiles/Public/Savegames/Story",
    );
    let cloudPending = true;
    let cloudRecoveries = 0;
    const steamCloudManager: Bg3SteamCloudManager = {
      hasPendingTransaction: async () => cloudPending,
      pendingOriginalEnabled: async () => cloudPending ? false : undefined,
      prepare: async () => {
        throw new Error("unexpected Cloud prepare");
      },
      restore: async () => {
        throw new Error("unexpected Cloud restore");
      },
      recover: async () => {
        cloudRecoveries += 1;
        cloudPending = false;
        return false;
      },
    };
    try {
      await Promise.all([
        mkdir(saveRoot, { recursive: true }),
        mkdir(markerPath, { recursive: true }),
      ]);
      await writeFile(path.join(markerPath, "unexpected"), "preserve me");
      const platform = createNodeBg3TestPlatform({
        ...testPlatformOptions,
        userRoot,
        steamCloudManager,
        steamCloudSaveAuditMs: 0,
      });

      await expect(platform.armRun({
        schemaVersion: 2,
        runId: "run-unsafe-marker-recovery",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      })).rejects.toThrow("ModCrashSanityCheck is not empty");

      expect(cloudRecoveries).toBe(1);
      await expect(readFile(path.join(markerPath, "unexpected"), "utf8"))
        .resolves.toBe("preserve me");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("clears the mod crash marker left while cleaning a run", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const markerPath = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/ModCrashSanityCheck",
    );
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-clean-crash-marker",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });
      await mkdir(markerPath);

      await platform.cleanupRun("run-clean-crash-marker");

      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("does not recover the builtin bridge while a pending launch is quarantined", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    try {
      await mkdir(path.join(harnessRoot, "active.lock"), { recursive: true });
      await Promise.all([
        writeFile(path.join(harnessRoot, "active.lock/owner.json"), JSON.stringify({
          schemaVersion: 2,
          runId: "run-quarantined",
          pid: process.pid,
          ownerStartTimeTicks: "1",
          createdAt: new Date().toISOString(),
          status: "pending-steam",
          quarantineUntilEpochMs: Date.now() + 60_000,
          saveSnapshotBeforeLaunch: [],
        })),
        writeFile(path.join(harnessRoot, "builtin-bridge-owner.json"), "not-json"),
      ]);
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

      await expect(platform.armRun({
        schemaVersion: 2,
        runId: "run-second-invocation",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      })).rejects.toThrow("run-quarantined is quarantined until");
      await expect(readFile(
        path.join(harnessRoot, "builtin-bridge-owner.json"),
        "utf8",
      )).resolves.toBe("not-json");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("does not recover an expired lock owned by the live runner identity", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    try {
      const statContents = await readFile(`/proc/${process.pid}/stat`, "utf8");
      const commandEnd = statContents.lastIndexOf(")");
      const ownerStartTimeTicks = statContents
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)[19];
      expect(ownerStartTimeTicks).toMatch(/^[0-9]+$/);
      await mkdir(path.join(harnessRoot, "active.lock"), { recursive: true });
      await writeFile(path.join(harnessRoot, "active.lock/owner.json"), JSON.stringify({
        schemaVersion: 2,
        runId: "run-live-owner",
        pid: process.pid,
        ownerStartTimeTicks,
        createdAt: "2026-08-30T10:00:00.000Z",
        status: "armed",
        quarantineUntilEpochMs: Date.now() - 1,
      }));
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

      await expect(platform.armRun({
        schemaVersion: 2,
        runId: "run-cannot-steal-live-lock",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      })).rejects.toThrow("runner PID");
      await expect(readFile(
        path.join(harnessRoot, "active.lock/owner.json"),
        "utf8",
      )).resolves.toContain('"runId":"run-live-owner"');
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("keeps a live runner's Cloud transaction untouched by another CLI cleanup", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const saveRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story",
    );
    let cloudPending = false;
    let cloudRecoveries = 0;
    const steamCloudManager: Bg3SteamCloudManager = {
      hasPendingTransaction: async () => cloudPending,
      pendingOriginalEnabled: async () => cloudPending ? false : undefined,
      prepare: async () => {
        cloudPending = true;
      },
      restore: async () => {
        throw new Error("unexpected Cloud restore");
      },
      recover: async () => {
        cloudRecoveries += 1;
        cloudPending = false;
        return false;
      },
    };
    const firstPlatform = createNodeBg3TestPlatform({
      ...testPlatformOptions,
      userRoot,
      steamCloudManager,
      steamCloudSaveAuditMs: 0,
    });
    const secondPlatform = createNodeBg3TestPlatform({
      ...testPlatformOptions,
      userRoot,
      steamCloudManager,
      steamCloudSaveAuditMs: 0,
    });
    try {
      await mkdir(saveRoot, { recursive: true });
      await firstPlatform.armRun({
        schemaVersion: 2,
        runId: "run-live-cloud-owner",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      });
      const ownerBefore = await readFile(path.join(harnessRoot, "active.lock/owner.json"));
      const armBefore = await readFile(path.join(harnessRoot, "arm.json"));
      await steamCloudManager.prepare("run-live-cloud-owner");

      const failure = await runBg3Test(
        ["--scenario", "core.runtime-smoke"],
        secondPlatform,
        testCatalog,
      ).then(() => undefined, (error: unknown) => error);
      expect(cloudRecoveries).toBe(0);
      expect(cloudPending).toBe(true);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("runner PID");
      await secondPlatform.cleanupRun("run-live-cloud-owner");
      expect(cloudRecoveries).toBe(0);
      expect(await readFile(path.join(harnessRoot, "active.lock/owner.json")))
        .toEqual(ownerBefore);
      expect(await readFile(path.join(harnessRoot, "arm.json"))).toEqual(armBefore);
      await expect(stat(path.join(harnessRoot, "steam-cloud-settlement.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      cloudPending = false;
      await firstPlatform.cleanupRun("run-live-cloud-owner");
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("recovers an expired zero-PID quarantine before acquiring a new lock", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const saveRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story",
    );
    const previousHyprlandSignature =
      process.env.HYPRLAND_INSTANCE_SIGNATURE;
    try {
      delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      await Promise.all([
        mkdir(path.join(harnessRoot, "active.lock"), { recursive: true }),
        mkdir(path.join(harnessRoot, "runs/run-expired"), { recursive: true }),
        mkdir(saveRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(harnessRoot, "active.lock/owner.json"), JSON.stringify({
          schemaVersion: 2,
          runId: "run-expired",
          pid: 2_147_483_647,
          ownerStartTimeTicks: "1",
          createdAt: "2026-08-30T10:00:00.000Z",
          status: "pending-steam",
          quarantineUntilEpochMs: Date.now() - 1,
          saveSnapshotBeforeLaunch: [],
        })),
        writeFile(path.join(harnessRoot, "arm.json"), JSON.stringify({
          runId: "run-expired",
        })),
      ]);
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

      await platform.armRun({
        schemaVersion: 2,
        runId: "run-after-expired",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      });

      await expect(readFile(
        path.join(harnessRoot, "active.lock/owner.json"),
        "utf8",
      )).resolves.toContain('"runId": "run-after-expired"');
      await expect(stat(path.join(
        harnessRoot,
        "runs/run-expired",
      ))).rejects.toMatchObject({ code: "ENOENT" });
      await platform.cleanupRun("run-after-expired");
    } finally {
      if (previousHyprlandSignature === undefined) {
        delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      } else {
        process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHyprlandSignature;
      }
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("recovers an abandoned recovery claim before acquiring an expired lock", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const saveRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story",
    );
    const claimRoot = path.join(harnessRoot, "active.lock/recovery.claim");
    const previousHyprlandSignature =
      process.env.HYPRLAND_INSTANCE_SIGNATURE;
    try {
      delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      await Promise.all([
        mkdir(claimRoot, { recursive: true }),
        mkdir(path.join(harnessRoot, "runs/run-abandoned-recovery"), {
          recursive: true,
        }),
        mkdir(saveRoot, { recursive: true }),
      ]);
      await writeFile(
        path.join(harnessRoot, "active.lock/owner.json"),
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-abandoned-recovery",
          pid: 2_147_483_647,
          ownerStartTimeTicks: "1",
          createdAt: "2026-08-30T10:00:00.000Z",
          status: "armed",
          quarantineUntilEpochMs: Date.now() - 1,
        }),
      );
      const abandonedAt = new Date(Date.now() - 60 * 60 * 1_000);
      await utimes(claimRoot, abandonedAt, abandonedAt);
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

      await platform.armRun({
        schemaVersion: 2,
        runId: "run-after-abandoned-recovery",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      });

      await expect(readFile(
        path.join(harnessRoot, "active.lock/owner.json"),
        "utf8",
      )).resolves.toContain('"runId": "run-after-abandoned-recovery"');
      await expect(stat(claimRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(
        harnessRoot,
        "runs/run-abandoned-recovery",
      ))).rejects.toMatchObject({ code: "ENOENT" });
      await platform.cleanupRun("run-after-abandoned-recovery");
    } finally {
      if (previousHyprlandSignature === undefined) {
        delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      } else {
        process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHyprlandSignature;
      }
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("recovers a stale run lock containing only a legacy recovery claim", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const lockRoot = path.join(harnessRoot, "active.lock");
    const claimRoot = path.join(lockRoot, "recovery.claim");
    const previousHyprlandSignature =
      process.env.HYPRLAND_INSTANCE_SIGNATURE;
    try {
      delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      await mkdir(claimRoot, { recursive: true });
      const abandonedAt = new Date(Date.now() - 60 * 60 * 1_000);
      await utimes(claimRoot, abandonedAt, abandonedAt);
      await utimes(lockRoot, abandonedAt, abandonedAt);
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

      await platform.armRun({
        schemaVersion: 2,
        runId: "run-after-claim-only-lock",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      });

      await expect(readFile(path.join(lockRoot, "owner.json"), "utf8"))
        .resolves.toContain('"runId": "run-after-claim-only-lock"');
      await expect(stat(claimRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await platform.cleanupRun("run-after-claim-only-lock");
    } finally {
      if (previousHyprlandSignature === undefined) {
        delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      } else {
        process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHyprlandSignature;
      }
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("recovers an abandoned empty run lock", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const lockRoot = path.join(harnessRoot, "active.lock");
    const previousHyprlandSignature =
      process.env.HYPRLAND_INSTANCE_SIGNATURE;
    try {
      delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      await mkdir(lockRoot, { recursive: true });
      const abandonedAt = new Date(Date.now() - 60 * 60 * 1_000);
      await utimes(lockRoot, abandonedAt, abandonedAt);
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

      await platform.armRun({
        schemaVersion: 2,
        runId: "run-after-empty-lock",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      });

      await expect(readFile(path.join(lockRoot, "owner.json"), "utf8"))
        .resolves.toContain('"runId": "run-after-empty-lock"');
      await platform.cleanupRun("run-after-empty-lock");
    } finally {
      if (previousHyprlandSignature === undefined) {
        delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      } else {
        process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHyprlandSignature;
      }
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("recovers a stale run lock containing only an abandoned owner temporary", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const lockRoot = path.join(harnessRoot, "active.lock");
    const ownerTemporary = path.join(
      lockRoot,
      "owner.json.2147483647.00000000-0000-4000-8000-000000000000.tmp",
    );
    const previousHyprlandSignature =
      process.env.HYPRLAND_INSTANCE_SIGNATURE;
    try {
      delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      await mkdir(lockRoot, { recursive: true });
      await writeFile(ownerTemporary, "incomplete owner");
      const abandonedAt = new Date(Date.now() - 60 * 60 * 1_000);
      await utimes(ownerTemporary, abandonedAt, abandonedAt);
      await utimes(lockRoot, abandonedAt, abandonedAt);
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

      await platform.armRun({
        schemaVersion: 2,
        runId: "run-after-owner-temporary",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      });

      await expect(readFile(path.join(lockRoot, "owner.json"), "utf8"))
        .resolves.toContain('"runId": "run-after-owner-temporary"');
      await expect(stat(ownerTemporary)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await platform.cleanupRun("run-after-owner-temporary");
    } finally {
      if (previousHyprlandSignature === undefined) {
        delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      } else {
        process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHyprlandSignature;
      }
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("refuses to remove unsafe unowned run lock entries", async () => {
    const previousHyprlandSignature =
      process.env.HYPRLAND_INSTANCE_SIGNATURE;
    const abandonedAt = new Date(Date.now() - 60 * 60 * 1_000);
    const uuid = "00000000-0000-4000-8000-000000000000";
    const cases = [
      {
        entryName: "foreign.txt",
        staleEntry: true,
        expectedError: "contains an unsafe entry",
      },
      {
        entryName: `owner.json.2147483647.${uuid}.tmp`,
        staleEntry: false,
        expectedError: "owner temporary is too recent to recover",
      },
      {
        entryName: `owner.json.${process.pid}.${uuid}.tmp`,
        staleEntry: true,
        expectedError: `owner writer PID ${process.pid} is alive`,
      },
    ] as const;
    try {
      delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      for (const [index, testCase] of cases.entries()) {
        const userRoot = await mkdtemp(
          path.join(os.tmpdir(), "bg3-harness-platform-"),
        );
        try {
          const lockRoot = path.join(
            userRoot,
            ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/active.lock",
          );
          const entryPath = path.join(lockRoot, testCase.entryName);
          await mkdir(lockRoot, { recursive: true });
          await writeFile(entryPath, "must remain");
          if (testCase.staleEntry) {
            await utimes(entryPath, abandonedAt, abandonedAt);
          }
          await utimes(lockRoot, abandonedAt, abandonedAt);
          const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });

          await expect(platform.armRun({
            schemaVersion: 2,
            runId: `run-reject-unowned-${index}`,
            scenarioId: "core.runtime-smoke",
            ...runtimeWireRequirements,
            mode: "runtime",
            saveId: "harness-fixture__AutoSave_0",
            createdAt: "2026-08-30T12:00:00.000Z",
            expiresAt: "2026-08-30T12:06:00.000Z",
            createdAtEpochMs: 1788091200000,
            expiresAtEpochMs: 1788091560000,
            timeoutMs: 360_000,
          })).rejects.toThrow(testCase.expectedError);
          await expect(readFile(entryPath, "utf8")).resolves.toBe(
            "must remain",
          );
        } finally {
          await rm(userRoot, { recursive: true, force: true });
        }
      }
    } finally {
      if (previousHyprlandSignature === undefined) {
        delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      } else {
        process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHyprlandSignature;
      }
    }
  });

  it("serializes concurrent expired lock recovery", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const saveRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story",
    );
    let markRecoveryEntered: (() => void) | undefined;
    const recoveryEntered = new Promise<void>((resolve) => {
      markRecoveryEntered = resolve;
    });
    let releaseRecovery: (() => void) | undefined;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let pendingChecks = 0;
    const steamCloudManager: Bg3SteamCloudManager = {
      hasPendingTransaction: async () => {
        pendingChecks += 1;
        if (pendingChecks === 1) {
          markRecoveryEntered?.();
          await recoveryGate;
        }
        return false;
      },
      pendingOriginalEnabled: async () => undefined,
      prepare: async () => {
        throw new Error("unexpected Cloud prepare");
      },
      restore: async () => {
        throw new Error("unexpected Cloud restore");
      },
      recover: async () => {
        throw new Error("unexpected Cloud recover");
      },
    };
    const previousHyprlandSignature =
      process.env.HYPRLAND_INSTANCE_SIGNATURE;
    try {
      delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      await Promise.all([
        mkdir(path.join(harnessRoot, "active.lock"), { recursive: true }),
        mkdir(saveRoot, { recursive: true }),
      ]);
      await writeFile(
        path.join(harnessRoot, "active.lock/owner.json"),
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-concurrent-recovery-source",
          pid: 2_147_483_647,
          ownerStartTimeTicks: "1",
          createdAt: "2026-08-30T10:00:00.000Z",
          status: "armed",
          quarantineUntilEpochMs: Date.now() - 1,
        }),
      );
      const firstPlatform = createNodeBg3TestPlatform({
        ...testPlatformOptions,
        userRoot,
        steamCloudManager,
      });
      const secondPlatform = createNodeBg3TestPlatform({
        ...testPlatformOptions,
        userRoot,
        steamCloudManager,
      });
      const firstArm = firstPlatform.armRun({
        schemaVersion: 2,
        runId: "run-concurrent-recovery-winner",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      });
      await recoveryEntered;

      await expect(secondPlatform.armRun({
        schemaVersion: 2,
        runId: "run-concurrent-recovery-loser",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:01:00.000Z",
        expiresAt: "2026-08-30T12:07:00.000Z",
        createdAtEpochMs: 1788091260000,
        expiresAtEpochMs: 1788091620000,
        timeoutMs: 360_000,
      })).rejects.toThrow("run lock transition is already in progress");

      releaseRecovery?.();
      await firstArm;
      await firstPlatform.cleanupRun("run-concurrent-recovery-winner");
    } finally {
      releaseRecovery?.();
      if (previousHyprlandSignature === undefined) {
        delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
      } else {
        process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHyprlandSignature;
      }
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("keeps a durable Cloud settlement when its terminal upload is missing", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const saveRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story",
    );
    const cloudLogPath = path.join(
      userRoot,
      ".local/share/Steam/logs/cloud_log.txt",
    );
    const settlementPath = path.join(
      harnessRoot,
      "steam-cloud-settlement.json",
    );
    const restoredCloud: Bg3SteamCloudManager = {
      hasPendingTransaction: async () => false,
      pendingOriginalEnabled: async () => undefined,
      prepare: async () => {
        throw new Error("unexpected Cloud prepare");
      },
      restore: async () => undefined,
      recover: async () => undefined,
    };
    try {
      await Promise.all([
        mkdir(harnessRoot, { recursive: true }),
        mkdir(saveRoot, { recursive: true }),
        mkdir(path.dirname(cloudLogPath), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(cloudLogPath, ""),
        writeFile(settlementPath, `${JSON.stringify({
          schemaVersion: 1,
          runId: "run-interrupted-settlement",
          cloudLogPath,
          expectAutoCloudUpload: true,
          logDevice: null,
          logInode: null,
          logOffset: 0,
          expectedSaveSnapshot: [],
        })}\n`),
      ]);
      const platform = createNodeBg3TestPlatform({
        ...testPlatformOptions,
        userRoot,
        steamCloudManager: restoredCloud,
        steamCloudSyncTimeoutMs: 10,
        steamCloudSaveAuditMs: 0,
      });

      await expect(platform.armRun({
        schemaVersion: 2,
        runId: "run-after-missing-terminal",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      })).rejects.toThrow("waiting for the BG3 Steam AutoCloud exit upload");

      await expect(readFile(settlementPath, "utf8")).resolves.toContain(
        '"runId":"run-interrupted-settlement"',
      );
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("recovers a durable Cloud settlement after its terminal upload", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    const saveRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story",
    );
    const cloudLogPath = path.join(
      userRoot,
      ".local/share/Steam/logs/cloud_log.txt",
    );
    const settlementPath = path.join(
      harnessRoot,
      "steam-cloud-settlement.json",
    );
    const restoredCloud: Bg3SteamCloudManager = {
      hasPendingTransaction: async () => false,
      pendingOriginalEnabled: async () => undefined,
      prepare: async () => {
        throw new Error("unexpected Cloud prepare");
      },
      restore: async () => undefined,
      recover: async () => undefined,
    };
    try {
      await Promise.all([
        mkdir(harnessRoot, { recursive: true }),
        mkdir(saveRoot, { recursive: true }),
        mkdir(path.dirname(cloudLogPath), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(cloudLogPath, [
          "[AppID 1086940] Starting sync (up,AC Exit,)",
          "[AppID 1086940] AutoCloud complete",
          "[AppID 1086940] Upload complete in build list",
        ].join("\n")),
        writeFile(settlementPath, `${JSON.stringify({
          schemaVersion: 1,
          runId: "run-completed-settlement",
          cloudLogPath,
          expectAutoCloudUpload: true,
          logDevice: null,
          logInode: null,
          logOffset: 0,
          expectedSaveSnapshot: [],
        })}\n`),
      ]);
      const platform = createNodeBg3TestPlatform({
        ...testPlatformOptions,
        userRoot,
        steamCloudManager: restoredCloud,
        steamCloudSyncTimeoutMs: 10,
        steamCloudSaveAuditMs: 0,
      });

      await platform.armRun({
        schemaVersion: 2,
        runId: "run-after-completed-terminal",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:06:00.000Z",
        createdAtEpochMs: 1788091200000,
        expiresAtEpochMs: 1788091560000,
        timeoutMs: 360_000,
      });

      await expect(stat(settlementPath)).rejects.toMatchObject({ code: "ENOENT" });
      await platform.cleanupRun("run-after-completed-terminal");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("archives checkpoints without a result after a crash before cleanup", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({
        ...testPlatformOptions,
        userRoot,
        workRoot: userRoot,
      });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-archive",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });
      await platform.writeCommand({
        schemaVersion: 2,
        runId: "run-archive",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:01.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839201000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 359_000,
      });

      const runDirectory = path.join(userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs/run-archive");
      const checkpoint = JSON.stringify({ schemaVersion: 1, runId: "run-archive", sequence: 1,
        phase: "cast-before-dispatch", fields: { spell: "Shout_HarnessExample_Ability_Wisdom" } });
      await writeFile(path.join(runDirectory, "checkpoint-0001.json"), checkpoint);
      await expect(stat(path.join(runDirectory, "result.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await platform.archiveRunArtifacts("run-archive");
      await platform.cleanupRun("run-archive");

      const archivedCommand = path.join(
        userRoot,
        ".cache/bg3-test-runs/run-archive/command.json",
      );
      await expect(readFile(archivedCommand, "utf8")).resolves.toContain(
        '"scenarioId": "core.runtime-smoke"',
      );
      await expect(readFile(path.join(path.dirname(archivedCommand), "checkpoint-0001.json"), "utf8"))
        .resolves.toBe(checkpoint);
      await expect(stat(path.join(path.dirname(archivedCommand), "result.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("returns a client fail-safe result when Server never arbitrates", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      const createdAtEpochMs = Date.now();
      const expiresAtEpochMs = createdAtEpochMs + 360_000;
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-client-error",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: new Date(createdAtEpochMs).toISOString(),
        expiresAt: new Date(expiresAtEpochMs).toISOString(),
        createdAtEpochMs,
        expiresAtEpochMs,
        timeoutMs: 360_000,
      });
      const runDirectory = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs/run-client-error",
      );
      const clientError = '{"status":"error","error":{"code":"client-failed"}}\n';
      const pendingResult = platform.readResult("run-client-error", 500);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      await writeFile(path.join(runDirectory, "client-error.json"), clientError);

      await expect(pendingResult).resolves.toBe(
        clientError,
      );
      await platform.cleanupRun("run-client-error");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("returns a startup fail-safe result when Server never starts", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      const runDirectory = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs/run-startup-error",
      );
      await mkdir(runDirectory, { recursive: true });
      const startupError =
        '{"status":"error","error":{"code":"startup-failed"}}\n';
      const pendingResult = platform.readResult("run-startup-error", 500);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      await writeFile(
        path.join(runDirectory, "startup-error.json"),
        startupError,
      );

      await expect(pendingResult).resolves.toBe(startupError);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it.each(["result.json", "client-error.json", "startup-error.json"])(
    "retries a partial %s until it contains valid JSON",
    async (fileName) => {
      const userRoot = await mkdtemp(
        path.join(os.tmpdir(), "bg3-harness-platform-"),
      );
      try {
        const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
        const runId = `run-partial-${fileName.replaceAll(".", "-")}`;
        const runDirectory = path.join(
          userRoot,
          ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs",
          runId,
        );
        await mkdir(runDirectory, { recursive: true });
        const filePath = path.join(runDirectory, fileName);
        await writeFile(filePath, '{"status":');
        const validJson = `{"status":"error","source":"${fileName}"}\n`;
        const pendingResult = platform.readResult(runId, 1_000);
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        await writeFile(filePath, validJson);

        await expect(pendingResult).resolves.toBe(validJson);
      } finally {
        await rm(userRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["result.json", "BG3 test result"],
    ["client-error.json", "BG3 client error result"],
    ["startup-error.json", "BG3 startup error result"],
  ])("applies the result size limit to %s", async (fileName, label) => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      const runId = `run-size-${fileName.replaceAll(".", "-")}`;
      const runDirectory = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs",
        runId,
      );
      await mkdir(runDirectory, { recursive: true });
      await writeFile(
        path.join(runDirectory, fileName),
        Buffer.alloc(1_048_577, "x"),
      );

      await expect(platform.readResult(runId, 10)).rejects.toThrow(
        `${label} exceeds 1048576 bytes`,
      );
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("prefers the authoritative Server result when both result files exist", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-result-race",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });
      const runDirectory = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs/run-result-race",
      );
      const serverResult = '{"status":"passed","source":"server"}\n';
      await Promise.all([
        writeFile(path.join(runDirectory, "client-error.json"), '{"source":"client"}\n'),
        writeFile(path.join(runDirectory, "startup-error.json"), '{"source":"startup"}\n'),
        writeFile(path.join(runDirectory, "result.json"), serverResult),
      ]);

      await expect(platform.readResult("run-result-race", 10)).resolves.toBe(
        serverResult,
      );
      await platform.cleanupRun("run-result-race");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("returns a valid Server result without reading an oversized fallback", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      const runId = "run-server-bypasses-fallback";
      const runDirectory = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs",
        runId,
      );
      await mkdir(runDirectory, { recursive: true });
      const serverResult = '{"source":"server"}\n';
      await Promise.all([
        writeFile(path.join(runDirectory, "result.json"), serverResult),
        writeFile(
          path.join(runDirectory, "startup-error.json"),
          Buffer.alloc(1_048_577, "x"),
        ),
      ]);

      await expect(platform.readResult(runId, 10)).resolves.toBe(serverResult);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("gives Server a grace window after a fallback appears", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      const runId = "run-fallback-server-grace";
      const runDirectory = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs",
        runId,
      );
      await mkdir(runDirectory, { recursive: true });
      await writeFile(
        path.join(runDirectory, "client-error.json"),
        '{"source":"client"}\n',
      );

      const pendingResult = platform.readResult(runId, 1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const serverResult = '{"source":"server"}\n';
      await writeFile(path.join(runDirectory, "result.json"), serverResult);

      await expect(pendingResult).resolves.toBe(serverResult);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("waits for a partial Server result instead of returning a fallback", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      const runId = "run-partial-server-authority";
      const runDirectory = path.join(
        userRoot,
        ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness/runs",
        runId,
      );
      await mkdir(runDirectory, { recursive: true });
      await Promise.all([
        writeFile(path.join(runDirectory, "result.json"), '{"source":'),
        writeFile(
          path.join(runDirectory, "client-error.json"),
          '{"source":"client"}\n',
        ),
      ]);
      const pendingResult = platform.readResult(runId, 1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      const serverResult = '{"source":"server"}\n';
      await writeFile(path.join(runDirectory, "result.json"), serverResult);

      await expect(pendingResult).resolves.toBe(serverResult);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("attempts every cleanup stage and aggregates a stage failure", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const harnessRoot = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Script Extender/BG3InGameHarness/TestHarness",
    );
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-cleanup-failure",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });
      const armPath = path.join(harnessRoot, "arm.json");
      await rm(armPath);
      await mkdir(armPath);

      await expect(platform.cleanupRun("run-cleanup-failure")).rejects
        .toBeInstanceOf(AggregateError);
      await expect(stat(path.join(
        harnessRoot,
        "runs/run-cleanup-failure",
      ))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(path.join(harnessRoot, "active.lock"))).isDirectory())
        .toBe(true);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("restores shared state even when the crash marker is unsafe to remove", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    const localAppData = path.join(
      userRoot,
      ".local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3",
    );
    const markerPath = path.join(localAppData, "ModCrashSanityCheck");
    const saveRoot = path.join(
      localAppData,
      "PlayerProfiles/Public/Savegames/Story",
    );
    let cloudPending = false;
    let cloudRecoveries = 0;
    const steamCloudManager: Bg3SteamCloudManager = {
      hasPendingTransaction: async () => cloudPending,
      pendingOriginalEnabled: async () => cloudPending ? false : undefined,
      prepare: async () => {
        throw new Error("unexpected Cloud prepare");
      },
      restore: async () => {
        throw new Error("unexpected Cloud restore");
      },
      recover: async () => {
        cloudRecoveries += 1;
        cloudPending = false;
        return false;
      },
    };
    try {
      await mkdir(saveRoot, { recursive: true });
      const platform = createNodeBg3TestPlatform({
        ...testPlatformOptions,
        userRoot,
        steamCloudManager,
        steamCloudSaveAuditMs: 0,
      });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-unsafe-crash-marker",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });
      await mkdir(markerPath);
      await writeFile(path.join(markerPath, "unexpected"), "preserve me");
      cloudPending = true;

      await expect(platform.cleanupRun("run-unsafe-crash-marker")).rejects
        .toBeInstanceOf(AggregateError);

      expect(cloudRecoveries).toBe(1);
      await expect(readFile(path.join(markerPath, "unexpected"), "utf8"))
        .resolves.toBe("preserve me");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it.each(["ProtectedSave", "777", "777-1000000000__AutoSave_0"])(
    "refuses to arm protected save %s",
    async (saveId) => {
      const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
      try {
        const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
        await expect(platform.armRun({
          schemaVersion: 2,
          runId: "run-protected",
          scenarioId: "core.runtime-smoke",
          ...runtimeWireRequirements,
          mode: "runtime",
          saveId,
          createdAt: "2026-08-27T14:00:00.000Z",
          expiresAt: "2026-08-27T14:06:00.000Z",
          createdAtEpochMs: 1787839200000,
          expiresAtEpochMs: 1787839560000,
          timeoutMs: 360_000,
        })).rejects.toThrow(`Refusing to arm disallowed runtime save: ${saveId}`);
      } finally {
        await rm(userRoot, { recursive: true, force: true });
      }
    },
  );

  it("revalidates command and launch against the armed catalog fixture", async () => {
    const userRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-platform-"));
    try {
      const platform = createNodeBg3TestPlatform({ ...testPlatformOptions, userRoot });
      await platform.armRun({
        schemaVersion: 2,
        runId: "run-revalidate",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839200000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 360_000,
      });

      await expect(platform.writeCommand({
        schemaVersion: 2,
        runId: "run-revalidate",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        requiredAssertionIds: ["host-party-member", "host-entity"],
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:01.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839201000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 359_000,
      } as unknown as Bg3TestCommand)).rejects.toThrow(
        "Refusing to write a command that does not match the armed run",
      );

      await expect(platform.writeCommand({
        schemaVersion: 2,
        runId: "run-revalidate",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        savePolicy: "create-test-fixture",
        mode: "runtime",
        saveId: "harness-fixture__AutoSave_0",
        createdAt: "2026-08-27T14:00:01.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839201000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 359_000,
      } as unknown as Bg3TestCommand)).rejects.toThrow(
        "Refusing to write a command that does not match the armed run",
      );

      await expect(platform.writeCommand({
        schemaVersion: 2,
        runId: "run-revalidate",
        scenarioId: "core.runtime-smoke",
        ...runtimeWireRequirements,
        mode: "runtime",
        saveId: "ProtectedSave",
        createdAt: "2026-08-27T14:00:01.000Z",
        expiresAt: "2026-08-27T14:06:00.000Z",
        createdAtEpochMs: 1787839201000,
        expiresAtEpochMs: 1787839560000,
        timeoutMs: 359_000,
      })).rejects.toThrow(
        "Refusing to write a command that does not match the armed run",
      );
      await expect(platform.launchGame(
        "ProtectedSave",
        "run-revalidate",
        "runtime",
      )).rejects.toThrow("Refusing to launch disallowed runtime test");
      await platform.cleanupRun("run-revalidate");
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it("detaches a grouped BG3 window before moving only that window", () => {
    const commands = bg3HeadlessWindowCommands(
      "HEADLESS-1",
      "1234abcd",
      true,
    );

    expect(commands).toEqual([
      [
        "dispatch",
        'hl.dsp.window.move({ window = "stableid:1234abcd", out_of_group = true })',
      ],
      [
        "dispatch",
        'hl.dsp.window.move({ window = "stableid:1234abcd", monitor = "HEADLESS-1", follow = false })',
      ],
    ]);
    expect(commands.flat().some((value) => value.includes("focus"))).toBe(false);
  });

  it("does not issue a group command for an ungrouped BG3 window", () => {
    expect(
      bg3HeadlessWindowCommands("HEADLESS-1", "1234abcd", false),
    ).toEqual([
      [
        "dispatch",
        'hl.dsp.window.move({ window = "stableid:1234abcd", monitor = "HEADLESS-1", follow = false })',
      ],
    ]);
  });

  it("builds a transient no-focus rule for the BG3 headless output", () => {
    const expression = bg3HeadlessWindowRuleInstallExpression(
      "run-window-rule",
      12_345,
    );

    expect(expression).toContain('name = "bg3-harness-display-headless"');
    expect(expression).toContain('name = "bg3-harness-steam-launch-guard"');
    expect(expression).toContain(
      'match = { initial_class = "^steam$" }',
    );
    expect(expression).toContain(
      'match = { initial_class = "^steam_app_1086940$" }',
    );
    expect(expression).toContain(
      'workspace = "name:bg3-harness silent"',
    );
    expect(expression).toContain("no_initial_focus = true");
    expect(expression).toContain("no_focus = true");
    expect(expression).toContain("no_follow_mouse = true");
    expect(expression).toContain("focus_on_activate = false");
    expect(expression).toContain("render_unfocused = true");
    expect(expression).toContain('group = "barred"');
    expect(expression).toContain(
      "else bg3_harness_window_rule:set_enabled(true) end",
    );
    expect(expression).toContain(
      "else bg3_harness_steam_rule:set_enabled(true) end",
    );
    expect(expression).toContain(
      "bg3_harness_window_rule:is_enabled() == nil",
    );
    expect(expression).toContain(
      'local watchdog_owner = "run-window-rule"',
    );
    expect(expression).toContain(
      'bg3_harness_window_rule_timer = hl.timer(function()',
    );
    expect(expression).toContain(
      '{ timeout = 12345, type = "oneshot" })',
    );
    expect(expression).not.toContain("HEADLESS-");
  });

  it("renames the new output workspace without dispatching focus", () => {
    expect(bg3HeadlessWorkspaceRenameExpression(4)).toBe(
      'hl.dsp.workspace.rename({ workspace = "4", name = "bg3-harness" })',
    );
    expect(bg3HeadlessWorkspaceRenameExpression(4)).not.toContain("focus");
  });

  it("selects the focused physical monitor and rejects headless or ambiguous targets", () => {
    const physical = { name: "DP-2", focused: true, physicalWidth: 600, physicalHeight: 340 };
    const virtual = { name: "BG3-HARNESS", focused: false, physicalWidth: 0, physicalHeight: 0 };
    expect(selectBg3VisibleMonitor([physical, virtual])).toBe("DP-2");
    expect(() => selectBg3VisibleMonitor([{ ...physical, focused: false }, { ...virtual, focused: true }])).toThrow("physical monitor");
    expect(() => selectBg3VisibleMonitor([physical, { ...physical, name: "HDMI-A-1" }])).toThrow();
    expect(() => selectBg3VisibleMonitor([{ ...physical, name: 'DP-2"; unsafe()' }])).toThrow();
  });

  it("reads only an explicit boolean desktop lock state", () => {
    expect(parseHyprlandDesktopLocked('{"locked":true}')).toBe(true);
    expect(parseHyprlandDesktopLocked('{"locked":false}')).toBe(false);
    for (const raw of ["ok", "null", "[]", "false", "{}", '{"locked":"false"}', '{"locked":0}']) {
      expect(() => parseHyprlandDesktopLocked(raw)).toThrow("hyprctl locked returned an invalid");
    }
  });

  it("uses only the selected display path without creating a virtual output for visible runs", async () => {
    const events: string[] = [];
    const outputs = {
      headless: async () => { events.push("create-headless"); return "virtual"; },
      visible: async () => { events.push("select-physical"); return "physical"; },
    };
    expect(await selectBg3LaunchDisplay("visible", outputs)).toBe("physical");
    expect(events).toEqual(["select-physical"]);
    expect(await selectBg3LaunchDisplay("headless", outputs)).toBe("virtual");
    expect(events).toEqual(["select-physical", "create-headless"]);
  });

  it("builds a visible ungrouped rule with a lease shared across display modes", () => {
    const expression = bg3HeadlessWindowRuleInstallExpression("run-visible", 12_345, "DP-2");
    const gameRule = expression.slice(expression.indexOf('name = "bg3-harness-display-visible'), expression.indexOf('group = "barred"') + 16);
    expect(gameRule).toContain('monitor = "DP-2"');
    expect(gameRule).toContain("float = true");
    expect(gameRule).toContain("no_initial_focus = false");
    expect(gameRule).toContain("no_focus = false");
    expect(gameRule).toContain('group = "barred"');
    expect(gameRule).not.toContain("workspace =");
    expect(expression).not.toContain("output create");
    expect(expression).not.toContain("hl.dsp.window.move");
    expect(expression).toContain('bg3_harness_window_rule_profiles["visible-DP-2"]');
    expect(expression).toContain('name = "bg3-harness-steam-launch-guard"');
    expect(expression).toContain('bg3_harness_window_rule_owner = watchdog_owner');
    expect(expression).toContain('bg3_harness_window_rule:set_enabled(false)');
    expect(expression).toContain('{ timeout = 12345, type = "oneshot" })');
    expect(() => bg3HeadlessWindowRuleInstallExpression("run-visible", 1000, "HEADLESS-1")).toThrow();
  });

  it("fails safely when the dedicated headless workspace already exists", () => {
    expect(() => assertBg3HeadlessWorkspaceAvailable([
      "1",
      "bg3-harness",
    ])).toThrow("Refusing to reuse existing Hyprland workspace bg3-harness");
  });

  it("discovers a mapped BG3 window even when it cannot accept focus", () => {
    expect(isMappedBg3WindowCandidate({
      pid: 4_102,
      mapped: true,
      acceptsInput: false,
    }, 4_102)).toBe(true);
  });

  function initialVisibleFocus() {
    const game = { pid: 4_102, address: "0xabc123", stableId: "18000a41", mapped: true,
      hidden: false, groupedAddresses: [] as string[], monitorId: 0, workspaceName: "3",
      className: "steam_app_1086940", initialClassName: "steam_app_1086940", acceptsInput: true };
    const editor = { ...game, pid: 4_101, address: "0xabc124", stableId: "1800042f" };
    const state = { windows: [game], active: editor, valid: true, validations: 0, polls: 0,
      commands: [] as string[][], afterReads: () => {}, afterDispatch: () => {}, afterPoll: () => {},
      dispatchResponse: "ok\n", properties: { noFocus: "false", noFollowMouse: "false" },
      desktopLocked: false,
      propertyTargets: [] as string[] };
    const options = {
      window: game, processId: game.pid,
      validateProcess: async () => { state.validations += 1; return state.valid; },
      readWindows: async () => state.windows,
      readActiveWindow: async () => { state.afterReads(); return state.active; },
      readDesktopLocked: async () => state.desktopLocked,
      readWindowProperties: async (window: { stableId: string }) => {
        state.propertyTargets.push(window.stableId);
        return { ...state.properties };
      },
      dispatch: async (command: readonly string[]) => {
        state.commands.push([...command]); state.afterDispatch(); return state.dispatchResponse;
      },
      waitUntil: async (predicate: () => Promise<boolean>, timeoutMs: number) => {
        expect(timeoutMs).toBe(5_000);
        for (let index = 0; index < 4; index += 1) {
          state.polls += 1;
          state.afterPoll();
          if (await predicate()) return true;
        }
        return false;
      },
    };
    return { state, options, game, editor };
  }

  it("focuses the exact visible BG3 stable window once and waits for observed focus", async () => {
    const { state, options, game, editor } = initialVisibleFocus();
    state.afterPoll = () => { if (state.polls === 3) state.active = game; };
    await expect(focusBg3VisibleWindowOnce(options)).resolves.toBeUndefined();
    expect(state.commands).toEqual([["dispatch", 'hl.dsp.focus({ window = "stableid:18000a41" })']]);
    expect(state.polls).toBe(3);
    state.active = editor;
    await Promise.resolve();
    expect(state.commands).toHaveLength(1);
  });

  it("does not dispatch when the validated game window already has focus", async () => {
    const { state, options, game } = initialVisibleFocus();
    state.active = game;
    await expect(focusBg3VisibleWindowOnce(options)).resolves.toBeUndefined();
    expect(state.commands).toHaveLength(0);
    expect(state.polls).toBe(0);
  });

  it.each(["before-read", "during-read", "after-dispatch"])(
    "rejects a replaced process identity %s without refocusing",
    async (stage) => {
      const { state, options } = initialVisibleFocus();
      if (stage === "before-read") state.valid = false;
      if (stage === "during-read") state.afterReads = () => { state.valid = false; };
      if (stage === "after-dispatch") state.afterDispatch = () => { state.valid = false; };
      await expect(focusBg3VisibleWindowOnce(options)).rejects.toThrow("process identity changed");
      expect(state.commands).toHaveLength(stage === "after-dispatch" ? 1 : 0);
    },
  );

  it.each(["pid", "stable-id", "address", "hidden", "unmapped", "grouped", "monitor", "ambiguous"])(
    "rejects a changed visible window before focus: %s",
    async (change) => {
      const { state, options, game } = initialVisibleFocus();
      const current = { ...game };
      if (change === "pid") current.pid += 1;
      if (change === "stable-id") current.stableId = "18000a42";
      if (change === "address") current.address = "0xdef123";
      if (change === "hidden") current.hidden = true;
      if (change === "unmapped") current.mapped = false;
      if (change === "grouped") current.groupedAddresses = ["0xabc124"];
      if (change === "monitor") current.monitorId = 1;
      state.windows = change === "ambiguous" ? [game, { ...game, stableId: "18000a42" }] : [current];
      await expect(focusBg3VisibleWindowOnce(options)).rejects.toThrow("window identity changed");
      expect(state.commands).toHaveLength(0);
    },
  );

  it("does not retarget another window of the same PID after dispatch", async () => {
    const { state, options, game } = initialVisibleFocus();
    state.afterDispatch = () => { state.windows = [{ ...game, stableId: "18000a42" }]; };
    await expect(focusBg3VisibleWindowOnce(options)).rejects.toThrow("window identity changed");
    expect(state.commands).toHaveLength(1);
  });

  it("fails if initial focus never arrives without repeating the action", async () => {
    const { state, options } = initialVisibleFocus();
    await expect(focusBg3VisibleWindowOnce(options)).rejects.toThrow("did not receive initial focus within 5000 ms");
    expect(state.commands).toHaveLength(1);
    expect(state.polls).toBe(4);
  });

  it("preserves the dispatch response and exact owned window properties on focus timeout", async () => {
    const { state, options, game, editor } = initialVisibleFocus();
    state.dispatchResponse = "warning: hl.focus: window not found\n";
    state.afterDispatch = () => {
      state.properties = { noFocus: "true", noFollowMouse: "true" };
      state.windows = [{ ...game, initialClassName: "steam", acceptsInput: false }];
    };
    Object.assign(editor, { title: "private editor title", secret: "private editor payload" });
    Object.assign(game, { title: "private game title", secret: "private game payload" });
    let message = "";
    try { await focusBg3VisibleWindowOnce(options); } catch (error) { message = String(error); }
    expect(message).toContain("did not receive initial focus within 5000 ms");
    const evidence = JSON.parse(message.split("; focus evidence: ")[1]!);
    expect(evidence.dispatchResponse).toBe("warning: hl.focus: window not found\n");
    expect(evidence.before.window).toMatchObject({ pid: game.pid, stableId: game.stableId,
      className: "steam_app_1086940", initialClassName: "steam_app_1086940", acceptsInput: true });
    expect(evidence.before.properties).toEqual({ noFocus: "false", noFollowMouse: "false" });
    expect(evidence.after.window).toMatchObject({ pid: game.pid, stableId: game.stableId,
      className: "steam_app_1086940", initialClassName: "steam", acceptsInput: false });
    expect(evidence.after.properties).toEqual({ noFocus: "true", noFollowMouse: "true" });
    expect(evidence.after.active).toEqual({ pid: editor.pid, stableId: editor.stableId, address: editor.address });
    expect(message).not.toContain("private");
    expect(state.commands).toHaveLength(1);
    expect(state.propertyTargets).toEqual([game.stableId, game.stableId]);
  });

  it("keeps the focus timeout when a diagnostic property query fails", async () => {
    const { state, options } = initialVisibleFocus();
    options.readWindowProperties = async () => { throw new Error("private diagnostic failure"); };
    let message = "";
    try { await focusBg3VisibleWindowOnce(options); } catch (error) { message = String(error); }
    expect(message).toContain("did not receive initial focus within 5000 ms");
    expect(message).toContain('"unavailable":true');
    expect(message).not.toContain("private");
    expect(state.commands).toHaveLength(1);
  });

  it("records a desktop that locks after launch without repeating focus", async () => {
    const { state, options } = initialVisibleFocus();
    state.afterDispatch = () => { state.desktopLocked = true; };
    let message = "";
    try { await focusBg3VisibleWindowOnce(options); } catch (error) { message = String(error); }
    expect(message).toContain("did not receive initial focus within 5000 ms");
    const evidence = JSON.parse(message.split("; focus evidence: ")[1]!);
    expect(evidence.before.desktop).toEqual({ locked: false });
    expect(evidence.after.desktop).toEqual({ locked: true });
    expect(state.commands).toHaveLength(1);
  });

  it("keeps the focus failure when the desktop diagnostic becomes unavailable", async () => {
    const { state, options } = initialVisibleFocus();
    options.readDesktopLocked = async () => { throw new Error("private desktop query failure"); };
    let message = "";
    try { await focusBg3VisibleWindowOnce(options); } catch (error) { message = String(error); }
    expect(message).toContain("did not receive initial focus within 5000 ms");
    const evidence = JSON.parse(message.split("; focus evidence: ")[1]!);
    expect(evidence.after.desktop).toEqual({ unavailable: true });
    expect(message).not.toContain("private");
    expect(state.commands).toHaveLength(1);
  });

  it("requires the focused window to match both the PID and stable identity", async () => {
    const { state, options, game } = initialVisibleFocus();
    state.active = { ...game, stableId: "18000a42" };
    await expect(focusBg3VisibleWindowOnce(options)).rejects.toThrow("did not receive initial focus");
    expect(state.commands).toHaveLength(1);
  });

  it("rejects an unsafe stable ID before any compositor action", async () => {
    const { state, options } = initialVisibleFocus();
    options.window = { ...options.window, stableId: 'abc" })' };
    await expect(focusBg3VisibleWindowOnce(options)).rejects.toThrow("unvalidated visible BG3 window");
    expect(state.validations).toBe(0);
    expect(state.commands).toHaveLength(0);
  });

  it("disables the reusable headless rule without creating another rule", () => {
    const expression = bg3HeadlessWindowRuleCleanupExpression(
      "run-window-rule",
    );
    expect(expression).toContain(
      'if bg3_harness_window_rule_owner == "run-window-rule" then',
    );
    expect(expression).toContain(
      "bg3_harness_window_rule:set_enabled(false)",
    );
    expect(expression).toContain(
      "bg3_harness_steam_rule:set_enabled(false)",
    );
    expect(expression).toContain(
      "bg3_harness_window_rule_timer:set_timeout(1)",
    );
    expect(expression).toContain("bg3_harness_window_rule_owner = nil");
    expect(expression.indexOf("set_enabled(false)")).toBeLessThan(
      expression.indexOf("window_rule_owner = nil"),
    );
  });

  it("creates output, installs rule, then spawns without changing focus", async () => {
    const events: string[] = [];
    await expect(prepareBg3HeadlessLaunch({
      createOutput: async () => {
        events.push("create-output");
        return "HEADLESS-1";
      },
      installRule: async () => {
        events.push("install-rule");
      },
      beforeSpawn: async () => {
        events.push("prepare-bridge");
      },
      spawn: async () => {
        events.push("spawn");
      },
      cleanup: async () => {
        events.push("cleanup");
      },
    })).resolves.toBe("HEADLESS-1");
    expect(events).toEqual([
      "create-output",
      "install-rule",
      "prepare-bridge",
      "spawn",
    ]);
  });

  it.each(["install-rule", "prepare-bridge", "spawn"])(
    "cleans headless isolation when %s fails",
    async (failureStage) => {
      const events: string[] = [];
      const stage = async (name: string): Promise<void> => {
        events.push(name);
        if (name === failureStage) throw new Error(`${name} failed`);
      };
      await expect(prepareBg3HeadlessLaunch({
        createOutput: async () => {
          events.push("create-output");
          return "HEADLESS-1";
        },
        installRule: async () => stage("install-rule"),
        beforeSpawn: async () => stage("prepare-bridge"),
        spawn: async () => stage("spawn"),
        cleanup: async () => {
          events.push("cleanup");
        },
      })).rejects.toThrow(`${failureStage} failed`);
      expect(events.at(-1)).toBe("cleanup");
    },
  );

  it("waits until the one new .lsv has stayed unchanged", async () => {
    let nowMs = 0;
    const saveId = await waitForStableNewBg3Save({
      before: new Set(["ProtectedSave"]),
      minimumModifiedAtMs: 100,
      timeoutMs: 3_000,
      stabilityMs: 2_000,
      pollMs: 200,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      assertGameRunning: async () => undefined,
      readSaveIds: async () =>
        new Set(["ProtectedSave", "Tav-created__AutoSave_0"]),
      inspectSave: async (id) => ({
        id,
        lsvPath: `/saves/${id}/${id}.lsv`,
        device: 1,
        inode: 10,
        size: 4096,
        modifiedAtMs: 100,
      }),
    });

    expect(saveId).toBe("Tav-created__AutoSave_0");
    expect(nowMs).toBe(2_000);
  });

  it("times out when character creation does not produce a save", async () => {
    let nowMs = 0;
    await expect(
      waitForStableNewBg3Save({
        before: new Set(["ProtectedSave"]),
        minimumModifiedAtMs: 100,
        timeoutMs: 1_000,
        stabilityMs: 400,
        pollMs: 200,
        now: () => nowMs,
        sleep: async (durationMs) => {
          nowMs += durationMs;
        },
        assertGameRunning: async () => undefined,
        readSaveIds: async () => new Set(["ProtectedSave"]),
        inspectSave: async () => undefined,
      }),
    ).rejects.toThrow(
      "Timed out after 1000 ms waiting for one stable new BG3 save",
    );
  });

  it("rejects a new save whose .lsv predates the launch", async () => {
    await expect(
      waitForStableNewBg3Save({
        before: new Set(["ProtectedSave"]),
        minimumModifiedAtMs: 1_000,
        timeoutMs: 1_000,
        stabilityMs: 400,
        pollMs: 200,
        now: () => 0,
        sleep: async () => undefined,
        assertGameRunning: async () => undefined,
        readSaveIds: async () => new Set(["ProtectedSave", "Tav-new__AutoSave_0"]),
        inspectSave: async (id) => ({
          id,
          lsvPath: `/saves/${id}/${id}.lsv`,
          device: 1,
          inode: 10,
          size: 4096,
          modifiedAtMs: 999,
        }),
      }),
    ).rejects.toThrow(
      "New BG3 save predates the test launch: Tav-new__AutoSave_0",
    );
  });

  it("rejects multiple saves through the stable-save validator", async () => {
    await expect(
      waitForStableNewBg3Save({
        before: new Set(["ProtectedSave"]),
        minimumModifiedAtMs: 0,
        timeoutMs: 1_000,
        stabilityMs: 400,
        pollMs: 200,
        now: () => 0,
        sleep: async () => undefined,
        assertGameRunning: async () => undefined,
        readSaveIds: async () =>
          new Set([
            "ProtectedSave",
            "harness-one__AutoSave_0",
            "harness-one__AutoSave_1",
          ]),
        inspectSave: async () => undefined,
      }),
    ).rejects.toThrow("Character creation produced 2 new saves");
  });

  it("snapshots every .lsv identity with filesystem identity", async () => {
    const saveRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-saves-"));
    try {
      const firstDirectory = path.join(saveRoot, "ProtectedSave");
      const secondDirectory = path.join(saveRoot, "Tav-test__AutoSave_0");
      await Promise.all([
        mkdir(firstDirectory),
        mkdir(secondDirectory),
      ]);
      await Promise.all([
        writeFile(path.join(firstDirectory, "ProtectedSave.lsv"), "protected"),
        writeFile(path.join(firstDirectory, "WebP.webp"), "ignored"),
        writeFile(path.join(secondDirectory, "Save.lsv"), "fixture"),
      ]);

      const snapshot = await snapshotBg3SaveIdentities(saveRoot);

      expect([...snapshot.values()].map(({ id }) => id).sort()).toEqual([
        "ProtectedSave",
        "Tav-test__AutoSave_0",
      ]);
      for (const identity of snapshot.values()) {
        expect(identity.device).toBeTypeOf("number");
        expect(identity.inode).toBeGreaterThan(0);
        expect(identity.size).toBeGreaterThan(0);
      }
    } finally {
      await rm(saveRoot, { recursive: true, force: true });
    }
  });

  it("detects created, modified, and deleted .lsv identities", () => {
    const before = new Map([
      ["/saves/kept.lsv", {
        id: "kept",
        lsvPath: "/saves/kept.lsv",
        device: 1,
        inode: 10,
        size: 100,
        modifiedAtMs: 100,
      }],
      ["/saves/deleted.lsv", {
        id: "deleted",
        lsvPath: "/saves/deleted.lsv",
        device: 1,
        inode: 11,
        size: 100,
        modifiedAtMs: 100,
      }],
    ]);
    const after = new Map([
      ["/saves/kept.lsv", {
        id: "kept",
        lsvPath: "/saves/kept.lsv",
        device: 1,
        inode: 10,
        size: 120,
        modifiedAtMs: 200,
      }],
      ["/saves/created.lsv", {
        id: "created",
        lsvPath: "/saves/created.lsv",
        device: 1,
        inode: 12,
        size: 100,
        modifiedAtMs: 200,
      }],
    ]);

    expect(changedBg3SaveIdentities(before, after).map((change) => change.kind))
      .toEqual(["created", "deleted", "modified"]);
    expect(() => assertNoBg3SaveChanges(before, after, "before save intent"))
      .toThrow("3 .lsv identities changed before save intent");
  });

  it.each(["ProtectedSave", "777"])(
    "fails runtime postcondition when protected save %s changes",
    (saveId) => {
      const lsvPath = `/saves/${saveId}/Save.lsv`;
      const before = new Map([[lsvPath, {
        id: saveId,
        lsvPath,
        device: 1,
        inode: 10,
        size: 100,
        modifiedAtMs: 100,
      }]]);
      const after = new Map([[lsvPath, {
        id: saveId,
        lsvPath,
        device: 1,
        inode: 10,
        size: 101,
        modifiedAtMs: 200,
      }]]);

      expect(() => assertNoBg3SaveChanges(
        before,
        after,
        "during runtime scenario",
      )).toThrow(`modified:${saveId}`);
    },
  );

  it("rejects an unacknowledged save after failed character creation", () => {
    const lsvPath = "/saves/early/Save.lsv";
    expect(() => assertBg3CreationSavePostcondition(
      new Map(),
      new Map([[lsvPath, {
        id: "early",
        lsvPath,
        device: 1,
        inode: 30,
        size: 100,
        modifiedAtMs: 200,
      }]]),
      undefined,
      "during failed character creation",
    )).toThrow("1 .lsv identities changed during failed character creation");
  });

  it("accepts only the unchanged fixture validated by character creation", () => {
    const lsvPath = "/saves/Tav-new/Save.lsv";
    const validatedSave = {
      id: "Tav-new",
      lsvPath,
      device: 1,
      inode: 30,
      size: 100,
      modifiedAtMs: 200,
    };
    const after = new Map([[lsvPath, validatedSave]]);

    expect(() => assertBg3CreationSavePostcondition(
      new Map(),
      after,
      validatedSave,
      "after validated character creation",
    )).not.toThrow();
    expect(() => assertBg3CreationSavePostcondition(
      new Map(),
      new Map([[lsvPath, { ...validatedSave, size: 101 }]]),
      validatedSave,
      "after validated character creation",
    )).toThrow("does not match validated fixture Tav-new");
  });

  it.each([0, 600])("accepts one stable .lsv after a %i ms write delay", async (writeDelayMs) => {
    let nowMs = 1_000;
    const before = new Map<string, {
      id: string;
      lsvPath: string;
      device: number;
      inode: number;
      size: number;
      modifiedAtMs: number;
    }>();
    const changed = new Map([
      ["/saves/Tav-new/Save.lsv", {
        id: "Tav-new",
        lsvPath: "/saves/Tav-new/Save.lsv",
        device: 1,
        inode: 20,
        size: 4_096,
        modifiedAtMs: 1_100,
      }],
    ]);

    await expect(waitForStableBg3SaveChange({
      before,
      requestedAtEpochMs: 1_050,
      timeoutMs: 3_000,
      stabilityMs: 2_000,
      pollMs: 200,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      assertGameRunning: async () => undefined,
      readSnapshot: async () => nowMs < 1_000 + writeDelayMs ? before : changed,
    })).resolves.toBe("Tav-new");
    expect(nowMs).toBe(3_000 + writeDelayMs);
  });

  it.each(["unchanged", "deleted"] as const)("handles a %s snapshot while waiting for the new save", async (state) => {
    let nowMs = 1_000;
    const lsvPath = "/saves/existing/Save.lsv";
    const before = new Map([[lsvPath, {
      id: "existing", lsvPath, device: 1, inode: 20, size: 100, modifiedAtMs: 100,
    }]]);
    await expect(waitForStableBg3SaveChange({
      before,
      requestedAtEpochMs: 1_000,
      timeoutMs: 300,
      stabilityMs: 100,
      pollMs: 100,
      now: () => nowMs,
      sleep: async (durationMs) => { nowMs += durationMs; },
      assertGameRunning: async () => undefined,
      readSnapshot: async () => state === "deleted" ? new Map() : before,
    })).rejects.toThrow(state === "deleted"
      ? "BG3 deleted .lsv identity after save request: existing"
      : "Timed out after 300 ms waiting for one stable request-correlated BG3 save");
    expect(nowMs).toBe(state === "deleted" ? 1_000 : 1_300);
  });

  it("accepts a created save whose mtime is truncated within request second", async () => {
    let nowMs = 1_500;
    const lsvPath = "/saves/Tav-truncated/Save.lsv";
    await expect(waitForStableBg3SaveChange({
      before: new Map(),
      requestedAtEpochMs: 1_500,
      timeoutMs: 1_000,
      stabilityMs: 100,
      pollMs: 100,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      assertGameRunning: async () => undefined,
      readSnapshot: async () => new Map([[lsvPath, {
        id: "Tav-truncated",
        lsvPath,
        device: 1,
        inode: 25,
        size: 100,
        modifiedAtMs: 1_000,
      }]]),
    })).resolves.toBe("Tav-truncated");
  });

  it("rejects a created save whose mtime predates the request second", async () => {
    const lsvPath = "/saves/Tav-stale/Save.lsv";
    await expect(waitForStableBg3SaveChange({
      before: new Map(),
      requestedAtEpochMs: 1_500,
      timeoutMs: 1_000,
      stabilityMs: 100,
      pollMs: 100,
      now: () => 1_500,
      sleep: async () => undefined,
      assertGameRunning: async () => undefined,
      readSnapshot: async () => new Map([[lsvPath, {
        id: "Tav-stale",
        lsvPath,
        device: 1,
        inode: 25,
        size: 100,
        modifiedAtMs: 0,
      }]]),
    })).rejects.toThrow("Changed BG3 save predates save request: Tav-stale");
  });

  it.each(["ProtectedSave", "777-1000000000__AutoSave_0", "777evil"])(
    "rejects a request-correlated change to protected save %s",
    async (saveId) => {
      const lsvPath = `/saves/${saveId}/Save.lsv`;
      await expect(waitForStableBg3SaveChange({
        before: new Map(),
        requestedAtEpochMs: 100,
        timeoutMs: 1_000,
        stabilityMs: 200,
        pollMs: 100,
        protectedSaves: testProtectedSaves,
        now: () => 100,
        sleep: async () => undefined,
        assertGameRunning: async () => undefined,
        readSnapshot: async () => new Map([[lsvPath, {
          id: saveId,
          lsvPath,
          device: 1,
          inode: 20,
          size: 100,
          modifiedAtMs: 100,
        }]]),
      })).rejects.toThrow(`protected BG3 save ${saveId}`);
    },
  );

  it("rejects more than one changed .lsv identity after save request", async () => {
    const changed = new Map(["one", "two"].map((id, index) => {
      const lsvPath = `/saves/${id}/Save.lsv`;
      return [lsvPath, {
        id,
        lsvPath,
        device: 1,
        inode: 20 + index,
        size: 100,
        modifiedAtMs: 100,
      }] as const;
    }));
    await expect(waitForStableBg3SaveChange({
      before: new Map(),
      requestedAtEpochMs: 100,
      timeoutMs: 1_000,
      stabilityMs: 200,
      pollMs: 100,
      now: () => 100,
      sleep: async () => undefined,
      assertGameRunning: async () => undefined,
      readSnapshot: async () => changed,
    })).rejects.toThrow("2 .lsv identities changed after save request");
  });

  it("rejects modifying an existing .lsv after save request", async () => {
    const lsvPath = "/saves/existing/Save.lsv";
    const before = new Map([[lsvPath, {
      id: "existing",
      lsvPath,
      device: 1,
      inode: 20,
      size: 100,
      modifiedAtMs: 100,
    }]]);
    const after = new Map([[lsvPath, {
      id: "existing",
      lsvPath,
      device: 1,
      inode: 20,
      size: 120,
      modifiedAtMs: 200,
    }]]);

    await expect(waitForStableBg3SaveChange({
      before,
      requestedAtEpochMs: 150,
      timeoutMs: 1_000,
      stabilityMs: 200,
      pollMs: 100,
      now: () => 200,
      sleep: async () => undefined,
      assertGameRunning: async () => undefined,
      readSnapshot: async () => after,
    })).rejects.toThrow(
      "Save request modified an existing .lsv identity: existing",
    );
  });

  it("rejects a save request timestamp from before its acknowledgement", () => {
    expect(() => assertBg3SaveRequestMatchesAcknowledgement({
      schemaVersion: 2,
      runId: "run-save-request",
      scenarioId: "example.background-creation",
      status: "requested",
      intentId: "run-save-request.save1",
      requestedAtEpochMs: 199,
    }, {
      intentId: "run-save-request.save1",
      acknowledgedAtEpochMs: 200,
    })).toThrow("BG3 save request predates its acknowledgement");
  });

  it("times out while waiting for the character-creation client ack", async () => {
    let nowMs = 0;
    await expect(
      waitForBg3ClientReady({
        runId: "run-client-ready-timeout",
        scenarioId: "example.background-creation",
        createdAtEpochMs: 0,
        expiresAtEpochMs: 1_000,
        timeoutMs: 1_000,
        pollMs: 200,
        maxBytes: 1024,
        now: () => nowMs,
        sleep: async (durationMs) => {
          nowMs += durationMs;
        },
        assertGameRunning: async () => undefined,
        readAcknowledgement: async () => undefined,
      }),
    ).rejects.toThrow(
      "Timed out after 1000 ms waiting for the character-creation client",
    );
  });

  it("accepts a builtin observation only after required mods pass validation", async () => {
    let nowMs = 0;
    await expect(
      waitForBg3ModLoad({
        runId: "run-mod-load",
        scenarioId: "core.runtime-smoke",
        createdAtEpochMs: 0,
        expiresAtEpochMs: 1_000,
        requiredMods: {
          ordered: [
            {
              name: "Example Rules Dependency",
              uuid: "0508cc3f-d202-4ae5-a927-7c837bd40de6",
            },
            {
              name: "BG3 In-Game Harness",
              uuid: "41d551b8-e0c1-4c12-8a29-1be03b5f9054",
            },
            {
              name: "Harness Example",
              uuid: "cd639062-7736-457d-aa6a-c364979b8921",
            },
          ],
          present: [],
        },
        timeoutMs: 1_000,
        pollMs: 200,
        stabilityMs: 200,
        maxBytes: 1024,
        now: () => nowMs,
        sleep: async (durationMs) => {
          nowMs += durationMs;
        },
        assertGameRunning: async () => undefined,
        readStartupError: async () => undefined,
        readAutosaveGuard: async () => ({
          size: 200,
          contents: JSON.stringify({
            schemaVersion: 2,
            runId: "run-mod-load",
            scenarioId: "core.runtime-smoke",
            status: "suppressed",
            suppressedAtEpochMs: 50,
          }),
        }),
        readObservation: async () => ({
          size: 320,
          contents: JSON.stringify({
            schemaVersion: 2,
            runId: "run-mod-load",
            scenarioId: "core.runtime-smoke",
            status: "observed",
            observedAtEpochMs: nowMs,
            loadOrder: [
              "0508cc3f-d202-4ae5-a927-7c837bd40de6",
              "41d551b8-e0c1-4c12-8a29-1be03b5f9054",
              "cd639062-7736-457d-aa6a-c364979b8921",
            ],
          }),
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("retries an intermediate load order until every required mod appears", async () => {
    let nowMs = 0;
    let observationReads = 0;
    const rulesUuid = "0508cc3f-d202-4ae5-a927-7c837bd40de6";
    const coreUuid = "41d551b8-e0c1-4c12-8a29-1be03b5f9054";

    await expect(waitForBg3ModLoad({
      runId: "run-progressive-mod-load",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      requiredMods: {
        ordered: [
          { name: "Example Rules Dependency", uuid: rulesUuid },
          { name: "BG3 In-Game Harness", uuid: coreUuid },
        ],
        present: [],
      },
      timeoutMs: 1_000,
      pollMs: 200,
      stabilityMs: 200,
      maxBytes: 1024,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      assertGameRunning: async () => undefined,
      readStartupError: async () => undefined,
      readAutosaveGuard: async () => ({
        size: 200,
        contents: JSON.stringify({
          schemaVersion: 2,
          runId: "run-progressive-mod-load",
          scenarioId: "core.runtime-smoke",
          status: "suppressed",
          suppressedAtEpochMs: 50,
        }),
      }),
      readObservation: async () => {
        observationReads += 1;
        const loadOrder = observationReads === 1
          ? [rulesUuid]
          : [rulesUuid, coreUuid];
        const contents = JSON.stringify({
          schemaVersion: 2,
          runId: "run-progressive-mod-load",
          scenarioId: "core.runtime-smoke",
          status: "observed",
          observedAtEpochMs: nowMs,
          loadOrder,
        });
        return { size: contents.length, contents };
      },
    })).resolves.toBeUndefined();
    expect(observationReads).toBe(3);
  });

  it("does not accept a complete mod-load artifact from another run", async () => {
    let nowMs = 0;
    let observationReads = 0;
    const rulesUuid = "0508cc3f-d202-4ae5-a927-7c837bd40de6";
    const coreUuid = "41d551b8-e0c1-4c12-8a29-1be03b5f9054";

    await expect(waitForBg3ModLoad({
      runId: "run-current-mod-load",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      requiredMods: {
        ordered: [
          { name: "Example Rules Dependency", uuid: rulesUuid },
          { name: "BG3 In-Game Harness", uuid: coreUuid },
        ],
        present: [],
      },
      timeoutMs: 1_000,
      pollMs: 200,
      stabilityMs: 200,
      maxBytes: 1_024,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      assertGameRunning: async () => undefined,
      readStartupError: async () => undefined,
      readAutosaveGuard: async () => {
        const contents = JSON.stringify({
          schemaVersion: 2,
          runId: "run-current-mod-load",
          scenarioId: "core.runtime-smoke",
          status: "suppressed",
          suppressedAtEpochMs: 50,
        });
        return { size: contents.length, contents };
      },
      readObservation: async () => {
        observationReads += 1;
        const contents = JSON.stringify({
          schemaVersion: 2,
          runId: observationReads === 1
            ? "run-stale-mod-load"
            : "run-current-mod-load",
          scenarioId: "core.runtime-smoke",
          status: "observed",
          observedAtEpochMs: nowMs,
          loadOrder: [rulesUuid, coreUuid],
        });
        return { size: contents.length, contents };
      },
    })).resolves.toBeUndefined();
    expect(observationReads).toBe(3);
  });

  it("reports the last mod-load protocol error when polling expires", async () => {
    let nowMs = 0;
    let observationReads = 0;
    const rulesUuid = "0508cc3f-d202-4ae5-a927-7c837bd40de6";

    await expect(waitForBg3ModLoad({
      runId: "run-incomplete-mod-load",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 400,
      requiredMods: {
        ordered: [
          { name: "Example Rules Dependency", uuid: rulesUuid },
          {
            name: "BG3 In-Game Harness",
            uuid: "41d551b8-e0c1-4c12-8a29-1be03b5f9054",
          },
        ],
        present: [],
      },
      timeoutMs: 400,
      pollMs: 200,
      stabilityMs: 200,
      maxBytes: 1024,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      assertGameRunning: async () => undefined,
      readStartupError: async () => undefined,
      readAutosaveGuard: async () => ({
        size: 200,
        contents: JSON.stringify({
          schemaVersion: 2,
          runId: "run-incomplete-mod-load",
          scenarioId: "core.runtime-smoke",
          status: "suppressed",
          suppressedAtEpochMs: 50,
        }),
      }),
      readObservation: async () => {
        observationReads += 1;
        const contents = JSON.stringify({
          schemaVersion: 2,
          runId: "run-incomplete-mod-load",
          scenarioId: "core.runtime-smoke",
          status: "observed",
          observedAtEpochMs: 100,
          loadOrder: [rulesUuid],
        });
        return { size: contents.length, contents };
      },
    })).rejects.toThrow(
      "Required BG3 mod is not loaded: BG3 In-Game Harness (41d551b8-e0c1-4c12-8a29-1be03b5f9054)",
    );
    expect(observationReads).toBe(2);
  });

  it("waits for autosave suppression after the mod order is complete", async () => {
    let nowMs = 0;
    let guardReads = 0;
    const rulesUuid = "0508cc3f-d202-4ae5-a927-7c837bd40de6";
    const coreUuid = "41d551b8-e0c1-4c12-8a29-1be03b5f9054";

    await expect(waitForBg3ModLoad({
      runId: "run-autosave-guard",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      requiredMods: {
        ordered: [
          { name: "Example Rules Dependency", uuid: rulesUuid },
          { name: "BG3 In-Game Harness", uuid: coreUuid },
        ],
        present: [],
      },
      timeoutMs: 1_000,
      pollMs: 200,
      stabilityMs: 200,
      maxBytes: 1024,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      assertGameRunning: async () => undefined,
      readStartupError: async () => undefined,
      readAutosaveGuard: async () => {
        guardReads += 1;
        if (guardReads === 1) return undefined;
        const contents = JSON.stringify({
          schemaVersion: 2,
          runId: "run-autosave-guard",
          scenarioId: "core.runtime-smoke",
          status: "suppressed",
          suppressedAtEpochMs: 100,
        });
        return { size: contents.length, contents };
      },
      readObservation: async () => {
        const contents = JSON.stringify({
          schemaVersion: 2,
          runId: "run-autosave-guard",
          scenarioId: "core.runtime-smoke",
          status: "observed",
          observedAtEpochMs: nowMs,
          loadOrder: [rulesUuid, coreUuid],
        });
        return { size: contents.length, contents };
      },
    })).resolves.toBeUndefined();
    expect(guardReads).toBe(2);
  });

  it("fails mod-load preflight immediately when autosave suppression is unavailable", async () => {
    let nowMs = 0;
    const startupError = JSON.stringify({
      schemaVersion: 2,
      runId: "run-guard-unavailable",
      scenarioId: "core.runtime-smoke",
      status: "error",
      startedAtEpochMs: 100,
      completedAtEpochMs: 100,
      assertions: [],
      error: {
        code: "autosave-guard-unavailable",
        message: "CanAutoSave could not be disabled",
      },
    });

    await expect(waitForBg3ModLoad({
      runId: "run-guard-unavailable",
      scenarioId: "core.runtime-smoke",
      createdAtEpochMs: 0,
      expiresAtEpochMs: 1_000,
      requiredMods: { ordered: [], present: [] },
      timeoutMs: 1_000,
      pollMs: 200,
      stabilityMs: 200,
      maxBytes: 1_024,
      now: () => nowMs,
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
      assertGameRunning: async () => {
        throw new Error("BG3 exited");
      },
      readStartupError: async () => ({
        size: startupError.length,
        contents: startupError,
      }),
      readAutosaveGuard: async () => undefined,
      readObservation: async () => undefined,
    })).rejects.toThrow(
      "autosave-guard-unavailable: CanAutoSave could not be disabled",
    );
    expect(nowMs).toBe(0);
  });

  it("accepts exactly one non-empty .lsv in the new save directory", async () => {
    const saveRoot = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-save-"));
    const saveId = "Tav-created__AutoSave_0";
    try {
      const saveDirectory = path.join(saveRoot, saveId);
      await mkdir(saveDirectory);
      await writeFile(path.join(saveDirectory, `${saveId}.lsv`), "save-data");

      await expect(inspectNewBg3Save(saveRoot, saveId)).resolves.toMatchObject({
        id: saveId,
        size: 9,
      });
    } finally {
      await rm(saveRoot, { recursive: true, force: true });
    }
  });
});
