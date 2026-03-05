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
pub fn layoutGraph(nodes_json: []const u8, edges_json: []const u8, groups_json: []const u8, out: []u8) !usize {
    var nodes: [MAX_NODES]Node = undefined;
    var node_count: usize = 0;
    node_count = parseNodes(nodes_json, &nodes) catch return 0;

    var edges: [MAX_EDGES]Edge = undefined;
    var edge_count: usize = 0;
    edge_count = parseEdges(edges_json, &edges) catch return 0;

    var groups: [MAX_GROUPS]Group = undefined;
    var group_count: usize = 0;
    if (groups_json.len > 2) { // not empty "[]"
        group_count = parseGroups(groups_json, &groups) catch 0;
    }

    // Build graph programmatically via cgraph API (no DOT parser needed)
    const graph = c.gviz_graph_new("G") orelse return 0;

    // Set graph attributes
    c.gviz_set_graph_attr(graph, "rankdir", "TB");
    c.gviz_set_graph_attr(graph, "splines", "ortho");
    c.gviz_set_graph_attr(graph, "nodesep", "1.5");
    c.gviz_set_graph_attr(graph, "ranksep", "1.2");

    // Set default node attributes so per-node agsafeset works
    c.gviz_set_default_node_attr(graph, "width", "");
    c.gviz_set_default_node_attr(graph, "height", "");
    c.gviz_set_default_node_attr(graph, "fixedsize", "");

    // Set default edge attribute so per-edge label agsafeset works
    c.gviz_set_default_edge_attr(graph, "label", "");

    // Create nodes with size attributes
    var node_ptrs: [MAX_NODES]?*anyopaque = undefined;
    for (nodes[0..node_count], 0..) |n, i| {
        const name_z = nullTerminate(n.id_slice) orelse {
            c.gviz_graph_close(graph);
            return 0;
        };

        const node_ptr = c.gviz_add_node(graph, name_z) orelse {
            c.gviz_graph_close(graph);
            return 0;
        };
        node_ptrs[i] = node_ptr;

        // Set width/height in inches (72 points per inch)
        var width_buf: [32]u8 = undefined;
        const width_len = writeFloat(&width_buf, @as(f64, @floatFromInt(n.width)) / 72.0);
        width_buf[width_len] = 0;
        c.gviz_set_node_attr(graph, node_ptr, "width", @ptrCast(&width_buf));

        var height_buf: [32]u8 = undefined;
        const height_len = writeFloat(&height_buf, @as(f64, @floatFromInt(n.height)) / 72.0);
        height_buf[height_len] = 0;
        c.gviz_set_node_attr(graph, node_ptr, "height", @ptrCast(&height_buf));

        c.gviz_set_node_attr(graph, node_ptr, "fixedsize", "true");
    }

    // Create cluster subgraphs for groups (Graphviz keeps clusters non-overlapping)
    var cluster_ptrs: [MAX_GROUPS]?*anyopaque = undefined;
    for (groups[0..group_count], 0..) |g, gi| {
        // Graphviz requires cluster names to start with "cluster"
        var cluster_name: [64]u8 = undefined;
        const prefix = "cluster_";
        @memcpy(cluster_name[0..prefix.len], prefix);
        const idx_len = writeInt(cluster_name[prefix.len..], @intCast(gi));
        cluster_name[prefix.len + idx_len] = 0;

        const subg = c.gviz_add_subgraph(graph, @ptrCast(&cluster_name)) orelse {
            cluster_ptrs[gi] = null;
            continue;
        };
        cluster_ptrs[gi] = subg;

        // Set cluster label and margin (margin ensures padding for TS-side group rect)
        const label_z = nullTerminate(g.label_slice) orelse continue;
        c.gviz_set_graph_attr(subg, "label", label_z);
        c.gviz_set_graph_attr(subg, "style", "dashed");
        c.gviz_set_graph_attr(subg, "margin", "20");

        // Add child nodes to the cluster subgraph
        for (g.children_slices[0..g.child_count]) |child_id| {
            // Find the node pointer for this child
            for (nodes[0..node_count], 0..) |n, ni| {
                if (std.mem.eql(u8, n.id_slice, child_id)) {
                    if (node_ptrs[ni]) |np| {
                        _ = c.gviz_subgraph_add_node(subg, np);
                    }
                    break;
                }
            }
        }
    }

    // Create edges (store pointers for reading label positions back)
    var edge_ptrs: [MAX_EDGES]?*anyopaque = undefined;
    for (edges[0..edge_count], 0..) |e, ei| {
        // Find source and target node pointers
        var from_ptr: ?*anyopaque = null;
        var to_ptr: ?*anyopaque = null;
        for (nodes[0..node_count], 0..) |n, ni| {
            if (std.mem.eql(u8, n.id_slice, e.from_slice)) from_ptr = node_ptrs[ni];
            if (std.mem.eql(u8, n.id_slice, e.to_slice)) to_ptr = node_ptrs[ni];
        }
        if (from_ptr == null or to_ptr == null) {
            edge_ptrs[ei] = null;
            continue;
        }

        // Edge name for uniqueness
        var edge_name: [32]u8 = undefined;
        const elen = writeInt(&edge_name, @intCast(ei));
        edge_name[elen] = 0;
        const edge_ptr = c.gviz_add_edge(graph, from_ptr.?, to_ptr.?, @ptrCast(&edge_name));
        edge_ptrs[ei] = edge_ptr;

        // Pass label to Graphviz so it computes label placement natively
        if (e.label_slice.len > 0) {
            if (edge_ptr) |ep| {
                const label_z = nullTerminate(e.label_slice) orelse continue;
                c.gviz_set_edge_attr(graph, ep, "label", label_z);
            }
        }
    }

    // Create GVC context with dot_layout plugin
    const gvc = c.gviz_context_new() orelse {
        c.gviz_graph_close(graph);
        return 0;
    };

    // Run dot layout
    if (c.gviz_layout(gvc, graph) != 0) {
        c.gviz_graph_close(graph);
        c.gviz_context_free(gvc);
        return 0;
    }

    // Extract positions and write JSON output (including cluster bounding boxes)
    const result = writeGraphvizOutput(out, graph, gvc, &nodes, node_count, &edges, edge_count, &groups, group_count, &cluster_ptrs, &edge_ptrs);

    // Cleanup
    c.gviz_free_layout(gvc, graph);
    c.gviz_graph_close(graph);
    c.gviz_context_free(gvc);

    return result;
}

