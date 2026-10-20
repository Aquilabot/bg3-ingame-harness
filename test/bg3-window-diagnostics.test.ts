import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BG3_WINDOW_DIAGNOSTIC_LIMITS as limits,
  createBg3WindowDiagnostics,
  waitForBg3Result,
  type Bg3WindowDiagnosticPhase,
} from "../src/node-platform.js";

const process = { pid: 123, startTimeTicks: "987654321" };
const window = {
  address: "0x123", stableId: "abc", pid: 123, class: "steam_app_1086940", initialClass: "steam_app_1086940",
  at: [0, -1080], size: [1920, 1080], monitor: 2, mapped: true, hidden: false,
  fullscreen: 0, fullscreenClient: 0, xwayland: true, workspace: { id: -1, name: "special:test" },
};
const monitor = {
  id: 2, name: "BG3-HARNESS", x: 0, y: -1080, width: 1920, height: 1080, refreshRate: 60,
  scale: 1, transform: 0, dpmsStatus: true, disabled: false, focused: false,
  activeWorkspace: { id: -1, name: "special:test" },
};
function fixture() {
  const records = new Map<Bg3WindowDiagnosticPhase, any>();
  const raw = { clients: JSON.stringify([window]), monitors: JSON.stringify([monitor]) };
  const readProcess = vi.fn(async () => ({ ...process }) as typeof process | undefined);
  const readHypr = vi.fn(async (query: "clients" | "monitors", _signal: AbortSignal) => raw[query]);
  const write = vi.fn(async (phase: Bg3WindowDiagnosticPhase, contents: string) => {
    records.set(phase, JSON.parse(contents));
  });
  const warn = vi.fn();
  const options = { runId: "run-window-diagnostics", display: "headless" as const, process, window,
    now: () => 1000, readProcess, readHypr, warn };
  const observer = createBg3WindowDiagnostics(options);
  const reader = { capture: async (selected: Bg3WindowDiagnosticPhase, trigger: string) => {
    await observer.capture(selected, trigger);
    await observer.archive(write);
  } };
  return { records, raw, readProcess, readHypr, write, warn, options, observer, reader };
}
const phase = "after-placement";
afterEach(() => vi.useRealTimers());

