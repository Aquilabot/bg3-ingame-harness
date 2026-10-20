local Label = {}
local ALPHABET = "ABCDEFGHJKLMNPQR"
local UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"
local NULL = "00000000-0000-0000-0000-000000000000"

local function read(object, name)
    if object == nil then return nil end
    local ok, value = pcall(function() return object[name] end)
    if ok then return value end
end

function Label.Describe(targetUuid)
    if type(targetUuid) ~= "string" or not targetUuid:match(UUID) or targetUuid == NULL then
        error("target-label-invalid-uuid")
    end
    targetUuid = targetUuid:lower()
    local token = targetUuid:sub(1, 8):gsub("%x", function(hex)
        local index = tonumber(hex, 16) + 1
        return ALPHABET:sub(index, index)
    end)
    return { targetUuid = targetUuid, text = "HNX" .. token,
        key = "BG3_HARNESS_TARGET_" .. targetUuid:gsub("-", "_"),
        handle = "h" .. targetUuid:gsub("-", "g") }
end

-- These calls only register owned localization entries. The scenario alone
-- assigns the story name after it has created and killed its disposable actor.
function Label.Ensure(targetUuid)
    local value = Label.Describe(targetUuid)
    local loca = Ext and Ext.Loca
    if not loca or type(loca.GetTranslatedStringKey) ~= "function"
        or type(loca.UpdateTranslatedStringKey) ~= "function"
        or type(loca.GetTranslatedString) ~= "function" or type(loca.UpdateTranslatedString) ~= "function" then
        error("target-label-localization-unavailable")
    end
    local existing = loca.GetTranslatedStringKey(value.key)
    -- This by-value API serializes TranslatedString as its handle string.
    -- ECS DisplayName.Name instead exposes a TranslatedString proxy.
    if existing ~= nil and existing ~= value.handle then error("target-label-key-collision") end
    local missing = "BG3_HARNESS_UNREGISTERED_TRANSLATION"
    local text = loca.GetTranslatedString(value.handle, missing)
    if text ~= missing and text ~= value.text then error("target-label-handle-collision") end
    if text == missing and loca.UpdateTranslatedString(value.handle, value.text) ~= true then
        error("target-label-text-write-failed")
    end
    if existing == nil and loca.UpdateTranslatedStringKey(value.key, value.handle) ~= true then
        error("target-label-key-write-failed")
    end
    existing = loca.GetTranslatedStringKey(value.key)
    if existing ~= value.handle or loca.GetTranslatedString(value.handle) ~= value.text then
        error("target-label-localization-not-observed")
    end
    return value
end

function Label.ActorText(targetUuid)
    local entity = Ext.Entity.Get(targetUuid)
    local translated = read(read(entity, "DisplayName"), "Name")
    local ok, text = pcall(function() return translated:Get() end)
    return ok and type(text) == "string" and text or nil
end

function Label.ReadTooltip(entry, targetUuid)
    local expected = Label.Describe(targetUuid)
    local id = read(read(entry, "GameObject"), "EntityUUID")
    if type(id) ~= "string" or id:lower() ~= expected.targetUuid then
        return nil, { error = "target-label-owner-mismatch" }
    end
    local declaredType
    local metadataOk = pcall(function()
        local info = entry:TypeInfo()
        for _ = 1, 16 do
            if info == nil then break end
            for _, property in ipairs(info.Properties) do
                if tostring(property.Name) == "Name" then
                    declaredType = tostring(property.ContentType.Name)
                    return
                end
            end
            info = info.Base
        end
    end)
    local raw = read(entry, "Name")
    local evidence = { nameType = declaredType, nameLuaType = type(raw) }
    if not metadataOk or declaredType == nil then
        evidence.error = "target-label-name-type-unavailable"
        return nil, evidence
    end
    local text
    if type(raw) == "string" then
        if declaredType == "String" or declaredType == "const Char*" then text = raw
        elseif declaredType == "ls.LocaString" then
            evidence.nameHandle = raw
            local ok, resolved = pcall(Ext.Loca.GetTranslatedString, raw)
            if ok then text = resolved end
        end
    end
    if type(text) == "string" then evidence.name = text:sub(1, 128) end
    if text ~= expected.text then
        evidence.error = "target-label-text-not-observed"
        return nil, evidence
    end
    evidence.nameVerified = true
    return text, evidence
end

return Label
