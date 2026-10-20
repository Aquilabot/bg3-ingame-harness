import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  bg3HeadlessWindowRuleCleanupExpression,
  bg3HeadlessWindowRuleInstallExpression,
} from "../src/node-platform.js";

// Execute the production Lua with controllable compositor handles and timers.
// Each expression gets its own scope, as it does in separate hyprctl eval calls.
const luaRuntime = `
local rules = {}
local timers = {}
hl = {}
function hl.window_rule(spec)
    local rule = { spec = spec, enabled = true, valid = true }
    function rule:is_enabled()
        if not self.valid then return nil end
        return self.enabled
    end
    function rule:set_enabled(enabled)
        if self.valid then self.enabled = enabled end
    end
    rules[#rules + 1] = rule
    return rule
end
function hl.timer(callback, options)
    local timer = { callback = callback, timeout = options.timeout }
    assert(options.type == "oneshot")
    function timer:set_timeout(timeout) self.timeout = timeout end
    function timer:fire() self.callback() end
    timers[#timers + 1] = timer
    return timer
end
local function assert_active(expected)
    for _, rule in ipairs(rules) do
        if rule.valid then
            assert(rule.enabled == (rule == expected or rule == bg3_harness_steam_rule),
                "Unexpected active rule: " .. rule.spec.name)
        end
    end
end
local function assert_disabled()
    for _, rule in ipairs(rules) do
        assert(rule:is_enabled() ~= true, "Rule still active: " .. rule.spec.name)
    end
    assert(bg3_harness_window_rule_owner == nil, "Lease owner still active")
    assert(bg3_harness_window_rule_timer == nil, "Lease timer still active")
end
`;

function install(runId: string, monitor?: string): string {
  return `do ${bg3HeadlessWindowRuleInstallExpression(runId, 10_000, monitor)} end`;
}

function cleanup(runId: string): string {
  return `do ${bg3HeadlessWindowRuleCleanupExpression(runId)} end`;
}

function runLua(script: string): void {
  expect(execFileSync("lua", ["-e", `${luaRuntime}\n${script}\nprint("PASS")`], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 2_000,
  }).trim()).toBe("PASS");
}

describe("BG3 display rule Lua lifecycle", () => {
  it.each([
    { first: undefined, second: "DP-2" },
    { first: "DP-2", second: undefined },
    { first: "DP-2", second: "HDMI-A-1" },
  ])("switches $first to $second without letting an old lease disable the new run", ({ first, second }) => {
    runLua(`
      ${install("run-first", first)}
      local first_rule = bg3_harness_window_rule
      local first_timer = bg3_harness_window_rule_timer
      local steam_rule = bg3_harness_steam_rule
      assert_active(first_rule)
      ${install("run-second", second)}
      local second_rule = bg3_harness_window_rule
      local second_timer = bg3_harness_window_rule_timer
      assert(first_rule ~= second_rule)
      assert(bg3_harness_steam_rule == steam_rule)
      assert(first_timer.timeout == 1)
      assert_active(second_rule)
      first_timer:fire()
      ${cleanup("run-first")}
      assert_active(second_rule)
      assert(bg3_harness_window_rule_owner == "run-second")
      assert(bg3_harness_window_rule_timer == second_timer)
      ${cleanup("run-second")}
      assert_disabled()
      assert(second_timer.timeout == 1)
      second_timer:fire()
      assert_disabled()
    `);
  });

  it.each([undefined, "DP-2"])("expires both guards in mode %s", (monitor) => {
    runLua(`
      ${install("run-expiring", monitor)}
      assert_active(bg3_harness_window_rule)
      local timer = bg3_harness_window_rule_timer
      assert(timer.timeout == 10000)
      timer:fire()
      assert_disabled()
      ${cleanup("run-expiring")}
      assert_disabled()
    `);
  });

  it("reuses disabled profiles and ignores a cleaned run's pending callback", () => {
    runLua(`
      ${install("run-headless")}
      local headless = bg3_harness_window_rule
      local old_timer = bg3_harness_window_rule_timer
      ${cleanup("run-headless")}
      assert_disabled()
      ${install("run-visible", "DP-2")}
      old_timer:fire()
      assert_active(bg3_harness_window_rule)
      local visible = bg3_harness_window_rule
      ${cleanup("run-visible")}
      ${install("run-headless-again")}
      assert(bg3_harness_window_rule == headless)
      assert_active(headless)
      ${cleanup("run-headless-again")}
      ${install("run-visible-again", "DP-2")}
      assert(bg3_harness_window_rule == visible)
      assert_active(visible)
      assert(#rules == 3, "Reusable rules were duplicated")
      ${cleanup("run-visible-again")}
      assert_disabled()
    `);
  });

  it("recreates compositor-invalidated handles before reusing a profile", () => {
    runLua(`
      ${install("run-before-reload", "DP-2")}
      local previous = bg3_harness_window_rule
      local previous_steam = bg3_harness_steam_rule
      previous.valid = false
      previous_steam.valid = false
      ${install("run-after-reload", "DP-2")}
      assert(bg3_harness_window_rule ~= previous)
      assert(bg3_harness_steam_rule ~= previous_steam)
      assert_active(bg3_harness_window_rule)
      ${cleanup("run-after-reload")}
      assert_disabled()
    `);
  });
});