// ── Graphviz C bridge FFI (from gviz_bridge.c) ──
// Only linked when targeting WASM (Graphviz C is compiled for wasm32-wasi only).
// Native test builds use parsing but not the layout C FFI.

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
pub const c = if (is_wasm) struct {
    // Graph construction (programmatic — no DOT parser needed)
    pub extern fn gviz_graph_new(name: [*:0]const u8) ?*anyopaque;
    pub extern fn gviz_add_node(g: ?*anyopaque, name: [*:0]const u8) ?*anyopaque;
    pub extern fn gviz_add_edge(g: ?*anyopaque, tail: ?*anyopaque, head: ?*anyopaque, name: [*:0]const u8) ?*anyopaque;
    pub extern fn gviz_set_default_node_attr(g: ?*anyopaque, name: [*:0]const u8, value: [*:0]const u8) void;
    pub extern fn gviz_set_graph_attr(g: ?*anyopaque, name: [*:0]const u8, value: [*:0]const u8) void;
    pub extern fn gviz_set_node_attr(g: ?*anyopaque, n: ?*anyopaque, name: [*:0]const u8, value: [*:0]const u8) void;
    pub extern fn gviz_set_default_edge_attr(g: ?*anyopaque, name: [*:0]const u8, value: [*:0]const u8) void;
    pub extern fn gviz_set_edge_attr(g: ?*anyopaque, e: ?*anyopaque, name: [*:0]const u8, value: [*:0]const u8) void;

    // Cluster subgraphs
    pub extern fn gviz_add_subgraph(g: ?*anyopaque, name: [*:0]const u8) ?*anyopaque;
    pub extern fn gviz_subgraph_add_node(subg: ?*anyopaque, n: ?*anyopaque) ?*anyopaque;

    // Context and layout
    pub extern fn gviz_context_new() ?*anyopaque;
    pub extern fn gviz_context_free(ctx: ?*anyopaque) void;
    pub extern fn gviz_graph_close(g: ?*anyopaque) void;
    pub extern fn gviz_layout(ctx: ?*anyopaque, g: ?*anyopaque) c_int;
    pub extern fn gviz_free_layout(ctx: ?*anyopaque, g: ?*anyopaque) void;

    // Node iteration
    pub extern fn gviz_first_node(g: ?*anyopaque) ?*anyopaque;
    pub extern fn gviz_next_node(g: ?*anyopaque, n: ?*anyopaque) ?*anyopaque;
    pub extern fn gviz_node_name(n: ?*anyopaque) ?[*:0]const u8;
    pub extern fn gviz_node_coord(n: ?*anyopaque, x: *f64, y: *f64) void;

    // Edge iteration
    pub extern fn gviz_first_out_edge(g: ?*anyopaque, n: ?*anyopaque) ?*anyopaque;
    pub extern fn gviz_next_out_edge(g: ?*anyopaque, e: ?*anyopaque) ?*anyopaque;
    pub extern fn gviz_edge_head(e: ?*anyopaque) ?*anyopaque;
    pub extern fn gviz_edge_tail(e: ?*anyopaque) ?*anyopaque;
    pub extern fn gviz_edge_spline(e: ?*anyopaque, out: *GvizSpline) c_int;
    pub extern fn gviz_edge_label_pos(e: ?*anyopaque, x: *f64, y: *f64) c_int;
    pub extern fn gviz_graph_bbox(g: ?*anyopaque) GvizBbox;
} else struct {
    pub fn gviz_graph_new(_: [*:0]const u8) ?*anyopaque { return null; }
    pub fn gviz_add_node(_: ?*anyopaque, _: [*:0]const u8) ?*anyopaque { return null; }
    pub fn gviz_add_edge(_: ?*anyopaque, _: ?*anyopaque, _: ?*anyopaque, _: [*:0]const u8) ?*anyopaque { return null; }
    pub fn gviz_set_default_node_attr(_: ?*anyopaque, _: [*:0]const u8, _: [*:0]const u8) void {}
    pub fn gviz_set_graph_attr(_: ?*anyopaque, _: [*:0]const u8, _: [*:0]const u8) void {}
    pub fn gviz_set_node_attr(_: ?*anyopaque, _: ?*anyopaque, _: [*:0]const u8, _: [*:0]const u8) void {}
    pub fn gviz_set_default_edge_attr(_: ?*anyopaque, _: [*:0]const u8, _: [*:0]const u8) void {}
    pub fn gviz_set_edge_attr(_: ?*anyopaque, _: ?*anyopaque, _: [*:0]const u8, _: [*:0]const u8) void {}
    pub fn gviz_add_subgraph(_: ?*anyopaque, _: [*:0]const u8) ?*anyopaque { return null; }
    pub fn gviz_subgraph_add_node(_: ?*anyopaque, _: ?*anyopaque) ?*anyopaque { return null; }
    pub fn gviz_context_new() ?*anyopaque { return null; }
    pub fn gviz_context_free(_: ?*anyopaque) void {}
    pub fn gviz_graph_close(_: ?*anyopaque) void {}
    pub fn gviz_layout(_: ?*anyopaque, _: ?*anyopaque) c_int { return -1; }
    pub fn gviz_free_layout(_: ?*anyopaque, _: ?*anyopaque) void {}
    pub fn gviz_first_node(_: ?*anyopaque) ?*anyopaque { return null; }
    pub fn gviz_next_node(_: ?*anyopaque, _: ?*anyopaque) ?*anyopaque { return null; }
    pub fn gviz_node_name(_: ?*anyopaque) ?[*:0]const u8 { return null; }
    pub fn gviz_node_coord(_: ?*anyopaque, _: *f64, _: *f64) void {}
    pub fn gviz_first_out_edge(_: ?*anyopaque, _: ?*anyopaque) ?*anyopaque { return null; }
    pub fn gviz_next_out_edge(_: ?*anyopaque, _: ?*anyopaque) ?*anyopaque { return null; }
    pub fn gviz_edge_head(_: ?*anyopaque) ?*anyopaque { return null; }
    pub fn gviz_edge_tail(_: ?*anyopaque) ?*anyopaque { return null; }
    pub fn gviz_edge_spline(_: ?*anyopaque, _: *GvizSpline) c_int { return 0; }
    pub fn gviz_edge_label_pos(_: ?*anyopaque, _: *f64, _: *f64) c_int { return 0; }
    pub fn gviz_graph_bbox(_: ?*anyopaque) GvizBbox { return .{ .ll_x = 0, .ll_y = 0, .ur_x = 0, .ur_y = 0 }; }
};

