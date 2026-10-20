import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { archiveBg3LaunchEvidence, createBg3LauncherObservation } from "../src/launcher-observation.js";

const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-launcher-observation-"));
  directories.push(value);
  return value;
}
async function manifest(root: string) {
  return JSON.parse(await readFile(path.join(root, "launcher", "manifest.json"), "utf8"));
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function fakeChild() {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 2468 });
  const unref = vi.spyOn(child, "unref");
  const kill = vi.spyOn(child, "kill");
  const spawnCommand = vi.fn(() => child);
  return { child, unref, kill, spawnCommand };
}

it("resolves on spawn without waiting for Steam exit or changing its descriptors", async () => {
  const root = await directory();
  const fake = fakeChild();
  let now = 100;
  const args = ["-silent", "-applaunch", "1086940"];
  const observation = createBg3LauncherObservation("run-starting", "steam", args, {
    spawn: fake.spawnCommand, now: () => now,
  });
  args.push("not-part-of-the-command");
  let ready = false;
  const launch = observation.launch().then(() => { ready = true; });
  await Promise.resolve();
  expect(ready).toBe(false);
  now = 110;
  fake.child.emit("spawn");
  await launch;
  expect(fake.unref).toHaveBeenCalledOnce();
  expect(fake.spawnCommand).toHaveBeenCalledWith("steam", ["-silent", "-applaunch", "1086940"], {
    detached: false, shell: false, stdio: "ignore",
  });
  now = 120;
  await observation.archive(root);
  const saved = await manifest(root);
  expect(saved).toMatchObject({
    runId: "run-starting", role: "steam-launch-wrapper", purpose: "bg3-launch",
    gameExitObserved: false, requestedAtEpochMs: 100, snapshotAtEpochMs: 120,
    spawnObserved: true, exitObserved: false, closeObserved: false,
    spawned: { atEpochMs: 110, pid: 2468 }, exited: null, closed: null, error: null,
  });
  expect(saved).not.toHaveProperty("env");
  expect(fake.kill).not.toHaveBeenCalled();
  expect((await stat(path.join(root, "launcher/manifest.json"))).mode & 0o777).toBe(0o600);
  // Late Steam termination must not rewrite the evidence frozen above.
  fake.child.emit("exit", 0, null);
  fake.child.emit("close", 0, null);
  expect((await manifest(root)).exitObserved).toBe(false);
  await expect(observation.launch()).rejects.toThrow("cannot launch twice");
});

it("records a nonzero wrapper exit separately from BG3, including close timing", async () => {
  const root = await directory();
  const fake = fakeChild();
  let now = 10;
  const observation = createBg3LauncherObservation("run-exited", "steam", [], {
    spawn: fake.spawnCommand, now: () => now,
  });
  const launch = observation.launch();
  fake.child.emit("spawn");
  await launch;
  now = 20;
  fake.child.emit("exit", 7, null);
  now = 30;
  fake.child.emit("close", 7, null);
  await observation.archive(root);
  expect(await manifest(root)).toMatchObject({
    gameExitObserved: false, exitObserved: true, closeObserved: true,
    exited: { code: 7, signal: null, atEpochMs: 20 },
    closed: { code: 7, signal: null, atEpochMs: 30 },
  });
  expect(fake.kill).not.toHaveBeenCalled();
});

it.each([false, true])("archives rejected launches without inventing an exit (synchronous=%s)", async (synchronous) => {
  const root = await directory();
  const fake = fakeChild();
  const error = Object.assign(new Error("unavailable " + "x".repeat(5000)), { code: "ENOENT" });
  const observation = createBg3LauncherObservation("run-missing", "steam", [], {
    spawn: synchronous ? () => { throw error; } : fake.spawnCommand,
  });
  const launch = observation.launch();
  const rejected = expect(launch).rejects.toBe(error);
  if (!synchronous) fake.child.emit("error", error);
  await rejected;
  if (!synchronous) fake.child.emit("close", -2, null);
  await observation.archive(root);
  const saved = await manifest(root);
  expect(saved).toMatchObject({ spawnObserved: false, exitObserved: false, exited: null,
    error: { code: "ENOENT" }, gameExitObserved: false });
  expect(saved.error.message).toHaveLength(2048);
  expect(fake.unref).not.toHaveBeenCalled();
  expect(fake.kill).not.toHaveBeenCalled();
});

it("observes an actual local child and does not confuse two runs", async () => {
  const root = await directory();
  const other = await directory();
  let terminal: Promise<unknown> | undefined;
  const observation = createBg3LauncherObservation("run-local-process", process.execPath, ["-e", "process.exit(7)"], {
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      terminal = once(child, "close");
      return child;
    },
  });
  const second = createBg3LauncherObservation("run-not-launched", "steam", []);
  await observation.launch();
  await terminal;
  await observation.archive(root);
  await second.archive(other);
  expect(await manifest(root)).toMatchObject({ runId: "run-local-process", exitObserved: true,
    exited: { code: 7, signal: null }, gameExitObserved: false });
  expect(await manifest(other)).toMatchObject({ runId: "run-not-launched", spawnObserved: false,
    exitObserved: false, requestedAtEpochMs: null });
  await expect(observation.archive(root)).rejects.toMatchObject({ code: "EEXIST" });
});

it("preserves launcher evidence and every collector failure after a channel or engine error", async () => {
  const root = path.join(await directory(), "archive");
  const observation = createBg3LauncherObservation("run-early-failure", "steam", []);
  const channelFailure = new Error("run channel missing");
  const engineFailure = new Error("engine collection failed");
  const stages: string[] = [];
  let error: unknown;
  try {
    await archiveBg3LaunchEvidence(root, [
      async () => { stages.push("channel"); throw channelFailure; },
      async () => { stages.push("engine"); throw engineFailure; },
      async () => { stages.push("launcher"); await observation.archive(root); },
    ]);
  } catch (value) { error = value; }
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([channelFailure, engineFailure]);
  expect(stages).toEqual(["channel", "engine", "launcher"]);
  expect((await manifest(root)).runId).toBe("run-early-failure");
});

it("refuses a launcher directory supplied by the run channel or a symlink", async () => {
  const root = await directory();
  const foreign = await directory();
  await symlink(foreign, path.join(root, "launcher"));
  const observation = createBg3LauncherObservation("run-linked-output", "steam", []);
  await expect(observation.archive(root)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readdir(foreign)).toEqual([]);
});

it("never appends collectors to an existing run archive", async () => {
  const root = await directory();
  await writeFile(path.join(root, "previous-evidence.json"), "previous run");
  const collector = vi.fn(async () => {
    await writeFile(path.join(root, "must-not-be-created"), "new run");
  });
  await expect(archiveBg3LaunchEvidence(root, [collector])).rejects.toMatchObject({ code: "EEXIST" });
  expect(collector).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual(["previous-evidence.json"]);
  expect(await readFile(path.join(root, "previous-evidence.json"), "utf8")).toBe("previous run");
});
