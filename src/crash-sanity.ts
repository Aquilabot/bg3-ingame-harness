import { lstat, readdir, rmdir } from "node:fs/promises";

export type Bg3CrashSanityCleanupResult = "absent" | "removed";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function clearBg3ModCrashSanityCheck(
  markerPath: string,
): Promise<Bg3CrashSanityCleanupResult> {
  let before;
  try {
    before = await lstat(markerPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "absent";
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(
      `BG3 ModCrashSanityCheck is not a real directory: ${markerPath}`,
    );
  }

  const entries = await readdir(markerPath);
  if (entries.length !== 0) {
    throw new Error(
      `BG3 ModCrashSanityCheck is not empty: ${markerPath}`,
    );
  }

  const after = await lstat(markerPath);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  ) {
    throw new Error(
      `BG3 ModCrashSanityCheck changed during cleanup: ${markerPath}`,
    );
  }
  await rmdir(markerPath);
  return "removed";
}
