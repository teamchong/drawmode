const std = @import("std");

const graphviz_c_sources = [_][]const u8{
    "lib/cdt/dtclose.c",
    "lib/cdt/dtdisc.c",
    "lib/cdt/dtextract.c",
    "lib/cdt/dtflatten.c",
    "lib/cdt/dthash.c",
    "lib/cdt/dtmethod.c",
    "lib/cdt/dtopen.c",
    "lib/cdt/dtrenew.c",
    "lib/cdt/dtrestore.c",
    "lib/cdt/dtsize.c",
    "lib/cdt/dtstat.c",
    "lib/cdt/dtstrhash.c",
    "lib/cdt/dttree.c",
    "lib/cdt/dtview.c",
    "lib/cdt/dtwalk.c",
    "lib/cgraph/acyclic.c",
    "lib/cgraph/agerror.c",
    "lib/cgraph/apply.c",
    "lib/cgraph/attr.c",
    "lib/cgraph/edge.c",
    "lib/cgraph/graph.c",
    "lib/cgraph/id.c",
    "lib/cgraph/imap.c",
    "lib/cgraph/io.c",
    "lib/cgraph/node_induce.c",
    "lib/cgraph/node.c",
    "lib/cgraph/obj.c",
    "lib/cgraph/rec.c",
    "lib/cgraph/refstr.c",
    "lib/cgraph/subg.c",
    "lib/cgraph/tred.c",
    "lib/cgraph/unflatten.c",
    "lib/cgraph/utils.c",
    "lib/cgraph/write.c",
    "lib/common/arrows.c",
    "lib/common/colxlate.c",
    "lib/common/ellipse.c",
    "lib/common/geom.c",
    "lib/common/globals.c",
    "lib/common/input.c",
    "lib/common/labels.c",
    "lib/common/ns.c",
    "lib/common/pointset.c",
    "lib/common/postproc.c",
    "lib/common/routespl.c",
    "lib/common/shapes.c",
    "lib/common/splines.c",
    "lib/common/taper.c",
    "lib/common/textspan_lut.c",
    "lib/common/textspan.c",
    "lib/common/timing.c",
    "lib/common/utils.c",
    "lib/dotgen/acyclic.c",
    "lib/dotgen/aspect.c",
    "lib/dotgen/class1.c",
    "lib/dotgen/class2.c",
    "lib/dotgen/cluster.c",
    "lib/dotgen/compound.c",
    "lib/dotgen/conc.c",
    "lib/dotgen/decomp.c",
    "lib/dotgen/dotinit.c",
    "lib/dotgen/dotsplines.c",
    "lib/dotgen/fastgr.c",
    "lib/dotgen/flat.c",
    "lib/dotgen/mincross.c",
    "lib/dotgen/position.c",
    "lib/dotgen/rank.c",
    "lib/dotgen/sameport.c",
    "lib/gvc/gvc.c",
    "lib/gvc/gvcontext.c",
    "lib/gvc/gvjobs.c",
    "lib/gvc/gvlayout.c",
    "lib/gvc/gvplugin.c",
    "lib/label/index.c",
    "lib/label/node.c",
    "lib/label/rectangle.c",
    "lib/label/split.q.c",
    "lib/label/xlabels.c",
    "lib/ortho/fPQ.c",
    "lib/ortho/maze.c",
    "lib/ortho/ortho.c",
    "lib/ortho/partition.c",
    "lib/ortho/rawgraph.c",
    "lib/ortho/sgraph.c",
    "lib/ortho/trapezoid.c",
    "lib/pack/ccomps.c",
    "lib/pack/pack.c",
    "lib/pathplan/cvt.c",
    "lib/pathplan/inpoly.c",
    "lib/pathplan/route.c",
    "lib/pathplan/shortest.c",
    "lib/pathplan/shortestpth.c",
    "lib/pathplan/solvers.c",
    "lib/pathplan/triang.c",
    "lib/pathplan/util.c",
    "lib/pathplan/visibility.c",
    "lib/util/arena.c",
    "lib/util/base64.c",
    "lib/util/list.c",
    "lib/util/random.c",
    "lib/util/xml.c",
    "lib/xdot/xdot.c",
    "plugin/dot_layout/gvlayout_dot_layout.c",
    "plugin/dot_layout/gvplugin_dot_layout.c",
    "wasm_platform/gviz_bridge.c",
};

const graphviz_c_flags = [_][]const u8{
    "-DHAVE_CONFIG_H",
    "-DNONDLL",
    "-std=c11",
    "-O2",
    "-fno-strict-aliasing",
    // Suppress warnings in vendored code
    "-Wno-unused-parameter",
    "-Wno-sign-compare",
    "-Wno-implicit-function-declaration",
    "-Wno-incompatible-pointer-types",
    "-Wno-pointer-sign",
    "-Wno-unused-variable",
    "-Wno-missing-field-initializers",
    "-Wno-int-conversion",
    "-Wno-unused-but-set-variable",
};

pub fn build(b: *std.Build) void {
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
    });

    const wasm = b.addExecutable(.{
        .name = "drawmode",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = wasm_target,
            .optimize = .ReleaseSmall,
            .link_libc = true,
        }),
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    wasm.export_memory = true;

    // Add Graphviz C source files
    const graphviz_root = b.path("vendor/graphviz");
    wasm.addCSourceFiles(.{
        .root = graphviz_root,
        .files = &graphviz_c_sources,
        .flags = &graphviz_c_flags,
    });

    // Include paths for Graphviz headers:
    // - vendor/graphviz/ for "config.h"
    // - vendor/graphviz/lib/ for <cgraph/cgraph.h>, <gvc/gvc.h>, etc.
    // - per-library dirs for internal includes like <cgraph.h>, <cdt.h>, <pathgeom.h>
    wasm.addIncludePath(b.path("vendor/graphviz"));
    wasm.addIncludePath(b.path("vendor/graphviz/lib"));
    wasm.addIncludePath(b.path("vendor/graphviz/plugin"));
    // Internal headers reference siblings without directory prefix
    const lib_subdirs = [_][]const u8{
        "vendor/graphviz/lib/cdt",
        "vendor/graphviz/lib/cgraph",
        "vendor/graphviz/lib/common",
        "vendor/graphviz/lib/dotgen",
        "vendor/graphviz/lib/gvc",
        "vendor/graphviz/lib/label",
        "vendor/graphviz/lib/ortho",
        "vendor/graphviz/lib/pack",
        "vendor/graphviz/lib/pathplan",
        "vendor/graphviz/lib/util",
        "vendor/graphviz/lib/xdot",
        "vendor/graphviz/lib/fdpgen",
    };
    for (lib_subdirs) |subdir| {
        wasm.addIncludePath(b.path(subdir));
    }

    const install_wasm = b.addInstallArtifact(wasm, .{});
    b.getInstallStep().dependOn(&install_wasm.step);

    const wasm_step = b.step("wasm", "Build WASM module");
    wasm_step.dependOn(&install_wasm.step);

    // Native tests (Zig only, no Graphviz C for native tests)
    const target = b.standardTargetOptions(.{});
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
        }),
    });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
