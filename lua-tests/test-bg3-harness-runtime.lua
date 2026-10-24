local SERVER_ROOT = "mod/Mods/BG3InGameHarness_41d551b8-e0c1-4c12-8a29-1be03b5f9054/ScriptExtender/Lua/Server/"
local HARNESS_PATH = SERVER_ROOT .. "TestHarness.lua"
local ARM_PATH = "BG3InGameHarness/TestHarness/arm.json"
local BACKGROUND_UUID = "56c19b4a-f7b7-4aba-ba1f-0ade44a98560"
local TRANSITION_MOD_UUID = "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c"

local function createEnvironment(options)
    options = options or {}
    local sessionLoadedCallback = nil
    local timerCallbacks = {}
    local cancelledTimers = {}
    local files = {}
    local parsedValues = {}
    local savedValues = {}
    local epochMilliseconds = options.InitialEpochMilliseconds or 2000
    local nextTimer = 0
    local valueBeingStringified = nil
    local autoSaveRequests = 0
    local saveStateListener = nil
    local pendingAutoSave = false
    local saveFileFailures = options.SaveFileFailures or 0
    local finalizingSaveFileFailures = options.FinalizingSaveFileFailures or 0
    local readBackMismatches = options.ReadBackMismatches or 0
    local saveFileAttempts = 0
    local allSaveFileAttempts = 0
    local printedErrors = {}
    local waitForRealtimeCalls = 0
    local protocolEvents = {}
    local switchState = { CanAutoSave = false }
    local switches = setmetatable({}, {
        __index = switchState,
        __newindex = function(_, key, value)
            switchState[key] = value
            if key == "CanAutoSave" then
                table.insert(
                    protocolEvents,
                    value == true and "autosave-gate-open" or "autosave-gate-closed"
                )
            end
        end
    })
    local autoCloseProducers = options.AutoCloseProducers ~= false
    local autoAcknowledgeSaveIntent = options.AutoAcknowledgeSaveIntent ~= false

    local function processAutoSave()
        if pendingAutoSave and switches.CanAutoSave then
            pendingAutoSave = false
            if saveStateListener then saveStateListener({ ToState = "Save" }) end
        end
    end

    Ext = {
        Events = {
            GameStateChanged = {
                Subscribe = function(_, callback) saveStateListener = callback; return 1 end,
                Unsubscribe = function() saveStateListener = nil end
            },
            SessionLoaded = {
                Subscribe = function(_, callback)
                    sessionLoadedCallback = callback
                end
            }
        },
        IO = {
            LoadFile = function(filePath)
                if readBackMismatches > 0
                    and filePath:match("/result%.json$") ~= nil
                    and files[filePath] ~= nil then
                    readBackMismatches = readBackMismatches - 1
                    return "TRUNCATED"
                end
                return files[filePath]
            end,
            SaveFile = function(filePath, contents)
                allSaveFileAttempts = allSaveFileAttempts + 1
                if filePath:match("/result%.json$") ~= nil then
                    saveFileAttempts = saveFileAttempts + 1
                end
                if finalizingSaveFileFailures > 0
                    and filePath:match("/server%-finalizing%.json$") ~= nil then
                    finalizingSaveFileFailures = finalizingSaveFileFailures - 1
                    return false
                end
                if saveFileFailures > 0 and filePath:match("/result%.json$") ~= nil then
                    saveFileFailures = saveFileFailures - 1
                    return false
                end
                files[filePath] = contents
                savedValues[filePath] = valueBeingStringified
                if filePath:match("/server%-finalizing%.json$") ~= nil then
                    table.insert(protocolEvents, "server-finalizing")
                    if autoCloseProducers then
                        local finalizing = valueBeingStringified
                        local runRoot = filePath:gsub("/server%-finalizing%.json$", "")
                        local startupToken = "AUTO_STARTUP_CLOSED_" .. finalizing.runId
                        local clientToken = "AUTO_CLIENT_CLOSED_" .. finalizing.runId
                        files[runRoot .. "/startup-closed.json"] = startupToken
                        parsedValues[startupToken] = {
                            schemaVersion = 2,
                            runId = finalizing.runId,
                            scenarioId = finalizing.scenarioId,
                            status = "closed",
                            closedAtEpochMs = finalizing.finalizingAtEpochMs
                        }
                        files[runRoot .. "/client-closed.json"] = clientToken
                        parsedValues[clientToken] = {
                            schemaVersion = 2,
                            runId = finalizing.runId,
                            scenarioId = finalizing.scenarioId,
                            status = "closed",
                            finalizingAtEpochMs = finalizing.finalizingAtEpochMs,
                            closedAtEpochMs = finalizing.finalizingAtEpochMs
                        }
                    end
                elseif filePath:match("/save%-intent%.json$") ~= nil then
                    table.insert(protocolEvents, "save-intent")
                    if autoAcknowledgeSaveIntent then
                        local intent = valueBeingStringified
                        local runRoot = filePath:gsub("/save%-intent%.json$", "")
                        local token = "AUTO_SAVE_INTENT_ACK_" .. intent.runId
                        files[runRoot .. "/save-intent-ack.json"] = token
                        parsedValues[token] = {
                            schemaVersion = 2,
                            runId = intent.runId,
                            scenarioId = intent.scenarioId,
                            status = "acknowledged",
                            intentId = intent.intentId,
                            acknowledgedAtEpochMs = intent.intentAtEpochMs
                        }
                    end
                elseif filePath:match("/save%-request%.json$") ~= nil then
                    table.insert(protocolEvents, "save-request")
                end
                return true
            end
        },
        Json = {
            Parse = function(contents)
                local value = parsedValues[contents]
                if value == nil then
                    error("invalid JSON")
                end
                return value
            end,
            Stringify = function(value)
                valueBeingStringified = value
                return "SERIALIZED"
            end
        },
        Timer = {
            Cancel = function(timer)
                if options.CancelFails then
                    error("timer cancellation failed")
                end
                cancelledTimers[timer] = true
                return true
            end,
            ClockEpoch = function()
                return math.floor(epochMilliseconds / 1000)
            end,
            MonotonicTime = function()
                return epochMilliseconds
            end,
            WaitForRealtime = function(_, callback)
                waitForRealtimeCalls = waitForRealtimeCalls + 1
                if waitForRealtimeCalls == options.WaitForRealtimeFailureAt then
                    error("realtime timer unavailable")
                end
                nextTimer = nextTimer + 1
                timerCallbacks[nextTimer] = callback
                return nextTimer
            end
        },
        Utils = {
            GetGlobalSwitches = function()
                return switches
            end,
            Print = function() end,
            PrintError = function(message)
                table.insert(printedErrors, message)
            end
        }
    }
    Osi = {
        AutoSave = setmetatable({}, {
            __call = function()
                table.insert(protocolEvents, "autosave")
                autoSaveRequests = autoSaveRequests + 1
                pendingAutoSave = true
                if not options.DeferredAutoSave then processAutoSave() end
            end
        })
    }

    Mods = {
        BG3InGameHarness = {
            EntityIdentity = dofile(SERVER_ROOT .. "EntityIdentity.lua")
        }
    }
    Mods.BG3InGameHarness.RuntimeFixture = dofile(SERVER_ROOT .. "RuntimeFixture.lua")
    local Harness = dofile(HARNESS_PATH)

    return {
        Harness = Harness,
        ProcessAutoSave = processAutoSave,
        CanAutoSave = function() return switches.CanAutoSave end,
        SessionLoaded = function()
            assert(sessionLoadedCallback ~= nil, "Test harness did not subscribe to SessionLoaded")
            sessionLoadedCallback()
        end,
        PutParsedFile = function(filePath, token, value)
            files[filePath] = token
            parsedValues[token] = value
            if filePath == ARM_PATH and type(value) == "table" then
                local guardPath = "BG3InGameHarness/TestHarness/runs/"
                    .. value.runId
                    .. "/autosave-guard.json"
                local guardToken = "AUTO_AUTOSAVE_GUARD_" .. value.runId
                files[guardPath] = guardToken
                parsedValues[guardToken] = {
                    schemaVersion = 2,
                    runId = value.runId,
                    scenarioId = value.scenarioId,
                    status = "suppressed",
                    suppressedAtEpochMs = value.createdAtEpochMs
                }
            end
        end,
        PutInvalidFile = function(filePath)
            files[filePath] = "INVALID"
        end,
        RunLatestTimer = function()
            assert(nextTimer > 0, "Test harness did not schedule a realtime timer")
            timerCallbacks[nextTimer]()
        end,
        RunTimer = function(timerId)
            assert(timerCallbacks[timerId] ~= nil, "Test harness did not schedule timer " .. tostring(timerId))
            timerCallbacks[timerId]()
        end,
        TimerCount = function()
            return nextTimer
        end,
        SetEpochMilliseconds = function(value)
            epochMilliseconds = value
        end,
        RemoveFile = function(filePath)
            files[filePath] = nil
        end,
        SetCanAutoSave = function(value)
            switches.CanAutoSave = value
        end,
        SavedValue = function(filePath)
            return savedValues[filePath]
        end,
        WasTimerCancelled = function(timer)
            return cancelledTimers[timer] == true
        end,
        AutoSaveRequests = function()
            return autoSaveRequests
        end,
        SaveFileAttempts = function()
            return saveFileAttempts
        end,
        AllSaveFileAttempts = function()
            return allSaveFileAttempts
        end,
        ProtocolEvents = function()
            return protocolEvents
        end,
        PrintedErrors = function()
            return printedErrors
        end
    }
end

local function arm(runId)
    return {
        schemaVersion = 2,
        runId = runId,
        scenarioId = "example.runtime-mechanic",
        mode = "runtime",
        savePolicy = "never",
        saveId = "harness-fixture__AutoSave_0",
        requiredAssertionIds = {},
        createdAtEpochMs = 1000,
        expiresAtEpochMs = 10000,
        timeoutMs = 9000
    }
end

local function command(runId)
    return {
        schemaVersion = 2,
        runId = runId,
        scenarioId = "example.runtime-mechanic",
        mode = "runtime",
        savePolicy = "never",
        saveId = "harness-fixture__AutoSave_0",
        requiredAssertionIds = {},
        createdAtEpochMs = 2000,
        expiresAtEpochMs = 10000,
        timeoutMs = 8000
    }
end

