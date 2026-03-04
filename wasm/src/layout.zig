const std = @import("std");
const util = @import("util.zig");

/// Graphviz C FFI — calls the statically-linked Graphviz dot layout engine
/// via gviz_bridge.c (which wraps the Graphviz C API in bitfield-free types).
///
/// Input JSON (nodes):
///   [{"id":"box_1","width":180,"height":80,"row":0,"col":1}, ...]
/// Input JSON (edges):
///   [{"from":"box_1","to":"box_2"}, ...]
/// Output JSON:
///   {"nodes":[{"id":"box_1","x":340,"y":100},...],
///    "edges":[{"from":"box_1","to":"box_2","points":[[x,y],[x,y],...]},...]}
pub fn layoutGraph(nodes_json: []const u8, edges_json: []const u8, out: []u8) !usize {
    var nodes: [MAX_NODES]Node = undefined;
    var node_count: usize = 0;
    node_count = parseNodes(nodes_json, &nodes) catch return 0;

    var edges: [MAX_EDGES]Edge = undefined;
    var edge_count: usize = 0;
    edge_count = parseEdges(edges_json, &edges) catch return 0;

    // Build DOT source string
    var dot_buf: [DOT_BUF_SIZE]u8 = undefined;
    const dot_len = buildDotString(&dot_buf, &nodes, node_count, &edges, edge_count);
    if (dot_len == 0 or dot_len >= DOT_BUF_SIZE) return 0;
    dot_buf[dot_len] = 0; // null-terminate for C

    // Parse DOT string into Graphviz graph
    const graph = c.gviz_parse_dot(&dot_buf) orelse return 0;

    // Create GVC context with dot_layout plugin
    const gvc = c.gviz_context_new() orelse return 0;

    // Run dot layout
    if (c.gviz_layout(gvc, graph) != 0) {
        c.gviz_graph_close(graph);
        c.gviz_context_free(gvc);
        return 0;
    }

    // Extract positions and write JSON output
    const result = writeGraphvizOutput(out, graph, gvc, &nodes, node_count, &edges, edge_count);

    // Cleanup
    c.gviz_free_layout(gvc, graph);
    c.gviz_graph_close(graph);
    c.gviz_context_free(gvc);

    return result;
}

// ── Graphviz C bridge FFI (from gviz_bridge.c) ──
// Only linked when targeting WASM (Graphviz C is compiled for wasm32-wasi only).
// Native test builds use parsing and DOT-building but not the layout C FFI.

const builtin = @import("builtin");
const is_wasm = builtin.cpu.arch == .wasm32;

const GvizPoint = extern struct {
    x: f64,
    y: f64,
};

const GvizSpline = extern struct {
    point_count: usize,
    points: [*]const GvizPoint,
    has_start_point: c_int,
    start_point: GvizPoint,
    has_end_point: c_int,
    end_point: GvizPoint,
};

const GvizBbox = extern struct {
    ll_x: f64,
    ll_y: f64,
    ur_x: f64,
    ur_y: f64,
};

