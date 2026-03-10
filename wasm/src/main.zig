const std = @import("std");
const build_options = @import("build_options");
const layout = @import("layout.zig");
const arrows = @import("arrows.zig");
const validate_mod = if (build_options.enable_validation) @import("validate.zig") else struct {};
const compress_mod = if (build_options.enable_compression) @import("compress.zig") else struct {};
const svg2png_mod = @import("svg2png.zig");

/// Bump allocator backed by a fixed buffer (no imports needed for WASM).
/// 16MB heap for element data, layout scratch, and SVG→PNG rendering.
var heap_buf: [16 * 1024 * 1024]u8 = undefined;
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
/// Input: nodes JSON + edges JSON + groups JSON. Output: positioned nodes + edge routes JSON.
export fn layoutGraph(
    nodes_ptr: [*]const u8,
    nodes_len: usize,
    edges_ptr: [*]const u8,
    edges_len: usize,
    groups_ptr: [*]const u8,
    groups_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
    opts_ptr: [*]const u8,
    opts_len: usize,
) usize {
    const nodes_slice = nodes_ptr[0..nodes_len];
    const edges_slice = edges_ptr[0..edges_len];
    const groups_slice = groups_ptr[0..groups_len];
    const opts_slice = opts_ptr[0..opts_len];
    const out_slice = out_ptr[0..out_cap];

    return layout.layoutGraph(nodes_slice, edges_slice, groups_slice, opts_slice, out_slice) catch 0;
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
/// Conditionally included via -Denable_validation (default: true).
export fn validate(
    elem_ptr: [*]const u8,
    elem_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    if (!build_options.enable_validation) return 0;
    const elem_slice = elem_ptr[0..elem_len];
    const out_slice = out_ptr[0..out_cap];

    return validate_mod.validate(elem_slice, out_slice) catch 0;
}


/// Compress data using zlib format (matching pako.deflate).
/// Conditionally included via -Denable_compression (default: true).
export fn zlibCompress(
    in_ptr: [*]const u8,
    in_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    if (!build_options.enable_compression) return 0;
    const in_slice = in_ptr[0..in_len];
    const out_slice = out_ptr[0..out_cap];

    return compress_mod.zlibCompress(in_slice, out_slice) catch 0;
}


/// Convert SVG string to PNG bytes.
/// Input: SVG data pointer/length + desired width/height (0 = use SVG intrinsic size).
/// Output: PNG bytes written to out_ptr. Returns byte count, or 0 on failure.
export fn svgToPng(
    svg_ptr: [*]const u8,
    svg_len: usize,
    width: i32,
    height: i32,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return svg2png_mod.svgToPng(svg_ptr, svg_len, width, height, out_ptr, out_cap);
}

test "alloc and reset" {
    resetHeap();
    const ptr = alloc(64);
    try std.testing.expect(ptr != 0);
    resetHeap();
    const ptr2 = alloc(64);
    try std.testing.expectEqual(ptr, ptr2);
}
