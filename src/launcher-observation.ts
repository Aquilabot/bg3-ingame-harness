import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface TerminalObservation {
  atEpochMs: number;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Bg3LauncherObservation {
  launch(): Promise<void>;
  archive(destination: string): Promise<void>;
}

interface LauncherDependencies {
  now?: () => number;
  spawn?: (executable: string, arguments_: string[], options: SpawnOptions) => ChildProcess;
}

/** Observes the Steam command only. BG3 ownership and exit are tracked separately. */
export function createBg3LauncherObservation(
  runId: string,
  executable: string,
  arguments_: readonly string[],
  dependencies: LauncherDependencies = {},
): Bg3LauncherObservation {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)
    || executable.length === 0 || executable.length > 4096
    || arguments_.length > 32 || arguments_.some((value) => value.length > 4096)) {
    throw new Error("Invalid BG3 launcher observation identity or command");
  }
  const now = dependencies.now ?? Date.now;
  const spawnCommand = dependencies.spawn ?? spawn;
  const commandArguments = [...arguments_];
  let requestedAtEpochMs: number | undefined;
  let spawned: { atEpochMs: number; pid: number | null } | undefined;
  let exited: TerminalObservation | undefined;
  let closed: TerminalObservation | undefined;
  let failure: { atEpochMs: number; name: string; message: string; code?: string } | undefined;

  function observeError(error: unknown): void {
    if (failure !== undefined) return;
    const value = error instanceof Error ? error : new Error(String(error));
    const code = "code" in value && typeof value.code === "string" ? value.code.slice(0, 128) : undefined;
    failure = { atEpochMs: now(), name: value.name.slice(0, 128), message: value.message.slice(0, 2048),
      ...(code === undefined ? {} : { code }) };
  }

  return {
    async launch() {
      if (requestedAtEpochMs !== undefined) throw new Error("BG3 launcher observation cannot launch twice");
      requestedAtEpochMs = now();
      await new Promise<void>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = spawnCommand(executable, commandArguments, {
            detached: false,
            shell: false,
            // Pipes can outlive this runner through Steam descendants. Keep the
            // existing descriptors and never change process lifetime for logging.
            stdio: "ignore",
          });
        } catch (error) {
          observeError(error);
          reject(error);
          return;
        }
        child.once("error", (error) => { observeError(error); reject(error); });
        child.once("exit", (code, signal) => { exited = { atEpochMs: now(), code, signal }; });
        child.once("close", (code, signal) => { closed = { atEpochMs: now(), code, signal }; });
        child.once("spawn", () => {
          spawned = { atEpochMs: now(), pid: child.pid ?? null };
          child.unref();
          resolve();
        });
      });
    },
    async archive(destination) {
      // Freeze at archive request time. An unobserved exit is not a successful exit.
      const snapshot = {
        schemaVersion: 1,
        runId,
        role: "steam-launch-wrapper",
        purpose: "bg3-launch",
        executable,
        arguments: commandArguments,
        stdio: "ignored",
        gameExitObserved: false,
        snapshotAtEpochMs: now(),
        requestedAtEpochMs: requestedAtEpochMs ?? null,
        spawnObserved: spawned !== undefined,
        exitObserved: exited !== undefined,
        closeObserved: closed !== undefined,
        spawned: spawned ?? null,
        exited: exited ?? null,
        closed: closed ?? null,
        error: failure ?? null,
      };
      const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
      const directory = path.join(destination, "launcher");
      await mkdir(destination, { recursive: true });
      await mkdir(directory, { mode: 0o700 });
      await writeFile(path.join(directory, "manifest.json"), contents, { flag: "wx", mode: 0o600 });
    },
  };
}

/** Attempt every evidence source even if an earlier collector fails. */
export async function archiveBg3LaunchEvidence(
  destination: string,
  stages: (() => Promise<void>)[],
): Promise<void> {
  // Reserve the whole run before any collector can append to older evidence.
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination, { mode: 0o700 });
  const errors: unknown[] = [];
  for (const stage of stages) {
    try { await stage(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Failed to archive all BG3 launch evidence");
}
