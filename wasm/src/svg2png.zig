const std = @import("std");
const build_options = @import("build_options");

/// C bindings for PlutoSVG + PlutoVG (SVG parsing → PNG rendering).
const c = struct {
    // PlutoSVG
    pub extern fn plutosvg_document_load_from_data(data: [*]const u8, length: c_int, width: f32, height: f32, destroy_func: ?*const anyopaque, closure: ?*anyopaque) ?*anyopaque;
    pub extern fn plutosvg_document_render(document: ?*const anyopaque, id: ?[*:0]const u8, canvas: ?*anyopaque, current_color: ?*const anyopaque, palette_func: ?*const anyopaque, closure: ?*anyopaque) bool;
    pub extern fn plutosvg_document_get_width(document: ?*const anyopaque) f32;
    pub extern fn plutosvg_document_get_height(document: ?*const anyopaque) f32;
    pub extern fn plutosvg_document_destroy(document: ?*anyopaque) void;

    // PlutoVG — surface
    pub extern fn plutovg_surface_create(width: c_int, height: c_int) ?*anyopaque;
    pub extern fn plutovg_surface_write_to_png_stream(surface: ?*const anyopaque, write_func: *const fn (?*anyopaque, [*]const u8, c_int) callconv(.c) void, closure: ?*anyopaque) bool;
    pub extern fn plutovg_surface_destroy(surface: ?*anyopaque) void;

    // PlutoVG — canvas
    pub extern fn plutovg_canvas_create(surface: ?*anyopaque) ?*anyopaque;
    pub extern fn plutovg_canvas_destroy(canvas: ?*anyopaque) void;
    pub extern fn plutovg_canvas_scale(canvas: ?*anyopaque, sx: f32, sy: f32) void;
    pub extern fn plutovg_canvas_add_font_face(canvas: ?*anyopaque, family: [*:0]const u8, bold: bool, italic: bool, face: ?*anyopaque) void;

    // PlutoVG — font face
    pub extern fn plutovg_font_face_load_from_data(data: [*]const u8, length: c_uint, ttcindex: c_int, destroy_func: ?*const anyopaque, closure: ?*anyopaque) ?*anyopaque;
    pub extern fn plutovg_font_face_destroy(face: ?*anyopaque) void;
};

/// Embedded TTF font data (converted from Excalidraw's woff2 at build time).
const virgil_ttf = @embedFile("fonts/Virgil.ttf");
const assistant_ttf = @embedFile("fonts/Assistant-Regular.ttf");

/// State passed to the PNG write callback.
const PngWriteState = struct {
    out_ptr: [*]u8,
    out_cap: usize,
    written: usize,
    overflow: bool,
};

/// Callback for plutovg_surface_write_to_png_stream — appends PNG chunks to output buffer.
fn pngWriteCallback(closure: ?*anyopaque, data: [*]const u8, size: c_int) callconv(.c) void {
    const state: *PngWriteState = @ptrCast(@alignCast(closure));
    const len: usize = @intCast(size);
    if (state.overflow or state.written + len > state.out_cap) {
        state.overflow = true;
        return;
    }
    @memcpy(state.out_ptr[state.written .. state.written + len], data[0..len]);
    state.written += len;
}

/// Convert an SVG string to PNG bytes.
/// Returns the number of PNG bytes written to out_ptr, or 0 on failure.
pub fn svgToPng(
    svg_ptr: [*]const u8,
    svg_len: usize,
    width: c_int,
    height: c_int,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    // Parse SVG document — always load at intrinsic size, then scale if needed.
    const doc = c.plutosvg_document_load_from_data(
        svg_ptr,
        @intCast(svg_len),
        -1,
        -1,
        null,
        null,
    ) orelse return 0;
    defer c.plutosvg_document_destroy(doc);

    // Document's intrinsic dimensions (from SVG width/height or viewBox)
    const doc_w = c.plutosvg_document_get_width(doc);
    const doc_h = c.plutosvg_document_get_height(doc);
    if (doc_w <= 0 or doc_h <= 0) return 0;

    // Target render dimensions: use caller's if provided, else intrinsic
    const render_w: c_int = if (width > 0) width else @intFromFloat(doc_w);
    const render_h: c_int = if (height > 0) height else @intFromFloat(doc_h);
    if (render_w <= 0 or render_h <= 0) return 0;

    // Create surface at target dimensions
    const surface = c.plutovg_surface_create(render_w, render_h) orelse return 0;
    defer c.plutovg_surface_destroy(surface);

    const canvas = c.plutovg_canvas_create(surface) orelse return 0;
    defer c.plutovg_canvas_destroy(canvas);

    // Scale canvas if target differs from intrinsic (e.g., 2x retina)
    const fw: f32 = @floatFromInt(render_w);
    const fh: f32 = @floatFromInt(render_h);
    if (fw != doc_w or fh != doc_h) {
        c.plutovg_canvas_scale(canvas, fw / doc_w, fh / doc_h);
    }

    // Load embedded fonts into the canvas font cache.
    const virgil_face = c.plutovg_font_face_load_from_data(
        virgil_ttf.ptr,
        virgil_ttf.len,
        0,
        null,
        null,
    );
    if (virgil_face) |face| {
        c.plutovg_canvas_add_font_face(canvas, "Virgil", false, false, face);
    }

    const assistant_face = c.plutovg_font_face_load_from_data(
        assistant_ttf.ptr,
        assistant_ttf.len,
        0,
        null,
        null,
    );
    if (assistant_face) |face| {
        c.plutovg_canvas_add_font_face(canvas, "Assistant", false, false, face);
    }

    // Render SVG document onto the canvas (shapes + text)
    const ok = c.plutosvg_document_render(
        doc,
        null,
        canvas,
        null,
        null,
        null,
    );
    if (!ok) return 0;

    // Encode surface as PNG into output buffer via streaming callback
    var state = PngWriteState{
        .out_ptr = out_ptr,
        .out_cap = out_cap,
        .written = 0,
        .overflow = false,
    };

    const png_ok = c.plutovg_surface_write_to_png_stream(surface, &pngWriteCallback, @ptrCast(&state));
    if (!png_ok or state.overflow) return 0;

    return state.written;
}
