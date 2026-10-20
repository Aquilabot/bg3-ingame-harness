local SCENARIO_ID = "example.runtime-smoke"
local NULL_UUID = "00000000-0000-0000-0000-000000000000"

local function isPartyMember(character)
    return Osi.IsPartyMember(character, 0) == 1
end

local function runScenario(context)
    local host = Osi.GetHostCharacter()
    if host == nil or host == "" or host == NULL_UUID then
        context:Error(
            "fixture-host-missing",
            "The runtime fixture does not expose a host character"
        )
        return
    end

    local entity = Ext.Entity.Get(host)
    local partyMember = isPartyMember(host)
    context:Assert(
        "host-entity",
        entity ~= nil,
        "The runtime fixture host resolves to a loaded entity",
        "loaded entity",
        entity == nil and "missing" or "loaded entity"
    )
    context:Assert(
        "host-party-member",
        partyMember,
        "The runtime fixture host belongs to the active party",
        host,
        partyMember and host or "not present"
    )
    context:Finish()
end

Mods.BG3InGameHarness.TestHarness.RegisterScenario({
    Id = SCENARIO_ID,
    Mode = "runtime",
    SavePolicy = "never",
    Run = runScenario
})