// ── Constants ──

const MAX_NODES = 256;
const MAX_EDGES = 512;
const MAX_GROUPS = 32;
const MAX_GROUP_CHILDREN = 64;

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
    label_slice: []const u8,
};

const Group = struct {
    id_slice: []const u8,
    label_slice: []const u8,
    children_slices: [MAX_GROUP_CHILDREN][]const u8,
    child_count: usize,
};

// ── Output: Extract Graphviz Layout Results ──

fn writeGraphvizOutput(out: []u8, graph: *anyopaque, _: *anyopaque, nodes: *[MAX_NODES]Node, node_count: usize, edges: *[MAX_EDGES]Edge, edge_count: usize, groups: *[MAX_GROUPS]Group, group_count: usize, cluster_ptrs: *[MAX_GROUPS]?*anyopaque, edge_ptrs: *[MAX_EDGES]?*anyopaque) usize {
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

    // Extract edge splines and label positions from Graphviz
    const EdgeInfo = struct {
        spline: SplineResult,
        edge_idx: usize,
        label_x: i32,
        label_y: i32,
        label_w: i32,
        has_label: bool,
    };
    var edge_infos: [MAX_EDGES]EdgeInfo = undefined;
    var edge_info_count: usize = 0;

    for (edges[0..edge_count], 0..) |e, ei| {
        const spline = findEdgeSpline(graph, e.from_slice, e.to_slice, y_max, nodes, node_count);
        if (spline.point_count < 2) continue;

        var info = EdgeInfo{
            .spline = spline,
            .edge_idx = ei,
            .label_x = 0,
            .label_y = 0,
            .label_w = if (e.label_slice.len > 0) @as(i32, @intCast(e.label_slice.len)) * 8 + 16 else 0,
            .has_label = e.label_slice.len > 0,
        };

        // Read label position from Graphviz (computed natively during layout)
        if (info.has_label) {
            if (edge_ptrs[ei]) |ep| {
                var lx: f64 = 0;
                var ly: f64 = 0;
                if (c.gviz_edge_label_pos(ep, &lx, &ly) != 0) {
                    // Graphviz Y-up → Excalidraw Y-down
                    info.label_x = @intFromFloat(lx);
                    info.label_y = @intFromFloat(y_max - ly);
                } else {
                    // Fallback: midpoint of longest segment
                    var best_len: i32 = 0;
                    var best_seg: usize = 0;
                    var s: usize = 0;
                    while (s + 1 < spline.point_count) : (s += 1) {
                        const dx = absInt(spline.points_x[s + 1] - spline.points_x[s]);
                        const dy = absInt(spline.points_y[s + 1] - spline.points_y[s]);
                        const seg_len = dx + dy;
                        if (seg_len > best_len) { best_len = seg_len; best_seg = s; }
                    }
                    info.label_x = @divTrunc(spline.points_x[best_seg] + spline.points_x[best_seg + 1], 2);
                    info.label_y = @divTrunc(spline.points_y[best_seg] + spline.points_y[best_seg + 1], 2);
                }
            }
        }

        edge_infos[edge_info_count] = info;
        edge_info_count += 1;
    }

    // Post-Graphviz collision fix: Graphviz doesn't know actual text widths
    // (gvtextlayout returns false in WASM), so nearby labels may still overlap.
    // Push overlapping labels apart on whichever axis needs less movement.
    const LABEL_H: i32 = 24;
    const MIN_GAP: i32 = 48;
    var pass: usize = 0;
    while (pass < 10) : (pass += 1) {
        var shifted = false;
        for (0..edge_info_count) |i| {
            if (!edge_infos[i].has_label) continue;
            for (0..i) |j| {
                if (!edge_infos[j].has_label) continue;

                const i_hw = @divTrunc(edge_infos[i].label_w, 2);
                const j_hw = @divTrunc(edge_infos[j].label_w, 2);
                const hh = @divTrunc(LABEL_H, 2);

                // Check bounding-box overlap with gap
                const x_overlap = (i_hw + j_hw + MIN_GAP) - absInt(edge_infos[i].label_x - edge_infos[j].label_x);
                const y_overlap = (hh + hh + MIN_GAP) - absInt(edge_infos[i].label_y - edge_infos[j].label_y);

                if (x_overlap > 0 and y_overlap > 0) {
                    // Push apart on axis needing less movement
                    if (x_overlap < y_overlap) {
                        const half = @divTrunc(x_overlap + 1, 2);
                        if (edge_infos[i].label_x >= edge_infos[j].label_x) {
                            edge_infos[i].label_x += half;
                            edge_infos[j].label_x -= half;
                        } else {
                            edge_infos[i].label_x -= half;
                            edge_infos[j].label_x += half;
                        }
                    } else {
                        const half = @divTrunc(y_overlap + 1, 2);
                        if (edge_infos[i].label_y >= edge_infos[j].label_y) {
                            edge_infos[i].label_y += half;
                            edge_infos[j].label_y -= half;
                        } else {
                            edge_infos[i].label_y -= half;
                            edge_infos[j].label_y += half;
                        }
                    }
                    shifted = true;
                }
            }
        }
        if (!shifted) break;
    }

    // Second pass: write edge JSON with label positions
    var first_edge = true;
    for (edge_infos[0..edge_info_count]) |info| {
        const e = edges[info.edge_idx];
        const spline = info.spline;

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

        w += copySlice(out[w..], "],\"startFixedPoint\":[");
        w += writeFloat(out[w..], spline.start_fixed_point[0]);
        w += copySlice(out[w..], ",");
        w += writeFloat(out[w..], spline.start_fixed_point[1]);
        w += copySlice(out[w..], "],\"endFixedPoint\":[");
        w += writeFloat(out[w..], spline.end_fixed_point[0]);
        w += copySlice(out[w..], ",");
        w += writeFloat(out[w..], spline.end_fixed_point[1]);
        w += copySlice(out[w..], "]");

        // Include label position if edge has a label
        if (info.has_label) {
            w += copySlice(out[w..], ",\"labelX\":");
            w += writeInt(out[w..], info.label_x);
            w += copySlice(out[w..], ",\"labelY\":");
            w += writeInt(out[w..], info.label_y);
        }

        w += copySlice(out[w..], "}");
    }

    w += copySlice(out[w..], "]");

    // Output cluster (group) bounding boxes from Graphviz
    if (group_count > 0) {
        w += copySlice(out[w..], ",\"groups\":[");
        var first_group = true;
        for (0..group_count) |gi| {
            const cluster = cluster_ptrs[gi] orelse continue;
            const cbb = c.gviz_graph_bbox(cluster);

            if (!first_group) w += copySlice(out[w..], ",");
            first_group = false;

            // Convert Graphviz bbox (Y-up, points) → Excalidraw (Y-down, pixels)
            const gx = @as(i32, @intFromFloat(cbb.ll_x));
            const gy = @as(i32, @intFromFloat(y_max - cbb.ur_y));
            const gw = @as(i32, @intFromFloat(cbb.ur_x - cbb.ll_x));
            const gh = @as(i32, @intFromFloat(cbb.ur_y - cbb.ll_y));

            w += copySlice(out[w..], "{\"id\":\"");
            w += copySlice(out[w..], groups[gi].id_slice);
            w += copySlice(out[w..], "\",\"x\":");
            w += writeInt(out[w..], gx);
            w += copySlice(out[w..], ",\"y\":");
            w += writeInt(out[w..], gy);
            w += copySlice(out[w..], ",\"width\":");
            w += writeInt(out[w..], gw);
            w += copySlice(out[w..], ",\"height\":");
            w += writeInt(out[w..], gh);
            w += copySlice(out[w..], "}");
        }
        w += copySlice(out[w..], "]");
    }

    w += copySlice(out[w..], "}");
    return w;
}

