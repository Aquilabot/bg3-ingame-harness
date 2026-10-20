Ext.Utils.Include(nil, "builtin://Startup.lua")
Ext.Utils.Include(nil, "builtin://BuiltinLibraryClient.lua")

local PROTOCOL_VERSION = 2
local ARM_PATH = "BG3InGameHarness/TestHarness/arm.json"
local RUNS_ROOT = "BG3InGameHarness/TestHarness/runs/"
local NEW_CAMPAIGN_SAVE_ID = "__new_campaign__"
local POLL_INTERVAL_MS = 250
local MOD_LOAD_REPLAY_TIMEOUT_MS = 120000
local INPUT_INTERVAL_MS = 1500
local MAX_INPUT_ATTEMPTS = 60
local MOVIE_SKIP_TIMEOUT_MS = 180000
local MAX_ASSERTIONS = 4096
local MAX_IDENTIFIER_LENGTH = 100
local ERROR_WRITE_RETRY_MS = 100
local ERROR_WRITE_MAX_ATTEMPTS = 300

local Bridge = {
    Armed = false,
    Attempts = 0,
    ModLoadObserved = false
}
local writeBridgeError

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

local CREATION_PLAN_KEYS = {
    kind = true,
    backgroundUuid = true,
    backgroundName = true,
    raceUuid = true,
    classUuid = true,
    subRaceUuid = true,
    racePassiveId = true,
    requiredTransitionModUuid = true
}

local function validateCreationPlan(plan)
    if type(plan) ~= "table" then
        return false
    end
    for key in pairs(plan) do
        if CREATION_PLAN_KEYS[key] ~= true then
            return false
        end
    end
    return plan.kind == "background"
        and isUuid(plan.backgroundUuid)
        and isNonBlankString(plan.backgroundName)
        and isUuid(plan.requiredTransitionModUuid)
        and (plan.raceUuid == nil or isUuid(plan.raceUuid))
        and (plan.classUuid == nil or isUuid(plan.classUuid))
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
    for _, assertionId in ipairs(value) do
        if not isNonBlankString(assertionId)
            or #assertionId > MAX_IDENTIFIER_LENGTH
            or seen[assertionId] then
            return false
        end
        seen[assertionId] = true
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

local function hasCoherentDeadline(value)
    return type(value) == "table"
        and isNonNegativeInteger(value.createdAtEpochMs)
        and isNonNegativeInteger(value.expiresAtEpochMs)
        and isPositiveInteger(value.timeoutMs)
        and value.expiresAtEpochMs > value.createdAtEpochMs
        and value.expiresAtEpochMs - value.createdAtEpochMs == value.timeoutMs
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

local function isCreationArm(arm)
    return type(arm) == "table"
        and arm.schemaVersion == PROTOCOL_VERSION
        and isSafeRunId(arm.runId)
        and isSafeScenarioId(arm.scenarioId)
        and arm.mode == "character-creation"
        and arm.saveId == NEW_CAMPAIGN_SAVE_ID
        and validateCreationPlan(arm.creationPlan)
        and hasAllowedSavePolicy(arm.mode, arm.savePolicy)
        and validateRequiredAssertionIds(arm.requiredAssertionIds)
        and hasCoherentDeadline(arm)
end

local function isRuntimeArm(arm)
    return type(arm) == "table"
        and arm.schemaVersion == PROTOCOL_VERSION
        and isSafeRunId(arm.runId)
        and isSafeScenarioId(arm.scenarioId)
        and arm.mode == "runtime"
        and isSafeSaveId(arm.saveId)
        and arm.creationPlan == nil
        and hasAllowedSavePolicy(arm.mode, arm.savePolicy)
        and validateRequiredAssertionIds(arm.requiredAssertionIds)
        and hasCoherentDeadline(arm)
end

