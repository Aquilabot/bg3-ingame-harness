import { appendFile, mkdtemp, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readSteamCloudLogAfter } from "../src/steam-cloud-log.js";

it("continues the owned Cloud log across a rotation without reading earlier syncs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-cloud-rotation-"));
  try {
    const log = path.join(root, "cloud_log.txt");
    await writeFile(log, "previous sync completed\n");
    const before = await stat(log);
    const cursor = { device: before.dev, inode: before.ino, size: before.size };
    await appendFile(log, "owned sync started\n");
    await rename(log, path.join(root, "cloud_log.previous.txt"));
    await writeFile(log, "owned sync completed\n");
    await expect(readSteamCloudLogAfter(log, cursor)).resolves.toBe("owned sync started\nowned sync completed\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects truncation and a replacement whose predecessor does not match the cursor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-cloud-history-"));
  try {
    const log = path.join(root, "cloud_log.txt");
    await writeFile(log, "history before launch\n");
    const before = await stat(log);
    const cursor = { device: before.dev, inode: before.ino, size: before.size };
    await truncate(log, 0);
    await expect(readSteamCloudLogAfter(log, cursor)).rejects.toThrow(/truncated/);
    await rename(log, path.join(root, "unrelated.txt"));
    await writeFile(path.join(root, "cloud_log.previous.txt"), "foreign history\n");
    await writeFile(log, "new log\n");
    await expect(readSteamCloudLogAfter(log, cursor)).rejects.toThrow(/rotated|continuity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("limits the combined suffix across a rotation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-cloud-limit-"));
  try {
    const log = path.join(root, "cloud_log.txt");
    await writeFile(log, "old");
    const before = await stat(log);
    const cursor = { device: before.dev, inode: before.ino, size: before.size };
    await appendFile(log, "12345");
    await rename(log, path.join(root, "cloud_log.previous.txt"));
    await writeFile(log, "67890");
    await expect(readSteamCloudLogAfter(log, cursor, 9)).rejects.toThrow(/grew by more/);
    await expect(readSteamCloudLogAfter(log, cursor, 10)).resolves.toBe("1234567890");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reads an ordinary suffix and tolerates the gap before a new log is created", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-cloud-suffix-"));
  try {
    const log = path.join(root, "cloud_log.txt");
    await expect(readSteamCloudLogAfter(log, { size: 0 })).resolves.toBe("");
    await writeFile(log, "old");
    const before = await stat(log);
    const cursor = { device: before.dev, inode: before.ino, size: before.size };
    await appendFile(log, "new");
    await expect(readSteamCloudLogAfter(log, cursor)).resolves.toBe("new");
    await rename(log, path.join(root, "cloud_log.previous.txt"));
    await expect(readSteamCloudLogAfter(log, cursor)).resolves.toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});
