/**
 * Layout bridge — Graphviz (via @hpcc-js/wasm-graphviz) for graph layout,
 * Zig WASM for SVG rendering and validation.
 *
 * Layout priority: Graphviz → Zig WASM grid → TS grid (in sdk.ts)
 */

let _dirname: string | undefined;
async function getDirname(): Promise<string> {
  if (!_dirname) {
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    _dirname = dirname(fileURLToPath(import.meta.url));
  }
  return _dirname;
}

// ── Graphviz layout via @hpcc-js/wasm-graphviz ──

export interface GraphvizEdgeRoute {
  /** Absolute Excalidraw-coordinate points for the arrow path */
  points: [number, number][];
  /** Label position in Excalidraw coordinates */
  labelPos?: { x: number; y: number };
}

export interface GraphvizLayoutResult {
  nodes: { id: string; x: number; y: number }[];
  edgeRoutes: Map<string, GraphvizEdgeRoute>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let graphvizPromise: Promise<any> | null = null;

function getGraphviz() {
  if (!graphvizPromise) {
    graphvizPromise = import("@hpcc-js/wasm-graphviz")
      .then(mod => mod.Graphviz.load())
      .catch(() => null);
  }
  return graphvizPromise;
}

export async function layoutGraphGraphviz(
  nodes: { id: string; width: number; height: number; row?: number; col?: number; absX?: number; absY?: number; type?: string }[],
  edges: { from: string; to: string; label?: string }[],
  groups?: { id: string; label: string; children: string[] }[],
): Promise<GraphvizLayoutResult | null> {
  const gv = await getGraphviz();
  if (!gv) return null;

  const dotString = generateDot(nodes, edges, groups);

  try {
    const resultStr = gv.dot(dotString, "json");
    return parseJson0Result(JSON.parse(resultStr), nodes);
  } catch {
    // ortho splines can fail on some graph topologies — try polyline
    try {
      const fallbackDot = dotString.replace("splines=ortho", "splines=polyline");
      const resultStr = gv.dot(fallbackDot, "json");
      return parseJson0Result(JSON.parse(resultStr), nodes);
    } catch {
      return null;
    }
  }
}

function generateDot(
  nodes: { id: string; width: number; height: number; row?: number; col?: number; type?: string }[],
  edges: { from: string; to: string; label?: string }[],
  groups?: { id: string; label: string; children: string[] }[],
): string {
  const lines: string[] = [];
  lines.push("digraph G {");
  lines.push("  rankdir=TB;");
  lines.push("  newrank=true;");
  lines.push("  ranksep=1.5;");
  lines.push("  nodesep=1.0;");
  lines.push("  splines=ortho;");
  lines.push("  node [shape=box];");

  // Cluster subgraphs for groups
  const groupedNodeIds = new Set<string>();
  if (groups) {
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    for (const group of groups) {
      const clusterId = group.id.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  subgraph cluster_${clusterId} {`);
      lines.push(`    label="${escapeDot(group.label)}";`);
      lines.push("    style=dashed;");
      lines.push('    color="#868e96";');
      for (const childId of group.children) {
        const node = nodeById.get(childId);
        if (node) {
          const gvShape = node.type === "diamond" ? " shape=diamond" : "";
          lines.push(`    "${escapeDot(node.id)}" [width=${(node.width / 72).toFixed(4)} height=${(node.height / 72).toFixed(4)}${gvShape}];`);
          groupedNodeIds.add(node.id);
        }
      }
      lines.push("  }");
    }
  }

  // Non-grouped nodes
  for (const node of nodes) {
    if (groupedNodeIds.has(node.id)) continue;
    const gvShape = node.type === "diamond" ? " shape=diamond" : "";
    lines.push(`  "${escapeDot(node.id)}" [width=${(node.width / 72).toFixed(4)} height=${(node.height / 72).toFixed(4)}${gvShape}];`);
  }

  // Rank constraints: nodes with same row value share a rank
  const rowGroups = new Map<number, string[]>();
  for (const node of nodes) {
    if (node.row !== undefined) {
      if (!rowGroups.has(node.row)) rowGroups.set(node.row, []);
      rowGroups.get(node.row)!.push(node.id);
    }
  }
  for (const [, nodeIds] of rowGroups) {
    if (nodeIds.length >= 2) {
      lines.push(`  { rank=same; ${nodeIds.map(id => `"${escapeDot(id)}"`).join("; ")}; }`);
    }
  }

  // Edges
  for (const edge of edges) {
    const labelAttr = edge.label ? ` [label="${escapeDot(edge.label)}"]` : "";
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}"${labelAttr};`);
  }

  lines.push("}");
  return lines.join("\n");
}

function parseJson0Result(
  json0: Record<string, unknown>,
  inputNodes: { id: string; width: number; height: number }[],
): GraphvizLayoutResult {
  // Bounding box: "x1,y1,x2,y2" in points (Y-up)
  const bb = (json0.bb as string).split(",").map(Number);
  const maxY = bb[3];

  // Map _gvid → node ID (only for actual nodes, not subgraphs)
  const gvidToId = new Map<number, string>();
  const inputNodeMap = new Map(inputNodes.map(n => [n.id, n]));
  const resultNodes: { id: string; x: number; y: number }[] = [];

  for (const obj of (json0.objects as Record<string, unknown>[]) ?? []) {
    const pos = obj.pos as string | undefined;
    if (!pos) continue; // subgraphs have bb, not pos

    const name = obj.name as string;
    const input = inputNodeMap.get(name);
    if (!input) continue;

    gvidToId.set(obj._gvid as number, name);

    const [gvX, gvY] = pos.split(",").map(Number);
    // Graphviz Y-up → Excalidraw Y-down, center → top-left corner
    const exX = gvX - input.width / 2;
    const exY = (maxY - gvY) - input.height / 2;
    resultNodes.push({ id: name, x: Math.round(exX), y: Math.round(exY) });
  }

  // Parse edge routing
  const edgeRoutes = new Map<string, GraphvizEdgeRoute>();
  const edgePairCounts = new Map<string, number>();
  for (const edge of (json0.edges as Record<string, unknown>[]) ?? []) {
    const fromId = gvidToId.get(edge.tail as number);
    const toId = gvidToId.get(edge.head as number);
    if (!fromId || !toId) continue;

    // Use index suffix to handle multiple edges between same nodes
    const baseKey = `${fromId}->${toId}`;
    const pairIdx = edgePairCounts.get(baseKey) ?? 0;
    edgePairCounts.set(baseKey, pairIdx + 1);
    const key = pairIdx === 0 ? baseKey : `${baseKey}#${pairIdx}`;

    // Extract path points from _draw_ B-spline operations (deduped in one pass)
    const drawOps = edge._draw_ as { op: string; points?: [number, number][] }[] | undefined;
    if (!drawOps) continue;

    const deduped: [number, number][] = [];
    const pushUnique = (x: number, y: number) => {
      const prev = deduped[deduped.length - 1];
      if (!prev || prev[0] !== x || prev[1] !== y) deduped.push([x, y]);
    };

    for (const op of drawOps) {
      if ((op.op === "b" || op.op === "B") && op.points) {
        const pts = op.points;
        for (let i = 0; i < pts.length; i += 3) {
          pushUnique(Math.round(pts[i][0]), Math.round(maxY - pts[i][1]));
        }
        const last = pts[pts.length - 1];
        pushUnique(Math.round(last[0]), Math.round(maxY - last[1]));
      }
    }

    // Parse label position from "lp" attribute
    let labelPos: { x: number; y: number } | undefined;
    if (edge.lp) {
      const [lpX, lpY] = (edge.lp as string).split(",").map(Number);
      labelPos = { x: Math.round(lpX), y: Math.round(maxY - lpY) };
    }

    if (deduped.length >= 2) {
      edgeRoutes.set(key, { points: deduped, labelPos });
    }
  }

  return { nodes: resultNodes, edgeRoutes };
}

function escapeDot(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

interface WasmLayoutExports {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
  dealloc: (ptr: number, size: number) => void;
  resetHeap: () => void;
  layoutGraph: (nodesPtr: number, nodesLen: number, edgesPtr: number, edgesLen: number, outPtr: number, outCap: number) => number;
  validate: (elemPtr: number, elemLen: number, outPtr: number, outCap: number) => number;
  renderSvg: (elemPtr: number, elemLen: number, outPtr: number, outCap: number) => number;
}

let wasmInstance: WasmLayoutExports | null = null;

export async function loadWasm(wasmPath?: string): Promise<void> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = await getDirname();
    const path = wasmPath ?? join(dir, "..", "wasm", "zig-out", "bin", "drawmode.wasm");
    const bytes = await readFile(path);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    wasmInstance = instance.exports as unknown as WasmLayoutExports;
  } catch {
    // WASM not available — fall back to TS layout
    wasmInstance = null;
  }
}

export function isWasmLoaded(): boolean {
  return wasmInstance !== null;
}

function writeToWasm(data: Uint8Array): number {
  if (!wasmInstance) throw new Error("WASM not loaded");
  const ptr = wasmInstance.alloc(data.byteLength);
  new Uint8Array(wasmInstance.memory.buffer, ptr, data.byteLength).set(data);
  return ptr;
}

function readFromWasm(ptr: number, len: number): Uint8Array {
  if (!wasmInstance) throw new Error("WASM not loaded");
  return new Uint8Array(wasmInstance.memory.buffer, ptr, len).slice();
}

/** Call a single-input WASM function: encode JSON → call → decode result. */
function callWasm(
  fn: (inPtr: number, inLen: number, outPtr: number, outCap: number) => number,
  inputJson: string,
  outCap: number,
): string | null {
  if (!wasmInstance) return null;
  wasmInstance.resetHeap();
  const inBytes = new TextEncoder().encode(inputJson);
  const inPtr = writeToWasm(inBytes);
  const outPtr = wasmInstance.alloc(outCap);
  const written = fn(inPtr, inBytes.byteLength, outPtr, outCap);
  const result = written > 0 ? new TextDecoder().decode(readFromWasm(outPtr, written)) : null;
  return result;
}

/** Run WASM auto-layout on nodes and edges. */
export function layoutGraph(nodesJson: string, edgesJson: string): string | null {
  if (!wasmInstance) return null;
  wasmInstance.resetHeap();
  const nodesBytes = new TextEncoder().encode(nodesJson);
  const edgesBytes = new TextEncoder().encode(edgesJson);
  const outCap = 64 * 1024;
  const nodesPtr = writeToWasm(nodesBytes);
  const edgesPtr = writeToWasm(edgesBytes);
  const outPtr = wasmInstance.alloc(outCap);
  const written = wasmInstance.layoutGraph(nodesPtr, nodesBytes.byteLength, edgesPtr, edgesBytes.byteLength, outPtr, outCap);
  return written > 0 ? new TextDecoder().decode(readFromWasm(outPtr, written)) : null;
}

/** Validate Excalidraw elements. Returns validation errors JSON, or null. */
export function validateElements(elementsJson: string): string | null {
  if (!wasmInstance) return null;
  return callWasm(wasmInstance.validate.bind(wasmInstance), elementsJson, 16 * 1024);
}

/** Render Excalidraw elements to SVG using WASM. */
export function renderSvg(elementsJson: string): string | null {
  if (!wasmInstance) return null;
  return callWasm(wasmInstance.renderSvg.bind(wasmInstance), elementsJson, 512 * 1024);
}
