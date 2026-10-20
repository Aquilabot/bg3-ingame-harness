import type { LaunchedGame } from "./platform.js";

export async function waitForBg3ExitAfterLostValidation(
  owned: LaunchedGame,
  readIdentity: () => Promise<LaunchedGame | undefined>,
  wait: (predicate: () => Promise<boolean>, timeoutMs: number) => Promise<boolean>,
): Promise<boolean> {
  // A shutting-down process can release its executable mapping before /proc
  // disappears. Observe exit only; losing validation never permits a signal.
  return wait(async () => {
    const current = await readIdentity();
    if (current === undefined) return true;
    if (current.pid !== owned.pid || current.startTimeTicks !== owned.startTimeTicks) {
      throw new Error(`Refusing to finalize PID ${owned.pid} because its identity changed`);
    }
    return false;
  }, 1_000);
}
