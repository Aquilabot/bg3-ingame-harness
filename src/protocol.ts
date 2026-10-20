import type {
  Bg3CharacterCreationPlan,
  Bg3RequiredMod,
  Bg3RequiredMods,
} from "./scenario-catalog.js";

export const BG3_TEST_PROTOCOL_VERSION = 2 as const;
export const BG3_NEW_CAMPAIGN_SAVE_ID = "__new_campaign__" as const;

export type Bg3TestMode = "runtime" | "character-creation";

interface Bg3TestWireTargetBase {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  createdAt: string;
  expiresAt: string;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  timeoutMs: number;
  requiredAssertionIds: readonly string[];
}

type Bg3TestWireTarget =
  | {
      mode: "runtime";
      saveId: string;
      savePolicy: "never";
      creationPlan?: never;
    }
  | {
      mode: "character-creation";
      saveId: typeof BG3_NEW_CAMPAIGN_SAVE_ID;
      // discard-campaign plays the new campaign and closes BG3 without any save.
      savePolicy: "create-test-fixture" | "discard-campaign";
      creationPlan: Bg3CharacterCreationPlan;
    };

export type Bg3TestCommand = Bg3TestWireTargetBase & Bg3TestWireTarget;
export type Bg3TestArm = Bg3TestWireTargetBase & Bg3TestWireTarget;

export interface Bg3TestAssertion {
  id: string;
  passed: boolean;
  message: string;
  expected?: string;
  actual?: string;
}

export interface Bg3TestError {
  code: string;
  message: string;
}

export interface Bg3TestResult {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "passed" | "failed" | "error";
  startedAtEpochMs: number;
  completedAtEpochMs: number;
  assertions: Bg3TestAssertion[];
  error?: Bg3TestError;
}

export interface Bg3TestClientReady {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "ready";
  readyAtEpochMs: number;
}

export interface Bg3TestModLoad {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "observed";
  observedAtEpochMs: number;
  loadOrder: string[];
}

export interface Bg3ServerReady {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "ready";
  readyAtEpochMs: number;
}

export interface Bg3AutosaveGuard {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "suppressed";
  suppressedAtEpochMs: number;
}

export interface Bg3ServerFinalizing {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "finalizing";
  finalizingAtEpochMs: number;
}

export interface Bg3SaveIntent {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "intent";
  intentId: string;
  intentAtEpochMs: number;
}

export interface Bg3SaveIntentAck {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "acknowledged";
  intentId: string;
  acknowledgedAtEpochMs: number;
}

export interface Bg3SaveRequest {
  schemaVersion: typeof BG3_TEST_PROTOCOL_VERSION;
  runId: string;
  scenarioId: string;
  status: "requested";
  intentId: string;
  requestedAtEpochMs: number;
}

export class Bg3TestProtocolError extends Error {
  override readonly name = "Bg3TestProtocolError";
}

interface ExpectedRunMessage {
  runId: string;
  scenarioId: string;
  createdAtEpochMs?: number;
  expiresAtEpochMs?: number;
}

const SAFE_INTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function parseStrictArtifact(
  raw: string,
  expected: ExpectedRunMessage,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Bg3TestProtocolError(`${label} is not valid JSON`);
  }
  if (!isRecord(value)) {
    throw new Bg3TestProtocolError(`${label} must be a JSON object`);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Bg3TestProtocolError(`${label} contains unexpected fields`);
  }
  if (value.schemaVersion !== BG3_TEST_PROTOCOL_VERSION) {
    throw new Bg3TestProtocolError(
      `${label} has unsupported schema version ${String(value.schemaVersion)}`,
    );
  }
  const runId = requireString(value, "runId", 80);
  if (runId !== expected.runId) {
    throw new Bg3TestProtocolError(
      `${label} runId does not match active run`,
    );
  }
  const scenarioId = requireString(value, "scenarioId", 100);
  if (scenarioId !== expected.scenarioId) {
    throw new Bg3TestProtocolError(
      `${label} scenarioId does not match requested scenario`,
    );
  }
  return value;
}