local function isMatchingCommand(command, arm)
    local matching = type(command) == "table"
        and command.schemaVersion == PROTOCOL_VERSION
        and command.runId == arm.runId
        and command.scenarioId == arm.scenarioId
        and command.mode == arm.mode
        and command.saveId == arm.saveId
        and command.mode == "character-creation"
        and command.saveId == NEW_CAMPAIGN_SAVE_ID
        and validateCreationPlan(command.creationPlan)
        and hasAllowedSavePolicy(command.mode, command.savePolicy)
        and validateRequiredAssertionIds(command.requiredAssertionIds)
        and hasCoherentDeadline(command)
        and command.createdAtEpochMs >= arm.createdAtEpochMs
        and command.expiresAtEpochMs <= arm.expiresAtEpochMs
    if not matching then
        return false
    end
    if command.savePolicy ~= arm.savePolicy
        or not sameStringArray(command.requiredAssertionIds, arm.requiredAssertionIds) then
        return false
    end
    return command.creationPlan.kind == arm.creationPlan.kind
        and command.creationPlan.backgroundUuid == arm.creationPlan.backgroundUuid
        and command.creationPlan.backgroundName == arm.creationPlan.backgroundName
        and command.creationPlan.raceUuid == arm.creationPlan.raceUuid
        and command.creationPlan.classUuid == arm.creationPlan.classUuid
        and command.creationPlan.subRaceUuid == arm.creationPlan.subRaceUuid
        and command.creationPlan.racePassiveId == arm.creationPlan.racePassiveId
        and command.creationPlan.requiredTransitionModUuid
            == arm.creationPlan.requiredTransitionModUuid
end

local function runPath(runId, fileName)
    return RUNS_ROOT .. runId .. "/" .. fileName
end

local function loadJson(filePath)
    if Ext == nil
        or Ext.IO == nil
        or type(Ext.IO.LoadFile) ~= "function"
        or Ext.Json == nil
        or type(Ext.Json.Parse) ~= "function"
    then
        return nil
    end
    local loaded, contents = pcall(Ext.IO.LoadFile, filePath)
    if not loaded or type(contents) ~= "string" then
        return nil
    end
    local parsed, value = pcall(Ext.Json.Parse, contents)
    if not parsed or type(value) ~= "table" then
        return nil
    end
    return value
end

local function saveJson(filePath, value)
    if Ext == nil
        or Ext.Json == nil
        or type(Ext.Json.Stringify) ~= "function"
        or Ext.IO == nil
        or type(Ext.IO.SaveFile) ~= "function"
    then
        return false
    end
    local serialized, contents = pcall(Ext.Json.Stringify, value)
    if not serialized or type(contents) ~= "string" then
        return false
    end
    local saved, result = pcall(Ext.IO.SaveFile, filePath, contents)
    if not saved or result ~= true then
        return false
    end
    local verified, persisted = pcall(Ext.IO.LoadFile, filePath)
    return verified and persisted == contents
end

local function printError(message)
    if Ext ~= nil
        and Ext.Utils ~= nil
        and type(Ext.Utils.PrintError) == "function" then
        pcall(Ext.Utils.PrintError, "[BG3 harness startup bridge] " .. message)
    end
end

local function writeJsonWithRetry(filePath, value, onComplete)
    local attempts = 0
    local function attemptWrite()
        attempts = attempts + 1
        if saveJson(filePath, value) then
            onComplete(true)
            return
        end
        if attempts >= ERROR_WRITE_MAX_ATTEMPTS then
            printError(
                "Could not persist " .. filePath .. " after " .. tostring(attempts) .. " attempts"
            )
            onComplete(false)
            return
        end
        if Ext == nil
            or Ext.Timer == nil
            or type(Ext.Timer.WaitForRealtime) ~= "function" then
            printError("Could not schedule a retry for " .. filePath)
            onComplete(false)
            return
        end
        local scheduled, scheduleError = pcall(
            Ext.Timer.WaitForRealtime,
            ERROR_WRITE_RETRY_MS,
            attemptWrite
        )
        if not scheduled then
            printError("Could not schedule a retry for " .. filePath .. ": " .. tostring(scheduleError))
            onComplete(false)
        end
    end
    attemptWrite()
end

