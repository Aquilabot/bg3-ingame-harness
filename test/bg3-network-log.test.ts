import { describe, expect, it } from "vitest";
import { inspectBg3SaveLoad } from "../src/network-log.js";

const saveId = "harness-fixture__AutoSave_0";

function completedLoad(requestedSaveId = saveId): string {
  return [
    `ServerLoadProtocol: Load savegame request: ${requestedSaveId}`,
    "ServerLoadProtocol: Level Starting",
    "SERVER STATE SWAP - from: Sync, to: Running",
    "CLIENT STATE SWAP - from: PrepareRunning, to: Running",
  ].join("\n");
}

describe("BG3 network log save verification", () => {
  it("accepts an ordered server and client transition for the exact save", () => {
    expect(inspectBg3SaveLoad(completedLoad(), saveId)).toEqual({
      loaded: true,
    });
  });

  it("waits for the client even after the server reaches Running", () => {
    const contents = completedLoad().replace(
      "CLIENT STATE SWAP - from: PrepareRunning, to: Running",
      "CLIENT STATE SWAP - from: StopLoading, to: PrepareRunning",
    );

    expect(inspectBg3SaveLoad(contents, saveId)).toEqual({
      loaded: false,
    });
  });

  it("does not reuse a client Running transition from before the save request", () => {
    const contents = [
      "CLIENT STATE SWAP - from: PrepareRunning, to: Running",
      `ServerLoadProtocol: Load savegame request: ${saveId}`,
      "ServerLoadProtocol: Level Starting",
      "SERVER STATE SWAP - from: Sync, to: Running",
    ].join("\n");

    expect(inspectBg3SaveLoad(contents, saveId)).toEqual({
      loaded: false,
    });
  });

  it("reports any request for a different save", () => {
    expect(inspectBg3SaveLoad(completedLoad("ProtectedSave"), saveId)).toEqual({
      loaded: false,
      unexpectedSaveId: "ProtectedSave",
    });
  });
});
