const std = @import("std");
const util = @import("util.zig");
const font = @import("font.zig");

/// Rasterize Excalidraw elements directly to PNG (no SVG intermediate).
///
/// Input: JSON array of Excalidraw elements
/// Output: PNG bytes
///
/// Approach:
/// 1. Parse elements and compute bounding box
/// 2. Allocate RGBA pixel buffer
/// 3. Rasterize each element (shapes, text, arrows)
/// 4. Encode to PNG (IHDR + IDAT with zlib + IEND)

const MAX_ELEMS = 512;
const MAX_POINTS = 64;
const PADDING: i32 = 40;

/// Maximum canvas dimensions to keep memory usage reasonable in WASM
const MAX_CANVAS_W: u32 = 2400;
const MAX_CANVAS_H: u32 = 1600;

const Point = struct { x: i32, y: i32 };
const ElemType = enum { rectangle, ellipse, diamond, text, line, arrow, unknown };

const Elem = struct {
    elem_type: ElemType,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    fill: [4]u8,
    stroke: [4]u8,
    text_content: []const u8,
    font_size: i32,
    is_dashed: bool,
    stroke_width: i32,
    points: [MAX_POINTS]Point,
    point_count: usize,
};

/// Render Excalidraw elements to PNG bytes.
pub fn renderPng(elements_json: []const u8, out: []u8) !usize {
    var elems: [MAX_ELEMS]Elem = undefined;
    var elem_count: usize = 0;
    parseElements(elements_json, &elems, &elem_count);

    if (elem_count == 0) return 0;

    // Calculate bounding box
    var min_x: i32 = std.math.maxInt(i32);
    var min_y: i32 = std.math.maxInt(i32);
    var max_x: i32 = std.math.minInt(i32);
    var max_y: i32 = std.math.minInt(i32);

    for (elems[0..elem_count]) |e| {
        if (e.x < min_x) min_x = e.x;
        if (e.y < min_y) min_y = e.y;
        if (e.x + e.w > max_x) max_x = e.x + e.w;
        if (e.y + e.h > max_y) max_y = e.y + e.h;
        for (e.points[0..e.point_count]) |pt| {
            const px = e.x + pt.x;
            const py = e.y + pt.y;
            if (px < min_x) min_x = px;
            if (py < min_y) min_y = py;
            if (px > max_x) max_x = px;
            if (py > max_y) max_y = py;
        }
    }

    min_x -= PADDING;
    min_y -= PADDING;
    max_x += PADDING;
    max_y += PADDING;

    var canvas_w: u32 = @intCast(@max(1, max_x - min_x));
    var canvas_h: u32 = @intCast(@max(1, max_y - min_y));

    // Clamp to maximum canvas size
    if (canvas_w > MAX_CANVAS_W) canvas_w = MAX_CANVAS_W;
    if (canvas_h > MAX_CANVAS_H) canvas_h = MAX_CANVAS_H;

    const pixel_count = canvas_w * canvas_h;
    const buf_size = pixel_count * 4;

    // Use static pixel buffer (single-threaded WASM, so this is safe)
    if (buf_size > pixel_buf.len) return 0;

    // Clear to white
    var pi: usize = 0;
    while (pi < buf_size) : (pi += 4) {
        pixel_buf[pi] = 255; // R
        pixel_buf[pi + 1] = 255; // G
        pixel_buf[pi + 2] = 255; // B
        pixel_buf[pi + 3] = 255; // A
    }

    // Rasterize each element
    for (elems[0..elem_count]) |e| {
        switch (e.elem_type) {
            .rectangle => drawRect(&pixel_buf, canvas_w, canvas_h, e.x - min_x, e.y - min_y, e.w, e.h, e.fill, e.stroke, e.stroke_width, e.is_dashed),
            .ellipse => drawEllipse(&pixel_buf, canvas_w, canvas_h, e.x - min_x, e.y - min_y, e.w, e.h, e.fill, e.stroke, e.stroke_width),
            .diamond => drawDiamond(&pixel_buf, canvas_w, canvas_h, e.x - min_x, e.y - min_y, e.w, e.h, e.fill, e.stroke, e.stroke_width),
            .text => drawText(&pixel_buf, canvas_w, canvas_h, e.x - min_x, e.y - min_y, e.w, e.h, e.text_content, e.font_size, e.stroke),
            .line, .arrow => drawPath(&pixel_buf, canvas_w, canvas_h, e.x - min_x, e.y - min_y, e.points[0..e.point_count], e.stroke, e.stroke_width, e.elem_type == .arrow),
            .unknown => {},
        }
    }

    // Encode to PNG
    return encodePng(pixel_buf[0..buf_size], canvas_w, canvas_h, out);
}