local function epochMilliseconds()
    if Ext == nil or Ext.Timer == nil or type(Ext.Timer.ClockEpoch) ~= "function" then
        return nil
    end
    local read, seconds = pcall(Ext.Timer.ClockEpoch)
    if not read or type(seconds) ~= "number" then
        return nil
    end
    return math.floor(seconds) * 1000
end

local function monotonicMilliseconds()
    if Ext == nil
        or Ext.Timer == nil
        or type(Ext.Timer.MonotonicTime) ~= "function"
    then
        return nil
    end
    local read, milliseconds = pcall(Ext.Timer.MonotonicTime)
    if not read or type(milliseconds) ~= "number" then
        return nil
    end
    return math.floor(milliseconds)
end

local function clampEpochToArm(arm, value)
    return math.max(arm.createdAtEpochMs, math.min(arm.expiresAtEpochMs, value))
end

local function writeModLoadObservation(arm, now)
    if Ext == nil
        or Ext.Mod == nil
        or type(Ext.Mod.GetLoadOrder) ~= "function"
    then
        return false
    end
    local read, loadedModules = pcall(Ext.Mod.GetLoadOrder)
    if not read or loadedModules == nil then
        return false
    end
    local loadOrder = {}
    local copied = pcall(function()
        for _, uuid in ipairs(loadedModules) do
            table.insert(loadOrder, string.lower(tostring(uuid)))
        end
    end)
    if not copied then
        return false
    end
    local saved = saveJson(runPath(arm.runId, "mod-load.json"), {
        schemaVersion = PROTOCOL_VERSION,
        runId = arm.runId,
        scenarioId = arm.scenarioId,
        status = "observed",
        observedAtEpochMs = clampEpochToArm(arm, now),
        loadOrder = loadOrder
    })
    Bridge.ModLoadObserved = saved
    return saved
end

local function enableSplashBypass()
    if Ext == nil
        or Ext.Utils == nil
        or type(Ext.Utils.GetGlobalSwitches) ~= "function"
    then
        return false
    end
    local read, switches = pcall(Ext.Utils.GetGlobalSwitches)
    if not read or switches == nil then
        return false
    end
    local changed, enabled = pcall(function()
        switches.SkipSplashScreen = true
        return switches.SkipSplashScreen == true
    end)
    return changed and enabled
end

local function suppressEngineAutoSave()
    if Ext == nil
        or Ext.Utils == nil
        or type(Ext.Utils.GetGlobalSwitches) ~= "function"
    then
        return false
    end
    local read, switches = pcall(Ext.Utils.GetGlobalSwitches)
    if not read or switches == nil then
        return false
    end
    local changed, disabled = pcall(function()
        switches.CanAutoSave = false
        return switches.CanAutoSave == false
    end)
    return changed and disabled
end

local function requireEngineAutoSaveSuppressed()
    if Ext == nil
        or Ext.Utils == nil
        or type(Ext.Utils.GetGlobalSwitches) ~= "function"
    then
        return false
    end
    local read, switches = pcall(Ext.Utils.GetGlobalSwitches)
    if not read or switches == nil then
        return false
    end
    local checked, enabled = pcall(function()
        return switches.CanAutoSave
    end)
    if checked and enabled == false then
        return true
    end
    pcall(function()
        switches.CanAutoSave = false
    end)
    return false
end

local function writeAutoSaveGuard(arm, now, onComplete)
    writeJsonWithRetry(runPath(arm.runId, "autosave-guard.json"), {
        schemaVersion = PROTOCOL_VERSION,
        runId = arm.runId,
        scenarioId = arm.scenarioId,
        status = "suppressed",
        suppressedAtEpochMs = clampEpochToArm(arm, now)
    }, onComplete)
end

local function typeName(object)
    if object == nil then
        return nil
    end
    local typed, directType = pcall(function()
        return object.Type
    end)
    if typed and directType ~= nil and tostring(directType) ~= "" then
        return tostring(directType)
    end
    local read, info = pcall(function()
        return object:TypeInfo()
    end)
    if not read or info == nil then
        return nil
    end
    local named, name = pcall(function()
        return info.Name
    end)
    return named and name ~= nil and tostring(name) or nil
