import {
  Bg3TestInterruptedError,
  Bg3TestTimeoutError,
  type Bg3TestPlatform,
  type Bg3TestDisplayMode,
} from "./platform.js";
import {
  BG3_TEST_PROTOCOL_VERSION,
  Bg3TestProtocolError,
  parseBg3TestResult,
  type Bg3TestArm,
  type Bg3TestCommand,
} from "./protocol.js";
import {
  isBg3CreationSavePolicy,
  scenarioMode,
  scenarioSaveId,
  type Bg3TestScenario,
  type Bg3TestScenarioCatalog,
} from "./scenario-catalog.js";

const modLoadTimeoutMs = 120_000;
const saveArtifactValidationTimeoutMs = 5_000;

export function bg3DisplayFromArguments(arguments_: readonly string[], defaultDisplay: Bg3TestDisplayMode = "headless"): Bg3TestDisplayMode {
  const flags = arguments_.filter((argument) => argument === "--display" || argument.startsWith("--display="));
  if (flags.length === 0) return defaultDisplay;
  if (flags.length !== 1 || flags[0] !== "--display") {
    throw new Error("Use --display headless or --display visible exactly once");
  }
  const value = arguments_[arguments_.indexOf("--display") + 1];
  if (value !== "headless" && value !== "visible") {
    throw new Error(`Invalid BG3 display mode: ${value ?? "<missing>"}`);
  }
  return value;
}

function interruptionMessage(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason !== ""
    ? `BG3 test interrupted by ${signal.reason}`
    : "BG3 test interrupted";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Bg3TestInterruptedError(interruptionMessage(signal));
  }
}

function assertionDetails(assertion: {
  expected?: string;
  actual?: string;
}): string {
  const values = [
    assertion.expected === undefined
      ? undefined
      : `expected ${JSON.stringify(assertion.expected)}`,
    assertion.actual === undefined
      ? undefined
      : `actual ${JSON.stringify(assertion.actual)}`,
  ].filter((value): value is string => value !== undefined);
  return values.length === 0 ? "" : ` (${values.join(", ")})`;
}

function scenarioFromArguments(
  arguments_: readonly string[],
  catalog: Bg3TestScenarioCatalog,
): Bg3TestScenario {
  const scenarioIndex = arguments_.indexOf("--scenario");
  const scenarioId =
    scenarioIndex >= 0 ? arguments_[scenarioIndex + 1] : undefined;
  const scenario = scenarioId === undefined
    ? undefined
    : catalog.get(scenarioId);
  if (scenario === undefined) {
    throw new Error(`Unknown BG3 test scenario: ${scenarioId ?? "<missing>"}`);
  }
  return scenario;
}

function wireTarget(scenario: Bg3TestScenario) {
  if (scenario.launch.kind === "runtime") {
    if (scenario.savePolicy !== "never") {
      throw new Error(`Runtime scenario ${scenario.id} has an unsafe save policy`);
    }
    return {
      mode: "runtime" as const,
      saveId: scenario.launch.fixture.saveId,
      savePolicy: scenario.savePolicy,
      requiredAssertionIds: scenario.requiredAssertionIds,
    };
  }
  if (!isBg3CreationSavePolicy(scenario.savePolicy)) {
    throw new Error(
      `Character-creation scenario ${scenario.id} has an unsafe save policy`,
    );
  }
  return {
    mode: "character-creation" as const,
    saveId: "__new_campaign__" as const,
    savePolicy: scenario.savePolicy,
    requiredAssertionIds: scenario.requiredAssertionIds,
    creationPlan: scenario.launch.creationPlan,
  };
}

function throwFinalizationErrors(
  primaryError: unknown,
  finalizationErrors: readonly unknown[],
): void {
  if (primaryError !== undefined && finalizationErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...finalizationErrors],
      "BG3 test failed and run finalization also failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (finalizationErrors.length === 1) throw finalizationErrors[0];
  if (finalizationErrors.length > 1) {
    throw new AggregateError(
      finalizationErrors,
      "Multiple BG3 run finalization operations failed",
    );
  }
}

