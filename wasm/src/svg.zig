const std = @import("std");

/// Render Excalidraw elements to SVG.
///
/// Input: JSON array of Excalidraw elements
/// Output: SVG string
pub fn renderSvg(elements_json: []const u8, out: []u8) !usize {
    // Parse elements to find bounding box and render
    var elems: [256]Elem = undefined;
    var elem_count: usize = 0;
    parseElements(elements_json, &elems, &elem_count);

    if (elem_count == 0) return 0;

    // Calculate viewBox from element bounding boxes
    var min_x: i32 = std.math.maxInt(i32);
    var min_y: i32 = std.math.maxInt(i32);
    var max_x: i32 = std.math.minInt(i32);
    var max_y: i32 = std.math.minInt(i32);

    for (elems[0..elem_count]) |e| {
        if (e.x < min_x) min_x = e.x;
        if (e.y < min_y) min_y = e.y;
        if (e.x + e.w > max_x) max_x = e.x + e.w;
        if (e.y + e.h > max_y) max_y = e.y + e.h;
    }

    const padding: i32 = 40;
    min_x -= padding;
    min_y -= padding;
    max_x += padding;
    max_y += padding;

    var written: usize = 0;

    // SVG header
    written += copySlice(out[written..], "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"");
    written += writeInt(out[written..], min_x);
    written += copySlice(out[written..], " ");
    written += writeInt(out[written..], min_y);
    written += copySlice(out[written..], " ");
    written += writeInt(out[written..], max_x - min_x);
    written += copySlice(out[written..], " ");
    written += writeInt(out[written..], max_y - min_y);
    written += copySlice(out[written..], "\" style=\"background:#ffffff\">\n");

    // Arrow marker definition
    written += copySlice(out[written..], "<defs><marker id=\"arrowhead\" markerWidth=\"10\" markerHeight=\"7\" refX=\"10\" refY=\"3.5\" orient=\"auto\"><polygon points=\"0 0, 10 3.5, 0 7\" fill=\"#333\"/></marker></defs>\n");

    // Render each element
    for (elems[0..elem_count]) |e| {
        if (e.elem_type == .rectangle) {
            if (e.is_dashed) {
                // Group rectangle
                written += copySlice(out[written..], "<rect x=\"");
                written += writeInt(out[written..], e.x);
                written += copySlice(out[written..], "\" y=\"");
                written += writeInt(out[written..], e.y);
                written += copySlice(out[written..], "\" width=\"");
                written += writeInt(out[written..], e.w);
                written += copySlice(out[written..], "\" height=\"");
                written += writeInt(out[written..], e.h);
                written += copySlice(out[written..], "\" fill=\"none\" stroke=\"#868e96\" stroke-dasharray=\"5,5\" rx=\"8\" opacity=\"0.4\"/>\n");
            } else {
                written += copySlice(out[written..], "<rect x=\"");
                written += writeInt(out[written..], e.x);
                written += copySlice(out[written..], "\" y=\"");
                written += writeInt(out[written..], e.y);
                written += copySlice(out[written..], "\" width=\"");
                written += writeInt(out[written..], e.w);
                written += copySlice(out[written..], "\" height=\"");
                written += writeInt(out[written..], e.h);
                written += copySlice(out[written..], "\" fill=\"");
                written += copySlice(out[written..], e.fill);
                written += copySlice(out[written..], "\" stroke=\"");
                written += copySlice(out[written..], e.stroke);
                written += copySlice(out[written..], "\" stroke-width=\"2\" rx=\"8\"/>\n");
            }
        } else if (e.elem_type == .ellipse) {
            const cx = e.x + @divTrunc(e.w, 2);
            const cy = e.y + @divTrunc(e.h, 2);
            const rx = @divTrunc(e.w, 2);
            const ry = @divTrunc(e.h, 2);
            written += copySlice(out[written..], "<ellipse cx=\"");
            written += writeInt(out[written..], cx);
            written += copySlice(out[written..], "\" cy=\"");
            written += writeInt(out[written..], cy);
            written += copySlice(out[written..], "\" rx=\"");
            written += writeInt(out[written..], rx);
            written += copySlice(out[written..], "\" ry=\"");
            written += writeInt(out[written..], ry);
            written += copySlice(out[written..], "\" fill=\"");
            written += copySlice(out[written..], e.fill);
            written += copySlice(out[written..], "\" stroke=\"");
            written += copySlice(out[written..], e.stroke);
            written += copySlice(out[written..], "\" stroke-width=\"2\"/>\n");
        } else if (e.elem_type == .text) {
            // Center text in parent container
            const tx = e.x;
            const ty = e.y;
            written += copySlice(out[written..], "<text x=\"");
            written += writeInt(out[written..], tx);
            written += copySlice(out[written..], "\" y=\"");
            written += writeInt(out[written..], ty);
            written += copySlice(out[written..], "\" text-anchor=\"middle\" dominant-baseline=\"central\" font-family=\"sans-serif\" font-size=\"");
            written += writeInt(out[written..], e.font_size);
            written += copySlice(out[written..], "\" fill=\"");
            written += copySlice(out[written..], e.stroke);
            written += copySlice(out[written..], "\">");
            written += copySlice(out[written..], e.text_content);
            written += copySlice(out[written..], "</text>\n");
        } else if (e.elem_type == .arrow) {
            written += copySlice(out[written..], "<path d=\"");
            for (e.points[0..e.point_count], 0..) |pt, pi| {
                if (pi == 0) {
                    written += copySlice(out[written..], "M");
                } else {
                    written += copySlice(out[written..], "L");
                }
                written += writeInt(out[written..], e.x + pt.x);
                written += copySlice(out[written..], " ");
                written += writeInt(out[written..], e.y + pt.y);
            }
            written += copySlice(out[written..], "\" fill=\"none\" stroke=\"");
            written += copySlice(out[written..], e.stroke);
            written += copySlice(out[written..], "\" stroke-width=\"2\" marker-end=\"url(#arrowhead)\"");
            if (e.is_dashed) {
                written += copySlice(out[written..], " stroke-dasharray=\"5,5\"");
            }
            written += copySlice(out[written..], "/>\n");
        }
    }

    written += copySlice(out[written..], "</svg>");
    return written;
}

const Point = struct {
    x: i32,
    y: i32,
};

const ElemType = enum { rectangle, ellipse, text, arrow, unknown };

const Elem = struct {
    elem_type: ElemType,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    fill: []const u8,
    stroke: []const u8,
    text_content: []const u8,
    font_size: i32,
    is_dashed: bool,
    points: [8]Point,
    point_count: usize,
};

fn parseElements(json: []const u8, out: *[256]Elem, count: *usize) void {
    var pos: usize = 0;

    while (pos < json.len) : (pos += 1) {
        if (json[pos] != '{') continue;

        const obj_end = findMatchingBrace(json[pos..]) + pos;
        const obj = json[pos..obj_end];

        const type_str = extractStringField(obj, "type") orelse {
            pos = obj_end;
            continue;
        };

        var elem = Elem{
            .elem_type = .unknown,
            .x = extractIntField(obj, "x") orelse 0,
            .y = extractIntField(obj, "y") orelse 0,
            .w = extractIntField(obj, "width") orelse 0,
            .h = extractIntField(obj, "height") orelse 0,
            .fill = extractStringField(obj, "backgroundColor") orelse "#ffffff",
            .stroke = extractStringField(obj, "strokeColor") orelse "#333333",
            .text_content = &.{},
            .font_size = extractIntField(obj, "fontSize") orelse 16,
            .is_dashed = false,
            .points = undefined,
            .point_count = 0,
        };

        if (std.mem.eql(u8, type_str, "rectangle")) {
            elem.elem_type = .rectangle;
            // Check if dashed
            const style = extractStringField(obj, "strokeStyle");
            if (style) |s| {
                if (std.mem.eql(u8, s, "dashed")) {
                    elem.is_dashed = true;
                }
            }
        } else if (std.mem.eql(u8, type_str, "ellipse")) {
            elem.elem_type = .ellipse;
        } else if (std.mem.eql(u8, type_str, "text")) {
            elem.elem_type = .text;
            elem.text_content = extractStringField(obj, "text") orelse "";
        } else if (std.mem.eql(u8, type_str, "arrow")) {
            elem.elem_type = .arrow;
            const style = extractStringField(obj, "strokeStyle");
            if (style) |s| {
                if (std.mem.eql(u8, s, "dashed")) {
                    elem.is_dashed = true;
                }
            }
            // Parse points array
            elem.point_count = parsePoints(obj, &elem.points);
        } else {
            pos = obj_end;
            continue;
        }

        if (count.* < 256) {
            out[count.*] = elem;
            count.* += 1;
        }

        pos = obj_end;
    }
}

fn parsePoints(obj: []const u8, out: *[8]Point) usize {
    // Find "points":[ and parse [[x,y],[x,y],...]
    const key = "\"points\"";
    const key_pos = std.mem.indexOf(u8, obj, key) orelse return 0;
    var pos = key_pos + key.len;

    // Skip to first [
    while (pos < obj.len and obj[pos] != '[') : (pos += 1) {}
    if (pos >= obj.len) return 0;
    pos += 1; // skip outer [

    var count: usize = 0;
    while (pos < obj.len and count < 8) {
        // Skip whitespace
        while (pos < obj.len and (obj[pos] == ' ' or obj[pos] == ',')) : (pos += 1) {}
        if (pos >= obj.len or obj[pos] == ']') break;
        if (obj[pos] != '[') break;
        pos += 1; // skip [

        // Parse x
        const x = parseIntAt(obj, &pos);
        // Skip comma
        while (pos < obj.len and (obj[pos] == ',' or obj[pos] == ' ')) : (pos += 1) {}
        // Parse y
        const y = parseIntAt(obj, &pos);
        // Skip to ]
        while (pos < obj.len and obj[pos] != ']') : (pos += 1) {}
        if (pos < obj.len) pos += 1;

        out[count] = .{ .x = x, .y = y };
        count += 1;
    }

    return count;
}

fn parseIntAt(buf: []const u8, pos: *usize) i32 {
    var negative = false;
    if (pos.* < buf.len and buf[pos.*] == '-') {
        negative = true;
        pos.* += 1;
    }
    var val: i32 = 0;
    while (pos.* < buf.len and buf[pos.*] >= '0' and buf[pos.*] <= '9') {
        val = val * 10 + @as(i32, @intCast(buf[pos.*] - '0'));
        pos.* += 1;
    }
    return if (negative) -val else val;
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

    var ii: usize = 0;
    while (ii < digit_count) : (ii += 1) {
        dst[len + ii] = buf[digit_count - 1 - ii];
    }

    return len + digit_count;
}

test "renderSvg basic" {
    const elements =
        \\[{"id":"box1","type":"rectangle","x":100,"y":100,"width":180,"height":80,"backgroundColor":"#d0bfff","strokeColor":"#7048e8","strokeStyle":"solid"},
        \\{"id":"box1-text","type":"text","x":190,"y":140,"width":160,"height":20,"text":"API","fontSize":16,"strokeColor":"#7048e8"}]
    ;
    var out: [8192]u8 = undefined;
    const written = try renderSvg(elements, &out);
    try std.testing.expect(written > 0);
    const result = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "<svg") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "<rect") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "API") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "</svg>") != null);
}