local function creationArm(runId, savePolicy, requiredAssertionIds)
    local value = arm(runId)
    value.scenarioId = "example.background-creation"
    value.mode = "character-creation"
    value.savePolicy = savePolicy or "create-test-fixture"
    value.saveId = "__new_campaign__"
    value.creationPlan = {
        kind = "background",
        backgroundUuid = BACKGROUND_UUID,
        backgroundName = "Example Background",
        requiredTransitionModUuid = TRANSITION_MOD_UUID
    }
    value.requiredAssertionIds = requiredAssertionIds or {}
    return value
end

local function creationCommand(runId, savePolicy, requiredAssertionIds)
    local value = command(runId)
    value.scenarioId = "example.background-creation"
    value.mode = "character-creation"
    value.savePolicy = savePolicy or "create-test-fixture"
    value.saveId = "__new_campaign__"
    value.creationPlan = {
        kind = "background",
        backgroundUuid = BACKGROUND_UUID,
        backgroundName = "Example Background",
        requiredTransitionModUuid = TRANSITION_MOD_UUID
    }
    value.requiredAssertionIds = requiredAssertionIds or {}
    return value
end

local function clientError(runId)
    return {
        schemaVersion = 2,
        runId = runId,
        scenarioId = "example.background-creation",
        status = "error",
        startedAtEpochMs = 2000,
        completedAtEpochMs = 2000,
        assertions = {},
        error = {
            code = "background-not-found",
            message = "Requested background was not selectable"
        }
    }
end

local function startupError(runId)
    local value = clientError(runId)
    value.error = {
        code = "movie-skip-timeout",
        message = "Startup Movie could not be skipped"
    }
    return value
end

local function checkpointEnvironment()
    local environment, context = createEnvironment(), nil
    local runId = "run-checkpoints"
    environment.Harness.RegisterScenario({ Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(value) context = value end })
    environment.PutParsedFile(ARM_PATH, "ARM_CHECKPOINT", arm(runId))
    environment.PutParsedFile("BG3InGameHarness/TestHarness/runs/" .. runId .. "/command.json",
        "COMMAND_CHECKPOINT", command(runId))
    environment.SessionLoaded(); environment.RunLatestTimer()
    assert(context, "checkpoint scenario did not start")
    return environment, context, "BG3InGameHarness/TestHarness/runs/" .. runId .. "/"
end

do
    local environment, context, prefix = checkpointEnvironment()
    local data = { actor = "fixture", request = 1, correlated = false, runId = "not-the-path" }
    assert(context:Checkpoint("cast-before-dispatch", data))
    local first = environment.SavedValue(prefix .. "checkpoint-0001.json")
    assert(first.runId == "run-checkpoints" and first.scenarioId == "example.runtime-mechanic"
        and first.phase == "cast-before-dispatch" and first.sequence == 1 and first.observedAtEpochMs == 2000)
    data.actor = "mutated-after-write"
    assert(first.fields.actor == "fixture" and first.fields.correlated == false, "checkpoint retained the caller's mutable map")
    assert(context:Checkpoint("cast-before-dispatch", { request = 2 }))
    assert(environment.SavedValue(prefix .. "checkpoint-0002.json").fields.request == 2)
    assert(environment.SavedValue(prefix .. "checkpoint-0001.json") == first, "later phase replaced crash evidence")
    for _, invalid in ipairs({ { nested = {} }, { callback = function() end }, { infinite = math.huge },
        { nan = 0/0 }, { long = string.rep("x", 513) }, { [1] = "array" }, setmetatable({}, {}) }) do
        assert(not pcall(context.Checkpoint, context, "valid", invalid), "accepted invalid checkpoint fields")
    end
    assert(not pcall(context.Checkpoint, context, "../../outside", {}), "phase escaped the run path")
    local large = {}; for i = 1, 33 do large["field" .. i] = i end
    assert(not pcall(context.Checkpoint, context, "valid", large), "unbounded checkpoint map accepted")
    for i = 3, 256 do assert(context:Checkpoint("bounded", { sequence = i })) end
    assert(not pcall(context.Checkpoint, context, "overflow", {}), "unbounded checkpoint count accepted")
    context:Finish()
    local attempts = environment.AllSaveFileAttempts()
    assert(not context:Checkpoint("late", {}) and environment.AllSaveFileAttempts() == attempts,
        "closed context wrote another checkpoint")
end

for _, failure in ipairs({ "write-false", "write-throw", "read-mismatch", "read-throw", "serialize-throw", "oversized" }) do
    local environment, context, prefix = checkpointEnvironment()
    local save, load, stringify = Ext.IO.SaveFile, Ext.IO.LoadFile, Ext.Json.Stringify
    local checkpointAttempts, effects, cleaned = 0, 0, false
    context:Defer(function() cleaned = true end)
    Ext.IO.SaveFile = function(path, contents)
        if path:find("/checkpoint-", 1, true) then
            checkpointAttempts = checkpointAttempts + 1
            if failure == "write-false" then return false end
            if failure == "write-throw" then error("disk unavailable") end
        end
        return save(path, contents)
    end
    Ext.IO.LoadFile = function(path)
        if path:find("/checkpoint-", 1, true) then
            if failure == "read-mismatch" then return "truncated" end
            if failure == "read-throw" then error("read failed") end
        end
        return load(path)
    end
    Ext.Json.Stringify = function(value)
        if value.phase then
            if failure == "serialize-throw" then error("serialization failed") end
            if failure == "oversized" then return string.rep("x", 32769) end
        end
        return stringify(value)
    end
    if context:Checkpoint("effect-before", {}) then effects = effects + 1 end
    if context:Checkpoint("must-not-follow", {}) then effects = effects + 1 end
    assert(effects == 0 and cleaned, failure .. " advanced the scenario or prevented cleanup")
    assert(environment.SavedValue(prefix .. "result.json").error.code == "checkpoint-write-failed")
    assert(checkpointAttempts == ((failure == "serialize-throw" or failure == "oversized") and 0 or 1),
        "checkpoint retry could reenter an effect")
end

do
    local environment = createEnvironment()
    local runId, context = "run-context-deadline", nil
    environment.Harness.RegisterScenario({ Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(value) context = value end })
    environment.PutParsedFile(ARM_PATH, "ARM_DEADLINE", arm(runId))
    environment.PutParsedFile("BG3InGameHarness/TestHarness/runs/" .. runId .. "/command.json", "COMMAND_DEADLINE", command(runId))
    environment.SetEpochMilliseconds(3000)
    environment.SessionLoaded(); environment.RunLatestTimer()
    assert(context:GetDeadlineEpochMs() == 10000, "Active context changed the command deadline")
    environment.SetEpochMilliseconds(1999)
    assert(context:GetDeadlineEpochMs() == nil, "A clock before command creation authorized more work")
    environment.SetEpochMilliseconds(9999)
    assert(context:GetDeadlineEpochMs() == 10000)
    environment.SetEpochMilliseconds(10000)
    assert(context:GetDeadlineEpochMs() == nil, "An expired context authorized more work")
    environment.SetEpochMilliseconds(9999)
    context:Finish()
    assert(context:GetDeadlineEpochMs() == nil, "A finished context exposed an active deadline")
end

do
    local environment = createEnvironment({ InitialEpochMilliseconds = 2498 })
    local runId, context = "run-context-fractional-command", nil
    local selectedCommand = command(runId)
    selectedCommand.createdAtEpochMs, selectedCommand.timeoutMs = 2498, 7502
    environment.Harness.RegisterScenario({ Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(value) context = value end })
    environment.PutParsedFile(ARM_PATH, "ARM_FRACTIONAL_COMMAND", arm(runId))
    environment.PutParsedFile("BG3InGameHarness/TestHarness/runs/" .. runId .. "/command.json",
        "COMMAND_FRACTIONAL_COMMAND", selectedCommand)
    environment.SessionLoaded(); environment.RunLatestTimer()
    assert(context == nil or context:GetDeadlineEpochMs() == 10000,
        "Accepted fractional command started without an active deadline in its creation second")
    assert(context == nil, "Second-resolution clock started the scenario before command creation was observable")
    environment.SetEpochMilliseconds(2999)
    environment.RunLatestTimer()
    assert(context == nil, "Same-second polling bypassed the exact creation guard")
    environment.SetEpochMilliseconds(3000)
    environment.RunLatestTimer()
    assert(context ~= nil and context:GetDeadlineEpochMs() == 10000, "Deferred scenario did not receive its active deadline")
    environment.SetEpochMilliseconds(2498)
    assert(context:GetDeadlineEpochMs() == nil, "Clock rollback authorized work before the exact command creation bound")
    environment.SetEpochMilliseconds(9999)
    assert(context:GetDeadlineEpochMs() == 10000, "Creation precision changed the original expiration bound")
    environment.SetEpochMilliseconds(10000)
    assert(context:GetDeadlineEpochMs() == nil, "Creation precision extended command expiration")
    context:Finish()
    assert(context:GetDeadlineEpochMs() == nil, "Deferred scenario retained authority after completion")
end

for _, creation in ipairs({ false, true }) do
    local environment = createEnvironment()
    local runId, context = "run-future-command-" .. tostring(creation), nil
    local selectedArm = creation and creationArm(runId) or arm(runId)
    local selectedCommand = creation and creationCommand(runId) or command(runId)
    selectedCommand.createdAtEpochMs, selectedCommand.timeoutMs = 4500, 5500
    environment.Harness.RegisterScenario({ Id = selectedCommand.scenarioId, Mode = selectedCommand.mode,
        SavePolicy = selectedCommand.savePolicy, Run = function(value) context = value end })
    environment.PutParsedFile(ARM_PATH, "ARM_FUTURE_COMMAND", selectedArm)
    environment.PutParsedFile("BG3InGameHarness/TestHarness/runs/" .. runId .. "/command.json",
        "COMMAND_FUTURE_COMMAND", selectedCommand)
    environment.SessionLoaded(); environment.RunLatestTimer()
    assert(context == nil, "Genuinely future command started immediately")
    for _, now in ipairs({ 3999, 4499, 4500, 4999 }) do
        environment.SetEpochMilliseconds(now); environment.RunLatestTimer()
        assert(context == nil, "Command started before its creation bound was observable")
    end
    environment.SetEpochMilliseconds(5000); environment.RunLatestTimer()
    assert(context ~= nil and context:GetDeadlineEpochMs() == 10000, "Future command failed to start when observable")
    context:Error("test-complete", "Future command boundary verified")
    assert(context:GetDeadlineEpochMs() == nil, "Finalized future command retained authority")
end

