local RuntimeFixture = {}
local EntityIdentity = Mods.BG3InGameHarness.EntityIdentity
local NULL_UUID = "00000000-0000-0000-0000-000000000000"
local POLL_MS = 100
local READINESS_TIMEOUT_MS = 5000

-- Construct the existing request without sending it. Diagnostics use this same
-- table to observe supplied fields, without guessing native defaults.
function RuntimeFixture.BuildCastRequest(caster, destination, spellId, targetingType)
    return {
        Caster = caster, Spell = spellId, CastOptions = { "FromClient" },
        Targets = { { Target = destination, TargetingType = targetingType } }
    }
end

-- The list variant keeps the caller's order and adds one native entry per
-- destination. A one element list matches BuildCastRequest.
function RuntimeFixture.BuildCastRequestTargets(caster, destinations, spellId, targetingType)
    local targets = {}
    for index, destination in ipairs(destinations) do
        targets[index] = { Target = destination, TargetingType = targetingType }
    end
    return { Caster = caster, Spell = spellId, CastOptions = { "FromClient" }, Targets = targets }
end

local MAX_CAST_TARGETS = 8

local function isFinite(value)
    return type(value) == "number" and value == value
        and value ~= math.huge and value ~= -math.huge
end

-- SE exposes SpellProperties as FunctorGroup[] and named bitfield labels as
-- booleans. Inspect those public fields rather than stringifying native userdata.
-- Positional casts at a ground point are limited to Target spells whose Stats ID
-- matches this Lua pattern. Narrow it to your mod's prefix, e.g. "^Target_MyMod_".
RuntimeFixture.GroundTargetSpellPattern = "^Target_"

local function ownedGroundTarget(spell, definition)
    if not spell:match(RuntimeFixture.GroundTargetSpellPattern) or tostring(definition.SpellType) ~= "Target" then return false end
    local properties = definition.SpellProperties
    if properties == nil then return false end
    local groups, functors, found = 0, 0, false
    for _, group in pairs(properties) do
        groups = groups + 1
        if groups > 64 then error("Fixture ground functor group read limit") end
        if group.Functors == nil then error("Fixture ground functor group unavailable") end
        for _, functor in pairs(group.Functors) do
            functors = functors + 1
            if functors > 64 then error("Fixture ground functor read limit") end
            if functor.PropertyContext ~= nil and functor.PropertyContext.GROUND == true then found = true end
        end
    end
    return found
end

local function has(query, actor, identifier)
    local result = query(actor, identifier)
    if result ~= 0 and result ~= 1 then
        error("Runtime fixture cannot inspect actor requirement " .. identifier)
    end
    return result == 1
end

local function requireActor(actor)
    local canonical = EntityIdentity.Canonical(actor)
    if canonical == nil or canonical == NULL_UUID then
        error("Runtime fixture requires a valid actor UUID")
    end
    return canonical
end

-- A dense list of 1 to 8 distinct actor UUIDs, validated before any wait.
local function castTargets(values)
    if type(values) ~= "table" then error("Fixture multi-target cast requires a list of targets") end
    local result, seen, count = {}, {}, 0
    for index, value in pairs(values) do
        count = count + 1
        if count > MAX_CAST_TARGETS or type(index) ~= "number" or index % 1 ~= 0
            or index < 1 or index > MAX_CAST_TARGETS then
            error("Fixture multi-target cast requires a dense list of 1 to 8 targets")
        end
        local target = requireActor(value)
        if seen[target] then error("Fixture multi-target cast requires distinct targets") end
        seen[target] = true
        result[index] = target
    end
    if count == 0 then error("Fixture multi-target cast requires a dense list of 1 to 8 targets") end
    for index = 1, count do
        if result[index] == nil then error("Fixture multi-target cast requires a dense list of 1 to 8 targets") end
    end
    return result
end

