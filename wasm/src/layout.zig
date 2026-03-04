const std = @import("std");
const util = @import("util.zig");

/// Sugiyama layered graph layout with orthogonal edge routing.
///
/// Input JSON (nodes):
///   [{"id":"box_1","width":180,"height":80,"row":0,"col":1,"group":"g1"}, ...]
/// Input JSON (edges):
///   [{"from":"box_1","to":"box_2"}, ...]
/// Output JSON:
///   {"nodes":[{"id":"box_1","x":340,"y":100},...],
///    "edges":[{"from":"box_1","to":"box_2","points":[[x,y],[x,y],...]},...]}
///
/// Layout phases:
/// 1. Layer assignment (longest-path heuristic, cycle-aware)
/// 2. Virtual nodes for long edges (span > 1 layer)
/// 3. Crossing minimization (barycenter heuristic, 8 sweeps)
/// 4. Coordinate assignment (center nodes within layers)
/// 5. Orthogonal edge routing (elbow points)
pub fn layoutGraph(nodes_json: []const u8, edges_json: []const u8, out: []u8) !usize {
    var nodes: [MAX_NODES]Node = undefined;
    var node_count: usize = 0;
    node_count = parseNodes(nodes_json, &nodes) catch return 0;

    var edges: [MAX_EDGES]Edge = undefined;
    var edge_count: usize = 0;
    edge_count = parseEdges(edges_json, &edges) catch return 0;

    // Save original edge count before virtual nodes are added
    const real_edge_count = edge_count;
    const real_node_count = node_count;

    // Check if all nodes have explicit positions
    var all_explicit = true;
    for (nodes[0..node_count]) |n| {
        if (n.row == null or n.col == null) {
            all_explicit = false;
            break;
        }
    }

    if (!all_explicit) {
        // Phase 1: Layer assignment
        assignLayers(&nodes, node_count, &edges, edge_count);

        // Phase 2: Insert virtual nodes for long edges
        insertVirtualNodes(&nodes, &node_count, &edges, &edge_count);

        // Phase 3: Crossing minimization (barycenter heuristic)
        crossingMinimization(&nodes, node_count, &edges, edge_count);

        // Phase 4: Coordinate assignment
        assignCoordinates(&nodes, node_count);
    } else {
        // Grid placement for explicit positions
        for (nodes[0..node_count]) |*n| {
            const row = n.row orelse 0;
            const col = n.col orelse 0;
            n.x = BASE_X + col * COL_SPACING;
            n.y = BASE_Y + row * ROW_SPACING;
        }
    }

    // Phase 5: Generate output with edge routing
    return writeOutput(out, &nodes, node_count, real_node_count, &edges, edge_count, real_edge_count);
}

const MAX_NODES = 256; // includes virtual nodes
const MAX_EDGES = 512;
const MAX_LAYERS = 64;

const COL_SPACING: i32 = 280;
const ROW_SPACING: i32 = 220;
const BASE_X: i32 = 100;
const BASE_Y: i32 = 100;
const MIN_NODE_SEP: i32 = 40; // minimum horizontal separation between nodes

const Node = struct {
    id_slice: []const u8,
    width: i32,
    height: i32,
    row: ?i32,
    col: ?i32,
    x: i32 = 0,
    y: i32 = 0,
    group: []const u8 = &.{},
    is_virtual: bool = false,
    /// For virtual nodes: which original edge spawned this
    virtual_edge_from: []const u8 = &.{},
    virtual_edge_to: []const u8 = &.{},
};

const Edge = struct {
    from_slice: []const u8,
    to_slice: []const u8,
};

// ── Phase 1: Layer Assignment ──