for _, outcome in ipairs({ "expired", "timeout", "finalizing", "guard-lost", "timer-failed" }) do
    local environment = createEnvironment({ InitialEpochMilliseconds = 2498,
        FinalizingSaveFileFailures = outcome == "finalizing" and 1 or 0,
        WaitForRealtimeFailureAt = outcome == "timer-failed" and 3 or nil })
    local runId, called = "run-deferred-start-" .. outcome, false
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local selectedCommand = command(runId)
    selectedCommand.createdAtEpochMs, selectedCommand.timeoutMs = 2498, 7502
    environment.Harness.RegisterScenario({ Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function() called = true end })
    environment.PutParsedFile(ARM_PATH, "ARM_DEFERRED_START", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_DEFERRED_START", selectedCommand)
    environment.SessionLoaded(); environment.RunLatestTimer()
    assert(not called, "Deferred scenario ran in its creation second")
    if outcome == "timer-failed" then
        local result = environment.SavedValue(runRoot .. "/result.json")
        assert(result and result.status == "error" and result.error.code == "error-input-read-failed",
            "Deferred-start timer failure did not fail closed")
    else
        local startTimer = environment.TimerCount()
        if outcome == "expired" then
            environment.SetEpochMilliseconds(10000); environment.RunTimer(startTimer)
        elseif outcome == "guard-lost" then
            environment.SetCanAutoSave(true); environment.SetEpochMilliseconds(3000); environment.RunTimer(startTimer)
        else environment.RunTimer(2) end
        assert(not called, "Deferred scenario ran while finalizing")
        if outcome == "timeout" or outcome == "finalizing" then
            assert(environment.WasTimerCancelled(startTimer), "Finalization retained the deferred-start timer")
        end
        local result = environment.SavedValue(runRoot .. "/result.json")
        if outcome == "finalizing" then
            assert(result == nil and environment.TimerCount() > startTimer,
                "Test did not hold finalization open for its write retry")
        else
            assert(result and result.status == "error" and result.error.code ==
                (outcome == "guard-lost" and "autosave-guard-lost" or "scenario-timeout"),
                "Deferred start lost its terminal error")
        end
        environment.SetEpochMilliseconds(3000); environment.RunTimer(startTimer)
        assert(not called, "Late deferred-start callback ran after finalization")
    end
    assert(environment.AutoSaveRequests() == 0, "Deferred start requested a save")
end

do
    local environment = createEnvironment()
    local runId = "run-before-cleanup-diagnostic"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local context, settled, removed, diagnosticAtBarrier = nil, false, false, nil
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(value)
            context = value
            context:Assert("actor-created", true, "Owned actor was created")
            context:Assert("item-ready", false, "Owned item did not settle", "present", "absent")
            context:BeforeCleanup("request settled", function()
                diagnosticAtBarrier = environment.SavedValue(runRoot .. "/server-before-cleanup.json")
                return settled
            end)
            context:Defer(function()
                removed = true
                error("cleanup lookup failed")
            end)
            context:Error("item-timeout", "Timed out waiting for the owned item")
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_BEFORE_CLEANUP", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_BEFORE_CLEANUP", command(runId))
    environment.SessionLoaded(); environment.RunLatestTimer()
    local diagnostic = assert(environment.SavedValue(runRoot .. "/server-before-cleanup.json"),
        "Original failure was not persisted before the cleanup barrier")
    assert(diagnosticAtBarrier == diagnostic and not removed,
        "Diagnostic was published after cleanup began")
    assert(diagnostic.schemaVersion == 1 and diagnostic.status == "diagnostic"
        and diagnostic.phase == "before-cleanup" and diagnostic.runId == runId
        and diagnostic.scenarioId == "example.runtime-mechanic" and diagnostic.observedAtEpochMs == 2000)
    assert(diagnostic.initialStatus == "error" and diagnostic.initialError.code == "item-timeout"
        and diagnostic.initialError.message == "Timed out waiting for the owned item")
    assert(diagnostic.assertionCount == 2 and #diagnostic.assertions == 2
        and diagnostic.assertions[1].id == "actor-created" and diagnostic.assertions[1].passed == true
        and diagnostic.assertions[2].id == "item-ready" and diagnostic.assertions[2].passed == false
        and diagnostic.assertions[2].message == nil and diagnostic.assertions[2].actual == nil)
    assert(diagnostic.completedAtEpochMs == nil and environment.SavedValue(runRoot .. "/result.json") == nil
        and environment.SavedValue(runRoot .. "/server-finalizing.json") == nil,
        "Pre-cleanup evidence became a terminal result or finalization marker")
    context:Error("late-failure", "Must not replace the initial error")
    context:Assert("late-assertion", true, "Must not alter the diagnostic")
    settled = true
    environment.RunLatestTimer()
    local result = assert(environment.SavedValue(runRoot .. "/result.json"))
    assert(removed and result.error.code == "scenario-cleanup-error"
        and result.error.message:find("item-timeout", 1, true)
        and result.error.message:find("cleanup lookup failed", 1, true))
    assert(environment.SavedValue(runRoot .. "/server-before-cleanup.json") == diagnostic
        and diagnostic.initialError.code == "item-timeout" and #diagnostic.assertions == 2,
        "Cleanup or late callbacks replaced the initial evidence")
    assert(environment.AutoSaveRequests() == 0 and not environment.CanAutoSave())
end

for _, outcome in ipairs({ "passed", "failed", "exception" }) do
    local environment = createEnvironment()
    local runId = "run-cleanup-diagnostic-" .. outcome
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local diagnosticAtCleanup
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(context)
            context:Defer(function()
                diagnosticAtCleanup = environment.SavedValue(runRoot .. "/server-before-cleanup.json")
            end)
            context:Assert("observation", outcome ~= "failed", "Observed native state")
            if outcome == "exception" then error("Original engine lookup failed") end
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_DIAGNOSTIC_OUTCOME", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_DIAGNOSTIC_OUTCOME", command(runId))
    environment.SessionLoaded(); environment.RunLatestTimer()
    local diagnostic = assert(diagnosticAtCleanup, "Cleanup ran before the initial outcome was recorded")
    local result = assert(environment.SavedValue(runRoot .. "/result.json"))
    assert(diagnostic.status == "diagnostic" and diagnostic.initialStatus == result.status
        and diagnostic.completedAtEpochMs == nil and diagnostic.assertions[1].id == "observation")
    if outcome == "exception" then
        assert(diagnostic.initialError.code == "scenario-error"
            and diagnostic.initialError.message:find("Original engine lookup failed", 1, true)
            and diagnostic.initialError ~= result.error)
    else
        assert(diagnostic.initialError == nil and result.status == outcome)
    end
    assert(diagnostic.assertions ~= result.assertions and diagnostic.assertions[1] ~= result.assertions[1],
        "Diagnostic retained mutable result assertions")
    assert(environment.AutoSaveRequests() == 0 and not environment.CanAutoSave())
end

for _, failure in ipairs({ "write-false", "write-throw", "read-mismatch", "read-throw", "serialize-throw",
    "serialize-nonstring", "oversized", "log-throw", "clock-throw" }) do
    local environment = createEnvironment()
    local runId = "run-cleanup-diagnostic-" .. failure
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local save, load, stringify = Ext.IO.SaveFile, Ext.IO.LoadFile, Ext.Json.Stringify
    local writes, reads, serializations, cleaned = 0, 0, 0, false
    Ext.IO.SaveFile = function(path, contents)
        if path == runRoot .. "/server-before-cleanup.json" then
            writes = writes + 1
            if failure == "write-false" or failure == "log-throw" then return false end
            if failure == "write-throw" then error("disk unavailable") end
        end
        return save(path, contents)
    end
    Ext.IO.LoadFile = function(path)
        if path == runRoot .. "/server-before-cleanup.json" then
            reads = reads + 1
            if failure == "read-mismatch" then return "TRUNCATED" end
            if failure == "read-throw" then error("read unavailable") end
        end
        return load(path)
    end
    Ext.Json.Stringify = function(value)
        if value.phase == "before-cleanup" then
            serializations = serializations + 1
            if failure == "serialize-throw" then error("serialization failed") end
            if failure == "serialize-nonstring" then return {} end
            if failure == "oversized" then return string.rep("x", 1048577) end
        end
        return stringify(value)
    end
    if failure == "log-throw" then Ext.Utils.PrintError = function() error("logger unavailable") end end
    local initialCode, initialMessage = string.rep("C", 100), string.rep("M", 4000)
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(context)
            context:Assert("owned-actor", true, "Owned actor was observed")
            context:Defer(function() cleaned = true end)
            if failure == "clock-throw" then
                local clock = Ext.Timer.ClockEpoch
                Ext.Timer.ClockEpoch = function()
                    Ext.Timer.ClockEpoch = clock
                    error("clock temporarily unavailable")
                end
            end
            context:Error(initialCode, initialMessage)
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_DIAGNOSTIC_FAILURE", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_DIAGNOSTIC_FAILURE", command(runId))
    environment.SessionLoaded(); environment.RunLatestTimer()
    local result = assert(environment.SavedValue(runRoot .. "/result.json"))
    assert(cleaned and result.status == "error" and result.error.code == initialCode
        and result.error.message == initialMessage, "Diagnostic failure replaced the error or prevented cleanup: " .. failure)
    local failedSerialization = failure:find("serialize-", 1, true) ~= nil or failure == "oversized"
    assert(serializations == (failure == "clock-throw" and 0 or 1)
        and writes == ((failedSerialization or failure == "clock-throw") and 0 or 1),
        "Diagnostic exceeded the byte limit or scheduled a delayed retry")
    assert(reads == ((failure == "read-mismatch" or failure == "read-throw") and 1 or 0),
        "Diagnostic read-back did not follow a successful write")
    if failure ~= "log-throw" then
        local logs = environment.PrintedErrors()
        assert(#logs == 1 and logs[1]:find(runId, 1, true)
            and logs[1]:find("initialStatus=error", 1, true) and logs[1]:find("assertionCount=1", 1, true)
            and logs[1]:find(initialCode, 1, true) and logs[1]:find(initialMessage, 1, true)
            and #logs[1] < 4500, "Bounded log fallback lost the initial failure: " .. failure)
    end
    assert(environment.AutoSaveRequests() == 0 and not environment.CanAutoSave())
end

do
    local environment = createEnvironment()
    local runId = "run-cleanup-diagnostic-limit"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local save, load, stringify = Ext.IO.SaveFile, Ext.IO.LoadFile, Ext.Json.Stringify
    local serializedBytes, readBacks = nil, 0
    Ext.Json.Stringify = function(value)
        local contents = stringify(value)
        if value.phase == "before-cleanup" then return string.rep("x", 1048576) end
        return contents
    end
    Ext.IO.SaveFile = function(path, contents)
        if path == runRoot .. "/server-before-cleanup.json" then serializedBytes = #contents end
        return save(path, contents)
    end
    Ext.IO.LoadFile = function(path)
        if path == runRoot .. "/server-before-cleanup.json" then readBacks = readBacks + 1 end
        return load(path)
    end
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(context)
            for i = 1, 4096 do
                local id = string.format("%04d", i) .. string.rep("a", 96)
                context:Assert(id, i ~= 4096, "Observed native state")
            end
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_DIAGNOSTIC_LIMIT", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_DIAGNOSTIC_LIMIT", command(runId))
    environment.SessionLoaded(); environment.RunLatestTimer()
    local diagnostic = assert(environment.SavedValue(runRoot .. "/server-before-cleanup.json"))
    assert(serializedBytes == 1048576 and readBacks == 1 and #environment.PrintedErrors() == 0)
    assert(diagnostic.assertionCount == 4096 and #diagnostic.assertions == 4096
        and #diagnostic.assertions[4096].id == 100 and diagnostic.assertions[4096].passed == false)
    assert(environment.SavedValue(runRoot .. "/result.json").status == "failed")
end

for _, behavior in ipairs({ "settles", "timeout", "throws", "invalid", "timer-error", "scenario-error" }) do
    local runId = "run-cleanup-barrier-" .. behavior
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local removed, settled = false, false
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(context)
            context:Defer(function() removed = true end)
            context:BeforeCleanup("preview closed", function()
                assert(not removed, "Fixture was removed before client cancellation")
                if behavior == "throws" then error("client query failed") end
                if behavior == "invalid" then return nil end
                if behavior == "timer-error" then
                    local wait = Ext.Timer.WaitForRealtime
                    Ext.Timer.WaitForRealtime = function()
                        Ext.Timer.WaitForRealtime = wait
                        error("timer unavailable")
                    end
                end
                return settled
            end)
            if behavior == "scenario-error" then
                context:Error("fixture-nesting-timeout", "Timed out waiting for the source bag owner")
            else context:Finish() end
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_BARRIER", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_BARRIER", command(runId))
    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(not removed, "Unsettled client task allowed fixture deletion")
    if behavior == "settles" or behavior == "timeout" or behavior == "scenario-error" then
        assert(environment.SavedValue(runRoot .. "/server-finalizing.json") == nil,
            "Client producer was closed before its task settled")
        settled = behavior == "settles"
        for _ = 1, 51 do
            if environment.SavedValue(runRoot .. "/result.json") then break end
            environment.RunLatestTimer()
        end
    end
    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result, "Cleanup barrier did not terminate")
    if behavior == "settles" then
        assert(removed and result.status == "passed", "Closed task did not release cleanup")
    else
        assert(not removed and result.status == "error" and result.error.code == "scenario-cleanup-barrier-error",
            "Client cleanup failure deleted a potentially referenced fixture")
        if behavior == "scenario-error" then
            assert(result.error.message:find("fixture-nesting-timeout", 1, true)
                and result.error.message:find("Timed out waiting for the source bag owner", 1, true),
                "Cleanup barrier erased the original scenario failure")
        end
    end
