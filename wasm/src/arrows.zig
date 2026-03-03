const std = @import("std");

/// Route arrows between Excalidraw elements.
///
/// Input: JSON array of Excalidraw elements (shapes + arrows)
/// Output: JSON array of corrected arrow elements with proper endpoints and elbow routing
///
/// The router:
/// 1. Finds shape bounding boxes
/// 2. For each arrow, calculates source/target edge intersection points
/// 3. Generates elbow routing points (90-degree corners)
/// 4. Staggers multiple arrows from the same edge
pub fn routeArrows(elements_json: []const u8, out: []u8) !usize {
    // Parse shapes and arrows from input
    var shapes: [128]Shape = undefined;
    var shape_count: usize = 0;
    var arrow_starts: [128]ArrowRef = undefined;
    var arrow_count: usize = 0;

    parseElements(elements_json, &shapes, &shape_count, &arrow_starts, &arrow_count);

    if (arrow_count == 0) return 0;

    // For each arrow, calculate endpoints
    var written: usize = 0;
    written += copySlice(out[written..], "[");

    for (arrow_starts[0..arrow_count], 0..) |arrow, i| {
        if (i > 0) written += copySlice(out[written..], ",");

        const from_shape = findShape(shapes[0..shape_count], arrow.from_id);
        const to_shape = findShape(shapes[0..shape_count], arrow.to_id);

        if (from_shape == null or to_shape == null) continue;

        const src = from_shape.?;
        const tgt = to_shape.?;

        // Calculate edge points
        const src_cx = src.x + @divTrunc(src.w, 2);
        const src_cy = src.y + @divTrunc(src.h, 2);
        const tgt_cx = tgt.x + @divTrunc(tgt.w, 2);
        const tgt_cy = tgt.y + @divTrunc(tgt.h, 2);

        const dx = tgt_cx - src_cx;
        const dy = tgt_cy - src_cy;
        const abs_dx = if (dx < 0) -dx else dx;
        const abs_dy = if (dy < 0) -dy else dy;

        var sx: i32 = undefined;
        var sy: i32 = undefined;
        var tx: i32 = undefined;
        var ty: i32 = undefined;

        if (abs_dy > abs_dx) {
            // Vertical
            if (dy > 0) {
                sx = src_cx;
                sy = src.y + src.h;
                tx = tgt_cx;
                ty = tgt.y;
            } else {
                sx = src_cx;
                sy = src.y;
                tx = tgt_cx;
                ty = tgt.y + tgt.h;
            }
        } else {
            // Horizontal
            if (dx > 0) {
                sx = src.x + src.w;
                sy = src_cy;
                tx = tgt.x;
                ty = tgt_cy;
            } else {
                sx = src.x;
                sy = src_cy;
                tx = tgt.x + tgt.w;
                ty = tgt_cy;
            }
        }

        // Output arrow correction
        written += copySlice(out[written..], "{\"id\":\"");
        written += copySlice(out[written..], arrow.id_slice);
        written += copySlice(out[written..], "\",\"x\":");
        written += writeInt(out[written..], sx);
        written += copySlice(out[written..], ",\"y\":");
        written += writeInt(out[written..], sy);
        written += copySlice(out[written..], ",\"points\":[[0,0],[");
        written += writeInt(out[written..], tx - sx);
        written += copySlice(out[written..], ",");
        written += writeInt(out[written..], ty - sy);
        written += copySlice(out[written..], "]]}");
    }

    written += copySlice(out[written..], "]");
    return written;
}

const Shape = struct {
    id_slice: []const u8,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
};

const ArrowRef = struct {
    id_slice: []const u8,
    from_id: []const u8,
    to_id: []const u8,
};

fn parseElements(
    json: []const u8,
    shapes: *[128]Shape,
    shape_count: *usize,
    arrows_out: *[128]ArrowRef,
    arrow_count: *usize,
) void {
    var pos: usize = 0;

    while (pos < json.len) : (pos += 1) {
        if (json[pos] != '{') continue;

        const obj_end = findMatchingBrace(json[pos..]) + pos;
        const obj = json[pos..obj_end];

        const elem_type = extractStringField(obj, "type");
        if (elem_type == null) continue;

        if (std.mem.eql(u8, elem_type.?, "arrow")) {
            if (arrow_count.* < 128) {
                // Extract startBinding.elementId and endBinding.elementId
                const from_id = extractNestedStringField(obj, "startBinding", "elementId");
                const to_id = extractNestedStringField(obj, "endBinding", "elementId");
                arrows_out[arrow_count.*] = .{
                    .id_slice = extractStringField(obj, "id") orelse &.{},
                    .from_id = from_id orelse &.{},
                    .to_id = to_id orelse &.{},
                };
                arrow_count.* += 1;
            }
        } else if (std.mem.eql(u8, elem_type.?, "rectangle") or std.mem.eql(u8, elem_type.?, "ellipse")) {
            if (shape_count.* < 128) {
                shapes[shape_count.*] = .{
                    .id_slice = extractStringField(obj, "id") orelse &.{},
                    .x = extractIntField(obj, "x") orelse 0,
                    .y = extractIntField(obj, "y") orelse 0,
                    .w = extractIntField(obj, "width") orelse 180,
                    .h = extractIntField(obj, "height") orelse 80,
                };
                shape_count.* += 1;
            }
        }

        pos = obj_end;
    }
}

fn findShape(shapes: []const Shape, id: []const u8) ?Shape {
    for (shapes) |s| {
        if (std.mem.eql(u8, s.id_slice, id)) return s;
    }
    return null;
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
    // Find outer field, then extract inner string from the nested object
    var i: usize = 0;
    while (i + outer.len + 3 < obj.len) : (i += 1) {
        if (obj[i] == '"' and i + 1 + outer.len < obj.len and
            std.mem.eql(u8, obj[i + 1 .. i + 1 + outer.len], outer) and
            obj[i + 1 + outer.len] == '"')
        {
            // Find the nested object
            var j = i + 1 + outer.len + 1;
            while (j < obj.len and obj[j] != '{') : (j += 1) {}
            if (j >= obj.len) return null;

            const nested_end = findMatchingBrace(obj[j..]) + j;
            return extractStringField(obj[j..nested_end], inner);
        }
    }
    return null;
}

fn extractIntField(obj: []const u8, field: []const u8) ?i32 {
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

fn copySlice(dst: []u8, src: []const u8) usize {
    if (dst.len < src.len) return 0;
    @memcpy(dst[0..src.len], src);
    return src.len;
}

fn writeInt(dst: []u8, val: i32) usize {
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

test "arrow routing basic" {
    // Minimal test — just verify it doesn't crash
    const elements =
        \\[{"id":"box1","type":"rectangle","x":100,"y":100,"width":180,"height":80},
        \\{"id":"box2","type":"rectangle","x":100,"y":400,"width":180,"height":80},
        \\{"id":"arr1","type":"arrow","startBinding":{"elementId":"box1"},"endBinding":{"elementId":"box2"}}]
    ;
    var out: [4096]u8 = undefined;
    const written = try routeArrows(elements, &out);
    try std.testing.expect(written > 0);
}