// Graphviz C bridge: real extern declarations for WASM, no-op shims for native tests
const c = if (is_wasm) struct {
    extern fn gviz_context_new() ?*anyopaque;
    extern fn gviz_context_free(ctx: ?*anyopaque) void;
    extern fn gviz_parse_dot(dot: [*]const u8) ?*anyopaque;
    extern fn gviz_graph_close(g: ?*anyopaque) void;
    extern fn gviz_layout(ctx: ?*anyopaque, g: ?*anyopaque) c_int;
    extern fn gviz_free_layout(ctx: ?*anyopaque, g: ?*anyopaque) void;
    extern fn gviz_first_node(g: ?*anyopaque) ?*anyopaque;
    extern fn gviz_next_node(g: ?*anyopaque, n: ?*anyopaque) ?*anyopaque;
    extern fn gviz_node_name(n: ?*anyopaque) ?[*:0]const u8;
    extern fn gviz_node_coord(n: ?*anyopaque, x: *f64, y: *f64) void;
    extern fn gviz_first_out_edge(g: ?*anyopaque, n: ?*anyopaque) ?*anyopaque;
    extern fn gviz_next_out_edge(g: ?*anyopaque, e: ?*anyopaque) ?*anyopaque;
    extern fn gviz_edge_head(e: ?*anyopaque) ?*anyopaque;
    extern fn gviz_edge_tail(e: ?*anyopaque) ?*anyopaque;
    extern fn gviz_edge_spline(e: ?*anyopaque, out: *GvizSpline) c_int;
    extern fn gviz_graph_bbox(g: ?*anyopaque) GvizBbox;
} else struct {
    fn gviz_context_new() ?*anyopaque { return null; }
    fn gviz_context_free(_: ?*anyopaque) void {}
    fn gviz_parse_dot(_: [*]const u8) ?*anyopaque { return null; }
    fn gviz_graph_close(_: ?*anyopaque) void {}
    fn gviz_layout(_: ?*anyopaque, _: ?*anyopaque) c_int { return -1; }
    fn gviz_free_layout(_: ?*anyopaque, _: ?*anyopaque) void {}
    fn gviz_first_node(_: ?*anyopaque) ?*anyopaque { return null; }
    fn gviz_next_node(_: ?*anyopaque, _: ?*anyopaque) ?*anyopaque { return null; }
    fn gviz_node_name(_: ?*anyopaque) ?[*:0]const u8 { return null; }
    fn gviz_node_coord(_: ?*anyopaque, _: *f64, _: *f64) void {}
    fn gviz_first_out_edge(_: ?*anyopaque, _: ?*anyopaque) ?*anyopaque { return null; }
    fn gviz_next_out_edge(_: ?*anyopaque, _: ?*anyopaque) ?*anyopaque { return null; }
    fn gviz_edge_head(_: ?*anyopaque) ?*anyopaque { return null; }
    fn gviz_edge_tail(_: ?*anyopaque) ?*anyopaque { return null; }
    fn gviz_edge_spline(_: ?*anyopaque, _: *GvizSpline) c_int { return 0; }
    fn gviz_graph_bbox(_: ?*anyopaque) GvizBbox { return .{ .ll_x = 0, .ll_y = 0, .ur_x = 0, .ur_y = 0 }; }
};

// ── Constants ──

const MAX_NODES = 256;
const MAX_EDGES = 512;
const DOT_BUF_SIZE = 64 * 1024;

const Node = struct {
    id_slice: []const u8,
    width: i32,
    height: i32,
    row: ?i32,
    col: ?i32,
};

const Edge = struct {
    from_slice: []const u8,
    to_slice: []const u8,
};

// ── DOT String Builder ──

fn buildDotString(buf: *[DOT_BUF_SIZE]u8, nodes: *[MAX_NODES]Node, node_count: usize, edges: *[MAX_EDGES]Edge, edge_count: usize) usize {
    var w: usize = 0;

    w += copySlice(buf[w..], "digraph G {\n");
    w += copySlice(buf[w..], "  rankdir=TB;\n");
    w += copySlice(buf[w..], "  splines=ortho;\n");
    w += copySlice(buf[w..], "  nodesep=0.5;\n");
    w += copySlice(buf[w..], "  ranksep=1.0;\n");

    // Declare nodes with size attributes (Graphviz uses inches, 1 inch = 72 pts)
    for (nodes[0..node_count]) |n| {
        if (w + 256 >= DOT_BUF_SIZE) break;
        w += copySlice(buf[w..], "  \"");
        w += copySlice(buf[w..], n.id_slice);
        w += copySlice(buf[w..], "\" [width=");
        w += writeFloat(buf[w..], @as(f64, @floatFromInt(n.width)) / 72.0);
        w += copySlice(buf[w..], ", height=");
        w += writeFloat(buf[w..], @as(f64, @floatFromInt(n.height)) / 72.0);
        w += copySlice(buf[w..], ", fixedsize=true];\n");
    }

    // Group nodes with same row using rank=same
    var max_row: i32 = -1;
    for (nodes[0..node_count]) |n| {
        if (n.row) |r| {
            if (r > max_row) max_row = r;
        }
    }
    if (max_row >= 0) {
        var row: i32 = 0;
        while (row <= max_row) : (row += 1) {
            var has_nodes = false;
            for (nodes[0..node_count]) |n| {
                if (n.row != null and n.row.? == row) {
                    has_nodes = true;
                    break;
                }
            }
            if (!has_nodes) continue;
            if (w + 256 >= DOT_BUF_SIZE) break;
            w += copySlice(buf[w..], "  { rank=same; ");
            for (nodes[0..node_count]) |n| {
                if (n.row != null and n.row.? == row) {
                    w += copySlice(buf[w..], "\"");
                    w += copySlice(buf[w..], n.id_slice);
                    w += copySlice(buf[w..], "\"; ");
                }
            }
            w += copySlice(buf[w..], "}\n");
        }
    }

    // Declare edges
    for (edges[0..edge_count]) |e| {
        if (w + 256 >= DOT_BUF_SIZE) break;
        w += copySlice(buf[w..], "  \"");
        w += copySlice(buf[w..], e.from_slice);
        w += copySlice(buf[w..], "\" -> \"");
        w += copySlice(buf[w..], e.to_slice);
        w += copySlice(buf[w..], "\";\n");
    }

    w += copySlice(buf[w..], "}\n");
    return w;
}

