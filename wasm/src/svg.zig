const std = @import("std");
const util = @import("util.zig");

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
        // Expand bounds for arrow/line points
        for (e.points[0..e.point_count]) |pt| {
            const px = e.x + pt.x;
            const py = e.y + pt.y;
            if (px < min_x) min_x = px;
            if (py < min_y) min_y = py;
            if (px > max_x) max_x = px;
            if (py > max_y) max_y = py;
        }
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
                written += copySlice(out[written..], "\" fill=\"none\" stroke=\"#868e96\" stroke-width=\"");
                written += writeInt(out[written..], e.stroke_width);
                written += copySlice(out[written..], "\" stroke-dasharray=\"5,5\" rx=\"8\" opacity=\"0.4\"/>\n");
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
                written += writeXmlEscaped(out[written..], e.fill);
                written += copySlice(out[written..], "\" stroke=\"");
                written += writeXmlEscaped(out[written..], e.stroke);
                written += copySlice(out[written..], "\" stroke-width=\"");
                written += writeInt(out[written..], e.stroke_width);
                written += copySlice(out[written..], "\" rx=\"8\"/>\n");
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
            written += writeXmlEscaped(out[written..], e.fill);
            written += copySlice(out[written..], "\" stroke=\"");
            written += writeXmlEscaped(out[written..], e.stroke);
            written += copySlice(out[written..], "\" stroke-width=\"");
            written += writeInt(out[written..], e.stroke_width);
            written += copySlice(out[written..], "\"/>\n");
        } else if (e.elem_type == .diamond) {
            const cx = e.x + @divTrunc(e.w, 2);
            const cy = e.y + @divTrunc(e.h, 2);
            written += copySlice(out[written..], "<polygon points=\"");
            written += writeInt(out[written..], cx);
            written += copySlice(out[written..], ",");
            written += writeInt(out[written..], e.y);
            written += copySlice(out[written..], " ");
            written += writeInt(out[written..], e.x + e.w);
            written += copySlice(out[written..], ",");
            written += writeInt(out[written..], cy);
            written += copySlice(out[written..], " ");
            written += writeInt(out[written..], cx);
            written += copySlice(out[written..], ",");
            written += writeInt(out[written..], e.y + e.h);
            written += copySlice(out[written..], " ");
            written += writeInt(out[written..], e.x);
            written += copySlice(out[written..], ",");
            written += writeInt(out[written..], cy);
            written += copySlice(out[written..], "\" fill=\"");
            written += writeXmlEscaped(out[written..], e.fill);
            written += copySlice(out[written..], "\" stroke=\"");
            written += writeXmlEscaped(out[written..], e.stroke);
            written += copySlice(out[written..], "\" stroke-width=\"");
            written += writeInt(out[written..], e.stroke_width);
            written += copySlice(out[written..], "\"/>\n");
        } else if (e.elem_type == .frame) {
            written += copySlice(out[written..], "<rect x=\"");
            written += writeInt(out[written..], e.x);
            written += copySlice(out[written..], "\" y=\"");
            written += writeInt(out[written..], e.y);
            written += copySlice(out[written..], "\" width=\"");
            written += writeInt(out[written..], e.w);
            written += copySlice(out[written..], "\" height=\"");
            written += writeInt(out[written..], e.h);
            written += copySlice(out[written..], "\" fill=\"none\" stroke=\"#868e96\" stroke-width=\"2\" stroke-dasharray=\"5,5\" rx=\"4\"/>\n");
            if (e.text_content.len > 0) {
                written += copySlice(out[written..], "<text x=\"");
                written += writeInt(out[written..], e.x + 8);
                written += copySlice(out[written..], "\" y=\"");
                written += writeInt(out[written..], e.y + 14);
                written += copySlice(out[written..], "\" font-family=\"sans-serif\" font-size=\"12\" fill=\"#868e96\">");
                written += writeXmlEscaped(out[written..], e.text_content);
                written += copySlice(out[written..], "</text>\n");
            }
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
                written += writeXmlEscaped(out[written..], e.stroke);
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
                written += writeXmlEscaped(out[written..], e.stroke);
                written += copySlice(out[written..], "\">");

                // Split on \n (literal JSON escape) and write tspan elements
                var line_idx: usize = 0;
                var text_pos: usize = 0;
                while (text_pos < e.text_content.len) {
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
        } else if (e.elem_type == .line or e.elem_type == .arrow) {
            written += renderPath(out[written..], e);
        }

        // Overflow guard: if buffer is nearly full, bail out so caller can fall back
        if (written + 256 > out.len) return 0;
    }

    written += copySlice(out[written..], "</svg>");
    return written;
}