function requireArtifactTimestamp(
  value: Record<string, unknown>,
  key: string,
  label: string,
  expected: ExpectedRunMessage,
): number {
  const timestamp = requireEpochMilliseconds(value, key);
  requireTimestampInRunWindow(timestamp, label, expected);
  return timestamp;
}

function requireIntentId(
  value: Record<string, unknown>,
  label: string,
): string {
  const intentId = requireString(value, "intentId", 100);
  if (!SAFE_INTENT_ID_PATTERN.test(intentId)) {
    throw new Bg3TestProtocolError(`${label} has an invalid intentId`);
  }
  return intentId;
}

function requireTimestampInRunWindow(
  timestamp: number,
  label: string,
  expected: ExpectedRunMessage,
): void {
  if (
    expected.createdAtEpochMs !== undefined &&
    timestamp < expected.createdAtEpochMs
  ) {
    throw new Bg3TestProtocolError(`${label} predates the active run`);
  }
  if (
    expected.expiresAtEpochMs !== undefined &&
    timestamp > expected.expiresAtEpochMs
  ) {
    throw new Bg3TestProtocolError(`${label} exceeds the active run deadline`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  maximumLength = 4_000,
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maximumLength
  ) {
    throw new Bg3TestProtocolError(`Result requires a non-empty ${key}`);
  }
  return value;
}

function requireFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Bg3TestProtocolError(`Result requires a finite ${key}`);
  }
  return value;
}

function requireEpochMilliseconds(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = requireFiniteNumber(record, key);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Bg3TestProtocolError(
      `Result requires a non-negative integer ${key}`,
    );
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Bg3TestProtocolError(`Result ${key} must be a string`);
  }
  return value;
}

function parseAssertion(value: unknown): Bg3TestAssertion {
  if (!isRecord(value)) {
    throw new Bg3TestProtocolError("Result assertions must be objects");
  }
  if (typeof value.passed !== "boolean") {
    throw new Bg3TestProtocolError("Result assertion passed must be a boolean");
  }

  const expected = optionalString(value, "expected");
  const actual = optionalString(value, "actual");
  return {
    id: requireString(value, "id", 100),
    passed: value.passed,
    message: requireString(value, "message", 4_000),
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireLoadedMod(
  positions: ReadonlyMap<string, number>,
  mod: Bg3RequiredMod,
): number {
  const position = positions.get(mod.uuid.toLowerCase());
  if (position === undefined) {
    throw new Bg3TestProtocolError(
      `Required BG3 mod is not loaded: ${mod.name} (${mod.uuid})`,
    );
  }
  return position;
}

export function parseBg3ServerReady(
  raw: string,
  expected: ExpectedRunMessage,
): Bg3ServerReady {
  const label = "Server readiness";
  const value = parseStrictArtifact(raw, expected, label, [
    "schemaVersion",
    "runId",
    "scenarioId",
    "status",
    "readyAtEpochMs",
  ]);
  if (value.status !== "ready") {
    throw new Bg3TestProtocolError("Server readiness status must be ready");
  }
  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId: expected.runId,
    scenarioId: expected.scenarioId,
    status: "ready",
    readyAtEpochMs: requireArtifactTimestamp(
      value,
      "readyAtEpochMs",
      label,
      expected,
    ),
  };
}

export function parseBg3AutosaveGuard(
  raw: string,
  expected: ExpectedRunMessage,
): Bg3AutosaveGuard {
  const label = "Autosave guard";
  const value = parseStrictArtifact(raw, expected, label, [
    "schemaVersion",
    "runId",
    "scenarioId",
    "status",
    "suppressedAtEpochMs",
  ]);
  if (value.status !== "suppressed") {
    throw new Bg3TestProtocolError(
      "Autosave guard status must be suppressed",
    );
  }
  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId: expected.runId,
    scenarioId: expected.scenarioId,
    status: "suppressed",
    suppressedAtEpochMs: requireArtifactTimestamp(
      value,
      "suppressedAtEpochMs",
      label,
      expected,
    ),
  };
}