fn assignLayers(nodes: *[MAX_NODES]Node, count: usize, edges: *[MAX_EDGES]Edge, edge_count: usize) void {
    // Longest-path heuristic: layer = max distance from a source node
    // Handles cycles by ignoring back edges during topological traversal
    var in_degree: [MAX_NODES]i32 = [_]i32{0} ** MAX_NODES;
    var longest: [MAX_NODES]i32 = [_]i32{0} ** MAX_NODES;
    var processed: [MAX_NODES]bool = [_]bool{false} ** MAX_NODES;
    var queue: [MAX_NODES]usize = undefined;

    // Compute in-degree
    for (edges[0..edge_count]) |e| {
        if (findNodeIdx(nodes[0..count], e.to_slice)) |idx| {
            in_degree[idx] += 1;
        }
    }

    // Kahn's algorithm to assign layers via longest path
    var q_front: usize = 0;
    var q_back: usize = 0;

    // Enqueue all sources (in-degree 0)
    for (0..count) |i| {
        if (in_degree[i] == 0) {
            queue[q_back] = i;
            q_back += 1;
            processed[i] = true;
        }
    }

    // If no sources found (pure cycle), pick node 0 as start
    if (q_back == 0 and count > 0) {
        queue[0] = 0;
        q_back = 1;
        processed[0] = true;
    }

    while (q_front < q_back) {
        const u = queue[q_front];
        q_front += 1;

        // For each outgoing edge from u
        for (edges[0..edge_count]) |e| {
            if (std.mem.eql(u8, e.from_slice, nodes[u].id_slice)) {
                if (findNodeIdx(nodes[0..count], e.to_slice)) |v| {
                    const new_layer = longest[u] + 1;
                    if (new_layer > longest[v]) {
                        longest[v] = new_layer;
                    }
                    in_degree[v] -= 1;
                    if (in_degree[v] <= 0 and !processed[v]) {
                        processed[v] = true;
                        queue[q_back] = v;
                        q_back += 1;
                    }
                }
            }
        }
    }

    // Handle unprocessed nodes (in cycles) — assign layer based on longest known + 1
    for (0..count) |i| {
        if (!processed[i]) {
            longest[i] = longest[i] + 1;
        }
    }

    // Apply layers: nodes with explicit row keep it; others get assigned
    for (0..count) |i| {
        if (nodes[i].row == null) {
            nodes[i].row = longest[i];
        }
    }

    // Assign columns within each layer based on order of appearance
    var layer_col_count: [MAX_LAYERS]i32 = [_]i32{0} ** MAX_LAYERS;
    for (0..count) |i| {
        if (nodes[i].col == null) {
            const layer: usize = @intCast(@max(0, nodes[i].row orelse 0));
            if (layer < MAX_LAYERS) {
                nodes[i].col = layer_col_count[layer];
                layer_col_count[layer] += 1;
            }
        }
    }
}

// ── Phase 2: Virtual Nodes for Long Edges ──

fn insertVirtualNodes(nodes: *[MAX_NODES]Node, node_count: *usize, edges: *[MAX_EDGES]Edge, edge_count: *usize) void {
    const orig_edge_count = edge_count.*;
    var ei: usize = 0;

    while (ei < orig_edge_count) : (ei += 1) {
        const e = edges[ei];
        const from_idx = findNodeIdx(nodes[0..node_count.*], e.from_slice) orelse continue;
        const to_idx = findNodeIdx(nodes[0..node_count.*], e.to_slice) orelse continue;

        const from_layer = nodes[from_idx].row orelse 0;
        const to_layer = nodes[to_idx].row orelse 0;
        const span = to_layer - from_layer;

        if (span <= 1) continue;
        if (node_count.* + @as(usize, @intCast(span - 1)) >= MAX_NODES) continue;
        if (edge_count.* + @as(usize, @intCast(span)) >= MAX_EDGES) continue;

        // Insert virtual nodes between layers
        var prev_id = e.from_slice;
        var layer: i32 = from_layer + 1;
        while (layer < to_layer) : (layer += 1) {
            const vi = node_count.*;
            nodes[vi] = .{
                .id_slice = &.{},
                .width = 0,
                .height = 0,
                .row = layer,
                .col = null,
                .is_virtual = true,
                .virtual_edge_from = e.from_slice,
                .virtual_edge_to = e.to_slice,
            };
            node_count.* += 1;

            edges[edge_count.*] = .{
                .from_slice = prev_id,
                .to_slice = nodes[vi].id_slice,
            };
            edge_count.* += 1;

            prev_id = nodes[vi].id_slice;
        }

        // Edge from last virtual to target
        edges[edge_count.*] = .{
            .from_slice = prev_id,
            .to_slice = e.to_slice,
        };
        edge_count.* += 1;

        // Mark original edge as replaced (empty from_slice signals deletion)
        edges[ei].from_slice = &.{};
        edges[ei].to_slice = &.{};
    }

    // Assign columns to virtual nodes
    var layer_col_count: [MAX_LAYERS]i32 = [_]i32{0} ** MAX_LAYERS;
    for (nodes[0..node_count.*]) |n| {
        if (!n.is_virtual) {
            const layer: usize = @intCast(@max(0, n.row orelse 0));
            if (layer < MAX_LAYERS) {
                const c = (n.col orelse 0) + 1;
                if (c > layer_col_count[layer]) layer_col_count[layer] = c;
            }
        }
    }
    for (nodes[0..node_count.*]) |*n| {
        if (n.is_virtual and n.col == null) {
            const layer: usize = @intCast(@max(0, n.row orelse 0));
            if (layer < MAX_LAYERS) {
                n.col = layer_col_count[layer];
                layer_col_count[layer] += 1;
            }
        }
    }
}

