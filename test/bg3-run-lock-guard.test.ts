import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withRunLockGuard } from "../src/run-lock-guard.js";

describe("BG3 run lock guard", () => {
  it("releases the kernel lock when its callback throws", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-bg3-guard-"));
    const guardPath = path.join(root, "active.lock.guard");
    try {
      await expect(withRunLockGuard(guardPath, async () => {
        throw new Error("expected callback failure");
      })).rejects.toThrow("expected callback failure");

      await expect(withRunLockGuard(
        guardPath,
        async () => "acquired after failure",
      )).resolves.toBe("acquired after failure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
