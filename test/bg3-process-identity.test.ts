import { expect, it } from "vitest";
import { validateBg3ProcessIdentity, type Bg3ProcessIdentityReader } from "../src/process-identity.js";

const owned = { pid: 123, startTimeTicks: "456" };
const gameRoot = "/games/Baldurs Gate 3";
const executable = `${gameRoot}/bin/bg3_dx11.exe`;
const environment = "USER=test\0SteamAppId=1086940\0";
const mapping = (file = executable) => `00400000-00500000 r-xp 00000000 08:01 12 ${file}\n`;
const missing = (code = "ENOENT") => Object.assign(new Error(code), { code });
function procStat(state = "S", startTimeTicks = owned.startTimeTicks, command = "bg3_dx11.exe"): string {
  const fields = Array<string>(20).fill("0");
  fields[0] = state; fields[19] = startTimeTicks;
  return `${owned.pid} (${command}) ${fields.join(" ")}\n`;
}
const status = (tid: number, tgid = owned.pid, state = "S") => `Name:\tbg3_dx11.exe\nState:\t${state} (state)\nTgid:\t${tgid}\nPid:\t${tid}\n`;

function fixture(leaderState = "S") {
  const files = new Map<string, string>([
    ["/proc/123/comm", "bg3_dx11.exe\n"], ["/proc/123/stat", procStat(leaderState)],
    ["/proc/123/maps", leaderState === "Z" ? "" : mapping()],
    ["/proc/123/environ", leaderState === "Z" ? "" : environment],
  ]);
  const reads: string[] = [], directories: string[] = [], tasks = ["123"];
  const calls = new Map<string, number>();
  const hooks = { read: (_file: string, _count: number) => {}, directory: () => {} };
  const reader: Bg3ProcessIdentityReader = {
    async readText(file) {
      reads.push(file);
      const count = (calls.get(file) ?? 0) + 1; calls.set(file, count);
      hooks.read(file, count);
      const result = files.get(file);
      if (result === undefined) throw missing();
      return result;
    },
    async listDirectory(directory) {
      directories.push(directory); hooks.directory();
      expect(directory).toBe("/proc/123/task");
      return tasks;
    },
  };
  function thread(tid = 124, state = "S") {
    const prefix = `/proc/123/task/${tid}`;
    tasks.push(String(tid));
    files.set(`${prefix}/status`, status(tid, owned.pid, state));
    files.set(`${prefix}/maps`, mapping()); files.set(`${prefix}/environ`, environment);
    return prefix;
  }
  return { files, reads, directories, hooks, thread, reader, validate: () => validateBg3ProcessIdentity(owned, gameRoot, reader) };
}

it("validates exact executable and AppId on the owned leader without scanning tasks", async () => {
  const f = fixture();
  expect(await f.validate()).toBe(true);
  expect(f.directories).toEqual([]);
  expect(f.reads.filter((file) => file === "/proc/123/stat")).toHaveLength(2);
});

it("validates an owned Z leader through a live member with exact group identity", async () => {
  const f = fixture("Z"); f.thread();
  expect(await f.validate()).toBe(true);
  expect(f.directories).toEqual(["/proc/123/task"]);
  expect(f.reads.filter((file) => file === "/proc/123/task/124/status")).toHaveLength(2);
  expect(f.reads.at(-1)).toBe("/proc/123/stat");
});

it("does not use thread evidence for an invalid live leader", async () => {
  const f = fixture(); f.thread(); f.files.set("/proc/123/maps", "");
  expect(await f.validate()).toBe(false);
  expect(f.directories).toEqual([]);
});

it("does not treat a Z leader alone as valid or change its identity into exit", async () => {
  const f = fixture("Z");
  expect(await f.validate()).toBe(false);
  expect(f.files.get("/proc/123/stat")).toBe(procStat("Z"));
});

it.each(["S", "Z"])("rejects leader PID reuse after capturing %s evidence", async (state) => {
  const f = fixture(state); f.thread();
  f.hooks.read = (file, count) => { if (file === "/proc/123/stat" && count === 2) f.files.set(file, procStat(state, "999")); };
  expect(await f.validate()).toBe(false);
});

it("rejects an already reused leader before reading process evidence", async () => {
  const f = fixture("Z"); f.thread(); f.files.set("/proc/123/stat", procStat("Z", "999"));
  expect(await f.validate()).toBe(false);
  expect(f.directories).toEqual([]);
  expect(f.reads).not.toContain("/proc/123/environ");
});