const MAX_SPLINE_POINTS = 64;

const SplineResult = struct {
    points_x: [MAX_SPLINE_POINTS]i32,
    points_y: [MAX_SPLINE_POINTS]i32,
    point_count: usize,
    start_fixed_point: [2]f64,
    end_fixed_point: [2]f64,
};

fn findEdgeSpline(graph: *anyopaque, from_name: []const u8, to_name: []const u8, y_max: f64, nodes: *[MAX_NODES]Node, node_count: usize) SplineResult {
    var result = SplineResult{
        .points_x = undefined,
        .points_y = undefined,
        .point_count = 0,
        .start_fixed_point = .{ 0.5, 0.5 },
        .end_fixed_point = .{ 0.5, 0.5 },
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
                    // Extract knot points from cubic bezier sequence.
                    // For ortho splines, control points coincide with knots,
                    // so every 3rd point gives the path waypoints.
                    // Don't add sp/ep as separate points — they create tiny duplicate
                    // segments near nodes. Use them only for fixedPoint calculation.
                    var i: usize = 0;
                    while (i < spline.point_count and result.point_count < MAX_SPLINE_POINTS) {
                        const pt = spline.points[i];
                        result.points_x[result.point_count] = @intFromFloat(pt.x);
                        result.points_y[result.point_count] = @intFromFloat(y_max - pt.y);
                        result.point_count += 1;
                        i += 3;
                    }
                    // Also capture the last bezier knot if not already included
                    if (spline.point_count > 0 and (spline.point_count - 1) % 3 != 0) {
                        const last_pt = spline.points[spline.point_count - 1];
                        if (result.point_count < MAX_SPLINE_POINTS) {
                            result.points_x[result.point_count] = @intFromFloat(last_pt.x);
                            result.points_y[result.point_count] = @intFromFloat(y_max - last_pt.y);
                            result.point_count += 1;
                        }
                    }

                    // Compute fixedPoints using sp/ep (arrow tip positions on node boundary)
                    if (result.point_count >= 2) {
                        // Use sp (start point) if available, else first bezier knot
                        const fix_start_x: f64 = if (spline.has_start_point != 0) spline.start_point.x else @floatFromInt(result.points_x[0]);
                        const fix_start_y: f64 = if (spline.has_start_point != 0) (y_max - spline.start_point.y) else @floatFromInt(result.points_y[0]);
                        const fix_end_x: f64 = if (spline.has_end_point != 0) spline.end_point.x else @floatFromInt(result.points_x[result.point_count - 1]);
                        const fix_end_y: f64 = if (spline.has_end_point != 0) (y_max - spline.end_point.y) else @floatFromInt(result.points_y[result.point_count - 1]);

                        // Find source node dimensions
                        for (nodes[0..node_count]) |sn| {
                            if (std.mem.eql(u8, sn.id_slice, from_name)) {
                                var scx: f64 = 0;
                                var scy: f64 = 0;
                                c.gviz_node_coord(src, &scx, &scy);
                                const snx = scx - @as(f64, @floatFromInt(sn.width)) / 2.0;
                                const sny = (y_max - scy) - @as(f64, @floatFromInt(sn.height)) / 2.0;
                                result.start_fixed_point[0] = clamp01((fix_start_x - snx) / @as(f64, @floatFromInt(sn.width)));
                                result.start_fixed_point[1] = clamp01((fix_start_y - sny) / @as(f64, @floatFromInt(sn.height)));
                                break;
                            }
                        }
                        // Find target node dimensions
                        const head_for_fp = c.gviz_edge_head(e);
                        if (head_for_fp != null) {
                            for (nodes[0..node_count]) |tn| {
                                if (std.mem.eql(u8, tn.id_slice, to_name)) {
                                    var tcx: f64 = 0;
                                    var tcy: f64 = 0;
                                    c.gviz_node_coord(head_for_fp, &tcx, &tcy);
                                    const tnx = tcx - @as(f64, @floatFromInt(tn.width)) / 2.0;
                                    const tny = (y_max - tcy) - @as(f64, @floatFromInt(tn.height)) / 2.0;
                                    result.end_fixed_point[0] = clamp01((fix_end_x - tnx) / @as(f64, @floatFromInt(tn.width)));
                                    result.end_fixed_point[1] = clamp01((fix_end_y - tny) / @as(f64, @floatFromInt(tn.height)));
                                    break;
                                }
                            }
                        }
                    }
                }
                return result;
            }
        }
        e_ptr = c.gviz_next_out_edge(graph, e);
    }

    return result;
}

