local EntityIdentity = {}

local UUID_SUFFIX_PATTERN = "(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)$"

local function canonicalString(value)
    local suffix = string.match(value, UUID_SUFFIX_PATTERN)
    if suffix == nil then
        return nil
    end
    return string.lower(suffix)
end

function EntityIdentity.Canonical(value)
    if value == nil then
        return nil
    end

    if type(value) == "string" then
        return canonicalString(value)
    end

    local ok, uuid = pcall(Ext.Entity.HandleToUuid, value)
    if not ok or uuid == nil then
        return nil
    end
    return canonicalString(tostring(uuid))
end

function EntityIdentity.Equals(left, right)
    local canonicalLeft = EntityIdentity.Canonical(left)
    if canonicalLeft == nil then
        return false
    end
    return canonicalLeft == EntityIdentity.Canonical(right)
end

return EntityIdentity
