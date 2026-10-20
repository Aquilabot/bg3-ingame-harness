import { Bg3TestProtocolError, type Bg3TestArm, type Bg3TestCommand } from "./protocol.js";
import type { Bg3PointerPolicy } from "./scenario-catalog.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALPHABET = "ABCDEFGHJKLMNPQR";
/** Prefix of the OCR label the client renders over the target. Must match HarnessTargetLabel.lua and bg3-pointer.py. */
export const BG3_POINTER_LABEL_PREFIX = "HNX";

export function targetPointerLabel(targetUuid: string): string {
  if (!UUID.test(targetUuid)) throw new Bg3TestProtocolError("Pointer target UUID is invalid");
  return BG3_POINTER_LABEL_PREFIX + [...targetUuid.slice(0, 8)].map((hex) => ALPHABET[Number.parseInt(hex, 16)]).join("");
}

export interface Bg3PointerRequest {
  schemaVersion: 2;
  runId: string;
  scenarioId: string;
  stepId: string;
  sequence: number;
  operation: string;
  casterUuid: string;
  targetUuid: string;
  spellId: string;
  castGuid: string;
  phase: "hover" | "leave";
  targetLabel: string;
  viewport: [number, number];
  observedAtEpochMs: number;
  expiresAtEpochMs: number;
  entries: Array<{ uuid: string; objectType: string }>;
}

const identityKeys = ["runId", "scenarioId", "stepId", "sequence", "operation", "casterUuid", "targetUuid", "spellId", "castGuid", "targetLabel"] as const;

function fail(message: string): never {
  throw new Bg3TestProtocolError(`BG3 pointer: ${message}`);
}