// Static pixel buffer (used within renderPng calls — not thread-safe, but WASM is single-threaded)
var pixel_buf: [MAX_CANVAS_W * MAX_CANVAS_H * 4]u8 = undefined;

// ── Shape Rasterizers ──

fn drawRect(
    buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8,
    w: u32,
    h: u32,
    x: i32,
    y: i32,
    rw: i32,
    rh: i32,
    fill: [4]u8,
    stroke: [4]u8,
    sw: i32,
    is_dashed: bool,
) void {
    // Fill interior
    if (!is_dashed and fill[3] > 0) {
        var ry: i32 = y;
        while (ry < y + rh) : (ry += 1) {
            var rx: i32 = x;
            while (rx < x + rw) : (rx += 1) {
                setPixel(buf, w, h, rx, ry, fill);
            }
        }
    }

    // Stroke outline
    drawHLine(buf, w, h, x, y, rw, stroke, sw);
    drawHLine(buf, w, h, x, y + rh - sw, rw, stroke, sw);
    drawVLine(buf, w, h, x, y, rh, stroke, sw);
    drawVLine(buf, w, h, x + rw - sw, y, rh, stroke, sw);
}

fn drawEllipse(
    buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8,
    w: u32,
    h: u32,
    x: i32,
    y: i32,
    ew: i32,
    eh: i32,
    fill: [4]u8,
    stroke: [4]u8,
    sw: i32,
) void {
    const cx = x + @divTrunc(ew, 2);
    const cy = y + @divTrunc(eh, 2);
    const rx = @divTrunc(ew, 2);
    const ry = @divTrunc(eh, 2);

    if (rx <= 0 or ry <= 0) return;

    // Scanline fill + outline using ellipse equation
    var py: i32 = y;
    while (py < y + eh) : (py += 1) {
        const dy = py - cy;
        // x² / rx² + y² / ry² = 1 → x = rx * sqrt(1 - y²/ry²)
        const dy2: i64 = @as(i64, dy) * @as(i64, dy);
        const ry2: i64 = @as(i64, ry) * @as(i64, ry);
        if (dy2 > ry2) continue;

        const inner = ry2 - dy2;
        const rx_i64: i64 = @as(i64, rx);
        const x_extent_sq = @divTrunc(inner * rx_i64 * rx_i64, ry2);
        const x_extent: i32 = @intCast(std.math.sqrt(@as(u64, @intCast(@max(0, x_extent_sq)))));

        // Fill scanline
        if (fill[3] > 0) {
            var px: i32 = cx - x_extent;
            while (px <= cx + x_extent) : (px += 1) {
                setPixel(buf, w, h, px, py, fill);
            }
        }

        // Stroke at edges
        var si: i32 = 0;
        while (si < sw) : (si += 1) {
            setPixel(buf, w, h, cx - x_extent + si, py, stroke);
            setPixel(buf, w, h, cx + x_extent - si, py, stroke);
        }
    }

    // Top and bottom stroke arcs
    var si: i32 = 0;
    while (si < sw) : (si += 1) {
        var px: i32 = cx - @divTrunc(rx, 3);
        while (px <= cx + @divTrunc(rx, 3)) : (px += 1) {
            setPixel(buf, w, h, px, y + si, stroke);
            setPixel(buf, w, h, px, y + eh - 1 - si, stroke);
        }
    }
}

