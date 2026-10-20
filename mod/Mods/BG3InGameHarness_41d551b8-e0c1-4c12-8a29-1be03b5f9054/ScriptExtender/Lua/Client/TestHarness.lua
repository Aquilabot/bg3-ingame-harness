local PROTOCOL_VERSION = 2
local ARM_PATH = "BG3InGameHarness/TestHarness/arm.json"
local RUNS_ROOT = "BG3InGameHarness/TestHarness/runs/"
local UI_POLL_MS = 250
local DEFAULT_UI_PHASE_TIMEOUT_MS = 60000
local AVATAR_BACKGROUND_TIMEOUT_MS = 180000
local NEW_CAMPAIGN_SAVE_ID = "__new_campaign__"
local MOVIE_SKIP_INTERVAL_MS = 1500
local MOVIE_SKIP_TIMEOUT_MS = 180000
local MAX_ASSERTIONS = 4096
local MAX_IDENTIFIER_LENGTH = 100
local ERROR_WRITE_RETRY_MS = 100
local ERROR_WRITE_MAX_ATTEMPTS = 300

local TestHarness = {
    StartupBypassEnabled = false,
    CharacterCreationAutomationStarted = false
}

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
    classUuid = true,
    raceUuid = true,
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
    return isNonNegativeInteger(value.createdAtEpochMs)
        and isNonNegativeInteger(value.expiresAtEpochMs)
        and isPositiveInteger(value.timeoutMs)
        and value.expiresAtEpochMs > value.createdAtEpochMs
        and value.expiresAtEpochMs - value.createdAtEpochMs == value.timeoutMs
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
        and validateRequiredAssertionIds(arm.requiredAssertionIds)
        and hasCoherentDeadline(arm)
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
        and validateRequiredAssertionIds(command.requiredAssertionIds)
        and hasCoherentDeadline(command)
        and command.createdAtEpochMs >= arm.createdAtEpochMs
        and command.expiresAtEpochMs <= arm.expiresAtEpochMs
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

local function runPath(runId, fileName)
    return RUNS_ROOT .. runId .. "/" .. fileName
end

local function loadJson(path)
    if Ext == nil or Ext.IO == nil or type(Ext.IO.LoadFile) ~= "function" then
        return nil
    end
    local loaded, contents = pcall(Ext.IO.LoadFile, path)
    if not loaded or contents == nil or Ext.Json == nil or type(Ext.Json.Parse) ~= "function" then
        return nil
    end
    local parsed, value = pcall(Ext.Json.Parse, contents)
    if not parsed or type(value) ~= "table" then
        return nil
    end
    return value
end

local function epochMilliseconds()
    if Ext == nil or Ext.Timer == nil or type(Ext.Timer.ClockEpoch) ~= "function" then
        return nil
    end
    local read, epochSeconds = pcall(Ext.Timer.ClockEpoch)
    if not read or type(epochSeconds) ~= "number" then
        return nil
    end
    return epochSeconds * 1000
end

local function monotonicMilliseconds()
    if Ext == nil or Ext.Timer == nil or type(Ext.Timer.MonotonicTime) ~= "function" then
        return nil
    end
    local read, milliseconds = pcall(Ext.Timer.MonotonicTime)
    if not read or type(milliseconds) ~= "number" then
        return nil
    end
    return milliseconds
end

local function saveJson(path, value)
    if Ext == nil
        or Ext.Json == nil
        or type(Ext.Json.Stringify) ~= "function"
        or Ext.IO == nil
        or type(Ext.IO.SaveFile) ~= "function"
    then
        return false
    end

    local serialized, contents = pcall(Ext.Json.Stringify, value)
    if not serialized then
        return false
    end
    local saved, result = pcall(Ext.IO.SaveFile, path, contents)
    if not saved or result ~= true then
        return false
    end
    local verified, persisted = pcall(Ext.IO.LoadFile, path)
    return verified and persisted == contents
end

local function printError(message)
    if Ext ~= nil
        and Ext.Utils ~= nil
        and type(Ext.Utils.PrintError) == "function" then
        pcall(Ext.Utils.PrintError, "[BG3 In-Game Harness] " .. message)
    end
end

local function writeJsonWithRetry(path, value, onComplete)
    local attempts = 0
    local function attemptWrite()
        attempts = attempts + 1
        if saveJson(path, value) then
            onComplete(true)
            return
        end
        if attempts >= ERROR_WRITE_MAX_ATTEMPTS then
            printError(
                "Could not persist " .. path .. " after " .. tostring(attempts) .. " attempts"
            )
            onComplete(false)
            return
        end
        if Ext == nil
            or Ext.Timer == nil
            or type(Ext.Timer.WaitForRealtime) ~= "function" then
            printError("Could not schedule a retry for " .. path)
            onComplete(false)
            return
        end
        local scheduled, scheduleError = pcall(
            Ext.Timer.WaitForRealtime,
            ERROR_WRITE_RETRY_MS,
            attemptWrite
        )
        if not scheduled then
            printError("Could not schedule a retry for " .. path .. ": " .. tostring(scheduleError))
            onComplete(false)
        end
    end
    attemptWrite()
end

local function enableStartupBypass(arm, now)
    if arm == nil or now == nil or now >= arm.expiresAtEpochMs then
        return false
    end
    if Ext.Utils == nil or type(Ext.Utils.GetGlobalSwitches) ~= "function" then
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

local function hasBridgeAutoSaveGuard(arm)
    local guard = loadJson(runPath(arm.runId, "autosave-guard.json"))
    return type(guard) == "table"
        and guard.schemaVersion == PROTOCOL_VERSION
        and guard.runId == arm.runId
        and guard.scenarioId == arm.scenarioId
        and guard.status == "suppressed"
        and isNonNegativeInteger(guard.suppressedAtEpochMs)
        and guard.suppressedAtEpochMs >= arm.createdAtEpochMs
        and guard.suppressedAtEpochMs <= arm.expiresAtEpochMs
end

local function safeGetProperty(object, name)
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
    if not read then
        return nil
    end
    return value
end

local function safeSetProperty(object, name, value)
    if object == nil then
        return false
    end
    return pcall(function()
        object:SetProperty(name, value)
    end)
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
    if not named or name == nil then
        return nil
    end
    return tostring(name)
end

local function findContextInVisual(root, expectedType)
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
        local context = safeGetProperty(visual, "DataContext")
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
    if Ext.UI == nil or type(Ext.UI.GetStateMachine) ~= "function" then
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
        local context = findContextInVisual(widget, expectedType)
        if context ~= nil then
            return context, widget
        end
    end

    if Ext.UI == nil or type(Ext.UI.GetRoot) ~= "function" then
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
        local context = findContextInVisual(contentRoot, expectedType)
        if context ~= nil then
            return context, contentRoot
        end
        for childIndex = 1, 9 do
            local childRead, child = pcall(function()
                return contentRoot:VisualChild(childIndex)
            end)
            if childRead and child ~= nil then
                context = findContextInVisual(child, expectedType)
                if context ~= nil then
                    return context, child
                end
            end
        end
    end
    return findContextInVisual(root, expectedType), root
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
    local function findInTree(root)
        if root == nil then
            return nil
        end
        local queue = { root }
        local visited = {}
        local offset = 1
        while offset <= #queue and offset <= 5000 do
            local candidate = queue[offset]
            offset = offset + 1
            if not visited[candidate] then
                visited[candidate] = true
                local named, candidateName = pcall(function()
                    return candidate.Name
                end)
                if named and tostring(candidateName) == name then
                    return candidate
                end
                local value = findIn(candidate)
                if value ~= nil then
                    return value
                end
                local counted, childCount = pcall(function()
                    return candidate.VisualChildrenCount
                end)
                if counted and type(childCount) == "number" then
                    for childIndex = 1, childCount do
                        local childRead, child = pcall(function()
                            return candidate:VisualChild(childIndex)
                        end)
                        if childRead and child ~= nil then
                            table.insert(queue, child)
                        end
                    end
                end
            end
        end
        return nil
    end

    local value = findInTree(container)
    if value ~= nil then
        return value
    end
    for _, widget in ipairs(activeWidgets()) do
        value = findInTree(widget)
        if value ~= nil then
            return value
        end
    end
    if Ext.UI == nil or type(Ext.UI.GetRoot) ~= "function" then
        return nil
    end
    local read, root = pcall(Ext.UI.GetRoot)
    return read and findInTree(root) or nil