fn absInt(v: i32) i32 {
    return if (v < 0) -v else v;
}

fn clamp01(v: f64) f64 {
    if (v < 0.0) return 0.0;
    if (v > 1.0) return 1.0;
    return v;
}

// ── Null-termination helper ──

/// Copy a slice into a stack buffer and null-terminate it for C FFI.
/// Returns a sentinel-terminated pointer, or null if the slice is too long.
const NT_BUF_COUNT = 16;
const NT_BUF_SIZE = 256;
var nt_bufs: [NT_BUF_COUNT][NT_BUF_SIZE]u8 = undefined;
var nt_idx: usize = 0;

fn nullTerminate(slice: []const u8) ?[*:0]const u8 {
    if (slice.len >= NT_BUF_SIZE) return null;
    const idx = nt_idx % NT_BUF_COUNT;
    nt_idx += 1;
    @memcpy(nt_bufs[idx][0..slice.len], slice);
    nt_bufs[idx][slice.len] = 0;
    return @ptrCast(&nt_bufs[idx]);
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
            var edge = Edge{ .from_slice = &.{}, .to_slice = &.{}, .label_slice = &.{} };
            const obj_end = findMatchingBrace(json[pos..]) + pos;
            const obj = json[pos..obj_end];
            edge.from_slice = extractStringField(obj, "from") orelse &.{};
            edge.to_slice = extractStringField(obj, "to") orelse &.{};
            edge.label_slice = extractStringField(obj, "label") orelse &.{};
            out_edges[count] = edge;
            count += 1;
            pos = obj_end;
        }
        pos += 1;
    }
    return count;
}

