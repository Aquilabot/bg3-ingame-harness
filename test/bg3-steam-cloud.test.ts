import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BG3_STEAM_APP_ID,
  createBg3SteamCloudManager,
  isSteamClientUnavailableHelperFailure,
  SteamClientUnavailableError,
  waitForSteamClientSession,
  type Bg3SteamCloudDisableSession,
  type Bg3SteamCloudExecutor,
} from "../src/steam-cloud.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

class FakeExecutor implements Bg3SteamCloudExecutor {
  readonly appId = BG3_STEAM_APP_ID;
  readonly helperPath: string;
  readonly buildScriptPath: string;
  readonly steamApiLibraryPath: string;
  enabled: boolean;
  commitError: Error | undefined;
  onCommit: (() => Promise<void>) | undefined;
  restoreCalls: boolean[] = [];

  constructor(root: string, enabled: boolean) {
    this.enabled = enabled;
    this.helperPath = path.join(root, "helper");
    this.buildScriptPath = path.join(root, "build.sh");
    this.steamApiLibraryPath = path.join(root, "libsteam_api.so");
  }

  async beginDisable(): Promise<Bg3SteamCloudDisableSession> {
    const originalEnabled = this.enabled;
    let finished = false;
    return {
      originalEnabled,
      commit: async () => {
        if (finished) throw new Error("handshake already finished");
        finished = true;
        await this.onCommit?.();
        this.enabled = false;
        if (this.commitError !== undefined) throw this.commitError;
      },
      abort: async () => {
        if (finished) throw new Error("handshake already finished");
        finished = true;
      },
    };
  }

  async restoreOriginal(expectedEnabled: boolean): Promise<void> {
    this.restoreCalls.push(expectedEnabled);
    if (this.enabled) {
      throw new Error("Steam Cloud did not remain disabled before the restore");
    }
    this.enabled = expectedEnabled;
  }
}

async function fixture(initialEnabled = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-steam-cloud-"));
  const harnessRoot = path.join(root, "harness");
  const ownerPath = path.join(harnessRoot, "steam-cloud-owner.json");
  const executor = new FakeExecutor(root, initialEnabled);
  const manager = createBg3SteamCloudManager({ harnessRoot, executor });
  return { root, harnessRoot, ownerPath, executor, manager };
}

