import { spawn } from "node:child_process";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

const FLOCK_BINARY = "/usr/bin/flock";
const FLOCK_BUSY_EXIT_CODE = 75;
const MAX_STDERR_BYTES = 64 * 1024;

async function assertStableGuardFile(
  guardPath: string,
  guardFile: FileHandle,
): Promise<void> {
  const [pathMetadata, fileMetadata] = await Promise.all([
    lstat(guardPath),
    guardFile.stat(),
  ]);
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    !fileMetadata.isFile() ||
    pathMetadata.dev !== fileMetadata.dev ||
    pathMetadata.ino !== fileMetadata.ino
  ) {
    throw new Error(`BG3 run lock guard is not a stable file: ${guardPath}`);
  }
}

async function acquireKernelLock(
  guardPath: string,
  guardFile: FileHandle,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    const child = spawn(
      FLOCK_BINARY,
      ["-n", "-E", String(FLOCK_BUSY_EXIT_CODE), "3"],
      {
        detached: false,
        shell: false,
        stdio: ["ignore", "ignore", "pipe", guardFile.fd],
      },
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr = `${stderr}${chunk}`.slice(0, MAX_STDERR_BYTES);
      }
    });
    child.once("error", (error) => {
      finish(() => reject(new Error(
        `Could not execute ${FLOCK_BINARY} for ${guardPath}`,
        { cause: error },
      )));
    });
    child.once("close", (exitCode, signal) => {
      finish(() => {
        if (exitCode === 0) {
          resolve();
          return;
        }
        if (exitCode === FLOCK_BUSY_EXIT_CODE) {
          reject(new Error(
            `BG3 run lock transition is already in progress: ${guardPath}`,
          ));
          return;
        }
        const detail = stderr.trim();
        reject(new Error(
          `${FLOCK_BINARY} failed for ${guardPath} with ${
            signal === null ? `exit code ${String(exitCode)}` : `signal ${signal}`
          }${detail === "" ? "" : `: ${detail}`}`,
        ));
      });
    });
  });
}

export async function withRunLockGuard<T>(
  guardPath: string,
  callback: () => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(guardPath), { recursive: true });
  const guardFile = await open(guardPath, "a+", 0o600);
  try {
    await assertStableGuardFile(guardPath, guardFile);
    await acquireKernelLock(guardPath, guardFile);
    await assertStableGuardFile(guardPath, guardFile);
    return await callback();
  } finally {
    await guardFile.close();
  }
}