// ── Phase 3: Crossing Minimization ──

fn crossingMinimization(nodes: *[MAX_NODES]Node, count: usize, edges: *[MAX_EDGES]Edge, edge_count: usize) void {
    // Barycenter heuristic: sort nodes in each layer by average neighbor position
    // 8 sweeps (4 top-down + 4 bottom-up)

    var max_layer: i32 = 0;
    for (nodes[0..count]) |n| {
        const r = n.row orelse 0;
        if (r > max_layer) max_layer = r;
    }

    const sweeps: usize = 8;
    var sweep: usize = 0;
    while (sweep < sweeps) : (sweep += 1) {
        const top_down = (sweep % 2 == 0);
        if (top_down) {
            var layer: i32 = 1;
            while (layer <= max_layer) : (layer += 1) {
                reorderLayer(nodes, count, edges, edge_count, layer, layer - 1);
            }
        } else {
            var layer: i32 = max_layer - 1;
            while (layer >= 0) : (layer -= 1) {
                reorderLayer(nodes, count, edges, edge_count, layer, layer + 1);
            }
        }
    }
}

fn reorderLayer(nodes: *[MAX_NODES]Node, count: usize, edges: *[MAX_EDGES]Edge, edge_count: usize, target_layer: i32, ref_layer: i32) void {
    var layer_indices: [MAX_NODES]usize = undefined;
    var layer_count: usize = 0;
    for (0..count) |i| {
        if ((nodes[i].row orelse -1) == target_layer) {
            layer_indices[layer_count] = i;
            layer_count += 1;
        }
    }
    if (layer_count <= 1) return;

    // Compute barycenter for each node in target layer (×100 for precision)
    var barycenters: [MAX_NODES]i32 = [_]i32{0} ** MAX_NODES;

    for (0..layer_count) |li| {
        const ni = layer_indices[li];
        var sum: i32 = 0;
        var neighbor_count: i32 = 0;

        for (edges[0..edge_count]) |e| {
            if (e.from_slice.len == 0) continue;

            if (std.mem.eql(u8, e.from_slice, nodes[ni].id_slice)) {
                if (findNodeIdx(nodes[0..count], e.to_slice)) |other| {
                    if ((nodes[other].row orelse -1) == ref_layer) {
                        sum += (nodes[other].col orelse 0) * 100;
                        neighbor_count += 1;
                    }
                }
            }
            if (std.mem.eql(u8, e.to_slice, nodes[ni].id_slice)) {
                if (findNodeIdx(nodes[0..count], e.from_slice)) |other| {
                    if ((nodes[other].row orelse -1) == ref_layer) {
                        sum += (nodes[other].col orelse 0) * 100;
                        neighbor_count += 1;
                    }
                }
            }
        }

        if (neighbor_count > 0) {
            barycenters[li] = @divTrunc(sum, neighbor_count);
        } else {
            barycenters[li] = (nodes[ni].col orelse 0) * 100;
        }
    }

    // Insertion sort by barycenter
    var i: usize = 1;
    while (i < layer_count) : (i += 1) {
        var j = i;
        while (j > 0 and barycenters[j] < barycenters[j - 1]) : (j -= 1) {
            std.mem.swap(usize, &layer_indices[j], &layer_indices[j - 1]);
            std.mem.swap(i32, &barycenters[j], &barycenters[j - 1]);
        }
    }

    // Assign new column values
    for (0..layer_count) |li| {
        nodes[layer_indices[li]].col = @intCast(li);
    }
}

// ── Phase 4: Coordinate Assignment ──