export function parseBg3ServerFinalizing(
  raw: string,
  expected: ExpectedRunMessage,
): Bg3ServerFinalizing {
  const label = "Server finalizing";
  const value = parseStrictArtifact(raw, expected, label, [
    "schemaVersion",
    "runId",
    "scenarioId",
    "status",
    "finalizingAtEpochMs",
  ]);
  if (value.status !== "finalizing") {
    throw new Bg3TestProtocolError(
      "Server finalizing status must be finalizing",
    );
  }
  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId: expected.runId,
    scenarioId: expected.scenarioId,
    status: "finalizing",
    finalizingAtEpochMs: requireArtifactTimestamp(
      value,
      "finalizingAtEpochMs",
      label,
      expected,
    ),
  };
}

export function parseBg3SaveIntent(
  raw: string,
  expected: ExpectedRunMessage,
): Bg3SaveIntent {
  const label = "Save intent";
  const value = parseStrictArtifact(raw, expected, label, [
    "schemaVersion",
    "runId",
    "scenarioId",
    "status",
    "intentId",
    "intentAtEpochMs",
  ]);
  if (value.status !== "intent") {
    throw new Bg3TestProtocolError("Save intent status must be intent");
  }
  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId: expected.runId,
    scenarioId: expected.scenarioId,
    status: "intent",
    intentId: requireIntentId(value, label),
    intentAtEpochMs: requireArtifactTimestamp(
      value,
      "intentAtEpochMs",
      label,
      expected,
    ),
  };
}

export function parseBg3SaveIntentAck(
  raw: string,
  expected: ExpectedRunMessage,
): Bg3SaveIntentAck {
  const label = "Save intent acknowledgement";
  const value = parseStrictArtifact(raw, expected, label, [
    "schemaVersion",
    "runId",
    "scenarioId",
    "status",
    "intentId",
    "acknowledgedAtEpochMs",
  ]);
  if (value.status !== "acknowledged") {
    throw new Bg3TestProtocolError(
      "Save intent acknowledgement status must be acknowledged",
    );
  }
  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId: expected.runId,
    scenarioId: expected.scenarioId,
    status: "acknowledged",
    intentId: requireIntentId(value, label),
    acknowledgedAtEpochMs: requireArtifactTimestamp(
      value,
      "acknowledgedAtEpochMs",
      label,
      expected,
    ),
  };
}

export function parseBg3SaveRequest(
  raw: string,
  expected: ExpectedRunMessage,
): Bg3SaveRequest {
  const label = "Save request";
  const value = parseStrictArtifact(raw, expected, label, [
    "schemaVersion",
    "runId",
    "scenarioId",
    "status",
    "intentId",
    "requestedAtEpochMs",
  ]);
  if (value.status !== "requested") {
    throw new Bg3TestProtocolError("Save request status must be requested");
  }
  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId: expected.runId,
    scenarioId: expected.scenarioId,
    status: "requested",
    intentId: requireIntentId(value, label),
    requestedAtEpochMs: requireArtifactTimestamp(
      value,
      "requestedAtEpochMs",
      label,
      expected,
    ),
  };
}

