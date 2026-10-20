export interface Bg3SaveLoadInspection {
  loaded: boolean;
  unexpectedSaveId?: string;
}

export function inspectBg3SaveLoad(
  contents: string,
  expectedSaveId: string,
): Bg3SaveLoadInspection {
  const lines = contents.split(/\r?\n/);
  const requestedSaveIds = lines
    .map(
      (line) =>
        line.match(
          /ServerLoadProtocol: Load savegame request: ([^\r\n]+)/,
        )?.[1],
    )
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim());
  const unexpectedSaveId = requestedSaveIds.find(
    (requestedSaveId) => requestedSaveId !== expectedSaveId,
  );
  if (unexpectedSaveId !== undefined) {
    return { loaded: false, unexpectedSaveId };
  }

  let phase = 0;
  for (const line of lines) {
    if (
      line.includes(
        `ServerLoadProtocol: Load savegame request: ${expectedSaveId}`,
      )
    ) {
      phase = 1;
      continue;
    }
    if (phase === 1 && line.includes("ServerLoadProtocol: Level Starting")) {
      phase = 2;
      continue;
    }
    if (
      phase === 2 &&
      line.includes("SERVER STATE SWAP - from: Sync, to: Running")
    ) {
      phase = 3;
      continue;
    }
    if (
      phase === 3 &&
      /CLIENT STATE SWAP - from: [^,\r\n]+, to: Running/.test(line)
    ) {
      return { loaded: true };
    }
  }

  return { loaded: false };
}