end

local function property(object, name)
    if object == nil then
        return nil
    end
    local indexed, indexedValue = pcall(function()
        return object[name]
    end)
    if indexed and indexedValue ~= nil then
        return indexedValue
    end
    local read, value = pcall(function()
        return object:GetProperty(name)
    end)
    return read and value or nil
end

local function isMovieStateActive()
    if Ext == nil
        or Ext.UI == nil
        or type(Ext.UI.GetStateMachine) ~= "function"
    then
        return false
    end
    local read, stateMachine = pcall(Ext.UI.GetStateMachine)
    if not read or stateMachine == nil then
        return false
    end
    local stateRead, rootState = pcall(function()
        return stateMachine.State
    end)
    if not stateRead or rootState == nil then
        return false
    end

    local visited = {}
    local containsMovie
    local function containsMovieCollection(collection)
        if collection == nil then
            return false
        end
        local found = false
        local iterated = pcall(function()
            for _, value in ipairs(collection) do
                if containsMovie(value) then
                    found = true
                    break
                end
            end
        end)
        return iterated and found
    end

    containsMovie = function(instance)
        if instance == nil then
            return false
        end
        local instanceType = type(instance)
        if instanceType ~= "table" and instanceType ~= "userdata" then
            return false
        end
        if visited[instance] then
            return false
        end
        visited[instance] = true

        local state = property(instance, "State")
        if tostring(property(state, "Name")) == "Movie" then
            return true
        end
        if containsMovieCollection(property(instance, "States")) then
            return true
        end
        return containsMovieCollection(instance)
    end

    return containsMovie(rootState)
end

local function injectLogicalInput(eventName)
    if Ext == nil
        or Ext.Input == nil
        or type(Ext.Input.GetInputManager) ~= "function"
    then
        return false
    end
    return pcall(function()
        local manager = Ext.Input.GetInputManager()
        if manager == nil then
            error("input-manager-unavailable")
        end

        local eventId = nil
        for _, definition in pairs(manager.InputDefinitions) do
            if tostring(definition.EventName) == eventName then
                eventId = definition.EventID
                break
            end
        end
        if eventId == nil then
            error("input-event-not-found")
        end

        local queue = manager.DeviceEventInjects
        queue[#queue + 1] = {
            EventId = eventId,
            DeviceId = 0
        }
    end)
end

local function injectRawEscape()
    if Ext == nil
        or Ext.Input == nil
        or type(Ext.Input.GetInputManager) ~= "function"
    then
        return false
    end
    return pcall(function()
        local manager = Ext.Input.GetInputManager()
        if manager == nil then
            error("input-manager-unavailable")
        end
        local queue = manager.InputInjects
        queue[#queue + 1] = {
            Input = {
                InputId = "escape",
                DeviceId = 0
            },
            Value = {
                Value = 1.0,
                Value2 = 0.0,
                State = "Pressed"
            },
            InjectRawInput = true,
            Debug = false
        }
        queue[#queue + 1] = {
            Input = {
                InputId = "escape",
                DeviceId = 0
            },
            Value = {
                Value = 0.0,
                Value2 = 0.0,
                State = "Released"
            },
            InjectRawInput = true,
            Debug = false
        }
    end)
end

local function contextsInVisual(root, expectedType)
    if root == nil then
        return nil
    end
    local queue = { root }
    local offset = 1
    local inspected = 0
    while offset <= #queue and inspected < 5000 do
        local visual = queue[offset]
        offset = offset + 1
        inspected = inspected + 1
        if typeName(visual) == expectedType then
            return visual
        end
        local context = property(visual, "DataContext")
        if typeName(context) == expectedType then
            return context
        end
        local counted, childCount = pcall(function()
            return visual.VisualChildrenCount
        end)
        if counted and type(childCount) == "number" then
            for childIndex = 1, childCount do
                local childRead, child = pcall(function()
                    return visual:VisualChild(childIndex)
                end)
                if childRead and child ~= nil then
                    table.insert(queue, child)
                end
            end
        end
    end
    return nil