end

local function describeUiObject(object)
    if object == nil then
        return { Present = false }
    end
    local description = {
        Present = true,
        LuaType = type(object),
        TypeName = typeName(object),
        DataContextType = typeName(safeGetProperty(object, "DataContext"))
    }
    local counted, childCount = pcall(function()
        return object.VisualChildrenCount
    end)
    if counted and type(childCount) == "number" then
        description.VisualChildrenCount = childCount
    end
    return description
end

local function describeUiCollection(collection)
    local description = {
        LuaType = type(collection),
        Items = {}
    }
    local counted, count = pcall(function()
        return #collection
    end)
    if counted and type(count) == "number" then
        description.Count = count
    end
    pcall(function()
        for index, value in ipairs(collection) do
            if index > 32 then
                break
            end
            table.insert(description.Items, describeUiObject(value))
        end
    end)
    return description
end

local function captureUiDiagnostics(arm)
    local diagnostics = {
        schemaVersion = PROTOCOL_VERSION,
        runId = arm.runId,
        scenarioId = arm.scenarioId,
        capturedAtEpochMs = epochMilliseconds(),
        ActiveWidgets = {}
    }
    for _, widget in ipairs(activeWidgets()) do
        table.insert(diagnostics.ActiveWidgets, describeUiObject(widget))
    end

    if Ext.UI ~= nil and type(Ext.UI.GetRoot) == "function" then
        local rootRead, root = pcall(Ext.UI.GetRoot)
        if rootRead then
            diagnostics.Root = describeUiObject(root)
            if root ~= nil then
                local contentRead, contentRoot = pcall(function()
                    return root:Find("ContentRoot")
                end)
                if contentRead then
                    diagnostics.ContentRoot = describeUiObject(contentRoot)
                    diagnostics.ContentChildren = {}
                    if contentRoot ~= nil then
                        for childIndex = 1, 9 do
                            local childRead, child = pcall(function()
                                return contentRoot:VisualChild(childIndex)
                            end)
                            if childRead and child ~= nil then
                                local childDescription = describeUiObject(child)
                                childDescription.Index = childIndex
                                table.insert(diagnostics.ContentChildren, childDescription)
                            end
                        end
                    end
                end
            end
        end
    end

    if Ext.UI ~= nil and type(Ext.UI.GetStateMachine) == "function" then
        local machineRead, machine = pcall(Ext.UI.GetStateMachine)
        if machineRead and machine ~= nil then
            local stateRead, currentState = pcall(function()
                return machine.State
            end)
            if stateRead and currentState ~= nil then
                diagnostics.State = describeUiObject(currentState)
                diagnostics.Widgets = describeUiCollection(safeGetProperty(currentState, "Widgets"))
                diagnostics.StateWidgets = describeUiCollection(safeGetProperty(currentState, "StateWidgets"))
                diagnostics.States = describeUiCollection(safeGetProperty(currentState, "States"))
            end
        end
    end

    return saveJson(runPath(arm.runId, "ui-diagnostics.json"), diagnostics)
end

local function executeNoesisCommand(command, parameter)
    if command == nil then
        return false, "missing-command"
    end
    local checked, canExecute = pcall(function()
        return command:CanExecute(parameter)
    end)
    if not checked or canExecute ~= true then
        return false, "command-disabled"
    end
    local executed = pcall(function()
        command:Execute(parameter)
    end)
    if not executed then
        return false, "command-error"
    end
    return true, nil
end

local function executeCommand(context, propertyName, parameter)
    return executeNoesisCommand(safeGetProperty(context, propertyName), parameter)
end

local function chooseDontResetTutorials(messageBox, creation)
    local actions = safeGetProperty(messageBox, "Actions")
    if actions ~= nil then
        local read, dontResetAction = pcall(function()
            return actions[2]
        end)
        if read and dontResetAction ~= nil then
            return executeNoesisCommand(
                safeGetProperty(dontResetAction, "ActionCommand"),
                safeGetProperty(dontResetAction, "ActionCommandParameter")
            )
        end
    end
    return executeCommand(creation, "CheckShowTutorialsQuestion", false)
end

local function selectedDifficultyPreset(settings)
    local presets = safeGetProperty(settings, "Presets")
    local selectedIndex = safeGetProperty(settings, "PresetSelectedIndex")
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
    if preset ~= nil then
        local executed, commandError = executeCommand(settings, "StartNewGame", preset)
        if executed then
            return true, nil
        end
        if commandError ~= "missing-command" then
            return false, commandError
        end
    end

    local confirmButton = findNamedElement(widget, "ConfirmBtn")
        or findNamedElement(widget, "StartGameButton")
    if confirmButton == nil then
        return false, "difficulty-confirm-missing"
    end
    return executeNoesisCommand(
        safeGetProperty(confirmButton, "Command"),
        safeGetProperty(confirmButton, "CommandParameter")
    )
end

local function uuidOf(value)
    local guid = safeGetProperty(value, "Guid")
    if guid == nil then
        return nil
    end
    return tostring(guid):lower()
end

local function selectClass(creation, plan, state)
    if plan.classUuid == nil then return true end
    local selector = Ext.Require("Client/ClassSelection.lua")
    return selector.Select(creation, plan, state, safeGetProperty, safeSetProperty)
end

local function selectBackground(creation, creationPlan)
    local backgrounds = safeGetProperty(creation, "SelectableBackgrounds")
    if backgrounds == nil then
        return false, "background-list-unavailable"
    end

    local selected = nil
    local requestedUuid = creationPlan.backgroundUuid:lower()
    local iterated = pcall(function()
        for _, background in ipairs(backgrounds) do
            if uuidOf(background) == requestedUuid then
                selected = background
                break
            end
        end
    end)
    if not iterated then
        return false, "background-list-unavailable"
    end
    if selected == nil then
        return false, "background-not-found"
    end
    if uuidOf(safeGetProperty(creation, "SelectedBackground")) ~= requestedUuid
        and not safeSetProperty(creation, "SelectedBackground", selected) then
        return false, "background-write-rejected"
    end
    if uuidOf(safeGetProperty(creation, "SelectedBackground")) ~= requestedUuid then
        return false, "background-selection-mismatch"
    end
    return true, nil
end