fn assignCoordinates(nodes: *[MAX_NODES]Node, count: usize) void {
    var max_layer: i32 = 0;
    for (nodes[0..count]) |n| {
        const r = n.row orelse 0;
        if (r > max_layer) max_layer = r;
    }

    // Position nodes within each layer with proper spacing
    var layer: i32 = 0;
    while (layer <= max_layer) : (layer += 1) {
        var layer_nodes: [MAX_NODES]usize = undefined;
        var layer_count: usize = 0;

        for (0..count) |i| {
            if ((nodes[i].row orelse -1) == layer) {
                layer_nodes[layer_count] = i;
                layer_count += 1;
            }
        }

        // Sort by col (insertion sort)
        {
            var si: usize = 1;
            while (si < layer_count) : (si += 1) {
                var sj = si;
                while (sj > 0) : (sj -= 1) {
                    const col_a = nodes[layer_nodes[sj]].col orelse 0;
                    const col_b = nodes[layer_nodes[sj - 1]].col orelse 0;
                    if (col_a < col_b) {
                        std.mem.swap(usize, &layer_nodes[sj], &layer_nodes[sj - 1]);
                    } else break;
                }
            }
        }

        var x_pos: i32 = BASE_X;
        for (layer_nodes[0..layer_count]) |ni| {
            nodes[ni].x = x_pos;
            nodes[ni].y = BASE_Y + layer * ROW_SPACING;
            x_pos += @max(nodes[ni].width, 20) + MIN_NODE_SEP;
        }
    }

    // Center layers horizontally relative to widest layer
    var max_right: i32 = 0;
    {
        var l: i32 = 0;
        while (l <= max_layer) : (l += 1) {
            for (nodes[0..count]) |n| {
                if ((n.row orelse -1) == l) {
                    const right = n.x + n.width;
                    if (right > max_right) max_right = right;
                }
            }
        }
    }

    {
        var l: i32 = 0;
        while (l <= max_layer) : (l += 1) {
            var lmin: i32 = std.math.maxInt(i32);
            var lmax: i32 = std.math.minInt(i32);
            for (nodes[0..count]) |n| {
                if ((n.row orelse -1) == l) {
                    if (n.x < lmin) lmin = n.x;
                    const right = n.x + n.width;
                    if (right > lmax) lmax = right;
                }
            }
            if (lmin > lmax) continue;
            const layer_width = lmax - lmin;
            const offset = @divTrunc(max_right - layer_width, 2) + BASE_X - lmin;
            for (nodes[0..count]) |*n| {
                if ((n.row orelse -1) == l) {
                    n.x += offset;
                }
            }
        }
    }
}

// ── Output Generation with Edge Routing ──