export function parseBg3TestModLoad(
  raw: string,
  expected: ExpectedRunMessage,
  requiredMods: Bg3RequiredMods,
): Bg3TestModLoad {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Bg3TestProtocolError(
      "Script Extender returned invalid mod-load JSON",
    );
  }
  if (!isRecord(value)) {
    throw new Bg3TestProtocolError(
      "Mod-load observation must be a JSON object",
    );
  }
  if (value.schemaVersion !== BG3_TEST_PROTOCOL_VERSION) {
    throw new Bg3TestProtocolError(
      `Unsupported mod-load schema version: ${String(value.schemaVersion)}`,
    );
  }
  const runId = requireString(value, "runId", 80);
  if (runId !== expected.runId) {
    throw new Bg3TestProtocolError(
      "Mod-load observation runId does not match active run",
    );
  }
  const scenarioId = requireString(value, "scenarioId", 100);
  if (scenarioId !== expected.scenarioId) {
    throw new Bg3TestProtocolError(
      "Mod-load observation scenarioId does not match requested scenario",
    );
  }
  if (value.status !== "observed") {
    throw new Bg3TestProtocolError(
      "Mod-load observation status must be observed",
    );
  }
  if (!Array.isArray(value.loadOrder)) {
    throw new Bg3TestProtocolError(
      "Mod-load observation loadOrder must be an array",
    );
  }
  if (value.loadOrder.length > 4_096) {
    throw new Bg3TestProtocolError(
      "Mod-load observation contains too many modules",
    );
  }

  const loadOrder = value.loadOrder.map((uuid) => {
    if (typeof uuid !== "string" || !UUID_PATTERN.test(uuid)) {
      throw new Bg3TestProtocolError(
        `Mod-load observation contains an invalid UUID: ${String(uuid)}`,
      );
    }
    return uuid.toLowerCase();
  });
  const positions = new Map<string, number>();
  for (const [index, uuid] of loadOrder.entries()) {
    if (positions.has(uuid)) {
      throw new Bg3TestProtocolError(
        `Mod-load observation contains a duplicate UUID: ${uuid}`,
      );
    }
    positions.set(uuid, index);
  }

  const requiredPositions = requiredMods.ordered.map((mod) =>
    requireLoadedMod(positions, mod)
  );
  for (const mod of requiredMods.present) {
    requireLoadedMod(positions, mod);
  }
  for (let index = 1; index < requiredPositions.length; index += 1) {
    const previousPosition = requiredPositions[index - 1];
    const currentPosition = requiredPositions[index];
    if (
      previousPosition !== undefined &&
      currentPosition !== undefined &&
      previousPosition > currentPosition
    ) {
      const previousMod = requiredMods.ordered[index - 1];
      const currentMod = requiredMods.ordered[index];
      if (previousMod !== undefined && currentMod !== undefined) {
        throw new Bg3TestProtocolError(
          `Required BG3 mods are out of order: ${previousMod.name} must load before ${currentMod.name}`,
        );
      }
    }
  }

  const observedAtEpochMs = requireEpochMilliseconds(
    value,
    "observedAtEpochMs",
  );
  requireTimestampInRunWindow(
    observedAtEpochMs,
    "Mod-load observation",
    expected,
  );
  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId,
    scenarioId,
    status: "observed",
    observedAtEpochMs,
    loadOrder,
  };
}

export function parseBg3TestClientReady(
  raw: string,
  expected: ExpectedRunMessage & { mode: "character-creation" },
): Bg3TestClientReady {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Bg3TestProtocolError(
      "Script Extender returned invalid client readiness JSON",
    );
  }
  if (!isRecord(value)) {
    throw new Bg3TestProtocolError("Client readiness must be a JSON object");
  }
  if (value.schemaVersion !== BG3_TEST_PROTOCOL_VERSION) {
    throw new Bg3TestProtocolError(
      `Unsupported client readiness schema version: ${String(value.schemaVersion)}`,
    );
  }
  const runId = requireString(value, "runId", 80);
  if (runId !== expected.runId) {
    throw new Bg3TestProtocolError(
      "Client readiness runId does not match active run",
    );
  }
  const scenarioId = requireString(value, "scenarioId", 100);
  if (scenarioId !== expected.scenarioId) {
    throw new Bg3TestProtocolError(
      "Client readiness scenarioId does not match requested scenario",
    );
  }
  if (value.status !== "ready") {
    throw new Bg3TestProtocolError("Client readiness status must be ready");
  }

  const readyAtEpochMs = requireEpochMilliseconds(value, "readyAtEpochMs");
  requireTimestampInRunWindow(readyAtEpochMs, "Client readiness", expected);
  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId,
    scenarioId,
    status: "ready",
    readyAtEpochMs,
  };
}

