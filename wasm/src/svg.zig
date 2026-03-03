const std = @import("std");

/// Render Excalidraw elements to SVG.
///
/// Input: JSON array of Excalidraw elements
/// Output: SVG string
pub fn renderSvg(elements_json: []const u8, out: []u8) !usize {
    // Parse elements to find bounding box and render
    var elems: [512]Elem = undefined;
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
            // Position text at center of its bounding box
            const cx = e.x + @divTrunc(e.w, 2);
            const cy = e.y + @divTrunc(e.h, 2);

            // Count lines by looking for \n (literal backslash-n in JSON)
            const line_count = countJsonNewlines(e.text_content) + 1;
            const line_height = @divTrunc(e.font_size * 3, 2); // fontSize * 1.5

            if (line_count == 1) {
                written += copySlice(out[written..], "<text x=\"");
                written += writeInt(out[written..], cx);
                written += copySlice(out[written..], "\" y=\"");
                written += writeInt(out[written..], cy);
                written += copySlice(out[written..], "\" text-anchor=\"middle\" dominant-baseline=\"central\" font-family=\"sans-serif\" font-size=\"");
                written += writeInt(out[written..], e.font_size);
                written += copySlice(out[written..], "\" fill=\"");
                written += copySlice(out[written..], e.stroke);
                written += copySlice(out[written..], "\">");
                written += writeXmlEscaped(out[written..], e.text_content);
                written += copySlice(out[written..], "</text>\n");
            } else {
                // Multiline: use tspan elements
                const total_height = line_height * @as(i32, @intCast(line_count));
                const start_y = cy - @divTrunc(total_height, 2) + @divTrunc(line_height, 2);

                written += copySlice(out[written..], "<text text-anchor=\"middle\" dominant-baseline=\"central\" font-family=\"sans-serif\" font-size=\"");
                written += writeInt(out[written..], e.font_size);
                written += copySlice(out[written..], "\" fill=\"");
                written += copySlice(out[written..], e.stroke);
                written += copySlice(out[written..], "\">");

                // Split on \n (literal JSON escape) and write tspan elements
                var line_idx: usize = 0;
                var text_pos: usize = 0;
                while (text_pos <= e.text_content.len) {
                    // Find next \n or end
                    var end = text_pos;
                    while (end + 1 < e.text_content.len) {
                        if (e.text_content[end] == '\\' and e.text_content[end + 1] == 'n') break;
                        end += 1;
                    }
                    if (end + 1 >= e.text_content.len) end = e.text_content.len;

                    const line_text = e.text_content[text_pos..end];
                    const line_y = start_y + line_height * @as(i32, @intCast(line_idx));

                    written += copySlice(out[written..], "<tspan x=\"");
                    written += writeInt(out[written..], cx);
                    written += copySlice(out[written..], "\" y=\"");
                    written += writeInt(out[written..], line_y);
                    written += copySlice(out[written..], "\">");
                    written += writeXmlEscaped(out[written..], line_text);
                    written += copySlice(out[written..], "</tspan>");

                    line_idx += 1;
                    // Skip past \n
                    if (end + 1 < e.text_content.len and
                        e.text_content[end] == '\\' and e.text_content[end + 1] == 'n')
                    {
                        text_pos = end + 2;
                    } else {
                        break;
                    }
                }

                written += copySlice(out[written..], "</text>\n");
            }
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
    points: [16]Point,
    point_count: usize,
};

/// Count occurrences of literal \n (JSON escaped newline) in text
fn countJsonNewlines(text: []const u8) usize {
    var count: usize = 0;
    var i: usize = 0;
    while (i + 1 < text.len) : (i += 1) {
        if (text[i] == '\\' and text[i + 1] == 'n') {
            count += 1;
            i += 1; // skip the 'n'
        }
    }
    return count;
}

/// Write XML-escaped text to output buffer
fn writeXmlEscaped(dst: []u8, src: []const u8) usize {
    var written: usize = 0;
    for (src) |c| {
        const replacement: ?[]const u8 = switch (c) {
            '&' => "&amp;",
            '<' => "&lt;",
            '>' => "&gt;",
            '"' => "&quot;",
            else => null,
        };
        if (replacement) |r| {
            if (written + r.len > dst.len) break;
            @memcpy(dst[written .. written + r.len], r);
            written += r.len;
        } else {
            if (written >= dst.len) break;
            dst[written] = c;
            written += 1;
        }
    }
    return written;
}

