import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import type { LaunchedGame } from "./platform.js";
import type { Bg3PointerReply, Bg3PointerRequest } from "./pointer.js";
import type { Bg3PointerPolicy } from "./scenario-catalog.js";

const POINTER_SCRIPT = "pointer/bg3-pointer.py";

export async function checkBg3PointerDependencies(packageRoot: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("python", [path.join(packageRoot, POINTER_SCRIPT), "--check"],
      { timeout: 10_000, maxBuffer: 65_536 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`BG3 pointer preflight failed: ${stderr.trim() || error.message}`));
        else resolve();
      });
  });
}

export function createBg3PointerDriver(options: {
  packageRoot: string;
  runDirectory: string;
  processIdentity: LaunchedGame;
  saveId: string;
  scenarioId: string;
  policy: Bg3PointerPolicy;
  signal?: AbortSignal;
}): { move(request: Bg3PointerRequest): Promise<Bg3PointerReply>; assertHealthy(): void; close(): Promise<void> } {
  // The backend validates every request against this policy and the arm on disk.
  const policy = JSON.stringify({
    scenarioId: options.scenarioId, saveId: options.saveId,
    operation: options.policy.operation, spellId: options.policy.spellId, steps: options.policy.steps,
  });
  const child = spawn("python", [path.join(options.packageRoot, POINTER_SCRIPT), "--policy", policy], {
    stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  let stderr = "";
  let closed = false;
  let childClosed = false;
  let terminationRequested = false;
  let closePromise: Promise<void> | undefined;
  let failure: Error | undefined;
  let pending: {
    id: string;
    resolve(value: Bg3PointerReply): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = undefined;
    }
    if (!childClosed && !terminationRequested) {
      terminationRequested = true;
      child.kill("SIGTERM");
    }
  };
  const assertHealthy = () => {
    if (failure) throw failure;
    if (closed || childClosed) throw new Error("BG3 pointer backend is closed");
  };
  child.stderr.on("data", (value: Buffer) => { stderr = (stderr + value.toString("utf8")).slice(-4000); });
  child.stdin.on("error", (error) => fail(error));
  lines.on("error", (error) => fail(error));
  const stdoutClosed = () => {
    if (!closed && !childClosed) fail(new Error("BG3 pointer backend stdout closed unexpectedly"));
  };
  lines.once("close", stdoutClosed);
  child.stdout.once("close", stdoutClosed);
  child.once("error", (error) => fail(error));
  const exited = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      childClosed = true;
      if (!closed) fail(new Error(`BG3 pointer backend exited (${code ?? signal}): ${stderr}`));
      resolve();
    });
  });
  lines.on("line", (line) => {
    if (failure || closed) return;
    if (line.length > 131072) { fail(new Error("BG3 pointer backend response is too large")); return; }
    try {
      const reply = JSON.parse(line) as { id: string; ok: boolean; error?: string } & Bg3PointerReply;
      if (!pending || reply.id !== pending.id) throw new Error("BG3 pointer backend response ID mismatch");
      if (reply.ok !== true) throw new Error(`BG3 pointer backend: ${reply.error ?? "unspecified failure"}`);
      const current = pending;
      pending = undefined;
      clearTimeout(current.timer);
      current.resolve(reply);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  const abort = () => {
    fail(new Error("BG3 pointer input interrupted"));
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  return {
    assertHealthy,
    async move(request) {
      assertHealthy();
      if (pending) throw new Error("BG3 pointer backend is already processing input");
      const timeoutMs = Math.min(8000, request.expiresAtEpochMs - Date.now());
      if (timeoutMs <= 0) throw new Error("BG3 pointer input already expired");
      const id = String(++nextId);
      const reply = await new Promise<Bg3PointerReply>((resolve, reject) => {
        pending = { id, resolve, reject, timer: setTimeout(() => {
          fail(new Error("BG3 pointer backend timed out"));
        }, timeoutMs) };
        child.stdin.write(JSON.stringify({
          id, action: request.phase, request,
          pid: options.processIdentity.pid, startTimeTicks: options.processIdentity.startTimeTicks,
          saveId: options.saveId, runDirectory: options.runDirectory,
        }) + "\n", (error) => { if (error) fail(error); });
      });
      assertHealthy();
      return reply;
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        if (pending) fail(new Error("BG3 pointer backend closed during movement"));
        child.stdin.end();
        const timer = setTimeout(() => { if (!childClosed) child.kill("SIGKILL"); }, 2000);
        try { await exited; } finally {
          clearTimeout(timer);
          lines.close();
          options.signal?.removeEventListener("abort", abort);
        }
      })();
      return closePromise;
    },
  };
}
