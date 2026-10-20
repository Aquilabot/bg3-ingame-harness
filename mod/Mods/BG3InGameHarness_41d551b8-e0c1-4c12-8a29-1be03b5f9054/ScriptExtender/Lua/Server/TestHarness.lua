local PROTOCOL_VERSION = 2
local ARM_PATH = "BG3InGameHarness/TestHarness/arm.json"
local RUNS_ROOT = "BG3InGameHarness/TestHarness/runs/"
local COMMAND_POLL_MS = 100
local ERROR_INPUT_POLL_MS = 100
local ERROR_INPUT_INVALID_MAX_POLLS = 20
local PROTOCOL_INPUT_INVALID_MAX_POLLS = 20
local RESULT_WRITE_RETRY_MS = 100
local RESULT_WRITE_MAX_ATTEMPTS = 300
local TEST_SAVE_SETTLE_MS = 5000
local TEST_SAVE_START_TIMEOUT_MS = 10000
local TEST_SAVE_FINALIZATION_RESERVE_MS = 8000
local CLEANUP_CHECK_POLL_MS = 100
local CLEANUP_CHECK_TIMEOUT_MS = 5000
local MAX_ASSERTIONS = 4096
local MAX_IDENTIFIER_LENGTH = 100
local MAX_MESSAGE_LENGTH = 4000
local MAX_RESULT_BYTES = 1048576
local MAX_CHECKPOINTS = 256
local MAX_CHECKPOINT_FIELDS = 32
local MAX_CHECKPOINT_STRING = 512
local MAX_CHECKPOINT_BYTES = 32768
local NEW_CAMPAIGN_SAVE_ID = "__new_campaign__"

local scenarios = {}
local activeRun = nil
local armedRunId = nil

local TestHarness = {}
local contextExtensions = {}
local finishRun

local function epochMilliseconds()
    return tonumber(Ext.Timer.ClockEpoch()) * 1000
end

local function isSafeRunId(runId)
    return type(runId) == "string"
        and #runId >= 1
        and #runId <= 80
        and runId:match("^[A-Za-z0-9][A-Za-z0-9._-]*$") ~= nil
end

local function isSafeScenarioId(scenarioId)
    return type(scenarioId) == "string"
        and #scenarioId >= 1
        and #scenarioId <= 100
        and scenarioId:match("^[A-Za-z0-9][A-Za-z0-9._-]*$") ~= nil
end

local function isSafeSaveId(saveId)
    if type(saveId) ~= "string" then
        return false
    end
    -- Shape only. The runner refuses protected saves and accepts only an exact,
    -- hash-verified fixture before it ever writes the arm.
    return #saveId >= 1
        and #saveId <= 200
        and saveId:match("^[A-Za-z0-9][A-Za-z0-9._-]*$") ~= nil
        and saveId ~= NEW_CAMPAIGN_SAVE_ID
end

local function isUuid(value)
    return type(value) == "string"
        and value:match(
            "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"
        ) ~= nil
end

local function isNonBlankString(value)
    return type(value) == "string" and value:match("^%s*$") == nil
end

local function isBoundedNonBlankString(value, maximumLength)
    return isNonBlankString(value) and #value <= maximumLength
end

local function truncateString(value, maximumLength)
    local text = tostring(value)
    if #text <= maximumLength then
        return text
    end
    return text:sub(1, maximumLength)
end

local function hasOnlyKeys(value, allowedKeys)
    for key in pairs(value) do
        if allowedKeys[key] ~= true then
            return false
        end
    end
    return true
end

local CREATION_PLAN_KEYS = {
    kind = true,
    backgroundUuid = true,
    backgroundName = true,
    classUuid = true,
    raceUuid = true,
    subRaceUuid = true,
    racePassiveId = true,
    requiredTransitionModUuid = true
}

local function validateCreationPlan(plan)
    return type(plan) == "table"
        and hasOnlyKeys(plan, CREATION_PLAN_KEYS)
        and plan.kind == "background"
        and isUuid(plan.backgroundUuid)
        and isNonBlankString(plan.backgroundName)
        and isUuid(plan.requiredTransitionModUuid)
        and (plan.classUuid == nil or isUuid(plan.classUuid))
        and (plan.raceUuid == nil or isUuid(plan.raceUuid))
        and (plan.subRaceUuid == nil or isUuid(plan.raceUuid) and isUuid(plan.subRaceUuid))
        and (plan.racePassiveId == nil or isUuid(plan.raceUuid)
            and type(plan.racePassiveId) == "string" and #plan.racePassiveId <= 150
            and plan.racePassiveId:match("^[A-Za-z][A-Za-z0-9_]*$") ~= nil)
end

local function isNonNegativeInteger(value)
    return type(value) == "number"
        and value >= 0
        and value == math.floor(value)
end

local function isPositiveInteger(value)
    return isNonNegativeInteger(value) and value > 0
end

local function validateRequiredAssertionIds(value)
    if type(value) ~= "table" or #value > MAX_ASSERTIONS then
        return false
    end
    local seen = {}
    for index, assertionId in ipairs(value) do
        if not isBoundedNonBlankString(assertionId, MAX_IDENTIFIER_LENGTH)
            or seen[assertionId] then
            return false
        end
        seen[assertionId] = true
        if index > MAX_ASSERTIONS then
            return false
        end
    end
    for key in pairs(value) do
        if type(key) ~= "number"
            or key < 1
            or key > #value
            or key ~= math.floor(key) then
            return false
        end
    end
    return true
end

local function sameStringArray(left, right)
    if type(left) ~= "table" or type(right) ~= "table" or #left ~= #right then
        return false
    end
    for index, value in ipairs(left) do
        if right[index] ~= value then
            return false
        end
    end
    return true
end

local function runPath(runId, fileName)
    return RUNS_ROOT .. runId .. "/" .. fileName
end

local function loadJson(filePath)
    local contents = Ext.IO.LoadFile(filePath)
    if contents == nil then
        return nil, "missing"
    end

    local ok, value = pcall(Ext.Json.Parse, contents)
    if not ok or type(value) ~= "table" then
        return nil, "invalid"
    end
    return value, nil
end

local function hasAllowedTarget(mode, saveId, creationPlan)
    if mode == "runtime" then
        return isSafeSaveId(saveId) and creationPlan == nil
    end
    return mode == "character-creation"
        and saveId == NEW_CAMPAIGN_SAVE_ID
        and validateCreationPlan(creationPlan)
end

-- Each policy belongs to one mode. A new campaign either creates one test fixture
-- save or is discarded unsaved; the runtime fixture is never saved.
local function hasAllowedSavePolicy(mode, savePolicy)
    if mode == "runtime" then
        return savePolicy == "never"
    end
    return mode == "character-creation"
        and (savePolicy == "create-test-fixture" or savePolicy == "discard-campaign")
end

local function validateArm(arm)
    return type(arm) == "table"
        and arm.schemaVersion == PROTOCOL_VERSION
        and isSafeRunId(arm.runId)
        and isSafeScenarioId(arm.scenarioId)
        and hasAllowedTarget(arm.mode, arm.saveId, arm.creationPlan)
        and hasAllowedSavePolicy(arm.mode, arm.savePolicy)
        and isNonNegativeInteger(arm.createdAtEpochMs)
        and isNonNegativeInteger(arm.expiresAtEpochMs)
        and isPositiveInteger(arm.timeoutMs)
        and validateRequiredAssertionIds(arm.requiredAssertionIds)
        and arm.expiresAtEpochMs > arm.createdAtEpochMs
        and arm.expiresAtEpochMs - arm.createdAtEpochMs == arm.timeoutMs
