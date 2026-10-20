import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { LaunchedGame } from "./platform.js";

export interface Bg3ProcessIdentityReader {
  readText(file: string): Promise<string>;
  listDirectory(directory: string): Promise<string[]>;
}

const procReader: Bg3ProcessIdentityReader = {
  readText: (file) => readFile(file, "utf8"),
  listDirectory: (directory) => readdir(directory),
};

export function environmentHasAppId(environment: Buffer | string): boolean {
  const text = typeof environment === "string" ? environment : environment.toString("utf8");
  return text.split("\0").some((entry) =>
    ["SteamAppId=1086940", "SteamGameId=1086940", "SteamOverlayGameId=1086940"].includes(entry),
  );
}

function disappeared(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code));
}

interface Leader {
  command: string;
  state: string;
  startTimeTicks: string;
}

async function readLeader(pid: number, reader: Bg3ProcessIdentityReader): Promise<Leader | undefined> {
  try {
    const [commandText, stat] = await Promise.all([
      reader.readText(`/proc/${pid}/comm`), reader.readText(`/proc/${pid}/stat`),
    ]);
    const command = commandText.trim();
    if (command !== "bg3.exe" && command !== "bg3_dx11.exe") return undefined;
    const commandEnd = stat.lastIndexOf(")");
    if (stat.slice(0, commandEnd + 1) !== `${pid} (${command})`) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const state = fields[0], startTimeTicks = fields[19];
    if (state === undefined || !/^[A-Za-z]$/.test(state)
      || startTimeTicks === undefined || !/^[0-9]+$/.test(startTimeTicks)) return undefined;
    return { command, state, startTimeTicks };
  } catch (error) {
    if (disappeared(error)) return undefined;
    throw error;
  }
}

function hasExecutableMapping(maps: string, executable: string): boolean {
  return maps.split("\n").some((line) => {
    const row = /^[0-9a-f]+-[0-9a-f]+\s+[r-][w-][x-][ps]\s+[0-9a-f]+\s+[0-9a-f]+:[0-9a-f]+\s+[0-9]+\s+(.*)$/i.exec(line);
    return row?.[1] === executable;
  });
}

async function hasGameEvidence(procPath: string, executable: string, reader: Bg3ProcessIdentityReader): Promise<boolean> {
  try {
    const [environment, maps] = await Promise.all([
      reader.readText(`${procPath}/environ`), reader.readText(`${procPath}/maps`),
    ]);
    return environmentHasAppId(environment) && hasExecutableMapping(maps, executable);
  } catch (error) {
    if (disappeared(error)) return false;
    throw error;
  }
}

function belongsToLiveThread(status: string, pid: number, tid: number): boolean {
  const memberPid = /^Pid:\s+([0-9]+)\s*$/m.exec(status)?.[1];
  const tgid = /^Tgid:\s+([0-9]+)\s*$/m.exec(status)?.[1];
  const state = /^State:\s+([A-Za-z])(?:\s|$)/m.exec(status)?.[1];
  return memberPid === String(tid) && tgid === String(pid)
    && state !== undefined && !["Z", "X", "x"].includes(state);
}

async function hasThreadEvidence(pid: number, executable: string, reader: Bg3ProcessIdentityReader): Promise<boolean> {
  try {
    const entries = await reader.listDirectory(`/proc/${pid}/task`);
    for (const entry of entries) {
      if (!/^[1-9][0-9]*$/.test(entry)) continue;
      const tid = Number(entry);
      if (!Number.isSafeInteger(tid) || tid === pid) continue;
      const procPath = `/proc/${pid}/task/${tid}`;
      try {
        if (!belongsToLiveThread(await reader.readText(`${procPath}/status`), pid, tid)) continue;
        if (!await hasGameEvidence(procPath, executable, reader)) continue;
        if (belongsToLiveThread(await reader.readText(`${procPath}/status`), pid, tid)) return true;
      } catch (error) {
        if (disappeared(error)) continue;
        throw error;
      }
    }
    return false;
  } catch (error) {
    if (disappeared(error)) return false;
    throw error;
  }
}

export async function validateBg3ProcessIdentity(
  owned: LaunchedGame,
  gameRoot: string,
  reader: Bg3ProcessIdentityReader = procReader,
): Promise<boolean> {
  if (!Number.isSafeInteger(owned.pid) || owned.pid <= 0 || !/^[0-9]+$/.test(owned.startTimeTicks)) return false;
  const before = await readLeader(owned.pid, reader);
  if (before?.startTimeTicks !== owned.startTimeTicks) return false;
  const executable = path.join(gameRoot, "bin", before.command);
  let valid = await hasGameEvidence(`/proc/${owned.pid}`, executable, reader);
  // A dead leader may leave live threads with the group's executable and environment.
  // Never use this fallback for a live leader or treat Z itself as process exit.
  if (!valid && before.state === "Z") valid = await hasThreadEvidence(owned.pid, executable, reader);
  const after = await readLeader(owned.pid, reader);
  return valid && after?.startTimeTicks === owned.startTimeTicks && after.command === before.command;
}