fn drawDiamond(
    buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8,
    w: u32,
    h: u32,
    x: i32,
    y: i32,
    dw: i32,
    dh: i32,
    fill: [4]u8,
    stroke: [4]u8,
    sw: i32,
) void {
    const cx = x + @divTrunc(dw, 2);
    const cy = y + @divTrunc(dh, 2);
    const half_w = @divTrunc(dw, 2);
    const half_h = @divTrunc(dh, 2);

    if (half_w <= 0 or half_h <= 0) return;

    // Scanline fill: for each row, compute the diamond edge intersection
    var py: i32 = y;
    while (py < y + dh) : (py += 1) {
        const dy = if (py < cy) cy - py else py - cy;
        // At distance dy from center, the x-extent is: half_w * (1 - dy/half_h)
        const x_extent = @divTrunc(half_w * (half_h - dy), half_h);
        if (x_extent <= 0) continue;

        // Fill
        if (fill[3] > 0) {
            var px: i32 = cx - x_extent;
            while (px <= cx + x_extent) : (px += 1) {
                setPixel(buf, w, h, px, py, fill);
            }
        }

        // Stroke at edges
        var si: i32 = 0;
        while (si < sw) : (si += 1) {
            setPixel(buf, w, h, cx - x_extent + si, py, stroke);
            setPixel(buf, w, h, cx + x_extent - si, py, stroke);
        }
    }
}

fn drawText(
    buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8,
    w: u32,
    h: u32,
    x: i32,
    y: i32,
    tw: i32,
    th: i32,
    text: []const u8,
    font_size: i32,
    color: [4]u8,
) void {
    if (text.len == 0) return;
    const fs: u32 = @intCast(@max(8, font_size));

    // Count lines (split on literal \n in JSON text)
    var line_count: usize = 1;
    {
        var i: usize = 0;
        while (i + 1 < text.len) : (i += 1) {
            if (text[i] == '\\' and text[i + 1] == 'n') {
                line_count += 1;
                i += 1;
            }
        }
    }

    const scale = if (fs <= font.GLYPH_H) 1 else fs / font.GLYPH_H;
    const char_h: i32 = @intCast(font.GLYPH_H * scale);
    const line_height: i32 = @divTrunc(char_h * 3, 2);
    const total_text_h = line_height * @as(i32, @intCast(line_count));

    // Center vertically
    const start_y = y + @divTrunc(th - total_text_h, 2);

    // Render each line
    var line_idx: usize = 0;
    var text_pos: usize = 0;
    while (text_pos <= text.len) {
        // Find end of current line
        var end = text_pos;
        while (end + 1 < text.len) {
            if (text[end] == '\\' and text[end + 1] == 'n') break;
            end += 1;
        }
        if (end + 1 >= text.len) end = text.len;

        const line_text = text[text_pos..end];
        const text_w = font.measureString(line_text, fs);
        const line_x = x + @divTrunc(tw - @as(i32, @intCast(text_w)), 2);
        const line_y = start_y + line_height * @as(i32, @intCast(line_idx));

        _ = font.drawString(buf, w, h, line_x, line_y, line_text, fs, color);

        line_idx += 1;
        if (end + 1 < text.len and text[end] == '\\' and text[end + 1] == 'n') {
            text_pos = end + 2;
        } else {
            break;
        }
    }
}

