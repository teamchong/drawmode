const std = @import("std");
const layout = @import("layout.zig");
const arrows = @import("arrows.zig");
const validate_mod = @import("validate.zig");
const svg_mod = @import("svg.zig");
const png_mod = @import("png.zig");

/// Bump allocator backed by a fixed buffer (no imports needed for WASM).
/// 8MB heap: 2400×1600×4 = 15.36MB for pixel buffer (static in png.zig),
/// plus headroom for element data, compression buffers, and layout scratch.
var heap_buf: [8 * 1024 * 1024]u8 = undefined;
var heap_offset: usize = 0;

export fn alloc(size: usize) usize {
    const aligned = std.mem.alignForward(usize, heap_offset, 8);
    if (aligned + size > heap_buf.len) return 0;
    heap_offset = aligned + size;
    return @intFromPtr(&heap_buf[aligned]);
}

export fn dealloc(_: usize, _: usize) void {
    // Bump allocator — no individual dealloc
}

export fn resetHeap() void {
    heap_offset = 0;
}

/// Auto-layout: position nodes in a layered graph layout.
/// Input: nodes JSON + edges JSON. Output: positioned nodes + edge routes JSON.
export fn layoutGraph(
    nodes_ptr: [*]const u8,
    nodes_len: usize,
    edges_ptr: [*]const u8,
    edges_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    const nodes_slice = nodes_ptr[0..nodes_len];
    const edges_slice = edges_ptr[0..edges_len];
    const out_slice = out_ptr[0..out_cap];

    return layout.layoutGraph(nodes_slice, edges_slice, out_slice) catch 0;
}

/// Route arrows: calculate arrow endpoints and elbow points.
export fn routeArrows(
    elem_ptr: [*]const u8,
    elem_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    const elem_slice = elem_ptr[0..elem_len];
    const out_slice = out_ptr[0..out_cap];

    return arrows.routeArrows(elem_slice, out_slice) catch 0;
}

/// Validate Excalidraw elements for structural correctness.
export fn validate(
    elem_ptr: [*]const u8,
    elem_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    const elem_slice = elem_ptr[0..elem_len];
    const out_slice = out_ptr[0..out_cap];

    return validate_mod.validate(elem_slice, out_slice) catch 0;
}

/// Render Excalidraw elements to SVG.
export fn renderSvg(
    elem_ptr: [*]const u8,
    elem_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    const elem_slice = elem_ptr[0..elem_len];
    const out_slice = out_ptr[0..out_cap];

    return svg_mod.renderSvg(elem_slice, out_slice) catch 0;
}

/// Render Excalidraw elements to PNG.
export fn renderPng(
    elem_ptr: [*]const u8,
    elem_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    const elem_slice = elem_ptr[0..elem_len];
    const out_slice = out_ptr[0..out_cap];

    return png_mod.renderPng(elem_slice, out_slice) catch 0;
}

test "alloc and reset" {
    resetHeap();
    const ptr = alloc(64);
    try std.testing.expect(ptr != 0);
    resetHeap();
    const ptr2 = alloc(64);
    try std.testing.expectEqual(ptr, ptr2);
}