fn writeOutput(
    out: []u8,
    nodes: *[MAX_NODES]Node,
    node_count: usize,
    real_node_count: usize,
    edges: *[MAX_EDGES]Edge,
    edge_count: usize,
    real_edge_count: usize,
) usize {
    var written: usize = 0;

    written += copySlice(out[written..], "{\"nodes\":[");

    // Write real (non-virtual) nodes
    var first_node = true;
    for (nodes[0..real_node_count]) |n| {
        if (n.is_virtual) continue;
        if (!first_node) written += copySlice(out[written..], ",");
        first_node = false;

        written += copySlice(out[written..], "{\"id\":\"");
        written += copySlice(out[written..], n.id_slice);
        written += copySlice(out[written..], "\",\"x\":");
        written += writeInt(out[written..], n.x);
        written += copySlice(out[written..], ",\"y\":");
        written += writeInt(out[written..], n.y);
        written += copySlice(out[written..], "}");
    }

    written += copySlice(out[written..], "],\"edges\":[");

    // Route edges and write points
    var first_edge = true;
    for (edges[0..real_edge_count]) |e| {
        if (e.from_slice.len == 0) continue; // skip deleted edges
        const from_idx = findNodeIdx(nodes[0..node_count], e.from_slice) orelse continue;
        const to_idx = findNodeIdx(nodes[0..node_count], e.to_slice) orelse continue;

        if (!first_edge) written += copySlice(out[written..], ",");
        first_edge = false;

        written += copySlice(out[written..], "{\"from\":\"");
        written += copySlice(out[written..], e.from_slice);
        written += copySlice(out[written..], "\",\"to\":\"");
        written += copySlice(out[written..], e.to_slice);
        written += copySlice(out[written..], "\",\"points\":");

        written += routeEdge(out[written..], nodes, node_count, from_idx, to_idx, edges, edge_count);

        written += copySlice(out[written..], "}");
    }

    // Reconstruct routes for edges that were split into virtual segments.
    // Virtual nodes have empty id_slice, so we match them by virtual_edge_from/to
    // and collect their positions ordered by layer to build a multi-segment path.
    for (0..real_edge_count) |ei| {
        if (edges[ei].from_slice.len != 0) continue; // not a replaced edge

        // Find the original from/to by scanning virtual nodes for this edge index
        var orig_from: []const u8 = &.{};
        var orig_to: []const u8 = &.{};
        for (nodes[0..node_count]) |n| {
            if (!n.is_virtual) continue;
            if (n.virtual_edge_from.len > 0) {
                orig_from = n.virtual_edge_from;
                orig_to = n.virtual_edge_to;
                break;
            }
        }
        if (orig_from.len == 0) continue;

        // Collect waypoints: source center-bottom, virtual node positions, target center-top
        const from_idx = findNodeIdx(nodes[0..node_count], orig_from) orelse continue;
        const to_idx = findNodeIdx(nodes[0..node_count], orig_to) orelse continue;
        const src = nodes[from_idx];
        const tgt = nodes[to_idx];

        var waypoints_x: [MAX_LAYERS + 2]i32 = undefined;
        var waypoints_y: [MAX_LAYERS + 2]i32 = undefined;
        var wp_count: usize = 0;

        // Start point: source center-bottom
        waypoints_x[wp_count] = src.x + @divTrunc(src.width, 2);
        waypoints_y[wp_count] = src.y + src.height;
        wp_count += 1;

        // Virtual node positions (already sorted by layer from insertion order)
        for (nodes[0..node_count]) |n| {
            if (!n.is_virtual) continue;
            if (!std.mem.eql(u8, n.virtual_edge_from, orig_from)) continue;
            if (!std.mem.eql(u8, n.virtual_edge_to, orig_to)) continue;
            if (wp_count >= MAX_LAYERS + 2) break;
            waypoints_x[wp_count] = n.x;
            waypoints_y[wp_count] = n.y;
            wp_count += 1;
        }

        // End point: target center-top
        if (wp_count < MAX_LAYERS + 2) {
            waypoints_x[wp_count] = tgt.x + @divTrunc(tgt.width, 2);
            waypoints_y[wp_count] = tgt.y;
            wp_count += 1;
        }

        if (wp_count < 2) continue;

        if (!first_edge) written += copySlice(out[written..], ",");
        first_edge = false;

        written += copySlice(out[written..], "{\"from\":\"");
        written += copySlice(out[written..], orig_from);
        written += copySlice(out[written..], "\",\"to\":\"");
        written += copySlice(out[written..], orig_to);
        written += copySlice(out[written..], "\",\"points\":[");

        for (0..wp_count) |wi| {
            if (wi > 0) written += copySlice(out[written..], ",");
            written += copySlice(out[written..], "[");
            written += writeInt(out[written..], waypoints_x[wi]);
            written += copySlice(out[written..], ",");
            written += writeInt(out[written..], waypoints_y[wi]);
            written += copySlice(out[written..], "]");
        }

        written += copySlice(out[written..], "]}");
    }

    written += copySlice(out[written..], "]}");
    return written;
}

/// Check if an axis-aligned segment intersects a node's padded bounding box.
/// Handles both horizontal (y1==y2) and vertical (x1==x2) segments.
fn segmentHitsNode(x1: i32, y1: i32, x2: i32, y2: i32, node: Node, padding: i32) bool {
    if (node.is_virtual) return false;
    if (node.width == 0 and node.height == 0) return false;

    const rx = node.x - padding;
    const ry = node.y - padding;
    const rw = node.width + padding * 2;
    const rh = node.height + padding * 2;

    if (y1 == y2) {
        // Horizontal segment
        if (y1 < ry or y1 > ry + rh) return false;
        const seg_min = @min(x1, x2);
        const seg_max = @max(x1, x2);
        return seg_max > rx and seg_min < rx + rw;
    } else if (x1 == x2) {
        // Vertical segment
        if (x1 < rx or x1 > rx + rw) return false;
        const seg_min = @min(y1, y2);
        const seg_max = @max(y1, y2);
        return seg_max > ry and seg_min < ry + rh;
    }
    return false;
}

/// Find the first node whose bounding box is hit by the given segment.
/// Skips the source and target nodes (skip1, skip2).
fn findBlockingNode(x1: i32, y1: i32, x2: i32, y2: i32, nodes: []const Node, skip1: usize, skip2: usize, padding: i32) ?usize {
    for (nodes, 0..) |n, i| {
        if (i == skip1 or i == skip2) continue;
        if (segmentHitsNode(x1, y1, x2, y2, n, padding)) return i;
    }
    return null;
}

const OBSTACLE_PADDING: i32 = 20;