fn drawPath(
    buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8,
    w: u32,
    h: u32,
    ox: i32,
    oy: i32,
    points: []const Point,
    color: [4]u8,
    sw: i32,
    is_arrow: bool,
) void {
    if (points.len < 2) return;

    // Draw line segments
    for (0..points.len - 1) |i| {
        const p1x = ox + points[i].x;
        const p1y = oy + points[i].y;
        const p2x = ox + points[i + 1].x;
        const p2y = oy + points[i + 1].y;
        drawLine(buf, w, h, p1x, p1y, p2x, p2y, color, sw);
    }

    // Draw arrowhead at last point
    if (is_arrow and points.len >= 2) {
        const last = points[points.len - 1];
        const prev = points[points.len - 2];
        const tip_x = ox + last.x;
        const tip_y = oy + last.y;
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;

        // Arrow marker: filled triangle pointing in the direction of the line
        const arrow_len: i32 = 12;
        const arrow_w_half: i32 = 7;

        // Normalize direction (approximate using integer math)
        const len_sq = dx * dx + dy * dy;
        if (len_sq > 0) {
            const len: i32 = @intCast(std.math.sqrt(@as(u64, @intCast(@max(0, len_sq)))));
            if (len > 0) {
                // Unit direction scaled by arrow_len
                const ux = @divTrunc(dx * arrow_len, len);
                const uy = @divTrunc(dy * arrow_len, len);
                // Perpendicular
                const px = @divTrunc(-dy * arrow_w_half, len);
                const py = @divTrunc(dx * arrow_w_half, len);

                // Triangle: tip, base-left, base-right
                const bx = tip_x - ux;
                const by = tip_y - uy;
                fillTriangle(buf, w, h, tip_x, tip_y, bx + px, by + py, bx - px, by - py, color);
            }
        }
    }
}

// ── Pixel Drawing Primitives ──

fn setPixel(buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8, w: u32, h: u32, x: i32, y: i32, color: [4]u8) void {
    if (x < 0 or y < 0) return;
    const ux: u32 = @intCast(x);
    const uy: u32 = @intCast(y);
    if (ux >= w or uy >= h) return;
    const offset = (uy * w + ux) * 4;
    buf[offset] = color[0];
    buf[offset + 1] = color[1];
    buf[offset + 2] = color[2];
    buf[offset + 3] = color[3];
}

fn drawHLine(buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8, w: u32, h: u32, x: i32, y: i32, length: i32, color: [4]u8, thickness: i32) void {
    var ty: i32 = 0;
    while (ty < thickness) : (ty += 1) {
        var px: i32 = x;
        while (px < x + length) : (px += 1) {
            setPixel(buf, w, h, px, y + ty, color);
        }
    }
}

fn drawVLine(buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8, w: u32, h: u32, x: i32, y: i32, length: i32, color: [4]u8, thickness: i32) void {
    var tx: i32 = 0;
    while (tx < thickness) : (tx += 1) {
        var py: i32 = y;
        while (py < y + length) : (py += 1) {
            setPixel(buf, w, h, x + tx, py, color);
        }
    }
}

fn drawLine(buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8, w: u32, h: u32, x0: i32, y0: i32, x1: i32, y1: i32, color: [4]u8, thickness: i32) void {
    // Bresenham's line algorithm
    const dx = if (x1 > x0) x1 - x0 else x0 - x1;
    const dy = if (y1 > y0) y1 - y0 else y0 - y1;
    const sx: i32 = if (x0 < x1) 1 else -1;
    const sy: i32 = if (y0 < y1) 1 else -1;
    var err = dx - dy;

    var cx = x0;
    var cy = y0;

    // Limit iterations to prevent infinite loops on degenerate input
    const max_steps: usize = @intCast(@max(dx, dy) * 2 + 1);
    var steps: usize = 0;

    while (steps < max_steps) : (steps += 1) {
        // Draw a square block for thickness
        var tx: i32 = 0;
        while (tx < thickness) : (tx += 1) {
            var ty: i32 = 0;
            while (ty < thickness) : (ty += 1) {
                setPixel(buf, w, h, cx + tx - @divTrunc(thickness, 2), cy + ty - @divTrunc(thickness, 2), color);
            }
        }

        if (cx == x1 and cy == y1) break;

        const e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            cx += sx;
        }
        if (e2 < dx) {
            err += dx;
            cy += sy;
        }
    }
}