export function parseBg3TestResult(
  raw: string,
  expected: ExpectedRunMessage,
): Bg3TestResult {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Bg3TestProtocolError(
      "Script Extender returned invalid JSON",
    );
  }

  if (!isRecord(value)) {
    throw new Bg3TestProtocolError("Result must be a JSON object");
  }
  if (value.schemaVersion !== BG3_TEST_PROTOCOL_VERSION) {
    throw new Bg3TestProtocolError(
      `Unsupported result schema version: ${String(value.schemaVersion)}`,
    );
  }

  const runId = requireString(value, "runId", 80);
  if (runId !== expected.runId) {
    throw new Bg3TestProtocolError("Result runId does not match active run");
  }
  const scenarioId = requireString(value, "scenarioId", 100);
  if (scenarioId !== expected.scenarioId) {
    throw new Bg3TestProtocolError(
      "Result scenarioId does not match requested scenario",
    );
  }
  if (
    value.status !== "passed" &&
    value.status !== "failed" &&
    value.status !== "error"
  ) {
    throw new Bg3TestProtocolError("Result has an invalid status");
  }
  if (!Array.isArray(value.assertions)) {
    throw new Bg3TestProtocolError("Result assertions must be an array");
  }
  if (value.assertions.length > 4_096) {
    throw new Bg3TestProtocolError("Result contains too many assertions");
  }

  const startedAtEpochMs = requireEpochMilliseconds(value, "startedAtEpochMs");
  const completedAtEpochMs = requireEpochMilliseconds(value, "completedAtEpochMs");
  if (completedAtEpochMs < startedAtEpochMs) {
    throw new Bg3TestProtocolError(
      "Result completedAtEpochMs precedes startedAtEpochMs",
    );
  }
  requireTimestampInRunWindow(startedAtEpochMs, "Result start", expected);
  requireTimestampInRunWindow(completedAtEpochMs, "Result completion", expected);

  let resultError: Bg3TestError | undefined;
  if (value.error !== undefined) {
    if (!isRecord(value.error)) {
      throw new Bg3TestProtocolError("Result error must be an object");
    }
    resultError = {
      code: requireString(value.error, "code", 100),
      message: requireString(value.error, "message", 4_000),
    };
  }

  const assertions = value.assertions.map(parseAssertion);
  const assertionIds = new Set(assertions.map((assertion) => assertion.id));
  if (assertionIds.size !== assertions.length) {
    throw new Bg3TestProtocolError(
      "Result assertion identifiers must be unique",
    );
  }
  if (
    value.status === "passed" &&
    assertions.some((assertion) => !assertion.passed)
  ) {
    throw new Bg3TestProtocolError(
      "Passing result contains a failed assertion",
    );
  }
  if (value.status === "error" && resultError === undefined) {
    throw new Bg3TestProtocolError(
      "Error result requires structured error details",
    );
  }
  if (value.status !== "error" && resultError !== undefined) {
    throw new Bg3TestProtocolError(
      "Only error results may contain structured error details",
    );
  }
  if (
    value.status === "failed" &&
    !assertions.some((assertion) => !assertion.passed)
  ) {
    throw new Bg3TestProtocolError(
      "Failed result requires a failed assertion",
    );
  }

  return {
    schemaVersion: BG3_TEST_PROTOCOL_VERSION,
    runId,
    scenarioId,
    status: value.status,
    startedAtEpochMs,
    completedAtEpochMs,
    assertions,
    ...(resultError === undefined ? {} : { error: resultError }),
  };
}