end

local function validateCommand(command, arm)
    local valid = type(command) == "table"
        and command.schemaVersion == PROTOCOL_VERSION
        and command.runId == arm.runId
        and command.scenarioId == arm.scenarioId
        and command.mode == arm.mode
        and command.saveId == arm.saveId
        and hasAllowedTarget(command.mode, command.saveId, command.creationPlan)
        and hasAllowedSavePolicy(command.mode, command.savePolicy)
        and isNonNegativeInteger(command.createdAtEpochMs)
        and isNonNegativeInteger(command.expiresAtEpochMs)
        and isPositiveInteger(command.timeoutMs)
        and validateRequiredAssertionIds(command.requiredAssertionIds)
        and command.createdAtEpochMs >= arm.createdAtEpochMs
        and command.expiresAtEpochMs <= arm.expiresAtEpochMs
        and command.expiresAtEpochMs > command.createdAtEpochMs
        and command.expiresAtEpochMs - command.createdAtEpochMs == command.timeoutMs
    if not valid then
        return false
    end
    if command.savePolicy ~= arm.savePolicy
        or not sameStringArray(command.requiredAssertionIds, arm.requiredAssertionIds) then
        return false
    end
    if command.mode == "runtime" then
        return arm.creationPlan == nil and command.creationPlan == nil
    end
    return arm.creationPlan ~= nil
        and command.creationPlan.kind == arm.creationPlan.kind
        and command.creationPlan.backgroundUuid == arm.creationPlan.backgroundUuid
        and command.creationPlan.backgroundName == arm.creationPlan.backgroundName
        and command.creationPlan.classUuid == arm.creationPlan.classUuid
        and command.creationPlan.raceUuid == arm.creationPlan.raceUuid
        and command.creationPlan.subRaceUuid == arm.creationPlan.subRaceUuid
        and command.creationPlan.racePassiveId == arm.creationPlan.racePassiveId
        and command.creationPlan.requiredTransitionModUuid
            == arm.creationPlan.requiredTransitionModUuid
end

local function saveResult(runId, result)
    local ok, contents = pcall(Ext.Json.Stringify, result)
    if not ok then
        Ext.Utils.PrintError("[BG3 In-Game Harness] Could not serialize BG3 test result: " .. tostring(contents))
        return false
    end

    if #contents > MAX_RESULT_BYTES then
        local replacement = {
            schemaVersion = PROTOCOL_VERSION,
            runId = result.runId,
            scenarioId = result.scenarioId,
            status = "error",
            startedAtEpochMs = result.startedAtEpochMs,
            completedAtEpochMs = result.completedAtEpochMs,
            assertions = {},
            error = {
                code = "result-too-large",
                message = "Scenario result exceeded the one MiB harness artifact limit"
            }
        }
        local replacementOk, replacementContents = pcall(Ext.Json.Stringify, replacement)
        if not replacementOk then
            Ext.Utils.PrintError(
                "[BG3 In-Game Harness] Could not serialize the result-too-large fallback"
            )
            return false
        end
        contents = replacementContents
    end

    local saved, writeResult = pcall(
        Ext.IO.SaveFile,
        runPath(runId, "result.json"),
        contents
    )
    if not saved or writeResult ~= true then
        Ext.Utils.PrintError("[BG3 In-Game Harness] Could not write BG3 test result for " .. runId)
        return false
    end
    local verified, persistedContents = pcall(
        Ext.IO.LoadFile,
        runPath(runId, "result.json")
    )
    if not verified or persistedContents ~= contents then
        Ext.Utils.PrintError(
            "[BG3 In-Game Harness] BG3 test result read-back did not match for " .. runId
        )
        return false
    end
    return true
end

local function writeResultWithRetry(runId, result, onComplete)
    local attempts = 0
    local function attemptWrite()
        attempts = attempts + 1
        if saveResult(runId, result) then
            onComplete(true)
            return
        end
        if attempts >= RESULT_WRITE_MAX_ATTEMPTS then
            Ext.Utils.PrintError(
                "[BG3 In-Game Harness] Giving up after "
                    .. tostring(attempts)
                    .. " attempts to persist BG3 test result for "
                    .. runId
            )
            onComplete(false)
            return
        end
        local scheduled, scheduleError = pcall(
            Ext.Timer.WaitForRealtime,
            RESULT_WRITE_RETRY_MS,
            attemptWrite
        )
        if not scheduled then
            Ext.Utils.PrintError(
                "[BG3 In-Game Harness] Could not schedule result write retry: "
                    .. tostring(scheduleError)
            )
            onComplete(false)
        end
    end
    attemptWrite()
end

local function saveProtocolArtifact(filePath, value)
    local serialized, contents = pcall(Ext.Json.Stringify, value)
    if not serialized or type(contents) ~= "string" or #contents > MAX_RESULT_BYTES then
        return false
    end
    local saved, result = pcall(Ext.IO.SaveFile, filePath, contents)
    if not saved or result ~= true then
        return false
    end
    local verified, persisted = pcall(Ext.IO.LoadFile, filePath)
    return verified and persisted == contents
end

