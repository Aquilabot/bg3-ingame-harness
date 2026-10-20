local ROOT = "mod/Mods/BG3InGameHarness_41d551b8-e0c1-4c12-8a29-1be03b5f9054/ScriptExtender/Lua/"
local ACTOR = "11111111-2222-3333-4444-555555555555"
local timers, now, nextId, defers, checks, errors, passives, spells, adds
local rejectGrant = false

local function schedule(delay, callback)
    nextId = nextId + 1
    timers[nextId] = { At = now + delay, Callback = callback }
    return nextId
end

local function advance(to)
    while true do
        local id, selected
        for candidateId, timer in pairs(timers) do
            if timer.At <= to and (selected == nil or timer.At < selected.At
                or (timer.At == selected.At and candidateId < id)) then
                id, selected = candidateId, timer
            end
        end
        if selected == nil then break end
        timers[id] = nil
        now = selected.At
        selected.Callback()
    end
    now = to
end

Mods = { BG3InGameHarness = { EntityIdentity = dofile(ROOT .. "Server/EntityIdentity.lua") } }
Ext = { Timer = {
    WaitForRealtime = schedule,
    Cancel = function(id) timers[id] = nil end
} }
Osi = {
    Exists = function(actor) assert(actor == ACTOR); return 1 end,
    HasPassive = function(_, id) return passives[id] and 1 or 0 end,
    HasSpell = function(_, id) return spells[id] and 1 or 0 end,
    AddPassive = function(_, id)
        if rejectGrant then return end
        schedule(25, function() passives[id] = true end)
        schedule(150, function()
            if passives[id] and id == "GrantSpell" then spells.Inherited = true end
        end)
    end,
    RemovePassive = function(_, id)
        schedule(25, function()
            passives[id] = nil
            if id == "GrantSpell" then spells.Inherited = nil end
        end)
    end,
    AddSpell = function(_, id)
        table.insert(adds, id)
        schedule(50, function() spells[id] = true end)
    end,
    RemoveSpell = function(_, id) schedule(50, function() spells[id] = nil end) end
}
local RuntimeFixture = dofile(ROOT .. "Server/RuntimeFixture.lua")
local context = {
    Defer = function(_, callback) table.insert(defers, callback) end,
    DeferCheck = function(_, label, callback) table.insert(checks, { Label = label, Run = callback }) end,
    Error = function(_, code, message) table.insert(errors, { Code = code, Message = message }) end
}
local function reset()
    timers, now, nextId = {}, 0, 0
    defers, checks, errors, adds = {}, {}, {}, {}
    passives, spells = { Existing = true }, { ExistingSpell = true }
    rejectGrant = false
    return RuntimeFixture.Create(context)
end
local function close()
    for index = #defers, 1, -1 do defers[index]() end
end
local function isClean()
    for _, check in ipairs(checks) do
        if not check.Run() then return false end
    end
    return true
end