describe("owned BG3 window diagnostics", () => {
  it("copies only owned window and monitor scalar geometry, including zero and false", async () => {
    const f = fixture();
    f.raw.clients = JSON.stringify([{ ...window, pid: 999, title: "private unrelated title" }, { ...window, title: "not needed" }]);
    f.raw.monitors = JSON.stringify([{ ...monitor, id: 3, description: "unrelated monitor" }, monitor]);
    await f.reader.capture(phase, "placement-verified");
    const result = f.records.get(phase);
    expect(result).toMatchObject({ schemaVersion: 1, status: "diagnostic", phase, runId: f.options.runId,
      expectedProcess: process, expectedWindow: { address: window.address, stableId: window.stableId },
      processBefore: "matched", processAfter: "matched", window, monitor, errors: [], absent: [] });
    expect(JSON.stringify(result)).not.toMatch(/private|title|unrelated/);
    expect(f.readProcess).toHaveBeenCalledTimes(2);
    expect(Buffer.byteLength(f.write.mock.calls[0]![1])).toBeLessThan(limits.artifactBytes);
  });

  it("records missing fields without inventing zero or false", async () => {
    const f = fixture();
    const { hidden: _hidden, at: _at, ...partial } = window;
    f.raw.clients = JSON.stringify([partial]);
    await f.reader.capture(phase, "placement-verified");
    expect(f.records.get(phase).absent).toEqual(expect.arrayContaining(["window.hidden", "window.at"]));
    expect(f.records.get(phase).window).not.toHaveProperty("hidden");
    expect(f.records.get(phase).window).not.toHaveProperty("at");
  });

  it.each([undefined, { ...process, startTimeTicks: "different" }, { ...process, pid: 456 }])(
    "does not query compositor when the process identity is unavailable or replaced: %s", async (identity) => {
      const f = fixture(); f.readProcess.mockResolvedValue(identity);
      await f.reader.capture(phase, "placement-verified");
      expect(f.readHypr).not.toHaveBeenCalled();
      expect(f.records.get(phase).processBefore).toBe(identity === undefined ? "unavailable" : "replaced");
      expect(f.records.get(phase)).not.toHaveProperty("window");
    },
  );

  it.each([undefined, { ...process, startTimeTicks: "reused" }])("discards geometry after PID identity changes mid-query", async (identity) => {
    const f = fixture(); f.readProcess.mockResolvedValueOnce(process).mockResolvedValueOnce(identity);
    await f.reader.capture(phase, "placement-verified");
    expect(f.readHypr).toHaveBeenCalledTimes(2);
    expect(f.records.get(phase).processAfter).toBe(identity === undefined ? "unavailable" : "replaced");
    expect(f.records.get(phase)).not.toHaveProperty("window");
    expect(f.records.get(phase)).not.toHaveProperty("monitor");
  });

  it.each([
    { windows: [{ ...window, address: "0x999" }] }, { windows: [{ ...window, stableId: "ffff" }] },
    { windows: [{ ...window, class: "other", initialClass: "other" }] }, { windows: [window, window] },
  ])("does not adopt a mismatched or ambiguous owned window", async ({ windows }) => {
    const f = fixture(); f.raw.clients = JSON.stringify(windows);
    await f.reader.capture(phase, "placement-verified");
    expect(f.records.get(phase).errors).toContain("window identity differs or is ambiguous");
    expect(f.records.get(phase)).not.toHaveProperty("window");
  });

  it("distinguishes window absence and monitor absence", async () => {
    const f = fixture(); f.raw.clients = "[]";
    await f.reader.capture(phase, "placement-verified");
    expect(f.records.get(phase).absent).toContain("window");
    f.raw.clients = JSON.stringify([window]); f.raw.monitors = "[]";
    await f.reader.capture("before-command", "command-write");
    expect(f.records.get("before-command").absent).toContain("monitor");
    expect(f.records.get("before-command").window).toEqual(window);
  });

  it.each(["{bad", "{}", JSON.stringify(Array.from({ length: limits.windows + 1 }, () => window)), " ".repeat(limits.queryBytes + 1)])(
    "bounds and rejects invalid clients responses", async (raw) => {
      const f = fixture(); f.raw.clients = raw;
      await f.reader.capture(phase, "placement-verified");
      expect(f.records.get(phase).errors).toContain("clients: read, JSON or collection validation failed");
      expect(f.records.get(phase)).not.toHaveProperty("window");
    },
  );

  it("rejects excessive monitor arrays and duplicate selected monitor identity", async () => {
    const f = fixture(); f.raw.monitors = JSON.stringify(Array.from({ length: limits.monitors + 1 }, () => monitor));
    await f.reader.capture(phase, "placement-verified");
    expect(f.records.get(phase).errors).toContain("monitors: read, JSON or collection validation failed");
    f.raw.monitors = JSON.stringify([monitor, monitor]);
    await f.reader.capture("before-command", "command-write");
    expect(f.records.get("before-command").errors).toContain("monitor identity is ambiguous");
  });

  it("rejects malformed scalar fields, bounded strings and tuples without retaining values", async () => {
    const f = fixture(); f.raw.clients = JSON.stringify([{ ...window, hidden: null, at: [1], size: [1, "2"], fullscreen: "0",
      workspace: { id: null, name: "s".repeat(257) } }]);
    await f.reader.capture(phase, "placement-verified");
    const result = f.records.get(phase);
    expect(result.errors).toHaveLength(6);
    expect(result.window).not.toHaveProperty("hidden");
    expect(result.window).not.toHaveProperty("size");
    expect(JSON.stringify(result)).not.toContain("s".repeat(257));
  });

  it("bounds errors even when every observed scalar is malformed", async () => {
    const f = fixture(); f.raw.monitors = JSON.stringify([{ id: monitor.id,
      ...Object.fromEntries(Object.keys(monitor).filter((key) => key !== "id").map((key) => [key, {}])) }]);
    await f.reader.capture(phase, "placement-verified");
    expect(f.records.get(phase).errors).toHaveLength(limits.errors);
    expect(f.records.get(phase).errors.every((error: string) => error.length <= limits.string)).toBe(true);
  });

  it("contains process and compositor read errors as diagnostics", async () => {
    const f = fixture(); f.readProcess.mockRejectedValueOnce(new Error("proc unavailable"));
    await expect(f.reader.capture(phase, "placement-verified")).resolves.toBeUndefined();
    expect(f.records.get(phase).errors).toContain("capture: read failed or exceeded deadline");
    f.readHypr.mockRejectedValue(new Error("socket unavailable"));
    await f.reader.capture("before-command", "command-write");
    expect(f.records.get("before-command").errors).toHaveLength(2);
  });

  it("attempts each phase once, including concurrent calls and failed writes", async () => {
    const f = fixture(); f.write.mockRejectedValueOnce(new Error("exists")); f.warn.mockImplementation(() => { throw new Error("stderr"); });
    await expect(Promise.all([f.reader.capture(phase, "first"), f.reader.capture(phase, "second")])).resolves.toEqual([undefined, undefined]);
    await f.reader.capture(phase, "third");
    expect(f.write).toHaveBeenCalledTimes(1);
    for (const next of ["before-command", "terminal-observation"] as const) await f.reader.capture(next, next);
    expect(f.write).toHaveBeenCalledTimes(3);
  });

  it("aborts hung reads, persists the timeout and prevents late geometry writes", async () => {
    vi.useFakeTimers();
    const f = fixture(); let resolve!: (value: string) => void;
    f.readHypr.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const capture = f.reader.capture(phase, "placement-verified");
    await vi.advanceTimersByTimeAsync(limits.readMs);
    await capture;
    expect(f.records.get(phase).errors).toContain("capture: read failed or exceeded deadline");
    expect(f.readHypr.mock.calls[0]![1].aborted).toBe(true);
    resolve("[]"); await vi.advanceTimersByTimeAsync(10);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.records.get(phase)).not.toHaveProperty("window");
  });

  it("does no writes during capture or teardown, then waits for late archive writes to settle", async () => {
    vi.useFakeTimers(); const f = fixture(); const events: string[] = [];
    let release!: () => void;
    f.write.mockImplementation(async () => {
      events.push("write-start");
      await new Promise<void>((resolve) => { release = resolve; });
      events.push("write-effect");
    });
    await f.observer.capture("terminal-observation", "before-teardown");
    events.push("teardown-complete");
    expect(f.write).not.toHaveBeenCalled();
    let archived = false;
    const archive = f.observer.archive(f.write).then(() => { archived = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(archived).toBe(false);
    expect(events).toEqual(["teardown-complete", "write-start"]);
    release(); await archive;
    expect(events).toEqual(["teardown-complete", "write-start", "write-effect"]);
    await f.observer.archive(f.write);
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it("archives every retained phase after cleanup even when one write fails, then releases all snapshots", async () => {
    const f = fixture();
    for (const selected of [phase, "before-command", "terminal-observation"] as const) {
      await f.observer.capture(selected, selected);
    }
    expect(f.write).not.toHaveBeenCalled();
    f.write.mockRejectedValueOnce(new Error("file exists"));
    await f.observer.archive(f.write);
    expect(f.write).toHaveBeenCalledTimes(3);
    expect(f.warn).toHaveBeenCalledTimes(1);
    await f.observer.archive(f.write);
    expect(f.write).toHaveBeenCalledTimes(3);
    expect(f.write.mock.calls.reduce((sum, [, contents]) => sum + Buffer.byteLength(contents), 0)).toBeLessThan(3 * limits.artifactBytes);
  });

  it("records clock failures without throwing or inventing timestamps", async () => {
    const f = fixture(); const observer = createBg3WindowDiagnostics({ ...f.options, now: () => { throw new Error("clock failed"); } });
    await observer.capture(phase, "placement-verified"); await observer.archive(f.write);
    expect(f.records.get(phase).errors).toContain("clock: unavailable or nonfinite");
    expect(f.records.get(phase)).not.toHaveProperty("startedAtEpochMs");
  });

  it.each([false, true])("does not replace a preexisting artifact or symlink target, symlink=%s", async (link) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bg3-window-diagnostic-"));
    try {
      const file = path.join(directory, `window-diagnostic-${phase}.json`);
      if (link) {
        await writeFile(path.join(directory, "witness"), "witness");
        await symlink(path.join(directory, "witness"), file);
      } else await writeFile(file, "witness");
      const f = fixture(); const reader = createBg3WindowDiagnostics(f.options);
      const write = async (selected: Bg3WindowDiagnosticPhase, contents: string) => writeFile(
        path.join(directory, `window-diagnostic-${selected}.json`), contents, { flag: "wx", encoding: "utf8" });
      await reader.capture(phase, "placement-verified"); await reader.archive(write);
      expect(await readFile(file, "utf8")).toBe("witness");
      expect(f.warn).toHaveBeenCalledTimes(1);
      await reader.capture("before-command", "command-write"); await reader.archive(write);
      expect(JSON.parse(await readFile(path.join(directory, "window-diagnostic-before-command.json"), "utf8")).status).toBe("diagnostic");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

it("observes validated finalizing once without treating a diagnostic failure as a result", async () => {
  let now = 0; const onServerFinalizing = vi.fn(async () => { throw new Error("diagnostic write failed"); });
  const result = '{"source":"server"}';
  await expect(waitForBg3Result({
    runId: "run-diagnostic", scenarioId: "core.runtime-smoke", createdAtEpochMs: 0, expiresAtEpochMs: 1000,
    timeoutMs: 1000, pollMs: 100, maxBytes: 1024, startupGraceMs: 200, finalizingDiscoveryGraceMs: 200, resultDrainMs: 1000,
    assertGameRunning: async () => undefined, onServerFinalizing, now: () => now,
    sleep: async (ms) => { now += ms; },
    readArtifact: async (name) => {
      if (name === "result.json" && now >= 500) return { size: result.length, contents: result };
      if (name !== "server-finalizing.json") return undefined;
      const contents = JSON.stringify({ schemaVersion: 2, runId: "run-diagnostic", scenarioId: "core.runtime-smoke",
        status: "finalizing", finalizingAtEpochMs: 0 });
      return { size: contents.length, contents };
    },
  })).resolves.toBe(result);
  expect(onServerFinalizing).toHaveBeenCalledTimes(1);
});