end

local function activeWidgets()
    if Ext == nil
        or Ext.UI == nil
        or type(Ext.UI.GetStateMachine) ~= "function"
    then
        return {}
    end
    local read, stateMachine = pcall(Ext.UI.GetStateMachine)
    if not read or stateMachine == nil then
        return {}
    end
    local stateRead, state = pcall(function()
        return stateMachine.State
    end)
    if not stateRead or state == nil then
        return {}
    end

    local widgets = {}
    local function forEach(collection, callback)
        if collection == nil then
            return false
        end
        return pcall(function()
            for _, value in ipairs(collection) do
                callback(value)
            end
        end)
    end
    local function addWidget(widget)
        if widget == nil then
            return
        end
        table.insert(widgets, widget)
        local container = property(widget, "WidgetContainerGrid")
        if container ~= nil then
            table.insert(widgets, container)
        end
    end
    local function collect(instance)
        if instance == nil then
            return
        end
        local readWidgets, currentWidgets = pcall(function()
            return instance.Widgets
        end)
        if readWidgets then
            forEach(currentWidgets, addWidget)
        end
        local readStateWidgets, currentStateWidgets = pcall(function()
            return instance.StateWidgets
        end)
        if readStateWidgets then
            forEach(currentStateWidgets, addWidget)
        end
        local readStates, childStates = pcall(function()
            return instance.States
        end)
        if readStates then
            forEach(childStates, function(row)
                if not forEach(row, collect) then
                    collect(row)
                end
            end)
        end
    end
    collect(state)
    return widgets
end

local function findDataContext(expectedType)
    for _, widget in ipairs(activeWidgets()) do
        local context = contextsInVisual(widget, expectedType)
        if context ~= nil then
            return context, widget
        end
    end
    if Ext == nil or Ext.UI == nil or type(Ext.UI.GetRoot) ~= "function" then
        return nil, nil
    end
    local read, root = pcall(Ext.UI.GetRoot)
    if not read or root == nil then
        return nil, nil
    end
    local contentRead, contentRoot = pcall(function()
        return root:Find("ContentRoot")
    end)
    if contentRead and contentRoot ~= nil then
        local context = contextsInVisual(contentRoot, expectedType)
        if context ~= nil then
            return context, contentRoot
        end
        for childIndex = 1, 9 do
            local childRead, child = pcall(function()
                return contentRoot:VisualChild(childIndex)
            end)
            if childRead and child ~= nil then
                context = contextsInVisual(child, expectedType)
                if context ~= nil then
                    return context, child
                end
            end
        end
    end
    return contextsInVisual(root, expectedType), root
end

local function findNamedElement(container, name)
    local function findIn(candidate)
        if candidate == nil then
            return nil
        end
        local found, value = pcall(function()
            return candidate:Find(name)
        end)
        return found and value or nil
    end
    local value = findIn(container)
    if value ~= nil then
        return value
    end
    for _, widget in ipairs(activeWidgets()) do
        value = findIn(widget)
        if value ~= nil then
            return value
        end
        value = findIn(property(widget, "WidgetContainerGrid"))
        if value ~= nil then
            return value
        end
    end
    if Ext ~= nil and Ext.UI ~= nil and type(Ext.UI.GetRoot) == "function" then
        local read, root = pcall(Ext.UI.GetRoot)
        if read then
            value = findIn(root)
            if value ~= nil then
                return value
            end
        end
    end
    return nil
end

local function executeNoesisCommand(command, parameter)
    if command == nil then
        return false
    end
    local checked, canExecute = pcall(function()
        return command:CanExecute(parameter)
    end)
    if not checked or canExecute ~= true then
        return false
    end
    return pcall(function()
        command:Execute(parameter)
    end)
end

local function selectedDifficultyPreset(settings)
    local presets = property(settings, "Presets")
    local selectedIndex = property(settings, "PresetSelectedIndex")
    if presets == nil or type(selectedIndex) ~= "number" then
        return nil
    end
    local read, preset = pcall(function()
        return presets[selectedIndex + 1]
    end)
    return read and preset or nil