/// Render a line or arrow path element to SVG.
fn renderPath(dst: []u8, e: Elem) usize {
    var written: usize = 0;
    written += copySlice(dst[written..], "<path d=\"");
    for (e.points[0..e.point_count], 0..) |pt, pi| {
        if (pi == 0) {
            written += copySlice(dst[written..], "M");
        } else {
            written += copySlice(dst[written..], "L");
        }
        written += writeInt(dst[written..], e.x + pt.x);
        written += copySlice(dst[written..], " ");
        written += writeInt(dst[written..], e.y + pt.y);
    }
    written += copySlice(dst[written..], "\" fill=\"none\" stroke=\"");
    written += writeXmlEscaped(dst[written..], e.stroke);
    written += copySlice(dst[written..], "\" stroke-width=\"");
    written += writeInt(dst[written..], e.stroke_width);
    written += copySlice(dst[written..], "\"");
    if (e.elem_type == .arrow) {
        written += copySlice(dst[written..], " marker-end=\"url(#arrowhead)\"");
    }
    if (e.is_dashed) {
        written += copySlice(dst[written..], " stroke-dasharray=\"5,5\"");
    }
    written += copySlice(dst[written..], "/>\n");
    return written;
}

const Point = struct {
    x: i32,
    y: i32,
};

const ElemType = enum { rectangle, ellipse, diamond, frame, text, line, arrow, unknown };

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
    stroke_width: i32,
    points: [64]Point,
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
            .x = extractIntField(obj, "x") orelse 0,
            .y = extractIntField(obj, "y") orelse 0,
            .w = extractIntField(obj, "width") orelse 0,
            .h = extractIntField(obj, "height") orelse 0,
            .fill = extractStringField(obj, "backgroundColor") orelse "#ffffff",
            .stroke = extractStringField(obj, "strokeColor") orelse "#333333",
            .text_content = &.{},
            .font_size = extractIntField(obj, "fontSize") orelse 16,
            .stroke_width = extractIntField(obj, "strokeWidth") orelse 2,
            .is_dashed = false,
            .points = undefined,
            .point_count = 0,
        };

        // Parse strokeStyle once for all element types
        const style = extractStringField(obj, "strokeStyle");
        if (style) |s| {
            if (std.mem.eql(u8, s, "dashed")) {
                elem.is_dashed = true;
            }
        }

        if (std.mem.eql(u8, type_str, "rectangle")) {
            elem.elem_type = .rectangle;
        } else if (std.mem.eql(u8, type_str, "ellipse")) {
            elem.elem_type = .ellipse;
        } else if (std.mem.eql(u8, type_str, "text")) {
            elem.elem_type = .text;
            elem.text_content = extractStringField(obj, "text") orelse "";
        } else if (std.mem.eql(u8, type_str, "diamond")) {
            elem.elem_type = .diamond;
        } else if (std.mem.eql(u8, type_str, "frame")) {
            elem.elem_type = .frame;
            elem.text_content = extractStringField(obj, "name") orelse "";
        } else if (std.mem.eql(u8, type_str, "line")) {
            elem.elem_type = .line;
            elem.point_count = parsePoints(obj, &elem.points);
        } else if (std.mem.eql(u8, type_str, "arrow")) {
            elem.elem_type = .arrow;
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

fn parsePoints(obj: []const u8, out: *[64]Point) usize {
    const key = "\"points\"";
    const key_pos = std.mem.indexOf(u8, obj, key) orelse return 0;
    var pos = key_pos + key.len;

    // Skip to first [
    while (pos < obj.len and obj[pos] != '[') : (pos += 1) {}
    if (pos >= obj.len) return 0;
    pos += 1; // skip outer [

    var count: usize = 0;
    while (pos < obj.len and count < 64) {
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
        val = val *| 10 +| @as(i32, @intCast(buf[pos.*] - '0'));
        pos.* += 1;
    }
    // Skip decimal portion for float values (e.g., 100.5 → 100)
    if (pos.* < buf.len and buf[pos.*] == '.') {
        pos.* += 1;
        while (pos.* < buf.len and buf[pos.*] >= '0' and buf[pos.*] <= '9') : (pos.* += 1) {}
    }
    return if (negative) -val else val;
}

const findMatchingBrace = util.findMatchingBrace;
const extractStringField = util.extractStringField;
const extractIntField = util.extractIntField;
const copySlice = util.copySlice;
const writeInt = util.writeInt;

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

test "renderSvg diamond" {
    const elements =
        \\[{"id":"d1","type":"diamond","x":100,"y":100,"width":120,"height":80,"backgroundColor":"#d0bfff","strokeColor":"#7048e8","strokeWidth":2}]
    ;
    var out_buf: [8192]u8 = undefined;
    const written = try renderSvg(elements, &out_buf);
    try std.testing.expect(written > 0);
    const result = out_buf[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "<polygon") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "160,100") != null); // top: cx,y
    try std.testing.expect(std.mem.indexOf(u8, result, "220,140") != null); // right: x+w,cy
}

test "renderSvg frame" {
    const elements =
        \\[{"id":"f1","type":"frame","x":50,"y":50,"width":300,"height":200,"name":"My Frame","strokeColor":"#bbb","strokeWidth":1}]
    ;
    var out_buf: [8192]u8 = undefined;
    const written = try renderSvg(elements, &out_buf);
    try std.testing.expect(written > 0);
    const result = out_buf[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "stroke-dasharray") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "My Frame") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "#868e96") != null);
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