fn writePoint6(out: []u8, x1: i32, y1: i32, x2: i32, y2: i32, x3: i32, y3: i32, x4: i32, y4: i32, x5: i32, y5: i32, x6: i32, y6: i32) usize {
    var w: usize = 0;
    w += copySlice(out[w..], "[[");
    w += writeInt(out[w..], x1);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y1);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x2);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y2);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x3);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y3);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x4);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y4);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x5);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y5);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x6);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y6);
    w += copySlice(out[w..], "]]");
    return w;
}

/// Generate orthogonal edge route points as JSON array [[x,y],...]
fn routeEdge(
    out: []u8,
    nodes: *[MAX_NODES]Node,
    node_count: usize,
    from_idx: usize,
    to_idx: usize,
    edges: *[MAX_EDGES]Edge,
    edge_count: usize,
) usize {
    const src = nodes[from_idx];
    const tgt = nodes[to_idx];

    // Compute stagger for this source node
    var total_out: usize = 0;
    var edge_idx: usize = 0;
    var found_self = false;
    for (edges[0..edge_count]) |e| {
        if (e.from_slice.len == 0) continue;
        if (std.mem.eql(u8, e.from_slice, src.id_slice)) {
            total_out += 1;
            if (!found_self and std.mem.eql(u8, e.to_slice, tgt.id_slice)) {
                edge_idx = total_out - 1;
                found_self = true;
            }
        }
    }

    const stagger = computeStagger(edge_idx, total_out);

    const src_cx = src.x + @divTrunc(src.width, 2);
    const src_cy = src.y + @divTrunc(src.height, 2);
    const tgt_cx = tgt.x + @divTrunc(tgt.width, 2);
    const tgt_cy = tgt.y + @divTrunc(tgt.height, 2);

    const d_x = tgt_cx - src_cx;
    const d_y = tgt_cy - src_cy;
    const abs_dx = if (d_x < 0) -d_x else d_x;
    const abs_dy = if (d_y < 0) -d_y else d_y;

    var sx: i32 = undefined;
    var sy: i32 = undefined;
    var tx: i32 = undefined;
    var ty: i32 = undefined;
    var vertical = true;

    if (abs_dy >= abs_dx) {
        if (d_y >= 0) {
            sx = src.x + applyStagger(src.width, stagger);
            sy = src.y + src.height;
            tx = tgt.x + applyStagger(tgt.width, stagger);
            ty = tgt.y;
        } else {
            sx = src.x + applyStagger(src.width, stagger);
            sy = src.y;
            tx = tgt.x + applyStagger(tgt.width, stagger);
            ty = tgt.y + tgt.height;
        }
        vertical = true;
    } else {
        if (d_x >= 0) {
            sx = src.x + src.width;
            sy = src.y + applyStagger(src.height, stagger);
            tx = tgt.x;
            ty = tgt.y + applyStagger(tgt.height, stagger);
        } else {
            sx = src.x;
            sy = src.y + applyStagger(src.height, stagger);
            tx = tgt.x + tgt.width;
            ty = tgt.y + applyStagger(tgt.height, stagger);
        }
        vertical = false;
    }

    var written: usize = 0;

    const dx = tx - sx;
    const dy = ty - sy;
    const adx = if (dx < 0) -dx else dx;
    const ady = if (dy < 0) -dy else dy;
    const all_nodes = nodes[0..node_count];

    if (vertical) {
        if (adx < 10) {
            // Straight vertical — check for obstacle
            if (findBlockingNode(sx, sy, tx, ty, all_nodes, from_idx, to_idx, OBSTACLE_PADDING)) |blocker| {
                // Convert to 4-point elbow that goes around the obstacle
                const obs = all_nodes[blocker];
                const obs_left = obs.x - OBSTACLE_PADDING;
                const obs_right = obs.x + obs.width + OBSTACLE_PADDING;
                const mid_y = sy + @divTrunc(dy, 2);
                // Pick the side closer to sx
                const detour_x = if ((sx - obs_left) < (obs_right - sx) and (sx - obs_left) >= 0)
                    obs_left
                else if ((obs_right - sx) <= (sx - obs_left))
                    obs_right
                else
                    obs_right;
                written += writePoint4(out[written..], sx, sy, sx, mid_y, detour_x, mid_y, tx, ty);
                // Recheck: does the new middle segment still hit something?
                // If so, try a 6-point S-route
                if (findBlockingNode(sx, mid_y, detour_x, mid_y, all_nodes, from_idx, to_idx, OBSTACLE_PADDING) != null) {
                    // 6-point: go fully to detour_x side
                    written = 0;
                    written += writePoint6(out[written..], sx, sy, sx, mid_y, detour_x, mid_y, detour_x, ty, tx, ty, tx, ty);
                }
            } else {
                written += writePoint2(out[written..], sx, sy, tx, ty);
            }
        } else {
            const mid_y = sy + @divTrunc(dy, 2);
            // Check middle segment (horizontal: sx,mid_y → tx,mid_y) for obstacles
            if (findBlockingNode(sx, mid_y, tx, mid_y, all_nodes, from_idx, to_idx, OBSTACLE_PADDING)) |blocker| {
                const obs = all_nodes[blocker];
                const obs_top = obs.y - OBSTACLE_PADDING;
                const obs_bottom = obs.y + obs.height + OBSTACLE_PADDING;
                // Shift mid_y above or below the obstacle
                const dist_above = if (mid_y >= obs_top) mid_y - obs_top else std.math.maxInt(i32);
                const dist_below = if (obs_bottom >= mid_y) obs_bottom - mid_y else std.math.maxInt(i32);
                const shifted_y = if (dist_above <= dist_below) obs_top else obs_bottom;
                // Check if the shifted route still hits something
                if (findBlockingNode(sx, shifted_y, tx, shifted_y, all_nodes, from_idx, to_idx, OBSTACLE_PADDING) != null) {
                    // 6-point S-route: go around obstacle entirely
                    const detour_x = if (sx < obs.x + @divTrunc(obs.width, 2))
                        obs.x - OBSTACLE_PADDING
                    else
                        obs.x + obs.width + OBSTACLE_PADDING;
                    written += writePoint6(out[written..], sx, sy, sx, shifted_y, detour_x, shifted_y, detour_x, ty, tx, ty, tx, ty);
                } else {
                    written += writePoint4(out[written..], sx, sy, sx, shifted_y, tx, shifted_y, tx, ty);
                }
            } else {
                written += writePoint4(out[written..], sx, sy, sx, mid_y, tx, mid_y, tx, ty);
            }
        }
    } else {
        if (ady < 10) {
            // Straight horizontal — check for obstacle
            if (findBlockingNode(sx, sy, tx, ty, all_nodes, from_idx, to_idx, OBSTACLE_PADDING)) |blocker| {
                const obs = all_nodes[blocker];
                const obs_top = obs.y - OBSTACLE_PADDING;
                const obs_bottom = obs.y + obs.height + OBSTACLE_PADDING;
                const mid_x = sx + @divTrunc(dx, 2);
                const detour_y = if ((sy - obs_top) < (obs_bottom - sy) and (sy - obs_top) >= 0)
                    obs_top
                else if ((obs_bottom - sy) <= (sy - obs_top))
                    obs_bottom
                else
                    obs_bottom;
                written += writePoint4(out[written..], sx, sy, mid_x, sy, mid_x, detour_y, tx, ty);
                if (findBlockingNode(mid_x, sy, mid_x, detour_y, all_nodes, from_idx, to_idx, OBSTACLE_PADDING) != null) {
                    written = 0;
                    written += writePoint6(out[written..], sx, sy, mid_x, sy, mid_x, detour_y, tx, detour_y, tx, ty, tx, ty);
                }
            } else {
                written += writePoint2(out[written..], sx, sy, tx, ty);
            }
        } else {
            const mid_x = sx + @divTrunc(dx, 2);
            // Check middle segment (vertical: mid_x,sy → mid_x,ty) for obstacles
            if (findBlockingNode(mid_x, sy, mid_x, ty, all_nodes, from_idx, to_idx, OBSTACLE_PADDING)) |blocker| {
                const obs = all_nodes[blocker];
                const obs_left = obs.x - OBSTACLE_PADDING;
                const obs_right = obs.x + obs.width + OBSTACLE_PADDING;
                const dist_left = if (mid_x >= obs_left) mid_x - obs_left else std.math.maxInt(i32);
                const dist_right = if (obs_right >= mid_x) obs_right - mid_x else std.math.maxInt(i32);
                const shifted_x = if (dist_left <= dist_right) obs_left else obs_right;
                if (findBlockingNode(shifted_x, sy, shifted_x, ty, all_nodes, from_idx, to_idx, OBSTACLE_PADDING) != null) {
                    const detour_y = if (sy < obs.y + @divTrunc(obs.height, 2))
                        obs.y - OBSTACLE_PADDING
                    else
                        obs.y + obs.height + OBSTACLE_PADDING;
                    written += writePoint6(out[written..], sx, sy, shifted_x, sy, shifted_x, detour_y, tx, detour_y, tx, ty, tx, ty);
                } else {
                    written += writePoint4(out[written..], sx, sy, shifted_x, sy, shifted_x, ty, tx, ty);
                }
            } else {
                written += writePoint4(out[written..], sx, sy, mid_x, sy, mid_x, ty, tx, ty);
            }
        }
    }

    return written;
}