fn fillTriangle(buf: *[MAX_CANVAS_W * MAX_CANVAS_H * 4]u8, w: u32, h: u32, x0: i32, y0: i32, x1: i32, y1: i32, x2: i32, y2: i32, color: [4]u8) void {
    // Scanline triangle fill
    const min_y = @max(0, @min(y0, @min(y1, y2)));
    const max_y = @min(@as(i32, @intCast(h)) - 1, @max(y0, @max(y1, y2)));

    var py = min_y;
    while (py <= max_y) : (py += 1) {
        var left: i32 = std.math.maxInt(i32);
        var right: i32 = std.math.minInt(i32);

        edgeIntersect(x0, y0, x1, y1, py, &left, &right);
        edgeIntersect(x1, y1, x2, y2, py, &left, &right);
        edgeIntersect(x2, y2, x0, y0, py, &left, &right);

        if (left <= right) {
            var px = @max(0, left);
            while (px <= @min(@as(i32, @intCast(w)) - 1, right)) : (px += 1) {
                setPixel(buf, w, h, px, py, color);
            }
        }
    }
}

fn edgeIntersect(x0: i32, y0: i32, x1: i32, y1: i32, y: i32, left: *i32, right: *i32) void {
    if ((y0 <= y and y <= y1) or (y1 <= y and y <= y0)) {
        const dy = y1 - y0;
        if (dy == 0) {
            if (x0 < left.*) left.* = x0;
            if (x1 < left.*) left.* = x1;
            if (x0 > right.*) right.* = x0;
            if (x1 > right.*) right.* = x1;
        } else {
            const ix = x0 + @divTrunc((y - y0) * (x1 - x0), dy);
            if (ix < left.*) left.* = ix;
            if (ix > right.*) right.* = ix;
        }
    }
}

// ── PNG Encoder ──

fn encodePng(pixels: []const u8, width: u32, height: u32, out: []u8) usize {
    var pos: usize = 0;

    // PNG signature
    const sig = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
    @memcpy(out[pos .. pos + 8], &sig);
    pos += 8;

    // IHDR chunk
    pos += writeChunk(out[pos..], "IHDR", &ihdrData(width, height));

    // IDAT chunk — filter + compress pixel data
    // Apply None filter (type 0) per row, then compress with std.compress.zlib

    const row_bytes = width * 4;
    const filtered_size = (1 + row_bytes) * height;

    // Use a portion of the pixel_buf after the pixel data as scratch space
    const pixel_end = width * height * 4;
    if (pixel_end + filtered_size > pixel_buf.len) {
        // Not enough scratch space for filtered data
        return 0;
    }

    const filtered = pixel_buf[pixel_end .. pixel_end + filtered_size];

    var row: u32 = 0;
    while (row < height) : (row += 1) {
        const filt_row_start: usize = row * (1 + row_bytes);
        const src_row_start: usize = row * row_bytes;

        filtered[filt_row_start] = 0; // None filter type

        @memcpy(
            filtered[filt_row_start + 1 .. filt_row_start + 1 + row_bytes],
            pixels[src_row_start .. src_row_start + row_bytes],
        );
    }

    // Encode filtered data as zlib stored blocks (no compression, valid format)
    pos += writeZlibStored(filtered, out[pos..]);

    // IEND chunk
    pos += writeChunk(out[pos..], "IEND", &[_]u8{});

    return pos;
}

fn ihdrData(width: u32, height: u32) [13]u8 {
    var data: [13]u8 = undefined;
    writeU32BE(&data, 0, width);
    writeU32BE(&data, 4, height);
    data[8] = 8; // bit depth
    data[9] = 6; // color type: RGBA
    data[10] = 0; // compression
    data[11] = 0; // filter
    data[12] = 0; // interlace
    return data;
}

fn writeU32BE(buf: []u8, offset: usize, val: u32) void {
    buf[offset] = @intCast((val >> 24) & 0xFF);
    buf[offset + 1] = @intCast((val >> 16) & 0xFF);
    buf[offset + 2] = @intCast((val >> 8) & 0xFF);
    buf[offset + 3] = @intCast(val & 0xFF);
}

fn writeChunk(out: []u8, chunk_type: *const [4]u8, data: []const u8) usize {
    return writeChunkFromSlice(out, chunk_type, data);
}

