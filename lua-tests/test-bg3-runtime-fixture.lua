local LUA_ROOT = "mod/Mods/BG3InGameHarness_41d551b8-e0c1-4c12-8a29-1be03b5f9054/ScriptExtender/Lua/"
local ACTOR = "11111111-2222-3333-4444-555555555555"
local TARGET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
local TEMPLATE = "12345678-1234-1234-1234-123456789abc"

local passives = {}
local spells = {}
local inheritedSpells = {}
local deferred = {}
local removedSpells = {}
local failAfterAdding = nil
local failRemoving = nil

Osi = {
    HasPassive = function(actor, passive)
        assert(actor == ACTOR)
        return passives[passive] and 1 or 0
    end,
    AddPassive = function(actor, passive)
        assert(actor == ACTOR)
        passives[passive] = true
        if passive == "GrantSpell" then
            inheritedSpells.Inherited = true
        end
        if passive == failAfterAdding then
            error("passive application failed after mutation")
        end
    end,
    RemovePassive = function(actor, passive)
        assert(actor == ACTOR)
        if passive == failRemoving then
            error("passive removal failed")
        end
        passives[passive] = nil
        if passive == "GrantSpell" then
            inheritedSpells.Inherited = nil
        end
    end,
    HasSpell = function(actor, spell)
        assert(actor == ACTOR)
        return (spells[spell] or inheritedSpells[spell]) and 1 or 0
    end,
    AddSpell = function(actor, spell, notification, containers)
        assert(actor == ACTOR and notification == 0 and containers == 0)
        spells[spell] = true
    end,
    RemoveSpell = function(actor, spell, containers)
        assert(actor == ACTOR and containers == 0)
        table.insert(removedSpells, spell)
        spells[spell] = nil
    end
}

local context = {
    DeferCheck = function() end,
    Error = function(_, code, message) error(code .. ": " .. message) end,
    Defer = function(_, callback)
        table.insert(deferred, callback)
    end
}

local function prepare(fixture, actor, requirements)
    local evidence
    fixture:PrepareActor(actor, requirements, function(value) evidence = value end)
    assert(evidence ~= nil, "Synchronous fake did not prepare immediately")
    return evidence
end

