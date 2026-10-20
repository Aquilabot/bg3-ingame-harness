local BRIDGE_PATH = "bridge/client-startup-bridge.lua"
local ARM_PATH = "BG3InGameHarness/TestHarness/arm.json"
local RUNTIME_SAVE_ID = "safe-runtime-save_01"
local BACKGROUND_UUID = "00000000-0000-0000-0000-000000000002"

local RULES_UUID = "0508cc3f-d202-4ae5-a927-7c837bd40de6"
local INTRO_SKIP_UUID = "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c"
local HARNESS_UUID = "41d551b8-e0c1-4c12-8a29-1be03b5f9054"
local EXAMPLE_MOD_UUID = "cd639062-7736-457d-aa6a-c364979b8921"

local function arm(runId)
    return {
        schemaVersion = 2,
        runId = runId,
        scenarioId = "second.background-smoke",
        mode = "character-creation",
        savePolicy = "create-test-fixture",
        saveId = "__new_campaign__",
        requiredAssertionIds = { "background-selected" },
        createdAtEpochMs = 1000,
        expiresAtEpochMs = 61000,
        timeoutMs = 60000,
        creationPlan = {
            kind = "background",
            backgroundUuid = BACKGROUND_UUID,
            backgroundName = "Generic Background",
            requiredTransitionModUuid = INTRO_SKIP_UUID
        }
    }
end

local function command(runId)
    return {
        schemaVersion = 2,
        runId = runId,
        scenarioId = "second.background-smoke",
        mode = "character-creation",
        savePolicy = "create-test-fixture",
        saveId = "__new_campaign__",
        requiredAssertionIds = { "background-selected" },
        createdAtEpochMs = 1000,
        expiresAtEpochMs = 61000,
        timeoutMs = 60000,
        creationPlan = {
            kind = "background",
            backgroundUuid = BACKGROUND_UUID,
            backgroundName = "Generic Background",
            requiredTransitionModUuid = INTRO_SKIP_UUID
        }
    }
end

local function dataContext(typeName, properties)
    local context = properties or {}
    context.Type = typeName
    context.TypeInfo = function()
        error("Noesis v32 viewmodels expose Type directly")
    end
    context.GetProperty = function(self, name)
        return rawget(self, name)
    end
    return context
end

local function commandProperty(onExecute)
    return {
        CanExecute = function()
            return true
        end,
        Execute = function(_, parameter)
            onExecute(parameter)
        end
    }
end

local function visualWithContext(context, namedElements)
    return {
        VisualChildrenCount = 0,
        TypeInfo = function()
            return { Name = "Noesis::Grid" }
        end,
        GetProperty = function(_, name)
            if name == "DataContext" then
                return context
            end
            return nil
        end,
        VisualChild = function()
            return nil
        end,
        Find = function(_, name)
            return (namedElements or {})[name]
        end
    }
end

local function oneBasedNestedVisual(child)
    return {
        VisualChildrenCount = 1,
        TypeInfo = function()
            return { Name = "Noesis::Grid" }
        end,
        GetProperty = function()
            return nil
        end,
        VisualChild = function(_, index)
            assert(index >= 1, "Noesis VisualChild received a zero-based index")
            if index == 1 then
                return child
            end
            return nil
        end,
        Find = function()
            return nil
        end
    }
end

local function officialMainMenuRoot(menuVisual)
    local contentRoot = {
        VisualChildrenCount = 0,
        TypeInfo = function()
            return { Name = "Noesis::Grid" }
        end,
        GetProperty = function()
            return nil
        end,
        VisualChild = function(_, index)
            if index == 1 then
                return menuVisual
            end
            return nil
        end
    }
    return {
        VisualChildrenCount = 0,
        TypeInfo = function()
            return { Name = "Noesis::Grid" }
        end,
        GetProperty = function()
            return nil
        end,
        VisualChild = function()
            return nil
        end,
        Find = function(_, name)
            if name == "ContentRoot" then
                return contentRoot
            end
            return nil
        end
    }
end

local function namedRoot(namedElements)
    return {
        VisualChildrenCount = 0,
        TypeInfo = function()
            return { Name = "Noesis::Grid" }
        end,
        GetProperty = function()
            return nil
        end,
        VisualChild = function()
            return nil
        end,
        Find = function(_, name)
            return namedElements[name]
        end
    }
end

local function movieStateTree()
    return {
        {
            {
                State = { Name = "Movie" },
                States = {}
            }
        }
    }
end

