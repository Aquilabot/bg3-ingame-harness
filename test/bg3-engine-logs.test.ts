import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { prepareBg3EngineLogArchive } from "../src/engine-logs.js";

it("archives this launch's engine logs with hashes and excludes earlier logs and links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-engine-logs-"));
  try {
    const game = path.join(root, "game");
    const data = path.join(root, "Larian Studios", "Baldur's Gate 3");
    const bin = path.join(game, "bin");
    const logs = path.join(data, "Script Extender Logs");
    await mkdir(bin, { recursive: true });
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(bin, "network.previous.log"), "previous run");
    await writeFile(path.join(bin, "CrashDump - previous.dmp"), "old crash");
    let now = 1000;
    const archive = await prepareBg3EngineLogArchive(game, data, () => now);
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    await writeFile(path.join(bin, "CrashDump - current.dmp"), "MDMP current crash");
    await writeFile(path.join(bin, "gold.current.log"), "engine diagnostics");
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    now += 500;
    await expect(archive.assertNoCrash()).rejects.toThrow("BG3 crashed during this launch: CrashDump - current.dmp");
    await writeFile(path.join(bin, "network.current.log"), "loaded expected save");
    await writeFile(path.join(bin, "network.previous.log"), "previous run changed");
    await writeFile(path.join(logs, "Extender Runtime current.log"), "runtime error");
    await writeFile(path.join(logs, "unrelated.log"), "unrelated");
    await symlink(path.join(logs, "unrelated.log"), path.join(logs, "Extender Runtime linked.log"));
    const destination = path.join(root, "archive");
    await archive.archive(destination);
    const manifest = JSON.parse(await readFile(path.join(destination, "engine-logs/manifest.json"), "utf8"));
    expect(manifest.files).toHaveLength(4);
    for (const file of manifest.files) {
      const contents = await readFile(path.join(destination, file.file));
      expect(file.sha256).toBe(createHash("sha256").update(contents).digest("hex"));
      expect(file.bytes).toBe(contents.length);
    }
    expect(await readdir(path.join(destination, "engine-logs/network"))).toEqual(["network.current.log"]);
    expect(await readdir(path.join(destination, "engine-logs/extender"))).toEqual(["Extender Runtime current.log"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("records missing engine logs without losing the run's other evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-engine-logs-"));
  try {
    const archive = await prepareBg3EngineLogArchive(path.join(root, "game"), path.join(root, "Larian Studios", "Baldur's Gate 3"));
    await archive.archive(root);
    expect(JSON.parse(await readFile(path.join(root, "engine-logs/manifest.json"), "utf8"))).toEqual({ files: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("waits for a growing crash dump and bounds the wait for an empty one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-engine-crash-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    let now = 0;
    const data = path.join(root, "Larian Studios", "Baldur's Gate 3");
    const archive = await prepareBg3EngineLogArchive(root, data, () => now);
    const dump = path.join(bin, "CrashDump - growing.dmp");
    await writeFile(dump, "");
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    now = 1000;
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    await writeFile(dump, "MDMP header");
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    now = 1300;
    await writeFile(dump, "MDMP header and thread context");
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    now = 1800;
    await expect(archive.assertNoCrash()).rejects.toThrow("BG3 crashed");
    const second = await prepareBg3EngineLogArchive(root, data, () => now);
    await writeFile(path.join(bin, "CrashDump - empty.dmp"), "");
    await expect(second.assertNoCrash()).resolves.toBeUndefined();
    now += 4999;
    await expect(second.assertNoCrash()).resolves.toBeUndefined();
    now += 1;
    await expect(second.assertNoCrash()).rejects.toThrow(
      "BG3 launch produced an empty crash dump marker; native crash unconfirmed: CrashDump - empty.dmp",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("detects and privately archives the Extender minidump overwritten in place by this launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-extender-crash-"));
  try {
    const temp = path.join(root, "Temp");
    const data = path.join(root, "Larian Studios", "Baldur's Gate 3");
    await mkdir(temp);
    const dump = path.join(temp, "OsiExtMiniDump.dmp");
    await writeFile(dump, "old");
    await utimes(dump, 1, 1);
    const originalInode = (await stat(dump)).ino;
    let now = 0;
    const archive = await prepareBg3EngineLogArchive(path.join(root, "game"), data, () => now);
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    const unchangedDestination = path.join(root, "unchanged");
    await archive.archive(unchangedDestination);
    expect(JSON.parse(await readFile(path.join(unchangedDestination, "engine-logs/manifest.json"), "utf8"))).toEqual({ files: [] });
    // Same inode and size must not hide a new fixed-name dump.
    await writeFile(dump, "new");
    await utimes(dump, 2, 2);
    expect((await stat(dump)).ino).toBe(originalInode);
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    now = 300;
    await writeFile(dump, "end");
    await utimes(dump, 3, 3);
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    now = 700;
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    now = 800;
    await expect(archive.assertNoCrash()).rejects.toThrow("OsiExtMiniDump.dmp");
    await writeFile(path.join(temp, "unrelated.dmp"), "private unrelated dump");
    const destination = path.join(root, "archive");
    await archive.archive(destination);
    const manifest = JSON.parse(await readFile(path.join(destination, "engine-logs/manifest.json"), "utf8"));
    expect(manifest.files).toEqual([{
      file: "engine-logs/extender-crash/OsiExtMiniDump.dmp",
      sha256: createHash("sha256").update("end").digest("hex"),
      bytes: 3,
    }]);
    const archived = path.join(destination, manifest.files[0].file);
    expect((await stat(archived)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(archived))).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("ignores a fixed-name Extender dump supplied through a symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-extender-crash-link-"));
  try {
    const data = path.join(root, "Larian Studios", "Baldur's Gate 3");
    const archive = await prepareBg3EngineLogArchive(path.join(root, "game"), data);
    await mkdir(path.join(root, "Temp"));
    const target = path.join(root, "unrelated.dmp");
    await writeFile(target, "unrelated");
    await symlink(target, path.join(root, "Temp/OsiExtMiniDump.dmp"));
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    await archive.archive(path.join(root, "archive"));
    expect(JSON.parse(await readFile(path.join(root, "archive/engine-logs/manifest.json"), "utf8"))).toEqual({ files: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("captures only changed mod diagnostics without treating them as crashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bg3-harness-mod-diagnostics-"));
  try {
    const data = path.join(root, "Larian Studios", "Baldur's Gate 3");
    const logs = path.join(data, "Script Extender", "ExampleMod");
    await mkdir(logs, { recursive: true });
    const server = path.join(logs, "diagnostics-last-server.txt");
    await writeFile(server, "old");
    await utimes(server, 1, 1);
    await writeFile(path.join(logs, "diagnostics-last-client.txt"), "unchanged");
    const archive = await prepareBg3EngineLogArchive(path.join(root, "game"), data, Date.now, [
      { directory: "ExampleMod", pattern: /^diagnostics-last-(?:client|server)\.txt$/ },
    ]);
    await writeFile(server, "new");
    await utimes(server, 2, 2);
    await writeFile(path.join(logs, "other.txt"), "unrelated");
    await expect(archive.assertNoCrash()).resolves.toBeUndefined();
    const destination = path.join(root, "archive");
    await archive.archive(destination);
    const manifest = JSON.parse(await readFile(path.join(destination, "engine-logs/manifest.json"), "utf8"));
    expect(manifest.files).toEqual([{
      file: "engine-logs/mod-diagnostics/diagnostics-last-server.txt",
      sha256: createHash("sha256").update("new").digest("hex"),
      bytes: 3,
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects mod diagnostics outside one Script Extender folder", async () => {
  for (const directory of ["", "..", "../Mods", "ExampleMod/nested"]) {
    await expect(prepareBg3EngineLogArchive("/game", "/data", Date.now, [{ directory, pattern: /x/ }]))
      .rejects.toThrow("one folder under Script Extender");
  }
});