/// Parse groups JSON: [{"id":"g1","label":"Group","children":["n1","n2"]}, ...]
fn parseGroups(json: []const u8, out_groups: *[MAX_GROUPS]Group) !usize {
    var count: usize = 0;
    var pos: usize = 0;
    while (pos < json.len and json[pos] != '{') : (pos += 1) {}
    while (pos < json.len and count < MAX_GROUPS) {
        if (json[pos] == '{') {
            const obj_end = findMatchingBrace(json[pos..]) + pos;
            const obj = json[pos..obj_end];

            var group = Group{
                .id_slice = extractStringField(obj, "id") orelse &.{},
                .label_slice = extractStringField(obj, "label") orelse &.{},
                .children_slices = undefined,
                .child_count = 0,
            };

            // Parse children array: find "children":[ then extract strings
            if (std.mem.indexOf(u8, obj, "\"children\"")) |ci| {
                var cp = ci + "\"children\"".len;
                // Skip to '['
                while (cp < obj.len and obj[cp] != '[') : (cp += 1) {}
                if (cp < obj.len) {
                    cp += 1; // skip '['
                    while (cp < obj.len and obj[cp] != ']' and group.child_count < MAX_GROUP_CHILDREN) {
                        if (obj[cp] == '"') {
                            cp += 1; // skip opening quote
                            const str_start = cp;
                            while (cp < obj.len and obj[cp] != '"') : (cp += 1) {}
                            group.children_slices[group.child_count] = obj[str_start..cp];
                            group.child_count += 1;
                            if (cp < obj.len) cp += 1; // skip closing quote
                        } else {
                            cp += 1;
                        }
                    }
                }
            }

            out_groups[count] = group;
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
