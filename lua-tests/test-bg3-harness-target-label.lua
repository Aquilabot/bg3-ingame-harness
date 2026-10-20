local PATH = "mod/Mods/BG3InGameHarness_41d551b8-e0c1-4c12-8a29-1be03b5f9054/ScriptExtender/Lua/HarnessTargetLabel.lua"
local Label = dofile(PATH)
local TARGET = "01234567-89ab-cdef-0123-456789abcdef"
local OTHER = "89abcdef-0123-4567-89ab-cdef01234567"
local value = Label.Describe(TARGET)
assert(value.text == "HNXABCDEFGH" and Label.Describe(OTHER).text == "HNXJKLMNPQR",
    "Fixture token did not use all sixteen agreed hexadecimal letters")
assert(value.handle == "h01234567g89abgcdefg0123g456789abcdef"
    and value.key == "BG3_HARNESS_TARGET_01234567_89ab_cdef_0123_456789abcdef")
for _, id in ipairs({ "", "other-" .. TARGET, "00000000-0000-0000-0000-000000000000", TARGET .. "0" }) do
    assert(not pcall(Label.Describe, id), "Invalid fixture identity generated a label")
end
local texts, keys, writes = { vanilla = "Human" }, {}, 0
Ext = { Loca = {
    GetTranslatedString = function(handle, fallback) return texts[handle] or fallback or "" end,
    UpdateTranslatedString = function(handle, text) texts[handle] = text; writes = writes + 1; return true end,
    GetTranslatedStringKey = function(key) return keys[key] end,
    UpdateTranslatedStringKey = function(key, handle)
        keys[key] = handle; writes = writes + 1; return true
    end,
} }
assert(Label.Ensure(TARGET).text == value.text and writes == 2 and texts.vanilla == "Human")
Label.Ensure(TARGET)
assert(writes == 2, "Shared client/server registration rewrote an existing owned entry")
texts[value.handle] = "Foreign translation"
assert(not pcall(Label.Ensure, TARGET) and writes == 2, "Foreign localization was overwritten")
texts[value.handle] = value.text
keys[value.key] = "foreign"
assert(not pcall(Label.Ensure, TARGET) and writes == 2, "Foreign translated key was overwritten")
keys[value.key] = value.handle

local function tooltip(kind, name, id, inherited)
    local properties = { { Name = "Name", ContentType = { Name = kind } } }
    return { Name = name, GameObject = { EntityUUID = id or TARGET },
        TypeInfo = function()
            if inherited then return { Properties = {}, Base = { Properties = properties } } end
            return { Properties = properties }
        end }
end
for _, inherited in ipairs({ false, true }) do
    local text, evidence = Label.ReadTooltip(tooltip("String", value.text, TARGET, inherited), TARGET)
    assert(text == value.text and evidence.nameVerified and evidence.nameType == "String")
end
local text, evidence = Label.ReadTooltip(tooltip("ls.LocaString", value.handle), TARGET)
assert(text == value.text and evidence.nameHandle == value.handle and evidence.nameVerified,
    "Localized tooltip handle was not resolved through the native repository")
for _, entry in ipairs({ tooltip("String", value.text, OTHER), tooltip("String", "Human"),
    tooltip("String", value.handle), tooltip("Unverified", value.text),
    { Name = value.text, GameObject = { EntityUUID = TARGET } } }) do
    assert(Label.ReadTooltip(entry, TARGET) == nil, "Foreign or unverified label was accepted")
end
Ext.Entity = { Get = function(id)
    if id == TARGET then return { DisplayName = { Name = { Get = function() return value.text end } } } end
end }
assert(Label.ActorText(TARGET) == value.text and Label.ActorText(OTHER) == nil,
    "Actor display name did not use the translated string getter")

print("BG3 harness target label tests passed")