-- Shared by the cast requests: the caster's own SpellBook identity and a
-- supported targeting type, read when the request is about to be queued.
local function grantedSpell(caster, spell)
    local spellId
    for _, entry in pairs(caster.SpellBook.Spells) do
        if tostring(entry.Id.Prototype) == spell then
            spellId = Ext.Types.Serialize(entry.Id)
            break
        end
    end
    if spellId == nil then error("Fixture spell is absent from SpellBook: " .. spell) end
    local definition = Ext.Stats.Get(spell)
    local targetingType = definition ~= nil and tostring(definition.SpellType) or nil
    if targetingType ~= "Target" and targetingType ~= "Shout" and targetingType ~= "Projectile" then
        error("Fixture does not support this spell target type: " .. tostring(targetingType))
    end
    return spellId, targetingType
end

local function identifiers(values, label)
    if values == nil then
        return {}
    end
    if type(values) ~= "table" then
        error(label .. " must be an array")
    end
    local result = {}
    local seen = {}
    local count = 0
    for index, value in pairs(values) do
        if type(index) ~= "number" or index % 1 ~= 0 or index < 1
            or type(value) ~= "string" or #value == 0 or #value > 256
            or not value:match("^[%w_]+$") or seen[value] then
            error(label .. " must contain unique Stats identifiers")
        end
        seen[value] = true
        result[index] = value
        count = count + 1
    end
    if count > 128 or count ~= #result then
        error(label .. " must be a dense array of at most 128 identifiers")
    end
    return result
end

local function inheritedSpellRequirements(values, passiveIds, directIds)
    values = values or {}
    if type(values) ~= "table" then error("InheritedSpells must map required passives to spells") end
    local passives, direct = {}, {}
    for _, id in ipairs(passiveIds) do passives[id] = true end
    for _, id in ipairs(directIds) do direct[id] = true end
    for passive in pairs(values) do
        if not passives[passive] then error("An inherited spell must name its required passive") end
    end
    local result, sources = {}, {}
    for _, passive in ipairs(passiveIds) do
        for _, spell in ipairs(identifiers(values[passive], "InheritedSpells")) do
            if direct[spell] or sources[spell] then
                error("An inherited spell must have one source and cannot also be direct")
            end
            table.insert(result, spell)
            sources[spell] = passive
        end
    end
    if #result > 128 then error("A fixture can require at most 128 inherited spells") end
    return result, sources
end

