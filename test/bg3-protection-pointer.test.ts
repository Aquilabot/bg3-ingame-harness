import { describe, expect, it } from "vitest";
import { createBg3PointerSession, parsePointerRequest } from "../src/pointer.js";
import type { Bg3PointerPolicy } from "../src/scenario-catalog.js";
import type { Bg3TestArm } from "../src/protocol.js";

const arm: Bg3TestArm = {
  schemaVersion: 2, runId: "run-protection-preview", scenarioId: "example.two-step-preview",
  mode: "runtime", saveId: "harness-fixture__AutoSave_0", savePolicy: "never",
  createdAt: new Date(100_000).toISOString(), expiresAt: new Date(220_000).toISOString(),
  createdAtEpochMs: 100_000, expiresAtEpochMs: 220_000, timeoutMs: 120_000, requiredAssertionIds: [],
};
const first = {
  schemaVersion: 2, runId: arm.runId, scenarioId: arm.scenarioId,
  stepId: "control-step", sequence: 1, operation: "inspect-target-validation",
  casterUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", targetUuid: "01234567-89ab-cdef-0123-456789abcdef",
  spellId: "Target_Example_Validation", castGuid: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
  phase: "hover", targetLabel: "HNXABCDEFGH", viewport: [2560, 1440],
  observedAtEpochMs: 101_000, expiresAtEpochMs: 147_000,
  entries: [{ uuid: "01234567-89ab-cdef-0123-456789abcdef", objectType: "ls.Character" }],
};
const policy: Bg3PointerPolicy = {
  operation: "inspect-target-validation", spellId: "Target_Example_Validation", steps: ["control-step", "marked-step"],
};
const second = { ...first, stepId: "marked-step", sequence: 2,
  castGuid: "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee", expiresAtEpochMs: 197_000 };

function fixture() {
  let request = first;
  const moved: string[] = [];
  const session = createBg3PointerSession({ arm, command: arm, policy, now: () => 101_500,
    readRequest: async () => { const contents = JSON.stringify(request); return { contents, size: contents.length }; },
    assertInputAllowed() {}, assertActive: async () => {},
    move: async (value) => { moved.push(value.stepId + ":" + value.phase); return { cursor: { x: 100, y: 100 } }; },
    writeAck: async (_value, beforeCommit) => { beforeCommit(); },
  });
  return { session, moved, request(value: typeof first) { request = value; } };
}

describe("multi-step pointer policy", () => {
  it("accepts only the declared steps in order", () => {
    expect(parsePointerRequest(JSON.stringify(first), arm, arm, policy)).toEqual(first);
    expect(parsePointerRequest(JSON.stringify(second), arm, arm, policy)).toEqual(second);
  });
  it.each([
    { operation: "cast-target" }, { spellId: "Target_Example_Other" },
    { stepId: "marked-step" }, { sequence: 2 }, { sequence: 3 },
    { scenarioId: "example.grave-keeper" },
  ])("rejects request scope changes %j", (change) => {
    expect(() => parsePointerRequest(JSON.stringify({ ...first, ...change }), arm, arm, policy)).toThrow();
  });
  it("allows the second hover only after acknowledging return from the first preview", async () => {
    const f = fixture();
    await f.session.poll();
    f.request({ ...first, phase: "leave" }); await f.session.poll();
    f.request(second); await f.session.poll();
    f.request({ ...second, phase: "leave" }); await f.session.poll();
    expect(f.moved).toEqual(["control-step:hover", "control-step:leave",
      "marked-step:hover", "marked-step:leave"]);
  });
  it("rejects skipping the control preview", async () => {
    const f = fixture(); f.request(second);
    await expect(f.session.poll()).rejects.toThrow(); expect(f.moved).toEqual([]);
  });
  it("rejects a second hover before the first pointer return", async () => {
    const f = fixture(); await f.session.poll(); f.request(second);
    await expect(f.session.poll()).rejects.toThrow(); expect(f.moved).toHaveLength(1);
  });
  it.each(["casterUuid", "targetUuid", "castGuid", "viewport"])("rejects replacing %s across the pair", async (field) => {
    const f = fixture(); await f.session.poll(); f.request({ ...first, phase: "leave" }); await f.session.poll();
    const changed = { ...second };
    if (field === "casterUuid") changed.casterUuid = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    if (field === "targetUuid") { changed.targetUuid = "01234567-aaaa-bbbb-cccc-456789abcdef";
      changed.entries = [{ uuid: changed.targetUuid, objectType: "ls.Character" }]; }
    if (field === "castGuid") changed.castGuid = first.castGuid;
    if (field === "viewport") changed.viewport = [1920, 1080];
    f.request(changed); await expect(f.session.poll()).rejects.toThrow(); expect(f.moved).toHaveLength(2);
  });
  it("rejects replaying the first preview after it returned the pointer", async () => {
    const f = fixture(); await f.session.poll(); f.request({ ...first, phase: "leave" }); await f.session.poll();
    f.request(first); await expect(f.session.poll()).rejects.toThrow(); expect(f.moved).toHaveLength(2);
  });
});