end

local function executeDifficultyCommand(settings, widget)
    local preset = selectedDifficultyPreset(settings)
    if preset ~= nil
        and executeNoesisCommand(property(settings, "StartNewGame"), preset)
    then
        return true
    end
    local confirmButton = findNamedElement(widget, "ConfirmBtn")
        or findNamedElement(widget, "StartGameButton")
    return confirmButton ~= nil and executeNoesisCommand(
        property(confirmButton, "Command"),
        property(confirmButton, "CommandParameter")
    )
end

local function clientIsReady(arm)
    local ready = loadJson(runPath(arm.runId, "client-ready.json"))
    return type(ready) == "table"
        and ready.schemaVersion == PROTOCOL_VERSION
        and ready.runId == arm.runId
        and ready.scenarioId == arm.scenarioId
        and ready.status == "ready"
        and isNonNegativeInteger(ready.readyAtEpochMs)
        and ready.readyAtEpochMs >= arm.createdAtEpochMs
        and ready.readyAtEpochMs <= arm.expiresAtEpochMs
end

local function serverIsReady(arm)
    local ready = loadJson(runPath(arm.runId, "server-ready.json"))
    return type(ready) == "table"
        and ready.schemaVersion == PROTOCOL_VERSION
        and ready.runId == arm.runId
        and ready.scenarioId == arm.scenarioId
        and ready.status == "ready"
        and isNonNegativeInteger(ready.readyAtEpochMs)
        and ready.readyAtEpochMs >= arm.createdAtEpochMs
        and ready.readyAtEpochMs <= arm.expiresAtEpochMs
end

local function writeStartupClosed(arm, now, onComplete)
    writeJsonWithRetry(runPath(arm.runId, "startup-closed.json"), {
        schemaVersion = PROTOCOL_VERSION,
        runId = arm.runId,
        scenarioId = arm.scenarioId,
        status = "closed",
        closedAtEpochMs = clampEpochToArm(arm, now)
    }, onComplete or function() end)
end

writeBridgeError = function(arm, startedAt, completedAt, code, message, onComplete)
    if not isNonNegativeInteger(startedAt) or not isNonNegativeInteger(completedAt) then
        onComplete(false)
        return
    end
    startedAt = clampEpochToArm(arm, startedAt)
    completedAt = math.max(startedAt, clampEpochToArm(arm, completedAt))
    writeJsonWithRetry(runPath(arm.runId, "startup-error.json"), {
        schemaVersion = PROTOCOL_VERSION,
        runId = arm.runId,
        scenarioId = arm.scenarioId,
        status = "error",
        startedAtEpochMs = startedAt,
        completedAtEpochMs = completedAt,
        assertions = {},
        error = {
            code = code,
            message = message
        }
    }, onComplete)
end

local function startRuntimeModLoadObservation(arm, now)
    local startedAtMonotonicMs = monotonicMilliseconds()
    if startedAtMonotonicMs == nil then
        return false
    end
    writeModLoadObservation(arm, now)

    local stopped = false
    local poll
    poll = function()
        local currentEpochMs = epochMilliseconds()
        local currentMonotonicMs = monotonicMilliseconds()
        if stopped
            or currentEpochMs == nil
            or currentMonotonicMs == nil
            or currentEpochMs >= arm.expiresAtEpochMs
        then
            return
        end
        if not requireEngineAutoSaveSuppressed() then
            stopped = true
            writeBridgeError(
                arm,
                now,
                currentEpochMs,
                "autosave-guard-lost",
                "Startup bridge could not keep engine autosaves disabled",
                function() end
            )
            return
        end
        if serverIsReady(arm) then
            return
        end
        if currentMonotonicMs - startedAtMonotonicMs < MOD_LOAD_REPLAY_TIMEOUT_MS then
            writeModLoadObservation(arm, currentEpochMs)
        end
        Ext.Timer.WaitForRealtime(POLL_INTERVAL_MS, poll)
    end

    Ext.Timer.WaitForRealtime(POLL_INTERVAL_MS, poll)
    return true
