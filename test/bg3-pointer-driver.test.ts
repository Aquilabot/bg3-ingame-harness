import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBg3PointerDriver } from "../src/pointer-driver.js";
import type { Bg3PointerRequest } from "../src/pointer.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));

class Helper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((_signal: NodeJS.Signals) => true);
  writes: string[] = [];
  finished = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.writes.push(chunk.toString("utf8")));
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }
}

const request = (): Bg3PointerRequest => ({
  schemaVersion: 2, runId: "run-example", scenarioId: "example.pointer-preview",
  stepId: "example-target", sequence: 1, operation: "preview-target",
  casterUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  targetUuid: "01234567-89ab-cdef-0123-456789abcdef",
  spellId: "Target_Example_Spell", castGuid: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
  phase: "hover", targetLabel: "HNXABCDEFGH", viewport: [2560, 1440],
  observedAtEpochMs: Date.now(), expiresAtEpochMs: Date.now() + 10_000,
  entries: [{ uuid: "01234567-89ab-cdef-0123-456789abcdef", objectType: "ls.Character" }],
});

const drivers: Array<{ helper: Helper; driver: ReturnType<typeof createBg3PointerDriver> }> = [];
function start(signal?: AbortSignal) {
  const helper = new Helper();
  vi.mocked(spawn).mockReturnValue(helper as unknown as ReturnType<typeof spawn>);
  const driver = createBg3PointerDriver({
    packageRoot: "/project", runDirectory: "/harness/runs/run-example",
    processIdentity: { pid: 123, startTimeTicks: "456" },
    saveId: "harness-fixture__AutoSave_0", scenarioId: "example.pointer-preview",
    policy: { operation: "preview-target", spellId: "Target_Example_Spell", steps: ["example-target"] },
    ...(signal ? { signal } : {}),
  });
  const pair = { helper, driver };
  drivers.push(pair);
  return pair;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(async () => {
  for (const { helper, driver } of drivers.splice(0)) {
    const closing = driver.close();
    helper.finish();
    await closing;
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("native pointer helper transport", () => {
  it("stops the helper immediately when its response is invalid JSON", async () => {
    const { helper, driver } = start();
    const rejected = expect(driver.move(request())).rejects.toThrow();
    helper.stdout.write("invalid response\n");
    await rejected;
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails immediately when stdout reaches EOF while the helper remains alive", async () => {
    const { helper, driver } = start();
    const outcome = driver.move(request()).catch((error: unknown) => error);
    const ended = new Promise<void>((resolve) => helper.stdout.once("end", resolve));
    helper.stdout.end();
    await ended;
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => driver.assertHealthy()).toThrow(/stdout|EOF/);
  });

  it("rejects a valid reply followed by an unexpected reply in the same chunk", async () => {
    const { helper, driver } = start();
    const outcome = driver.move(request()).catch((error: unknown) => error);
    helper.stdout.write(JSON.stringify({ id: "1", ok: true, cursor: { x: 1400, y: 800 } }) + "\n"
      + JSON.stringify({ id: "2", ok: true, cursor: { x: 1400, y: 800 } }) + "\n");
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => driver.assertHealthy()).toThrow("ID mismatch");
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(driver.move(request())).rejects.toThrow("ID mismatch");
    expect(helper.writes).toHaveLength(1);
  });

  it("waits for the same child close from every close call and escalates a stuck helper", async () => {
    const { helper, driver } = start();
    const outcome = driver.move(request()).catch((error: unknown) => error);
    let firstClosed = false;
    let secondClosed = false;
    const first = driver.close().then(() => { firstClosed = true; });
    const second = driver.close().then(() => { secondClosed = true; });
    await Promise.resolve();
    expect({ firstClosed, secondClosed }).toEqual({ firstClosed: false, secondClosed: false });
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
    expect(await outcome).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(helper.kill).toHaveBeenCalledWith("SIGKILL");
    expect({ firstClosed, secondClosed }).toEqual({ firstClosed: false, secondClosed: false });
    helper.finish();
    await Promise.all([first, second]);
    expect({ firstClosed, secondClosed }).toEqual({ firstClosed: true, secondClosed: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { reply: { id: "other", ok: true, cursor: { x: 1, y: 2 } }, message: "ID mismatch" },
    { reply: { id: "1", ok: false, error: "foreground changed" }, message: "foreground changed" },
  ])("leaves the driver terminal after $message", async ({ reply, message }) => {
    const { helper, driver } = start();
    const outcome = driver.move(request()).catch((error: unknown) => error);
    helper.stdout.write(JSON.stringify(reply) + "\n");
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => driver.assertHealthy()).toThrow(message);
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(driver.move(request())).rejects.toThrow(message);
    expect(helper.writes).toHaveLength(1);
  });

  it("aborts an active movement immediately and never accepts a late reply", async () => {
    const controller = new AbortController();
    const { helper, driver } = start(controller.signal);
    const outcome = driver.move(request()).catch((error: unknown) => error);
    controller.abort("stop");
    helper.stdout.write(JSON.stringify({ id: "1", ok: true, cursor: { x: 1400, y: 800 } }) + "\n");
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => driver.assertHealthy()).toThrow("interrupted");
    expect(helper.kill.mock.calls).toEqual([["SIGTERM"]]);
    await expect(driver.move(request())).rejects.toThrow("interrupted");
    expect(helper.writes).toHaveLength(1);
  });

  it("rejects input if the signal was already aborted when the driver was created", async () => {
    const controller = new AbortController();
    controller.abort();
    const { helper, driver } = start(controller.signal);
    await expect(driver.move(request())).rejects.toThrow("interrupted");
    expect(helper.writes).toEqual([]);
    expect(helper.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("revokes health when an idle helper exits and never signals its exited process", async () => {
    const { helper, driver } = start();
    helper.finish();
    expect(() => driver.assertHealthy()).toThrow("exited");
    await expect(driver.move(request())).rejects.toThrow("exited");
    await driver.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(helper.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps successful serial movements correlated without duplicating a pending command", async () => {
    const { helper, driver } = start();
    const hover = request();
    const first = driver.move(hover);
    await expect(driver.move(hover)).rejects.toThrow("already processing");
    helper.stdout.write(JSON.stringify({ id: "1", ok: true, cursor: { x: 1400, y: 800 } }) + "\n");
    await expect(first).resolves.toMatchObject({ cursor: { x: 1400, y: 800 } });
    expect(() => driver.assertHealthy()).not.toThrow();
    const second = driver.move({ ...hover, phase: "leave" });
    helper.stdout.write(JSON.stringify({ id: "2", ok: true, cursor: { x: 20, y: 30 } }) + "\n");
    await expect(second).resolves.toMatchObject({ cursor: { x: 20, y: 30 } });
    const commands = helper.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(commands.map(({ id, action }) => ({ id, action }))).toEqual([
      { id: "1", action: "hover" }, { id: "2", action: "leave" },
    ]);
    expect(commands[0]).toMatchObject({ pid: 123, startTimeTicks: "456", runDirectory: "/harness/runs/run-example",
      saveId: "harness-fixture__AutoSave_0", request: hover });
    let finished = false;
    const closing = driver.close().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    helper.finish();
    await closing;
    expect(helper.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats an input pipe error as terminal", async () => {
    const { helper, driver } = start();
    const outcome = driver.move(request()).catch((error: unknown) => error);
    helper.stdin.emit("error", new Error("pipe failed"));
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => driver.assertHealthy()).toThrow("pipe failed");
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("terminates a timed out movement without retrying its command", async () => {
    const { helper, driver } = start();
    const outcome = driver.move(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => driver.assertHealthy()).toThrow("timed out");
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
    expect(helper.writes).toHaveLength(1);
  });
});