fn writeChunkFromSlice(out: []u8, chunk_type: *const [4]u8, data: []const u8) usize {
    const data_len: u32 = @intCast(data.len);
    var pos: usize = 0;

    // Length
    writeU32BE(out, pos, data_len);
    pos += 4;

    // Type
    @memcpy(out[pos .. pos + 4], chunk_type);
    pos += 4;

    // Data
    if (data.len > 0) {
        @memcpy(out[pos .. pos + data.len], data);
        pos += data.len;
    }

    // CRC over type + data
    var crc = std.hash.Crc32.init();
    crc.update(chunk_type);
    crc.update(data);
    writeU32BE(out, pos, crc.final());
    pos += 4;

    return pos;
}

/// Write filtered pixel data as IDAT chunk(s) using zlib stored (uncompressed) blocks.
/// Produces valid zlib stream: 2-byte header + stored blocks + 4-byte Adler-32.
/// Multiple stored blocks are used when data exceeds 65535 bytes.
fn writeZlibStored(filtered: []const u8, out: []u8) usize {
    var pos: usize = 0;

    // We write the entire IDAT as one chunk. Build the zlib stream directly into out.
    // First, calculate total IDAT size: 2 (zlib header) + stored blocks + 4 (adler32)
    const max_block: usize = 65535;
    const num_blocks = (filtered.len + max_block - 1) / max_block;
    const idat_size = 2 + (num_blocks * 5) + filtered.len + 4;

    if (pos + 12 + idat_size > out.len) return 0; // 4 len + 4 type + data + 4 crc

    // IDAT chunk: length
    writeU32BE(out[pos .. pos + 4], 0, @intCast(idat_size));
    pos += 4;

    // IDAT chunk: type
    @memcpy(out[pos .. pos + 4], "IDAT");
    pos += 4;

    const idat_start = pos;

    // zlib header
    out[pos] = 0x78; // CM=8 (deflate), CINFO=7 (32K window)
    out[pos + 1] = 0x01; // FCHECK=1, no dict, level 0
    pos += 2;

    // Stored blocks
    var remaining = filtered.len;
    var src_pos: usize = 0;
    while (remaining > 0) {
        const block_len = @min(remaining, max_block);
        const is_final: u8 = if (remaining <= max_block) 1 else 0;

        out[pos] = is_final; // BFINAL + BTYPE=00 (stored)
        pos += 1;

        const len16: u16 = @intCast(block_len);
        out[pos] = @intCast(len16 & 0xFF);
        out[pos + 1] = @intCast(len16 >> 8);
        out[pos + 2] = @intCast(~len16 & 0xFF);
        out[pos + 3] = @intCast(~len16 >> 8);
        pos += 4;

        @memcpy(out[pos .. pos + block_len], filtered[src_pos .. src_pos + block_len]);
        pos += block_len;
        src_pos += block_len;
        remaining -= block_len;
    }

    // Adler-32 checksum over the uncompressed (filtered) data
    var adler_a: u32 = 1;
    var adler_b: u32 = 0;
    for (filtered) |byte| {
        adler_a = (adler_a + byte) % 65521;
        adler_b = (adler_b + adler_a) % 65521;
    }
    writeU32BE(out[pos .. pos + 4], 0, (adler_b << 16) | adler_a);
    pos += 4;

    // IDAT chunk: CRC over type + data
    var crc = std.hash.Crc32.init();
    crc.update(out[idat_start - 4 .. pos]); // type bytes + data
    writeU32BE(out[pos .. pos + 4], 0, crc.final());
    pos += 4;

    return pos;
}

// ── Color Parsing ──

fn parseHexColor(hex: []const u8) [4]u8 {
    if (hex.len < 7 or hex[0] != '#') return .{ 0, 0, 0, 255 };

    const r = parseHexByte(hex[1], hex[2]);
    const g = parseHexByte(hex[3], hex[4]);
    const b = parseHexByte(hex[5], hex[6]);
    return .{ r, g, b, 255 };
}

fn parseHexByte(hi: u8, lo: u8) u8 {
    return (hexVal(hi) << 4) | hexVal(lo);
}

fn hexVal(c: u8) u8 {
    if (c >= '0' and c <= '9') return c - '0';
    if (c >= 'a' and c <= 'f') return c - 'a' + 10;
    if (c >= 'A' and c <= 'F') return c - 'A' + 10;
    return 0;
}

