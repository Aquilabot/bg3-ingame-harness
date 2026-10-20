import { describe, expect, it } from "vitest";
import { createBg3PointerSession, parsePointerRequest, targetPointerLabel } from "../src/pointer.js";
import { createBg3TestScenarioCatalog, type Bg3PointerPolicy } from "../src/scenario-catalog.js";
import type { Bg3TestArm } from "../src/protocol.js";
import { waitForBg3Result, writeJsonAtomically } from "../src/node-platform.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bg3DisplayFromArguments, runBg3Test } from "../src/runner.js";
import type { Bg3TestPlatform } from "../src/platform.js";

const arm: Bg3TestArm = {
  schemaVersion: 2, runId: "run-example", scenarioId: "example.pointer-preview",
  mode: "runtime", saveId: "harness-fixture__AutoSave_0", savePolicy: "never",
  createdAt: new Date(100_100).toISOString(), expiresAt: new Date(130_100).toISOString(),
  createdAtEpochMs: 100_100, expiresAtEpochMs: 130_100, timeoutMs: 30000, requiredAssertionIds: [],
};
const targetUuid = "01234567-89ab-cdef-0123-456789abcdef";
const hover = {
  schemaVersion: 2, runId: arm.runId, scenarioId: arm.scenarioId, stepId: "example-target", sequence: 1,
  operation: "preview-target", casterUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", targetUuid,
  spellId: "Target_Example_Spell", castGuid: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee", phase: "hover",
  targetLabel: "HNXABCDEFGH", viewport: [2560, 1440], observedAtEpochMs: 101000, expiresAtEpochMs: 127000,
  entries: [{ uuid: targetUuid, objectType: "ls.Character" }],
};
const policy: Bg3PointerPolicy = { operation: "preview-target", spellId: "Target_Example_Spell", steps: ["example-target"] };
const castPolicy: Bg3PointerPolicy = { operation: "cast-target", spellId: "Target_Example_Spell", steps: ["example-target"] };
const harnessModUuid = "41d551b8-e0c1-4c12-8a29-1be03b5f9054";
const catalog = createBg3TestScenarioCatalog({
  harnessModUuid,
  allowedRuntimeSaveIds: [arm.saveId],
  runtimeFixtures: [{
    id: "fixture", saveId: arm.saveId, expectedLsvSha256: "0".repeat(64),
    requiredMods: { ordered: [{ name: "BG3 In-Game Harness", uuid: harnessModUuid }], present: [] },
  }],
  scenarios: [{
    id: arm.scenarioId, ownerModUuid: harnessModUuid, savePolicy: "never", timeoutMs: 30_000,
    launch: { kind: "runtime", fixtureId: "fixture" }, requiredAssertionIds: ["target-correct"], pointer: policy,
  }],
});