fn writePoint2(out: []u8, x1: i32, y1: i32, x2: i32, y2: i32) usize {
    var w: usize = 0;
    w += copySlice(out[w..], "[[");
    w += writeInt(out[w..], x1);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y1);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x2);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y2);
    w += copySlice(out[w..], "]]");
    return w;
}

fn writePoint4(out: []u8, x1: i32, y1: i32, x2: i32, y2: i32, x3: i32, y3: i32, x4: i32, y4: i32) usize {
    var w: usize = 0;
    w += copySlice(out[w..], "[[");
    w += writeInt(out[w..], x1);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y1);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x2);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y2);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x3);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y3);
    w += copySlice(out[w..], "],[");
    w += writeInt(out[w..], x4);
    w += copySlice(out[w..], ",");
    w += writeInt(out[w..], y4);
    w += copySlice(out[w..], "]]");
    return w;
}

/// Compute stagger ratio ×100 for an arrow at given index out of total count.
fn computeStagger(idx: usize, total: usize) i32 {
    if (total <= 1) return 50;
    const positions = [_]i32{ 50, 35, 65, 20, 80 };
    if (idx < positions.len) return positions[idx];
    return 50;
}

fn applyStagger(dim: i32, stagger: i32) i32 {
    return @divTrunc(dim * stagger, 100);
}

