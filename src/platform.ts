import type {
  Bg3TestArm,
  Bg3TestCommand,
  Bg3TestMode,
} from "./protocol.js";

export interface LaunchedGame {
  pid: number;
  startTimeTicks: string;
}

export type Bg3TestDisplayMode = "headless" | "visible";

export class Bg3TestTimeoutError extends Error {
  override readonly name = "Bg3TestTimeoutError";
}

export class Bg3TestInterruptedError extends Error {
  override readonly name = "Bg3TestInterruptedError";
}

export interface Bg3TestPlatform {
  now(): Date;
  runId(): string;
  armRun(arm: Bg3TestArm): Promise<void>;
  archiveRunArtifacts(runId: string): Promise<void>;
  writeCommand(command: Bg3TestCommand): Promise<void>;
  launchGame(
    saveId: string | undefined,
    runId: string,
    mode: Bg3TestMode,
    display?: Bg3TestDisplayMode,
  ): Promise<LaunchedGame>;
  waitForClientReady?(
    runId: string,
    scenarioId: string,
    timeoutMs: number,
  ): Promise<void>;
  waitForModLoad(
    runId: string,
    scenarioId: string,
    mode: Bg3TestMode,
    timeoutMs: number,
  ): Promise<void>;
  validateNewSave?(runId: string, timeoutMs: number): Promise<string>;
  waitForSaveLoaded(
    saveId: string,
    launchedAt: Date,
    timeoutMs: number,
  ): Promise<void>;
  readResult(runId: string, timeoutMs: number): Promise<string>;
  terminateGame(processIdentity: LaunchedGame): Promise<void>;
  cleanupRun(runId: string): Promise<void>;
  writeOutput(line: string): void;
}