describe("native pointer protocol", () => {
  it("preserves the previous acknowledgment if authorization is revoked before atomic publication", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bg3-pointer-ack-"));
    const file = path.join(directory, "ack.json");
    try {
      await writeFile(file, "previous");
      await expect(writeJsonAtomically(file, { status: "moved" }, () => { throw new Error("interrupted"); })).rejects.toThrow("interrupted");
      expect(await readFile(file, "utf8")).toBe("previous");
      expect(await readdir(directory)).toEqual(["ack.json"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["validation", "publication"])("does not acknowledge input revoked during %s", async (phase) => {
    let checks = 0;
    let aborted = false;
    let acknowledged = false;
    const contents = JSON.stringify(hover);
    const session = createBg3PointerSession({
      arm, command: arm, policy, now: () => 101500,
      readRequest: async () => ({ contents, size: contents.length }),
      assertInputAllowed: () => { if (aborted) throw new Error("interrupted"); },
      assertActive: async () => { checks += 1; if (checks === 2 && phase === "validation") aborted = true; },
      move: async () => ({ cursor: { x: 100, y: 100 } }),
      writeAck: async (_value, beforeCommit) => {
        if (phase === "publication") aborted = true;
        beforeCommit();
        acknowledged = true;
      },
    });
    await expect(session.poll()).rejects.toThrow("interrupted");
    expect(acknowledged).toBe(false);
  });

  it.each([arm.scenarioId])("requires visible display for pointer scenario %s before arming", async (scenarioId) => {
    expect(bg3DisplayFromArguments([], "visible")).toBe("visible");
    const output: string[] = [];
    const platform = { writeOutput: (line: string) => output.push(line) } as unknown as Bg3TestPlatform;
    expect(await runBg3Test(["--scenario", scenarioId, "--display", "headless"], platform, catalog)).toBe(2);
    expect(output[0]).toContain("require --display visible");
  });

  it("services input only after valid server readiness and stops before finalization", async () => {
    let time = 100000;
    const inputs: number[] = [];
    const encode = (value: unknown) => { const contents = JSON.stringify(value); return { contents, size: contents.length }; };
    await waitForBg3Result({
      runId: arm.runId, scenarioId: arm.scenarioId, createdAtEpochMs: 100000, expiresAtEpochMs: 102000,
      timeoutMs: 2000, pollMs: 100, maxBytes: 65536, startupGraceMs: 100,
      finalizingDiscoveryGraceMs: 100, resultDrainMs: 100,
      assertGameRunning: async () => undefined, now: () => time, sleep: async (ms) => { time += ms; },
      onClientInput: async () => { inputs.push(time); },
      readArtifact: async (name) => {
        if (name === "server-ready.json" && time >= 100200) return encode({ schemaVersion: 2,
          runId: arm.runId, scenarioId: arm.scenarioId, status: "ready", readyAtEpochMs: 100200 });
        if (name === "server-finalizing.json" && time >= 100400) return encode({ schemaVersion: 2,
          runId: arm.runId, scenarioId: arm.scenarioId, status: "finalizing", finalizingAtEpochMs: 100400 });
        if (name === "result.json" && time >= 100600) return encode({ status: "passed" });
        return undefined;
      },
    });
    expect(inputs).toEqual([100200, 100300]);
  });

  it("uses the same unambiguous alphabet as the native label and authorizes only supported scenarios", () => {
    expect(targetPointerLabel(targetUuid)).toBe("HNXABCDEFGH");
    expect(targetPointerLabel("89abcdef-0123-4567-89ab-cdef01234567")).toBe("HNXJKLMNPQR");
    expect(catalog.get(arm.scenarioId)?.pointer).toEqual(policy);
    expect(parsePointerRequest(JSON.stringify(hover), arm, arm, policy)).toEqual(hover);
  });

  it.each([
    { targetLabel: "Human" }, { sequence: 2 }, { phase: "click" }, { operation: "cast-target" },
    { targetUuid: hover.casterUuid }, { castGuid: "invalid" }, { runId: "another-run" },
    { entries: [...hover.entries, ...hover.entries] }, { entries: [{ uuid: targetUuid, objectType: "ls.Item" }] },
    { viewport: [0, 1440] }, { expiresAtEpochMs: 140000 }, { observedAtEpochMs: 90000 },
  ])("rejects an uncorrelated or invalid request %j", (patch) => {
    expect(() => parsePointerRequest(JSON.stringify({ ...hover, ...patch }), arm, arm, policy)).toThrow();
  });

  it("rejects a changed command or fixture even when the request matches the arm", () => {
    expect(() => parsePointerRequest(JSON.stringify(hover), arm, { ...arm, runId: "replacement" }, policy)).toThrow();
    expect(() => parsePointerRequest(JSON.stringify(hover), { ...arm, saveId: "777" }, arm, policy)).toThrow();
  });

  it("refuses scenarios without a pointer policy and requests outside the policy", () => {
    expect(() => parsePointerRequest(JSON.stringify(hover), arm, arm, undefined)).toThrow("arm or command does not authorize pointer input");
    expect(() => parsePointerRequest(JSON.stringify(hover), arm, arm, castPolicy)).toThrow("authorized step");
    expect(() => parsePointerRequest(JSON.stringify({ ...hover, stepId: "other-step" }), arm, arm, policy)).toThrow("authorized step");
  });

  function session(owner = arm, ownerPolicy = policy) {
    let contents: string | undefined;
    let now = 101500;
    let revoked = false;
    const actions: string[] = [];
    const acknowledgements: unknown[] = [];
    const controller = createBg3PointerSession({
      arm: owner, command: owner, policy: ownerPolicy, now: () => now,
      readRequest: async () => contents === undefined ? undefined : { contents, size: Buffer.byteLength(contents) },
      assertActive: async () => { if (revoked) throw new Error("revoked"); },
      assertInputAllowed: () => { if (revoked) throw new Error("revoked"); },
      move: async (request) => { actions.push(request.phase); return { cursor: { x: 1400, y: 800 } }; },
      writeAck: async (value) => { acknowledgements.push(value); },
    });
    return { controller, actions, acknowledgements,
      write: (value: unknown) => { contents = typeof value === "string" ? value : JSON.stringify(value); },
      advance: (value: number) => { now = value; }, revoke: () => { revoked = true; } };
  }

  it("moves once per phase and acknowledges the correlated native step only after movement", async () => {
    const s = session();
    s.write(hover);
    await s.controller.poll();
    await s.controller.poll();
    s.write({ ...hover, phase: "leave", observedAtEpochMs: 101500 });
    await s.controller.poll();
    s.advance(130000);
    await s.controller.poll();
    expect(s.actions).toEqual(["hover", "leave"]);
    expect(s.acknowledgements).toHaveLength(2);
    expect(s.acknowledgements[1]).toMatchObject({ targetUuid, castGuid: hover.castGuid, phase: "leave", status: "moved" });
  });

  it("never moves or acknowledges a request outside the scenario policy", async () => {
    const s = session(arm, castPolicy);
    s.write(hover);
    await expect(s.controller.poll()).rejects.toThrow("authorized step");
    expect(s.actions).toEqual([]);
    expect(s.acknowledgements).toEqual([]);
  });

  it("never moves for a stale, revoked, partial, replayed or unmatched phase", async () => {
    const partial = session(); partial.write('{"schemaVersion":'); await partial.controller.poll(); expect(partial.actions).toEqual([]);
    const stale = session(); stale.write(hover); stale.advance(104000); await expect(stale.controller.poll()).rejects.toThrow("stale"); expect(stale.actions).toEqual([]);
    const revoked = session(); revoked.write(hover); revoked.revoke(); await expect(revoked.controller.poll()).rejects.toThrow("revoked"); expect(revoked.actions).toEqual([]);
    const leave = session(); leave.write({ ...hover, phase: "leave" }); await expect(leave.controller.poll()).rejects.toThrow("leave"); expect(leave.actions).toEqual([]);
    const replay = session(); replay.write(hover); await replay.controller.poll(); replay.write({ ...hover, observedAtEpochMs: 101100 }); await expect(replay.controller.poll()).rejects.toThrow("replayed"); expect(replay.actions).toEqual(["hover"]);
    const mismatch = session(); mismatch.write(hover); await mismatch.controller.poll(); mismatch.write({ ...hover, phase: "leave", castGuid: hover.casterUuid }); await expect(mismatch.controller.poll()).rejects.toThrow("owned hover"); expect(mismatch.actions).toEqual(["hover"]);
  });
});
