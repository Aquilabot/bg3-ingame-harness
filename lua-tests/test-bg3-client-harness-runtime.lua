local HARNESS_PATH = "mod/Mods/BG3InGameHarness_41d551b8-e0c1-4c12-8a29-1be03b5f9054/ScriptExtender/Lua/Client/TestHarness.lua"
local BOOTSTRAP_PATH = "mod/Mods/BG3InGameHarness_41d551b8-e0c1-4c12-8a29-1be03b5f9054/ScriptExtender/Lua/BootstrapClient.lua"
local ARM_PATH = "BG3InGameHarness/TestHarness/arm.json"

local function arm()
    return {
        schemaVersion = 2,
        runId = "run-client-startup",
        scenarioId = "core.runtime-smoke",
        mode = "runtime",
        savePolicy = "never",
        saveId = "safe-runtime-save_01",
        requiredAssertionIds = { "host-entity", "host-party-member" },
        createdAtEpochMs = 1000,
        expiresAtEpochMs = 10000,
        timeoutMs = 9000
    }
end

local function createEnvironment(contents, parsedValue, epochMilliseconds, switches, guardPresent)
    local globalSwitchCalls = 0
    if type(switches) == "table" and getmetatable(switches) == nil then
        switches.CanAutoSave = false
    end
    local guardPath = nil
    if parsedValue ~= nil then
        guardPath = "BG3InGameHarness/TestHarness/runs/"
            .. parsedValue.runId
            .. "/autosave-guard.json"
    end

    Ext = {
        IO = {
            LoadFile = function(filePath)
                if filePath == ARM_PATH then
                    return contents
                end
                if filePath == guardPath and guardPresent ~= false then
                    return "AUTOSAVE_GUARD"
                end
                return nil
            end
        },
        Json = {
            Parse = function(value)
                if value == "AUTOSAVE_GUARD" and parsedValue ~= nil then
                    return {
                        schemaVersion = 2,
                        runId = parsedValue.runId,
                        scenarioId = parsedValue.scenarioId,
                        status = "suppressed",
                        suppressedAtEpochMs = parsedValue.createdAtEpochMs
                    }
                end
                if value ~= contents or parsedValue == nil then
                    error("invalid JSON")
                end
                return parsedValue
            end
        },
        Timer = {
            ClockEpoch = function()
                return math.floor(epochMilliseconds / 1000)
            end
        },
        Utils = {
            GetGlobalSwitches = function()
                globalSwitchCalls = globalSwitchCalls + 1
                return switches
            end
        }
    }

    local Harness = dofile(HARNESS_PATH)
    return Harness, function()
        return globalSwitchCalls
    end
end

do
    local switches = { SkipSplashScreen = false }
    local Harness, globalSwitchCalls = createEnvironment("ARM", arm(), 2000, switches)

    assert(Harness.StartupBypassEnabled == true, "Valid arm did not enable the startup bypass")
    assert(switches.SkipSplashScreen == true, "Valid arm did not set SkipSplashScreen")
    assert(globalSwitchCalls() == 2, "Valid arm did not validate both autosave and splash switches")
end

do
    local switches = { SkipSplashScreen = false }
    local Harness, globalSwitchCalls = createEnvironment("ARM", arm(), 2000, switches, false)

    assert(Harness.StartupBypassEnabled == false, "Missing bridge guard enabled the startup bypass")
    assert(globalSwitchCalls() == 0, "Missing bridge guard accessed global switches")
end

do
    local switches = { SkipSplashScreen = false }
    local Harness, globalSwitchCalls = createEnvironment(nil, nil, 2000, switches)

    assert(Harness.StartupBypassEnabled == false, "Missing arm enabled the startup bypass")
    assert(switches.SkipSplashScreen == false, "Missing arm changed SkipSplashScreen")
    assert(globalSwitchCalls() == 0, "Missing arm accessed global switches")
end