end

for _, behavior in ipairs({ "settles", "timeout", "throws", "invalid" }) do
    local runId = "run-creation-cleanup-barrier-" .. behavior
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local cleaned, settled, heldContext = false, false, nil
    environment.Harness.RegisterScenario({
        Id = "example.background-creation", Mode = "character-creation", SavePolicy = "create-test-fixture",
        Run = function(context)
            heldContext = context
            assert(not pcall(context.CreateFixture, context), "Creation must not authorize runtime fixtures")
            context:Assert("creation-valid", true, "The new avatar passed validation")
            context:Defer(function() cleaned = true end)
            context:BeforeCleanup("new avatar level-up page closed", function()
                assert(not cleaned and environment.AutoSaveRequests() == 0,
                    "Creation saved or cleaned up before its UI barrier settled")
                if behavior == "throws" then error("Cannot observe the level-up page") end
                if behavior == "invalid" then return nil end
                return settled
            end)
            assert(context:RequestTestSave())
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CREATION_BARRIER", creationArm(runId, nil, { "creation-valid" }))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_CREATION_BARRIER",
        creationCommand(runId, nil, { "creation-valid" }))
    environment.SessionLoaded(); environment.RunLatestTimer()
    assert(not cleaned and environment.AutoSaveRequests() == 0)
    assert(not pcall(heldContext.BeforeCleanup, heldContext, "late barrier", function() return true end),
        "A finalizing context accepted another barrier")
    settled = behavior == "settles"
    for _ = 1, 60 do
        if environment.SavedValue(runRoot .. "/result.json") then break end
        environment.RunLatestTimer()
    end
    local result = assert(environment.SavedValue(runRoot .. "/result.json"))
    if behavior == "settles" then
        assert(cleaned and result.status == "passed" and environment.AutoSaveRequests() == 1,
            "A settled creation barrier did not permit exactly one authorized save")
    else
        assert(not cleaned and result.status == "error" and result.error.code == "scenario-cleanup-barrier-error"
            and environment.AutoSaveRequests() == 0, "Unsettled creation UI escaped the save gate")
    end
end

for _, behavior in ipairs({ "settles", "timeout", "throws" }) do
    local runId = "run-cleanup-check-" .. behavior
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local removed, settled = false, false
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(context)
            context:Defer(function() removed = true end)
            context:DeferCheck("passive removal", function()
                assert(removed, "Cleanup was checked before requesting removal")
                if behavior == "throws" then error("query failed") end
                return settled
            end)
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CLEANUP_CHECK", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_CLEANUP_CHECK", command(runId))
    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(removed, "Scenario did not request cleanup")
    if behavior ~= "throws" then
        assert(environment.SavedValue(runRoot .. "/result.json") == nil,
            "Result was published before asynchronous cleanup settled")
        settled = behavior == "settles"
        for _ = 1, 51 do
            if environment.SavedValue(runRoot .. "/result.json") ~= nil then break end
            environment.RunLatestTimer()
        end
    end
    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil, "Cleanup verification did not terminate")
    if behavior == "settles" then
        assert(result.status == "passed", "Settled cleanup did not preserve success")
    else
        assert(result.status == "error" and result.error.code == "scenario-cleanup-error")
        assert(result.error.message:find("passive removal", 1, true), "Cleanup failure lost its label")
    end
end

do
    local environment = createEnvironment()
    environment.SessionLoaded()
    assert(environment.TimerCount() == 0, "Test harness polled without an armed run")
end

do
    local invalidArm = arm("run-invalid-arm-deadline")
    invalidArm.timeoutMs = invalidArm.timeoutMs - 1
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_INVALID_DEADLINE", invalidArm)

    environment.SessionLoaded()

    assert(environment.TimerCount() == 0, "Test harness accepted an incoherent arm deadline")
end

do
    local runId = "run-single-poll"
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_SINGLE_POLL", arm(runId))

    environment.SessionLoaded()
    environment.SessionLoaded()

    assert(environment.TimerCount() == 1, "Test harness armed the same run more than once")
end

do
    local runId = "run-success"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Assert(
                "resistance-bypassed",
                true,
                "The mechanic ignored resistance for the marked hit"
            )
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_SUCCESS", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_SUCCESS", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil, "Test harness did not write a result")
    assert(result.schemaVersion == 2, "Test harness wrote the wrong schema version")
    assert(result.runId == runId, "Test harness wrote the wrong runId")
    assert(result.status == "passed", "Test harness did not pass the scenario")
    assert(#result.assertions == 1, "Test harness lost the scenario assertion")
    assert(result.assertions[1].id == "resistance-bypassed", "Test harness wrote the wrong assertion")
    local ready = environment.SavedValue(runRoot .. "/server-ready.json")
    assert(ready ~= nil and ready.status == "ready", "Server did not publish its authority marker")
end

for _, finalizationPending in ipairs({ false, true }) do
    local runId = "run-fixture-capability-" .. tostring(finalizationPending)
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment({ FinalizingSaveFileFailures = finalizationPending and 1 or 0 })
    local actor = "11111111-2222-3333-4444-555555555555"
    local boost = "Ability(Strength,1)"
    local boosted = false
    local scenarioContext = nil
    local fixture = nil
    Osi.AddBoosts = function(target, definition)
        assert(target == actor and definition == boost, "Fixture mutated an unexpected actor")
        boosted = true
    end
    Osi.RemoveBoosts = function(target, definition)
        assert(target == actor and definition == boost, "Fixture cleaned an unexpected actor")
        boosted = false
    end
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            scenarioContext = context
            fixture = context:CreateFixture()
            fixture:Boost(actor, boost, "HARNESS_TEST_FIXTURE", actor)
            context:Assert("fixture-active", boosted, "Active runtime fixture applied its setup")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_FIXTURE_CAPABILITY", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_FIXTURE_CAPABILITY", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    assert(scenarioContext ~= nil and fixture ~= nil, "Active runtime did not create its fixture")
    assert(not boosted, "Finishing the scenario did not undo fixture setup")
    assert(environment.AutoSaveRequests() == 0, "Runtime fixture requested a save")
    local result = environment.SavedValue(runRoot .. "/result.json")
    if finalizationPending then
        assert(result == nil, "Expected fixture test to remain in finalization")
    else
        assert(result ~= nil and result.status == "passed", "Runtime fixture scenario did not pass")
    end
    local created, creationError = pcall(function()
        scenarioContext:CreateFixture()
    end)
    assert(not created, "Inactive scenario created another fixture")
    assert(
        tostring(creationError):find("active runtime scenario without saving", 1, true) ~= nil,
        "Inactive fixture creation failed for an unrelated reason"
    )
    local mutated, mutationError = pcall(function()
        fixture:Boost(actor, boost, "HARNESS_TEST_FIXTURE_LATE", actor)
    end)
    assert(not mutated and tostring(mutationError):find("fixture is closed", 1, true) ~= nil,
        "Finished scenario retained a usable fixture")
    assert(not boosted, "Closed fixture applied a late mutation")
end

do
    local runId = "run-creation-fixture-denied"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            context:CreateFixture()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CREATION_FIXTURE_DENIED", creationArm(runId))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_CREATION_FIXTURE_DENIED",
        creationCommand(runId)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Creation accepted a runtime fixture")
    assert(result.error.code == "scenario-error", "Denied fixture used the wrong error code")
    assert(
        result.error.message:find("active runtime scenario without saving", 1, true) ~= nil,
        "Creation fixture failed for an unrelated reason"
    )
    assert(environment.AutoSaveRequests() == 0, "Denied fixture triggered a save")
end

do
    local runId = "run-character-creation"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            assert(context:RequestTestSave(), "Character creation save request was denied")
            context:Assert("new-campaign", true, "New campaign command was accepted")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CREATION", creationArm(runId, nil, { "new-campaign" }))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_CREATION",
        creationCommand(runId, nil, { "new-campaign" })
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "passed", "Character creation command did not execute")
end