fn findNodeIdx(nodes: []const Node, id: []const u8) ?usize {
    for (nodes, 0..) |n, i| {
        if (std.mem.eql(u8, n.id_slice, id)) return i;
    }
    return null;
}

// ── JSON Parsing ──

fn parseNodes(json: []const u8, out: *[MAX_NODES]Node) !usize {
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
            node.group = extractStringField(obj, "group") orelse &.{};

            out[count] = node;
            count += 1;
            pos = obj_end;
        }
        pos += 1;
    }

    return count;
}

fn parseEdges(json: []const u8, out: *[MAX_EDGES]Edge) !usize {
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

            out[count] = edge;
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

test "layout with explicit positions" {
    const nodes =
        \\[{"id":"a","width":180,"height":80,"row":0,"col":0},{"id":"b","width":180,"height":80,"row":1,"col":1}]
    ;
    const edges_json =
        \\[{"from":"a","to":"b"}]
    ;
    var out: [8192]u8 = undefined;
    const written = try layoutGraph(nodes, edges_json, &out);
    try std.testing.expect(written > 0);

    const result = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "\"nodes\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"edges\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"x\":100") != null);
}

test "layout with auto-assignment" {
    const nodes =
        \\[{"id":"a","width":180,"height":80},{"id":"b","width":180,"height":80},{"id":"c","width":180,"height":80}]
    ;
    const edges_json =
        \\[{"from":"a","to":"b"},{"from":"b","to":"c"}]
    ;
    var out: [8192]u8 = undefined;
    const written = try layoutGraph(nodes, edges_json, &out);
    try std.testing.expect(written > 0);

    const result = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "\"points\"") != null);
}

test "layout with no edges" {
    const nodes =
        \\[{"id":"x","width":180,"height":80}]
    ;
    const edges_json =
        \\[]
    ;
    var out: [4096]u8 = undefined;
    const written = try layoutGraph(nodes, edges_json, &out);
    try std.testing.expect(written > 0);
    const result = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "\"x\"") != null);
}

test "crossing minimization reduces crossings" {
    const nodes =
        \\[{"id":"a","width":180,"height":80},{"id":"b","width":180,"height":80},{"id":"c","width":180,"height":80},{"id":"d","width":180,"height":80}]
    ;
    const edges_json =
        \\[{"from":"a","to":"b"},{"from":"a","to":"c"},{"from":"b","to":"d"},{"from":"c","to":"d"}]
    ;
    var out: [16384]u8 = undefined;
    const written = try layoutGraph(nodes, edges_json, &out);
    try std.testing.expect(written > 0);
    const result = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "\"nodes\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"edges\"") != null);
}