export function parsePointerRequest(
  contents: string,
  arm: Bg3TestArm,
  command: Bg3TestCommand,
  policy: Bg3PointerPolicy | undefined,
): Bg3PointerRequest {
  if (Buffer.byteLength(contents) > 65_536) fail("request exceeds 65536 bytes");
  let value: unknown;
  try { value = JSON.parse(contents); } catch { fail("request is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("request is not an object");
  const request = value as Bg3PointerRequest;
  const allowedKeys = new Set(["schemaVersion", ...identityKeys, "phase", "viewport", "observedAtEpochMs", "expiresAtEpochMs", "entries", "projection"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) fail("request contains unsupported fields");
  if (policy === undefined || arm.mode !== "runtime" || arm.savePolicy !== "never"
    || command.mode !== "runtime" || command.savePolicy !== "never" || command.saveId !== arm.saveId
    || command.runId !== arm.runId || command.scenarioId !== arm.scenarioId
    || command.createdAtEpochMs < arm.createdAtEpochMs || command.expiresAtEpochMs > arm.expiresAtEpochMs) {
    fail("arm or command does not authorize pointer input");
  }
  if (request.schemaVersion !== 2 || request.runId !== arm.runId || request.scenarioId !== arm.scenarioId
    || !Number.isSafeInteger(request.sequence) || request.sequence < 1
    || request.stepId !== policy.steps[request.sequence - 1]
    || request.operation !== policy.operation || request.spellId !== policy.spellId
    || (request.phase !== "hover" && request.phase !== "leave")) fail("request does not match the authorized step");
  if (![request.casterUuid, request.targetUuid, request.castGuid].every((value) => typeof value === "string" && UUID.test(value)
    && value !== "00000000-0000-0000-0000-000000000000")
    || request.casterUuid === request.targetUuid) fail("actor or cast identity is invalid");
  if (request.targetLabel !== targetPointerLabel(request.targetUuid)) fail("target label does not match its UUID");
  if (!Array.isArray(request.viewport) || request.viewport.length !== 2
    || !request.viewport.every((value) => Number.isSafeInteger(value) && value >= 320 && value <= 16384)) fail("viewport is invalid");
  if (!Array.isArray(request.entries) || request.entries.length > 256) fail("target entries are invalid");
  const matching = request.entries.filter((entry) => entry !== null && typeof entry === "object" && entry.uuid === request.targetUuid);
  if (matching.length !== 1 || matching[0]?.objectType !== "ls.Character") fail("target lacks a unique native character label");
  if (!Number.isSafeInteger(request.observedAtEpochMs) || !Number.isSafeInteger(request.expiresAtEpochMs)
    // SE's epoch clock has whole-second resolution.
    || request.observedAtEpochMs < Math.floor(command.createdAtEpochMs / 1000) * 1000
    || request.expiresAtEpochMs <= request.observedAtEpochMs
    || request.expiresAtEpochMs > command.expiresAtEpochMs) fail("request timestamps are outside the command");
  return request;
}

export interface Bg3PointerReply {
  cursor: { x: number; y: number };
  evidence?: unknown;
}

export interface Bg3PointerSessionOptions {
  arm: Bg3TestArm;
  command: Bg3TestCommand;
  policy: Bg3PointerPolicy;
  now(): number;
  readRequest(): Promise<{ size: number; contents: string } | undefined>;
  assertInputAllowed(): void;
  assertActive(): Promise<void>;
  move(request: Bg3PointerRequest): Promise<Bg3PointerReply>;
  writeAck(value: unknown, beforeCommit: () => void): Promise<void>;
}

export function createBg3PointerSession(options: Bg3PointerSessionOptions): { poll(): Promise<void> } {
  let hover: Bg3PointerRequest | undefined;
  let lastContents: string | undefined;
  let released = false;
  return {
    async poll() {
      const artifact = await options.readRequest();
      if (artifact === undefined || artifact.size === 0) return;
      if (artifact.size > 65_536) fail("request exceeds 65536 bytes");
      // SaveFile can be observed while replacing its contents. Never act on an incomplete write.
      try { JSON.parse(artifact.contents); } catch { return; }
      if (artifact.contents === lastContents) return;
      const request = parsePointerRequest(artifact.contents, options.arm, options.command, options.policy);
      const now = options.now();
      if (now < request.observedAtEpochMs || now - request.observedAtEpochMs > 2000 || now >= request.expiresAtEpochMs) fail("request is stale or expired");
      if (request.phase === "hover") {
        if (hover === undefined) {
          if (request.sequence !== 1) fail("hover skipped the first preview");
        } else {
          // A later step starts only after the previous hover/leave pair completed on the same actors.
          const nextValidation = released && request.sequence === hover.sequence + 1
            && request.casterUuid === hover.casterUuid && request.targetUuid === hover.targetUuid
            && request.castGuid !== hover.castGuid && request.viewport.every((value, index) => value === hover?.viewport[index]);
          if (!nextValidation) fail("hover was replaced or replayed");
        }
      } else {
        if (hover === undefined || released || identityKeys.some((key) => request[key] !== hover?.[key])
          || request.expiresAtEpochMs !== hover.expiresAtEpochMs
          || request.viewport.some((value, index) => value !== hover?.viewport[index])) fail("leave does not match the owned hover");
      }
      options.assertInputAllowed();
      await options.assertActive();
      const result = await options.move(request);
      await options.assertActive();
      const beforeCommit = () => {
        options.assertInputAllowed();
        if (options.now() >= request.expiresAtEpochMs) fail("movement completed after its deadline");
      };
      beforeCommit();
      if (!Number.isSafeInteger(result.cursor?.x) || !Number.isSafeInteger(result.cursor?.y)) fail("backend cursor is invalid");
      await options.writeAck({
        schemaVersion: 2,
        ...Object.fromEntries(identityKeys.map((key) => [key, request[key]])),
        phase: request.phase, status: "moved", cursor: result.cursor,
        observedAtEpochMs: options.now(), expiresAtEpochMs: request.expiresAtEpochMs,
        evidence: result.evidence,
      }, beforeCommit);
      if (request.phase === "hover") { hover = request; released = false; }
      else released = true;
      lastContents = artifact.contents;
    },
  };
}