end

local function start(arm, command, now)
    local startedAtMonotonicMs = monotonicMilliseconds()
    if startedAtMonotonicMs == nil then
        return false
    end
    local progressPath = runPath(arm.runId, "startup-bridge.json")
    local progress = loadJson(progressPath)
    local attempts = 0
    local lastInputAtMonotonicMs = startedAtMonotonicMs - INPUT_INTERVAL_MS
    if type(progress) == "table"
        and progress.schemaVersion == PROTOCOL_VERSION
        and progress.runId == arm.runId
        and progress.scenarioId == arm.scenarioId
        and isNonNegativeInteger(progress.attempts)
    then
        attempts = progress.attempts
    end
    Bridge.Attempts = attempts
    Bridge.Armed = true
    enableSplashBypass()

    local movieObserved = false
    local movieStartedAtMonotonicMs = nil
    local movieLastInputAtMonotonicMs = nil
    local movieAttempts = 0
    local stopped = false
    local terminalErrorWriting = false

    local function resetMovieWindow()
        movieObserved = false
        movieStartedAtMonotonicMs = nil
        movieLastInputAtMonotonicMs = nil
        movieAttempts = 0
    end

    local function processMovieState(currentEpochMs, currentMonotonicMs)
        if not isMovieStateActive() then
            if movieObserved then
                resetMovieWindow()
            end
            return false
        end
        if not movieObserved then
            movieObserved = true
            movieStartedAtMonotonicMs = currentMonotonicMs
            movieLastInputAtMonotonicMs = currentMonotonicMs - INPUT_INTERVAL_MS
            movieAttempts = 0
        end
        local movieElapsedMs = currentMonotonicMs - movieStartedAtMonotonicMs
        if movieElapsedMs >= MOVIE_SKIP_TIMEOUT_MS then
            if terminalErrorWriting then
                return true
            end
            terminalErrorWriting = true
            writeBridgeError(
                arm,
                now,
                currentEpochMs,
                "movie-skip-timeout",
                "Startup Movie remained active for "
                    .. tostring(movieElapsedMs)
                    .. " ms after "
                    .. tostring(movieAttempts)
                    .. " skip attempts",
                function()
                    stopped = true
                end
            )
            return true
        end
        if currentMonotonicMs - movieLastInputAtMonotonicMs < INPUT_INTERVAL_MS then
            return true
        end

        injectLogicalInput("SkipVideo")
        injectRawEscape()
        movieLastInputAtMonotonicMs = currentMonotonicMs
        movieAttempts = movieAttempts + 1
        return true
    end

    local clientProgressPath = runPath(arm.runId, "client-progress.json")
    local clientProgress = loadJson(clientProgressPath)
    local phase = "main-menu"
    if type(clientProgress) == "table"
        and clientProgress.schemaVersion == PROTOCOL_VERSION
        and clientProgress.runId == arm.runId
        and clientProgress.scenarioId == arm.scenarioId
        and (clientProgress.phase == "main-menu"
            or clientProgress.phase == "difficulty"
            or clientProgress.phase == "avatar-background")
    then
        phase = clientProgress.phase
    end

    local function setPhase(value)
        phase = value
        saveJson(clientProgressPath, {
            schemaVersion = PROTOCOL_VERSION,
            runId = arm.runId,
            scenarioId = arm.scenarioId,
            phase = value,
            updatedAtEpochMs = clampEpochToArm(arm, epochMilliseconds())
        })
    end

    local poll
    poll = function()
        local currentEpochMs = epochMilliseconds()
        local currentMonotonicMs = monotonicMilliseconds()
        if currentEpochMs == nil
            or currentMonotonicMs == nil
            or currentEpochMs >= command.expiresAtEpochMs
        then
            return
        end
        writeModLoadObservation(arm, currentEpochMs)
        if clientIsReady(arm) then
            stopped = true
            writeStartupClosed(arm, currentEpochMs, function() end)
            return
        end
        if terminalErrorWriting then
            return
        end
        if not requireEngineAutoSaveSuppressed() then
            terminalErrorWriting = true
            writeBridgeError(
                arm,
                now,
                currentEpochMs,
                "autosave-guard-lost",
                "Startup bridge could not keep engine autosaves disabled",
                function()
                    stopped = true
                end
            )
            return
        end
        if processMovieState(currentEpochMs, currentMonotonicMs) then
            if not stopped and not terminalErrorWriting then
                Ext.Timer.WaitForRealtime(POLL_INTERVAL_MS, poll)
            end
            return
        end
        local handledUi = false
        if phase == "main-menu" then
            if findDataContext("gui::DCCharacterCreation") ~= nil then
                setPhase("avatar-background")
                handledUi = true
            elseif findDataContext("gui::DCDMSettings") ~= nil then
                setPhase("difficulty")
                handledUi = true
            else
                local menu = findDataContext("gui::DCMainMenu")
                if menu ~= nil then
                    handledUi = true
                    if executeNoesisCommand(property(menu, "StartGameCommand"), nil) then
                        setPhase("difficulty")
                    end
                end
            end
        elseif phase == "difficulty" then
            if findDataContext("gui::DCCharacterCreation") ~= nil then
                setPhase("avatar-background")
                handledUi = true
            else
                local settings, widget = findDataContext("gui::DCDMSettings")
                if settings ~= nil then
                    handledUi = true
                    if executeDifficultyCommand(settings, widget) then
                        setPhase("avatar-background")
                    end
                end
            end
        else
            handledUi = findDataContext("gui::DCCharacterCreation") ~= nil
        end

        if not handledUi
            and phase == "main-menu"
            and attempts < MAX_INPUT_ATTEMPTS
            and currentMonotonicMs - lastInputAtMonotonicMs >= INPUT_INTERVAL_MS
            and Ext.Input ~= nil
            and type(Ext.Input.InjectKeyPress) == "function"
        then
            local injected = pcall(Ext.Input.InjectKeyPress, "F13")
            if injected then
                attempts = attempts + 1
                lastInputAtMonotonicMs = currentMonotonicMs
                Bridge.Attempts = attempts
                saveJson(progressPath, {
                    schemaVersion = PROTOCOL_VERSION,
                    runId = arm.runId,
                    scenarioId = arm.scenarioId,
                    attempts = attempts
                })
            end
        end
        Ext.Timer.WaitForRealtime(POLL_INTERVAL_MS, poll)
    end

    if now < command.expiresAtEpochMs
        and Ext.Timer ~= nil
        and type(Ext.Timer.WaitForRealtime) == "function"
    then
        Ext.Timer.WaitForRealtime(POLL_INTERVAL_MS, poll)
    end