fn parseElements(json: []const u8, out: *[512]Elem, count: *usize) void {
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
            .x = extractIntField(obj, "\"x\"") orelse 0,
            .y = extractIntField(obj, "\"y\"") orelse 0,
            .w = extractIntField(obj, "\"width\"") orelse 0,
            .h = extractIntField(obj, "\"height\"") orelse 0,
            .fill = extractStringField(obj, "backgroundColor") orelse "#ffffff",
            .stroke = extractStringField(obj, "strokeColor") orelse "#333333",
            .text_content = &.{},
            .font_size = extractIntField(obj, "\"fontSize\"") orelse 16,
            .is_dashed = false,
            .points = undefined,
            .point_count = 0,
        };

        if (std.mem.eql(u8, type_str, "rectangle")) {
            elem.elem_type = .rectangle;
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
            elem.point_count = parsePoints(obj, &elem.points);
        } else {
            pos = obj_end;
            continue;
        }

        if (count.* < 512) {
            out[count.*] = elem;
            count.* += 1;
        }

        pos = obj_end;
    }
}

fn parsePoints(obj: []const u8, out: *[16]Point) usize {
    const key = "\"points\"";
    const key_pos = std.mem.indexOf(u8, obj, key) orelse return 0;
    var pos = key_pos + key.len;

    // Skip to first [
    while (pos < obj.len and obj[pos] != '[') : (pos += 1) {}
    if (pos >= obj.len) return 0;
    pos += 1; // skip outer [

    var count: usize = 0;
    while (pos < obj.len and count < 16) {
        while (pos < obj.len and (obj[pos] == ' ' or obj[pos] == ',')) : (pos += 1) {}
        if (pos >= obj.len or obj[pos] == ']') break;
        if (obj[pos] != '[') break;
        pos += 1; // skip [

        const x = parseIntAt(obj, &pos);
        while (pos < obj.len and (obj[pos] == ',' or obj[pos] == ' ')) : (pos += 1) {}
        const y = parseIntAt(obj, &pos);
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
                // Handle escaped quotes in strings
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

fn extractIntField(obj: []const u8, field_with_quotes: []const u8) ?i32 {
    // field_with_quotes includes the surrounding quotes, e.g. "\"x\""
    const key_pos = std.mem.indexOf(u8, obj, field_with_quotes) orelse return null;
    var j = key_pos + field_with_quotes.len;

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
        \\{"id":"box1-text","type":"text","x":110,"y":130,"width":160,"height":20,"text":"API","fontSize":16,"strokeColor":"#7048e8"}]
    ;
    var out_buf: [8192]u8 = undefined;
    const written = try renderSvg(elements, &out_buf);
    try std.testing.expect(written > 0);
    const result = out_buf[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "<svg") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "<rect") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "API") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "</svg>") != null);
}

test "renderSvg multiline text" {
    const elements =
        \\[{"id":"box1","type":"rectangle","x":100,"y":100,"width":180,"height":80,"backgroundColor":"#d0bfff","strokeColor":"#7048e8","strokeStyle":"solid"},
        \\{"id":"box1-text","type":"text","x":110,"y":130,"width":160,"height":20,"text":"Line 1\\nLine 2","fontSize":16,"strokeColor":"#7048e8"}]
    ;
    var out_buf: [8192]u8 = undefined;
    const written = try renderSvg(elements, &out_buf);
    try std.testing.expect(written > 0);
    const result = out_buf[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "<tspan") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "Line 1") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "Line 2") != null);
}

test "renderSvg xml escaping" {
    const elements =
        \\[{"id":"t1","type":"text","x":0,"y":0,"width":100,"height":20,"text":"A & B <C>","fontSize":16,"strokeColor":"#333"}]
    ;
    var out_buf: [8192]u8 = undefined;
    const written = try renderSvg(elements, &out_buf);
    const result = out_buf[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "&amp;") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "&lt;") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "&gt;") != null);
}
