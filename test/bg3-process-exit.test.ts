import { expect, it } from "vitest";
import { waitForBg3ExitAfterLostValidation } from "../src/process-exit.js";

const owned = { pid: 123, startTimeTicks: "456" };
it("waits for an owned process that has released its mapping to disappear", async () => {
  let polls = 0;
  const exited = await waitForBg3ExitAfterLostValidation(owned,
    async () => ++polls === 1 ? owned : undefined,
    async (predicate, timeoutMs) => {
      expect(timeoutMs).toBe(1_000);
      expect(await predicate()).toBe(false);
      return predicate();
    });
  expect(exited).toBe(true);
});

it("does not accept a live invalid process as terminated", async () => {
  expect(await waitForBg3ExitAfterLostValidation(owned, async () => owned,
    async (predicate) => predicate())).toBe(false);
});

it("rejects PID reuse during the exit grace period", async () => {
  await expect(waitForBg3ExitAfterLostValidation(owned,
    async () => ({ ...owned, startTimeTicks: "789" }),
    async (predicate) => predicate())).rejects.toThrow("identity changed");
});