// ── Element Parsing ──

fn parseElements(json: []const u8, out_elems: *[MAX_ELEMS]Elem, count: *usize) void {
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
            .fill = parseHexColor(extractStringField(obj, "backgroundColor") orelse "#ffffff"),
            .stroke = parseHexColor(extractStringField(obj, "strokeColor") orelse "#333333"),
            .text_content = &.{},
            .font_size = extractIntField(obj, "fontSize") orelse 16,
            .stroke_width = extractIntField(obj, "strokeWidth") orelse 2,
            .is_dashed = false,
            .points = undefined,
            .point_count = 0,
        };

        // Check for "transparent" backgroundColor
        const bg_str = extractStringField(obj, "backgroundColor") orelse "#ffffff";
        if (std.mem.eql(u8, bg_str, "transparent")) {
            elem.fill = .{ 0, 0, 0, 0 };
        }

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
        } else if (std.mem.eql(u8, type_str, "diamond")) {
            elem.elem_type = .diamond;
        } else if (std.mem.eql(u8, type_str, "text")) {
            elem.elem_type = .text;
            elem.text_content = extractStringField(obj, "text") orelse "";
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

        if (count.* < MAX_ELEMS) {
            out_elems[count.*] = elem;
            count.* += 1;
        }

        pos = obj_end;
    }
}

fn parsePoints(obj: []const u8, out: *[MAX_POINTS]Point) usize {
    const key = "\"points\"";
    const key_pos = std.mem.indexOf(u8, obj, key) orelse return 0;
    var pos = key_pos + key.len;

    while (pos < obj.len and obj[pos] != '[') : (pos += 1) {}
    if (pos >= obj.len) return 0;
    pos += 1;

    var count: usize = 0;
    while (pos < obj.len and count < MAX_POINTS) {
        while (pos < obj.len and (obj[pos] == ' ' or obj[pos] == ',')) : (pos += 1) {}
        if (pos >= obj.len or obj[pos] == ']') break;
        if (obj[pos] != '[') break;
        pos += 1;

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
    if (pos.* < buf.len and buf[pos.*] == '.') {
        pos.* += 1;
        while (pos.* < buf.len and buf[pos.*] >= '0' and buf[pos.*] <= '9') : (pos.* += 1) {}
    }
    return if (negative) -val else val;
}

const findMatchingBrace = util.findMatchingBrace;
const extractStringField = util.extractStringField;
const extractIntField = util.extractIntField;

// ── Tests ──

test "renderPng basic rectangle" {
    const elements =
        \\[{"id":"box1","type":"rectangle","x":10,"y":10,"width":100,"height":50,"backgroundColor":"#d0bfff","strokeColor":"#7048e8","strokeStyle":"solid"}]
    ;
    var out: [65536]u8 = undefined;
    const written = try renderPng(elements, &out);
    try std.testing.expect(written > 8);
    // Check PNG signature
    try std.testing.expectEqual(@as(u8, 0x89), out[0]);
    try std.testing.expectEqual(@as(u8, 0x50), out[1]); // 'P'
    try std.testing.expectEqual(@as(u8, 0x4E), out[2]); // 'N'
    try std.testing.expectEqual(@as(u8, 0x47), out[3]); // 'G'
}

test "parseHexColor" {
    const c = parseHexColor("#ff8800");
    try std.testing.expectEqual(@as(u8, 255), c[0]);
    try std.testing.expectEqual(@as(u8, 0x88), c[1]);
    try std.testing.expectEqual(@as(u8, 0), c[2]);
    try std.testing.expectEqual(@as(u8, 255), c[3]);
}

test "renderPng with text" {
    const elements =
        \\[{"id":"t1","type":"text","x":10,"y":10,"width":100,"height":20,"text":"Hello","fontSize":16,"strokeColor":"#333333"}]
    ;
    var out: [65536]u8 = undefined;
    const written = try renderPng(elements, &out);
    try std.testing.expect(written > 8);
}