describe("BG3 Steam Cloud transaction manager", () => {
  it("recognizes only known Steam client startup failures", () => {
    expect(isSteamClientUnavailableHelperFailure([
      "[S_API] SteamAPI_Init(): Loaded steamclient.so OK.",
      "steam-cloud-helper: SteamAPI_InitFlat failed with result 2: Cannot create IPC pipe to Steam client process.",
    ].join("\n"))).toBe(true);
    expect(isSteamClientUnavailableHelperFailure([
      "[S_API] SteamAPI_Init(): Loaded steamclient.so OK.",
      "steam-cloud-helper: SteamAPI_InitFlat failed with result 1: ConnectToGlobalUser failed.",
    ].join("\n"))).toBe(true);
    expect(isSteamClientUnavailableHelperFailure(
      "steam-cloud-helper: SteamAPI_InitFlat failed with result 1: unexpected failure",
    )).toBe(false);
    expect(isSteamClientUnavailableHelperFailure(
      "steam-cloud-helper: invalid helper protocol",
    )).toBe(false);
  });

  it("starts Steam and retries until its API session is ready", async () => {
    const events: string[] = [];
    let now = 0;
    let attempts = 0;

    const session = await waitForSteamClientSession({
      beginSession: async () => {
        attempts += 1;
        events.push(`begin:${attempts}`);
        if (attempts < 3) {
          throw new SteamClientUnavailableError("Steam IPC unavailable");
        }
        return "ready-session";
      },
      startClient: async () => {
        events.push("start-client");
      },
      now: () => now,
      sleep: async (durationMs) => {
        events.push(`sleep:${durationMs}`);
        now += durationMs;
      },
      timeoutMs: 1_000,
      pollMs: 100,
    });

    expect(session).toBe("ready-session");
    expect(events).toEqual([
      "begin:1",
      "start-client",
      "sleep:100",
      "begin:2",
      "sleep:100",
      "begin:3",
    ]);
  });

  it("does not start Steam for a non-transient helper failure", async () => {
    let attempts = 0;
    let starts = 0;
    let now = 0;

    await expect(waitForSteamClientSession({
      beginSession: async () => {
        attempts += 1;
        throw new Error("invalid helper protocol");
      },
      startClient: async () => {
        starts += 1;
      },
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      timeoutMs: 1_000,
      pollMs: 100,
    })).rejects.toThrow("invalid helper protocol");

    expect(attempts).toBe(1);
    expect(starts).toBe(0);
  });

  it("limits Steam startup attempts to one absolute time budget", async () => {
    let now = 0;
    const attemptBudgets: number[] = [];

    await expect(waitForSteamClientSession({
      beginSession: async (remainingMs) => {
        attemptBudgets.push(remainingMs);
        now += attemptBudgets.length === 1 ? 700 : remainingMs;
        throw new SteamClientUnavailableError("Steam IPC unavailable");
      },
      startClient: async () => {
        now += 100;
      },
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      timeoutMs: 1_000,
      pollMs: 100,
    })).rejects.toThrow("did not become ready within 1000 ms");

    expect(attemptBudgets).toEqual([1_000, 100]);
    expect(now).toBe(1_000);
  });

  it("journals the original state before disable and restores it", async () => {
    const test = await fixture(true);
    try {
      test.executor.onCommit = async () => {
        const owner = JSON.parse(await readFile(test.ownerPath, "utf8"));
        expect(owner.originalEnabled).toBe(true);
        expect(owner.modifiedEnabled).toBe(false);
      };

      await test.manager.prepare("run-cloud");

      expect(test.executor.enabled).toBe(false);
      expect(await exists(test.ownerPath)).toBe(true);
      await expect(test.manager.hasPendingTransaction()).resolves.toBe(true);
      await expect(test.manager.pendingOriginalEnabled()).resolves.toBe(true);

      await expect(test.manager.restore("run-cloud")).resolves.toBe(true);

      expect(test.executor.enabled).toBe(true);
      expect(test.executor.restoreCalls).toEqual([true]);
      expect(await exists(test.ownerPath)).toBe(false);
      await expect(test.manager.hasPendingTransaction()).resolves.toBe(false);
      await expect(test.manager.pendingOriginalEnabled()).resolves
        .toBeUndefined();
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("preserves an originally disabled setting", async () => {
    const test = await fixture(false);
    try {
      await test.manager.prepare("run-already-disabled");
      await expect(test.manager.restore("run-already-disabled"))
        .resolves.toBe(false);

      expect(test.executor.enabled).toBe(false);
      expect(test.executor.restoreCalls).toEqual([false]);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("recovers the original setting after an interrupted manager", async () => {
    const test = await fixture(true);
    try {
      await test.manager.prepare("run-interrupted");
      const recovered = createBg3SteamCloudManager({
        harnessRoot: test.harnessRoot,
        executor: test.executor,
      });

      await expect(recovered.prepare("run-next")).rejects.toThrow(
        "recover modsettings before Steam Cloud",
      );
      expect(test.executor.enabled).toBe(false);
      expect(test.executor.restoreCalls).toEqual([]);

      await recovered.recover();

      expect(test.executor.enabled).toBe(true);
      expect(await exists(test.ownerPath)).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("rejects a different run owner without changing Cloud", async () => {
    const test = await fixture(true);
    try {
      await test.manager.prepare("run-owner-a");

      await expect(test.manager.restore("run-owner-b")).rejects.toThrow(
        "belongs to run-owner-a",
      );

      expect(test.executor.enabled).toBe(false);
      expect(test.executor.restoreCalls).toEqual([]);
      expect(await exists(test.ownerPath)).toBe(true);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "rejects a concurrent Cloud enable without overwriting an original %s setting",
    async (initialEnabled) => {
      const test = await fixture(initialEnabled);
      try {
        await test.manager.prepare("run-concurrent-enable");
        test.executor.enabled = true;

        await expect(
          test.manager.restore("run-concurrent-enable"),
        ).rejects.toThrow("did not remain disabled before the restore");

        expect(test.executor.enabled).toBe(true);
        expect(test.executor.restoreCalls).toEqual([initialEnabled]);
        expect(await exists(test.ownerPath)).toBe(true);
      } finally {
        await rm(test.root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a journal that targets another helper path", async () => {
    const test = await fixture(true);
    try {
      await test.manager.prepare("run-tampered");
      const owner = JSON.parse(await readFile(test.ownerPath, "utf8"));
      owner.helperPath = path.join(test.root, "other-helper");
      await writeFile(test.ownerPath, `${JSON.stringify(owner)}\n`);

      await expect(test.manager.recover()).rejects.toThrow(
        "targets unexpected paths",
      );

      expect(test.executor.enabled).toBe(false);
      expect(test.executor.restoreCalls).toEqual([]);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("rolls back when the disable handshake fails after mutation", async () => {
    const test = await fixture(true);
    try {
      test.executor.commitError = new Error("simulated commit failure");

      await expect(test.manager.prepare("run-failed-commit")).rejects.toThrow(
        "simulated commit failure",
      );

      expect(test.executor.enabled).toBe(true);
      expect(test.executor.restoreCalls).toEqual([true]);
      expect(await exists(test.ownerPath)).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