end

local arm = loadJson(ARM_PATH)
local now = epochMilliseconds()
if isRuntimeArm(arm) and now ~= nil and now < arm.expiresAtEpochMs then
    if suppressEngineAutoSave() then
        writeAutoSaveGuard(arm, now, function(persisted)
            if persisted and requireEngineAutoSaveSuppressed() then
                Bridge.Armed = true
                startRuntimeModLoadObservation(arm, now)
            end
        end)
    else
        writeBridgeError(
            arm,
            now,
            now,
            "autosave-guard-unavailable",
            "Startup bridge could not disable engine autosaves before runtime loading",
            function() end
        )
    end
elseif isCreationArm(arm) and now ~= nil and now < arm.expiresAtEpochMs then
    local command = loadJson(runPath(arm.runId, "command.json"))
    if isMatchingCommand(command, arm) and now < command.expiresAtEpochMs then
        if suppressEngineAutoSave() then
            writeAutoSaveGuard(arm, now, function(persisted)
                if persisted and requireEngineAutoSaveSuppressed() then
                    writeModLoadObservation(arm, now)
                    start(arm, command, now)
                end
            end)
        else
            writeBridgeError(
                arm,
                now,
                now,
                "autosave-guard-unavailable",
                "Startup bridge could not disable engine autosaves before character creation",
                function() end
            )
        end
    end
end

return Bridge
