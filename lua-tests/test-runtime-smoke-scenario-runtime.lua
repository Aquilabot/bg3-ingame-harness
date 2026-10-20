local SCENARIO_PATH = "examples/runtime-smoke/mod/Mods/HarnessExample_cd639062-7736-457d-aa6a-c364979b8921/ScriptExtender/Lua/Server/RuntimeSmoke.lua"
local HOST = "11111111-2222-3333-4444-555555555555"
local HOST_ROW = "Elves_Female_High_Player_" .. HOST

local scenarioDefinition = nil
local hostCharacter = HOST
local hostEntity = {
    Uuid = {
        EntityUuid = HOST
    }
}
local partyRows = { { HOST_ROW } }
local partyMemberResult = 1
local partyMemberQueries = {}

Mods = {
    BG3InGameHarness = {
        TestHarness = {
            RegisterScenario = function(definition)
                scenarioDefinition = definition
            end
        }
    }
}

Ext = {
    Entity = {
        Get = function(character)
            if character == HOST then
                return hostEntity
            end
            return nil
        end
    }
}

Osi = {
    DB_PartyMembers = {
        Get = function()
            return partyRows
        end
    },
    GetHostCharacter = function()
        return hostCharacter
    end,
    IsPartyMember = function(character, includeNotControllable)
        table.insert(partyMemberQueries, {
            Character = character,
            IncludeNotControllable = includeNotControllable
        })
        return partyMemberResult
    end
}

local loaded, loadError = loadfile(SCENARIO_PATH)
assert(loaded ~= nil, loadError)
loaded()

assert(type(scenarioDefinition) == "table", "Runtime smoke scenario was not registered")
assert(scenarioDefinition.Id == "example.runtime-smoke", "Runtime smoke registered the wrong id")
assert(scenarioDefinition.Mode == "runtime", "Runtime smoke registered the wrong mode")
assert(scenarioDefinition.SavePolicy == "never", "Runtime smoke registered an unsafe save policy")
assert(type(scenarioDefinition.Run) == "function", "Runtime smoke did not register a Run callback")

local function runScenario()
    local assertions = {}
    local finished = false
    local scenarioError = nil
    local context = {}

    function context:Assert(id, passed, message, expected, actual)
        table.insert(assertions, {
            Id = id,
            Passed = passed,
            Message = message,
            Expected = expected,
            Actual = actual
        })
    end

    function context:Finish()
        finished = true
    end

    function context:Error(code, message)
        scenarioError = {
            Code = code,
            Message = message
        }
    end

    scenarioDefinition.Run(context)
    return assertions, finished, scenarioError
end

local assertions, finished, scenarioError = runScenario()
assert(scenarioError == nil, "Happy path returned a scenario error")
assert(finished, "Happy path did not finish")
assert(#assertions == 2, "Happy path emitted the wrong assertion count")
assert(assertions[1].Id == "host-entity", "Host entity assertion is missing")
assert(assertions[1].Passed, "Host entity assertion failed")
assert(assertions[2].Id == "host-party-member", "Party membership assertion is missing")
assert(assertions[2].Passed, "Party membership assertion failed")
assert(#partyMemberQueries == 1, "Party membership query was not issued exactly once")
assert(partyMemberQueries[1].Character == HOST, "Party membership queried the wrong host")
assert(
    partyMemberQueries[1].IncludeNotControllable == 0,
    "Party membership included non-controllable characters"
)

partyMemberResult = 0
assertions, finished, scenarioError = runScenario()
assert(scenarioError == nil, "Party mismatch returned a scenario error")
assert(finished, "Party mismatch did not finish")
assert(#assertions == 2, "Party mismatch emitted the wrong assertion count")
assert(not assertions[2].Passed, "Party mismatch unexpectedly passed")
assert(assertions[2].Expected == HOST, "Party mismatch omitted the expected host")

hostCharacter = nil
assertions, finished, scenarioError = runScenario()
assert(not finished, "Missing host unexpectedly finished")
assert(#assertions == 0, "Missing host emitted assertions")
assert(scenarioError ~= nil, "Missing host did not return a scenario error")
assert(scenarioError.Code == "fixture-host-missing", "Missing host returned the wrong error code")

print("Runtime smoke scenario tests passed")