local function persistBeforeCleanupDiagnostic(state)
    local captured, persisted = pcall(function()
        local assertions = {}
        for _, assertion in ipairs(state.Assertions) do
            assertions[#assertions + 1] = { id = assertion.id, passed = assertion.passed }
        end
        local diagnostic = {
            schemaVersion = 1,
            runId = state.Command.runId,
            scenarioId = state.Command.scenarioId,
            status = "diagnostic",
            phase = "before-cleanup",
            observedAtEpochMs = epochMilliseconds(),
            initialStatus = state.FinalStatus,
            assertionCount = #assertions,
            assertions = assertions
        }
        if state.FinalError ~= nil then
            diagnostic.initialError = {
                code = truncateString(state.FinalError.code, MAX_IDENTIFIER_LENGTH),
                message = truncateString(state.FinalError.message, MAX_MESSAGE_LENGTH)
            }
        end
        return saveProtocolArtifact(runPath(state.Command.runId, "server-before-cleanup.json"), diagnostic)
    end)
    -- This evidence must precede every cleanup callback and cannot replace a result.
    -- Failed capture or persistence must not delay cleanup or erase the initial error.
    if not captured or not persisted then
        local message = "[BG3 In-Game Harness] Could not persist pre-cleanup diagnostic for "
            .. state.Command.runId .. " (" .. state.Command.scenarioId .. "); initialStatus="
            .. state.FinalStatus .. "; assertionCount=" .. tostring(#state.Assertions)
        if state.FinalError ~= nil then
            message = message .. "; initialError=" .. truncateString(state.FinalError.code, MAX_IDENTIFIER_LENGTH)
                .. ": " .. truncateString(state.FinalError.message, MAX_MESSAGE_LENGTH)
        end
        pcall(Ext.Utils.PrintError, message)
    end
end

local function writeProtocolArtifactWithRetry(filePath, value, label, onComplete)
    local attempts = 0
    local function attemptWrite()
        attempts = attempts + 1
        if saveProtocolArtifact(filePath, value) then
            onComplete(true)
            return
        end
        if attempts >= RESULT_WRITE_MAX_ATTEMPTS then
            Ext.Utils.PrintError(
                "[BG3 In-Game Harness] Giving up after "
                    .. tostring(attempts)
                    .. " attempts to persist "
                    .. label
            )
            onComplete(false)
            return
        end
        local scheduled, scheduleError = pcall(
            Ext.Timer.WaitForRealtime,
            RESULT_WRITE_RETRY_MS,
            attemptWrite
        )
        if not scheduled then
            Ext.Utils.PrintError(
                "[BG3 In-Game Harness] Could not schedule "
                    .. label
                    .. " write retry: "
                    .. tostring(scheduleError)
            )
            onComplete(false)
        end
    end
    attemptWrite()
end

local function readGlobalSwitches()
    if Ext == nil
        or Ext.Utils == nil
        or type(Ext.Utils.GetGlobalSwitches) ~= "function"
    then
        return nil, "global switches are unavailable"
    end
    local read, switches = pcall(Ext.Utils.GetGlobalSwitches)
    if not read or switches == nil then
        return nil, "global switches lookup failed: " .. tostring(switches)
    end
    return switches, nil
end

local function requireAutoSaveSuppressed()
    local switches, switchesError = readGlobalSwitches()
    if switches == nil then
        return false, switchesError
    end
    local read, enabled = pcall(function()
        return switches.CanAutoSave
    end)
    if not read then
        return false, "CanAutoSave read failed: " .. tostring(enabled)
    end
    if enabled ~= false then
        pcall(function()
            switches.CanAutoSave = false
        end)
        return false, "CanAutoSave became enabled outside the authorized save gate"
    end
    return true, nil
end

local function validateAutoSaveGuard(arm)
    local guard, loadError = loadJson(runPath(arm.runId, "autosave-guard.json"))
    return loadError == nil
        and type(guard) == "table"
        and guard.schemaVersion == PROTOCOL_VERSION
        and guard.runId == arm.runId
        and guard.scenarioId == arm.scenarioId
        and guard.status == "suppressed"
        and isNonNegativeInteger(guard.suppressedAtEpochMs)
        and guard.suppressedAtEpochMs >= arm.createdAtEpochMs
        and guard.suppressedAtEpochMs <= arm.expiresAtEpochMs
end

local function errorResult(arm, code, message)
    local now = epochMilliseconds()
    now = math.max(arm.createdAtEpochMs, math.min(now, arm.expiresAtEpochMs))
    writeProtocolArtifactWithRetry(
        runPath(arm.runId, "server-finalizing.json"),
        {
            schemaVersion = PROTOCOL_VERSION,
            runId = arm.runId,
            scenarioId = arm.scenarioId,
            status = "finalizing",
            finalizingAtEpochMs = now
        },
        "pre-scenario server finalization for " .. arm.runId,
        function()
            writeResultWithRetry(arm.runId, {
                schemaVersion = PROTOCOL_VERSION,
                runId = arm.runId,
                scenarioId = arm.scenarioId,
                status = "error",
                startedAtEpochMs = now,
                completedAtEpochMs = now,
                assertions = {},
                error = {
                    code = code,
                    message = message
                }
            }, function() end)
        end
    )
end


local ERROR_INPUTS = {
    {
        FileName = "client-error.json",
        InvalidCode = "invalid-client-error",
        InvalidMessage = "Character creation client wrote an invalid error artifact"
    },
    {
        FileName = "startup-error.json",
        InvalidCode = "invalid-startup-error",
        InvalidMessage = "Character creation startup bridge wrote an invalid error artifact"
    }
}

local function validateErrorInput(value, state)
    return type(value) == "table"
        and value.schemaVersion == PROTOCOL_VERSION
        and value.runId == state.Command.runId
        and value.scenarioId == state.Command.scenarioId
        and value.status == "error"
        and isNonNegativeInteger(value.startedAtEpochMs)
        and isNonNegativeInteger(value.completedAtEpochMs)
        and value.startedAtEpochMs >= state.Arm.createdAtEpochMs
        and value.completedAtEpochMs >= value.startedAtEpochMs
        and value.completedAtEpochMs <= state.Arm.expiresAtEpochMs
        and type(value.assertions) == "table"
        and #value.assertions == 0
        and type(value.error) == "table"
        and isBoundedNonBlankString(value.error.code, MAX_IDENTIFIER_LENGTH)
        and isBoundedNonBlankString(value.error.message, MAX_MESSAGE_LENGTH)
end

local function readErrorInput(state)
    for _, input in ipairs(ERROR_INPUTS) do
        local value, loadError = loadJson(runPath(state.Command.runId, input.FileName))
        if loadError ~= "missing" then
            if loadError ~= nil or not validateErrorInput(value, state) then
                local invalidPolls = (state.ErrorInputInvalidPolls[input.FileName] or 0) + 1
                state.ErrorInputInvalidPolls[input.FileName] = invalidPolls
                if invalidPolls < ERROR_INPUT_INVALID_MAX_POLLS then
                    return nil, true
                end
                return {
                    code = input.InvalidCode,
                    message = input.InvalidMessage
                }, false
            end
            state.ErrorInputInvalidPolls[input.FileName] = nil
            return {
                code = value.error.code,
                message = value.error.message
            }, false
        end
        state.ErrorInputInvalidPolls[input.FileName] = nil
    end
    return nil, false
end

local function persistFinalResult(state, status, errorValue)
    local completedAtEpochMs = math.max(
        state.StartedAtEpochMs,
        math.min(epochMilliseconds(), state.Command.expiresAtEpochMs)
    )
    local result = {
        schemaVersion = PROTOCOL_VERSION,
        runId = state.Command.runId,
        scenarioId = state.Command.scenarioId,
        status = status,
        startedAtEpochMs = state.StartedAtEpochMs,
        completedAtEpochMs = completedAtEpochMs,
        assertions = state.Assertions
    }
    if errorValue ~= nil then
        result.error = {
            code = truncateString(errorValue.code, MAX_IDENTIFIER_LENGTH),
            message = truncateString(errorValue.message, MAX_MESSAGE_LENGTH)
        }
    end

    writeResultWithRetry(state.Command.runId, result, function(persisted)
        state.Completed = true
        if not persisted then
            Ext.Utils.PrintError(
                "[BG3 In-Game Harness] BG3 test run ended without a persisted result: "
                    .. state.Command.runId
            )
        end
        if activeRun == state then
            activeRun = nil
        end
    end)
end

local function requestAutoSave(state)
    local switches, switchesError = readGlobalSwitches()
    if switches == nil then
        return false, switchesError
    end
    local read, initiallyEnabled = pcall(function()
        return switches.CanAutoSave
    end)
    if not read or initiallyEnabled ~= false then
        return false, "autosave gate was not closed before the authorized request"
    end
    local subscription = nil
    local closed = false
    state.CloseSaveGate = function()
        if closed then return state.SaveGateError == nil, state.SaveGateError end
        closed = true
        local restored, gateClosed = pcall(function()
            local currentSwitches = Ext.Utils.GetGlobalSwitches()
            currentSwitches.CanAutoSave = false
            return currentSwitches.CanAutoSave == false
        end)
        if subscription ~= nil then
            pcall(function() Ext.Events.GameStateChanged:Unsubscribe(subscription) end)
        end
        if not restored or not gateClosed then
            state.SaveGateError = "autosave gate did not close after the authorized request"
        end
        return state.SaveGateError == nil, state.SaveGateError
    end
    local subscribed, subscriptionOrError = pcall(function()
        return Ext.Events.GameStateChanged:Subscribe(function(event)
            if tostring(event.ToState) == "Save" then
                state.SaveStarted = true
                state.CloseSaveGate()
            end
        end)
    end)
    if not subscribed then
        state.CloseSaveGate()
        return false, "save state subscription failed: " .. tostring(subscriptionOrError)
    end
    subscription = subscriptionOrError
    local opened, gateOpen = pcall(function()
        switches.CanAutoSave = true
        return switches.CanAutoSave == true
    end)
    if not opened or not gateOpen then
        state.CloseSaveGate()
        return false, "autosave gate could not be opened for the authorized request"
    end

    -- Osiris functions are engine proxies. Protect lookup and invocation together.
    -- AutoSave queues engine work; the Save event closes the gate after it starts.
    local requested, requestError = pcall(function()
        Osi.AutoSave()
    end)
    if not requested then
        local restored, restoreError = state.CloseSaveGate()
        return false, restored and ("autosave request failed: " .. tostring(requestError)) or restoreError
    end
    return true, nil
end

local function runCleanup(state)
    if state.CleanupDone then
        return
    end
    state.CleanupDone = true
    local cleanupErrors = {}
    for index = #state.CleanupCallbacks, 1, -1 do
        local ok, cleanupError = xpcall(
            state.CleanupCallbacks[index],
            function(value)
                return tostring(value)
            end
        )
        if not ok then
            table.insert(cleanupErrors, cleanupError)
        end
    end
    if #cleanupErrors > 0 then
        if state.FinalError ~= nil then
            table.insert(cleanupErrors, 1, state.FinalError.code .. ": " .. state.FinalError.message)
        end
        state.FinalStatus = "error"
        state.FinalError = {
            code = "scenario-cleanup-error",
            message = table.concat(cleanupErrors, "; ")
        }
    end
end

local function persistStateResult(state)
    runCleanup(state)
    if state.CleanupCheckStarted then return end
    state.CleanupCheckStarted = true
    local waitedMs = 0
    local function completeCleanupError(message)
        if state.FinalError ~= nil then
            message = state.FinalError.message .. "; " .. message
        end
        state.FinalStatus = "error"
        state.FinalError = { code = "scenario-cleanup-error", message = message }
        persistFinalResult(state, state.FinalStatus, state.FinalError)
    end
    local function poll()
        if state.Completed then return end
        local pending, failures = {}, {}
        for _, check in ipairs(state.CleanupChecks or {}) do
            local ok, clean = pcall(check.Run)
            if not ok or type(clean) ~= "boolean" then
                table.insert(failures, check.Label .. ": " .. tostring(clean))
            elseif not clean then
                table.insert(pending, check.Label)
            end
        end
        if #failures > 0 then
            completeCleanupError(table.concat(failures, "; "))
        elseif #pending == 0 then
            persistFinalResult(state, state.FinalStatus, state.FinalError)
        elseif waitedMs >= CLEANUP_CHECK_TIMEOUT_MS then
            completeCleanupError("Cleanup did not settle: " .. table.concat(pending, "; "))
        else
            waitedMs = waitedMs + CLEANUP_CHECK_POLL_MS
            local scheduled, scheduleError = pcall(Ext.Timer.WaitForRealtime, CLEANUP_CHECK_POLL_MS, poll)
            if not scheduled then
                completeCleanupError("Cleanup check timer failed: " .. tostring(scheduleError))
            end
        end
    end
    poll()
end

local function setFinalError(state, code, message)
    state.FinalStatus = "error"
    state.FinalError = {
        code = code,
        message = truncateString(message, MAX_MESSAGE_LENGTH)
    }
end

local function scheduleStatePoll(state, callback, failureCode, failureMessage)
    local scheduled, timerOrError = pcall(
        Ext.Timer.WaitForRealtime,
        ERROR_INPUT_POLL_MS,
        function()
            state.FinalizationRetryTimer = nil
            callback()
        end
    )
    if scheduled then
        state.FinalizationRetryTimer = timerOrError
        return true
    end
    setFinalError(
        state,
        failureCode,
        failureMessage .. ": " .. tostring(timerOrError)
    )
    persistStateResult(state)
    return false
end

local function validateProducerClosed(value, state, requireFinalizationEcho)
    local valid = type(value) == "table"
        and value.schemaVersion == PROTOCOL_VERSION
        and value.runId == state.Command.runId
        and value.scenarioId == state.Command.scenarioId
        and value.status == "closed"
        and isNonNegativeInteger(value.closedAtEpochMs)
        and value.closedAtEpochMs >= state.Arm.createdAtEpochMs
        and value.closedAtEpochMs <= state.Arm.expiresAtEpochMs
    if not valid then
        return false
    end
    if not requireFinalizationEcho then
        return true
    end
    return isNonNegativeInteger(value.finalizingAtEpochMs)
        and value.finalizingAtEpochMs == state.FinalizingAtEpochMs
        and value.closedAtEpochMs >= value.finalizingAtEpochMs
end

local function readProducerClosed(state, fileName, requireFinalizationEcho)
    local value, loadError = loadJson(runPath(state.Command.runId, fileName))
    if loadError == "missing" then
        return false, false, nil
    end
    if loadError ~= nil or not validateProducerClosed(value, state, requireFinalizationEcho) then
        local invalidPolls = (state.ProtocolInputInvalidPolls[fileName] or 0) + 1
        state.ProtocolInputInvalidPolls[fileName] = invalidPolls
        if invalidPolls < PROTOCOL_INPUT_INVALID_MAX_POLLS then
            return false, true, nil
        end
        return false, false, {
            code = "invalid-producer-closure",
            message = "Invalid producer closure artifact: " .. fileName
        }
    end
    state.ProtocolInputInvalidPolls[fileName] = nil
    return true, false, nil
end

local function validateSaveIntentAck(value, state)
    return type(value) == "table"
        and value.schemaVersion == PROTOCOL_VERSION
        and value.runId == state.Command.runId
        and value.scenarioId == state.Command.scenarioId
        and value.status == "acknowledged"
        and value.intentId == state.SaveIntentId
        and isNonNegativeInteger(value.acknowledgedAtEpochMs)
        and value.acknowledgedAtEpochMs >= state.SaveIntentAtEpochMs
        and value.acknowledgedAtEpochMs <= state.Command.expiresAtEpochMs
end

local function readSaveIntentAck(state)
    local fileName = "save-intent-ack.json"
    local value, loadError = loadJson(runPath(state.Command.runId, fileName))
    if loadError == "missing" then
        return nil, false
    end
    if loadError ~= nil or not validateSaveIntentAck(value, state) then
        local invalidPolls = (state.ProtocolInputInvalidPolls[fileName] or 0) + 1
        state.ProtocolInputInvalidPolls[fileName] = invalidPolls
        if invalidPolls < PROTOCOL_INPUT_INVALID_MAX_POLLS then
            return nil, true
        end
        return {
            code = "invalid-save-intent-ack",
            message = "Save intent acknowledgement is invalid"
        }, false
    end
    state.ProtocolInputInvalidPolls[fileName] = nil
    return value, false
end

local pollSaveIntentAck

local function executeAuthorizedSave(state)
    local remainingMs = state.Command.expiresAtEpochMs - epochMilliseconds()
    if remainingMs < TEST_SAVE_SETTLE_MS + 500 then
        setFinalError(
            state,
            "test-save-deadline-insufficient",
            "Not enough run time remains to settle the test save"
        )
        persistStateResult(state)
        return
    end

    local requestedAtEpochMs = math.max(
        state.SaveIntentAtEpochMs,
        state.SaveAcknowledgedAtEpochMs,
        math.min(epochMilliseconds(), state.Command.expiresAtEpochMs)
    )
    writeProtocolArtifactWithRetry(
        runPath(state.Command.runId, "save-request.json"),
        {
            schemaVersion = PROTOCOL_VERSION,
            runId = state.Command.runId,
            scenarioId = state.Command.scenarioId,
            status = "requested",
            intentId = state.SaveIntentId,
            requestedAtEpochMs = requestedAtEpochMs
        },
        "save request for " .. state.Command.runId,
        function(persisted)
            if not persisted then
                setFinalError(
                    state,
                    "test-save-request-evidence-failed",
                    "Could not persist the authorized save request"
                )
                persistStateResult(state)
                return
            end
            if state.Command.expiresAtEpochMs - epochMilliseconds()
                < TEST_SAVE_SETTLE_MS + 500 then
                setFinalError(
                    state,
                    "test-save-deadline-insufficient",
                    "Save request evidence completed too close to the run deadline"
                )
                persistStateResult(state)
                return
            end
            local guardOk, guardError = requireAutoSaveSuppressed()
            if not guardOk then
                setFinalError(state, "autosave-guard-lost", guardError)
                persistStateResult(state)
                return
            end
            local requested, requestError = requestAutoSave(state)
            if not requested then
                setFinalError(state, "test-save-request-failed", requestError)
                persistStateResult(state)
                return
            end
            local saveStartDeadline = math.min(
                epochMilliseconds() + TEST_SAVE_START_TIMEOUT_MS,
                state.Command.expiresAtEpochMs - TEST_SAVE_SETTLE_MS - 500
            )
            local function failSaveStart(code, message)
                local restored, restoreError = state.CloseSaveGate()
                setFinalError(state, restored and code or "autosave-guard-lost", restored and message or restoreError)
                persistStateResult(state)
            end
            local waitForSaveStart
            waitForSaveStart = function()
                if not state.SaveStarted then
                    if epochMilliseconds() >= saveStartDeadline then
                        failSaveStart("test-save-start-timeout", "The authorized AutoSave did not enter Save within its deadline")
                        return
                    end
                    local scheduled, timerOrError = pcall(Ext.Timer.WaitForRealtime, ERROR_INPUT_POLL_MS, waitForSaveStart)
                    if not scheduled then
                        failSaveStart("test-save-start-schedule-failed", tostring(timerOrError))
                    end
                    return
                end
                if state.SaveGateError ~= nil then
                    failSaveStart("autosave-guard-lost", state.SaveGateError)
                    return
                end
                state.SaveExecuted = true
                local scheduled, scheduleError = pcall(
                    Ext.Timer.WaitForRealtime,
                    TEST_SAVE_SETTLE_MS,
                    function()
                        state.SaveSettleTimer = nil
                        local stillSuppressed, suppressionError = requireAutoSaveSuppressed()
                        if not stillSuppressed then
                            setFinalError(state, "autosave-guard-lost", suppressionError)
                        end
                        persistStateResult(state)
                    end
                )
                if scheduled then
                    state.SaveSettleTimer = scheduleError
                    return
                end
                Ext.Utils.PrintError(
                    "[BG3 In-Game Harness] Could not schedule test save settlement: "
                        .. tostring(scheduleError)
                )
                setFinalError(
                    state,
                    "test-save-settle-schedule-failed",
                    tostring(scheduleError)
                )
                persistStateResult(state)
            end
            waitForSaveStart()
        end
    )
end

pollSaveIntentAck = function(state)
    if state.Completed then
        return
    end
    local guardOk, guardError = requireAutoSaveSuppressed()
    if not guardOk then
        setFinalError(state, "autosave-guard-lost", guardError)
        persistStateResult(state)
        return
    end
    if state.Command.expiresAtEpochMs - epochMilliseconds()
        < TEST_SAVE_SETTLE_MS + 500 then
        setFinalError(
            state,
            "test-save-intent-timeout",
            "Save intent was not acknowledged before its effect deadline"
        )
        persistStateResult(state)
        return
    end
    local acknowledgement, pending = readSaveIntentAck(state)
    if pending or acknowledgement == nil then
        scheduleStatePoll(
            state,
            function()
                pollSaveIntentAck(state)
            end,
            "save-intent-poll-failed",
            "Could not poll the save intent acknowledgement"
        )
        return
    end
    if acknowledgement.code ~= nil then
        setFinalError(state, acknowledgement.code, acknowledgement.message)
        persistStateResult(state)
        return
    end
    state.SaveAcknowledgedAtEpochMs = acknowledgement.acknowledgedAtEpochMs
    executeAuthorizedSave(state)
end

local function startSaveIntent(state)
    local remainingMs = state.Command.expiresAtEpochMs - epochMilliseconds()
    if remainingMs < TEST_SAVE_FINALIZATION_RESERVE_MS then
        setFinalError(
            state,
            "test-save-deadline-insufficient",
            "Not enough run time remains to authorize and settle the test save"
        )
        persistStateResult(state)
        return
    end
    state.SaveIntentId = state.Command.runId .. ".save1"
    state.SaveIntentAtEpochMs = math.max(
        state.StartedAtEpochMs,
        math.min(epochMilliseconds(), state.Command.expiresAtEpochMs)
    )
    writeProtocolArtifactWithRetry(
        runPath(state.Command.runId, "save-intent.json"),
        {
            schemaVersion = PROTOCOL_VERSION,
            runId = state.Command.runId,
            scenarioId = state.Command.scenarioId,
            status = "intent",
            intentId = state.SaveIntentId,
            intentAtEpochMs = state.SaveIntentAtEpochMs
        },
        "save intent for " .. state.Command.runId,
        function(persisted)
            if not persisted then
                setFinalError(
                    state,
                    "test-save-intent-write-failed",
                    "Could not persist the save intent"
                )
                persistStateResult(state)
                return
            end
            pollSaveIntentAck(state)
        end
    )
end

local continueFinalization

continueFinalization = function(state)
    if state.Completed then
        return
    end
    local guardOk, guardError = requireAutoSaveSuppressed()
    if not guardOk then
        setFinalError(state, "autosave-guard-lost", guardError)
        persistStateResult(state)
        return
    end

    local inputError, inputPending = readErrorInput(state)
    if inputPending then
        scheduleStatePoll(
            state,
            function()
                continueFinalization(state)
            end,
            "error-input-read-failed",
            "Could not settle an error input"
        )
        return
    end
    if inputError ~= nil then
        state.FinalStatus = "error"
        state.FinalError = inputError
    end

    if state.FinalStatus ~= "passed" or not state.SaveRequested then
        persistStateResult(state)
        return
    end

    local startupClosed, startupPending, startupError = readProducerClosed(
        state,
        "startup-closed.json",
        false
    )
    local clientClosed, clientPending, clientError = readProducerClosed(
        state,
        "client-closed.json",
        true
    )
    local closureError = startupError or clientError
    if closureError ~= nil then
        state.FinalStatus = "error"
        state.FinalError = closureError
        persistStateResult(state)
        return
    end
    if not startupClosed or not clientClosed or startupPending or clientPending then
        if epochMilliseconds() >= state.Command.expiresAtEpochMs then
            setFinalError(
                state,
                "producer-close-timeout",
                "Client or startup error producer did not close before the run deadline"
            )
            persistStateResult(state)
            return
        end
        scheduleStatePoll(
            state,
            function()
                continueFinalization(state)
            end,
            "producer-close-poll-failed",
            "Could not poll producer closure artifacts"
        )
        return
    end

    local sealedInputError, sealedInputPending = readErrorInput(state)
    if sealedInputPending then
        scheduleStatePoll(
            state,
            function()
                continueFinalization(state)
            end,
            "error-input-read-failed",
            "Could not settle a sealed error input"
        )
        return
    end
    if sealedInputError ~= nil then
        state.FinalStatus = "error"
        state.FinalError = sealedInputError
        persistStateResult(state)
        return
    end

    runCleanup(state)
    if state.FinalStatus ~= "passed" then
        persistStateResult(state)
        return
    end
    startSaveIntent(state)
end

finishRun = function(state, status, errorValue)
    if state.Completed or state.Finalizing then
        return
    end
    state.Finalizing = true
    state.FinalStatus = status
    state.FinalError = errorValue
    if state.TimeoutTimer ~= nil then
        pcall(Ext.Timer.Cancel, state.TimeoutTimer)
    end
    if state.ErrorInputTimer ~= nil then
        pcall(Ext.Timer.Cancel, state.ErrorInputTimer)
    end
    persistBeforeCleanupDiagnostic(state)
    local function finalize()
        runCleanup(state)
        state.FinalizingAtEpochMs = math.max(
            state.StartedAtEpochMs,
            math.min(epochMilliseconds(), state.Command.expiresAtEpochMs)
        )
        writeProtocolArtifactWithRetry(
            runPath(state.Command.runId, "server-finalizing.json"),
            {
                schemaVersion = PROTOCOL_VERSION,
                runId = state.Command.runId,
                scenarioId = state.Command.scenarioId,
                status = "finalizing",
                finalizingAtEpochMs = state.FinalizingAtEpochMs
            },
            "server finalization for " .. state.Command.runId,
            function(persisted)
                if not persisted then
                    setFinalError(
                        state,
                        "server-finalization-write-failed",
                        "Could not persist the server finalization marker"
                    )
                    persistStateResult(state)
                    return
                end
                continueFinalization(state)
            end
        )
    end

    local function withholdCleanup(reason)
        -- The runner closes this disposable world without saving. Keep actors
        -- alive until then if a client task might still refer to them.
        state.CleanupDone = true
        state.CleanupChecks = {}
        local message = "Cleanup barrier did not settle; fixture cleanup withheld: " .. reason
        if state.FinalError ~= nil then
            message = state.FinalError.code .. ": " .. state.FinalError.message .. "; " .. message
        end
        state.FinalStatus = "error"
        state.FinalError = { code = "scenario-cleanup-barrier-error",
            message = truncateString(message, MAX_MESSAGE_LENGTH) }
        finalize()
    end
    local waited = 0
    local function awaitBarriers()
        local pending, failures = {}, {}
        for _, check in ipairs(state.CleanupBarriers or {}) do
            local ok, settled = pcall(check.Run)
            if not ok or type(settled) ~= "boolean" then
                failures[#failures + 1] = check.Label .. ": " .. tostring(settled)
            elseif not settled then pending[#pending + 1] = check.Label end
        end
        if #failures == 0 and #pending == 0 then finalize(); return end
        if #failures > 0 or waited >= CLEANUP_CHECK_TIMEOUT_MS then
            withholdCleanup(table.concat(#failures > 0 and failures or pending, "; "))
            return
        end
        waited = waited + CLEANUP_CHECK_POLL_MS
        local ok, failure = pcall(Ext.Timer.WaitForRealtime, CLEANUP_CHECK_POLL_MS, awaitBarriers)
        if not ok then withholdCleanup("Cannot poll cleanup: " .. tostring(failure)) end
    end
    awaitBarriers()
end

local function observeErrorInput(state)
    local inputError, pending = readErrorInput(state)
    if pending then
        return false, true
    end
    if inputError == nil then
        return false, false
    end
    finishRun(state, "error", inputError)
    return true, false
end

local function waitForErrorInput(state)
    state.ErrorInputTimer = Ext.Timer.WaitForRealtime(ERROR_INPUT_POLL_MS, function()
        state.ErrorInputTimer = nil
        if state.Completed or state.Finalizing then
            return
        end
        local guardOk, guardError = requireAutoSaveSuppressed()
        if not guardOk then
            finishRun(state, "error", {
                code = "autosave-guard-lost",
                message = guardError
            })
            return
        end
        local observed = observeErrorInput(state)
        if observed then
            return
        end
        waitForErrorInput(state)
    end)
end

local function createContext(state)
    local context = {}

    -- Synchronous read-back is deliberate: callers must not emit their next effect
    -- unless this returns true. No delayed retry can resume an expired scenario.
    function context:Checkpoint(phase, fields)
        if state.Completed or state.Finalizing then return false end
        if type(phase) ~= "string" or #phase == 0 or #phase > 100
            or not phase:match("^[A-Za-z0-9][A-Za-z0-9._-]*$")
            or type(fields) ~= "table" or getmetatable(fields) ~= nil then
            error("Checkpoints require a bounded phase and a plain scalar field map")
        end
        local data, count = {}, 0
        for key, value in pairs(fields) do
            count = count + 1
            local kind = type(value)
            if count > MAX_CHECKPOINT_FIELDS or type(key) ~= "string" or #key == 0 or #key > 64
                or not key:match("^[A-Za-z][A-Za-z0-9_]*$")
                or (kind ~= "string" and kind ~= "number" and kind ~= "boolean")
                or (kind == "string" and #value > MAX_CHECKPOINT_STRING)
                or (kind == "number" and (value ~= value or value == math.huge or value == -math.huge)) then
                error("Checkpoint fields must be bounded strings, finite numbers or booleans")
            end
            data[key] = value
        end
        local sequence = (state.CheckpointSequence or 0) + 1
        if sequence > MAX_CHECKPOINTS then error("Scenario checkpoint limit exceeded") end
        state.CheckpointSequence = sequence
        local filePath = runPath(state.Command.runId, string.format("checkpoint-%04d.json", sequence))
        local value = { schemaVersion = 1, runId = state.Command.runId, scenarioId = state.Command.scenarioId,
            sequence = sequence, phase = phase, observedAtEpochMs = epochMilliseconds(), fields = data }
        local serialized, contents = pcall(Ext.Json.Stringify, value)
        local saved, result, verified, persisted = false, nil, false, nil
        if serialized and type(contents) == "string" and #contents <= MAX_CHECKPOINT_BYTES then
            saved, result = pcall(Ext.IO.SaveFile, filePath, contents)
            if saved and result == true then verified, persisted = pcall(Ext.IO.LoadFile, filePath) end
        end
        if not saved or result ~= true or not verified or persisted ~= contents then
            finishRun(state, "error", { code = "checkpoint-write-failed",
                message = "Could not persist checkpoint " .. tostring(sequence) .. " (" .. phase .. ")" })
            return false
        end
        return not state.Completed and not state.Finalizing
    end

    function context:Assert(id, passed, message, expected, actual)
        if state.Completed or state.Finalizing then
            return
        end
        if not isBoundedNonBlankString(id, MAX_IDENTIFIER_LENGTH)
            or state.AssertionIds[id] then
            error("Scenario assertions require unique identifiers of at most 100 characters")
        end
        if type(passed) ~= "boolean"
            or not isBoundedNonBlankString(message, MAX_MESSAGE_LENGTH) then
            error("Scenario assertions require a boolean result and a message of at most 4000 characters")
        end
        if #state.Assertions >= MAX_ASSERTIONS then
            error("Scenario cannot emit more than 4096 assertions")
        end

        state.AssertionIds[id] = true
        local assertion = {
            id = id,
            passed = passed,
            message = message
        }
        if expected ~= nil then
            assertion.expected = truncateString(expected, MAX_MESSAGE_LENGTH)
        end
        if actual ~= nil then
            assertion.actual = truncateString(actual, MAX_MESSAGE_LENGTH)
        end
        table.insert(state.Assertions, assertion)
    end

    function context:Defer(callback)
        if state.Completed or state.Finalizing then
            return
        end
        if type(callback) ~= "function" then
            error("Scenario cleanup requires a callback")
        end
        table.insert(state.CleanupCallbacks, callback)
    end

    function context:DeferCheck(label, callback)
        if state.Completed or state.Finalizing or state.Command.mode ~= "runtime"
            or state.Command.savePolicy ~= "never" then
            error("Cleanup checks require an active runtime scenario without saving")
        end
        if not isBoundedNonBlankString(label, 1000) or type(callback) ~= "function" then
            error("Cleanup checks require a label and a predicate")
        end
        state.CleanupChecks = state.CleanupChecks or {}
        table.insert(state.CleanupChecks, { Label = label, Run = callback })
    end

    function context:BeforeCleanup(label, callback)
        local permitted = (state.Command.mode == "runtime" and state.Command.savePolicy == "never")
            or (state.Command.mode == "character-creation" and state.Command.savePolicy == "create-test-fixture"
                and state.Command.saveId == "__new_campaign__" and state.Scenario.SavePolicy == "create-test-fixture")
        if state.Completed or state.Finalizing or not permitted or not isBoundedNonBlankString(label, 1000)
            or type(callback) ~= "function" then error("Cleanup barriers require an active permitted scenario") end
        state.CleanupBarriers = state.CleanupBarriers or {}
        table.insert(state.CleanupBarriers, { Label = label, Run = callback })
    end

    function context:GetCreationPlan()
        local plan = state.Command.creationPlan
        if plan == nil then
            return nil
        end
        return {
            kind = plan.kind,
            backgroundUuid = plan.backgroundUuid,
            backgroundName = plan.backgroundName,
            classUuid = plan.classUuid,
            raceUuid = plan.raceUuid,
            subRaceUuid = plan.subRaceUuid,
            racePassiveId = plan.racePassiveId,
            requiredTransitionModUuid = plan.requiredTransitionModUuid
        }
    end

    function context:GetDeadlineEpochMs()
        if activeRun ~= state or state.Completed or state.Finalizing then return nil end
        local currentTime = epochMilliseconds()
        if currentTime < state.Command.createdAtEpochMs or currentTime >= state.Command.expiresAtEpochMs then return nil end
        return state.Command.expiresAtEpochMs
    end

    function context:CreateFixture()
        -- A fixture never saves. It serves runtime scenarios on the fixed save and new campaigns
        -- that command, arm and registration all discard unsaved; a fixture-creating campaign
        -- keeps refusing it.
        local runtime = state.Command.mode == "runtime" and state.Command.savePolicy == "never"
        local discarded = state.Command.mode == "character-creation"
            and state.Command.savePolicy == "discard-campaign" and state.Command.saveId == "__new_campaign__"
            and state.Scenario.SavePolicy == "discard-campaign"
        if state.Completed or state.Finalizing or not (runtime or discarded) then
            error("Runtime fixtures require an active runtime scenario without saving or a discarded new campaign")
        end
        local fixture = Mods.BG3InGameHarness.RuntimeFixture.Create(self)
        state.RuntimeFixtures = state.RuntimeFixtures or {}
        state.RuntimeFixtures[fixture] = true
        return fixture
    end

    function context:RequestTestSave()
        if state.Completed or state.Finalizing then
            return false, "scenario-completed"
        end
        if state.Command.mode ~= "character-creation"
            or state.Command.savePolicy ~= "create-test-fixture"
            or state.Scenario.SavePolicy ~= "create-test-fixture" then
            return false, "scenario-save-policy-denied"
        end
        if #state.Command.requiredAssertionIds == 0 then
            return false, "scenario-required-assertions-missing"
        end
        state.SaveRequested = true
        return true, nil
    end

    function context:Finish()
        if state.Completed or state.Finalizing then
            return
        end
        local status = "passed"
        for _, assertion in ipairs(state.Assertions) do
            if assertion.passed ~= true then
                status = "failed"
                break
            end
        end
        local missingRequired = {}
        for _, assertionId in ipairs(state.Command.requiredAssertionIds) do
            if not state.AssertionIds[assertionId] then
                table.insert(missingRequired, assertionId)
            end
        end
        if #missingRequired > 0 then
            finishRun(state, "error", {
                code = "required-assertions-missing",
                message = "Scenario omitted required assertions: "
                    .. table.concat(missingRequired, ", ")
            })
            return
        end
        if status == "passed"
            and state.Command.mode == "character-creation"
            and state.Command.savePolicy == "create-test-fixture"
            and not state.SaveRequested
        then
            finishRun(state, "error", {
                code = "test-save-not-requested",
                message = "Passing character creation scenario did not request its test fixture save"
            })
            return
        end
        finishRun(state, status, nil)
    end

    function context:Error(code, message)
        if not isBoundedNonBlankString(code, MAX_IDENTIFIER_LENGTH)
            or not isBoundedNonBlankString(message, MAX_MESSAGE_LENGTH) then
            error("Scenario errors require bounded non-empty code and message strings")
        end
        finishRun(state, "error", {
            code = code,
            message = message
        })
    end

    -- Extensions add scenario-specific operations without changing the core
    -- methods above. They see the command and whether this run is still live.
    local run = {
        Command = state.Command,
        IsActive = function()
            return activeRun == state and not state.Completed and not state.Finalizing
        end,
        OwnsFixture = function(fixture)
            return state.RuntimeFixtures ~= nil and state.RuntimeFixtures[fixture] == true
        end,
        EpochMilliseconds = epochMilliseconds,
    }
    for _, extend in ipairs(contextExtensions) do
        local before = {}
        for key, value in pairs(context) do before[key] = value end
        extend(context, run)
        for key, value in pairs(before) do
            if context[key] ~= value then
                error("Context extensions cannot replace " .. tostring(key))
            end
        end
    end

    return context
end

local function runRegisteredScenario(state)
    if activeRun ~= state or state.Completed or state.Finalizing or state.ScenarioStarted then
        return
    end
    state.ScenarioStarted = true
    waitForErrorInput(state)
    local ok, scenarioError = xpcall(
        function()
            state.Scenario.Run(createContext(state))
        end,
        function(value)
            return tostring(value)
        end
    )
    if not ok and not state.Completed and not state.Finalizing then
        finishRun(state, "error", {
            code = "scenario-error",
            message = truncateString(scenarioError, MAX_MESSAGE_LENGTH)
        })
    end
end

local function startScenarioAfterErrorInput(state)
    if activeRun ~= state or state.Completed or state.Finalizing or state.ScenarioStarted then
        return
    end
    local currentTime = epochMilliseconds()
    if currentTime >= state.Command.expiresAtEpochMs then
        finishRun(state, "error", {
            code = "scenario-timeout",
            message = "Scenario command expired before execution"
        })
        return
    end
    local guardOk, guardError = requireAutoSaveSuppressed()
    if not guardOk then
        finishRun(state, "error", { code = "autosave-guard-lost", message = guardError })
        return
    end
    local observed, pending = observeErrorInput(state)
    if observed then
        return
    end
    -- ClockEpoch reports whole seconds, while commands carry milliseconds.
    -- Wait for the exact creation bound instead of starting with an inactive context.
    if pending or currentTime < state.Command.createdAtEpochMs then
        local scheduled, timerOrError = pcall(
            Ext.Timer.WaitForRealtime,
            ERROR_INPUT_POLL_MS,
            function()
                state.ErrorInputTimer = nil
                startScenarioAfterErrorInput(state)
            end
        )
        if scheduled then
            state.ErrorInputTimer = timerOrError
            return
        end
        finishRun(state, "error", {
            code = "error-input-read-failed",
            message = truncateString(timerOrError, MAX_MESSAGE_LENGTH)
        })
        return
    end
    runRegisteredScenario(state)
end

local function executeScenario(command, arm)
    if activeRun ~= nil then
        errorResult(arm, "run-active", "Another BG3 test scenario is already active")
        return
    end

    local scenario = scenarios[command.scenarioId]
    if scenario == nil then
        errorResult(arm, "unknown-scenario", "Scenario is not registered: " .. command.scenarioId)
        return
    end
    if scenario.Mode ~= command.mode then
        errorResult(
            arm,
            "scenario-mode-mismatch",
            "Scenario mode " .. scenario.Mode .. " does not match command mode " .. command.mode
        )
        return
    end
    if scenario.SavePolicy ~= command.savePolicy then
        errorResult(
            arm,
            "scenario-save-policy-mismatch",
            "Scenario save policy does not match the command"
        )
        return
    end
    if not validateAutoSaveGuard(arm) then
        errorResult(
            arm,
            "autosave-guard-missing",
            "Startup bridge did not establish the required autosave guard"
        )
        return
    end
    local guardOk, guardError = requireAutoSaveSuppressed()
    if not guardOk then
        errorResult(arm, "autosave-guard-lost", guardError)
        return
    end

    local clockNow = epochMilliseconds()
    local remainingMs = math.min(command.timeoutMs, command.expiresAtEpochMs - clockNow)
    if remainingMs <= 0 then
        errorResult(arm, "scenario-timeout", "Scenario command expired before execution")
        return
    end
    local now = math.max(
        arm.createdAtEpochMs,
        math.min(clockNow, command.expiresAtEpochMs)
    )

    local state = {
        Command = command,
        Arm = arm,
        Scenario = scenario,
        StartedAtEpochMs = now,
        Assertions = {},
        AssertionIds = {},
        CleanupCallbacks = {},
        Completed = false,
        Finalizing = false,
        ScenarioStarted = false,
        SaveRequested = false,
        SaveExecuted = false,
        CleanupDone = false,
        TimeoutTimer = nil,
        ErrorInputTimer = nil,
        ErrorInputInvalidPolls = {},
        ProtocolInputInvalidPolls = {},
        FinalizationRetryTimer = nil,
        SaveSettleTimer = nil,
        FinalStatus = nil,
        FinalError = nil,
        FinalizingAtEpochMs = nil,
        SaveIntentId = nil,
        SaveIntentAtEpochMs = nil,
        SaveAcknowledgedAtEpochMs = nil
    }
    activeRun = state
    state.TimeoutTimer = Ext.Timer.WaitForRealtime(remainingMs, function()
        finishRun(state, "error", {
            code = "scenario-timeout",
            message = "Scenario did not finish before its timeout"
        })
    end)

    writeProtocolArtifactWithRetry(
        runPath(command.runId, "server-ready.json"),
        {
            schemaVersion = PROTOCOL_VERSION,
            runId = command.runId,
            scenarioId = command.scenarioId,
            status = "ready",
            readyAtEpochMs = now
        },
        "server readiness for " .. command.runId,
        function(persisted)
            if not persisted then
                finishRun(state, "error", {
                    code = "server-ready-write-failed",
                    message = "Could not persist the server readiness marker"
                })
                return
            end
            startScenarioAfterErrorInput(state)
        end
    )
end

local function waitForCommand(arm)
    local poll
    poll = function()
        if epochMilliseconds() >= arm.expiresAtEpochMs then
            errorResult(arm, "command-timeout", "No command arrived before the armed run expired")
            return
        end

        local command, loadError = loadJson(runPath(arm.runId, "command.json"))
        if loadError == "missing" then
            Ext.Timer.WaitForRealtime(COMMAND_POLL_MS, poll)
            return
        end
        if loadError ~= nil then
            errorResult(arm, "invalid-command", "Command is not valid JSON")
            return
        end
        if not validateCommand(command, arm) then
            errorResult(arm, "invalid-command", "Command does not match the armed run")
            return
        end

        executeScenario(command, arm)
    end

    Ext.Timer.WaitForRealtime(COMMAND_POLL_MS, poll)
end

-- Registers function(context, run) called for every scenario context. Use it to
-- add operations such as client probes; it cannot replace the core methods.
function TestHarness.ExtendContext(extend)
    if type(extend) ~= "function" then
        error("Context extension requires a function")
    end
    table.insert(contextExtensions, extend)
end

function TestHarness.RegisterScenario(definition)
    if type(definition) ~= "table" then
        error("Test scenario requires a definition")
    end
    if not isSafeScenarioId(definition.Id) then
        error("Test scenario requires a safe non-empty id")
    end
    if definition.Mode ~= "runtime" and definition.Mode ~= "character-creation" then
        error("Test scenario requires a supported mode")
    end
    if type(definition.Run) ~= "function" then
        error("Test scenario requires a Run callback")
    end
    if definition.SavePolicy ~= "never"
        and definition.SavePolicy ~= "create-test-fixture"
        and definition.SavePolicy ~= "discard-campaign" then
        error("Test scenario requires an explicit save policy")
    end
    if definition.Mode == "runtime" and definition.SavePolicy ~= "never" then
        error("Runtime test scenarios require the never save policy")
    end
    if definition.Mode == "character-creation" and not hasAllowedSavePolicy(definition.Mode, definition.SavePolicy) then
        error("Character creation test scenarios must create test saves or discard their campaign")
    end
    if scenarios[definition.Id] ~= nil then
        error("Test scenario is already registered: " .. definition.Id)
    end
    scenarios[definition.Id] = {
        Id = definition.Id,
        Mode = definition.Mode,
        SavePolicy = definition.SavePolicy,
        Run = definition.Run
    }
end

Ext.Events.SessionLoaded:Subscribe(function()
    local arm, loadError = loadJson(ARM_PATH)
    if loadError ~= nil or not validateArm(arm) then
        return
    end
    if epochMilliseconds() >= arm.expiresAtEpochMs then
        errorResult(arm, "command-timeout", "Armed run expired before session load")
        return
    end
    if armedRunId ~= nil then
        return
    end

    armedRunId = arm.runId
    waitForCommand(arm)
end)

return TestHarness