// ── Output: Extract Graphviz Layout Results ──

fn writeGraphvizOutput(out: []u8, graph: *anyopaque, _: *anyopaque, nodes: *[MAX_NODES]Node, node_count: usize, edges: *[MAX_EDGES]Edge, edge_count: usize) usize {
    var w: usize = 0;

    // Get bounding box for Y-flip (Graphviz Y-up → Excalidraw Y-down)
    const bb = c.gviz_graph_bbox(graph);
    const y_max = bb.ur_y;

    w += copySlice(out[w..], "{\"nodes\":[");

    // Extract node positions
    var first_node = true;
    var n_ptr = c.gviz_first_node(graph);
    while (n_ptr) |n| {
        const name_ptr = c.gviz_node_name(n);
        if (name_ptr == null) {
            n_ptr = c.gviz_next_node(graph, n);
            continue;
        }
        const name_slice = std.mem.span(name_ptr.?);

        // Find matching input node for dimensions
        var input_w: i32 = 180;
        var input_h: i32 = 80;
        for (nodes[0..node_count]) |in_node| {
            if (std.mem.eql(u8, in_node.id_slice, name_slice)) {
                input_w = in_node.width;
                input_h = in_node.height;
                break;
            }
        }

        // Get node center position (Graphviz points, 72 DPI, Y-up)
        var cx: f64 = 0;
        var cy: f64 = 0;
        c.gviz_node_coord(n, &cx, &cy);

        // Convert to Excalidraw coordinates (Y-down, top-left corner)
        const node_x = @as(i32, @intFromFloat(cx)) - @divTrunc(input_w, 2);
        const node_y = @as(i32, @intFromFloat(y_max - cy)) - @divTrunc(input_h, 2);

        if (!first_node) w += copySlice(out[w..], ",");
        first_node = false;

        w += copySlice(out[w..], "{\"id\":\"");
        w += copySlice(out[w..], name_slice);
        w += copySlice(out[w..], "\",\"x\":");
        w += writeInt(out[w..], node_x);
        w += copySlice(out[w..], ",\"y\":");
        w += writeInt(out[w..], node_y);
        w += copySlice(out[w..], "}");

        n_ptr = c.gviz_next_node(graph, n);
    }

    w += copySlice(out[w..], "],\"edges\":[");

    // Extract edge spline points
    var first_edge = true;
    for (edges[0..edge_count]) |e| {
        const spline = findEdgeSpline(graph, e.from_slice, e.to_slice, y_max);
        if (spline.point_count < 2) continue;

        if (!first_edge) w += copySlice(out[w..], ",");
        first_edge = false;

        w += copySlice(out[w..], "{\"from\":\"");
        w += copySlice(out[w..], e.from_slice);
        w += copySlice(out[w..], "\",\"to\":\"");
        w += copySlice(out[w..], e.to_slice);
        w += copySlice(out[w..], "\",\"points\":[");

        for (0..spline.point_count) |pi| {
            if (pi > 0) w += copySlice(out[w..], ",");
            w += copySlice(out[w..], "[");
            w += writeInt(out[w..], spline.points_x[pi]);
            w += copySlice(out[w..], ",");
            w += writeInt(out[w..], spline.points_y[pi]);
            w += copySlice(out[w..], "]");
        }

        w += copySlice(out[w..], "]}");
    }

    w += copySlice(out[w..], "]}");
    return w;
}