do
    local invalidArm = creationArm("run-disallowed-creation-save")
    invalidArm.saveId = "ProtectedSave"
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_DISALLOWED_CREATION_SAVE", invalidArm)

    environment.SessionLoaded()

    assert(environment.TimerCount() == 0, "Character creation arm accepted a named save")
end

do
    local runId = "run-cleanup"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local cleaned = false
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Defer(function()
                cleaned = true
            end)
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CLEANUP", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_CLEANUP", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    assert(cleaned, "Test harness did not run scenario cleanup")
    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "passed", "Scenario cleanup changed a passing result")
end

do
    local runId = "run-invalid-json"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_INVALID", arm(runId))
    environment.PutInvalidFile(runRoot .. "/command.json")

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil, "Test harness did not report invalid command JSON")
    assert(result.status == "error", "Invalid command JSON did not produce an error")
    assert(result.error.code == "invalid-command", "Invalid command JSON produced the wrong error")
end

do
    local runId = "run-invalid-command-deadline"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local invalidCommand = command(runId)
    invalidCommand.createdAtEpochMs = 500
    invalidCommand.timeoutMs = 9500
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_COMMAND_DEADLINE", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_BAD_DEADLINE", invalidCommand)

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil, "Test harness did not reject an incoherent command deadline")
    assert(result.status == "error", "Incoherent command deadline did not produce an error")
    assert(result.error.code == "invalid-command", "Incoherent command produced the wrong error")
end

do
    local runId = "run-timeout"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_TIMEOUT", arm(runId))

    environment.SessionLoaded()
    environment.SetEpochMilliseconds(11000)
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil, "Test harness did not report a command timeout")
    assert(result.status == "error", "Command timeout did not produce an error")
    assert(result.error.code == "command-timeout", "Command timeout produced the wrong error")
    assert(
        result.startedAtEpochMs == 10000 and result.completedAtEpochMs == 10000,
        "Command timeout timestamps escaped the armed run window"
    )
end

do
    local runId = "run-generic-scenario"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local selectedArm = arm(runId)
    local selectedCommand = command(runId)
    selectedArm.scenarioId = "second.generic-runtime"
    selectedCommand.scenarioId = selectedArm.scenarioId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = selectedArm.scenarioId,
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Assert("generic-runtime", true, "A second registered scenario ran")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_GENERIC", selectedArm)
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_GENERIC", selectedCommand)

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "passed", "A generic registered scenario did not run")
    assert(result.scenarioId == selectedArm.scenarioId, "Generic scenario result lost its id")
end

do
    local environment = createEnvironment()
    local definition = {
        Id = "generic.duplicate",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function() end
    }
    environment.Harness.RegisterScenario(definition)
    local registered, registrationError = pcall(environment.Harness.RegisterScenario, definition)
    assert(not registered, "Duplicate scenario registration was accepted")
    assert(
        tostring(registrationError):find("already registered", 1, true) ~= nil,
        "Duplicate scenario registration produced the wrong error"
    )
end

do
    local runId = "run-mode-mismatch"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function()
            error("A scenario with the wrong mode must not run")
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_MODE_MISMATCH", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_MODE_MISMATCH", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Scenario mode mismatch did not fail")
    assert(result.error.code == "scenario-mode-mismatch", "Scenario mode mismatch used the wrong error code")
end

do
    local runId = "run-callback-error"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function()
            error("callback exploded")
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CALLBACK_ERROR", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_CALLBACK_ERROR", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Scenario callback failure did not fail the run")
    assert(result.error.code == "scenario-error", "Scenario callback failure used the wrong error code")
    assert(result.error.message:find("callback exploded", 1, true) ~= nil, "Scenario callback failure lost its message")
end

do
    local runId = "run-duplicate-assertion"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Assert("same-id", true, "First assertion")
            context:Assert("same-id", true, "Duplicate assertion")
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_DUPLICATE_ASSERTION", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_DUPLICATE_ASSERTION", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Duplicate assertion did not fail the run")
    assert(result.error.code == "scenario-error", "Duplicate assertion used the wrong error code")
end

do
    local runId = "run-cleanup-error"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Defer(function()
                error("cleanup exploded")
            end)
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CLEANUP_ERROR", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_CLEANUP_ERROR", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Cleanup failure did not fail the run")
    assert(result.error.code == "scenario-cleanup-error", "Cleanup failure used the wrong error code")
    assert(result.error.message:find("cleanup exploded", 1, true) ~= nil, "Cleanup failure lost its message")
end

do
    local runId = "run-cleanup-before-finalization-retry"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local cleaned = false
    local environment = createEnvironment({ FinalizingSaveFileFailures = 1 })
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Defer(function()
                cleaned = true
            end)
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CLEANUP_BEFORE_RETRY", arm(runId))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_CLEANUP_BEFORE_RETRY",
        command(runId)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()

    assert(
        cleaned,
        "Scenario cleanup did not freeze immediately when finalization began"
    )
    assert(
        environment.SavedValue(runRoot .. "/result.json") == nil,
        "Finalization retry test persisted a result before its marker retry"
    )
end

do
    local runId = "run-scenario-timeout"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function() end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_SCENARIO_TIMEOUT", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_SCENARIO_TIMEOUT", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()
    environment.SetEpochMilliseconds(10001)
    environment.RunTimer(2)

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Scenario timeout did not fail the run")
    assert(result.error.code == "scenario-timeout", "Scenario timeout used the wrong error code")
    assert(
        result.completedAtEpochMs == 10000,
        "Scenario timeout completion escaped the command window"
    )
end

do
    local runId = "run-timer-cancel-failure"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment({ CancelFails = true })
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Assert("completed", true, "Scenario completed before timer cancellation")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_TIMER_CANCEL_FAILURE", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_TIMER_CANCEL_FAILURE", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "passed", "Timer cancellation failure lost the scenario result")
end

do
    local invalidArm = arm("run-runtime-plan")
    invalidArm.creationPlan = creationArm("unused").creationPlan
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_RUNTIME_PLAN", invalidArm)

    environment.SessionLoaded()

    assert(environment.TimerCount() == 0, "Runtime arm accepted a character creation plan")
end

do
    local runId = "run-plan-mismatch"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local selectedCommand = creationCommand(runId)
    selectedCommand.creationPlan.backgroundUuid = "00000000-0000-0000-0000-000000000002"
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_PLAN_MISMATCH", creationArm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_PLAN_MISMATCH", selectedCommand)

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Mismatched creation plan did not fail the run")
    assert(result.error.code == "invalid-command", "Mismatched creation plan used the wrong error code")
end

do
    local invalidArm = arm("run-path-like-save")
    invalidArm.saveId = "../escape"
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "ARM_PATH_LIKE_SAVE", invalidArm)

    environment.SessionLoaded()

    assert(environment.TimerCount() == 0, "A path-like save armed the runtime harness")
end

do
    local environment = createEnvironment()
    local registered, registrationError = pcall(environment.Harness.RegisterScenario, {
        Id = "generic.missing-save-policy",
        Mode = "runtime",
        Run = function() end
    })
    assert(not registered, "Scenario registration accepted a missing save policy")
    assert(
        tostring(registrationError):find("save policy", 1, true) ~= nil,
        "Missing save policy produced the wrong registration error"
    )
end

do
    local environment = createEnvironment()
    local registered, registrationError = pcall(environment.Harness.RegisterScenario, {
        Id = "generic.creation-never",
        Mode = "character-creation",
        SavePolicy = "never",
        Run = function() end
    })
    assert(not registered, "Character creation registered with a never save policy")
    assert(
        tostring(registrationError):find("create test saves", 1, true) ~= nil,
        "Disallowed character creation policy produced the wrong error"
    )
end

do
    local environment = createEnvironment()
    local registered, registrationError = pcall(environment.Harness.RegisterScenario, {
        Id = "generic.runtime-discard",
        Mode = "runtime",
        SavePolicy = "discard-campaign",
        Run = function() end
    })
    assert(not registered, "A runtime scenario registered with the discard-campaign policy")
    assert(tostring(registrationError):find("never save policy", 1, true) ~= nil,
        "Runtime discard policy produced the wrong registration error: " .. tostring(registrationError))
    assert(pcall(environment.Harness.RegisterScenario, {
        Id = "generic.creation-discard", Mode = "character-creation", SavePolicy = "discard-campaign", Run = function() end
    }), "A character creation scenario could not discard its campaign")
end

-- A discard-campaign creation passes without a save request and can never obtain one.
do
    local runId = "run-discard-campaign"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local requested, requestError
    environment.Harness.RegisterScenario({
        Id = "example.background-creation", Mode = "character-creation", SavePolicy = "discard-campaign",
        Run = function(context)
            requested, requestError = context:RequestTestSave()
            assert(not pcall(context.BeforeCleanup, context, "barrier", function() return true end),
                "A discard-campaign run acquired a pre-save barrier")
            -- A discarded campaign never saves, so it may cast through a fixture; its cleanup
            -- checks stay limited to runtime scenarios.
            local created, fixture = pcall(context.CreateFixture, context)
            assert(created and type(fixture) == "table" and type(fixture.CastSpell) == "function",
                "A discard-campaign run could not obtain a fixture: " .. tostring(fixture))
            assert(not pcall(context.DeferCheck, context, "check", function() return true end),
                "A discard-campaign run acquired a runtime cleanup check")
            context:Assert("creation-valid", true, "Creation fixture is valid")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_DISCARD", creationArm(runId, "discard-campaign", { "creation-valid" }))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_DISCARD",
        creationCommand(runId, "discard-campaign", { "creation-valid" }))
    environment.SessionLoaded()
    environment.RunLatestTimer()
    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(requested == false and requestError == "scenario-save-policy-denied", "A discard-campaign run obtained a save request")
    assert(result ~= nil and result.status == "passed", "A passing discard-campaign run did not pass: "
        .. tostring(result and result.error and result.error.code))
    assert(environment.SavedValue(runRoot .. "/save-intent.json") == nil, "A discard-campaign run published a save intent")
    assert(environment.AutoSaveRequests() == 0, "A discard-campaign run executed AutoSave")
end

-- The discard policy belongs to the new campaign only; arm, command and registration must agree.
do
    local environment = createEnvironment()
    local selectedArm = arm("run-runtime-discard")
    selectedArm.savePolicy = "discard-campaign"
    environment.PutParsedFile(ARM_PATH, "ARM_RUNTIME_DISCARD", selectedArm)
    environment.SessionLoaded()
    assert(environment.TimerCount() == 0, "A runtime arm with the discard policy armed the server")
end
for _, case in ipairs({ { Registered = "create-test-fixture", Commanded = "discard-campaign" },
    { Registered = "discard-campaign", Commanded = "create-test-fixture" } }) do
    local runId = "run-discard-mismatch-" .. case.Commanded
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local started = false
    environment.Harness.RegisterScenario({ Id = "example.background-creation", Mode = "character-creation",
        SavePolicy = case.Registered, Run = function() started = true end })
    environment.PutParsedFile(ARM_PATH, "ARM_DISCARD_MISMATCH", creationArm(runId, case.Commanded, { "creation-valid" }))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_DISCARD_MISMATCH",
        creationCommand(runId, case.Commanded, { "creation-valid" }))
    environment.SessionLoaded()
    environment.RunLatestTimer()
    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(not started and result ~= nil and result.error.code == "scenario-save-policy-mismatch",
        "A scenario ran under another creation save policy")
