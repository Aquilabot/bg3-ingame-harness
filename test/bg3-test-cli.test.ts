import { describe, expect, it } from "vitest";
import { bg3DisplayFromArguments, runBg3Test } from "../src/runner.js";
import { harnessMod, testCatalog, testProtectedSaves } from "./fixtures.js";
import {
  Bg3TestTimeoutError,
  type Bg3TestPlatform,
} from "../src/platform.js";
import { Bg3TestProtocolError } from "../src/protocol.js";
import {
  createBg3TestScenarioCatalog,
  type Bg3TestScenarioDefinition,
} from "../src/scenario-catalog.js";

const exampleBackgroundAssertionIds = [
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
] as const;

describe("bg3:test CLI", () => {
  it.each([
    { flags: [], display: "headless" },
    { flags: ["--display", "headless"], display: "headless" },
    { flags: ["--display", "visible"], display: "visible" },
  ])("reports a successful runtime scenario with $flags", async ({ flags, display }) => {
    const output: string[] = [];
    const finalization: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async (runId) => {
        finalization.push(`archive:${runId}`);
      },
      armRun: async () => undefined,
      cleanupRun: async (runId) => {
        finalization.push(`cleanup:${runId}`);
      },
      launchGame: async (saveId, _runId, mode, requestedDisplay) => {
        expect(saveId).toBe("harness-fixture__AutoSave_0");
        expect(mode).toBe("runtime");
        expect(requestedDisplay).toBe(display);
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () =>
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-success",
          scenarioId: "core.runtime-smoke",
          status: "passed",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839202000,
          assertions: [
            {
              id: "host-entity",
              passed: true,
              message: "The fixture host entity is loaded",
            },
            {
              id: "host-party-member",
              passed: true,
              message: "The fixture host belongs to the party",
            },
          ],
        }),
      runId: () => "run-success",
      terminateGame: async () => {
        finalization.push("terminate");
      },
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke", ...flags],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(0);
    expect(output).toContain("PASS core.runtime-smoke");
    expect(output).toContain(
      "PASS host-entity: The fixture host entity is loaded",
    );
    expect(output).toContain("TIME core.runtime-smoke: 1000 ms");
    expect(finalization).toEqual([
      "cleanup:run-success",
      "terminate",
      "archive:run-success",
      "cleanup:run-success",
    ]);
  });

  it.each([
    ["--display"],
    ["--display", "native"],
    ["--display", "visible", "--display", "headless"],
    ["--display=visible"],
  ])("rejects invalid display flags %j before any platform mutation", async (...flags) => {
    expect(() => bg3DisplayFromArguments(flags)).toThrow();
    const output: string[] = [];
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected platform mutation"); };
    const platform: Bg3TestPlatform = {
      now: () => { throw new Error("Unexpected clock access"); },
      runId: () => { throw new Error("Unexpected run creation"); },
      armRun: unexpected, archiveRunArtifacts: unexpected, cleanupRun: unexpected,
      launchGame: unexpected, readResult: unexpected, terminateGame: unexpected,
      waitForModLoad: unexpected, waitForSaveLoaded: unexpected, writeCommand: unexpected,
      writeOutput: (line) => output.push(line),
    };
    expect(await runBg3Test(["--scenario", "core.runtime-smoke", ...flags], platform, testCatalog)).toBe(2);
    expect(output[0]).toMatch(/^ERROR invalid-display:/);
  });

  it("rejects an unknown scenario before launching BG3", async () => {
    const output: string[] = [];
    let launched = false;
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => {
        launched = true;
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "",
      runId: () => "run-unknown",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "example.missing"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(2);
    expect(output).toContain(
      "ERROR unknown-scenario: Unknown BG3 test scenario: example.missing",
    );
    expect(launched).toBe(false);
  });

  it("rejects a save outside the runtime allowlist", async () => {
    const output: string[] = [];
    let launched = false;
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => {
        launched = true;
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "",
      runId: () => "run-disallowed-save",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke", "--save", "ProtectedSave"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(2);
    expect(output).toContain(
      "ERROR save-not-allowed: Save is not allowed for automated tests: ProtectedSave",
    );
    expect(launched).toBe(false);
  });

  it("rejects the superseded runtime save", async () => {
    const output: string[] = [];
    let launched = false;
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => {
        launched = true;
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "",
      runId: () => "run-superseded-save",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      [
        "--scenario",
        "core.runtime-smoke",
        "--save",
        "Tav-23271261272__AutoSave_0",
      ],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(2);
    expect(output).toContain(
      "ERROR save-not-allowed: Save is not allowed for automated tests: Tav-23271261272__AutoSave_0",
    );
    expect(launched).toBe(false);
  });

  it("reports invalid result JSON and closes the launched process", async () => {
    const output: string[] = [];
    const terminatedProcesses: unknown[] = [];
    const archivedRuns: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async (runId) => {
        archivedRuns.push(runId);
      },
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "{not-json",
      runId: () => "run-invalid-json",
      terminateGame: async (processIdentity) => {
        terminatedProcesses.push(processIdentity);
      },
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "ERROR invalid-result: Script Extender returned invalid JSON",
    );
    expect(terminatedProcesses).toEqual([
      { pid: 4102, startTimeTicks: "778899" },
    ]);
    expect(archivedRuns).toEqual(["run-invalid-json"]);
  });

  it("reports a result timeout and closes the launched process", async () => {
    const output: string[] = [];
    const terminatedProcesses: unknown[] = [];
    const archivedRuns: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async (runId) => {
        archivedRuns.push(runId);
      },
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async (_runId, timeoutMs) => {
        throw new Bg3TestTimeoutError(
          `Timed out after ${timeoutMs} ms waiting for result for run-timeout`,
        );
      },
      runId: () => "run-timeout",
      terminateGame: async (processIdentity) => {
        terminatedProcesses.push(processIdentity);
      },
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "ERROR timeout: Timed out after 360000 ms waiting for result for run-timeout",
    );
    expect(terminatedProcesses).toEqual([
      { pid: 4102, startTimeTicks: "778899" },
    ]);
    expect(archivedRuns).toEqual(["run-timeout"]);
  });

  it("sends the command only after the exact save is confirmed", async () => {
    const events: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => {
        events.push("arm");
      },
      cleanupRun: async () => {
        events.push("cleanup");
      },
      launchGame: async (saveId) => {
        events.push(`launch:${saveId}`);
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => {
        events.push("read-result");
        return JSON.stringify({
          schemaVersion: 2,
          runId: "run-order",
          scenarioId: "core.runtime-smoke",
          status: "passed",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839202000,
          assertions: [
            {
              id: "host-entity",
              passed: true,
              message: "The fixture host entity is loaded",
            },
            {
              id: "host-party-member",
              passed: true,
              message: "The fixture host belongs to the party",
            },
          ],
        });
      },
      runId: () => "run-order",
      terminateGame: async () => {
        events.push("terminate");
      },
      waitForModLoad: async (_runId, _scenarioId, mode, timeoutMs) => {
        events.push(`mods-loaded:${mode}:${timeoutMs}`);
      },
      waitForSaveLoaded: async (saveId) => {
        events.push(`save-loaded:${saveId}`);
      },
      writeCommand: async () => {
        events.push("write-command");
      },
      writeOutput: () => undefined,
    };

    await runBg3Test(["--scenario", "core.runtime-smoke"], platform, testCatalog);

    expect(events).toEqual([
      "cleanup",
      "arm",
      "launch:harness-fixture__AutoSave_0",
      "mods-loaded:runtime:120000",
      "save-loaded:harness-fixture__AutoSave_0",
      "write-command",
      "read-result",
      "terminate",
      "cleanup",
    ]);
  });

  it.each([
    { flags: [], display: "headless" },
    { flags: ["--display", "headless"], display: "headless" },
    { flags: ["--display", "visible"], display: "visible" },
  ])("arms creation before launch with $flags and never loads a save", async ({ flags, display }) => {
    const events: string[] = [];
    const output: string[] = [];
    const wireTargets: unknown[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => {
        events.push("archive");
      },
      armRun: async (arm) => {
        wireTargets.push(arm);
        events.push(`arm:${arm.mode}:${arm.saveId}`);
      },
      cleanupRun: async () => {
        events.push("cleanup");
      },
      launchGame: async (saveId, _runId, mode, requestedDisplay) => {
        expect(requestedDisplay).toBe(display);
        events.push(`launch:${saveId ?? "none"}:${mode}`);
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => {
        events.push("read-result");
        return JSON.stringify({
          schemaVersion: 2,
          runId: "run-character-creation",
          scenarioId: "example.background-creation",
          status: "passed",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839202000,
          assertions: exampleBackgroundAssertionIds.map((id) => ({
            id,
            passed: true,
            message: `${id} passed`,
          })),
        });
      },
      runId: () => "run-character-creation",
      terminateGame: async () => {
        events.push("terminate");
      },
      validateNewSave: async () => {
        events.push("validate-new-save");
        return "harness-created__AutoSave_0";
      },
      waitForClientReady: async () => {
        events.push("client-ready");
      },
      waitForModLoad: async (_runId, _scenarioId, mode) => {
        events.push(`mods-loaded:${mode}`);
      },
      waitForSaveLoaded: async () => {
        events.push("save-loaded");
      },
      writeCommand: async (command) => {
        wireTargets.push(command);
        events.push(`command:${command.mode}:${command.saveId}`);
      },
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "example.background-creation", ...flags],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "cleanup",
      "arm:character-creation:__new_campaign__",
      "command:character-creation:__new_campaign__",
      "launch:none:character-creation",
      "mods-loaded:character-creation",
      "client-ready",
      "read-result",
      "validate-new-save",
      "terminate",
      "archive",
      "cleanup",
    ]);
    expect(wireTargets).toHaveLength(2);
    for (const target of wireTargets) {
      expect(target).toMatchObject({
        schemaVersion: 2,
        mode: "character-creation",
        saveId: "__new_campaign__",
        savePolicy: "create-test-fixture",
        requiredAssertionIds: exampleBackgroundAssertionIds,
        creationPlan: {
          kind: "background",
          backgroundUuid: "56c19b4a-f7b7-4aba-ba1f-0ade44a98560",
          backgroundName: "Example Background",
          requiredTransitionModUuid:
            "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c",
        },
      });
    }
    expect(output).toContain("SAVE harness-created__AutoSave_0");
  });

  it("passes a discard-campaign creation scenario without validating or reporting a save", async () => {
    const discardScenario: Bg3TestScenarioDefinition = {
      id: "example.discard-probe",
      ownerModUuid: "cd639062-7736-457d-aa6a-c364979b8921",
      savePolicy: "discard-campaign",
      timeoutMs: 600_000,
      requiredAssertionIds: ["probe-ready"],
      launch: {
        kind: "character-creation",
        creationPlan: {
          kind: "background",
          backgroundUuid: "56c19b4a-f7b7-4aba-ba1f-0ade44a98560",
          backgroundName: "Example Background",
          requiredTransitionModUuid: "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c",
        },
      },
      requiredMods: {
        ordered: [
          { name: "Example Rules Dependency", uuid: "0508cc3f-d202-4ae5-a927-7c837bd40de6" },
          { name: "Example Intro Skip", uuid: "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c" },
          { name: "BG3 In-Game Harness", uuid: "41d551b8-e0c1-4c12-8a29-1be03b5f9054" },
          { name: "Harness Example", uuid: "cd639062-7736-457d-aa6a-c364979b8921" },
        ],
        present: [],
      },
    };
    const catalog = createBg3TestScenarioCatalog({
      harnessModUuid: harnessMod.uuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: [],
      runtimeFixtures: [],
      scenarios: [discardScenario],
    });
    const events: string[] = [];
    const output: string[] = [];
    const wireTargets: unknown[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => {
        events.push("archive");
      },
      armRun: async (arm) => {
        wireTargets.push(arm);
        events.push(`arm:${arm.mode}:${arm.saveId}`);
      },
      cleanupRun: async () => {
        events.push("cleanup");
      },
      launchGame: async (saveId, _runId, mode) => {
        events.push(`launch:${saveId ?? "none"}:${mode}`);
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => {
        events.push("read-result");
        return JSON.stringify({
          schemaVersion: 2,
          runId: "run-discard-campaign",
          scenarioId: "example.discard-probe",
          status: "passed",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839202000,
          assertions: [{ id: "probe-ready", passed: true, message: "Probe evidence written" }],
        });
      },
      runId: () => "run-discard-campaign",
      terminateGame: async () => {
        events.push("terminate");
      },
      validateNewSave: async () => {
        events.push("validate-new-save");
        return "unexpected-save";
      },
      waitForClientReady: async () => {
        events.push("client-ready");
      },
      waitForModLoad: async (_runId, _scenarioId, mode) => {
        events.push(`mods-loaded:${mode}`);
      },
      waitForSaveLoaded: async () => {
        events.push("save-loaded");
      },
      writeCommand: async (command) => {
        wireTargets.push(command);
        events.push(`command:${command.mode}:${command.saveId}`);
      },
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(["--scenario", "example.discard-probe"], platform, catalog);

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "cleanup",
      "arm:character-creation:__new_campaign__",
      "command:character-creation:__new_campaign__",
      "launch:none:character-creation",
      "mods-loaded:character-creation",
      "client-ready",
      "read-result",
      "terminate",
      "archive",
      "cleanup",
    ]);
    expect(wireTargets).toHaveLength(2);
    for (const target of wireTargets) {
      expect(target).toMatchObject({
        mode: "character-creation",
        saveId: "__new_campaign__",
        savePolicy: "discard-campaign",
        requiredAssertionIds: ["probe-ready"],
      });
    }
    expect(output.some((line) => line.startsWith("SAVE "))).toBe(false);
    expect(output).toContain("PASS example.discard-probe");
  });

  it("runs an injected Second Hollow scenario without adding a runner branch", async () => {
    const secondScenario: Bg3TestScenarioDefinition = {
      id: "second.fixture",
      ownerModUuid: "7f712806-3674-421f-8e7b-dca469e545f5",
      savePolicy: "never",
      timeoutMs: 120_000,
      requiredAssertionIds: ["second-ready"],
      launch: { kind: "runtime", fixtureId: "second" },
    };
    const catalog = createBg3TestScenarioCatalog({
      harnessModUuid: harnessMod.uuid,
      protectedSaves: testProtectedSaves,
      allowedRuntimeSaveIds: ["harness-second__AutoSave_0"],
      runtimeFixtures: [
        {
          id: "second",
          saveId: "harness-second__AutoSave_0",
          expectedLsvSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
                name: "Example Content B",
                uuid: "7f712806-3674-421f-8e7b-dca469e545f5",
              },
            ],
            present: [],
          },
        },
      ],
      scenarios: [secondScenario],
    });
    const observed: unknown[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async (arm) => {
        observed.push(arm);
      },
      cleanupRun: async () => undefined,
      launchGame: async (saveId, _runId, mode) => {
        observed.push({ saveId, mode });
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => JSON.stringify({
        schemaVersion: 2,
        runId: "run-second",
        scenarioId: "second.fixture",
        status: "passed",
        startedAtEpochMs: 1787839201000,
        completedAtEpochMs: 1787839202000,
        assertions: [
          {
            id: "second-ready",
            passed: true,
            message: "Second fixture is ready",
          },
        ],
      }),
      runId: () => "run-second",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async (command) => {
        observed.push(command);
      },
      writeOutput: () => undefined,
    };

    await expect(
      runBg3Test(
        ["--scenario", "second.fixture"],
        platform,
        catalog,
      ),
    ).resolves.toBe(0);
    expect(observed).toContainEqual({
      saveId: "harness-second__AutoSave_0",
      mode: "runtime",
    });
    expect(observed).toContainEqual(expect.objectContaining({
      mode: "runtime",
      saveId: "harness-second__AutoSave_0",
    }));
    const wireTargets = observed.filter((value) =>
      typeof value === "object" &&
      value !== null &&
      "schemaVersion" in value
    );
    expect(wireTargets).toHaveLength(2);
    for (const target of wireTargets) {
      expect(target).toMatchObject({
        savePolicy: "never",
        requiredAssertionIds: ["second-ready"],
      });
    }
    expect(observed).not.toContainEqual(expect.objectContaining({
      creationPlan: expect.anything(),
    }));
  });

  it("reports an invalid mod load and closes BG3 before touching runtime UI", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => {
        events.push("archive");
      },
      armRun: async () => undefined,
      cleanupRun: async () => {
        events.push("cleanup");
      },
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "",
      runId: () => "run-missing-mods",
      terminateGame: async () => {
        events.push("terminate");
      },
      waitForModLoad: async () => {
        throw new Bg3TestProtocolError(
          "Required BG3 mod is not loaded: BG3 In-Game Harness (41d551b8-e0c1-4c12-8a29-1be03b5f9054)",
        );
      },
      waitForSaveLoaded: async () => {
        events.push("save-loaded");
      },
      writeCommand: async () => {
        events.push("write-command");
      },
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "ERROR invalid-mod-load: Required BG3 mod is not loaded: BG3 In-Game Harness (41d551b8-e0c1-4c12-8a29-1be03b5f9054)",
    );
    expect(events).toEqual([
      "cleanup",
      "terminate",
      "archive",
      "cleanup",
    ]);
  });

  it("rejects an explicit save for character creation", async () => {
    const output: string[] = [];
    let launched = false;
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => {
        launched = true;
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "",
      runId: () => "run-character-save-rejected",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      [
        "--scenario",
        "example.background-creation",
        "--save",
        "777-1000000000__AutoSave_0",
      ],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(2);
    expect(launched).toBe(false);
    expect(output).toContain(
      "ERROR save-not-allowed: Save is not allowed for automated tests: 777-1000000000__AutoSave_0",
    );
  });

  it("does not expose or validate a save when character creation fails", async () => {
    const output: string[] = [];
    let validated = false;
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () =>
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-character-failed",
          scenarioId: "example.background-creation",
          status: "failed",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839202000,
          assertions: [
            {
              id: "background",
              passed: false,
              message: "Example Background was not selected",
              expected: "Example Background",
              actual: "Acolyte",
            },
          ],
        }),
      runId: () => "run-character-failed",
      terminateGame: async () => undefined,
      validateNewSave: async () => {
        validated = true;
        return "harness-invalid__AutoSave_0";
      },
      waitForClientReady: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "example.background-creation"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(validated).toBe(false);
    expect(output.some((line) => line.startsWith("SAVE "))).toBe(false);
    expect(output).toContain(
      'FAIL background: Example Background was not selected (expected "Example Background", actual "Acolyte")',
    );
  });

  it("terminates BG3 and cleans the headless run when client readiness times out", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => {
        events.push("cleanup");
      },
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "",
      runId: () => "run-client-timeout",
      terminateGame: async (identity) => {
        events.push(`terminate:${identity.pid}:${identity.startTimeTicks}`);
      },
      waitForClientReady: async () => {
        throw new Bg3TestTimeoutError("Client readiness timed out");
      },
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "example.background-creation"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(events).toEqual([
      "cleanup",
      "terminate:4102:778899",
      "cleanup",
    ]);
    expect(output).toContain("ERROR timeout: Client readiness timed out");
  });

  it("rejects a stale result from another run", async () => {
    const output: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () =>
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-from-yesterday",
          scenarioId: "core.runtime-smoke",
          status: "passed",
          startedAtEpochMs: 1787752801000,
          completedAtEpochMs: 1787752802000,
          assertions: [],
        }),
      runId: () => "run-current",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "ERROR invalid-result: Result runId does not match active run",
    );
  });

  it("prints a structured scenario error", async () => {
    const output: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () =>
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-engine-error",
          scenarioId: "core.runtime-smoke",
          status: "error",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839201250,
          assertions: [],
          error: {
            code: "fixture-failed",
            message: "Could not create the resistant target",
          },
        }),
      runId: () => "run-engine-error",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "ERROR fixture-failed: Could not create the resistant target",
    );
    expect(output).toContain("TIME core.runtime-smoke: 250 ms");
  });

  it("cleans the run even when terminating BG3 fails", async () => {
    const events: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => {
        events.push("archive");
      },
      armRun: async () => undefined,
      cleanupRun: async () => {
        events.push("cleanup");
      },
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () =>
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-terminate-error",
          scenarioId: "core.runtime-smoke",
          status: "passed",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839202000,
          assertions: [],
        }),
      runId: () => "run-terminate-error",
      terminateGame: async () => {
        throw new Error("identity changed");
      },
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: () => undefined,
    };

    await expect(
      runBg3Test(["--scenario", "core.runtime-smoke"], platform, testCatalog),
    ).rejects.toThrow("identity changed");
    expect(events).toEqual(["cleanup", "archive", "cleanup"]);
  });

  it("rejects a passing result that contains a failed assertion", async () => {
    const output: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () =>
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-false-pass",
          scenarioId: "core.runtime-smoke",
          status: "passed",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839202000,
          assertions: [
            {
              id: "damage",
              passed: false,
              message: "Damage did not match",
            },
          ],
        }),
      runId: () => "run-false-pass",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "ERROR invalid-result: Passing result contains a failed assertion",
    );
  });

  it("rejects a passing result missing the scenario assertions", async () => {
    const output: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => JSON.stringify({
        schemaVersion: 2,
        runId: "run-empty-pass",
        scenarioId: "core.runtime-smoke",
        status: "passed",
        startedAtEpochMs: 1787839201000,
        completedAtEpochMs: 1787839202000,
        assertions: [],
      }),
      runId: () => "run-empty-pass",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    await expect(runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    )).resolves.toBe(1);
    expect(output).toContain(
      "ERROR invalid-result: Passing result is missing required assertions: host-entity, host-party-member",
    );
  });

  it("rejects an error result without structured error details", async () => {
    const output: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () =>
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-error-without-details",
          scenarioId: "core.runtime-smoke",
          status: "error",
          startedAtEpochMs: 1787839201000,
          completedAtEpochMs: 1787839202000,
          assertions: [],
        }),
      runId: () => "run-error-without-details",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "ERROR invalid-result: Error result requires structured error details",
    );
  });

  it("uses one global deadline across launch, load, and result", async () => {
    const times = [
      new Date("2026-08-27T14:00:00.000Z"),
      new Date("2026-08-27T14:01:00.000Z"),
      new Date("2026-08-27T14:02:00.000Z"),
      new Date("2026-08-27T14:03:00.000Z"),
    ];
    const observedTimeouts: number[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => ({ pid: 4102, startTimeTicks: "778899" }),
      now: () => {
        const next = times.shift();
        if (next === undefined) throw new Error("Unexpected clock read");
        return next;
      },
      readResult: async (_runId, timeoutMs) => {
        observedTimeouts.push(timeoutMs);
        return JSON.stringify({
          schemaVersion: 2,
          runId: "run-deadline",
          scenarioId: "core.runtime-smoke",
          status: "passed",
          startedAtEpochMs: 1787839320000,
          completedAtEpochMs: 1787839321000,
          assertions: [
            {
              id: "host-entity",
              passed: true,
              message: "The fixture host entity is loaded",
            },
            {
              id: "host-party-member",
              passed: true,
              message: "The fixture host belongs to the party",
            },
          ],
        });
      },
      runId: () => "run-deadline",
      terminateGame: async () => undefined,
      waitForModLoad: async (_runId, _scenarioId, _mode, timeoutMs) => {
        observedTimeouts.push(timeoutMs);
      },
      waitForSaveLoaded: async (_saveId, _launchedAt, timeoutMs) => {
        observedTimeouts.push(timeoutMs);
      },
      writeCommand: async () => undefined,
      writeOutput: () => undefined,
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
    );

    expect(exitCode).toBe(0);
    expect(observedTimeouts).toEqual([120_000, 240_000, 180_000]);
  });

  it("does not launch when the run is already interrupted", async () => {
    const controller = new AbortController();
    controller.abort("SIGINT");
    const output: string[] = [];
    let launched = false;
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => undefined,
      armRun: async () => undefined,
      cleanupRun: async () => undefined,
      launchGame: async () => {
        launched = true;
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "",
      runId: () => "run-interrupted",
      terminateGame: async () => undefined,
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    const exitCode = await runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
      controller.signal,
    );

    expect(exitCode).toBe(130);
    expect(launched).toBe(false);
    expect(output).toContain("ERROR interrupted: BG3 test interrupted by SIGINT");
  });

  it("archives an interruption that happens after the run is armed", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const output: string[] = [];
    const platform: Bg3TestPlatform = {
      archiveRunArtifacts: async () => {
        events.push("archive");
      },
      armRun: async () => {
        events.push("arm");
      },
      cleanupRun: async () => {
        events.push("cleanup");
      },
      launchGame: async () => {
        events.push("launch");
        controller.abort("SIGTERM");
        return { pid: 4102, startTimeTicks: "778899" };
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      readResult: async () => "",
      runId: () => "run-interrupted-after-arm",
      terminateGame: async () => {
        events.push("terminate");
      },
      waitForModLoad: async () => undefined,
      waitForSaveLoaded: async () => undefined,
      writeCommand: async () => undefined,
      writeOutput: (line) => output.push(line),
    };

    await expect(runBg3Test(
      ["--scenario", "core.runtime-smoke"],
      platform,
      testCatalog,
      controller.signal,
    )).resolves.toBe(130);
    expect(events).toEqual([
      "cleanup",
      "arm",
      "launch",
      "terminate",
      "archive",
      "cleanup",
    ]);
    expect(output).toContain(
      "ERROR interrupted: BG3 test interrupted by SIGTERM",
    );
  });
});