do
    local switches = { SkipSplashScreen = false }
    local Harness, globalSwitchCalls = createEnvironment("INVALID", nil, 2000, switches)

    assert(Harness.StartupBypassEnabled == false, "Invalid JSON enabled the startup bypass")
    assert(switches.SkipSplashScreen == false, "Invalid JSON changed SkipSplashScreen")
    assert(globalSwitchCalls() == 0, "Invalid JSON accessed global switches")
end

do
    local switches = { SkipSplashScreen = false }
    local Harness, globalSwitchCalls = createEnvironment("ARM", arm(), 10000, switches)

    assert(Harness.StartupBypassEnabled == false, "Expired arm enabled the startup bypass")
    assert(switches.SkipSplashScreen == false, "Expired arm changed SkipSplashScreen")
    assert(globalSwitchCalls() == 0, "Expired arm accessed global switches")
end

do
    local invalidArm = arm()
    invalidArm.saveId = "../escape"
    local switches = { SkipSplashScreen = false }
    local Harness, globalSwitchCalls = createEnvironment("ARM", invalidArm, 2000, switches)

    assert(Harness.StartupBypassEnabled == false, "Disallowed save enabled the startup bypass")
    assert(switches.SkipSplashScreen == false, "Disallowed save changed SkipSplashScreen")
    assert(globalSwitchCalls() == 0, "Disallowed save accessed global switches")
end

do
    local invalidArm = arm()
    invalidArm.creationPlan = {
        kind = "background",
        backgroundUuid = "00000000-0000-0000-0000-000000000002",
        backgroundName = "Runtime must reject this",
        requiredTransitionModUuid = "00000000-0000-0000-0000-000000000003"
    }
    local switches = { SkipSplashScreen = false }
    local Harness, globalSwitchCalls = createEnvironment("ARM", invalidArm, 2000, switches)

    assert(Harness.StartupBypassEnabled == false, "Runtime arm accepted creationPlan")
    assert(switches.SkipSplashScreen == false, "Runtime arm with creationPlan changed SkipSplashScreen")
    assert(globalSwitchCalls() == 0, "Runtime arm with creationPlan accessed global switches")
end

do
    local invalidArm = arm()
    invalidArm.timeoutMs = invalidArm.timeoutMs - 1
    local switches = { SkipSplashScreen = false }
    local Harness, globalSwitchCalls = createEnvironment("ARM", invalidArm, 2000, switches)

    assert(Harness.StartupBypassEnabled == false, "Incoherent arm enabled the startup bypass")
    assert(switches.SkipSplashScreen == false, "Incoherent arm changed SkipSplashScreen")
    assert(globalSwitchCalls() == 0, "Incoherent arm accessed global switches")
end

do
    local Harness = createEnvironment("ARM", arm(), 2000, nil)
    assert(Harness.StartupBypassEnabled == false, "Missing global switches reported a startup bypass")
end

do
    Ext = {
        Json = {},
        Timer = {},
        Utils = {}
    }

    local loaded, Harness = pcall(dofile, HARNESS_PATH)
    assert(loaded, "Missing client APIs crashed the startup harness")
    assert(Harness.StartupBypassEnabled == false, "Missing client APIs enabled the startup bypass")
end

do
    local switches = setmetatable({}, {
        __index = function(_, key)
            if key == "SkipSplashScreen" then
                return false
            end
            return nil
        end,
        __newindex = function() end
    })
    local Harness = createEnvironment("ARM", arm(), 2000, switches)

    assert(Harness.StartupBypassEnabled == false, "Rejected switch write reported a startup bypass")
end

