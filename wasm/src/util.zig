const std = @import("std");

/// Copy a slice into a destination buffer. Returns bytes written.
pub fn copySlice(dst: []u8, src: []const u8) usize {
    if (dst.len < src.len) return 0;
    @memcpy(dst[0..src.len], src);
    return src.len;
}

/// Write an i32 as decimal text into a buffer. Returns bytes written.
pub fn writeInt(dst: []u8, val: i32) usize {
    var buf: [12]u8 = undefined;
    var v = val;
    var len: usize = 0;

    if (v < 0) {
        dst[0] = '-';
        v = -v;
        len = 1;
    }

    if (v == 0) {
        dst[len] = '0';
        return len + 1;
    }

    var digit_count: usize = 0;
    var tmp = v;
    while (tmp > 0) : (tmp = @divTrunc(tmp, 10)) {
        buf[digit_count] = @intCast(@as(u32, @intCast(@rem(tmp, 10))) + '0');
        digit_count += 1;
    }

    var i: usize = 0;
    while (i < digit_count) : (i += 1) {
        dst[len + i] = buf[digit_count - 1 - i];
    }

    return len + digit_count;
}

/// Find the matching closing brace for a '{' at position 0.
/// Correctly handles quoted strings (including escaped quotes).
pub fn findMatchingBrace(json: []const u8) usize {
    var depth: i32 = 0;
    var in_string = false;
    var prev_backslash = false;
    for (json, 0..) |c, i| {
        if (in_string) {
            if (c == '"' and !prev_backslash) {
                in_string = false;
            }
            prev_backslash = (c == '\\' and !prev_backslash);
        } else {
            if (c == '"') in_string = true;
            if (c == '{') depth += 1;
            if (c == '}') {
                depth -= 1;
                if (depth == 0) return i + 1;
            }
        }
    }
    return json.len;
}

/// Extract a string value for a given field name from a JSON object slice.
/// Handles escaped quotes within string values.
pub fn extractStringField(obj: []const u8, field: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i + field.len + 3 < obj.len) : (i += 1) {
        if (obj[i] == '"' and i + 1 + field.len < obj.len and
            std.mem.eql(u8, obj[i + 1 .. i + 1 + field.len], field) and
            obj[i + 1 + field.len] == '"')
        {
            var j = i + 1 + field.len + 1;
            while (j < obj.len and (obj[j] == ':' or obj[j] == ' ')) : (j += 1) {}
            if (j < obj.len and obj[j] == '"') {
                j += 1;
                const start = j;
                while (j < obj.len) {
                    if (obj[j] == '"' and (j == start or obj[j - 1] != '\\')) break;
                    j += 1;
                }
                return obj[start..j];
            }
        }
    }
    return null;
}

/// Extract an integer value for a given field name from a JSON object slice.
/// The field parameter should be the bare field name (without quotes).
/// Returns null for missing fields or JSON null values.
pub fn extractIntField(obj: []const u8, field: []const u8) ?i32 {
    var i: usize = 0;
    while (i + field.len + 3 < obj.len) : (i += 1) {
        if (obj[i] == '"' and i + 1 + field.len < obj.len and
            std.mem.eql(u8, obj[i + 1 .. i + 1 + field.len], field) and
            obj[i + 1 + field.len] == '"')
        {
            var j = i + 1 + field.len + 1;
            while (j < obj.len and (obj[j] == ':' or obj[j] == ' ')) : (j += 1) {}
            if (j >= obj.len) return null;
            if (j + 4 <= obj.len and std.mem.eql(u8, obj[j .. j + 4], "null")) return null;

            var negative = false;
            if (obj[j] == '-') {
                negative = true;
                j += 1;
            }
            var val: i32 = 0;
            while (j < obj.len and obj[j] >= '0' and obj[j] <= '9') : (j += 1) {
                val = val * 10 + @as(i32, @intCast(obj[j] - '0'));
            }
            return if (negative) -val else val;
        }
    }
    return null;
}

/// Extract a string field from a nested JSON object.
/// E.g., extractNestedStringField(obj, "startBinding", "elementId")
pub fn extractNestedStringField(obj: []const u8, outer: []const u8, inner: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i + outer.len + 3 < obj.len) : (i += 1) {
        if (obj[i] == '"' and i + 1 + outer.len < obj.len and
            std.mem.eql(u8, obj[i + 1 .. i + 1 + outer.len], outer) and
            obj[i + 1 + outer.len] == '"')
        {
            var j = i + 1 + outer.len + 1;
            while (j < obj.len and obj[j] != '{') : (j += 1) {}
            if (j >= obj.len) return null;
            const nested_end = findMatchingBrace(obj[j..]) + j;
            return extractStringField(obj[j..nested_end], inner);
        }
    }
    return null;
}