local function createEnvironment(runId, customize)
    local files = {}
    local parsed = {}
    local savedValues = {}
    local timers = {}
    local included = {}
    local inputKeys = {}
    local inputEvents = {}
    local rawInputEvents = {}
    local root = nil
    local stateWidget = nil
    local stateStates = {}
    local epochMilliseconds = 2000
    local monotonicMilliseconds = 2000
    local switches = { SkipSplashScreen = false, CanAutoSave = true }
    local globalSwitchesAvailable = true
    local modLoadOrder = {
        "28ac9ce2-2aba-8cda-b3b5-6e922f71b6b8",
        RULES_UUID,
        INTRO_SKIP_UUID,
        HARNESS_UUID,
        EXAMPLE_MOD_UUID
    }
    local stringifying = nil
    local startupErrorSaveFailures = 0

    local selectedArm = arm(runId)
    local selectedCommand = command(runId)
    if customize ~= nil then
        customize(selectedArm, selectedCommand, files, parsed)
    end
    globalSwitchesAvailable = selectedArm.testGlobalSwitchesUnavailable ~= true
    selectedArm.testGlobalSwitchesUnavailable = nil
    if selectedArm.testAutosaveWriteRejected == true then
        selectedArm.testAutosaveWriteRejected = nil
        local backing = switches
        switches = setmetatable({}, {
            __index = backing,
            __newindex = function(_, key, value)
                if key ~= "CanAutoSave" or value ~= false then
                    backing[key] = value
                end
            end
        })
    end
    startupErrorSaveFailures = selectedArm.testStartupErrorSaveFailures or 0
    selectedArm.testStartupErrorSaveFailures = nil
    files[ARM_PATH] = files[ARM_PATH] or "ARM"
    parsed.ARM = parsed.ARM or selectedArm
    local runRoot = "BG3InGameHarness/TestHarness/runs/" .. runId
    files[runRoot .. "/command.json"] = files[runRoot .. "/command.json"] or "COMMAND"
    parsed.COMMAND = parsed.COMMAND or selectedCommand

    Ext = {
        IO = {
            LoadFile = function(filePath)
                return files[filePath]
            end,
            SaveFile = function(filePath, contents)
                if startupErrorSaveFailures > 0
                    and filePath:match("/startup%-error%.json$") ~= nil then
                    startupErrorSaveFailures = startupErrorSaveFailures - 1
                    return false
                end
                files[filePath] = contents
                savedValues[filePath] = stringifying
                return true
            end
        },
        Json = {
            Parse = function(contents)
                local value = parsed[contents]
                if value == nil then
                    error("invalid JSON")
                end
                return value
            end,
            Stringify = function(value)
                stringifying = value
                return "SERIALIZED"
            end
        },
        Timer = {
            ClockEpoch = function()
                return math.floor(epochMilliseconds / 1000)
            end,
            MonotonicTime = function()
                return monotonicMilliseconds
            end,
            WaitForRealtime = function(_, callback)
                table.insert(timers, callback)
                return #timers
            end
        },
        Utils = {
            Include = function(mod, filePath)
                table.insert(included, { mod = mod, path = filePath })
            end,
            GetGlobalSwitches = function()
                if not globalSwitchesAvailable then
                    return nil
                end
                return switches
            end
        },
        UI = {
            GetRoot = function()
                return root
            end,
            GetStateMachine = function()
                return {
                    State = {
                        Widgets = {},
                        StateWidgets = stateWidget == nil and {} or { stateWidget },
                        States = stateStates
                    }
                }
            end
        },
        Input = {
            InjectKeyPress = function(key)
                table.insert(inputKeys, key)
            end,
            GetInputManager = function()
                return {
                    InputDefinitions = {
                        { EventName = "UICancel", EventID = 225 },
                        { EventName = "SkipVideo", EventID = 180 }
                    },
                    DeviceEventInjects = inputEvents,
                    InputInjects = rawInputEvents
                }
            end
        },
        Mod = {
            GetLoadOrder = function()
                return modLoadOrder
            end
        }
    }

    local Bridge = dofile(BRIDGE_PATH)
    return {
        Bridge = Bridge,
        RunNextTimer = function()
            assert(#timers > 0, "Startup bridge did not schedule a poll")
            local callback = table.remove(timers, 1)
            callback()
        end,
        TimerCount = function()
            return #timers
        end,
        SetRoot = function(value)
            root = value
        end,
        SetStateWidget = function(value)
            stateWidget = value
        end,
        SetStateStates = function(value)
            stateStates = value
        end,
        SetEpochMilliseconds = function(value)
            epochMilliseconds = value
            monotonicMilliseconds = value
        end,
        SetReady = function()
            local marker = "READY"
            files[runRoot .. "/client-ready.json"] = marker
            parsed[marker] = {
                schemaVersion = 2,
                runId = runId,
                scenarioId = selectedArm.scenarioId,
                status = "ready",
                readyAtEpochMs = math.floor(epochMilliseconds / 1000) * 1000
            }
        end,
        SetServerReady = function()
            local marker = "SERVER_READY"
            files[runRoot .. "/server-ready.json"] = marker
            parsed[marker] = {
                schemaVersion = 2,
                runId = runId,
                scenarioId = selectedArm.scenarioId,
                status = "ready",
                readyAtEpochMs = math.floor(epochMilliseconds / 1000) * 1000
            }
        end,
        SetModLoadOrder = function(value)
            modLoadOrder = value
        end,
        SetGlobalSwitchesAvailable = function(value)
            globalSwitchesAvailable = value
        end,
        Included = included,
        InputKeys = inputKeys,
        InputEvents = inputEvents,
        RawInputEvents = rawInputEvents,
        Switches = switches,
        SavedValue = function(fileName)
            return savedValues[runRoot .. "/" .. fileName]
        end
    }
end

do
    local environment = createEnvironment("run-startup-bridge")
    assert(#environment.Included == 2, "Startup bridge did not load exactly two official builtins")
    assert(environment.Included[1].path == "builtin://Startup.lua", "Startup bridge loaded the wrong first builtin")
    assert(environment.Included[2].path == "builtin://BuiltinLibraryClient.lua", "Startup bridge loaded the wrong client builtin")
    assert(environment.Bridge.Armed == true, "Valid character creation did not arm the startup bridge")
    assert(environment.Switches.SkipSplashScreen == true, "Startup bridge did not enable splash skipping")
    assert(environment.Switches.CanAutoSave == false, "Startup bridge did not suppress engine autosaves")
    local autosaveGuard = environment.SavedValue("autosave-guard.json")
    assert(autosaveGuard ~= nil and autosaveGuard.status == "suppressed", "Startup bridge did not persist its autosave guard")

    environment.RunNextTimer()
    assert(#environment.InputKeys == 1 and environment.InputKeys[1] == "F13", "Startup bridge did not inject its focus-independent title key")
    local progress = environment.SavedValue("startup-bridge.json")
    assert(progress ~= nil and progress.attempts == 1, "Startup bridge did not persist its input attempt")
    assert(
        progress.lastInputAtMonotonicMs == nil,
        "Startup bridge persisted a process-local monotonic timestamp"
    )

    local startedGame = 0
    local mainMenuVisual = visualWithContext(dataContext("gui::DCMainMenu", {
        StartGameCommand = commandProperty(function()
            startedGame = startedGame + 1
        end)
    }))
    environment.SetRoot(officialMainMenuRoot(mainMenuVisual))
    environment.SetEpochMilliseconds(4000)
    environment.RunNextTimer()
    assert(startedGame == 1, "Startup bridge did not execute the semantic New Game command")
    assert(#environment.InputKeys == 1, "Startup bridge injected a key on the main menu")

    local selectedPreset = dataContext("gui::DifficultyPreset")
    local startedCampaignWith = nil
    local difficulty = dataContext("gui::DCDMSettings", {
        Presets = { dataContext("gui::DifficultyPreset"), selectedPreset },
        PresetSelectedIndex = 1,
        StartNewGame = commandProperty(function(parameter)
            startedCampaignWith = parameter
        end)
    })
    environment.SetStateWidget(visualWithContext(difficulty))
    environment.SetRoot(namedRoot({}))
    environment.RunNextTimer()
    assert(startedCampaignWith == selectedPreset, "Startup bridge did not confirm the selected difficulty")

    environment.SetStateWidget(visualWithContext(dataContext("gui::DCCharacterCreation")))
    environment.RunNextTimer()
    local creationProgress = environment.SavedValue("client-progress.json")
    assert(creationProgress ~= nil and creationProgress.phase == "avatar-background", "Startup bridge did not hand off at character creation")

    environment.SetReady()
    environment.RunNextTimer()
    assert(environment.TimerCount() == 0, "Startup bridge kept polling after the mod client became ready")
    local startupClosed = environment.SavedValue("startup-closed.json")
    assert(startupClosed ~= nil and startupClosed.status == "closed", "Startup bridge did not seal its error producer")
end

do
    local environment = createEnvironment("run-autosave-guard-unavailable", function(selectedArm)
        selectedArm.testGlobalSwitchesUnavailable = true
    end)
    assert(environment.Bridge.Armed == false, "Startup bridge armed without global switches")
    assert(environment.SavedValue("autosave-guard.json") == nil, "Unavailable autosave guard was reported as persisted")
    assert(environment.SavedValue("mod-load.json") == nil, "Startup bridge published mod-load without an autosave guard")
    local failure = environment.SavedValue("startup-error.json")
    assert(failure ~= nil and failure.error.code == "autosave-guard-unavailable", "Unavailable autosave guard did not publish a fail-stop artifact")
    assert(environment.TimerCount() == 0, "Startup bridge scheduled work without an autosave guard")
end

do
    local environment = createEnvironment("run-autosave-guard-rejected", function(selectedArm)
        selectedArm.testAutosaveWriteRejected = true
    end)
    assert(environment.Bridge.Armed == false, "Startup bridge armed after CanAutoSave rejected the write")
    assert(environment.Switches.CanAutoSave == true, "Rejected CanAutoSave write changed the mock state")
    assert(environment.SavedValue("mod-load.json") == nil, "Rejected autosave guard published mod-load")
    local failure = environment.SavedValue("startup-error.json")
    assert(failure ~= nil and failure.error.code == "autosave-guard-unavailable", "Rejected autosave guard did not fail-stop")
end

do
    local environment = createEnvironment("run-runtime-guard-watchdog", function(selectedArm, selectedCommand)
        selectedArm.mode = "runtime"
        selectedArm.savePolicy = "never"
        selectedArm.scenarioId = "core.runtime-smoke"
        selectedArm.saveId = RUNTIME_SAVE_ID
        selectedArm.creationPlan = nil
        selectedArm.expiresAtEpochMs = 301000
        selectedArm.timeoutMs = 300000
        selectedCommand.mode = selectedArm.mode
        selectedCommand.savePolicy = selectedArm.savePolicy
        selectedCommand.scenarioId = selectedArm.scenarioId
        selectedCommand.saveId = selectedArm.saveId
        selectedCommand.creationPlan = nil
        selectedCommand.expiresAtEpochMs = 301000
        selectedCommand.timeoutMs = 300000
    end)
    environment.SetEpochMilliseconds(123000)
    environment.RunNextTimer()
    assert(environment.TimerCount() == 1, "Runtime autosave watchdog stopped after the mod-load replay window")
    environment.SetServerReady()
    environment.RunNextTimer()
    assert(environment.TimerCount() == 0, "Runtime autosave watchdog continued after Server ownership")
end

do
    local environment = createEnvironment("run-runtime-autosave-guard-lost", function(selectedArm, selectedCommand)
        selectedArm.mode = "runtime"
        selectedArm.savePolicy = "never"
        selectedArm.scenarioId = "core.runtime-smoke"
        selectedArm.saveId = RUNTIME_SAVE_ID
        selectedArm.creationPlan = nil
        selectedCommand.mode = selectedArm.mode
        selectedCommand.savePolicy = selectedArm.savePolicy
        selectedCommand.scenarioId = selectedArm.scenarioId
        selectedCommand.saveId = selectedArm.saveId
        selectedCommand.creationPlan = nil
    end)
    environment.SetGlobalSwitchesAvailable(false)
    environment.RunNextTimer()
    local failure = environment.SavedValue("startup-error.json")
    assert(failure ~= nil and failure.error.code == "autosave-guard-lost", "Lost runtime autosave guard did not fail closed")
    assert(environment.TimerCount() == 0, "Lost runtime autosave guard kept replaying mod-load")
end

do
    local runId = "run-relaunched-monotonic-clock"
    local environment = createEnvironment(runId, function(_, _, files, parsed)
        local progressPath = "BG3InGameHarness/TestHarness/runs/"
            .. runId
            .. "/startup-bridge.json"
        files[progressPath] = "OLD_PROGRESS"
        parsed.OLD_PROGRESS = {
            schemaVersion = 2,
            runId = runId,
            scenarioId = "second.background-smoke",
            attempts = 4,
            lastInputAtMonotonicMs = 120000
        }
    end)

    environment.RunNextTimer()

    assert(
        #environment.InputKeys == 1 and environment.InputKeys[1] == "F13",
        "Relaunched startup bridge reused a monotonic timestamp from the previous process"
    )
    local progress = environment.SavedValue("startup-bridge.json")
    assert(progress ~= nil and progress.attempts == 5, "Relaunched bridge lost its attempt count")
    assert(progress.lastInputAtMonotonicMs == nil, "Relaunched bridge persisted monotonic state")
end

do
    local environment = createEnvironment("run-one-based-noesis")
    local startedGame = 0
    local mainMenu = visualWithContext(dataContext("gui::DCMainMenu", {
        StartGameCommand = commandProperty(function()
            startedGame = startedGame + 1
        end)
    }))
    environment.SetStateWidget(oneBasedNestedVisual(oneBasedNestedVisual(mainMenu)))

    environment.RunNextTimer()

    assert(startedGame == 1, "Startup bridge did not traverse nested one-based Noesis children")
    assert(#environment.InputKeys == 0, "Startup bridge used F13 after finding the nested main menu")
end

do
    local environment = createEnvironment("run-wire-epoch-clamp", function(selectedArm, selectedCommand)
        selectedArm.createdAtEpochMs = 2500
        selectedArm.expiresAtEpochMs = 302500
        selectedArm.timeoutMs = 300000
        selectedCommand.createdAtEpochMs = 2500
        selectedCommand.expiresAtEpochMs = 302500
        selectedCommand.timeoutMs = 300000
    end)
    local observation = environment.SavedValue("mod-load.json")
    assert(observation ~= nil, "Startup bridge did not write its clamped mod observation")
    assert(
        observation.observedAtEpochMs == 2500,
        "ClockEpoch resolution produced a wire timestamp before the arm window"
    )
end

do
    local environment = createEnvironment("run-long-startup-movie", function(selectedArm, selectedCommand)
        selectedArm.expiresAtEpochMs = 301000
        selectedArm.timeoutMs = 300000
        selectedCommand.expiresAtEpochMs = 301000
        selectedCommand.timeoutMs = 300000
    end)
    environment.SetStateStates(movieStateTree())

    local expectedAttempts = 0
    for elapsedMilliseconds = 0, 110000, 1500 do
        expectedAttempts = expectedAttempts + 1
        environment.SetEpochMilliseconds(2000 + elapsedMilliseconds)
        environment.RunNextTimer()
    end

    assert(expectedAttempts > 5, "Synthetic startup movie did not exceed the old input cap")
    assert(
        #environment.InputEvents == expectedAttempts
            and environment.InputEvents[expectedAttempts].EventId == 180
            and environment.InputEvents[expectedAttempts].DeviceId == 0,
        "Startup bridge stopped retrying semantic SkipVideo during a 110 second Movie"
    )
    assert(
        #environment.RawInputEvents == expectedAttempts * 2
            and environment.RawInputEvents[expectedAttempts * 2 - 1].Input.InputId == "escape"
            and environment.RawInputEvents[expectedAttempts * 2 - 1].Value.State == "Pressed"
            and environment.RawInputEvents[expectedAttempts * 2].Value.State == "Released",
        "Startup bridge stopped retrying raw Escape during a 110 second Movie"
    )
    assert(#environment.InputKeys == 0, "Startup bridge injected F13 during Movie")
    assert(environment.SavedValue("startup-error.json") == nil, "A 110 second Movie failed before its local deadline")

    environment.SetReady()
    environment.SetEpochMilliseconds(114000)
    environment.RunNextTimer()
    assert(environment.TimerCount() == 0, "Startup bridge kept polling after Core Client became ready")
    assert(#environment.InputEvents == expectedAttempts, "Startup bridge injected SkipVideo after Core Client became ready")
    assert(#environment.RawInputEvents == expectedAttempts * 2, "Startup bridge injected raw Escape after Core Client became ready")
end

do
    local environment = createEnvironment("run-startup-movie-timeout", function(selectedArm, selectedCommand)
        selectedArm.expiresAtEpochMs = 301000
        selectedArm.timeoutMs = 300000
        selectedCommand.expiresAtEpochMs = 301000
        selectedCommand.timeoutMs = 300000
    end)
    environment.SetStateStates(movieStateTree())
    environment.SetEpochMilliseconds(2000)
    environment.RunNextTimer()
    environment.SetEpochMilliseconds(182000)
    environment.RunNextTimer()

    local result = environment.SavedValue("startup-error.json")
    assert(result ~= nil and result.status == "error", "Startup Movie beyond 180 seconds did not write an error")
    assert(result.schemaVersion == 2, "Startup Movie timeout wrote the wrong schema version")
    assert(result.error.code == "movie-skip-timeout", "Startup Movie timeout used the wrong error code")
    assert(result.startedAtEpochMs == 2000, "Startup Movie timeout wrote the wrong start timestamp")
    assert(result.completedAtEpochMs == 182000, "Startup Movie timeout wrote the wrong completion timestamp")
    assert(
        result.startedAtEpochMs >= 1000 and result.completedAtEpochMs <= 301000,
        "Startup Movie timeout timestamps escaped the armed run"
    )
    assert(environment.TimerCount() == 0, "Startup bridge kept polling after Movie timeout")
    assert(#environment.InputKeys == 0, "Startup bridge injected F13 during timed-out Movie")
end

do
    local environment = createEnvironment("run-startup-error-write-retry", function(selectedArm, selectedCommand)
        selectedArm.expiresAtEpochMs = 301000
        selectedArm.timeoutMs = 300000
        selectedArm.testStartupErrorSaveFailures = 1
        selectedCommand.expiresAtEpochMs = 301000
        selectedCommand.timeoutMs = 300000
    end)
    environment.SetStateStates(movieStateTree())
    environment.SetEpochMilliseconds(2000)
    environment.RunNextTimer()
    environment.SetEpochMilliseconds(182000)
    environment.RunNextTimer()

    assert(
        environment.SavedValue("startup-error.json") == nil,
        "Failed first startup error write was reported as persisted"
    )
    assert(environment.TimerCount() == 1, "Startup error writer did not schedule one retry")
    environment.RunNextTimer()

    local result = environment.SavedValue("startup-error.json")
    assert(result ~= nil and result.status == "error", "Startup error retry did not persist the artifact")
    assert(result.error.code == "movie-skip-timeout", "Startup error retry changed the error")
    assert(environment.TimerCount() == 0, "Startup bridge kept polling after its error was persisted")
end

do
    local environment = createEnvironment("run-startup-movie-deadline", function(selectedArm, selectedCommand)
        selectedArm.expiresAtEpochMs = 10000
        selectedArm.timeoutMs = 9000
        selectedCommand.expiresAtEpochMs = 10000
        selectedCommand.timeoutMs = 9000
    end)
    environment.SetStateStates(movieStateTree())
    for current = 2000, 8000, 2000 do
        environment.SetEpochMilliseconds(current)
        environment.RunNextTimer()
    end
    local attemptsBeforeDeadline = #environment.InputEvents
    environment.SetEpochMilliseconds(10000)
    environment.RunNextTimer()

    assert(attemptsBeforeDeadline > 0, "Startup Movie did not inject input before the command deadline")
    assert(#environment.InputEvents == attemptsBeforeDeadline, "Startup bridge injected SkipVideo at the command deadline")
    assert(#environment.RawInputEvents == attemptsBeforeDeadline * 2, "Startup bridge injected raw Escape at the command deadline")
    assert(environment.TimerCount() == 0, "Startup bridge kept polling after the command deadline")
    assert(environment.SavedValue("startup-error.json") == nil, "Command deadline was misreported as a local Movie timeout")
end

do
    local environment = createEnvironment("run-runtime-observer", function(selectedArm, selectedCommand)
        selectedArm.mode = "runtime"
        selectedArm.savePolicy = "never"
        selectedArm.scenarioId = "second.generic-runtime"
        selectedArm.saveId = RUNTIME_SAVE_ID
        selectedArm.creationPlan = nil
        selectedCommand.mode = selectedArm.mode
        selectedCommand.savePolicy = selectedArm.savePolicy
        selectedCommand.scenarioId = selectedArm.scenarioId
        selectedCommand.saveId = selectedArm.saveId
        selectedCommand.creationPlan = nil
    end)
    assert(environment.Bridge.Armed == true, "The allowlisted runtime save did not arm the startup observer")
    assert(environment.Switches.SkipSplashScreen == false, "The runtime observer changed the splash setting")
    assert(environment.Switches.CanAutoSave == false, "The runtime observer did not suppress engine autosaves")
    assert(environment.TimerCount() == 1, "The runtime observer did not schedule one mod-load replay")
    assert(#environment.InputKeys == 0, "The runtime observer injected input")
    local observation = environment.SavedValue("mod-load.json")
    assert(observation ~= nil, "The runtime observer did not report the loaded modules")
    assert(observation.runId == "run-runtime-observer", "The mod observation used the wrong run")
    assert(observation.scenarioId == "second.generic-runtime", "The mod observation used the wrong scenario")
    assert(observation.status == "observed", "The mod observation used the wrong status")
    assert(observation.observedAtEpochMs == 2000, "The mod observation used the wrong timestamp")
    assert(#observation.loadOrder == 5, "The mod observation did not preserve the full load order")
    assert(observation.loadOrder[2] == RULES_UUID, "The mod observation changed the rules dependency's position")
    assert(observation.loadOrder[3] == INTRO_SKIP_UUID, "The mod observation changed the intro skip mod's position")
    assert(observation.loadOrder[4] == HARNESS_UUID, "The mod observation changed the harness mod's position")
    assert(observation.loadOrder[5] == EXAMPLE_MOD_UUID, "The mod observation changed the example mod's position")

    environment.SetModLoadOrder({
        "28ac9ce2-2aba-8cda-b3b5-6e922f71b6b8",
        RULES_UUID,
        HARNESS_UUID
    })
    environment.RunNextTimer()
    local replayed = environment.SavedValue("mod-load.json")
    assert(#replayed.loadOrder == 3, "Runtime observer did not replay the settled load order")
    assert(environment.TimerCount() == 1, "Runtime mod-load replay did not continue inside its window")
end

do
    local environment = createEnvironment("run-disallowed-creation-never", function(selectedArm, selectedCommand)
        selectedArm.savePolicy = "never"
        selectedCommand.savePolicy = "never"
    end)
    assert(environment.Bridge.Armed == false, "Character creation accepted a never save policy")
    assert(environment.Switches.CanAutoSave == true, "Invalid creation arm changed autosave state")
    assert(environment.TimerCount() == 0, "Invalid creation arm scheduled automation")
end

do
    local environment = createEnvironment("run-creation-discard", function(selectedArm, selectedCommand)
        selectedArm.savePolicy = "discard-campaign"
        selectedCommand.savePolicy = "discard-campaign"
    end)
    assert(environment.Bridge.Armed == true, "A discard-campaign creation did not arm the startup bridge")
    assert(environment.Switches.CanAutoSave == false, "A discard-campaign creation left engine autosave enabled")
end

do
    local environment = createEnvironment("run-runtime-discard", function(selectedArm, selectedCommand)
        selectedArm.mode = "runtime"
        selectedArm.savePolicy = "discard-campaign"
        selectedArm.scenarioId = "second.generic-runtime"
        selectedArm.saveId = RUNTIME_SAVE_ID
        selectedArm.creationPlan = nil
        selectedCommand.mode = selectedArm.mode
        selectedCommand.savePolicy = selectedArm.savePolicy
        selectedCommand.scenarioId = selectedArm.scenarioId
        selectedCommand.saveId = selectedArm.saveId
        selectedCommand.creationPlan = nil
    end)
    assert(environment.Bridge.Armed == false, "A runtime fixture accepted the discard-campaign policy")
    assert(environment.Switches.CanAutoSave == true, "An invalid runtime arm changed autosave state")
end

do
    local environment = createEnvironment("run-disallowed", function(selectedArm, selectedCommand)
        selectedArm.mode = "runtime"
        selectedArm.savePolicy = "never"
        selectedArm.scenarioId = "second.generic-runtime"
        selectedArm.saveId = "../escape"
        selectedArm.creationPlan = nil
        selectedCommand.mode = selectedArm.mode
        selectedCommand.savePolicy = selectedArm.savePolicy
        selectedCommand.scenarioId = selectedArm.scenarioId
        selectedCommand.saveId = selectedArm.saveId
        selectedCommand.creationPlan = nil
    end)
    assert(environment.Bridge.Armed == false, "A disallowed save armed the startup bridge")
    assert(environment.Switches.SkipSplashScreen == false, "A disallowed save changed global switches")
    assert(environment.TimerCount() == 0, "A disallowed save scheduled input")
end

do
    local environment = createEnvironment("run-runtime-plan", function(selectedArm, selectedCommand)
        selectedArm.mode = "runtime"
        selectedArm.savePolicy = "never"
        selectedArm.scenarioId = "core.runtime-smoke"
        selectedArm.saveId = RUNTIME_SAVE_ID
        selectedCommand.mode = selectedArm.mode
        selectedCommand.savePolicy = selectedArm.savePolicy
        selectedCommand.scenarioId = selectedArm.scenarioId
        selectedCommand.saveId = selectedArm.saveId
    end)
    assert(environment.Bridge.Armed == false, "Runtime arm accepted creationPlan")
    assert(environment.TimerCount() == 0, "Runtime arm with creationPlan scheduled input")
end

do
    local environment = createEnvironment("run-path-like-save", function(selectedArm, selectedCommand)
        selectedArm.mode = "runtime"
        selectedArm.savePolicy = "never"
        selectedArm.scenarioId = "core.runtime-smoke"
        selectedArm.saveId = "Story/escape__AutoSave_0"
        selectedArm.creationPlan = nil
        selectedCommand.mode = selectedArm.mode
        selectedCommand.savePolicy = selectedArm.savePolicy
        selectedCommand.scenarioId = selectedArm.scenarioId
        selectedCommand.saveId = selectedArm.saveId
        selectedCommand.creationPlan = nil
    end)
    assert(environment.Bridge.Armed == false, "A path-like save armed the startup bridge")
    assert(environment.TimerCount() == 0, "A path-like save scheduled input")
end

do
    local environment = createEnvironment("run-sentinel-runtime-save", function(selectedArm, selectedCommand)
        selectedArm.mode = "runtime"
        selectedArm.savePolicy = "never"
        selectedArm.scenarioId = "core.runtime-smoke"
        selectedArm.saveId = "__new_campaign__"
        selectedArm.creationPlan = nil
        selectedCommand.mode = selectedArm.mode
        selectedCommand.savePolicy = selectedArm.savePolicy
        selectedCommand.scenarioId = selectedArm.scenarioId
        selectedCommand.saveId = selectedArm.saveId
        selectedCommand.creationPlan = nil
    end)
    assert(environment.Bridge.Armed == false, "The new-campaign sentinel as a runtime save armed the startup bridge")
    assert(environment.TimerCount() == 0, "The new-campaign sentinel as a runtime save scheduled input")
end

do
    local environment = createEnvironment("run-missing-plan", function(selectedArm, selectedCommand)
        selectedArm.creationPlan = nil
        selectedCommand.creationPlan = nil
    end)
    assert(environment.Bridge.Armed == false, "Character creation arm without creationPlan armed the bridge")
    assert(environment.TimerCount() == 0, "Character creation arm without creationPlan scheduled input")
end

do
    local environment = createEnvironment("run-plan-mismatch", function(_, selectedCommand)
        selectedCommand.creationPlan.backgroundUuid = "00000000-0000-0000-0000-000000000003"
    end)
    assert(environment.Bridge.Armed == false, "Mismatched creationPlan armed the bridge")
    assert(environment.TimerCount() == 0, "Mismatched creationPlan scheduled input")
end

do
    local environment = createEnvironment("run-plan-extra-field", function(selectedArm)
        selectedArm.creationPlan.unexpected = true
    end)
    assert(environment.Bridge.Armed == false, "Extra creationPlan field armed the bridge")
    assert(environment.TimerCount() == 0, "Extra creationPlan field scheduled input")
end

do
    local environment = createEnvironment("run-expired", function(selectedArm, selectedCommand)
        selectedArm.expiresAtEpochMs = 2000
        selectedArm.timeoutMs = 1000
        selectedCommand.expiresAtEpochMs = 2000
        selectedCommand.timeoutMs = 1000
    end)
    assert(environment.Bridge.Armed == false, "An expired command armed the startup bridge")
    assert(environment.TimerCount() == 0, "An expired command scheduled input")
end

local ELF = "ce4b7923-bcdd-495c-b2e5-3810bf6dd9b5"
local WOOD_ELF = "5a076d0b-9b01-4edd-bafe-1d4469eacfdd"
for _, outcome in ipairs({ "match", "race-only", "invalid-race", "missing-race", "invalid-subrace", "mismatch-race", "mismatch-subrace" }) do
    local environment = createEnvironment("run-species-" .. outcome, function(selectedArm, selectedCommand)
        selectedArm.creationPlan.raceUuid, selectedArm.creationPlan.subRaceUuid = ELF, WOOD_ELF
        selectedCommand.creationPlan.raceUuid, selectedCommand.creationPlan.subRaceUuid = ELF, WOOD_ELF
        if outcome == "race-only" then
            selectedArm.creationPlan.subRaceUuid, selectedCommand.creationPlan.subRaceUuid = nil, nil
        elseif outcome == "invalid-race" then selectedArm.creationPlan.raceUuid = "Elf"
        elseif outcome == "missing-race" then selectedArm.creationPlan.raceUuid = nil
        elseif outcome == "invalid-subrace" then selectedArm.creationPlan.subRaceUuid = "Wood Elf"
        elseif outcome == "mismatch-race" then selectedCommand.creationPlan.raceUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        elseif outcome == "mismatch-subrace" then selectedCommand.creationPlan.subRaceUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" end
    end)
    assert(environment.Bridge.Armed == (outcome == "match" or outcome == "race-only"),
        "Startup bridge must validate and bind the complete species plan: " .. outcome)
end
local PASSIVE = "HarnessExample_RaceChoice_Wisdom"
for _, outcome in ipairs({ "match", "max-length", "mismatch", "case-mismatch", "missing-arm", "missing-command", "orphan" }) do
    local environment = createEnvironment("run-race-passive-" .. outcome, function(selectedArm, selectedCommand)
        for _, value in ipairs({ selectedArm, selectedCommand }) do
            value.creationPlan.raceUuid, value.creationPlan.racePassiveId = ELF, PASSIVE
        end
        if outcome == "max-length" then
            selectedArm.creationPlan.racePassiveId, selectedCommand.creationPlan.racePassiveId = string.rep("A", 150), string.rep("A", 150)
        elseif outcome == "mismatch" then selectedCommand.creationPlan.racePassiveId = "HarnessExample_Other"
        elseif outcome == "case-mismatch" then selectedCommand.creationPlan.racePassiveId = PASSIVE:lower()
        elseif outcome == "missing-arm" then selectedArm.creationPlan.racePassiveId = nil
        elseif outcome == "missing-command" then selectedCommand.creationPlan.racePassiveId = nil
        elseif outcome == "orphan" then selectedArm.creationPlan.raceUuid, selectedCommand.creationPlan.raceUuid = nil, nil end
    end)
    assert(environment.Bridge.Armed == (outcome == "match" or outcome == "max-length"), "Race passive plan was not bound exactly: " .. outcome)
end
for index, value in ipairs({ "", "_Passive", "1Passive", "Passive-name", "Passive name", "Passive\n", "é", string.rep("A", 151), 123, {} }) do
    local environment = createEnvironment("run-invalid-race-passive-" .. index, function(selectedArm, selectedCommand)
        for _, candidate in ipairs({ selectedArm, selectedCommand }) do
            candidate.creationPlan.raceUuid, candidate.creationPlan.racePassiveId = ELF, value
        end
    end)
    assert(not environment.Bridge.Armed and environment.TimerCount() == 0, "Invalid race passive armed input: " .. index)
end
print("BG3 builtin startup bridge runtime tests passed")

for _, outcome in ipairs({ "match", "mismatch", "missing", "invalid" }) do
    local environment = createEnvironment("run-parent-class-" .. outcome, function(arm, command)
        arm.creationPlan.classUuid = "a865965f-501b-46e9-9eaa-7748e8c04d09"
        command.creationPlan.classUuid = arm.creationPlan.classUuid
        if outcome == "mismatch" then command.creationPlan.classUuid = "c4598bdb-fc07-40dd-a62c-90cc138bd76f"
        elseif outcome == "missing" then command.creationPlan.classUuid = nil
        elseif outcome == "invalid" then arm.creationPlan.classUuid = "Wizard" end
    end)
    assert(environment.Bridge.Armed == (outcome == "match"), "Startup bridge parent class: " .. outcome)
end
print("Startup bridge parent class: 4 assertions passed")