it("rejects a leader command change despite matching start ticks", async () => {
  const f = fixture("Z"); f.thread();
  f.hooks.read = (file, count) => {
    if (file === "/proc/123/comm" && count === 2) {
      f.files.set(file, "bg3.exe\n"); f.files.set("/proc/123/stat", procStat("Z", "456", "bg3.exe"));
    }
  };
  expect(await f.validate()).toBe(false);
});

it("rejects leader disappearance after thread evidence", async () => {
  const f = fixture("Z"); f.thread();
  f.hooks.read = (file, count) => { if (file === "/proc/123/stat" && count === 2) throw missing("ESRCH"); };
  expect(await f.validate()).toBe(false);
});

it.each([`${executable}.old`, `${executable} (deleted)`, `/other${executable}`, `${executable} `, executable.toLowerCase()])(
  "rejects a substring or another mapped path %s", async (file) => {
    const f = fixture("Z"); const prefix = f.thread(); f.files.set(`${prefix}/maps`, mapping(file));
    expect(await f.validate()).toBe(false);
  },
);

it("requires a real maps row, not the executable path in arbitrary text", async () => {
  const f = fixture(); f.files.set("/proc/123/maps", `not a mapping ${executable}`);
  expect(await f.validate()).toBe(false);
});

it.each(["SteamAppId=10869400\0", "OTHER=SteamAppId=1086940\0", "SteamAppId=999\0"])(
  "rejects an inexact Steam AppId %s", async (value) => {
    const f = fixture("Z"); const prefix = f.thread(); f.files.set(`${prefix}/environ`, value);
    expect(await f.validate()).toBe(false);
  },
);

it.each([status(124, 999), status(999), status(124, 123, "Z"), status(124, 123, "X"), "Tgid:\t123\nPid:\t124\n"])(
  "rejects a thread without both group membership and a live state: %s", async (value) => {
    const f = fixture("Z"); const prefix = f.thread(); f.files.set(`${prefix}/status`, value);
    expect(await f.validate()).toBe(false);
    expect(f.reads).not.toContain(`${prefix}/maps`);
  },
);

it("rechecks thread membership after reading its maps and environment", async () => {
  const f = fixture("Z"); const prefix = f.thread();
  f.hooks.read = (file, count) => { if (file === `${prefix}/status` && count === 2) f.files.set(file, status(124, 999)); };
  expect(await f.validate()).toBe(false);
});

it.each(["status", "maps", "environ"])("tolerates a disappearing thread at %s and checks the next member", async (field) => {
  const f = fixture("Z"); const prefix = f.thread(); f.thread(125);
  f.files.delete(`${prefix}/${field}`);
  expect(await f.validate()).toBe(true);
  expect(f.reads).toContain("/proc/123/task/125/status");
});

it("rejects a thread that disappears during its final membership read", async () => {
  const f = fixture("Z"); const prefix = f.thread();
  f.hooks.read = (file, count) => { if (file === `${prefix}/status` && count === 2) throw missing(); };
  expect(await f.validate()).toBe(false);
});

it("tolerates a disappearing task directory without accepting the process", async () => {
  const f = fixture("Z"); f.hooks.directory = () => { throw missing(); };
  expect(await f.validate()).toBe(false);
});

it("requires mapping and AppId on the same thread", async () => {
  const f = fixture("Z"); const first = f.thread(), second = f.thread(125);
  f.files.set(`${first}/maps`, ""); f.files.set(`${second}/environ`, "");
  expect(await f.validate()).toBe(false);
});

it("does not turn permission errors into identity or an exit", async () => {
  const f = fixture("Z"); f.thread();
  f.hooks.read = (file) => { if (file === "/proc/123/task/124/maps") throw missing("EACCES"); };
  await expect(f.validate()).rejects.toThrow("EACCES");
});

it("rejects a forged comm or stat PID before considering thread evidence", async () => {
  const f = fixture("Z"); f.thread(); f.files.set("/proc/123/stat", procStat("Z").replace(/^123/, "999"));
  expect(await f.validate()).toBe(false);
  expect(f.directories).toEqual([]);
});

it("accepts the Vulkan executable only when comm, stat and mapped pathname agree", async () => {
  const f = fixture();
  f.files.set("/proc/123/comm", "bg3.exe\n"); f.files.set("/proc/123/stat", procStat("S", "456", "bg3.exe"));
  f.files.set("/proc/123/maps", mapping(`${gameRoot}/bin/bg3.exe`));
  expect(await f.validate()).toBe(true);
});