const MAX_SPLINE_POINTS = 64;

const SplineResult = struct {
    points_x: [MAX_SPLINE_POINTS]i32,
    points_y: [MAX_SPLINE_POINTS]i32,
    point_count: usize,
};

fn findEdgeSpline(graph: *anyopaque, from_name: []const u8, to_name: []const u8, y_max: f64) SplineResult {
    var result = SplineResult{
        .points_x = undefined,
        .points_y = undefined,
        .point_count = 0,
    };

    // Find source node
    var src_node: ?*anyopaque = null;
    var n_ptr = c.gviz_first_node(graph);
    while (n_ptr) |n| {
        const name = c.gviz_node_name(n);
        if (name != null and std.mem.eql(u8, std.mem.span(name.?), from_name)) {
            src_node = n;
            break;
        }
        n_ptr = c.gviz_next_node(graph, n);
    }
    const src = src_node orelse return result;

    // Find the edge from src to target
    var e_ptr = c.gviz_first_out_edge(graph, src);
    while (e_ptr) |e| {
        const head = c.gviz_edge_head(e);
        if (head != null) {
            const head_name = c.gviz_node_name(head);
            if (head_name != null and std.mem.eql(u8, std.mem.span(head_name.?), to_name)) {
                // Found the edge — extract spline data
                var spline: GvizSpline = undefined;
                if (c.gviz_edge_spline(e, &spline) != 0) {
                    // Add start point if present
                    if (spline.has_start_point != 0 and result.point_count < MAX_SPLINE_POINTS) {
                        result.points_x[result.point_count] = @intFromFloat(spline.start_point.x);
                        result.points_y[result.point_count] = @intFromFloat(y_max - spline.start_point.y);
                        result.point_count += 1;
                    }

                    // Extract knot points from cubic bezier sequence.
                    // For ortho splines, control points coincide with knots,
                    // so every 3rd point gives the path waypoints.
                    var i: usize = 0;
                    while (i < spline.point_count and result.point_count < MAX_SPLINE_POINTS) {
                        const pt = spline.points[i];
                        result.points_x[result.point_count] = @intFromFloat(pt.x);
                        result.points_y[result.point_count] = @intFromFloat(y_max - pt.y);
                        result.point_count += 1;
                        i += 3;
                        if (i == 3 and i < spline.point_count) {
                            // Include the first point, then skip by 3
                        }
                    }

                    // Add end point if present
                    if (spline.has_end_point != 0 and result.point_count < MAX_SPLINE_POINTS) {
                        result.points_x[result.point_count] = @intFromFloat(spline.end_point.x);
                        result.points_y[result.point_count] = @intFromFloat(y_max - spline.end_point.y);
                        result.point_count += 1;
                    }
                }
                return result;
            }
        }
        e_ptr = c.gviz_next_out_edge(graph, e);
    }

    return result;
}

// ── Float formatting ──

fn writeFloat(out: []u8, val: f64) usize {
    const negative = val < 0;
    const abs_val = if (negative) -val else val;
    const int_part = @as(i64, @intFromFloat(abs_val));
    const frac = @as(i64, @intFromFloat((abs_val - @as(f64, @floatFromInt(int_part))) * 100.0 + 0.5));

    var w: usize = 0;
    if (negative) {
        out[w] = '-';
        w += 1;
    }
    w += writeInt(out[w..], @intCast(int_part));
    out[w] = '.';
    w += 1;
    if (frac < 10) {
        out[w] = '0';
        w += 1;
    }
    w += writeInt(out[w..], @intCast(frac));
    return w;
}

// ── JSON Parsing ──