end

for _, starts in ipairs({ true, false }) do
    local runId = "run-deferred-autosave-" .. tostring(starts)
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment({ DeferredAutoSave = true })
    environment.Harness.RegisterScenario({
        Id = "example.background-creation", Mode = "character-creation", SavePolicy = "create-test-fixture",
        Run = function(context)
            context:Assert("ready", true, "Creation is ready")
            assert(context:RequestTestSave())
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "DEFERRED_ARM", creationArm(runId, nil, { "ready" }))
    environment.PutParsedFile(runRoot .. "/command.json", "DEFERRED_COMMAND", creationCommand(runId, nil, { "ready" }))
    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(environment.CanAutoSave(), "Autosave gate closed before the queued engine request was processed")
    if not starts then
        environment.SetEpochMilliseconds(5000)
        environment.RunLatestTimer()
        local result = environment.SavedValue(runRoot .. "/result.json")
        assert(result ~= nil and result.status == "error", "Missing Save event lost the result")
        assert(result.error.code == "test-save-start-timeout", "Missing Save event used the wrong error")
        assert(not environment.CanAutoSave(), "Missing Save event left the gate open")
    else
        environment.ProcessAutoSave()
        assert(not environment.CanAutoSave(), "Autosave gate stayed open after Save started")
        environment.RunLatestTimer()
        environment.RunLatestTimer()
        local result = environment.SavedValue(runRoot .. "/result.json")
        assert(result ~= nil and result.status == "passed", "Deferred engine save did not complete")
    end
    assert(environment.AutoSaveRequests() == 1, "Deferred request was retried")
end

for _, failure in ipairs({ "missing", "lookup", "call" }) do
    local runId = "run-autosave-error-" .. failure
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    Osi = setmetatable({}, {
        __index = function(_, name)
            assert(name == "AutoSave", "Unexpected Osiris lookup")
            if failure == "lookup" then error("lookup failed") end
            if failure == "missing" then return nil end
            return setmetatable({}, { __call = function() error("request failed") end })
        end
    })
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            context:Assert("creation-ready", true, "New campaign is ready")
            assert(context:RequestTestSave())
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_SAVE_FAILURE", creationArm(runId, nil, { "creation-ready" }))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_SAVE_FAILURE", creationCommand(runId, nil, { "creation-ready" }))
    environment.SessionLoaded()
    environment.RunLatestTimer()
    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Autosave failure lost the terminal result")
    assert(result.error.code == "test-save-request-failed", "Autosave failure reported the wrong code")
    assert(environment.AutoSaveRequests() == 0, "Failed autosave was counted as requested")
    local events = environment.ProtocolEvents()
    assert(events[#events] == "autosave-gate-closed", "Autosave error left the save gate open")
end

do
    local runId = "run-creation-capability"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            local plan = context:GetCreationPlan()
            context:Assert(
                "creation-plan-exposed",
                plan ~= nil and plan.backgroundUuid == BACKGROUND_UUID,
                "Scenario received its validated creation plan"
            )
            plan.backgroundUuid = "00000000-0000-0000-0000-000000000099"
            local secondPlan = context:GetCreationPlan()
            context:Assert(
                "creation-plan-isolated",
                secondPlan.backgroundUuid == BACKGROUND_UUID,
                "Scenario could not mutate the command creation plan"
            )
            local requested, requestError = context:RequestTestSave()
            context:Assert(
                "test-save-requested",
                requested and requestError == nil,
                "Opt-in creation scenario requested its test fixture save"
            )
            context:Finish()
        end
    })
    local requiredAssertionIds = {
        "creation-plan-exposed",
        "creation-plan-isolated",
        "test-save-requested"
    }
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_CREATION_CAPABILITY",
        creationArm(runId, "create-test-fixture", requiredAssertionIds)
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_CREATION_CAPABILITY",
        creationCommand(runId, "create-test-fixture", requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(environment.AutoSaveRequests() == 1, "Passing creation run did not execute its deferred autosave")
    assert(
        environment.SavedValue(runRoot .. "/result.json") == nil,
        "Creation result was published before the autosave settlement window"
    )
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "passed", "Creation capability scenario did not pass")
    assert(environment.AutoSaveRequests() == 1, "Creation capability did not request exactly one autosave")
    local intent = environment.SavedValue(runRoot .. "/save-intent.json")
    local request = environment.SavedValue(runRoot .. "/save-request.json")
    assert(intent ~= nil and intent.intentId == runId .. ".save1", "Creation capability did not persist its save intent")
    assert(request ~= nil and request.intentId == intent.intentId, "Save request did not correlate to its intent")
    assert(
        table.concat(environment.ProtocolEvents(), ",")
            == "server-finalizing,save-intent,save-request,autosave-gate-open,autosave,autosave-gate-closed",
        "Authorized save operations ran out of order"
    )
end

do
    local runId = "run-save-intent-without-ack"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local requiredAssertionIds = { "creation-valid" }
    local environment = createEnvironment({ AutoAcknowledgeSaveIntent = false })
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            assert(context:RequestTestSave(), "Save request was denied")
            context:Assert("creation-valid", true, "Creation fixture is valid")
            context:Finish()
        end
    })
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_SAVE_INTENT_NO_ACK",
        creationArm(runId, nil, requiredAssertionIds)
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_SAVE_INTENT_NO_ACK",
        creationCommand(runId, nil, requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(environment.SavedValue(runRoot .. "/save-intent.json") ~= nil, "Server did not publish its save intent")
    assert(environment.AutoSaveRequests() == 0, "Server saved before Node acknowledged the intent")
    environment.SetEpochMilliseconds(5000)
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.error.code == "test-save-intent-timeout", "Missing intent ack did not fail closed")
    assert(environment.AutoSaveRequests() == 0, "Missing intent ack still executed AutoSave")
end

do
    local runId = "run-save-ack-temporal-order"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local requiredAssertionIds = { "creation-valid" }
    local environment = createEnvironment({ AutoAcknowledgeSaveIntent = false })
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            assert(context:RequestTestSave(), "Save request was denied")
            context:Assert("creation-valid", true, "Creation fixture is valid")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_ACK_ORDER", creationArm(runId, nil, requiredAssertionIds))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_ACK_ORDER",
        creationCommand(runId, nil, requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    environment.PutParsedFile(runRoot .. "/save-intent-ack.json", "SAVE_ACK_ORDER", {
        schemaVersion = 2,
        runId = runId,
        scenarioId = "example.background-creation",
        status = "acknowledged",
        intentId = runId .. ".save1",
        acknowledgedAtEpochMs = 2500
    })
    environment.RunLatestTimer()

    local request = environment.SavedValue(runRoot .. "/save-request.json")
    assert(request ~= nil and request.requestedAtEpochMs >= 2500, "Save request predates its Node acknowledgement")
end

do
    local runId = "run-save-near-deadline"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local requiredAssertionIds = { "creation-valid" }
    local environment = createEnvironment({ InitialEpochMilliseconds = 9000 })
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            assert(context:RequestTestSave(), "Save request was denied")
            context:Assert("creation-valid", true, "Creation fixture is valid")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_NEAR_DEADLINE", creationArm(runId, nil, requiredAssertionIds))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_NEAR_DEADLINE",
        creationCommand(runId, nil, requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.error.code == "test-save-deadline-insufficient", "Near-deadline save did not fail closed")
    assert(environment.AutoSaveRequests() == 0, "Near-deadline scenario executed AutoSave")
end

do
    local runId = "run-client-error-cancels"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local cleaned = false
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            context:Defer(function()
                cleaned = true
            end)
        end
    })
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_CLIENT_ERROR",
        creationArm(runId, "create-test-fixture", { "creation-complete" })
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_CLIENT_ERROR",
        creationCommand(runId, "create-test-fixture", { "creation-complete" })
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    environment.PutParsedFile(runRoot .. "/client-error.json", "CLIENT_ERROR", clientError(runId))
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Client error did not cancel the server scenario")
    assert(result.error.code == "background-not-found", "Server lost the client error code")
    assert(cleaned, "Client error did not run scenario cleanup")
    assert(environment.AutoSaveRequests() == 0, "Failed client run requested an autosave")
end

do
    local runId = "run-save-after-failed-assertion"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local requiredAssertionIds = { "late-failure" }
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            local requested = context:RequestTestSave()
            assert(requested, "Opt-in save request was denied")
            context:Assert("late-failure", false, "A later assertion failed")
            context:Finish()
        end
    })
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_SAVE_AFTER_FAILURE",
        creationArm(runId, "create-test-fixture", requiredAssertionIds)
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_SAVE_AFTER_FAILURE",
        creationCommand(runId, "create-test-fixture", requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "failed", "Late failed assertion did not fail the run")
    assert(environment.AutoSaveRequests() == 0, "Failed assertion still executed the deferred autosave")
end

do
    local runId = "run-duplicate-save-request"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local requiredAssertionIds = { "creation-valid" }
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            assert(context:RequestTestSave(), "First save request was denied")
            assert(context:RequestTestSave(), "Idempotent save request was denied")
            context:Assert("creation-valid", true, "Creation fixture is valid")
            context:Finish()
        end
    })
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_DUPLICATE_SAVE",
        creationArm(runId, "create-test-fixture", requiredAssertionIds)
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_DUPLICATE_SAVE",
        creationCommand(runId, "create-test-fixture", requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(environment.AutoSaveRequests() == 1, "Duplicate requests executed more than one autosave")
    environment.RunLatestTimer()
    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "passed", "Idempotent save request did not pass")
