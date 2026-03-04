/**
 * Layout bridge — Zig WASM for graph layout, SVG rendering, PNG rendering,
 * and validation. TS grid layout as last-resort fallback.
 *
 * Layout priority: WASM Sugiyama → TS grid (in sdk.ts)
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

// ── WASM Layout Result Types ──

export interface EdgeRoute {
  /** Absolute Excalidraw-coordinate points for the arrow path */
  points: [number, number][];
  /** Label position in Excalidraw coordinates */
  labelPos?: { x: number; y: number };
}

export interface WasmLayoutResult {
  nodes: { id: string; x: number; y: number }[];
  edgeRoutes: Map<string, EdgeRoute>;
}

// ── WASM Instance ──

interface WasmLayoutExports {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
  dealloc: (ptr: number, size: number) => void;
  resetHeap: () => void;
  layoutGraph: (nodesPtr: number, nodesLen: number, edgesPtr: number, edgesLen: number, outPtr: number, outCap: number) => number;
  validate: (elemPtr: number, elemLen: number, outPtr: number, outCap: number) => number;
  renderSvg: (elemPtr: number, elemLen: number, outPtr: number, outCap: number) => number;
  renderPng: (elemPtr: number, elemLen: number, outPtr: number, outCap: number) => number;
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

/** Call a single-input WASM function that returns binary data. */
function callWasmBinary(
  fn: (inPtr: number, inLen: number, outPtr: number, outCap: number) => number,
  inputJson: string,
  outCap: number,
): Uint8Array | null {
  if (!wasmInstance) return null;
  wasmInstance.resetHeap();
  const inBytes = new TextEncoder().encode(inputJson);
  const inPtr = writeToWasm(inBytes);
  const outPtr = wasmInstance.alloc(outCap);
  const written = fn(inPtr, inBytes.byteLength, outPtr, outCap);
  return written > 0 ? readFromWasm(outPtr, written) : null;
}

/**
 * Run WASM Sugiyama layout on nodes and edges.
 * Returns positioned nodes and edge routes with orthogonal routing points.
 */
export async function layoutGraphWasm(
  nodes: { id: string; width: number; height: number; row?: number; col?: number; absX?: number; absY?: number; type?: string }[],
  edges: { from: string; to: string; label?: string }[],
  _groups?: { id: string; label: string; children: string[] }[],
): Promise<WasmLayoutResult | null> {
  if (!wasmInstance) return null;

  const nodesJson = JSON.stringify(
    nodes.map(n => ({
      id: n.id,
      width: n.width,
      height: n.height,
      row: n.row ?? null,
      col: n.col ?? null,
    })),
  );
  const edgesJson = JSON.stringify(
    edges.map(e => ({ from: e.from, to: e.to })),
  );

  wasmInstance.resetHeap();
  const nodesBytes = new TextEncoder().encode(nodesJson);
  const edgesBytes = new TextEncoder().encode(edgesJson);
  const outCap = 128 * 1024;
  const nodesPtr = writeToWasm(nodesBytes);
  const edgesPtr = writeToWasm(edgesBytes);
  const outPtr = wasmInstance.alloc(outCap);
  const written = wasmInstance.layoutGraph(
    nodesPtr, nodesBytes.byteLength,
    edgesPtr, edgesBytes.byteLength,
    outPtr, outCap,
  );

  if (written === 0) return null;

  try {
    const resultStr = new TextDecoder().decode(readFromWasm(outPtr, written));
    const result = JSON.parse(resultStr) as {
      nodes: { id: string; x: number; y: number }[];
      edges: { from: string; to: string; points: [number, number][] }[];
    };

    // Build edge routes map
    const edgeRoutes = new Map<string, EdgeRoute>();
    const edgePairCounts = new Map<string, number>();

    for (const edge of result.edges ?? []) {
      const baseKey = `${edge.from}->${edge.to}`;
      const pairIdx = edgePairCounts.get(baseKey) ?? 0;
      edgePairCounts.set(baseKey, pairIdx + 1);
      const key = pairIdx === 0 ? baseKey : `${baseKey}#${pairIdx}`;

      if (edge.points && edge.points.length >= 2) {
        // Compute label position at midpoint of longest segment
        let bestLen = 0, bestSeg = 0;
        for (let s = 0; s < edge.points.length - 1; s++) {
          const dx = edge.points[s + 1][0] - edge.points[s][0];
          const dy = edge.points[s + 1][1] - edge.points[s][1];
          const segLen = Math.abs(dx) + Math.abs(dy);
          if (segLen > bestLen) { bestLen = segLen; bestSeg = s; }
        }
        const p1 = edge.points[bestSeg], p2 = edge.points[bestSeg + 1];
        const labelPos = { x: Math.round((p1[0] + p2[0]) / 2), y: Math.round((p1[1] + p2[1]) / 2) };

        edgeRoutes.set(key, { points: edge.points, labelPos });
      }
    }

    return { nodes: result.nodes, edgeRoutes };
  } catch {
    return null;
  }
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

/** Render Excalidraw elements to PNG using WASM. Returns PNG bytes or null. */
export function renderPng(elementsJson: string): Uint8Array | null {
  if (!wasmInstance) return null;
  return callWasmBinary(wasmInstance.renderPng.bind(wasmInstance), elementsJson, 4 * 1024 * 1024);
}
