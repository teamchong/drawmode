/**
 * C bridge implementation — wraps Graphviz internals into simple types
 * that Zig can import without @cImport bitfield issues.
 */

#include "config.h"
#include <cgraph/cgraph.h>
#include <gvc/gvc.h>
#include <common/types.h>
#include "gviz_bridge.h"

/* Plugin registration */
extern gvplugin_library_t gvplugin_dot_layout_LTX_library;

static lt_symlist_t builtin_plugins[] = {
    { "gvplugin_dot_layout_LTX_library", (void*)&gvplugin_dot_layout_LTX_library },
    { 0, 0 }
};

gviz_context_t gviz_context_new(void) {
    return (gviz_context_t)gvContextPlugins(builtin_plugins, 0);
}

void gviz_context_free(gviz_context_t ctx) {
    if (ctx) gvFreeContext((GVC_t*)ctx);
}

gviz_graph_t gviz_parse_dot(const char *dot_string) {
    return (gviz_graph_t)agmemread(dot_string);
}

void gviz_graph_close(gviz_graph_t g) {
    if (g) agclose((Agraph_t*)g);
}

int gviz_layout(gviz_context_t ctx, gviz_graph_t g) {
    return gvLayout((GVC_t*)ctx, (Agraph_t*)g, "dot");
}

void gviz_free_layout(gviz_context_t ctx, gviz_graph_t g) {
    gvFreeLayout((GVC_t*)ctx, (Agraph_t*)g);
}

gviz_node_t gviz_first_node(gviz_graph_t g) {
    return (gviz_node_t)agfstnode((Agraph_t*)g);
}

gviz_node_t gviz_next_node(gviz_graph_t g, gviz_node_t n) {
    return (gviz_node_t)agnxtnode((Agraph_t*)g, (Agnode_t*)n);
}

const char* gviz_node_name(gviz_node_t n) {
    return agnameof(n);
}

void gviz_node_coord(gviz_node_t n, double *x, double *y) {
    Agnode_t *node = (Agnode_t*)n;
    *x = ND_coord(node).x;
    *y = ND_coord(node).y;
}

gviz_edge_t gviz_first_out_edge(gviz_graph_t g, gviz_node_t n) {
    return (gviz_edge_t)agfstout((Agraph_t*)g, (Agnode_t*)n);
}

gviz_edge_t gviz_next_out_edge(gviz_graph_t g, gviz_edge_t e) {
    return (gviz_edge_t)agnxtout((Agraph_t*)g, (Agedge_t*)e);
}

gviz_node_t gviz_edge_head(gviz_edge_t e) {
    return (gviz_node_t)aghead((Agedge_t*)e);
}

gviz_node_t gviz_edge_tail(gviz_edge_t e) {
    return (gviz_node_t)agtail((Agedge_t*)e);
}

int gviz_edge_spline(gviz_edge_t e, gviz_spline_t *out) {
    Agedge_t *edge = (Agedge_t*)e;
    splines *spl = ED_spl(edge);
    if (!spl || spl->size == 0) return 0;

    bezier *bz = &spl->list[0];
    out->point_count = bz->size;
    out->points = (const gviz_point_t*)bz->list;
    out->has_start_point = (bz->sflag != 0);
    out->start_point.x = bz->sp.x;
    out->start_point.y = bz->sp.y;
    out->has_end_point = (bz->eflag != 0);
    out->end_point.x = bz->ep.x;
    out->end_point.y = bz->ep.y;
    return 1;
}

gviz_bbox_t gviz_graph_bbox(gviz_graph_t g) {
    Agraph_t *graph = (Agraph_t*)g;
    boxf bb = GD_bb(graph);
    gviz_bbox_t result;
    result.ll_x = bb.LL.x;
    result.ll_y = bb.LL.y;
    result.ur_x = bb.UR.x;
    result.ur_y = bb.UR.y;
    return result;
}

/* ── Functions referenced by Graphviz internals but not needed for layout-only use ──
 *
 * The dot layout engine calls into render/emit/HTML-label systems during
 * spline computation and label sizing. We provide these so the linker
 * is satisfied. They are no-ops because we only extract positions and
 * spline coordinates after layout, never render output.
 */

#include <gvc/gvcjob.h>
#include <string.h>

