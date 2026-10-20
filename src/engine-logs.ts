import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants, createReadStream } from "node:fs";

interface LogRoot {
  directory: string;
  kind: "network" | "extender" | "gold" | "crash" | "extender-crash" | "mod-diagnostics";
  pattern?: RegExp;
}

/**
 * Fixed-name diagnostic files a mod rewrites under `Script Extender/<directory>`.
 * They are archived when they are new or changed during the launch.
 */
export interface Bg3ModDiagnosticsSource {
  directory: string;
  pattern: RegExp;
}

interface LogFile {
  path: string;
  name: string;
  kind: LogRoot["kind"];
  identity: string;
  bytes: number;
  version: string;
}

function isCrash(file: Pick<LogFile, "kind">): boolean {
  return file.kind === "crash" || file.kind === "extender-crash";
}

async function listLogs(roots: LogRoot[]): Promise<LogFile[]> {
  const files: LogFile[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.sort()) {
      const patterns = {
        network: /^network.*\.log$/i,
        extender: /^Extender Runtime .*\.log$/i,
        gold: /^gold\..*\.log$/i,
        crash: /^CrashDump - .*\.dmp$/i,
        "extender-crash": /^OsiExtMiniDump\.dmp$/,
        "mod-diagnostics": /$^/,
      };
      const matches = (root.pattern ?? patterns[root.kind]).test(name);
      if (!matches) continue;
      const filePath = path.join(root.directory, name);
      const metadata = await lstat(filePath);
      if (!metadata.isFile()) continue;
      files.push({
        path: filePath,
        name,
        kind: root.kind,
        identity: `${filePath}:${metadata.dev}:${metadata.ino}`,
        bytes: metadata.size,
        version: `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`,
      });
    }
  }
  return files;
}

export interface Bg3EngineLogArchive {
  archive(destination: string): Promise<void>;
  assertNoCrash(): Promise<void>;
}

/** Captures this launch's new logs and changed, fixed-name diagnostics. */
export async function prepareBg3EngineLogArchive(
  gameRoot: string,
  localAppData: string,
  now: () => number = Date.now,
  modDiagnostics: readonly Bg3ModDiagnosticsSource[] = [],
): Promise<Bg3EngineLogArchive> {
  const scriptExtenderRoot = path.join(localAppData, "Script Extender");
  for (const source of modDiagnostics) {
    const directory = path.resolve(scriptExtenderRoot, source.directory);
    if (path.dirname(directory) !== scriptExtenderRoot) {
      throw new Error(`Mod diagnostics directory must be one folder under Script Extender: ${source.directory}`);
    }
  }
  const roots: LogRoot[] = [
    { directory: path.join(gameRoot, "bin"), kind: "network" },
    { directory: path.join(gameRoot, "bin"), kind: "gold" },
    { directory: path.join(gameRoot, "bin"), kind: "crash" },
    { directory: path.join(localAppData, "Script Extender Logs"), kind: "extender" },
    { directory: path.resolve(localAppData, "..", "..", "Temp"), kind: "extender-crash" },
    ...modDiagnostics.map((source): LogRoot => ({
      directory: path.join(scriptExtenderRoot, source.directory),
      kind: "mod-diagnostics",
      pattern: source.pattern,
    })),
  ];
  const previous = new Map((await listLogs(roots)).map((file) => [file.identity, file.version]));
  const belongsToLaunch = (file: LogFile): boolean => !previous.has(file.identity)
    || ((file.kind === "extender-crash" || file.kind === "mod-diagnostics") && previous.get(file.identity) !== file.version);
  let crashObservation: { identity: string; firstSeen: number; lastChange: number; version: string } | undefined;
  return {
    async assertNoCrash() {
      const crash = (await listLogs(roots.filter(isCrash))).find(belongsToLaunch);
      if (crash !== undefined) {
        const observedAt = now();
        if (crashObservation?.identity !== crash.identity) {
          crashObservation = { identity: crash.identity, firstSeen: observedAt, lastChange: observedAt, version: crash.version };
        } else if (crashObservation.version !== crash.version) {
          crashObservation.version = crash.version;
          crashObservation.lastChange = observedAt;
        }
        // Allow the crash writer to finish before cleanup terminates this BG3 PID.
        const settled = crash.bytes > 0 && observedAt - crashObservation.lastChange >= 500;
        if (!settled && observedAt - crashObservation.firstSeen < 5000) return;
        throw new Error(crash.bytes === 0
          ? `BG3 launch produced an empty crash dump marker; native crash unconfirmed: ${crash.name}`
          : `BG3 crashed during this launch: ${crash.name}`);
      }
    },
    async archive(destination) {
      const evidence: { file: string; sha256: string; bytes: number }[] = [];
      for (const file of await listLogs(roots)) {
        if (!belongsToLaunch(file)) continue;
        const relative = path.join("engine-logs", file.kind, file.name);
        const archived = path.join(destination, relative);
        await mkdir(path.dirname(archived), { recursive: true, mode: isCrash(file) ? 0o700 : 0o755 });
        await copyFile(file.path, archived, constants.COPYFILE_EXCL);
        if (isCrash(file)) await chmod(archived, 0o600);
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(archived)) {
          hash.update(chunk);
          bytes += chunk.length;
        }
        evidence.push({
          file: relative,
          sha256: hash.digest("hex"),
          bytes,
        });
      }
      await mkdir(path.join(destination, "engine-logs"), { recursive: true });
      await writeFile(
        path.join(destination, "engine-logs", "manifest.json"),
        `${JSON.stringify({ files: evidence }, null, 2)}\n`,
        { flag: "wx" },
      );
    },
  };
}