local function cleanup()
    assert(#deferred == 1, "A fixture must register exactly one cleanup callback")
    deferred[1]()
end

local function reset()
    passives = {}
    spells = {}
    inheritedSpells = {}
    deferred = {}
    removedSpells = {}
    failAfterAdding = nil
    failRemoving = nil
end

Mods = { BG3InGameHarness = {} }
Ext = {
    Require = function(modulePath)
        return dofile(LUA_ROOT .. modulePath)
    end,
    Events = { SessionLoaded = { Subscribe = function() end } },
    Utils = { Print = function() end }
}
dofile(LUA_ROOT .. "BootstrapServer.lua")
local RuntimeFixture = Mods.BG3InGameHarness.RuntimeFixture
-- Positional ground casts are limited to this mod's Target spells.
RuntimeFixture.GroundTargetSpellPattern = "^Target_Owned_"

reset()
passives.Existing = true
spells.ExistingSpell = true
local fixture = RuntimeFixture.Create(context)
local evidence = prepare(fixture, ACTOR, {
    Passives = { "Existing", "GrantSpell" },
    Spells = { "ExistingSpell", "Direct" },
    InheritedSpells = { GrantSpell = { "Inherited" } }
})
assert(Osi.HasPassive(ACTOR, "GrantSpell") == 1)
assert(Osi.HasSpell(ACTOR, "Inherited") == 1 and Osi.HasSpell(ACTOR, "Direct") == 1)
assert(table.concat(evidence.AddedPassives, ",") == "GrantSpell")
assert(table.concat(evidence.ExistingPassives, ",") == "Existing")
assert(table.concat(evidence.AddedSpells, ",") == "Direct")
assert(table.concat(evidence.ExistingSpells, ",") == "ExistingSpell")
cleanup()
assert(Osi.HasPassive(ACTOR, "Existing") == 1 and Osi.HasSpell(ACTOR, "ExistingSpell") == 1)
assert(Osi.HasPassive(ACTOR, "GrantSpell") == 0)
assert(Osi.HasSpell(ACTOR, "Inherited") == 0 and Osi.HasSpell(ACTOR, "Direct") == 0)
assert(table.concat(removedSpells, ",") == "Direct", "Cleanup removed a spell inherited from a passive")
cleanup()
assert(#removedSpells == 1, "Cleanup repeated a mutation")
assert(not pcall(function()
    prepare(fixture, ACTOR, { Passives = { "Late" } })
end), "Closed fixture accepted a new mutation")

reset()
fixture = RuntimeFixture.Create(context)
failAfterAdding = "Broken"
local prepared, prepareError = pcall(function()
    prepare(fixture, ACTOR, { Passives = { "First", "Broken" } })
end)
assert(not prepared and tostring(prepareError):find("failed after mutation", 1, true))
failRemoving = "Broken"
local cleaned, cleanupError = pcall(cleanup)
assert(not cleaned and tostring(cleanupError):find("Broken", 1, true))
assert(Osi.HasPassive(ACTOR, "First") == 0, "A failed rollback prevented remaining cleanup")
cleanup()
assert(not pcall(function()
    prepare(fixture, ACTOR, {})
end), "A failed cleanup reopened the fixture")

reset()
fixture = RuntimeFixture.Create(context)
local originalHasPassive = Osi.HasPassive
Osi.HasPassive = function() return nil end
assert(not pcall(function()
    prepare(fixture, ACTOR, { Passives = { "Unknown" } })
end), "An unavailable precondition query was accepted")
assert(passives.Unknown == nil, "Unknown preexisting state was modified")
Osi.HasPassive = originalHasPassive
cleanup()

reset()
local spawned = {}
local validPosition = true
local spawnCalls = 0
local returnedActor = TARGET
Osi.GetPosition = function(actor)
    assert(actor == ACTOR)
    return 10, 1, 20
end
Osi.FindValidPosition = function(x, y, z, radius, anchor, avoidDangerousSurfaces)
    assert(x == 13 and y == 1 and z == 20 and radius == 4)
    assert(anchor == ACTOR and avoidDangerousSurfaces == 1)
    if validPosition then
        return 12, 1, 20
    end
    return nil
end
Osi.CreateAt = function(template, x, y, z, temporary, playSpawn, finishEvent)
    assert(template == TEMPLATE and x == 12 and y == 1 and z == 20)
    assert(temporary == 1 and playSpawn == 0 and finishEvent == "")
    spawnCalls = spawnCalls + 1
    spawned[returnedActor] = true
    return returnedActor
end
Osi.RequestDeleteTemporary = function(actor)
    assert(actor == TARGET, "Cleanup attempted to delete the anchor")
    spawned[actor] = nil
end
fixture = RuntimeFixture.Create(context)
assert(not fixture:OwnsActor(ACTOR) and not fixture:OwnsActor(TARGET))
assert(fixture:SpawnNear(ACTOR, {
    Template = TEMPLATE, Offset = { 3, 0, 0 }, Radius = 4
}) == TARGET)
assert(fixture:OwnsActor(TARGET) and not fixture:OwnsActor(ACTOR))
assert(spawned[TARGET], "Spawn did not create a temporary actor")
cleanup()
assert(spawned[TARGET] == nil, "Cleanup did not request removal of its actor")
assert(not pcall(function()
    fixture:SpawnNear(ACTOR, { Template = TEMPLATE })
end), "Closed fixture accepted a spawn")

reset()
fixture = RuntimeFixture.Create(context)
validPosition = false
assert(not pcall(function()
    fixture:SpawnNear(ACTOR, { Template = TEMPLATE })
end), "An invalid position fell back to unchecked coordinates")
assert(spawnCalls == 1, "Invalid position still created an actor")
cleanup()

reset()
fixture = RuntimeFixture.Create(context)
validPosition = true
returnedActor = ACTOR
assert(not pcall(function()
    fixture:SpawnNear(ACTOR, { Template = TEMPLATE })
end), "Spawn accepted the existing anchor as a new actor")
cleanup()

local function searchSpawn(options, responses, onQuery, expired)
    reset()
    local queries, created, anchors, deadline = 0, 0, 0, 10000
    if expired then deadline = nil end
    context.GetDeadlineEpochMs = function() return deadline end
    Osi.GetPosition = function(actor)
        assert(actor == ACTOR); anchors = anchors + 1; return 10, 1, 20
    end
    Osi.FindValidPosition = function(x, y, z, radius, actor, avoid)
        queries = queries + 1
        assert(radius == 4 and actor == ACTOR and avoid == 1)
        if onQuery then onQuery(queries, function() deadline = nil end) end
        local value = responses[queries]
        if type(value) == "function" then return value() end
        if value == nil then return nil, nil, nil end
        return table.unpack(value, 1, 3)
    end
    Osi.CreateAt = function(template, x, y, z, temporary, playSpawn, finishEvent)
        assert(template == TEMPLATE and temporary == 1 and playSpawn == 0 and finishEvent == "")
        assert((x - 10)^2 + (z - 20)^2 >= 36^2, "Candidate violated separation before CreateAt")
        created = created + 1; return TARGET
    end
    local searchFixture = RuntimeFixture.Create(context)
    local ok, result = pcall(searchFixture.SpawnNear, searchFixture, ACTOR, options)
    cleanup()
    return ok, result, queries, created, anchors
end
local function searchOptions()
    return { Template = TEMPLATE, CandidateOffsets = { { 40, 0, 0 }, { 0, 0, 40 }, { -40, 0, 0 } },
        Radius = 4, MinHorizontalDistance = 36 }
end
do
    local ok, result, queries, created, anchors = searchSpawn(searchOptions(), { [2] = { 10, 1, 60 } })
    assert(ok and result == TARGET and queries == 2 and created == 1 and anchors == 1,
        "Candidate search did not use one anchor read and one creation after missing ground")
    ok, _, queries, created = searchSpawn(searchOptions(), { { 45, 1, 20 }, { 10, 1, 60 } })
    assert(ok and queries == 2 and created == 1, "Candidate search accepted a position below its minimum separation")
    ok, result, queries, created = searchSpawn(searchOptions(), {})
    assert(not ok and queries == 3 and created == 0 and tostring(result):find("3 candidates", 1, true),
        "Exhausted candidate search created an actor or lost its bounded diagnostic")
    local options = searchOptions()
    for i = 4, 8 do options.CandidateOffsets[i] = { 40, 0, 0 } end
    ok, _, queries, created = searchSpawn(options, {})
    assert(not ok and queries == 8 and created == 0, "Candidate search exceeded its eight-query budget")
    ok, _, queries, created, anchors = searchSpawn(searchOptions(), { { 50, 1, 20 } }, nil, true)
    assert(not ok and queries == 0 and created == 0 and anchors == 0, "Expired search read positions or created an actor")
end
for _, invalid in ipairs({ { 50 }, { 50, 1 }, { 0/0, 1, 20 }, { 50, "1", 20 }, { 50, 1, math.huge },
    function() error("native position query failed") end }) do
    local ok, _, queries, created = searchSpawn(searchOptions(), { invalid, { 10, 1, 60 } })
    assert(not ok and queries == 1 and created == 0, "Invalid query output was hidden by a later successful candidate")
end
for _, malformed in ipairs({ "empty", "sparse", "spaced", "nine", "mixed", "bad-last", "extra-coordinate", "minimum", "false-minimum", "overflow" }) do
    local options = searchOptions()
    if malformed == "empty" then options.CandidateOffsets = {}
    elseif malformed == "sparse" then options.CandidateOffsets[2] = nil
    elseif malformed == "spaced" then options.CandidateOffsets = { [1] = { 40, 0, 0 }, [3] = { 0, 0, 40 }, [5] = { -40, 0, 0 } }
    elseif malformed == "nine" then for i = 4, 9 do options.CandidateOffsets[i] = { 40, 0, 0 } end
    elseif malformed == "mixed" then options.Offset = { 40, 0, 0 }
    elseif malformed == "bad-last" then options.CandidateOffsets[3][3] = 0/0
    elseif malformed == "extra-coordinate" then options.CandidateOffsets[3].Other = 1
    elseif malformed == "minimum" then options.MinHorizontalDistance = -1
    elseif malformed == "false-minimum" then options.MinHorizontalDistance = false
    else options.MinHorizontalDistance = 1e308 end
    local ok, _, queries, created = searchSpawn(options, { { 50, 1, 20 } })
    assert(not ok and queries == 0 and created == 0, "Candidate validation was partial: " .. malformed)
end
for _, found in ipairs({ false, true }) do
    local ok, _, queries, created = searchSpawn(searchOptions(), found and { { 50, 1, 20 } } or {},
        function(_, expire) expire() end)
    assert(not ok and queries == 1 and created == 0, "Expired candidate search continued or created an actor")
end

reset()
local activeBoost = nil
local failBoost = false
Osi.AddBoosts = function(actor, boosts, source, owner)
    assert(actor == ACTOR and boosts == "RollBonus(Attack,100)")
    assert(source == "HARNESS_FIXTURE_TEST" and owner == ACTOR)
    activeBoost = { actor, boosts, source, owner }
    if failBoost then
        error("boost failed after mutation")
    end
end
Osi.RemoveBoosts = function(actor, boosts, onlyFirst, source, owner)
    assert(activeBoost ~= nil)
    assert(actor == activeBoost[1] and boosts == activeBoost[2])
    assert(onlyFirst == 0 and source == activeBoost[3] and owner == activeBoost[4])
    activeBoost = nil
end
fixture = RuntimeFixture.Create(context)
fixture:Boost(ACTOR, "RollBonus(Attack,100)", "HARNESS_FIXTURE_TEST", ACTOR)
assert(activeBoost ~= nil)
cleanup()
assert(activeBoost == nil, "Cleanup retained its boost")
assert(not pcall(function()
    fixture:Boost(ACTOR, "RollBonus(Attack,100)", "HARNESS_FIXTURE_TEST", ACTOR)
end), "Closed fixture accepted a boost")

reset()
fixture = RuntimeFixture.Create(context)
failBoost = true
assert(not pcall(function()
    fixture:Boost(ACTOR, "RollBonus(Attack,100)", "HARNESS_FIXTURE_TEST", ACTOR)
end))
cleanup()
assert(activeBoost == nil, "A partial boost failure leaked its mutation")

local positionalCases = 0
local function positional(variant)
    positionalCases = positionalCases + 1
    reset()
    local deadline, requests, sent = 10000, {}, false
    context.GetDeadlineEpochMs = function() return deadline end
    local id = { Prototype = "Zone_Test", OriginatorPrototype = "Zone_Test", SourceType = "Boost",
        Source = TARGET, ProgressionSource = TEMPLATE, SpellCastSource = ACTOR }
    local caster = { SpellBook = { Spells = { { Id = id } } } }
    local definition = { SpellType = "Zone", Shape = "Cone", Range = 4.5 }
    local point = { 14, 1, 20 }
    Ext.Entity = { Get = function(actor) assert(actor == ACTOR); return caster end }
    Ext.Types = { Serialize = function(value) local result = {}; for key, child in pairs(value) do result[key] = child end; return result end }
    Ext.Stats = { Get = function() if variant == "expired-read" then deadline = nil end; return definition end }
    Ext.System = { ServerCastRequest = { NetworkStartRequests = setmetatable({}, { __newindex = function()
        error("Positional cast must use the public native entry point")
    end }) } }
    Osi.UseSpellAtPosition = function(...) requests[#requests + 1] = { ... } end
    Osi.GetPosition = function() return 10, 1, 20 end
    if variant == "expired" then deadline = nil
    elseif variant == "busy" then caster.SpellCastIsCasting = {}
    elseif variant == "missing-book" then caster.SpellBook = nil
    elseif variant == "missing-spell" then caster.SpellBook.Spells = {}
    elseif variant == "ambiguous" then caster.SpellBook.Spells[2] = { Id = id }
    elseif variant == "partial-id" then id.Source = nil
    elseif variant == "other-type" then definition.SpellType = "Target"
    elseif variant == "other-shape" then definition.Shape = "Circle"
    elseif variant == "square" then definition.Shape = "Square"; definition.Base = 6
    elseif variant == "square-zero-base" then definition.Shape = "Square"; definition.Base = 0
    elseif variant == "square-missing-base" then definition.Shape = "Square"
    elseif variant == "zero-direction" then point = { 10, 4, 20 }
    elseif variant == "overflow-direction" then point = { 1e308, 1, 1e308 }
    elseif variant == "missing-coordinate" then point[2] = nil
    elseif variant == "extra-coordinate" then point[4] = 0
    elseif variant == "mixed-coordinate" then point.Other = 0
    elseif variant == "string-coordinate" then point[2] = "1"
    elseif variant == "nan-coordinate" then point[2] = 0/0
    elseif variant == "infinite-coordinate" then point[1] = math.huge
    elseif variant == "float-overflow" then point[2] = 1e100
    elseif variant == "vertical-range" then point[2] = 100
    elseif variant == "range-unreadable" then definition.Range = nil
    elseif variant == "origin-float-overflow" then Osi.GetPosition = function() return 10,1e100,20 end
    elseif variant == "origin-unreadable" then Osi.GetPosition = function() return 10,nil,20 end
    elseif variant == "origin-error" then Osi.GetPosition = function() error("origin read failed") end
    elseif variant == "spellbook-limit" then for index = 2, 513 do caster.SpellBook.Spells[index] = { Id = { Prototype = "Other" } } end
    end
    local current = RuntimeFixture.Create(context)
    if variant == "closed" then cleanup() end
    local ok = pcall(function() current:CastSpellAtPosition(ACTOR,"Zone_Test",point); sent = true end)
    if variant == "pass" or variant == "square" then
        assert(ok and sent and #requests == 1, "Positional request not dispatched synchronously")
        local request = requests[1]
        assert(#request == 6 and request[1] == ACTOR and request[2] == "Zone_Test" and request[6] == 1)
        assert(request[3] == 14 and request[4] == 1 and request[5] == 20)
        assert(id.Source == TARGET and id.ProgressionSource == TEMPLATE and id.SpellCastSource == ACTOR,
            "Grant inspection mutated the actual SpellId")
        point[1] = 999
        assert(request[3] == 14, "Public native invocation retained mutable coordinates")
    else assert(not ok and not sent and #requests == 0, "Unsafe positional request: " .. variant) end
    if variant ~= "closed" then cleanup() end
end
for _, variant in ipairs({ "pass", "expired", "expired-read", "busy", "missing-book", "missing-spell", "ambiguous", "partial-id",
    "other-type", "other-shape", "zero-direction", "overflow-direction", "missing-coordinate", "extra-coordinate", "mixed-coordinate",
    "string-coordinate", "nan-coordinate", "infinite-coordinate", "float-overflow", "vertical-range", "range-unreadable",
    "origin-float-overflow", "origin-unreadable", "origin-error", "spellbook-limit", "closed", "square", "square-zero-base", "square-missing-base" }) do
    positional(variant)
end
print("BG3 positional fixture: " .. positionalCases .. " cases passed")

-- Native Stats reads SpellProperties as groups of functors. PropertyContext is
-- a bitfield whose GROUND label indexes to a boolean in SE32.
local groundCases = 0
local function groundPosition(variant)
    groundCases = groundCases + 1
    reset()
    local deadline, requests = 10000, {}
    context.GetDeadlineEpochMs = function() return deadline end
    local spell = "Target_Owned_GroundFixture"
    if variant == "external-spell" then spell = "Target_ExternalGroundFixture" end
    local id = { Prototype = spell, OriginatorPrototype = spell, SourceType = "Boost",
        Source = TARGET, ProgressionSource = TEMPLATE }
    local caster = { SpellBook = { Spells = { { Id = id } } } }
    local ground = { PropertyContext = { GROUND = true } }
    local definition = { SpellType = "Target", TargetRadius = "27",
        SpellProperties = { { Functors = { ground } } } }
    local point = { 37, 1, 20 }
    Ext.Entity = { Get = function(actor) assert(actor == ACTOR); return caster end }
    Ext.Types = { Serialize = function(value) local result = {}; for k, v in pairs(value) do result[k] = v end; return result end }
    Ext.Stats = { Get = function() if variant == "expired-read" then deadline = nil end; return definition end }
    Ext.System = { ServerCastRequest = { NetworkStartRequests = setmetatable({}, { __newindex = function()
        error("Ground cast must use the public native entry point")
    end }) } }
    Osi.UseSpellAtPosition = function(...) requests[#requests + 1] = { ... } end
    Osi.GetPosition = function() return 10, 1, 20 end
    if variant == "same-position" then point = { 10, 1, 20 }
    elseif variant == "no-properties" then definition.SpellProperties = nil
    elseif variant == "no-ground" then ground.PropertyContext.GROUND = false
    elseif variant == "missing-context" then ground.PropertyContext = nil
    elseif variant == "nonboolean-ground" then ground.PropertyContext.GROUND = "GROUND"
    elseif variant == "wrong-type" then definition.SpellType = "Projectile"
    elseif variant == "out-of-range" then point[1] = 37.01
    elseif variant == "vertical-range" then point = { 10, 28.01, 20 }
    elseif variant == "no-radius" then definition.TargetRadius = nil; definition.Range = 100
    elseif variant == "nonfinite-radius" then definition.TargetRadius = math.huge
    elseif variant == "zero-radius" then definition.TargetRadius = 0
    elseif variant == "missing-coordinate" then point[2] = nil
    elseif variant == "ambiguous" then caster.SpellBook.Spells[2] = { Id = id }
    elseif variant == "partial-id" then id.Source = nil
    elseif variant == "missing-spell" then caster.SpellBook.Spells = {}
    elseif variant == "busy" then caster.SpellCastIsCasting = {}
    elseif variant == "expired" then deadline = nil
    elseif variant == "groups-limit" then
        definition.SpellProperties = {}
        for i = 1, 65 do definition.SpellProperties[i] = { Functors = {} } end
        definition.SpellProperties[65].Functors = { ground }
    elseif variant == "functors-limit" then
        local functors = {}
        for i = 1, 65 do functors[i] = { PropertyContext = { GROUND = false } } end
        functors[65] = ground
        definition.SpellProperties = { { Functors = functors } }
    end
    local current = RuntimeFixture.Create(context)
    if variant == "closed" then cleanup() end
    local ok, err = pcall(function() current:CastSpellAtPosition(ACTOR, spell, point) end)
    if variant == "pass" or variant == "same-position" then
        assert(ok and #requests == 1, "Ground request not dispatched: " .. tostring(err))
        local request = requests[1]
        assert(#request == 6 and request[1] == ACTOR and request[2] == spell and request[6] == 1)
        assert(request[3] == point[1] and request[4] == point[2] and request[5] == point[3])
        assert(id.Source == TARGET and id.ProgressionSource == TEMPLATE, "Ground grant provenance changed")
    else assert(not ok and #requests == 0, "Unsafe ground request: " .. variant) end
    if variant ~= "closed" then cleanup() end
end
for _, variant in ipairs({ "pass", "same-position", "external-spell", "no-properties", "no-ground", "missing-context",
    "nonboolean-ground", "wrong-type", "out-of-range", "vertical-range", "no-radius", "nonfinite-radius", "zero-radius",
    "missing-coordinate", "ambiguous", "partial-id", "missing-spell", "busy", "expired", "expired-read", "groups-limit",
    "functors-limit", "closed" }) do groundPosition(variant) end
print("BG3 ground positional fixture: " .. groundCases .. " cases passed")

local zoneCases = 0
local function zoneAtActor(variant)
    zoneCases = zoneCases + 1; reset()
    local group = "03b17647-161a-42e1-9660-5ba517e80ad2"
    local deadline, requests, hookCount = 10000, {}, 0
    context.GetDeadlineEpochMs = function() return deadline end
    local id = { Prototype="Zone_Test",OriginatorPrototype="Zone_Test",SourceType="Boost",Source=TEMPLATE,ProgressionSource=ACTOR }
    local caster = { SpellBook={Spells={{Id=id,PreferredCastingResource=group}}} }
    local destination = { Health={Hp=10} }
    local p = {13,1,20}
    Osi.GetPosition = function(actor) if actor==ACTOR then return 10,1,20 end; return table.unpack(p) end
    Osi.FindValidPosition = function(x,y,z) return x,y,z end
    Osi.CreateAt = function() return TARGET end
    Osi.RequestDeleteTemporary = function() end
    Osi.Exists = function() return 1 end
    Osi.IsCharacter = function() return 1 end
    Osi.IsDead = function() return 0 end
    Osi.UseSpellAtPosition = function() error("Client cone must not invoke Osiris cast") end
    Ext.Entity = {Get=function(actor) return actor==ACTOR and caster or actor==TARGET and destination or nil end}
    local definition={SpellType="Zone",Shape="Cone",Range=5,Angle=60}
    Ext.Stats = {Get=function()
        if variant=="expired-read" then deadline=nil end
        if variant=="moved-read" then p[1]=14 end
        if variant=="busy-read" then caster.SpellCastIsCasting={} end
        return definition
    end}
    Ext.Types = {Serialize=function(value) local result={}; for k,v in pairs(value) do result[k]=v end; return result end}
    Ext.System = {ServerCastRequest={NetworkStartRequests=requests}}
    if variant=="queue-length-error" then setmetatable(requests,{__len=function() error("Queue length unavailable") end}) end
    if variant=="queue-index-invalid" then setmetatable(requests,{__len=function() return -1 end}) end
    if variant=="append-then-error" then setmetatable(requests,{__newindex=function(self,key,value)
        rawset(self,key,value); error("Queue wrote before error")
    end}) end
    local current=RuntimeFixture.Create(context)
    local target=variant=="unowned" and TARGET or current:SpawnNear(ACTOR,{Template=TEMPLATE})
    local point={13,1,20}
    if variant=="expired" then deadline=nil
    elseif variant=="closed" then cleanup()
    elseif variant=="self" then target=ACTOR
    elseif variant=="target-dead" or variant=="caster-dead" then Osi.IsDead=function(v) return v==(variant=="target-dead" and TARGET or ACTOR) and 1 or 0 end
    elseif variant=="target-missing" or variant=="caster-missing" then Osi.Exists=function(v) return v==(variant=="target-missing" and TARGET or ACTOR) and 0 or 1 end
    elseif variant=="caster-item" then Osi.IsCharacter=function(v) return v==ACTOR and 0 or 1 end
    elseif variant=="caster-dead-unreadable" then Osi.IsDead=function(v) if v==TARGET then return 0 end end
    elseif variant=="caster-read-error" then Osi.Exists=function() error("Exists failed") end
    elseif variant=="moved" then p[1]=14
    elseif variant=="nonfinite" then point[1]=0/0
    elseif variant=="extra-position" then point[4]=0
    elseif variant=="zero-direction" then point={10,1,20}; p=point
    elseif variant=="range" then definition.Range=2
    elseif variant=="range-overflow" then definition.Range=1e308
    elseif variant=="angle" then definition.Angle=0
    elseif variant=="noncone" then definition.Shape="Circle"
    elseif variant=="wrong-resource" then caster.SpellBook.Spells[1].PreferredCastingResource=TEMPLATE
    elseif variant=="nil-resource" then caster.SpellBook.Spells[1].PreferredCastingResource=nil
    elseif variant=="ambiguous" then caster.SpellBook.Spells[2]=caster.SpellBook.Spells[1]
    elseif variant=="partial-id" then id.Source=nil
    elseif variant=="missing-book" then caster.SpellBook=nil
    elseif variant=="missing-grant" then caster.SpellBook.Spells={}
    elseif variant=="target-method" or variant=="targets-method" then definition.SpellType="Target"
    end
    local ok=pcall(function()
        if variant=="target-method" then current:CastSpell(ACTOR,"Zone_Test",target)
        elseif variant=="targets-method" then current:CastSpellTargets(ACTOR,"Zone_Test",{target})
        else current:CastZoneAtActor(ACTOR,"Zone_Test",target,point,group,
            variant=="invalid-hook" and true or function() hookCount=hookCount+1 end) end
    end)
    if variant=="pass" or variant=="target-method" or variant=="targets-method" then
        assert(ok and #requests==1,"Owned actor cone request was not dispatched")
        local r=requests[1]
        assert(r.Caster==caster and r.Targets[1].Target==destination and #r.Targets==1
            and r.Targets[1].TargetProxy==nil and #r.CastOptions==1 and r.CastOptions[1]=="FromClient" and r.Spell.Source==TEMPLATE)
        if variant=="pass" then
            assert(hookCount==1,"Dispatch hook did not precede append")
            assert(r.Targets[1].Position[1]==13 and r.Targets[1].TargetingType=="Zone")
            point[1]=900; assert(r.Targets[1].Position[1]==13,"Queued position retained mutable input")
        else assert(r.Targets[1].TargetingType=="Target" and r.Targets[1].Position==nil) end
    elseif variant=="append-then-error" then
        assert(not ok and hookCount==1 and rawget(requests,1),"Ambiguous append lost its attempted marker")
    else assert(not ok and hookCount==0 and rawget(requests,1)==nil,"Invalid client cone dispatched: "..variant) end
    if variant~="closed" then cleanup() end
end
for _,variant in ipairs({"pass","unowned","self","expired","expired-read","closed","target-dead","caster-dead",
    "target-missing","caster-missing","caster-item","caster-dead-unreadable","caster-read-error","moved","moved-read",
    "busy-read","nonfinite","extra-position","zero-direction","range","range-overflow","angle","noncone","wrong-resource","nil-resource",
    "ambiguous","partial-id","missing-book","missing-grant","target-method","targets-method","invalid-hook",
    "queue-length-error","queue-index-invalid","append-then-error"}) do zoneAtActor(variant) end
print("BG3 client cone fixture: "..zoneCases.." cases passed")

local itemCleanupCases = 0
for _, variant in ipairs({ "owned-item", "consumed-item", "character", "ambiguous", "unknown",
    "exists-nil", "exists-error", "item-query-error", "invalid-kind", "false-kind" }) do
    reset()
    local creates, itemDeletes, characterDeletes, queries = 0, 0, 0, 0
    Osi.GetPosition = function(actor) assert(actor == ACTOR); return 10, 1, 20 end
    Osi.FindValidPosition = function() return 12, 1, 20 end
    Osi.CreateAt = function() creates = creates + 1; return TARGET end
    Osi.Exists = function(actor)
        assert(actor == TARGET); queries = queries + 1
        if variant == "exists-error" then error("unreadable existence") end
        if variant == "exists-nil" then return nil end
        return variant == "consumed-item" and 0 or 1
    end
    Osi.IsItem = function(actor)
        assert(actor == TARGET and variant ~= "consumed-item")
        if variant == "item-query-error" then error("unreadable item type") end
        return variant ~= "character" and variant ~= "unknown" and 1 or 0
    end
    Osi.IsCharacter = function(actor)
        assert(actor == TARGET and variant ~= "consumed-item")
        return (variant == "character" or variant == "ambiguous") and 1 or 0
    end
    Osi.RequestDelete = function(actor) assert(actor == TARGET); itemDeletes = itemDeletes + 1 end
    Osi.RequestDeleteTemporary = function() characterDeletes = characterDeletes + 1 end
    local current = RuntimeFixture.Create(context)
    local kind = "Item"
    if variant == "invalid-kind" then kind = "item" elseif variant == "false-kind" then kind = false end
    local created = pcall(current.SpawnNear, current, ACTOR, { Template = TEMPLATE, EntityKind = kind })
    local cleaned = pcall(cleanup)
    if variant == "invalid-kind" or variant == "false-kind" then
        assert(not created and creates == 0 and cleaned and queries == 0, "Invalid entity kind mutated the world")
    else
        assert(created and creates == 1, "Item fixture was not created")
        if variant == "owned-item" then
            assert(cleaned and itemDeletes == 1, "Item cleanup did not use RequestDelete")
        elseif variant == "consumed-item" then
            assert(cleaned and itemDeletes == 0, "Consumed item received another delete request")
        else
            assert(not cleaned and itemDeletes == 0, "Unsafe item cleanup accepted " .. variant)
        end
    end
    assert(characterDeletes == 0, "Item cleanup used the character-only deletion API")
    cleanup()
    assert(itemDeletes <= 1, "Item cleanup repeated its deletion")
    itemCleanupCases = itemCleanupCases + 1
end
print("BG3 item cleanup: " .. itemCleanupCases .. " cases passed")
print("BG3 runtime fixture test passed")
