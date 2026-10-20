import { expect, it } from "vitest";
import { describeBg3TestError } from "../src/errors.js";

it("preserves each cause when launch and several cleanup stages fail", () => {
  const error = new AggregateError([
    new Error("scenario failed"),
    new AggregateError([
      new Error("profile restore failed", { cause: new Error("hash changed") }),
      new Error("Cloud remains disabled"),
    ], "finalization failed"),
  ], "test failed");
  expect(describeBg3TestError(error)).toBe([
    "test failed", "  scenario failed", "  finalization failed",
    "    profile restore failed", "      hash changed", "    Cloud remains disabled",
  ].join("\n"));
});

it("handles repeated errors and non-Error throws without losing sibling errors", () => {
  const repeated = new Error("original failure");
  repeated.cause = repeated;
  expect(describeBg3TestError(new AggregateError([repeated, "cleanup failed"], "failed")))
    .toBe("failed\n  original failure\n    [repeated error]\n  cleanup failed");
});
