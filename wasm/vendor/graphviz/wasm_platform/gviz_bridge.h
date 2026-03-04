/**
 * C bridge for Zig FFI — exposes Graphviz functions with simple types
 * that Zig can handle (no bitfield structs).
 */
#ifndef GVIZ_BRIDGE_H
#define GVIZ_BRIDGE_H

#include <stddef.h>

/* Opaque handle types (Zig treats these as *anyopaque) */
typedef void* gviz_graph_t;
typedef void* gviz_node_t;
typedef void* gviz_edge_t;
typedef void* gviz_context_t;

/* Spline point */
typedef struct {
    double x;
    double y;
} gviz_point_t;

/* Spline data for an edge */
typedef struct {
    size_t point_count;
    const gviz_point_t *points;
    int has_start_point;
    gviz_point_t start_point;
    int has_end_point;
    gviz_point_t end_point;
} gviz_spline_t;

/* Bounding box */
typedef struct {
    double ll_x, ll_y;
    double ur_x, ur_y;
} gviz_bbox_t;

/* Initialize Graphviz with built-in dot layout plugin */
gviz_context_t gviz_context_new(void);
void gviz_context_free(gviz_context_t ctx);

/* Graph operations */
gviz_graph_t gviz_parse_dot(const char *dot_string);
void gviz_graph_close(gviz_graph_t g);
int gviz_layout(gviz_context_t ctx, gviz_graph_t g);
void gviz_free_layout(gviz_context_t ctx, gviz_graph_t g);

/* Node iteration */
gviz_node_t gviz_first_node(gviz_graph_t g);
gviz_node_t gviz_next_node(gviz_graph_t g, gviz_node_t n);
const char* gviz_node_name(gviz_node_t n);
void gviz_node_coord(gviz_node_t n, double *x, double *y);

/* Edge iteration */
gviz_edge_t gviz_first_out_edge(gviz_graph_t g, gviz_node_t n);
gviz_edge_t gviz_next_out_edge(gviz_graph_t g, gviz_edge_t e);
gviz_node_t gviz_edge_head(gviz_edge_t e);
gviz_node_t gviz_edge_tail(gviz_edge_t e);

/* Edge spline data */
int gviz_edge_spline(gviz_edge_t e, gviz_spline_t *out);

/* Graph bounding box */
gviz_bbox_t gviz_graph_bbox(gviz_graph_t g);

#endif /* GVIZ_BRIDGE_H */