function RuntimeFixture.Create(context)
    if type(context) ~= "table" or type(context.Defer) ~= "function"
        or type(context.DeferCheck) ~= "function" then
        error("Runtime fixture requires a scenario cleanup context")
    end

    local closed = false
    local undo = {}
    local createdActors = {}
    local timers = {}
    local scope = {}
    local function requireOpen()
        if closed then
            error("Runtime fixture is closed")
        end
    end

    context:Defer(function()
        if closed then
            return
        end
        closed = true
        for timer in pairs(timers) do
            pcall(Ext.Timer.Cancel, timer)
        end
        timers = {}
        local errors = {}
        for index = #undo, 1, -1 do
            local ok, cleanupError = pcall(undo[index].Callback)
            if not ok then
                table.insert(errors, undo[index].Label .. ": " .. tostring(cleanupError))
            end
        end
        undo = {}
        if #errors > 0 then
            error(table.concat(errors, "; "))
        end
    end)

    local function remember(label, callback)
        table.insert(undo, { Label = label, Callback = callback })
    end

    function scope:WaitUntil(label, predicate, ready, timeoutMs)
        requireOpen()
        timeoutMs = timeoutMs or READINESS_TIMEOUT_MS
        if type(label) ~= "string" or #label == 0 or #label > 1000
            or type(predicate) ~= "function" or type(ready) ~= "function"
            or not isFinite(timeoutMs) or timeoutMs < POLL_MS or timeoutMs > 60000 then
            error("Runtime fixture wait requires a label, callbacks and a bounded timeout")
        end
        local elapsed = 0
        local finished = false
        local function poll()
            if closed or finished then return end
            local ok, result = pcall(predicate)
            if not ok or type(result) ~= "boolean" then
                finished = true
                context:Error("fixture-readiness-error", label .. ": " .. tostring(result))
            elseif result then
                finished = true
                local completed, callbackError = pcall(ready)
                if not completed then
                    context:Error("fixture-readiness-error", label .. ": " .. tostring(callbackError))
                end
            elseif elapsed >= timeoutMs then
                finished = true
                context:Error("fixture-readiness-timeout", label)
            else
                elapsed = elapsed + POLL_MS
                local timer
                local scheduled, timerOrError = pcall(Ext.Timer.WaitForRealtime, POLL_MS, function()
                    timers[timer] = nil
                    poll()
                end)
                if scheduled then
                    timer = timerOrError
                    timers[timer] = true
                else
                    finished = true
                    context:Error("fixture-readiness-error", label .. ": " .. tostring(timerOrError))
                end
            end
        end
        poll()
    end

    function scope:CastSpell(actor, spell, target)
        requireOpen()
        actor = requireActor(actor)
        target = requireActor(target)
        if #identifiers({ spell }, "Spell") ~= 1 then
            error("Fixture cast requires one spell identifier")
        end
        self:WaitUntil("Caster completed previous action", function()
            local caster = Ext.Entity.Get(actor)
            if caster == nil then error("Fixture caster no longer exists") end
            return caster.SpellCastIsCasting == nil
        end, function()
            local caster = Ext.Entity.Get(actor)
            local destination = Ext.Entity.Get(target)
            if destination == nil then error("Fixture cast target no longer exists") end
            local spellId, targetingType = grantedSpell(caster, spell)
            local requests = Ext.System.ServerCastRequest.NetworkStartRequests
            requests[#requests + 1] = RuntimeFixture.BuildCastRequest(caster, destination, spellId, targetingType)
        end)
    end

    -- One request for several targets, for spells whose native definition
    -- accepts more than one. Every target must still exist and be alive when
    -- the request is queued; BG3 remains the authority on how many it takes.
    function scope:CastSpellTargets(actor, spell, targets)
        requireOpen()
        actor = requireActor(actor)
        targets = castTargets(targets)
        if #identifiers({ spell }, "Spell") ~= 1 then
            error("Fixture cast requires one spell identifier")
        end
        self:WaitUntil("Caster completed previous action", function()
            local caster = Ext.Entity.Get(actor)
            if caster == nil then error("Fixture caster no longer exists") end
            return caster.SpellCastIsCasting == nil
        end, function()
            local caster = Ext.Entity.Get(actor)
            local destinations = {}
            for index, target in ipairs(targets) do
                local destination = Ext.Entity.Get(target)
                if destination == nil or Osi.Exists(target) ~= 1 or Osi.IsDead(target) ~= 0 then
                    error("Fixture cast target is not a live actor: " .. target)
                end
                destinations[index] = destination
            end
            local spellId, targetingType = grantedSpell(caster, spell)
            local requests = Ext.System.ServerCastRequest.NetworkStartRequests
            requests[#requests + 1] = RuntimeFixture.BuildCastRequestTargets(caster, destinations, spellId, targetingType)
        end)
    end

    -- Let the public Osiris API construct the native positional target. This API
    -- does not promise client costs or the grant's SpellId provenance. Callers
    -- must observe both before accepting a mechanical or resource assertion.
    -- The call is synchronous; its native cast and cleanup barrier are not.
    function scope:CastSpellAtPosition(actor, spell, position)
        requireOpen()
        actor = requireActor(actor)
        if #identifiers({ spell }, "Spell") ~= 1 or type(position) ~= "table" then
            error("Fixture positional cast requires a spell and a three-coordinate position")
        end
        local coordinates, count = {}, 0
        for key, value in pairs(position) do
            if key ~= 1 and key ~= 2 and key ~= 3 or not isFinite(value) or math.abs(value) > 3.402823466e38 then
                error("Fixture positional position requires three finite coordinates")
            end
            count = count + 1; coordinates[key] = value
        end
        if count ~= 3 then error("Fixture positional position requires three finite coordinates") end
        local function live()
            if type(context.GetDeadlineEpochMs) == "function" and context:GetDeadlineEpochMs() == nil then
                error("Fixture positional cast deadline expired")
            end
        end
        live()
        local caster = Ext.Entity.Get(actor)
        if not caster or caster.SpellCastIsCasting ~= nil then error("Fixture positional caster is unavailable or busy") end
        local x, y, z = Osi.GetPosition(actor)
        if not isFinite(x) or not isFinite(y) or not isFinite(z)
            or math.abs(x) > 3.402823466e38 or math.abs(y) > 3.402823466e38 or math.abs(z) > 3.402823466e38 then
            error("Fixture positional origin is unavailable")
        end
        local dx, dy, dz = coordinates[1] - x, coordinates[2] - y, coordinates[3] - z
        local horizontalSquared = dx * dx + dz * dz
        local lengthSquared = horizontalSquared + dy * dy
        if not isFinite(lengthSquared) then error("Fixture positional distance is unavailable") end
        local definition = Ext.Stats.Get(spell)
        local shape = definition and tostring(definition.Shape)
        local zone = definition and tostring(definition.SpellType) == "Zone" and (shape == "Cone" or shape == "Square")
        local ground = definition and ownedGroundTarget(spell, definition)
        if not zone and not ground then
            error("Fixture positional cast only supports Zone cones, Zone lines and owned GROUND Targets")
        end
        if zone and shape == "Square" and (not isFinite(tonumber(definition.Base)) or tonumber(definition.Base) <= 0) then
            error("Fixture positional line requires a positive width")
        end
        if zone and horizontalSquared <= 0 then error("Fixture positional direction is unavailable") end
        local range
        if ground then range = tonumber(definition.TargetRadius) else range = tonumber(definition.Range) end
        if not isFinite(range) or range <= 0 or not isFinite(range * range) or lengthSquared > range * range then
            error("Fixture positional position is outside its native range")
        end
        local spellId, read = nil, 0
        if not caster.SpellBook or not caster.SpellBook.Spells then error("Fixture positional SpellBook unavailable") end
        for _, entry in pairs(caster.SpellBook.Spells) do
            read = read + 1
            if read > 512 then error("Fixture positional SpellBook read limit") end
            if tostring(entry.Id.Prototype) == spell then
                if spellId then error("Fixture positional spell grant is ambiguous") end
                spellId = Ext.Types.Serialize(entry.Id)
                for _, key in ipairs({ "Prototype", "OriginatorPrototype", "SourceType", "Source", "ProgressionSource" }) do
                    if spellId[key] == nil then error("Fixture positional SpellId incomplete: " .. key) end
                end
            end
        end
        if not spellId then error("Fixture positional spell is absent from SpellBook: " .. spell) end
        live()
        Osi.UseSpellAtPosition(actor, spell, coordinates[1], coordinates[2], coordinates[3], 1)
    end

    -- A client cone aimed at an actual character owned by this fixture. SE 9198
    -- InitialTarget accepts both Target and Position; its position getter gives
    -- Position precedence. Do not fabricate a null or self target for the cone.
    function scope:CastZoneAtActor(actor, spell, target, expectedPosition, resourceGroup, beforeEnqueue)
        requireOpen()
        if beforeEnqueue ~= nil and type(beforeEnqueue) ~= "function" then
            error("Fixture client cone enqueue hook must be a function")
        end
        actor, target, resourceGroup = requireActor(actor), requireActor(target), requireActor(resourceGroup)
        if actor == target or not createdActors[target] or #identifiers({spell}, "Spell") ~= 1 then
            error("Fixture client cone requires its own separate target and one spell")
        end
        if type(expectedPosition) ~= "table" then error("Fixture client cone requires an expected position") end
        local coordinates, count = {}, 0
        for key, value in pairs(expectedPosition) do
            if key ~= 1 and key ~= 2 and key ~= 3 or not isFinite(value) or math.abs(value) > 3.402823466e38 then
                error("Fixture client cone position requires three finite float coordinates")
            end
            count = count + 1; coordinates[key] = value
        end
        if count ~= 3 then error("Fixture client cone position is incomplete") end
        local function live()
            requireOpen()
            if type(context.GetDeadlineEpochMs) ~= "function" or context:GetDeadlineEpochMs() == nil then
                error("Fixture client cone deadline expired")
            end
            for _, character in ipairs({actor,target}) do
                if Osi.Exists(character) ~= 1 or Osi.IsCharacter(character) ~= 1 or Osi.IsDead(character) ~= 0 then
                    error("Fixture client cone requires two living characters")
                end
            end
            local x, y, z = Osi.GetPosition(target)
            if x ~= coordinates[1] or y ~= coordinates[2] or z ~= coordinates[3] then
                error("Fixture client cone target moved from its expected position")
            end
        end
        live()
        local caster, destination = Ext.Entity.Get(actor), Ext.Entity.Get(target)
        if not caster or caster.SpellCastIsCasting ~= nil or not destination then
            error("Fixture client cone caster or target is unavailable or busy")
        end
        local x, y, z = Osi.GetPosition(actor)
        if not isFinite(x) or not isFinite(y) or not isFinite(z)
            or math.abs(x) > 3.402823466e38 or math.abs(y) > 3.402823466e38 or math.abs(z) > 3.402823466e38 then
            error("Fixture client cone origin is unreadable")
        end
        local dx, dy, dz = coordinates[1]-x, coordinates[2]-y, coordinates[3]-z
        local lengthSquared = dx*dx + dy*dy + dz*dz
        local definition = Ext.Stats.Get(spell)
        if not definition or tostring(definition.SpellType) ~= "Zone" or tostring(definition.Shape) ~= "Cone"
            or not isFinite(definition.Range) or definition.Range <= 0 or not isFinite(definition.Range^2)
            or not isFinite(definition.Angle) or definition.Angle <= 0 or definition.Angle > 360
            or not isFinite(lengthSquared) or dx*dx+dz*dz <= 0 or lengthSquared > definition.Range^2 then
            error("Fixture client cone definition, direction or range differs")
        end
        local spellId, read = nil, 0
        if not caster.SpellBook or not caster.SpellBook.Spells then error("Fixture client cone SpellBook unavailable") end
        for _, entry in pairs(caster.SpellBook.Spells) do
            read = read + 1
            if read > 512 then error("Fixture client cone SpellBook read limit") end
            if tostring(entry.Id.Prototype) == spell then
                if spellId or entry.PreferredCastingResource ~= resourceGroup then
                    error("Fixture client cone grant is ambiguous or has another casting resource")
                end
                spellId = Ext.Types.Serialize(entry.Id)
                for _, key in ipairs({"Prototype","OriginatorPrototype","SourceType","Source","ProgressionSource"}) do
                    if spellId[key] == nil then error("Fixture client cone SpellId incomplete: "..key) end
                end
            end
        end
        if not spellId then error("Fixture client cone spell is absent from SpellBook") end
        live()
        if Ext.Entity.Get(actor) ~= caster or Ext.Entity.Get(target) ~= destination or caster.SpellCastIsCasting ~= nil then
            error("Fixture client cone actor changed before dispatch")
        end
        local request = RuntimeFixture.BuildCastRequest(caster, destination, spellId, "Zone")
        request.Targets[1].Position = coordinates
        local requests = Ext.System.ServerCastRequest.NetworkStartRequests
        local index = #requests + 1
        if not isFinite(index) or index < 1 or index % 1 ~= 0 then error("Fixture client cone queue index is invalid") end
        -- The hook records a possibly applied enqueue, not confirmed success.
        -- All reads precede it; an append error must retain pending cleanup.
        if beforeEnqueue then beforeEnqueue() end
        requests[index] = request
    end

    function scope:EndForceTurnBasedTurn(actor)
        requireOpen()
        actor = requireActor(actor)
        if Osi.IsInForceTurnBasedMode(actor) ~= 1 then
            error("Fixture actor is outside Force Turn Based")
        end
        local entity = Ext.Entity.Get(actor)
        if entity == nil then error("Fixture actor no longer exists") end
        local requests = Ext.System.ServerFTBZone.SetTurnActionsCompleted
        requests[#requests + 1] = { Entity = entity, ActionsCompleted = true }
    end

    function scope:OnForceTurnBasedRound(callback)
        requireOpen()
        if type(callback) ~= "function" then error("Fixture round requires a callback") end
        local subscription = Ext.Entity.OnCreateDeferred("FTBPlayersTurnStartedEvent", function()
            if closed then return end
            local ok, callbackError = pcall(callback)
            if not ok then context:Error("fixture-round-error", tostring(callbackError)) end
        end)
        remember("unsubscribe Force Turn Based round", function()
            Ext.Entity.Unsubscribe(subscription)
        end)
    end

    function scope:PrepareActor(actor, requirements, ready)
        requireOpen()
        actor = requireActor(actor)
        if type(requirements) ~= "table" then
            error("Runtime fixture actor requirements must be a table")
        end
        if type(ready) ~= "function" then
            error("Runtime fixture actor preparation requires a readiness callback")
        end
        local passives = identifiers(requirements.Passives, "Passives")
        local spells = identifiers(requirements.Spells, "Spells")
        local inheritedSpells, inheritedSources = inheritedSpellRequirements(
            requirements.InheritedSpells, passives, spells
        )
        local readiness = requirements.Readiness
        if readiness ~= nil and type(readiness) ~= "function" then
            error("Runtime fixture actor readiness must be a predicate")
        end
        local function prepareRequirements()
            local evidence = {
                AddedPassives = {}, ExistingPassives = {},
                AddedSpells = {}, ExistingSpells = {}, InheritedSpells = inheritedSpells
            }
            local removedPassives, removedSpells = {}, {}
            local newInheritedSpells = {}
            for _, passive in ipairs(passives) do
                local destination = has(Osi.HasPassive, actor, passive)
                    and evidence.ExistingPassives or evidence.AddedPassives
                table.insert(destination, passive)
            end
            for _, spell in ipairs(spells) do
                local destination = has(Osi.HasSpell, actor, spell)
                    and evidence.ExistingSpells or evidence.AddedSpells
                table.insert(destination, spell)
            end
            local ownedPassives = {}
            for _, passive in ipairs(evidence.AddedPassives) do ownedPassives[passive] = true end
            for _, spell in ipairs(inheritedSpells) do
                if ownedPassives[inheritedSources[spell]] and not has(Osi.HasSpell, actor, spell) then
                    table.insert(newInheritedSpells, spell)
                end
            end
            context:DeferCheck("actor requirements removed from " .. actor, function()
                if createdActors[actor] and Osi.Exists(actor) == 0 then return true end
                for _, passive in ipairs(removedPassives) do
                    if has(Osi.HasPassive, actor, passive) then return false end
                end
                for _, spell in ipairs(removedSpells) do
                    if has(Osi.HasSpell, actor, spell) then return false end
                end
                for _, spell in ipairs(newInheritedSpells) do
                    if has(Osi.HasSpell, actor, spell) then return false end
                end
                return true
            end)

            for _, passive in ipairs(evidence.AddedPassives) do
                remember("remove passive " .. passive, function()
                    Osi.RemovePassive(actor, passive)
                end)
                table.insert(removedPassives, passive)
                Osi.AddPassive(actor, passive)
            end
            for _, spell in ipairs(evidence.AddedSpells) do
                if not has(Osi.HasSpell, actor, spell) then
                    remember("remove spell " .. spell, function()
                        Osi.RemoveSpell(actor, spell, 0)
                    end)
                    table.insert(removedSpells, spell)
                    Osi.AddSpell(actor, spell, 0, 0)
                end
            end
            local label = "Actor " .. actor .. " requires " .. table.concat(passives, ",")
                .. "; spells " .. table.concat(spells, ",") .. "; inherited " .. table.concat(inheritedSpells, ",")
            self:WaitUntil(label:sub(1, 1000), function()
                for _, passive in ipairs(passives) do
                    if not has(Osi.HasPassive, actor, passive) then return false end
                end
                for _, spell in ipairs(spells) do
                    if not has(Osi.HasSpell, actor, spell) then return false end
                end
                for _, spell in ipairs(inheritedSpells) do
                    if not has(Osi.HasSpell, actor, spell) then return false end
                end
                return true
            end, function() ready(evidence) end)
        end
        if readiness ~= nil then
            -- A caller must supply a read-only predicate appropriate to this actor.
            -- Exists and StatsApplied do not guarantee initialized character stats.
            self:WaitUntil("Actor " .. actor .. " initialization before requirements", readiness, prepareRequirements)
        else
            prepareRequirements()
        end
    end

    function scope:OwnsActor(actor)
        local canonical = EntityIdentity.Canonical(actor)
        return not closed and canonical ~= nil and createdActors[canonical] == true
    end

    function scope:SpawnNear(actor, options)
        requireOpen()
        actor = requireActor(actor)
        if type(options) ~= "table" then
            error("Runtime fixture spawn options must be a table")
        end
        local entityKind = options.EntityKind
        if entityKind == nil then entityKind = "Character" end
        if entityKind ~= "Character" and entityKind ~= "Item" then
            error("Runtime fixture entity kind must be Character or Item")
        end
        local template = requireActor(options.Template)
        local radius = options.Radius or 4
        local minimum = options.MinHorizontalDistance
        if minimum == nil then minimum = 0 end
        if not isFinite(radius) or radius <= 0 or not isFinite(minimum) or minimum < 0 then
            error("Runtime fixture spawn requires finite coordinates and a positive radius")
        end
        local minimumSquared = minimum * minimum
        if not isFinite(minimumSquared) then error("Runtime fixture minimum spawn distance overflowed") end
        local candidates = options.CandidateOffsets
        local boundedSearch = candidates ~= nil
        if boundedSearch and (options.Offset ~= nil or type(candidates) ~= "table"
            or type(context.GetDeadlineEpochMs) ~= "function") then
            error("Runtime fixture candidate search requires offsets, an active deadline and no single Offset")
        end
        candidates = candidates or { options.Offset or { 3, 0, 0 } }
        local count, offsets = 0, {}
        for index, offset in pairs(candidates) do
            count = count + 1
            if count > 8 or type(index) ~= "number" or index % 1 ~= 0 or index < 1 or index > 8
                or type(offset) ~= "table" or #offset ~= 3
                or not isFinite(offset[1]) or not isFinite(offset[2]) or not isFinite(offset[3]) then
                error("Runtime fixture candidate offsets must be a dense array of 1 to 8 finite coordinate triples")
            end
            local fields = 0
            for key in pairs(offset) do
                fields = fields + 1
                if fields > 3 or key ~= 1 and key ~= 2 and key ~= 3 then
                    error("Runtime fixture spawn offsets must contain exactly three coordinates")
                end
            end
            if fields ~= 3 then error("Runtime fixture spawn offsets must contain exactly three coordinates") end
            offsets[index] = { offset[1], offset[2], offset[3] }
        end
        if count == 0 then error("Runtime fixture candidate offsets must be a dense array of 1 to 8 triples") end
        for index = 1, count do
            if offsets[index] == nil then error("Runtime fixture candidate offsets must be a dense array of 1 to 8 triples") end
        end
        local function requireSearchActive()
            requireOpen()
            if boundedSearch then
                local deadline = context:GetDeadlineEpochMs()
                if not isFinite(deadline) or deadline <= 0 then error("Runtime fixture candidate search has no active deadline") end
            end
        end
        requireSearchActive()
        local x, y, z = Osi.GetPosition(actor)
        if not isFinite(x) or not isFinite(y) or not isFinite(z) then
            error("Runtime fixture cannot read the anchor position")
        end
        local positions = {}
        for _, offset in ipairs(offsets) do
            local desiredX, desiredY, desiredZ = x + offset[1], y + offset[2], z + offset[3]
            if not isFinite(desiredX) or not isFinite(desiredY) or not isFinite(desiredZ) then
                error("Runtime fixture spawn coordinates overflowed")
            end
            positions[#positions + 1] = { desiredX, desiredY, desiredZ }
        end
        local targetX, targetY, targetZ
        local rejected = {}
        for index, position in ipairs(positions) do
            requireSearchActive()
            local foundX, foundY, foundZ = Osi.FindValidPosition(position[1], position[2], position[3], radius, actor, 1)
            if foundX == nil and foundY == nil and foundZ == nil then
                rejected[#rejected + 1] = string.format("%d: no ground at %.2f, %.2f, %.2f", index, position[1], position[2], position[3])
            elseif not isFinite(foundX) or not isFinite(foundY) or not isFinite(foundZ) then
                error("Runtime fixture received an invalid spawn position tuple for candidate " .. index)
            else
                local dx, dz = foundX - x, foundZ - z
                local distanceSquared = dx * dx + dz * dz
                if not isFinite(distanceSquared) then error("Runtime fixture spawn distance overflowed") end
                if distanceSquared < minimumSquared then
                    rejected[#rejected + 1] = string.format("%d: horizontal distance %.2f below %.2f", index, math.sqrt(distanceSquared), minimum)
                else
                    targetX, targetY, targetZ = foundX, foundY, foundZ
                    break
                end
            end
        end
        if targetX == nil then error("Runtime fixture could not find a valid spawn position within radius "
            .. radius .. " after " .. #positions .. " candidates: " .. table.concat(rejected, "; ")) end
        requireSearchActive()
        local spawned = Osi.CreateAt(template, targetX, targetY, targetZ, 1, 0, "")
        local created = EntityIdentity.Canonical(spawned)
        if created == nil or created == NULL_UUID or created == actor
            or createdActors[created] then
            error("Runtime fixture did not receive a new temporary actor UUID")
        end
        createdActors[created] = true
        remember("delete temporary actor " .. created, function()
            if entityKind == "Item" then
                local exists = Osi.Exists(created)
                if exists == 0 then return end
                if exists ~= 1 or Osi.IsItem(created) ~= 1 or Osi.IsCharacter(created) ~= 0 then
                    error("Runtime fixture cannot confirm its created item before deletion")
                end
                Osi.RequestDelete(created)
            else
                Osi.RequestDeleteTemporary(created)
            end
        end)
        return created
    end

    function scope:Boost(actor, boosts, source, owner)
        requireOpen()
        actor = requireActor(actor)
        owner = requireActor(owner)
        if type(boosts) ~= "string" or #boosts > 4096 or not boosts:match("%S")
            or type(source) ~= "string" or #source > 256
            or not source:match("^[%w_]+$") then
            error("Runtime fixture boosts require a nonempty definition and source identifier")
        end
        remember("remove boosts from " .. actor, function()
            Osi.RemoveBoosts(actor, boosts, 0, source, owner)
        end)
        Osi.AddBoosts(actor, boosts, source, owner)
    end

    return scope
end

return RuntimeFixture
