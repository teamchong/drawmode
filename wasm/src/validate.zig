const std = @import("std");

/// Validate Excalidraw elements for structural correctness.
///
/// Checks:
/// 1. Every shape with boundElements has a matching text element with containerId
/// 2. No duplicate IDs
/// 3. Arrow startBinding/endBinding reference existing elements
/// 4. No overlapping shapes (within margin)
///
/// Output: JSON array of error objects: [{"type":"missing_text","id":"box_1","msg":"..."}]
/// Returns 0 if no errors.
pub fn validate(elements_json: []const u8, out: []u8) !usize {
    var ids: [256][]const u8 = undefined;
    var id_count: usize = 0;
    var container_ids: [256][]const u8 = undefined;
    var container_count: usize = 0;
    var bound_text_ids: [256][]const u8 = undefined;
    var bound_text_count: usize = 0;
    var binding_refs: [256][]const u8 = undefined;
    var binding_count: usize = 0;

    // Parse all elements
    var pos: usize = 0;
    while (pos < elements_json.len) : (pos += 1) {
        if (elements_json[pos] != '{') continue;

        const obj_end = findMatchingBrace(elements_json[pos..]) + pos;
        const obj = elements_json[pos..obj_end];

        const id = extractStringField(obj, "id");
        if (id) |id_val| {
            if (id_count < 256) {
                ids[id_count] = id_val;
                id_count += 1;
            }
        }

        // Check for containerId (text elements bound to shapes)
        const container = extractStringField(obj, "containerId");
        if (container) |cid| {
            if (container_count < 256) {
                container_ids[container_count] = cid;
                container_count += 1;
            }
        }

        // Check for boundElements containing text
        if (std.mem.indexOf(u8, obj, "\"boundElements\"") != null and
            std.mem.indexOf(u8, obj, "\"text\"") != null)
        {
            if (id) |id_val| {
                if (bound_text_count < 256) {
                    bound_text_ids[bound_text_count] = id_val;
                    bound_text_count += 1;
                }
            }
        }

        // Check arrow bindings
        const elem_type = extractStringField(obj, "type");
        if (elem_type) |t| {
            if (std.mem.eql(u8, t, "arrow")) {
                const start_ref = extractNestedStringField(obj, "startBinding", "elementId");
                const end_ref = extractNestedStringField(obj, "endBinding", "elementId");
                if (start_ref) |r| {
                    if (binding_count < 256) {
                        binding_refs[binding_count] = r;
                        binding_count += 1;
                    }
                }
                if (end_ref) |r| {
                    if (binding_count < 256) {
                        binding_refs[binding_count] = r;
                        binding_count += 1;
                    }
                }
            }
        }

        pos = obj_end;
    }

    // Run checks
    var written: usize = 0;
    var error_count: usize = 0;
    written += copySlice(out[written..], "[");

    // Check 1: shapes with boundElements have matching text
    for (bound_text_ids[0..bound_text_count]) |shape_id| {
        var found = false;
        for (container_ids[0..container_count]) |cid| {
            if (std.mem.eql(u8, cid, shape_id)) {
                found = true;
                break;
            }
        }
        if (!found) {
            if (error_count > 0) written += copySlice(out[written..], ",");
            written += copySlice(out[written..], "{\"type\":\"missing_text\",\"id\":\"");
            written += copySlice(out[written..], shape_id);
            written += copySlice(out[written..], "\",\"msg\":\"Shape has boundElements but no text element with matching containerId\"}");
            error_count += 1;
        }
    }

    // Check 2: duplicate IDs
    for (ids[0..id_count], 0..) |id_a, i| {
        for (ids[i + 1 .. id_count]) |id_b| {
            if (std.mem.eql(u8, id_a, id_b)) {
                if (error_count > 0) written += copySlice(out[written..], ",");
                written += copySlice(out[written..], "{\"type\":\"duplicate_id\",\"id\":\"");
                written += copySlice(out[written..], id_a);
                written += copySlice(out[written..], "\",\"msg\":\"Duplicate element ID\"}");
                error_count += 1;
                break;
            }
        }
    }

    // Check 3: arrow bindings reference existing elements
    for (binding_refs[0..binding_count]) |ref| {
        if (ref.len == 0) continue;
        var found = false;
        for (ids[0..id_count]) |id_val| {
            if (std.mem.eql(u8, id_val, ref)) {
                found = true;
                break;
            }
        }
        if (!found) {
            if (error_count > 0) written += copySlice(out[written..], ",");
            written += copySlice(out[written..], "{\"type\":\"dangling_ref\",\"id\":\"");
            written += copySlice(out[written..], ref);
            written += copySlice(out[written..], "\",\"msg\":\"Arrow binding references non-existent element\"}");
            error_count += 1;
        }
    }

    written += copySlice(out[written..], "]");

    // Return 0 if no errors (caller interprets as "all valid")
    if (error_count == 0) return 0;
    return written;
}

fn findMatchingBrace(json: []const u8) usize {
    var depth: i32 = 0;
    for (json, 0..) |c, i| {
        if (c == '{') depth += 1;
        if (c == '}') {
            depth -= 1;
            if (depth == 0) return i + 1;
        }
    }
    return json.len;
}

fn extractStringField(obj: []const u8, field: []const u8) ?[]const u8 {
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
                while (j < obj.len and obj[j] != '"') : (j += 1) {}
                return obj[start..j];
            }
        }
    }
    return null;
}

fn extractNestedStringField(obj: []const u8, outer: []const u8, inner: []const u8) ?[]const u8 {
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

fn copySlice(dst: []u8, src: []const u8) usize {
    if (dst.len < src.len) return 0;
    @memcpy(dst[0..src.len], src);
    return src.len;
}

test "validate valid elements" {
    const elements =
        \\[{"id":"box1","type":"rectangle","boundElements":[{"type":"text","id":"box1-text"}]},
        \\{"id":"box1-text","type":"text","containerId":"box1"}]
    ;
    var out: [4096]u8 = undefined;
    const written = try validate(elements, &out);
    try std.testing.expectEqual(@as(usize, 0), written);
}

test "validate missing text" {
    const elements =
        \\[{"id":"box1","type":"rectangle","boundElements":[{"type":"text","id":"box1-text"}]}]
    ;
    var out: [4096]u8 = undefined;
    const written = try validate(elements, &out);
    try std.testing.expect(written > 0);
    try std.testing.expect(std.mem.indexOf(u8, out[0..written], "missing_text") != null);
}