do
    local requiredPaths = {}
    local adapter = {}
    local label = {}
    local loadedHarness = { RuntimeUI = adapter }
    Mods = { BG3InGameHarness = {} }
    Ext = {
        Require = function(path)
            requiredPaths[#requiredPaths + 1] = path
            if path == "Client/TestHarness.lua" then return loadedHarness end
            if path == "HarnessTargetLabel.lua" then return label end
            error("Unexpected client bootstrap module: " .. tostring(path))
        end
    }

    dofile(BOOTSTRAP_PATH)
    assert(requiredPaths[1] == "Client/TestHarness.lua" and requiredPaths[2] == "HarnessTargetLabel.lua"
        and #requiredPaths == 2, "Client bootstrap loaded unexpected modules")
    assert(adapter.TargetLabel == label, "Client bootstrap did not share the target label with the runtime adapter")
    assert(Mods.BG3InGameHarness.ClientHarness == loadedHarness, "Client bootstrap did not expose the client harness")
end

do
    local currentArm = arm()
    currentArm.mode, currentArm.savePolicy, currentArm.saveId = "character-creation", "create-test-fixture", "__new_campaign__"
    currentArm.creationPlan = { kind = "background", backgroundUuid = "56c19b4a-f7b7-4aba-ba1f-0ade44a98560",
        backgroundName = "Example Background", requiredTransitionModUuid = "bdb30fae-00c7-4cdb-99d3-7c3e00b4380c" }
    local harness = createEnvironment("ARM", currentArm, 2000, {})
    local ui = harness.NewCampaignUI
    assert(type(ui) == "table" and ui.Read == harness.RuntimeUI.Read and ui.TypeName == harness.RuntimeUI.TypeName
        and ui.Widgets == harness.RuntimeUI.Widgets and ui.CancelInput == harness.RuntimeUI.CancelInput,
        "New-campaign UI must share the native readers of the runtime adapter")
    local native = { GetProperty = function(_, name)
        if name == "IsEnabled" then return false end
        if name == "CommandParameter" then return "native-parameter" end
        error("Unreadable native property")
    end }
    assert(ui.Read(native, "IsEnabled") == false and ui.Read(native, "CommandParameter") == "native-parameter"
        and ui.Read(native, "Missing") == nil, "Adapter lost false, a dependency property, or unavailable state")
    local load, parse = Ext.IO.LoadFile, Ext.Json.Parse
    local command, finalizing, guardMissing = {}, nil, false
    for key, value in pairs(currentArm) do command[key] = value end
    local progress = { schemaVersion = 2, runId = currentArm.runId, scenarioId = currentArm.scenarioId, phase = "campaign-starting" }
    Ext.IO.LoadFile = function(path)
        if path:match("/command%.json$") then return "COMMAND" end
        if path:match("/client%-progress%.json$") then return progress and "PROGRESS" end
        if path:match("/server%-finalizing%.json$") then return finalizing end
        if guardMissing and path:match("/autosave%-guard%.json$") then return nil end
        return load(path)
    end
    Ext.Json.Parse = function(value)
        if value == "COMMAND" then return command end
        if value == "PROGRESS" then return progress end
        return parse(value)
    end
    local FIXTURE, DISCARD, BOTH = { ["create-test-fixture"] = true }, { ["discard-campaign"] = true },
        { ["create-test-fixture"] = true, ["discard-campaign"] = true }
    local request = { runId = currentArm.runId, scenarioId = currentArm.scenarioId, deadlineEpochMs = 9000 }
    assert(ui.Authorize(request, FIXTURE) and ui.Authorize(request, BOTH), "Created campaign was not authorized")
    assert(not ui.Authorize(request, DISCARD), "A saving campaign acquired a discard-only operation")
    currentArm.savePolicy, command.savePolicy = "discard-campaign", "discard-campaign"
    assert(ui.Authorize(request, DISCARD) and not ui.Authorize(request, FIXTURE), "Discard policy was not respected")
    command.savePolicy = "create-test-fixture"
    assert(not ui.Authorize(request, BOTH), "Arm and command policies disagreed")
    currentArm.savePolicy = "create-test-fixture"
    assert(not harness.RuntimeUI.Authorize({ runId = currentArm.runId, scenarioId = currentArm.scenarioId, deadline = 9000 }),
        "Creation must not acquire runtime privileges")
    local savedUI, nativeRoot = Ext.UI, {}
    Ext.UI = nil
    assert(ui.Root() == nil, "A missing UI API produced a root")
    Ext.UI = { GetRoot = function() return nativeRoot end }
    assert(ui.Root() == nativeRoot, "The adapter lost the Noesis root")
    Ext.UI = { GetRoot = function() error("native root unreadable") end }
    assert(ui.Root() == nil, "An unreadable root escaped the adapter")
    Ext.UI = savedUI
    local events, definitions = {}, { { EventName = "SkipVideo", EventID = 11 }, { EventName = "UISkipDialog", EventID = 42 } }
    local inputManager = { InputDefinitions = definitions, DeviceEventInjects = events }
    Ext.Input = { GetInputManager = function() return inputManager end }
    assert(ui.InjectLogicalInput("UISkipDialog") == true and #events == 1 and events[1].EventId == 42
        and events[1].DeviceId == 0, "Logical input did not enqueue exactly one native event")
    assert(inputManager.InputInjects == nil, "Logical input must not inject raw keys")
    Ext.Input = nil
    assert(ui.InjectLogicalInput("UISkipDialog") == false, "Missing input APIs injected input")
    request.runId = "foreign"
    assert(not ui.Authorize(request, FIXTURE)); request.runId = currentArm.runId
    request.scenarioId = "foreign"
    assert(not ui.Authorize(request, FIXTURE)); request.scenarioId = currentArm.scenarioId
    for _, invalid in ipairs({ 2000, 11000, 9000.5, math.huge }) do
        request.deadlineEpochMs = invalid
        assert(not ui.Authorize(request, FIXTURE), "Invalid deadline authorized")
    end
    request.deadlineEpochMs = 9000
    command.expiresAtEpochMs, command.timeoutMs = 8000, 7000
    assert(not ui.Authorize(request, FIXTURE), "Operation outlived command")
    command.expiresAtEpochMs, command.timeoutMs = 10000, 9000
    progress.phase = "guardian"
    assert(not ui.Authorize(request, FIXTURE), "Creation still in progress authorized campaign UI")
    progress.phase = "campaign-starting"; progress.runId = "foreign"
    assert(not ui.Authorize(request, FIXTURE)); progress.runId = currentArm.runId
    progress.scenarioId = "foreign"
    assert(not ui.Authorize(request, FIXTURE)); progress.scenarioId = currentArm.scenarioId
    local savedProgress = progress; progress = nil
    assert(not ui.Authorize(request, FIXTURE), "Missing campaign evidence authorized UI"); progress = savedProgress
    guardMissing = true
    assert(not ui.Authorize(request, FIXTURE), "Missing autosave guard authorized UI"); guardMissing = false
    finalizing = "marker"
    assert(not ui.Authorize(request, FIXTURE), "Finalizing run authorized new UI work"); finalizing = nil
    assert(ui.Authorize(request, FIXTURE), "Restored state did not authorize again")
    currentArm.saveId, command.saveId = "harness-fixture__AutoSave_0", "harness-fixture__AutoSave_0"
    assert(not ui.Authorize(request, BOTH), "Loaded fixture authorized creation-only UI")
    currentArm.mode, command.mode = "runtime", "runtime"
    currentArm.savePolicy, command.savePolicy = "never", "never"
    currentArm.creationPlan, command.creationPlan = nil, nil
    assert(not ui.Authorize(request, BOTH), "Runtime fixture authorized new-campaign UI")
    Ext.IO.LoadFile, Ext.Json.Parse = load, parse
end

do
    local currentArm = arm()
    currentArm.saveId = "harness-fixture__AutoSave_0"
    local harness = createEnvironment("ARM", currentArm, 2000, {})
    local load, parse = Ext.IO.LoadFile, Ext.Json.Parse
    local command, finalizing = {}, nil
    for key, value in pairs(currentArm) do command[key] = value end
    Ext.IO.LoadFile = function(path)
        if path:match("/command%.json$") then return "COMMAND" end
        if path:match("/server%-finalizing%.json$") then return finalizing end
        return load(path)
    end
    Ext.Json.Parse = function(value) if value == "COMMAND" then return command end; return parse(value) end
    local request = { runId = currentArm.runId, scenarioId = currentArm.scenarioId, deadline = 9000 }
    assert(harness.RuntimeUI.Authorize(request), "Active fixture command did not authorize inspection")
    request.runId = "run-foreign"
    assert(not harness.RuntimeUI.Authorize(request), "Foreign run authorized")
    request.runId = currentArm.runId
    request.deadline = 2000
    assert(not harness.RuntimeUI.Authorize(request), "Expired step authorized")
    request.deadline = 11000
    assert(not harness.RuntimeUI.Authorize(request), "Step outlived arm")
    request.deadline = 9000
    command.expiresAtEpochMs = 8000; command.timeoutMs = 7000
    assert(not harness.RuntimeUI.Authorize(request), "Step outlived command")
    command.expiresAtEpochMs = 10000; command.timeoutMs = 9000
    finalizing = "incomplete marker"
    assert(not harness.RuntimeUI.Authorize(request), "Finalizing run authorized")
    finalizing = nil
    -- The client trusts the arm's save: the runner admits only an allowlisted, hash-verified fixture.
    command.saveId = "other-runtime-save_01"
    assert(not harness.RuntimeUI.Authorize(request), "A command for another save authorized")
    command.saveId = currentArm.saveId
    local queue = {}
    Ext.Input = { GetInputManager = function() return { InputInjects = queue } end }
    assert(harness.RuntimeUI.CancelInput())
    assert(#queue == 2 and queue[1].Input.InputId == "escape" and queue[2].Input.InputId == "escape"
        and queue[1].Value.State == "Pressed" and queue[2].Value.State == "Released"
        and queue[1].InjectRawInput and queue[2].InjectRawInput,
        "Native cancellation must enqueue both key edges in the owned BG3 client")
    Ext.Input.GetInputManager = function() return nil end
    assert(not harness.RuntimeUI.CancelInput() and #queue == 2, "Missing input manager must report failure")
end

for _, operation in ipairs({ "preview-target", "cast-target", "cast-selected-target", "inspect-target-validation" }) do
    local currentArm = arm()
    currentArm.saveId = "harness-fixture__AutoSave_0"
    local harness = createEnvironment("ARM", currentArm, 2000, {})
    local load, parse = Ext.IO.LoadFile, Ext.Json.Parse
    local command, finalizing, ack, pointer = {}, nil, nil, nil
    for key, value in pairs(currentArm) do command[key] = value end
    Ext.IO.LoadFile = function(path)
        if path:match("/command%.json$") then return "COMMAND" end
        if path:match("/server%-finalizing%.json$") then return finalizing end
        if path:match("/spell%-pointer%-ack%.json$") then return ack and "ACK" end
        if path:match("/spell%-pointer%.json$") then return pointer and "POINTER" end
        return load(path)
    end
    Ext.IO.SaveFile = function(_, encoded) return encoded == "POINTER" end
    Ext.Json.Stringify = function(document) pointer = document; return "POINTER" end
    Ext.Json.Parse = function(encoded)
        if encoded == "COMMAND" then return command end
        if encoded == "ACK" then return ack end
        if encoded == "POINTER" then return pointer end
        return parse(encoded)
    end
    Ext.IMGUI = { GetViewportSize = function() return { 2560, 1440 } end }
    local label = dofile("mod/Mods/BG3InGameHarness_41d551b8-e0c1-4c12-8a29-1be03b5f9054/ScriptExtender/Lua/HarnessTargetLabel.lua")
    harness.RuntimeUI.TargetLabel = label
    local request = { runId = currentArm.runId, scenarioId = currentArm.scenarioId, deadline = 9000,
        stepId = "target", sequence = 1, operation = operation,
        casterUuid = "00000000-0000-0000-0000-000000000001",
        targetUuid = "01234567-89ab-cdef-0123-456789abcdef", spellId = "Target_Example_Spell" }
    local castGuid = "00000000-0000-0000-0000-000000000002"
    local text = label.Describe(request.targetUuid).text
    local entries = { { uuid = request.targetUuid, name = text, nameVerified = true } }
    assert(not harness.RuntimeUI.ReportSpellPointer(request, "hover", castGuid, entries, "Foreign"))
    entries[1].nameVerified = false
    assert(not harness.RuntimeUI.ReportSpellPointer(request, "hover", castGuid, entries, text))
    entries[1].nameVerified = true
    for _, change in ipairs({ { operation = "click" }, { spellId = 42 }, { sequence = 0 }, { sequence = 1.5 },
        { sequence = true }, { casterUuid = request.targetUuid }, { casterUuid = "not-a-uuid" },
        { runId = "run-foreign" } }) do
        local invalid = {}; for key, value in pairs(request) do invalid[key] = value end
        for key, value in pairs(change) do invalid[key] = value end
        assert(not harness.RuntimeUI.ReportSpellPointer(invalid, "hover", castGuid, entries, text),
            "A malformed or foreign request emitted a pointer operation")
    end
    local hover = harness.RuntimeUI.ReportSpellPointer(request, "hover", castGuid, entries, text)
    assert(hover and hover.schemaVersion == 2 and hover.targetLabel == text and hover.viewport[1] == 2560)
    assert(harness.RuntimeUI.ReadSpellPointerAck(request, hover) == nil, "Missing ACK allowed movement")
    local function moved(document)
        local result = {}
        for _, key in ipairs({ "schemaVersion", "runId", "scenarioId", "stepId", "sequence", "operation", "casterUuid",
            "targetUuid", "spellId", "castGuid", "phase", "targetLabel", "expiresAtEpochMs" }) do result[key] = document[key] end
        result.status, result.observedAtEpochMs, result.cursor = "moved", 2345, { x = 1400, y = 800 }
        return result
    end
    ack = moved(hover)
    assert(harness.RuntimeUI.ReadSpellPointerAck(request, hover) == ack, "Valid millisecond ACK was rejected")
    for _, key in ipairs({ "schemaVersion", "runId", "scenarioId", "stepId", "sequence", "operation", "casterUuid",
        "targetUuid", "spellId", "castGuid", "phase", "targetLabel", "expiresAtEpochMs", "status" }) do
        ack = moved(hover); ack[key] = "wrong"
        assert(harness.RuntimeUI.ReadSpellPointerAck(request, hover) == nil, "Wrong ACK field accepted: " .. key)
    end
    for _, time in ipairs({ 1999, 3000, 6000, math.huge }) do
        ack = moved(hover); ack.observedAtEpochMs = time
        assert(harness.RuntimeUI.ReadSpellPointerAck(request, hover) == nil, "Invalid ACK timestamp accepted")
    end
    ack = moved(hover); ack.cursor.x = math.huge
    assert(harness.RuntimeUI.ReadSpellPointerAck(request, hover) == nil, "Invalid cursor accepted")
    ack = moved(hover)
    local leave = harness.RuntimeUI.ReportSpellPointer(request, "leave", castGuid, entries, text)
    assert(harness.RuntimeUI.ReadSpellPointerAck(request, leave) == nil, "Hover ACK acknowledged departure")
    assert(harness.RuntimeUI.ReadSpellPointerAck(request, hover) == nil, "Old pointer request was replayed")
    ack = moved(leave)
    assert(harness.RuntimeUI.ReadSpellPointerAck(request, leave) == ack)
    finalizing = "FINALIZING"
    assert(harness.RuntimeUI.ReadSpellPointerAck(request, leave) == nil, "Finalizing run accepted movement")
    finalizing = nil
    Ext.Timer.ClockEpoch = function() return 6 end
    assert(harness.RuntimeUI.ReadSpellPointerAck(request, leave) == nil, "Expired pointer accepted an earlier ACK")
end

print("BG3 client test harness runtime tests passed")