end

do
    local runId = "run-save-without-manifest"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            local requested, requestError = context:RequestTestSave()
            context:Assert(
                "save-denied",
                not requested and requestError == "scenario-required-assertions-missing",
                "Save request without an assertion manifest was denied"
            )
            context:Finish()
        end
    })
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_SAVE_WITHOUT_MANIFEST",
        creationArm(runId, "create-test-fixture", {})
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_SAVE_WITHOUT_MANIFEST",
        creationCommand(runId, "create-test-fixture", {})
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Denied save request did not fail closed")
    assert(result.error.code == "test-save-not-requested", "Denied save request used the wrong terminal error")
    assert(environment.AutoSaveRequests() == 0, "Empty assertion manifest executed an autosave")
end

do
    local runId = "run-save-settle-schedule-failure"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local requiredAssertionIds = { "creation-valid" }
    local environment = createEnvironment({ WaitForRealtimeFailureAt = 4 })
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            assert(context:RequestTestSave(), "Save request was denied")
            context:Assert("creation-valid", true, "Creation fixture is valid")
            context:Finish()
        end
    })
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_SETTLE_FAILURE",
        creationArm(runId, "create-test-fixture", requiredAssertionIds)
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_SETTLE_FAILURE",
        creationCommand(runId, "create-test-fixture", requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Settlement scheduling failure reported passed")
    assert(
        result.error.code == "test-save-settle-schedule-failed",
        "Settlement scheduling failure used the wrong error code"
    )
    assert(environment.AutoSaveRequests() == 1, "Settlement failure retried the autosave effect")
end

do
    local runId = "run-required-assertion-omitted"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local requiredAssertionIds = { "must-be-emitted" }
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            assert(context:RequestTestSave(), "Manifest-backed save request was denied")
            context:Finish()
        end
    })
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_REQUIRED_OMITTED",
        creationArm(runId, "create-test-fixture", requiredAssertionIds)
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_REQUIRED_OMITTED",
        creationCommand(runId, "create-test-fixture", requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Missing required assertion did not error")
    assert(result.error.code == "required-assertions-missing", "Missing assertion used the wrong error code")
    assert(environment.AutoSaveRequests() == 0, "Missing required assertion executed an autosave")
end

do
    local runId = "run-startup-error-cancels"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local scenarioRan = false
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function()
            scenarioRan = true
        end
    })
    environment.PutParsedFile(
        ARM_PATH,
        "ARM_STARTUP_ERROR",
        creationArm(runId, "create-test-fixture", { "creation-valid" })
    )
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_STARTUP_ERROR",
        creationCommand(runId, "create-test-fixture", { "creation-valid" })
    )
    environment.PutParsedFile(
        runRoot .. "/startup-error.json",
        "STARTUP_ERROR",
        startupError(runId)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Startup error did not become the server result")
    assert(result.error.code == "movie-skip-timeout", "Server lost the startup error code")
    assert(not scenarioRan, "Server executed a scenario after startup had already failed")
    assert(environment.AutoSaveRequests() == 0, "Startup failure executed an autosave")
end

do
    local runId = "run-initial-partial-client-error"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local scenarioRan = false
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function()
            scenarioRan = true
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_INITIAL_PARTIAL", creationArm(runId))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_INITIAL_PARTIAL",
        creationCommand(runId)
    )
    environment.PutInvalidFile(runRoot .. "/client-error.json")

    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(not scenarioRan, "Server ran a scenario while an initial client artifact was partial")
    assert(environment.SavedValue(runRoot .. "/result.json") == nil, "Initial partial client artifact became terminal")
    environment.PutParsedFile(runRoot .. "/client-error.json", "INITIAL_CLIENT_ERROR", clientError(runId))
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.error.code == "background-not-found", "Settled initial client error was not arbitrated")
    assert(not scenarioRan, "Server ran a scenario after the initial client error settled")
end

do
    local runId = "run-late-client-error-before-save"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local requiredAssertionIds = { "creation-valid" }
    local environment = createEnvironment({ AutoCloseProducers = false })
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function(context)
            assert(context:RequestTestSave(), "Save request was denied")
            context:Assert("creation-valid", true, "Creation fixture is valid")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_LATE_CLIENT_ERROR", creationArm(runId, nil, requiredAssertionIds))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_LATE_CLIENT_ERROR",
        creationCommand(runId, nil, requiredAssertionIds)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(environment.AutoSaveRequests() == 0, "Server saved before producers closed")
    environment.PutParsedFile(runRoot .. "/client-error.json", "LATE_CLIENT_ERROR", clientError(runId))
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.error.code == "background-not-found", "Late client error lost arbitration")
    assert(environment.AutoSaveRequests() == 0, "Late client error arrived after an unauthorized save")
end

do
    local runId = "run-partial-client-error"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function() end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_PARTIAL_CLIENT", creationArm(runId))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_PARTIAL_CLIENT",
        creationCommand(runId)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    environment.PutInvalidFile(runRoot .. "/client-error.json")
    environment.RunLatestTimer()
    assert(
        environment.SavedValue(runRoot .. "/result.json") == nil,
        "A transient partial client artifact became a terminal result"
    )
    environment.PutParsedFile(runRoot .. "/client-error.json", "CLIENT_ERROR_STABLE", clientError(runId))
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Stable client error was not observed after a partial write")
    assert(result.error.code == "background-not-found", "Stable client error lost its code")
end

do
    local runId = "run-assertion-limit"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            for index = 1, 4097 do
                context:Assert("assertion-" .. tostring(index), true, "bounded assertion")
            end
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_ASSERTION_LIMIT", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_ASSERTION_LIMIT", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "4097 assertions did not fail the run")
    assert(result.error.code == "scenario-error", "Assertion limit used the wrong error code")
    assert(#result.assertions == 4096, "Assertion limit did not preserve the bounded prefix")
end

do
    local runId = "run-oversized-error-input"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local oversized = clientError(runId)
    oversized.error.message = string.rep("x", 4001)
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.background-creation",
        Mode = "character-creation",
        SavePolicy = "create-test-fixture",
        Run = function() end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_OVERSIZED_INPUT", creationArm(runId))
    environment.PutParsedFile(
        runRoot .. "/command.json",
        "COMMAND_OVERSIZED_INPUT",
        creationCommand(runId)
    )

    environment.SessionLoaded()
    environment.RunLatestTimer()
    environment.PutParsedFile(runRoot .. "/client-error.json", "OVERSIZED_INPUT", oversized)
    for _ = 1, 20 do
        environment.RunLatestTimer()
    end

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "error", "Oversized client error was not rejected")
    assert(result.error.code == "invalid-client-error", "Oversized client error used the wrong code")
end

do
    local runId = "run-missing-autosave-guard"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    local scenarioRan = false
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function()
            scenarioRan = true
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_MISSING_GUARD", arm(runId))
    environment.RemoveFile(runRoot .. "/autosave-guard.json")
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_MISSING_GUARD", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.error.code == "autosave-guard-missing", "Missing autosave guard did not fail closed")
    assert(not scenarioRan, "Scenario ran without the startup autosave guard")
end

do
    local runId = "run-runtime-autosave-guard-lost"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment()
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function() end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_GUARD_LOST", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_GUARD_LOST", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()
    environment.SetCanAutoSave(true)
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.error.code == "autosave-guard-lost", "Runtime guard loss did not terminate the scenario")
    assert(environment.AutoSaveRequests() == 0, "Runtime guard loss executed AutoSave")
end

do
    local runId = "run-server-clock-clamp"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local selectedArm = arm(runId)
    local selectedCommand = command(runId)
    selectedArm.createdAtEpochMs = 1500
    selectedArm.timeoutMs = 8500
    selectedCommand.createdAtEpochMs = 1500
    selectedCommand.timeoutMs = 8500
    local environment = createEnvironment({ InitialEpochMilliseconds = 1000 })
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_CLOCK_CLAMP", selectedArm)
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_CLOCK_CLAMP", selectedCommand)

    environment.SessionLoaded()
    environment.RunLatestTimer()

    local ready = environment.SavedValue(runRoot .. "/server-ready.json")
    assert(ready ~= nil and ready.readyAtEpochMs == 1500, "Server readiness predates the arm window")
    assert(environment.SavedValue(runRoot .. "/result.json") == nil, "Scenario ran before its command creation bound")
    environment.SetEpochMilliseconds(2000)
    environment.RunLatestTimer()
    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.startedAtEpochMs == 1500, "Server result predates the arm window")
end

do
    local runId = "run-result-readback-retry"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment({ ReadBackMismatches = 1 })
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Assert("readback", true, "Result read-back eventually matched")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_READBACK_RETRY", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_READBACK_RETRY", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(environment.SaveFileAttempts() == 1, "Initial result write did not occur")
    environment.RunLatestTimer()

    local result = environment.SavedValue(runRoot .. "/result.json")
    assert(result ~= nil and result.status == "passed", "Read-back retry lost the passing result")
    assert(environment.SaveFileAttempts() == 2, "Read-back mismatch was not retried exactly once")
end

do
    local runId = "run-result-write-exhausted"
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    local environment = createEnvironment({ SaveFileFailures = 1000 })
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic",
        Mode = "runtime",
        SavePolicy = "never",
        Run = function(context)
            context:Assert("write-exhausted", true, "Result writer remains bounded")
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_WRITE_EXHAUSTED", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_WRITE_EXHAUSTED", command(runId))

    environment.SessionLoaded()
    environment.RunLatestTimer()
    for _ = 2, 300 do
        environment.RunLatestTimer()
    end

    assert(environment.SaveFileAttempts() == 300, "Permanent write failure used an unbounded retry count")
    assert(
        environment.SavedValue(runRoot .. "/result.json") == nil,
        "Permanent write failure reported a result as persisted"
    )
    local logs = table.concat(environment.PrintedErrors(), "\n")
    assert(logs:find("Giving up after 300 attempts", 1, true) ~= nil, "Permanent write failure was silent")
    assert(logs:find(runId, 1, true) ~= nil, "Permanent write failure log lost the run id")
end

