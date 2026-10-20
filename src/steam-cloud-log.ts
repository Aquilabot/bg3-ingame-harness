import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface SteamCloudLogCursor {
  device?: number;
  inode?: number;
  size: number;
}

async function readRange(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await file.read(buffer, consumed, length - consumed, offset + consumed);
    if (bytesRead === 0) throw new Error("Steam Cloud log was truncated while reading the owned sync");
    consumed += bytesRead;
  }
  return buffer;
}

export async function readSteamCloudLogAfter(
  logPath: string,
  cursor: SteamCloudLogCursor,
  maxDeltaBytes = 4 * 1024 * 1024,
): Promise<string> {
  let current: FileHandle;
  try {
    current = await open(logPath, "r");
  } catch (error) {
    // Steam can briefly leave the current pathname absent during a rename.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const metadata = await current.stat();
    if (!metadata.isFile()) throw new Error(`Steam Cloud log is not a file: ${logPath}`);
    const hasIdentity = cursor.device !== undefined && cursor.inode !== undefined;
    const matches = (value: { dev: number; ino: number }) =>
      value.dev === cursor.device && value.ino === cursor.inode;
    const checkSize = (size: number) => {
      if (size > maxDeltaBytes) {
        throw new Error(`Steam Cloud log grew by more than ${maxDeltaBytes} bytes during BG3 cleanup`);
      }
    };
    if (!hasIdentity || matches(metadata)) {
      const offset = hasIdentity ? cursor.size : 0;
      if (metadata.size < offset) throw new Error("Steam Cloud log was truncated before the owned BG3 sync completed");
      checkSize(metadata.size - offset);
      return (await readRange(current, offset, metadata.size - offset)).toString("utf8");
    }

    // Steam retains one previous file. Its inode must be the captured file;
    // an unrelated replacement cannot establish continuity with this run.
    const extension = path.extname(logPath);
    const previousPath = path.join(path.dirname(logPath), `${path.basename(logPath, extension)}.previous${extension}`);
    let previous: FileHandle;
    try {
      previous = await open(previousPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Steam Cloud log rotated without a retained predecessor; continuity is unknown");
      }
      throw error;
    }
    try {
      const prior = await previous.stat();
      if (!prior.isFile() || !matches(prior) || prior.size < cursor.size) {
        throw new Error("Steam Cloud log rotated or truncated without the captured predecessor");
      }
      const tailLength = prior.size - cursor.size;
      checkSize(tailLength + metadata.size);
      // Read through the same handles whose identity was checked. A subsequent
      // rename cannot redirect either read to a different file.
      const tail = await readRange(previous, cursor.size, tailLength);
      const head = await readRange(current, 0, metadata.size);
      return Buffer.concat([tail, head]).toString("utf8");
    } finally { await previous.close(); }
  } finally { await current.close(); }
}