/* Render functions — called by arrows.c, shapes.c, labels.c, splines.c */
void gvrender_polygon(GVJ_t *j, pointf *a, size_t n, int f) { (void)j;(void)a;(void)n;(void)f; }
void gvrender_polyline(GVJ_t *j, pointf *a, size_t n) { (void)j;(void)a;(void)n; }
void gvrender_ellipse(GVJ_t *j, pointf *a, size_t n, int f) { (void)j;(void)a;(void)n;(void)f; }
void gvrender_beziercurve(GVJ_t *j, pointf *a, size_t n, int f) { (void)j;(void)a;(void)n;(void)f; }
void gvrender_box(GVJ_t *j, boxf b, int f) { (void)j;(void)b;(void)f; }
void gvrender_begin_anchor(GVJ_t *j, char *h, char *t, char *ta, char *id) { (void)j;(void)h;(void)t;(void)ta;(void)id; }
void gvrender_end_anchor(GVJ_t *j) { (void)j; }
void gvrender_begin_label(GVJ_t *j, label_type t) { (void)j;(void)t; }
void gvrender_end_label(GVJ_t *j) { (void)j; }
void gvrender_set_pencolor(GVJ_t *j, char *c) { (void)j;(void)c; }
void gvrender_set_fillcolor(GVJ_t *j, char *c) { (void)j;(void)c; }
void gvrender_set_gradient_vals(GVJ_t *j, char *s, int t, double a) { (void)j;(void)s;(void)t;(void)a; }
void gvrender_set_penwidth(GVJ_t *j, double w) { (void)j;(void)w; }
void gvrender_set_style(GVJ_t *j, char **s) { (void)j;(void)s; }
void gvrender_textspan(GVJ_t *j, pointf p, textspan_t *s) { (void)j;(void)p;(void)s; }
void gvrender_usershape(GVJ_t *j, char *n, pointf *a, size_t s, int f, char *iu, char *ip) { (void)j;(void)n;(void)a;(void)s;(void)f;(void)iu;(void)ip; }

/* Text layout — returns false (no text measurement in WASM, layout uses defaults) */
int gvtextlayout(GVC_t *gvc, textspan_t *span, char **fp) { (void)gvc;(void)span;(void)fp; return 0; }

/* User shape sizing — returns false (no image loading) */
int gvusershape_size(graph_t *g, char *name) { (void)g;(void)name; return 0; }

/* HTML label functions — not supported (no expat parser) */
int make_html_label(void *obj, textlabel_t *lp) { (void)obj; if(lp) lp->dimen.x = lp->dimen.y = 0; return 0; }
void free_html_label(textlabel_t *lp, int root) { (void)lp;(void)root; }
void emit_html_label(GVJ_t *j, htmllabel_t *lp, textlabel_t *tp) { (void)j;(void)lp;(void)tp; }
int html_port(node_t *n, char *pname, port *pp) { (void)n;(void)pname;(void)pp; return 0; }

/* Emit functions */
int emit_once(char *s) { (void)s; return 0; }
void emit_once_reset(void) {}

/* EPS functions */
void epsf_init(node_t *n) { (void)n; }
void epsf_free(node_t *n) { (void)n; }

/* Style parsing */
char **parse_style(char *s) { (void)s; return NULL; }

/* Color gradient stop parsing */
char *findStopColor(char *c, float *f) { (void)f; return c; }

/* Striped/wedged shapes — rendering-only, not used during layout positioning */
void stripedBox(GVJ_t *j, pointf *a, char *c, int f) { (void)j;(void)a;(void)c;(void)f; }
int wedgedEllipse(GVJ_t *j, pointf *a, char *c) { (void)j;(void)a;(void)c; return 0; }

/* Spline bounding box update */
void update_bb_bz(boxf *bb, pointf *cp) { (void)bb;(void)cp; }

/* xdot initialization */
void init_xdot(Agraph_t *g) { (void)g; }

/* Locale handling */
void gv_fixLocale(int set) { (void)set; }

/* Plugin config loading (filesystem-based, not needed with builtins) */
void gvconfig(GVC_t *gvc, int c) { (void)gvc;(void)c; }

/* Graph reading from FILE* — not needed, we use agmemread */
Agraph_t *agread(void *chan, Agdisc_t *disc) { (void)chan;(void)disc; return NULL; }
Agraph_t *agconcat(Agraph_t *g, const char *filename, void *chan, Agdisc_t *disc) { (void)g;(void)filename;(void)chan;(void)disc; return NULL; }

/* Thread-safe stdio (WASI is single-threaded) */
void flockfile(void *f) { (void)f; }
void funlockfile(void *f) { (void)f; }

/* Required by WASI libc startup */
int main(void) {
    return 0;
}