local ELF = "ce4b7923-bcdd-495c-b2e5-3810bf6dd9b5"
local WOOD_ELF = "5a076d0b-9b01-4edd-bafe-1d4469eacfdd"
for _, outcome in ipairs({ "match", "mismatch-race", "mismatch-subrace" }) do
    local runId = "run-server-species-" .. outcome
    local environment = createEnvironment()
    local called = false
    environment.Harness.RegisterScenario({
        Id = "example.background-creation", Mode = "character-creation", SavePolicy = "create-test-fixture",
        Run = function(context)
            called = true
            local plan = context:GetCreationPlan()
            assert(plan.raceUuid == ELF and plan.subRaceUuid == WOOD_ELF)
            plan.raceUuid, plan.subRaceUuid = "mutated", "mutated"
            local second = context:GetCreationPlan()
            assert(second.raceUuid == ELF and second.subRaceUuid == WOOD_ELF, "Species plan getter must return an isolated copy")
            context:Assert("species-plan", true, "Server received the immutable species plan")
            context:Finish()
        end
    })
    local selectedArm = creationArm(runId, nil, { "species-plan" })
    local selectedCommand = creationCommand(runId, nil, { "species-plan" })
    selectedArm.creationPlan.raceUuid, selectedArm.creationPlan.subRaceUuid = ELF, WOOD_ELF
    selectedCommand.creationPlan.raceUuid, selectedCommand.creationPlan.subRaceUuid = ELF, WOOD_ELF
    if outcome == "mismatch-race" then selectedCommand.creationPlan.raceUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    elseif outcome == "mismatch-subrace" then selectedCommand.creationPlan.subRaceUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" end
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    environment.PutParsedFile(ARM_PATH, "ARM_SPECIES", selectedArm)
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_SPECIES", selectedCommand)
    environment.SessionLoaded()
    environment.RunLatestTimer()
    assert(called == (outcome == "match"), "Server must reject a changed race or subrace before scenario execution")
    if outcome ~= "match" then
        assert(environment.SavedValue(runRoot .. "/result.json").error.code == "invalid-command")
    end
    assert(environment.AutoSaveRequests() == 0, "Protocol validation must not request a save")
end
for _, outcome in ipairs({ "missing-race", "invalid-race", "invalid-subrace" }) do
    local selectedArm = creationArm("run-server-species-" .. outcome)
    selectedArm.creationPlan.raceUuid, selectedArm.creationPlan.subRaceUuid = ELF, WOOD_ELF
    if outcome == "missing-race" then selectedArm.creationPlan.raceUuid = nil
    elseif outcome == "invalid-race" then selectedArm.creationPlan.raceUuid = "Elf"
    else selectedArm.creationPlan.subRaceUuid = "Wood Elf" end
    local environment = createEnvironment()
    environment.PutParsedFile(ARM_PATH, "INVALID_SPECIES", selectedArm)
    environment.SessionLoaded()
    assert(environment.TimerCount() == 0, "Server must not arm an invalid species plan")
end
local PASSIVE = "HarnessExample_RaceChoice_Wisdom"
for _, outcome in ipairs({ "match", "max-length", "mismatch", "case-mismatch", "missing-arm", "missing-command" }) do
    local environment, called = createEnvironment(), false
    local runId = "run-server-race-passive-" .. outcome
    local expected = outcome == "max-length" and string.rep("A", 150) or PASSIVE
    environment.Harness.RegisterScenario({ Id = "example.background-creation", Mode = "character-creation", SavePolicy = "create-test-fixture",
        Run = function(context)
            called = true
            local plan = context:GetCreationPlan()
            assert(plan.racePassiveId == expected and plan.raceUuid == ELF)
            plan.racePassiveId = "mutated"
            assert(context:GetCreationPlan().racePassiveId == expected, "Race passive getter retained a mutable alias")
            context:Assert("race-passive-plan", true, "Exact authorized race passive reached the server")
            context:Finish()
        end })
    local selectedArm = creationArm(runId, nil, { "race-passive-plan" })
    local selectedCommand = creationCommand(runId, nil, { "race-passive-plan" })
    for _, candidate in ipairs({ selectedArm, selectedCommand }) do
        candidate.creationPlan.raceUuid, candidate.creationPlan.racePassiveId = ELF, expected
    end
    if outcome == "mismatch" then selectedCommand.creationPlan.racePassiveId = "HarnessExample_Other"
    elseif outcome == "case-mismatch" then selectedCommand.creationPlan.racePassiveId = expected:lower()
    elseif outcome == "missing-arm" then selectedArm.creationPlan.racePassiveId = nil
    elseif outcome == "missing-command" then selectedCommand.creationPlan.racePassiveId = nil end
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    environment.PutParsedFile(ARM_PATH, "ARM_RACE_PASSIVE", selectedArm)
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_RACE_PASSIVE", selectedCommand)
    environment.SessionLoaded(); environment.RunLatestTimer()
    assert(called == (outcome == "match" or outcome == "max-length"), "Server accepted mismatched race passive: " .. outcome)
    if not called then assert(environment.SavedValue(runRoot .. "/result.json").error.code == "invalid-command") end
    assert(environment.AutoSaveRequests() == 0, "Transport must not request saving")
end
for index, passive in ipairs({ "", "_Passive", "1Passive", "Passive-name", "Passive name", "Passive\n", "é", string.rep("A", 151), 123, {} }) do
    for _, malformed in ipairs({ "arm", "command" }) do
        local environment = createEnvironment()
        local runId = "run-invalid-race-passive-" .. index .. "-" .. malformed
        local selectedArm, selectedCommand = creationArm(runId), creationCommand(runId)
        selectedArm.creationPlan.raceUuid, selectedArm.creationPlan.racePassiveId = ELF, PASSIVE
        selectedCommand.creationPlan.raceUuid, selectedCommand.creationPlan.racePassiveId = ELF, PASSIVE
        local target = malformed == "arm" and selectedArm or selectedCommand
        target.creationPlan.racePassiveId = passive
        local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
        environment.PutParsedFile(ARM_PATH, "ARM_BAD_PASSIVE", selectedArm)
        environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_BAD_PASSIVE", selectedCommand)
        environment.SessionLoaded()
        if malformed == "arm" then assert(environment.TimerCount() == 0, "Invalid passive armed the server")
        else
            environment.RunLatestTimer()
            assert(environment.SavedValue(runRoot .. "/result.json").error.code == "invalid-command")
        end
    end
end
for _, malformed in ipairs({ "arm", "command" }) do
    local environment = createEnvironment()
    local runId = "run-orphan-race-passive-" .. malformed
    local selectedArm, selectedCommand = creationArm(runId), creationCommand(runId)
    for _, candidate in ipairs({ selectedArm, selectedCommand }) do
        candidate.creationPlan.raceUuid, candidate.creationPlan.racePassiveId = ELF, PASSIVE
    end
    (malformed == "arm" and selectedArm or selectedCommand).creationPlan.raceUuid = nil
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    environment.PutParsedFile(ARM_PATH, "ARM_ORPHAN_PASSIVE", selectedArm)
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_ORPHAN_PASSIVE", selectedCommand)
    environment.SessionLoaded()
    if malformed == "arm" then assert(environment.TimerCount() == 0)
    else environment.RunLatestTimer(); assert(environment.SavedValue(runRoot .. "/result.json").error.code == "invalid-command") end
end
-- Context extensions add operations for one run but cannot replace the core methods.
local function extensionEnvironment(runId, extend)
    local environment, context = createEnvironment(), nil
    environment.Harness.ExtendContext(extend)
    environment.Harness.RegisterScenario({ Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(value) context = value end })
    environment.PutParsedFile(ARM_PATH, "ARM_EXTENSION_" .. runId, arm(runId))
    environment.PutParsedFile("BG3InGameHarness/TestHarness/runs/" .. runId .. "/command.json",
        "COMMAND_EXTENSION_" .. runId, command(runId))
    environment.SessionLoaded(); environment.RunLatestTimer()
    return environment, context, "BG3InGameHarness/TestHarness/runs/" .. runId .. "/"
end

do
    local seen
    local environment, context = extensionEnvironment("run-extension", function(value, run)
        seen = run
        function value:ExampleOperation() return run.IsActive() end
    end)
    assert(context ~= nil and context:ExampleOperation() == true, "Extension operation was not attached")
    assert(seen.Command.runId == "run-extension" and seen.Command.scenarioId == "example.runtime-mechanic",
        "Extension did not receive the validated command")
    local fixture = context:CreateFixture()
    assert(seen.OwnsFixture(fixture) and not seen.OwnsFixture({}), "Extension could not tell owned fixtures apart")
    assert(type(seen.EpochMilliseconds()) == "number", "Extension lacks the harness clock")
    context:Finish()
    assert(not seen.IsActive(), "A finished run still reported itself active to extensions")
    assert(environment ~= nil)
end

do
    local environment, context, prefix = extensionEnvironment("run-extension-replace", function(value)
        value.Finish = function() end
    end)
    assert(context == nil, "A scenario ran with a replaced core method")
    local result = environment.SavedValue(prefix .. "result.json")
    assert(result ~= nil and result.status == "error" and result.error.code == "scenario-error"
        and result.error.message:find("cannot replace Finish", 1, true) ~= nil,
        "Replacing a core method did not fail the run")
end

do
    local environment = createEnvironment()
    assert(not pcall(environment.Harness.ExtendContext, "not a function"), "A non-function extension was accepted")
end
print("BG3 test harness context extensions: 3 cases passed")

-- ClockEpoch counts whole seconds, so the epoch timestamps alone would say 2000 ms;
-- durationMs comes from the millisecond monotonic clock.
for _, monotonic in ipairs({ true, false }) do
    local environment = createEnvironment({ InitialEpochMilliseconds = 2400 })
    if not monotonic then Ext.Timer.MonotonicTime = nil end
    local runId = "run-duration-" .. tostring(monotonic)
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    environment.Harness.RegisterScenario({
        Id = "example.runtime-mechanic", Mode = "runtime", SavePolicy = "never",
        Run = function(context)
            context:Assert("observation", true, "Observed native state")
            environment.SetEpochMilliseconds(4100)
            context:Finish()
        end
    })
    environment.PutParsedFile(ARM_PATH, "ARM_DURATION", arm(runId))
    environment.PutParsedFile(runRoot .. "/command.json", "COMMAND_DURATION", command(runId))
    environment.SessionLoaded(); environment.RunLatestTimer()
    local result = assert(environment.SavedValue(runRoot .. "/result.json"))
    assert(result.status == "passed" and result.completedAtEpochMs - result.startedAtEpochMs == 2000,
        "Epoch timestamps changed resolution")
    if monotonic then
        assert(result.durationMs == 1700, "durationMs did not come from the monotonic clock: " .. tostring(result.durationMs))
    else
        assert(result.durationMs == nil, "durationMs was reported without a monotonic clock")
    end
end
print("BG3 test harness duration: 2 cases passed")
print("BG3 test harness runtime test passed")