fn parseNodes(json: []const u8, out_nodes: *[MAX_NODES]Node) !usize {
    var count: usize = 0;
    var pos: usize = 0;
    while (pos < json.len and json[pos] != '{') : (pos += 1) {}
    while (pos < json.len and count < MAX_NODES) {
        if (json[pos] == '{') {
            var node = Node{ .id_slice = &.{}, .width = 180, .height = 80, .row = null, .col = null };
            const obj_end = findMatchingBrace(json[pos..]) + pos;
            const obj = json[pos..obj_end];
            node.id_slice = extractStringField(obj, "id") orelse &.{};
            node.width = extractIntField(obj, "width") orelse 180;
            node.height = extractIntField(obj, "height") orelse 80;
            node.row = extractIntField(obj, "row");
            node.col = extractIntField(obj, "col");
            out_nodes[count] = node;
            count += 1;
            pos = obj_end;
        }
        pos += 1;
    }
    return count;
}

fn parseEdges(json: []const u8, out_edges: *[MAX_EDGES]Edge) !usize {
    var count: usize = 0;
    var pos: usize = 0;
    while (pos < json.len and json[pos] != '{') : (pos += 1) {}
    while (pos < json.len and count < MAX_EDGES) {
        if (json[pos] == '{') {
            var edge = Edge{ .from_slice = &.{}, .to_slice = &.{} };
            const obj_end = findMatchingBrace(json[pos..]) + pos;
            const obj = json[pos..obj_end];
            edge.from_slice = extractStringField(obj, "from") orelse &.{};
            edge.to_slice = extractStringField(obj, "to") orelse &.{};
            out_edges[count] = edge;
            count += 1;
            pos = obj_end;
        }
        pos += 1;
    }
    return count;
}

const findMatchingBrace = util.findMatchingBrace;
const extractStringField = util.extractStringField;
const extractIntField = util.extractIntField;
const copySlice = util.copySlice;
const writeInt = util.writeInt;

// ── Tests ──

test "node parsing" {
    const nodes_json =
        \\[{"id":"a","width":180,"height":80,"row":0,"col":0},{"id":"b","width":180,"height":80,"row":1,"col":1}]
    ;
    var nodes: [MAX_NODES]Node = undefined;
    const count = try parseNodes(nodes_json, &nodes);
    try std.testing.expectEqual(@as(usize, 2), count);
    try std.testing.expect(std.mem.eql(u8, nodes[0].id_slice, "a"));
    try std.testing.expect(std.mem.eql(u8, nodes[1].id_slice, "b"));
    try std.testing.expectEqual(@as(i32, 180), nodes[0].width);
}

test "edge parsing" {
    const edges_json =
        \\[{"from":"a","to":"b"},{"from":"b","to":"c"}]
    ;
    var edges: [MAX_EDGES]Edge = undefined;
    const count = try parseEdges(edges_json, &edges);
    try std.testing.expectEqual(@as(usize, 2), count);
    try std.testing.expect(std.mem.eql(u8, edges[0].from_slice, "a"));
    try std.testing.expect(std.mem.eql(u8, edges[0].to_slice, "b"));
}

test "dot string builder" {
    var nodes: [MAX_NODES]Node = undefined;
    nodes[0] = .{ .id_slice = "api", .width = 180, .height = 80, .row = 0, .col = 0 };
    nodes[1] = .{ .id_slice = "db", .width = 180, .height = 80, .row = 1, .col = 0 };
    var edges: [MAX_EDGES]Edge = undefined;
    edges[0] = .{ .from_slice = "api", .to_slice = "db" };
    var dot_buf: [DOT_BUF_SIZE]u8 = undefined;
    const dot_len = buildDotString(&dot_buf, &nodes, 2, &edges, 1);
    try std.testing.expect(dot_len > 0);
    const dot_str = dot_buf[0..dot_len];
    try std.testing.expect(std.mem.indexOf(u8, dot_str, "digraph G") != null);
    try std.testing.expect(std.mem.indexOf(u8, dot_str, "\"api\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, dot_str, "\"api\" -> \"db\"") != null);
}
