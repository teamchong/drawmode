const std = @import("std");

/// Simple layered graph layout.
///
/// Input JSON format (nodes):
///   [{"id":"box_1","width":180,"height":80,"row":0,"col":1}, ...]
/// Input JSON format (edges):
///   [{"from":"box_1","to":"box_2"}, ...]
/// Output JSON format:
///   [{"id":"box_1","x":340,"y":100}, ...]
///
/// Layout strategy:
/// 1. If nodes have explicit row/col, use grid placement
/// 2. Otherwise, do topological sort for layer assignment + greedy column ordering
pub fn layoutGraph(nodes_json: []const u8, edges_json: []const u8, out: []u8) !usize {
    // Parse nodes
    var nodes: [128]Node = undefined;
    var node_count: usize = 0;
    node_count = parseNodes(nodes_json, &nodes) catch return 0;

    // Parse edges
    var edges: [256]Edge = undefined;
    var edge_count: usize = 0;
    edge_count = parseEdges(edges_json, &edges) catch return 0;

    // Check if all nodes have explicit positions
    var all_explicit = true;
    for (nodes[0..node_count]) |n| {
        if (n.row == null or n.col == null) {
            all_explicit = false;
            break;
        }
    }

    if (!all_explicit) {
        assignLayers(&nodes, node_count, &edges, edge_count);
    }

    // Apply grid positioning
    const col_spacing: i32 = 280;
    const row_spacing: i32 = 220;
    const base_x: i32 = 100;
    const base_y: i32 = 100;

    // Write output
    var written: usize = 0;
    written += copySlice(out[written..], "[");

    for (nodes[0..node_count], 0..) |n, i| {
        if (i > 0) written += copySlice(out[written..], ",");

        const row = n.row orelse 0;
        const col = n.col orelse 0;
        const x = base_x + col * col_spacing;
        const y = base_y + row * row_spacing;

        // {"id":"...","x":NNN,"y":NNN}
        written += copySlice(out[written..], "{\"id\":\"");
        written += copySlice(out[written..], n.id_slice);
        written += copySlice(out[written..], "\",\"x\":");
        written += writeInt(out[written..], x);
        written += copySlice(out[written..], ",\"y\":");
        written += writeInt(out[written..], y);
        written += copySlice(out[written..], "}");
    }

    written += copySlice(out[written..], "]");
    return written;
}

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

fn assignLayers(nodes: *[128]Node, count: usize, edges: *[256]Edge, edge_count: usize) void {
    // Simple topological layer assignment
    var in_degree: [128]i32 = [_]i32{0} ** 128;

    for (edges[0..edge_count]) |e| {
        const to_idx = findNodeIdx(nodes[0..count], e.to_slice);
        if (to_idx) |idx| {
            in_degree[idx] += 1;
        }
    }

    var layer: i32 = 0;
    var assigned: [128]bool = [_]bool{false} ** 128;
    var total_assigned: usize = 0;

    while (total_assigned < count) : (layer += 1) {
        var col: i32 = 0;
        for (0..count) |i| {
            if (!assigned[i] and in_degree[i] == 0) {
                if (nodes[i].row == null) nodes[i].row = layer;
                if (nodes[i].col == null) nodes[i].col = col;
                assigned[i] = true;
                total_assigned += 1;
                col += 1;
            }
        }

        // Decrease in-degree for successors
        for (0..count) |i| {
            if (assigned[i]) {
                for (edges[0..edge_count]) |e| {
                    if (std.mem.eql(u8, e.from_slice, nodes[i].id_slice)) {
                        const to_idx = findNodeIdx(nodes[0..count], e.to_slice);
                        if (to_idx) |idx| {
                            if (in_degree[idx] > 0) in_degree[idx] -= 1;
                        }
                    }
                }
            }
        }

        // Safety: break if no progress (cyclic graph)
        if (col == 0) break;
    }
}

fn findNodeIdx(nodes: []const Node, id: []const u8) ?usize {
    for (nodes, 0..) |n, i| {
        if (std.mem.eql(u8, n.id_slice, id)) return i;
    }
    return null;
}

// Minimal JSON parsing helpers (no allocator needed)

fn parseNodes(json: []const u8, out: *[128]Node) !usize {
    var count: usize = 0;
    var pos: usize = 0;

    // Skip to first '{'
    while (pos < json.len and json[pos] != '{') : (pos += 1) {}

    while (pos < json.len and count < 128) {
        if (json[pos] == '{') {
            var node = Node{ .id_slice = &.{}, .width = 180, .height = 80, .row = null, .col = null };

            // Find fields in this object
            const obj_end = findMatchingBrace(json[pos..]) + pos;
            const obj = json[pos..obj_end];

            node.id_slice = extractStringField(obj, "id") orelse &.{};
            node.width = extractIntField(obj, "width") orelse 180;
            node.height = extractIntField(obj, "height") orelse 80;
            node.row = extractIntField(obj, "row");
            node.col = extractIntField(obj, "col");

            out[count] = node;
            count += 1;
            pos = obj_end;
        }
        pos += 1;
    }

    return count;
}

fn parseEdges(json: []const u8, out: *[256]Edge) !usize {
    var count: usize = 0;
    var pos: usize = 0;

    while (pos < json.len and json[pos] != '{') : (pos += 1) {}

    while (pos < json.len and count < 256) {
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
    // Find "field":"value"
    var i: usize = 0;
    while (i + field.len + 3 < obj.len) : (i += 1) {
        if (obj[i] == '"' and i + 1 + field.len < obj.len and
            std.mem.eql(u8, obj[i + 1 .. i + 1 + field.len], field) and
            obj[i + 1 + field.len] == '"')
        {
            // Skip to value
            var j = i + 1 + field.len + 1; // past closing quote
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

            // Check for null
            if (j + 4 <= obj.len and std.mem.eql(u8, obj[j .. j + 4], "null")) return null;

            // Parse integer (possibly negative)
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

    var i: usize = 0;
    while (i < digit_count) : (i += 1) {
        dst[len + i] = buf[digit_count - 1 - i];
    }

    return len + digit_count;
}

test "layout with explicit positions" {
    const nodes =
        \\[{"id":"a","width":180,"height":80,"row":0,"col":0},{"id":"b","width":180,"height":80,"row":1,"col":1}]
    ;
    const edges =
        \\[{"from":"a","to":"b"}]
    ;
    var out: [4096]u8 = undefined;
    const written = try layoutGraph(nodes, edges, &out);
    try std.testing.expect(written > 0);

    const result = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, result, "\"x\":100") != null);
}