export async function runBg3Test(
  arguments_: readonly string[],
  platform: Bg3TestPlatform,
  catalog: Bg3TestScenarioCatalog,
  signal?: AbortSignal,
): Promise<number> {
  let scenario: Bg3TestScenario;
  try {
    scenario = scenarioFromArguments(arguments_, catalog);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    platform.writeOutput(`ERROR unknown-scenario: ${message}`);
    return 2;
  }

  const saveIndex = arguments_.indexOf("--save");
  let display: Bg3TestDisplayMode;
  try {
    const needsPointer = scenario.pointer !== undefined;
    display = bg3DisplayFromArguments(arguments_, needsPointer ? "visible" : "headless");
    if (needsPointer && display !== "visible") throw new Error("Native pointer scenarios require --display visible");
  } catch (error) {
    platform.writeOutput(`ERROR invalid-display: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const catalogSaveId = scenarioSaveId(scenario);
  const requestedSaveId = saveIndex >= 0
    ? arguments_[saveIndex + 1]
    : catalogSaveId;
  const saveAllowed = scenario.launch.kind === "runtime"
    ? requestedSaveId === catalogSaveId
    : saveIndex < 0 && requestedSaveId === catalogSaveId;
  if (requestedSaveId === undefined || !saveAllowed) {
    platform.writeOutput(
      `ERROR save-not-allowed: Save is not allowed for automated tests: ${requestedSaveId ?? "<missing>"}`,
    );
    return 2;
  }
  if (signal?.aborted === true) {
    platform.writeOutput(`ERROR interrupted: ${interruptionMessage(signal)}`);
    return 130;
  }

  const runId = platform.runId();
  const launchRequestedAt = platform.now();
  const armExpiresAtEpochMs = launchRequestedAt.getTime() + scenario.timeoutMs;
  const arm: Bg3TestArm = {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId,
    scenarioId: scenario.id,
    ...wireTarget(scenario),
    createdAt: launchRequestedAt.toISOString(),
    expiresAt: new Date(armExpiresAtEpochMs).toISOString(),
    createdAtEpochMs: launchRequestedAt.getTime(),
    expiresAtEpochMs: armExpiresAtEpochMs,
    timeoutMs: scenario.timeoutMs,
  };

  let launchedGame: Awaited<ReturnType<Bg3TestPlatform["launchGame"]>> | undefined;
  let armed = false;
  let shouldArchive = false;
  let exitCode: number | undefined;
  let primaryError: unknown;

  const execute = async (): Promise<number> => {
    let resultTimeoutMs = 0;
    await platform.cleanupRun(runId);
    await platform.armRun(arm);
    armed = true;
    throwIfAborted(signal);

    if (scenario.launch.kind === "character-creation") {
      const commandCreatedAt = platform.now();
      const commandTimeoutMs = armExpiresAtEpochMs - commandCreatedAt.getTime();
      if (commandTimeoutMs <= 0) {
        throw new Bg3TestTimeoutError(
          `Timed out after ${scenario.timeoutMs} ms before sending the scenario command`,
        );
      }
      const command: Bg3TestCommand = {
        schemaVersion: BG3_TEST_PROTOCOL_VERSION,
        runId,
        scenarioId: scenario.id,
        ...wireTarget(scenario),
        createdAt: commandCreatedAt.toISOString(),
        expiresAt: new Date(armExpiresAtEpochMs).toISOString(),
        createdAtEpochMs: commandCreatedAt.getTime(),
        expiresAtEpochMs: armExpiresAtEpochMs,
        timeoutMs: commandTimeoutMs,
      };
      await platform.writeCommand(command);
      throwIfAborted(signal);
      launchedGame = await platform.launchGame(
        undefined,
        runId,
        scenarioMode(scenario),
        display,
      );
    } else {
      launchedGame = await platform.launchGame(
        requestedSaveId,
        runId,
        scenarioMode(scenario),
        display,
      );
    }

    throwIfAborted(signal);
    const modLoadRemainingMs = armExpiresAtEpochMs - platform.now().getTime();
    if (modLoadRemainingMs <= 0) {
      throw new Bg3TestTimeoutError(
        `Timed out after ${scenario.timeoutMs} ms before verifying required BG3 mods`,
      );
    }
    try {
      await platform.waitForModLoad(
        runId,
        scenario.id,
        scenarioMode(scenario),
        Math.min(modLoadTimeoutMs, modLoadRemainingMs),
      );
    } catch (error) {
      if (error instanceof Bg3TestProtocolError) {
        shouldArchive = true;
        platform.writeOutput(`ERROR invalid-mod-load: ${error.message}`);
        return 1;
      }
      throw error;
    }
    platform.writeOutput("PASS mods-loaded: Required BG3 mods are loaded in order");
    throwIfAborted(signal);

    if (scenario.launch.kind === "character-creation") {
      const readyTimeoutMs = armExpiresAtEpochMs - platform.now().getTime();
      if (readyTimeoutMs <= 0) {
        throw new Bg3TestTimeoutError(
          `Timed out after ${scenario.timeoutMs} ms before the character-creation client became ready`,
        );
      }
      if (platform.waitForClientReady === undefined) {
        throw new Error(
          "BG3 platform cannot observe character-creation client readiness",
        );
      }
      await platform.waitForClientReady(runId, scenario.id, readyTimeoutMs);
      resultTimeoutMs = armExpiresAtEpochMs - platform.now().getTime();
      if (resultTimeoutMs <= 0) {
        throw new Bg3TestTimeoutError(
          `Timed out after ${scenario.timeoutMs} ms before reading the scenario result`,
        );
      }
    } else {
      const loadStartedAt = platform.now();
      const loadTimeoutMs = armExpiresAtEpochMs - loadStartedAt.getTime();
      if (loadTimeoutMs <= 0) {
        throw new Bg3TestTimeoutError(
          `Timed out after ${scenario.timeoutMs} ms before verifying the loaded save`,
        );
      }
      await platform.waitForSaveLoaded(
        requestedSaveId,
        launchRequestedAt,
        loadTimeoutMs,
      );
      throwIfAborted(signal);
      const commandCreatedAt = platform.now();
      const commandTimeoutMs = armExpiresAtEpochMs - commandCreatedAt.getTime();
      if (commandTimeoutMs <= 0) {
        throw new Bg3TestTimeoutError(
          `Timed out after ${scenario.timeoutMs} ms before sending the scenario command`,
        );
      }
      const command: Bg3TestCommand = {
        schemaVersion: BG3_TEST_PROTOCOL_VERSION,
        runId,
        scenarioId: scenario.id,
        ...wireTarget(scenario),
        createdAt: commandCreatedAt.toISOString(),
        expiresAt: new Date(armExpiresAtEpochMs).toISOString(),
        createdAtEpochMs: commandCreatedAt.getTime(),
        expiresAtEpochMs: armExpiresAtEpochMs,
        timeoutMs: commandTimeoutMs,
      };
      await platform.writeCommand(command);
      resultTimeoutMs = commandTimeoutMs;
    }

    let result;
    try {
      result = parseBg3TestResult(
        await platform.readResult(runId, resultTimeoutMs),
        {
          runId,
          scenarioId: scenario.id,
          createdAtEpochMs: arm.createdAtEpochMs,
          expiresAtEpochMs: arm.expiresAtEpochMs,
        },
      );
    } catch (error) {
      if (error instanceof Bg3TestProtocolError) {
        shouldArchive = true;
        platform.writeOutput(`ERROR invalid-result: ${error.message}`);
        return 1;
      }
      throw error;
    }

    if (result.status === "passed") {
      const assertionIds = new Set(
        result.assertions.map((assertion) => assertion.id),
      );
      const missingAssertionIds = scenario.requiredAssertionIds.filter(
        (assertionId) => !assertionIds.has(assertionId),
      );
      if (missingAssertionIds.length > 0) {
        shouldArchive = true;
        platform.writeOutput(
          `ERROR invalid-result: Passing result is missing required assertions: ${missingAssertionIds.join(", ")}`,
        );
        return 1;
      }
    }

    for (const assertion of result.assertions) {
      platform.writeOutput(
        `${assertion.passed ? "PASS" : "FAIL"} ${assertion.id}: ${assertion.message}${assertionDetails(assertion)}`,
      );
    }
    if (result.error !== undefined) {
      platform.writeOutput(`ERROR ${result.error.code}: ${result.error.message}`);
    }
    platform.writeOutput(
      `TIME ${scenario.id}: ${result.completedAtEpochMs - result.startedAtEpochMs} ms`,
    );
    if (
      scenario.launch.kind === "character-creation" &&
      scenario.savePolicy === "create-test-fixture" &&
      result.status === "passed"
    ) {
      if (platform.validateNewSave === undefined) {
        throw new Error("BG3 platform cannot validate a newly created save");
      }
      const saveTimeoutMs = Math.max(
        saveArtifactValidationTimeoutMs,
        armExpiresAtEpochMs - platform.now().getTime(),
      );
      const newSaveId = await platform.validateNewSave(runId, saveTimeoutMs);
      platform.writeOutput(`SAVE ${newSaveId}`);
    }
    platform.writeOutput(
      `${result.status === "passed" ? "PASS" : "FAIL"} ${scenario.id}`,
    );
    shouldArchive = true;
    return result.status === "passed" ? 0 : 1;
  };

  try {
    exitCode = await execute();
  } catch (error) {
    if (armed) shouldArchive = true;
    if (error instanceof Bg3TestInterruptedError) {
      platform.writeOutput(`ERROR interrupted: ${error.message}`);
      exitCode = 130;
    } else if (error instanceof Bg3TestTimeoutError) {
      platform.writeOutput(`ERROR timeout: ${error.message}`);
      exitCode = 1;
    } else {
      primaryError = error;
    }
  }

  const finalizationErrors: unknown[] = [];
  if (launchedGame !== undefined) {
    try {
      await platform.terminateGame(launchedGame);
    } catch (error) {
      shouldArchive = armed;
      finalizationErrors.push(error);
    }
  }
  if (armed && shouldArchive) {
    try {
      await platform.archiveRunArtifacts(runId);
    } catch (error) {
      finalizationErrors.push(error);
    }
  }
  try {
    await platform.cleanupRun(runId);
  } catch (error) {
    finalizationErrors.push(error);
  }

  throwFinalizationErrors(primaryError, finalizationErrors);
  if (exitCode === undefined) {
    throw new Error("BG3 test finished without an exit code");
  }
  return exitCode;
}
