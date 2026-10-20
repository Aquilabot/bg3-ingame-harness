import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearBg3ModCrashSanityCheck } from "../src/crash-sanity.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("BG3 mod crash sanity marker", () => {
  it("removes an empty marker directory without recursive deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-sanity-"));
    const markerPath = path.join(root, "ModCrashSanityCheck");
    try {
      await mkdir(markerPath);

      await expect(clearBg3ModCrashSanityCheck(markerPath)).resolves.toBe(
        "removed",
      );
      expect(await exists(markerPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the marker directory contains data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-sanity-"));
    const markerPath = path.join(root, "ModCrashSanityCheck");
    const contentsPath = path.join(markerPath, "unexpected.txt");
    try {
      await mkdir(markerPath);
      await writeFile(contentsPath, "keep");

      await expect(clearBg3ModCrashSanityCheck(markerPath)).rejects.toThrow(
        "ModCrashSanityCheck is not empty",
      );
      await expect(readFile(contentsPath, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to follow a marker symlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-sanity-"));
    const targetPath = path.join(root, "target");
    const markerPath = path.join(root, "ModCrashSanityCheck");
    try {
      await mkdir(targetPath);
      await symlink(targetPath, markerPath);

      await expect(clearBg3ModCrashSanityCheck(markerPath)).rejects.toThrow(
        "ModCrashSanityCheck is not a real directory",
      );
      expect((await stat(targetPath)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