local function raceList(creation, binding, requestedUuid)
    local collection = safeGetProperty(creation, binding)
    if not collection then return nil, "list-unavailable" end
    local result = { Count = 0, Matches = 0, Guids = {}, CollectionKey = tostring(collection) }
    local read, failure = pcall(function()
        for index, item in ipairs(collection) do
            if index > 256 then error("list-limit") end
            local guid = safeGetProperty(item, "Guid")
            if type(guid) ~= "string" or not isUuid(guid) then error("guid-type-unsupported") end
            guid = guid:lower()
            result.Count = result.Count + 1
            result.Guids[#result.Guids + 1] = guid
            if guid == requestedUuid then
                if typeName(item) ~= "ls.VMSelectableRace" then error("item-type-unsupported") end
                result.Matches, result.Item = result.Matches + 1, item
            end
        end
    end)
    if not read then return nil, tostring(failure) end
    table.sort(result.Guids)
    result.Signature = table.concat(result.Guids, ";")
    return result
end

local function selectSpecies(creation, plan, state)
    if not plan.raceUuid then return true end
    local raceUuid = plan.raceUuid:lower()
    local subRaceUuid = plan.subRaceUuid and plan.subRaceUuid:lower()
    local selection = state.SpeciesSelection or {}
    state.SpeciesSelection = selection
    local races, raceError = raceList(creation, "SelectableRaces", raceUuid)
    if not races then return false, "race-" .. raceError end
    if races.Matches ~= 1 then return false, races.Matches == 0 and "race-not-found" or "race-ambiguous" end
    if uuidOf(safeGetProperty(creation, "SelectedRace")) ~= raceUuid then
        if selection.RaceWritten then return false, "race-selection-pending" end
        local before = raceList(creation, "SelectableSubRaces", subRaceUuid)
        selection.PreviousSubRaceList = before and before.Signature
        selection.PreviousSubRaceCollection = before and before.CollectionKey
        if not safeSetProperty(creation, "SelectedRace", races.Item) then return false, "race-write-rejected" end
        selection.RaceWritten, selection.Verified = true, false
        return false, "race-selection-pending"
    end
    if selection.RaceWritten and not selection.RaceObserved then
        selection.RaceObserved = true
        return false, "race-selection-settling"
    end
    local signature = raceUuid
    if subRaceUuid then
        -- Acquire the list and its item in this callback, after the race setter has reconciled.
        local subraces, subraceError = raceList(creation, "SelectableSubRaces", subRaceUuid)
        if not subraces then return false, "subrace-" .. subraceError end
        if selection.RaceWritten and not selection.SubRaceListRefreshed then
            if subraces.Signature == selection.PreviousSubRaceList
                and subraces.CollectionKey == selection.PreviousSubRaceCollection then
                return false, "subrace-list-refresh-pending"
            end
            selection.SubRaceListRefreshed = true
        end
        if subraces.Matches ~= 1 then return false, subraces.Matches == 0 and "subrace-not-found" or "subrace-ambiguous" end
        if uuidOf(safeGetProperty(creation, "SelectedSubRace")) ~= subRaceUuid then
            if selection.SubRaceWritten then return false, "subrace-selection-pending" end
            if not safeSetProperty(creation, "SelectedSubRace", subraces.Item) then return false, "subrace-write-rejected" end
            selection.SubRaceWritten, selection.Verified = true, false
            return false, "subrace-selection-pending"
        end
        signature = signature .. ":" .. subRaceUuid .. ":" .. subraces.Signature
    end
    if selection.LastSample ~= signature then
        selection.LastSample = signature
        return false, "species-selection-settling"
    end
    selection.RaceUuid, selection.SubRaceUuid, selection.Verified = raceUuid, subRaceUuid, true
    return true
end

local BACKGROUND_HANDLE_PATTERN = "^h" .. string.rep("%x", 8) .. "g" .. string.rep("%x", 4)
    .. "g" .. string.rep("%x", 4) .. "g" .. string.rep("%x", 4) .. "g" .. string.rep("%x", 12) .. "$"

local function readBackgroundText(object, propertyName, binding)
    local observed = { binding = binding }
    local value = safeGetProperty(object, propertyName)
    observed.valueType = type(value)
    if type(value) == "string" then observed.raw = value end
    local read, info = pcall(function() return object:TypeInfo() end)
    local visited = {}
    for _ = 1, 32 do
        if not read or info == nil or visited[info] then break end
        visited[info] = true
        pcall(function()
            for _, property in ipairs(info.Properties) do
                if safeGetProperty(property, "Name") == propertyName then
                    observed.contentType = safeGetProperty(safeGetProperty(property, "ContentType"), "Name")
                    break
                end
            end
        end)
        if type(observed.contentType) == "string" then break end
        info = safeGetProperty(info, "Base")
    end
    if type(observed.contentType) ~= "string" then observed.contentType = nil end
    -- Native Noesis background bindings can return a serialized handle string
    -- while their property type metadata is unavailable. Recognize only the
    -- complete BG3 handle format, without stringifying an unknown proxy.
    local serializedHandle = type(value) == "string" and value:match(BACKGROUND_HANDLE_PATTERN) ~= nil
    if type(value) ~= "string" then
        observed.error = "text-value-unavailable"
    elseif serializedHandle or observed.contentType == "ls.LocaString" then
        observed.resolution = serializedHandle and "serialized-localization-handle" or "typed-localization-handle"
        local fallback = "__BG3_HARNESS_BACKGROUND_TRANSLATION_UNAVAILABLE__"
        local translated, text = pcall(function() return Ext.Loca.GetTranslatedString(value, fallback) end)
        if translated and type(text) == "string" and text ~= fallback then
            observed.text = text
        else
            observed.error = "text-translation-unavailable"
        end
    elseif observed.contentType == "String" then
        observed.text = value
    elseif observed.contentType == nil then
        observed.error = "text-property-type-unavailable"
    else
        observed.error = "text-property-type-unsupported"
    end
    if observed.text ~= nil and observed.text:match("^%s*$") then
        observed.text = nil
        observed.error = "text-empty"
    end
    return observed
end

local function observeCreationSpecies(creation)
    local function property(object, name)
        if not object then return nil, "object-unavailable" end
        local ok, value = pcall(function() return object[name] end)
        if ok and type(value) ~= "nil" then return value end
        local read, fallback = pcall(function() return object:GetProperty(name) end)
        if read then return fallback, type(fallback) == "nil" and "property-absent" or nil end
        return nil, ok and "property-absent" or "property-read-failed"
    end
    local function item(value)
        local result = { present = not not value, luaType = type(value) }
        if not value then return result end
        local typed, nativeType = pcall(typeName, value)
        result.nativeType = typed and nativeType or nil
        local guid, failure = property(value, "Guid")
        result.guidType, result.guidError = type(guid), failure
        if type(guid) ~= "nil" then
            local rendered, raw = pcall(tostring, guid)
            if rendered then result.guidRaw = raw:sub(1, 150) else result.guidError = "guid-render-failed" end
        end
        local named, name = pcall(readBackgroundText, value, "Name", "Name")
        result.name = named and name or { error = "name-observation-failed" }
        return result
    end
    local result = { scope = "Read-only native bindings; no species selection or mechanical acceptance." }
    for _, field in ipairs({ "SelectableRaces", "SelectableSubRaces" }) do
        local collection, failure = property(creation, field)
        local observation = { present = not not collection, luaType = type(collection), error = failure, items = {} }
        if collection then
            local counted, count = pcall(function() return #collection end)
            if counted then observation.count = count end
            local iterated = pcall(function()
                for index, value in ipairs(collection) do
                    if index > 32 then observation.truncated = true; break end
                    local observed, details = pcall(item, value)
                    observation.items[#observation.items + 1] = observed and details or { error = "item-observation-failed" }
                end
            end)
            if not iterated then observation.error = "collection-read-failed" end
        end
        result[field] = observation
    end
    for _, field in ipairs({ "SelectedRace", "SelectedSubRace" }) do
        local value, failure = property(creation, field)
        local observed, details = pcall(item, value)
        result[field] = observed and details or { error = "item-observation-failed" }
        if failure then result[field].error = failure end
    end
    return result
end

local function observeRacialPassiveSelectors(creation)
    local fieldBudget = 256
    local function inspect(object)
        local result = { present = object ~= nil, fields = {}, types = {} }
        if object == nil then return result end
        result.nativeType = typeName(object)
        local read, info = pcall(function() return object:TypeInfo() end)
        if not read then result.error = "type-info-unavailable"; return result end
        local visited, count = {}, 0
        for _ = 1, 16 do
            if not info or visited[info] then break end
            visited[info] = true
            for _, property in ipairs(safeGetProperty(info, "Properties") or {}) do
                local name = safeGetProperty(property, "Name")
                if type(name) == "string" and #name <= 100 and not result.types[name] then
                    count = count + 1
                    fieldBudget = fieldBudget - 1
                    if count > 64 or fieldBudget < 0 then result.truncated = true; return result end
                    local value = safeGetProperty(object, name)
                    local kind = type(value)
                    result.types[name] = kind
                    if kind == "string" then result.fields[name] = value:sub(1, 512)
                    elseif kind == "boolean" or (kind == "number" and value == value
                        and value > -math.huge and value < math.huge) then result.fields[name] = value end
                end
            end
            info = safeGetProperty(info, "Base")
        end
        return result
    end
    local progression = safeGetProperty(creation, "RaceProgressionDetails")
    local result = { scope = "Read-only native racial passive selection bindings; no choice is changed.",
        toggleCommand = inspect(safeGetProperty(creation, "TogglePassive")) }
    for _, name in ipairs({ "NotSubPassiveSelectors", "SubPassiveSelectors" }) do
        local groups = safeGetProperty(progression, name)
        local observation = { present = groups ~= nil, groups = {} }
        for index, group in ipairs(groups or {}) do
            if index > 8 then observation.truncated = true; break end
            local details = inspect(group)
            details.passives = {}
            for passiveIndex, passive in ipairs(safeGetProperty(group, "Passives") or {}) do
                if passiveIndex > 16 then details.passivesTruncated = true; break end
                details.passives[#details.passives + 1] = inspect(passive)
            end
            observation.groups[#observation.groups + 1] = details
        end
        result[name] = observation
    end
    return result
end

-- CCLib_k.PassiveSelectorItemTemplate passes the current native passive object
-- to TogglePassive. Name and Stats.DisplayName serialize localization handles;
-- match their exact identity within the selected race, never translated labels.
local function readRacePassive(creation, passiveId)
    local loaded, displayName = pcall(function() return Ext.Stats.Get(passiveId).DisplayName end)
    if not loaded or type(displayName) ~= "string" or not displayName:match(BACKGROUND_HANDLE_PATTERN) then
        return nil, "racial-passive-stats-name-unavailable"
    end
    local progression = safeGetProperty(creation, "RaceProgressionDetails")
    local match, count = nil, 0
    for _, scope in ipairs({ "NotSubPassiveSelectors", "SubPassiveSelectors" }) do
        local groups = safeGetProperty(progression, scope)
        if groups == nil then return nil, "racial-passive-groups-unavailable" end
        for groupIndex, group in ipairs(groups) do
            if groupIndex > 8 then return nil, "racial-passive-group-limit" end
            local passives = safeGetProperty(group, "Passives")
            if passives == nil then return nil, "racial-passive-entries-unavailable" end
            for passiveIndex, passive in ipairs(passives) do
                if passiveIndex > 32 then return nil, "racial-passive-entry-limit" end
                if safeGetProperty(passive, "Name") == displayName then
                    count = count + 1
                    match = { Group = group, Item = passive, Scope = scope, DisplayName = displayName }
                end
            end
        end
    end
    if count ~= 1 then return nil, count == 0 and "racial-passive-not-found" or "racial-passive-ambiguous" end
    local group = match.Group
    if typeName(group) ~= "ls.VMCharacterCreationPassives"
        or typeName(match.Item) ~= "ls.VMCharacterCreationPassive"
        or safeGetProperty(group, "MaxSelectedPassiveCount") ~= 1 then
        return nil, "racial-passive-group-unsupported"
    end
    match.SelectedCount, match.Choices = 0, {}
    local names = {}
    for _, passive in ipairs(safeGetProperty(group, "Passives")) do
        local name, value = safeGetProperty(passive, "Name"), safeGetProperty(passive, "Value")
        if typeName(passive) ~= "ls.VMCharacterCreationPassive"
            or type(name) ~= "string" or not name:match(BACKGROUND_HANDLE_PATTERN) or names[name]
            or (value ~= 0 and value ~= 1) then return nil, "racial-passive-state-unavailable" end
        names[name] = true
        match.Choices[#match.Choices + 1] = { name = name, value = value,
            enabled = safeGetProperty(passive, "Enabled"), blocked = safeGetProperty(passive, "Blocked") }
        if value == 1 then match.SelectedCount = match.SelectedCount + 1; match.SelectedItem = passive end
    end
    if match.SelectedCount > 1 or match.SelectedCount ~= safeGetProperty(group, "SelectedPassiveCount") then
        return nil, "racial-passive-count-pending"
    end
    local complete = safeGetProperty(group, "IsComplete")
    if type(complete) ~= "boolean" or complete ~= (match.SelectedCount == 1) then
        return nil, "racial-passive-completion-pending"
    end
    match.Complete = complete
    match.Value = safeGetProperty(match.Item, "Value")
    return match
end

local function prepareRacialSelectionPanel(widget, plan, state)
    if not plan.racePassiveId or state.RacePanelPrepared then return true end
    local flow = findNamedElement(widget, "flowPage")
    local tabs = findNamedElement(widget, "gameplayTabs")
    local tab = findNamedElement(widget, "raceTab")
    if not flow or not tabs or not tab then return false, "racial-passive-panel-unavailable" end
    if safeGetProperty(flow, "SelectedIndex") ~= 0 then
        if not safeSetProperty(flow, "SelectedIndex", 0) then return false, "racial-passive-gameplay-write-rejected" end
        return false, "racial-passive-gameplay-pending"
    end
    if safeGetProperty(safeGetProperty(tabs, "SelectedItem"), "Tag") ~= "race" then
        if not safeSetProperty(tabs, "SelectedItem", tab) then return false, "racial-passive-tab-write-rejected" end
        return false, "racial-passive-tab-pending"
    end
    if not findNamedElement(widget, "racePanel") or not findNamedElement(widget, "raceListBox") then
        return false, "racial-passive-panel-pending"
    end
    state.RacePanelPrepared = true
    return true
end

local function observeRacialDefinitions(plan)
    local read, result = pcall(function() return TestHarness.RacialSelectionDiagnostics.Read(plan) end)
    if not read or type(result) ~= "table" then result = { error = "racial-definitions-observation-unavailable" } end
    result.observedAtEpochMs = epochMilliseconds()
    return result
end

local function selectRacePassive(creation, plan, arm, state, confirmOnly)
    if not plan.racePassiveId then return true end
    local selection = state.RacialPassiveSelection or { ActionCount = 0 }
    state.RacialPassiveSelection = selection
    if selection.CommandFailed then return false, selection.CommandFailed end
    local read, match, readError = pcall(readRacePassive, creation, plan.racePassiveId)
    if not read or not match then
        selection.Verified, selection.LastSample = false, nil
        local code = read and readError or "racial-passive-read-failed"
        if selection.LastReadError ~= code then
            local observed, bindings = pcall(observeRacialPassiveSelectors, creation)
            local speciesRead, species = pcall(observeCreationSpecies, creation)
            selection.NativeDefinitions = observeRacialDefinitions(plan)
            selection.DefinitionsVerified = false
            local saved = saveJson(runPath(arm.runId, "client-racial-passive.json"), {
                schemaVersion = PROTOCOL_VERSION, runId = arm.runId, scenarioId = arm.scenarioId,
                observedAtEpochMs = epochMilliseconds(), passiveId = plan.racePassiveId,
                raceUuid = plan.raceUuid, subRaceUuid = plan.subRaceUuid, status = "pending", error = code,
                bindings = observed and bindings or { error = "passive-observation-failed" },
                speciesBindings = speciesRead and species or { error = "species-observation-failed" },
                nativeDefinitions = selection.NativeDefinitions
            })
            if not saved then return false, "racial-passive-observation-write-failed" end
            selection.LastReadError = code
        end
        return false, code
    end
    local observation = { schemaVersion = PROTOCOL_VERSION, runId = arm.runId, scenarioId = arm.scenarioId,
        observedAtEpochMs = epochMilliseconds(), raceUuid = plan.raceUuid, subRaceUuid = plan.subRaceUuid,
        passiveId = plan.racePassiveId, displayNameHandle = match.DisplayName, scope = match.Scope,
        selectedCount = match.SelectedCount, maxSelectedCount = 1, complete = match.Complete,
        value = match.Value, choices = match.Choices, actionCount = selection.ActionCount, status = "pending" }
    local function persist(status)
        observation.status = status
        if status == "verified" and not selection.DefinitionsVerified then
            selection.NativeDefinitions = observeRacialDefinitions(plan)
            selection.DefinitionsVerified = true
        end
        observation.nativeDefinitions = selection.NativeDefinitions
        return saveJson(runPath(arm.runId, "client-racial-passive.json"), observation)
    end
    if selection.ActionPending then
        local observed = false
        for _, choice in ipairs(match.Choices) do
            if choice.name == selection.ActionPending.Name and choice.value == selection.ActionPending.ExpectedValue then
                observed = true
            end
        end
        if not observed then return false, "racial-passive-command-pending" end
        selection.ActionPending, selection.LastSample = nil, nil
        if not persist("command-observed") then return false, "racial-passive-observation-write-failed" end
        return false, "racial-passive-selection-settling"
    end
    if match.Value == 1 and match.SelectedCount == 1 and match.Complete then
        if selection.LastSample ~= match.DisplayName then
            selection.LastSample = match.DisplayName
            if not persist("selection-settling") then return false, "racial-passive-observation-write-failed" end
            return false, "racial-passive-selection-settling"
        end
        if not persist("verified") then return false, "racial-passive-observation-write-failed" end
        selection.Verified = true
        return true
    end
    selection.Verified, selection.LastSample, selection.DefinitionsVerified = false, nil, false
    if confirmOnly then return false, "racial-passive-changed-before-confirmation" end
    if match.Value == 1 then return false, "racial-passive-completion-pending" end
    if selection.ActionCount >= 2 then return false, "racial-passive-command-limit" end
    -- A full single-choice selector must be cleared through its native command
    -- before choosing the requested entry. Reacquire both objects on every poll.
    local item = match.SelectedItem or match.Item
    if safeGetProperty(item, "Enabled") ~= true or safeGetProperty(item, "Blocked") ~= false then
        return false, "racial-passive-option-disabled"
    end
    local expectedValue = match.SelectedItem and 0 or 1
    observation.commandName, observation.expectedValue = safeGetProperty(item, "Name"), expectedValue
    if not persist("before-toggle") then return false, "racial-passive-observation-write-failed" end
    selection.ActionCount = selection.ActionCount + 1
    selection.ActionPending = { Name = observation.commandName, ExpectedValue = expectedValue }
    local executed, commandError = executeCommand(creation, "TogglePassive", item)
    if not executed then
        selection.ActionPending = nil
        selection.CommandFailed = "racial-passive-" .. commandError
        return false, selection.CommandFailed
    end
    return false, "racial-passive-command-pending"
end

local function captureBackgroundUi(creation, widget, creationPlan, arm, state)
    local flowPage = findNamedElement(widget, "flowPage")
    local tabs = findNamedElement(widget, "gameplayTabs")
    local backgroundTab = findNamedElement(widget, "backgroundTab")
    if flowPage == nil or tabs == nil or backgroundTab == nil then
        state.BackgroundSample = nil
        return false, "background-tab-unavailable"
    end
    if safeGetProperty(flowPage, "SelectedIndex") ~= 0 then
        state.BackgroundSample = nil
        safeSetProperty(flowPage, "SelectedIndex", 0)
        return false, "background-gameplay-page-pending"
    end
    if safeGetProperty(safeGetProperty(tabs, "SelectedItem"), "Tag") ~= "background" then
        state.BackgroundSample = nil
        if not safeSetProperty(tabs, "SelectedItem", backgroundTab) then
            return false, "background-tab-write-rejected"
        end
        return false, "background-tab-pending"
    end
    if findNamedElement(widget, "backgroundPanel") == nil then
        state.BackgroundSample = nil
        return false, "background-panel-pending"
    end
    local selected = safeGetProperty(creation, "SelectedBackground")
    local selectedUuid = uuidOf(selected)
    if selectedUuid ~= creationPlan.backgroundUuid:lower() then
        state.BackgroundSample = nil
        return false, "background-selection-mismatch"
    end
    local stats = safeGetProperty(safeGetProperty(creation, "DummyCharacter"), "Stats")
    local observation = {
        schemaVersion = PROTOCOL_VERSION, runId = arm.runId, scenarioId = arm.scenarioId,
        backgroundUuid = selectedUuid, observedAtEpochMs = epochMilliseconds(),
        tab = "background", panel = "backgroundPanel", status = "pending",
        name = readBackgroundText(selected, "Name", "SelectedBackground.Name"),
        description = readBackgroundText(stats, "BackgroundDescription", "DummyCharacter.Stats.BackgroundDescription")
    }
    local speciesRead, species = pcall(observeCreationSpecies, creation)
    observation.speciesBindings = speciesRead and species or { error = "species-observation-failed" }
    local passivesRead, passives = pcall(observeRacialPassiveSelectors, creation)
    observation.racialPassiveBindings = passivesRead and passives or { error = "passive-observation-failed" }
    if creationPlan.classUuid then
        observation.classSelection = { classUuid = creationPlan.classUuid:lower(),
            verified = state.ClassSelection and state.ClassSelection.Verified == true }
    end
    if creationPlan.raceUuid then
        observation.speciesSelection = { raceUuid = creationPlan.raceUuid:lower(),
            subRaceUuid = creationPlan.subRaceUuid and creationPlan.subRaceUuid:lower(),
            verified = state.SpeciesSelection and state.SpeciesSelection.Verified == true }
        observation.speciesBindings.scope = "Native selection bindings verified by UUID; created avatar requires server acceptance."
    end
    if creationPlan.racePassiveId then
        observation.racialPassiveSelection = { passiveId = creationPlan.racePassiveId,
            verified = state.RacialPassiveSelection and state.RacialPassiveSelection.Verified == true }
    end
    if observation.name.error ~= nil or observation.description.error ~= nil then
        state.BackgroundSample = nil
        if not saveJson(runPath(arm.runId, "client-background.json"), observation) then
            return false, "background-observation-write-failed"
        end
        return false, "background-ui-text-unavailable"
    end
    local previous = state.BackgroundSample
    state.BackgroundSample = observation
    local stable = previous ~= nil and previous.backgroundUuid == selectedUuid
    for _, field in ipairs({ "name", "description" }) do
        for _, part in ipairs({ "contentType", "raw", "text" }) do
            stable = stable and previous[field][part] == observation[field][part]
        end
    end
    if not stable then return false, "background-ui-text-pending" end
    observation.status = "observed"
    observation.previousObservedAtEpochMs = previous.observedAtEpochMs
    if not saveJson(runPath(arm.runId, "client-background.json"), observation) then
        return false, "background-observation-write-failed"
    end
    return true, nil
end

local function validateCharacterName(creation)
    local characterName = tostring(safeGetProperty(creation, "CharacterName") or "")
    if characterName:match("^%s*$") ~= nil then
        return false, "character-name-missing"
    end
    local validity = safeGetProperty(creation, "Validity")
    if validity == nil then
        return false, "character-name-validity-unavailable"
    end
    if safeGetProperty(validity, "Name") ~= true then
        return false, "character-name-invalid"
    end
    return true, nil
end

local function writeClientError(arm, code, message, onComplete)
    local now = epochMilliseconds() or arm.createdAtEpochMs
    now = math.max(arm.createdAtEpochMs, math.min(now, arm.expiresAtEpochMs))
    writeJsonWithRetry(runPath(arm.runId, "client-error.json"), {
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
    }, onComplete or function() end)
end

local function hasTerminalResult(arm)
    local result = loadJson(runPath(arm.runId, "result.json"))
    if type(result) ~= "table"
        or result.schemaVersion ~= PROTOCOL_VERSION
        or result.runId ~= arm.runId
        or result.scenarioId ~= arm.scenarioId
        or (result.status ~= "passed"
            and result.status ~= "failed"
            and result.status ~= "error")
        or not isNonNegativeInteger(result.startedAtEpochMs)
        or not isNonNegativeInteger(result.completedAtEpochMs)
        or result.startedAtEpochMs < arm.createdAtEpochMs
        or result.completedAtEpochMs < result.startedAtEpochMs
        or result.completedAtEpochMs > arm.expiresAtEpochMs
    then
        return false
    end
    return true
end

local function readServerFinalizing(arm)
    local finalizing = loadJson(runPath(arm.runId, "server-finalizing.json"))
    if type(finalizing) ~= "table"
        or finalizing.schemaVersion ~= PROTOCOL_VERSION
        or finalizing.runId ~= arm.runId
        or finalizing.scenarioId ~= arm.scenarioId
        or finalizing.status ~= "finalizing"
        or not isNonNegativeInteger(finalizing.finalizingAtEpochMs)
        or finalizing.finalizingAtEpochMs < arm.createdAtEpochMs
        or finalizing.finalizingAtEpochMs > arm.expiresAtEpochMs
    then
        return nil
    end
    return finalizing
end

local function isMovieStateActive()
    if Ext.UI == nil or type(Ext.UI.GetStateMachine) ~= "function" then
        return false
    end
    local read, stateMachine = pcall(Ext.UI.GetStateMachine)
    if not read or stateMachine == nil then
        return false
    end
    local stateRead, rootState = pcall(function()
        return stateMachine.State
    end)
    if not stateRead then
        return false
    end

    local visited = {}
    local containsMovie
    local function containsMovieCollection(collection)
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
        if visited[instance] then
            return false
        end
        visited[instance] = true
        local named, name = pcall(function()
            return instance.State.Name
        end)
        if named and tostring(name) == "Movie" then
            return true
        end
        local readStates, childStates = pcall(function()
            return instance.States
        end)
        if readStates and containsMovieCollection(childStates) then
            return true
        end
        return containsMovieCollection(instance)
    end
    return containsMovie(rootState)
end

local function injectLogicalInput(eventName)
    if Ext.Input == nil or type(Ext.Input.GetInputManager) ~= "function" then
        return false
    end

    local injected = pcall(function()
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
    return injected
end

local function injectRawEscape()
    if Ext.Input == nil or type(Ext.Input.GetInputManager) ~= "function" then
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

local function startCharacterCreationAutomation(arm, command)
    local allowedPhases = {
        ["main-menu"] = true,
        difficulty = true,
        ["avatar-background"] = true,
        ["avatar-naming"] = true,
        guardian = true,
        ["campaign-starting"] = true
    }
    local progress = loadJson(runPath(arm.runId, "client-progress.json"))
    local initialPhase = "main-menu"
    if type(progress) == "table"
        and progress.runId == arm.runId
        and progress.scenarioId == arm.scenarioId
        and allowedPhases[progress.phase] == true
    then
        initialPhase = progress.phase
    end
    local state = {
        Phase = initialPhase,
        Completed = false,
        Failing = false,
        Closing = false,
        MovieEventActive = false,
        MovieObserved = false,
        MovieStartedAt = nil,
        MovieSkipAttempts = 0,
        LastMovieSkipAt = nil,
        DiagnosticsWritten = false,
        TutorialPromptHandled = false,
        TutorialPromptCleared = false,
        PhaseStartedAt = nil,
        LastPhaseErrorCode = nil,
        LastPhaseErrorMessage = nil
    }

    local readyAt = epochMilliseconds()
    if readyAt == nil or not saveJson(runPath(arm.runId, "client-ready.json"), {
        schemaVersion = PROTOCOL_VERSION,
        runId = arm.runId,
        scenarioId = arm.scenarioId,
        status = "ready",
        readyAtEpochMs = readyAt
    }) then
        return false
    end

    local skipModAvailable = Ext.Mod ~= nil and type(Ext.Mod.IsModLoaded) == "function"
    local checkedSkipMod, skipModLoaded = pcall(function()
        return Ext.Mod.IsModLoaded(command.creationPlan.requiredTransitionModUuid)
    end)
    if not skipModAvailable or not checkedSkipMod or skipModLoaded ~= true then
        writeClientError(
            arm,
            "required-transition-mod-missing",
            "Required transition mod "
                .. command.creationPlan.requiredTransitionModUuid
                .. " for "
                .. command.creationPlan.backgroundName
                .. " is not loaded"
        )
        return false
    end


    local function setPhase(phase)
        local entering = state.Phase ~= phase or state.PhaseStartedAt == nil
        if entering then
            state.PhaseStartedAt = monotonicMilliseconds()
            state.LastPhaseErrorCode = nil
            state.LastPhaseErrorMessage = nil
        end
        state.Phase = phase
        saveJson(runPath(arm.runId, "client-progress.json"), {
            schemaVersion = PROTOCOL_VERSION,
            runId = arm.runId,
            scenarioId = arm.scenarioId,
            phase = phase,
            updatedAtEpochMs = epochMilliseconds()
        })
    end
    setPhase(initialPhase)

    local function resetMovieWindow()
        state.MovieObserved = false
        state.MovieStartedAt = nil
        state.MovieSkipAttempts = 0
        state.LastMovieSkipAt = nil
    end

    if Ext.Events ~= nil
        and Ext.Events.GameStateChanged ~= nil
        and type(Ext.Events.GameStateChanged.Subscribe) == "function"
    then
        Ext.Events.GameStateChanged:Subscribe(function(event)
            local movieActive = tostring(event.ToState) == "Movie"
            if state.MovieEventActive and not movieActive then
                state.PhaseStartedAt = monotonicMilliseconds() or state.PhaseStartedAt
            end
            if movieActive ~= state.MovieEventActive then
                resetMovieWindow()
            end
            state.MovieEventActive = movieActive
        end)
    end

    local function fail(code, message)
        if state.Completed or state.Failing then
            return
        end
        state.Failing = true
        writeClientError(arm, code, message, function()
            state.Completed = true
        end)
    end

    local function waitForPhaseUi(code, message)
        state.LastPhaseErrorCode = code
        state.LastPhaseErrorMessage = message
    end

    local function phaseTimeoutMs()
        if state.Phase == "avatar-background" then
            return AVATAR_BACKGROUND_TIMEOUT_MS
        end
        return DEFAULT_UI_PHASE_TIMEOUT_MS
    end

    local function isCreationLoadingTransition()
        if state.Phase ~= "avatar-background" and state.Phase ~= "campaign-starting" then
            return false
        end
        if Ext.Utils == nil or type(Ext.Utils.GetGameState) ~= "function" then
            return false
        end
        local read, gameState = pcall(Ext.Utils.GetGameState)
        if not read then return false end
        -- Opening videos also run inside loading states, without a UI state machine.
        return tostring(gameState) == "PrepareRunning" or tostring(gameState) == "StartLoading"
    end

    local function processMovieState(now)
        local active = state.MovieEventActive or isMovieStateActive() or isCreationLoadingTransition()
        if not active then
            if state.MovieObserved then
                resetMovieWindow()
                state.PhaseStartedAt = now
            end
            return false
        end

        if not state.MovieObserved then
            state.MovieObserved = true
            state.MovieStartedAt = now
            state.MovieSkipAttempts = 0
            state.LastMovieSkipAt = now - MOVIE_SKIP_INTERVAL_MS
        end
        if now - state.MovieStartedAt >= MOVIE_SKIP_TIMEOUT_MS then
            fail(
                "movie-skip-timeout",
                "Movie state remained active for "
                    .. tostring(now - state.MovieStartedAt)
                    .. " ms after "
                    .. tostring(state.MovieSkipAttempts)
                    .. " skip attempts"
            )
            return true
        end
        if now - state.LastMovieSkipAt < MOVIE_SKIP_INTERVAL_MS then
            return true
        end

        local logicalInjected = injectLogicalInput("SkipVideo")
        local rawInjected = injectRawEscape()
        state.LastMovieSkipAt = now
        state.MovieSkipAttempts = state.MovieSkipAttempts + 1
        if not logicalInjected and not rawInjected then
            state.LastPhaseErrorCode = "movie-input-unavailable"
            state.LastPhaseErrorMessage = "Could not inject SkipVideo or raw Escape during Movie"
        end
        return true
    end

    local poll
    poll = function()
        if state.Completed or state.Failing or state.Closing then
            return
        end
        if not requireEngineAutoSaveSuppressed() then
            fail(
                "autosave-guard-lost",
                "Character creation client could not keep engine autosaves disabled"
            )
            return
        end
        local finalizing = readServerFinalizing(arm)
        if finalizing ~= nil then
            state.Closing = true
            local closedAt = epochMilliseconds() or finalizing.finalizingAtEpochMs
            closedAt = math.max(
                finalizing.finalizingAtEpochMs,
                math.min(closedAt, arm.expiresAtEpochMs)
            )
            writeJsonWithRetry(runPath(arm.runId, "client-closed.json"), {
                schemaVersion = PROTOCOL_VERSION,
                runId = arm.runId,
                scenarioId = arm.scenarioId,
                status = "closed",
                finalizingAtEpochMs = finalizing.finalizingAtEpochMs,
                closedAtEpochMs = closedAt
            }, function()
                state.Completed = true
            end)
            return
        end
        if hasTerminalResult(arm) then
            state.Completed = true
            return
        end
        local epochNow = epochMilliseconds()
        local localNow = monotonicMilliseconds()
        if epochNow == nil or localNow == nil or epochNow >= command.expiresAtEpochMs then
            fail(
                "character-creation-timeout",
                "Character creation UI automation expired in phase " .. state.Phase
            )
            return
        end
        if not state.DiagnosticsWritten then
            state.DiagnosticsWritten = captureUiDiagnostics(arm)
        end
        if processMovieState(localNow) then
            if not state.Completed and not state.Failing then
                Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
            end
            return
        end
        if state.Phase ~= "campaign-starting"
            and state.PhaseStartedAt ~= nil
            and localNow - state.PhaseStartedAt >= phaseTimeoutMs()
        then
            fail(
                state.LastPhaseErrorCode or "character-creation-phase-timeout",
                (state.LastPhaseErrorMessage or "Character creation UI did not become ready")
                    .. " in phase " .. state.Phase
            )
            return
        end

        if not state.TutorialPromptCleared
            and (state.Phase == "avatar-background"
                or state.Phase == "avatar-naming"
                or state.Phase == "guardian")
        then
            local creation = findDataContext("gui::DCCharacterCreation")
            if creation ~= nil then
                local messageBox = findDataContext("ls.DCMessageBox")
                if messageBox ~= nil then
                    if not state.TutorialPromptHandled then
                        local handled, commandError = chooseDontResetTutorials(messageBox, creation)
                        if handled then
                            state.TutorialPromptHandled = true
                        else
                            waitForPhaseUi(
                                "tutorial-prompt-dismiss-failed",
                                "Could not choose Don't Reset in the tutorial prompt: " .. tostring(commandError)
                            )
                        end
                    end
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                elseif state.TutorialPromptHandled then
                    state.TutorialPromptCleared = true
                end
            end
        end

        if state.Phase == "avatar-background" then
            local creation, widget = findDataContext("gui::DCCharacterCreation")
            if creation ~= nil then
                local panelReady, panelError = prepareRacialSelectionPanel(widget, command.creationPlan, state)
                if not panelReady then
                    waitForPhaseUi(panelError, "Native race panel is not ready for racial passive selection")
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                end
                local classSelected, classError = selectClass(creation, command.creationPlan, state)
                if not classSelected then
                    waitForPhaseUi(classError, "Waiting for the requested parent class")
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                end
                local speciesSelected, speciesError = selectSpecies(creation, command.creationPlan, state)
                if not speciesSelected then
                    waitForPhaseUi(speciesError, "Requested race or subrace is not yet selected in Character Creation")
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                end
                local passiveSelected, passiveError = selectRacePassive(creation, command.creationPlan, arm, state, false)
                if not passiveSelected then
                    waitForPhaseUi(passiveError, "Requested racial passive is not yet selected in Character Creation")
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                end
                local selected, selectionError = selectBackground(creation, command.creationPlan)
                if not selected then
                    waitForPhaseUi(
                        selectionError,
                        command.creationPlan.backgroundName
                            .. " was not available and selectable in Character Creation"
                    )
                else
                    local captured, captureError = captureBackgroundUi(creation, widget, command.creationPlan, arm, state)
                    if not captured then
                        waitForPhaseUi(captureError, "Native background tab text was not observed for "
                            .. command.creationPlan.backgroundName .. ": " .. tostring(captureError))
                        Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                        return
                    end
                    local flowPage = findNamedElement(widget, "flowPage")
                    if flowPage == nil
                        or not safeSetProperty(flowPage, "SelectedIndex", 3)
                        or safeGetProperty(flowPage, "SelectedIndex") ~= 3
                    then
                        waitForPhaseUi("naming-step-unavailable", "Could not advance Character Creation to naming")
                    else
                        setPhase("avatar-naming")
                    end
                end
            end
        elseif state.Phase == "main-menu" then
            if findDataContext("gui::DCCharacterCreation") ~= nil then
                setPhase("avatar-background")
            elseif findDataContext("gui::DCDMSettings") ~= nil then
                setPhase("difficulty")
            else
                local menu = findDataContext("gui::DCMainMenu")
                if menu ~= nil then
                    local executed, commandError = executeCommand(menu, "StartGameCommand", nil)
                    if not executed then
                        waitForPhaseUi(commandError, "Could not execute the main menu New Game command")
                    else
                        setPhase("difficulty")
                    end
                end
            end
        elseif state.Phase == "difficulty" then
            if findDataContext("gui::DCCharacterCreation") ~= nil then
                setPhase("avatar-background")
            else
                local settings, widget = findDataContext("gui::DCDMSettings")
                if settings ~= nil then
                    local executed, commandError = executeDifficultyCommand(settings, widget)
                    if not executed then
                        waitForPhaseUi(commandError, "Could not start a new campaign with the selected preset")
                    else
                        setPhase("avatar-background")
                    end
                end
            end
        elseif state.Phase == "avatar-naming" then
            local creation, widget = findDataContext("gui::DCCharacterCreation")
            if creation ~= nil then
                local classSelected, classError = selectClass(creation, command.creationPlan, state)
                if not classSelected then
                    waitForPhaseUi(classError, "Waiting for the requested parent class")
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                end
                local speciesSelected, speciesError = selectSpecies(creation, command.creationPlan, state)
                if not speciesSelected then
                    waitForPhaseUi(speciesError, "Requested species changed before avatar confirmation")
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                end
                local passiveSelected, passiveError = selectRacePassive(creation, command.creationPlan, arm, state, true)
                if not passiveSelected then
                    waitForPhaseUi(passiveError, "Requested racial passive changed before avatar confirmation")
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                end
                local flowPage = findNamedElement(widget, "flowPage")
                if flowPage == nil or safeGetProperty(flowPage, "SelectedIndex") ~= 3 then
                    waitForPhaseUi("naming-step-unavailable", "Character Creation did not enter the naming page")
                    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
                    return
                end
                local nameIsValid, nameError = validateCharacterName(creation)
                if not nameIsValid then
                    waitForPhaseUi(nameError, "Could not validate the game-generated character name")
                elseif safeGetProperty(creation, "IsCharacterComplete") ~= true then
                    waitForPhaseUi(
                        "avatar-incomplete",
                        "The avatar remained incomplete after selecting "
                            .. command.creationPlan.backgroundName
                    )
                else
                    if not safeSetProperty(flowPage, "SelectedIndex", 2)
                        or safeGetProperty(flowPage, "SelectedIndex") ~= 2
                    then
                        waitForPhaseUi("companion-step-unavailable", "Could not advance Character Creation to the guardian")
                    else
                        setPhase("guardian")
                    end
                end
            end
        elseif state.Phase == "guardian" then
            local creation = findDataContext("gui::DCCharacterCreation")
            if creation ~= nil
                and tostring(safeGetProperty(creation, "CharacterCreationStep")) == "Companion"
                and safeGetProperty(creation, "IsCharacterComplete") == true
            then
                local finished, commandError = executeCommand(creation, "FinishCreating", nil)
                if not finished then
                    waitForPhaseUi(commandError, "Could not finish guardian creation")
                else
                    setPhase("campaign-starting")
                end
            end
        end

        Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
    end

    TestHarness.CharacterCreationAutomationStarted = true
    Ext.Timer.WaitForRealtime(UI_POLL_MS, poll)
    return true
end

local arm = loadJson(ARM_PATH)
local now = epochMilliseconds()
if validateArm(arm)
    and now ~= nil
    and now < arm.expiresAtEpochMs
    and hasBridgeAutoSaveGuard(arm)
    and suppressEngineAutoSave()
then
    TestHarness.StartupBypassEnabled = enableStartupBypass(arm, now)
    if arm.mode == "character-creation" then
        local command = loadJson(runPath(arm.runId, "command.json"))
        if validateCommand(command, arm) then
            startCharacterCreationAutomation(arm, command)
        end
    end
end

-- The runtime probe shares the same arm, command and autosave checks as creation.
TestHarness.RuntimeUI = {
    Read = safeGetProperty,
    TypeName = typeName,
    Widgets = activeWidgets,
    -- Callers must first identify the live page opened by their authorized probe.
    CancelInput = injectRawEscape,
    Authorize = function(request)
        local currentArm = loadJson(ARM_PATH)
        local currentTime = epochMilliseconds()
        if type(request) ~= "table" or not validateArm(currentArm)
            or currentArm.mode ~= "runtime" or currentArm.savePolicy ~= "never"
            or currentArm.runId ~= request.runId or currentArm.scenarioId ~= request.scenarioId
            or type(request.deadline) ~= "number" or currentTime == nil
            or currentTime < currentArm.createdAtEpochMs or currentTime >= request.deadline
            or request.deadline > currentArm.expiresAtEpochMs
            or not hasBridgeAutoSaveGuard(currentArm) or not suppressEngineAutoSave()
            or Ext.IO.LoadFile(runPath(currentArm.runId, "server-finalizing.json")) ~= nil then
            return false
        end
        local command = loadJson(runPath(currentArm.runId, "command.json"))
        return validateCommand(command, currentArm) and request.deadline <= command.expiresAtEpochMs
    end
}

-- The server additionally binds these operations to the avatar created in this run.
-- They never authorize a loaded save or the runtime fixture lane.
local function authorizeNewCampaign(request, policies)
    local currentArm = loadJson(ARM_PATH)
    local currentTime = epochMilliseconds()
    if type(request) ~= "table" or not validateArm(currentArm)
        or currentArm.mode ~= "character-creation" or policies[currentArm.savePolicy] ~= true
        or currentArm.saveId ~= "__new_campaign__"
        or currentArm.runId ~= request.runId or currentArm.scenarioId ~= request.scenarioId
        or type(request.deadlineEpochMs) ~= "number" or request.deadlineEpochMs % 1 ~= 0
        or currentTime == nil or currentTime < currentArm.createdAtEpochMs
        or currentTime >= request.deadlineEpochMs or request.deadlineEpochMs > currentArm.expiresAtEpochMs
        or not hasBridgeAutoSaveGuard(currentArm) or not suppressEngineAutoSave()
        or Ext.IO.LoadFile(runPath(currentArm.runId, "server-finalizing.json")) ~= nil then return false end
    local command = loadJson(runPath(currentArm.runId, "command.json"))
    local progress = loadJson(runPath(currentArm.runId, "client-progress.json"))
    return validateCommand(command, currentArm) and request.deadlineEpochMs <= command.expiresAtEpochMs
        and type(progress) == "table" and progress.schemaVersion == PROTOCOL_VERSION
        and progress.runId == currentArm.runId and progress.scenarioId == currentArm.scenarioId
        and progress.phase == "campaign-starting"
end

-- Extensions that drive new-campaign UI (intro dialogue, level-up panels) share this
-- authorization: the arm must be a new campaign with one of the given save policies,
-- the client must have reached "campaign-starting", and the deadline must fit the run.
TestHarness.NewCampaignUI = {
    Authorize = authorizeNewCampaign,
    Read = safeGetProperty,
    TypeName = typeName,
    Widgets = activeWidgets,
    CancelInput = injectRawEscape,
    InjectLogicalInput = injectLogicalInput,
    Root = function()
        if Ext.UI == nil or type(Ext.UI.GetRoot) ~= "function" then return nil end
        local read, root = pcall(Ext.UI.GetRoot)
        if read then return root end
        return nil
    end
}

local issuedSpellPointer
local function finite(value)
    return type(value) == "number" and value > -math.huge and value < math.huge
end

-- Publishes one pointer hover/leave request for the runner. The runner accepts it
-- only if the scenario's catalog entry declares a matching pointer policy.
local POINTER_OPERATIONS = {
    ["preview-target"] = true, ["cast-target"] = true,
    ["cast-selected-target"] = true, ["inspect-target-validation"] = true,
}

function TestHarness.RuntimeUI.ReportSpellPointer(request, phase, castGuid, entries, targetLabel)
    if not TestHarness.RuntimeUI.Authorize(request) or POINTER_OPERATIONS[request.operation] ~= true
        or type(request.spellId) ~= "string" or not isUuid(request.casterUuid) or not isUuid(request.targetUuid)
        or request.casterUuid == request.targetUuid
        or type(request.sequence) ~= "number" or request.sequence < 1 or request.sequence % 1 ~= 0
        or (phase ~= "hover" and phase ~= "leave") or not isUuid(castGuid)
        or type(entries) ~= "table" or type(TestHarness.RuntimeUI.TargetLabel) ~= "table" then return false end
    local expected = TestHarness.RuntimeUI.TargetLabel.Describe(request.targetUuid)
    if targetLabel ~= expected.text then return false end
    local matches = 0
    for _, entry in ipairs(entries) do
        if entry.uuid == request.targetUuid and entry.nameVerified == true and entry.name == targetLabel then
            matches = matches + 1
        end
    end
    if matches ~= 1 then return false end
    local ok, viewport = pcall(function() return Ext.IMGUI.GetViewportSize() end)
    if not ok or type(viewport) ~= "table" or not finite(viewport[1]) or not finite(viewport[2])
        or viewport[1] < 320 or viewport[2] < 320 or viewport[1] > 16384 or viewport[2] > 16384
        or viewport[1] % 1 ~= 0 or viewport[2] % 1 ~= 0 then return false end
    local observedAt = epochMilliseconds()
    if observedAt == nil or observedAt >= request.deadline - 3000 then return false end
    local document = {
        schemaVersion = 2, runId = request.runId, scenarioId = request.scenarioId,
        stepId = request.stepId, sequence = request.sequence, operation = request.operation,
        casterUuid = request.casterUuid, targetUuid = request.targetUuid, spellId = request.spellId,
        castGuid = castGuid, phase = phase, entries = entries, targetLabel = targetLabel,
        viewport = { viewport[1], viewport[2] },
        projection = phase == "hover" and TestHarness.RuntimeUI.ProjectSpellTarget
            and TestHarness.RuntimeUI.ProjectSpellTarget(request) or nil,
        observedAtEpochMs = observedAt, expiresAtEpochMs = request.deadline - 3000,
    }
    if not saveJson(runPath(request.runId, "spell-pointer.json"), document) then return false end
    issuedSpellPointer = document
    return document
end

function TestHarness.RuntimeUI.ReadSpellPointerAck(request, pointer)
    if not TestHarness.RuntimeUI.Authorize(request) then return nil, "pointer-arm-revoked" end
    if pointer == nil or pointer ~= issuedSpellPointer then return nil, "pointer-request-not-current" end
    local currentTime = epochMilliseconds()
    if currentTime == nil or currentTime >= pointer.expiresAtEpochMs then return nil, "pointer-request-expired" end
    local ack = loadJson(runPath(request.runId, "spell-pointer-ack.json"))
    if ack == nil then return nil, "pointer-ack-missing" end
    if ack.schemaVersion ~= 2 or ack.status ~= "moved" then return nil, "pointer-ack-status-invalid" end
    for _, key in ipairs({ "runId", "scenarioId", "stepId", "sequence", "operation", "casterUuid",
        "targetUuid", "spellId", "castGuid", "phase", "targetLabel", "expiresAtEpochMs" }) do
        if ack[key] ~= pointer[key] then return nil, "pointer-ack-mismatch: " .. key end
    end
    if not finite(ack.observedAtEpochMs) or ack.observedAtEpochMs % 1 ~= 0
        or ack.observedAtEpochMs < pointer.observedAtEpochMs
        or ack.observedAtEpochMs >= pointer.expiresAtEpochMs
        -- ClockEpoch has second precision; the runner reports Date.now().
        or ack.observedAtEpochMs >= currentTime + 1000
        or type(ack.cursor) ~= "table" or not finite(ack.cursor.x) or not finite(ack.cursor.y) then
        return nil, "pointer-ack-observation-invalid"
    end
    return ack
end

return TestHarness