local fixture = reset()
local ready = 0
local evidence
fixture:PrepareActor(ACTOR, {
    Passives = { "Existing", "GrantSpell" },
    Spells = { "ExistingSpell", "Direct" },
    InheritedSpells = { GrantSpell = { "Inherited" } }
}, function(prepared) ready = ready + 1; evidence = prepared end)
assert(ready == 0, "Actor was reported ready before the engine published its requirements")
advance(100)
assert(ready == 0, "Passive presence incorrectly implied inherited spell readiness")
advance(300)
assert(ready == 1 and #errors == 0, "Deferred requirements never became ready")
assert(table.concat(adds, ",") == "Direct", "An inherited spell was also granted directly")
assert(evidence.ExistingPassives[1] == "Existing" and evidence.ExistingSpells[1] == "ExistingSpell")
close()
assert(not isClean(), "Cleanup passed before the engine removed granted features")
advance(500)
assert(isClean(), "Deferred removal did not settle")
assert(passives.Existing and spells.ExistingSpell, "Cleanup removed preexisting features")
assert(not passives.GrantSpell and not spells.Direct and not spells.Inherited)
assert(ready == 1, "Readiness callback repeated")

fixture = reset()
ready = 0
fixture:PrepareActor(ACTOR, { Passives = { "GrantSpell" }, InheritedSpells = { GrantSpell = { "Inherited" } } }, function()
    ready = ready + 1
end)
close()
advance(6000)
assert(ready == 0 and #errors == 0, "Closed fixture delivered a readiness callback or timeout")
assert(isClean() and not passives.GrantSpell and not spells.Inherited)

fixture = reset()
rejectGrant = true
fixture:PrepareActor(ACTOR, { Passives = { "Unavailable" } }, function()
    error("Missing passive was accepted")
end)
advance(6000)
assert(#errors == 1 and errors[1].Code == "fixture-readiness-timeout", "Missing requirements did not time out")
assert(errors[1].Message:find("Unavailable", 1, true), "Timeout omitted the missing requirement")
close()
advance(7000)
assert(isClean() and #errors == 1, "Timeout cleanup or cancellation failed")

fixture = reset()
passives.GrantSpell = true
schedule(150, function() spells.Inherited = true end)
fixture:PrepareActor(ACTOR, {
    Passives = { "GrantSpell", "Unrelated" },
    InheritedSpells = { GrantSpell = { "Inherited" } }
}, function() end)
advance(300)
close()
advance(500)
assert(isClean(), "Cleanup mistook a preexisting passive's delayed spell for an owned grant")
assert(passives.GrantSpell and spells.Inherited, "Cleanup removed a preexisting passive's spell")

-- The caller's actor-specific initialization check must precede both baseline reads and grants.
local originalHasPassive, originalAddPassive, originalAddSpell = Osi.HasPassive, Osi.AddPassive, Osi.AddSpell
local requirementReads, grantCalls, nativeReady
Osi.HasPassive = function(actor, id)
    requirementReads = requirementReads + 1
    return originalHasPassive(actor, id)
end
Osi.AddPassive = function(actor, id)
    grantCalls = grantCalls + 1
    assert(nativeReady, "Granted a passive before caller-observed initialization")
    return originalAddPassive(actor, id)
end
Osi.AddSpell = function(actor, id, ...)
    grantCalls = grantCalls + 1
    assert(nativeReady, "Granted a spell before caller-observed initialization")
    return originalAddSpell(actor, id, ...)
end
fixture = reset()
requirementReads, grantCalls, nativeReady, ready = 0, 0, false, 0
local initPolls = 0
fixture:PrepareActor(ACTOR, {
    Readiness = function() initPolls = initPolls + 1; return nativeReady end,
    Passives = { "GrantSpell", "Unrelated" }, Spells = { "Direct" },
    InheritedSpells = { GrantSpell = { "Inherited" } }
}, function(prepared) ready = ready + 1; evidence = prepared end)
advance(200)
assert(requirementReads == 0 and grantCalls == 0 and ready == 0, "Initialization wait inspected or changed requirements")
-- A native initialization grant must become part of the baseline, not an owned addition.
schedule(25, function() passives.GrantSpell = true; spells.Inherited = true; nativeReady = true end)
advance(600)
assert(ready == 1 and grantCalls == 2 and evidence.ExistingPassives[1] == "GrantSpell")
assert(evidence.AddedPassives[1] == "Unrelated")
local completedInitPolls = initPolls
advance(900)
assert(initPolls == completedInitPolls and ready == 1, "Initialization predicate repeated after preparation")
close()
advance(1200)
assert(passives.GrantSpell and spells.Inherited and not passives.Unrelated and not spells.Direct)
assert(isClean(), "Initialization changed cleanup ownership")

for _, mode in ipairs({ "timeout", "closed", "invalid-result", "exception" }) do
    fixture = reset()
    requirementReads, grantCalls, nativeReady, ready = 0, 0, false, 0
    fixture:PrepareActor(ACTOR, {
        Passives = { "NeverAdded" },
        Readiness = function()
            if mode == "invalid-result" then return 1 end
            if mode == "exception" then error("initialization unavailable") end
            return false
        end,
    }, function() ready = ready + 1 end)
    if mode == "closed" then close() end
    advance(6000)
    assert(requirementReads == 0 and grantCalls == 0 and ready == 0, mode)
    if mode == "closed" then
        assert(#errors == 0 and next(timers) == nil, "Closed initialization wait stayed active")
    else
        assert(#errors == 1 and errors[1].Message:find("initialization", 1, true))
        assert(errors[1].Code == (mode == "timeout" and "fixture-readiness-timeout" or "fixture-readiness-error"))
        close()
    end
    assert(next(timers) == nil and isClean(), "Initialization failure left work or cleanup debt")
end
fixture = reset()
requirementReads, grantCalls = 0, 0
assert(not pcall(function()
    fixture:PrepareActor(ACTOR, { Readiness = true, Passives = { "NeverAdded" } }, function() end)
end), "Non-callable initialization predicate was accepted")
assert(requirementReads == 0 and grantCalls == 0)
close()
Osi.HasPassive, Osi.AddPassive, Osi.AddSpell = originalHasPassive, originalAddPassive, originalAddSpell

local TARGET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
local caster = { SpellCastIsCasting = {}, SpellBook = {
    Spells = { { Id = { Prototype = "KnownSpell", OriginatorPrototype = "OriginalSpell", SourceType = "Passive" } } }
} }
local destination = {}
local castRequests, turnRequests = {}, {}
local roundCallback, unsubscribed
Ext.Entity = {
    Get = function(actor) if actor == ACTOR then return caster elseif actor == TARGET then return destination end end,
    OnCreateDeferred = function(name, callback)
        assert(name == "FTBPlayersTurnStartedEvent")
        roundCallback = callback
        return 91
    end,
    Unsubscribe = function(id) unsubscribed = id end
}
Ext.Types = { Serialize = function(value)
    local copy = {}; for key, item in pairs(value) do copy[key] = item end; return copy
end }
Ext.System = {
    ServerCastRequest = { NetworkStartRequests = castRequests },
    ServerFTBZone = { SetTurnActionsCompleted = turnRequests }
}
Ext.Stats = { Get = function() return { SpellType = "Target" } end }
Osi.IsInForceTurnBasedMode = function() return 1 end
fixture = reset()
fixture:CastSpell(ACTOR, "KnownSpell", TARGET)
advance(300)
assert(#castRequests == 0, "Fixture overlapped a spell still being cast")
caster.SpellCastIsCasting = nil
advance(400)
assert(#castRequests == 1 and castRequests[1].Caster == caster and castRequests[1].Targets[1].Target == destination)
assert(castRequests[1].Spell.OriginatorPrototype == "OriginalSpell" and castRequests[1].Spell.SourceType == "Passive", "Fixture lost the real spell identity")
assert(#castRequests[1].CastOptions == 1 and castRequests[1].CastOptions[1] == "FromClient", "Fixture disabled cast validation or costs")
fixture:EndForceTurnBasedTurn(ACTOR)
assert(#turnRequests == 1 and turnRequests[1].Entity == caster and turnRequests[1].ActionsCompleted)
local rounds = 0
fixture:OnForceTurnBasedRound(function() rounds = rounds + 1 end)
roundCallback()
assert(rounds == 1)
caster.SpellCastIsCasting = {}
fixture:CastSpell(ACTOR, "KnownSpell", TARGET)
close()
caster.SpellCastIsCasting = nil
advance(1000)
roundCallback()
assert(#castRequests == 1 and rounds == 1 and unsubscribed == 91, "Closed fixture delivered an action or retained a round callback")

fixture = reset()
fixture:CastSpell(ACTOR, "MissingSpell", TARGET)
assert(#castRequests == 1 and #errors == 1 and errors[1].Message:find("MissingSpell", 1, true))
Osi.IsInForceTurnBasedMode = function() return 0 end
assert(not pcall(function() fixture:EndForceTurnBasedTurn(ACTOR) end), "Fixture submitted an FTB action outside FTB")
close()

for _, kind in ipairs({ "Shout", "Projectile" }) do
    fixture = reset()
    Ext.Stats.Get = function() return { SpellType = kind } end
    fixture:CastSpell(ACTOR, "KnownSpell", ACTOR)
    assert(castRequests[#castRequests].Targets[1].TargetingType == kind,
        "Fixture must preserve the spell's targeting type")
    close()
end

-- Multi-target requests reuse the SpellBook identity and targeting type of
-- CastSpell and carry one native entry per distinct live target.
local SECOND, THIRD = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee"
local others = { [SECOND] = {}, [THIRD] = {} }
local alive, existing = {}, {}
Ext.Entity.Get = function(actor)
    if actor == ACTOR then return caster elseif actor == TARGET then return destination end
    return others[actor]
end
Osi.Exists = function(actor) return existing[actor] == false and 0 or 1 end
Osi.IsDead = function(actor) return alive[actor] == false and 1 or 0 end
Ext.Stats.Get = function() return { SpellType = "Target" } end
local multiCases = 0
local function multi(variant)
    multiCases = multiCases + 1
    fixture = reset()
    alive, existing = {}, {}
    caster.SpellCastIsCasting = nil
    local before = #castRequests
    local targets = { TARGET, SECOND, THIRD }
    local spell = "KnownSpell"
    if variant == "empty" then targets = {}
    elseif variant == "nine" then for index = 4, 9 do targets[index] = string.format("%08d-bbbb-cccc-dddd-eeeeeeeeeeee", index) end
    elseif variant == "duplicate" then targets[3] = TARGET
    elseif variant == "alias" then targets[3] = "Human_" .. TARGET:upper()
    elseif variant == "sparse" then targets = { [1] = TARGET, [3] = THIRD }
    elseif variant == "keyed" then targets.Other = SECOND
    elseif variant == "null" then targets[2] = "00000000-0000-0000-0000-000000000000"
    elseif variant == "invalid" then targets[2] = 42
    elseif variant == "not-list" then targets = TARGET
    elseif variant == "missing-spell" then spell = "MissingSpell"
    elseif variant == "zone" then Ext.Stats.Get = function() return { SpellType = "Zone" } end
    elseif variant == "gone" then others[SECOND] = nil
    elseif variant == "removed" then existing[THIRD] = false
    elseif variant == "dead" then alive[SECOND] = false
    elseif variant == "busy" then caster.SpellCastIsCasting = {}
    elseif variant == "closed" then caster.SpellCastIsCasting = {}
    end
    local called = pcall(fixture.CastSpellTargets, fixture, ACTOR, spell, targets)
    if variant == "busy" then
        advance(now + 300)
        assert(#castRequests == before, "Multi-target request overlapped a spell still being cast")
        caster.SpellCastIsCasting = nil
    elseif variant == "closed" then
        close(); caster.SpellCastIsCasting = nil
    end
    advance(now + 400)
    local added = #castRequests - before
    if variant == "pass" or variant == "busy" then
        assert(called and added == 1 and #errors == 0, "Multi-target request was not dispatched: " .. variant)
        local request = castRequests[#castRequests]
        assert(request.Caster == caster and #request.CastOptions == 1 and request.CastOptions[1] == "FromClient",
            "Multi-target request disabled validation or costs")
        assert(request.Spell.OriginatorPrototype == "OriginalSpell" and request.Spell.SourceType == "Passive",
            "Multi-target request lost the real spell identity")
        assert(#request.Targets == 3 and request.Targets[1].Target == destination
            and request.Targets[2].Target == others[SECOND] and request.Targets[3].Target == others[THIRD],
            "Multi-target request lost the target order")
        for _, entry in ipairs(request.Targets) do assert(entry.TargetingType == "Target") end
    elseif variant == "closed" then
        assert(called and added == 0 and #errors == 0, "Closed fixture dispatched a multi-target request")
    elseif variant == "missing-spell" or variant == "zone" or variant == "gone" or variant == "removed" or variant == "dead" then
        assert(called and added == 0 and #errors == 1 and errors[1].Code == "fixture-readiness-error",
            "Invalid dispatch-time multi-target request was not rejected: " .. variant)
    else
        assert(not called and added == 0 and #errors == 0, "Invalid multi-target list was accepted: " .. variant)
    end
    if variant ~= "closed" then close() end
    others[SECOND] = others[SECOND] or {}
    Ext.Stats.Get = function() return { SpellType = "Target" } end
end
for _, variant in ipairs({ "pass", "busy", "closed", "empty", "nine", "duplicate", "alias", "sparse", "keyed", "null", "invalid",
    "not-list", "missing-spell", "zone", "gone", "removed", "dead" }) do multi(variant) end
do
    local list = RuntimeFixture.BuildCastRequestTargets(caster, { destination, others[SECOND] }, { Prototype = "KnownSpell" }, "Target")
    local single = RuntimeFixture.BuildCastRequest(caster, destination, { Prototype = "KnownSpell" }, "Target")
    assert(#list.Targets == 2 and list.Targets[2].Target == others[SECOND] and list.Targets[2].TargetingType == "Target")
    assert(list.Caster == single.Caster and list.Spell.Prototype == single.Spell.Prototype
        and list.CastOptions[1] == single.CastOptions[1] and #list.CastOptions == #single.CastOptions)
    assert(#single.Targets == 1 and single.Targets[1].Target == destination, "Single request builder changed")
end
print("BG3 multi-target fixture: " .. multiCases .. " cases passed")
print("BG3 asynchronous runtime fixture tests passed")
