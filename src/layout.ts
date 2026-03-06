/**
 * Layout bridge — Zig WASM with statically-linked Graphviz C for graph layout,
 * plus validation. Graphviz `dot` engine handles layout and edge routing.
 */

import { z } from "zod";

class WasiExit extends Error {
  code: number;
  constructor(code: number) { super(`WASI exit: ${code}`); this.code = code; }
}

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
  /** Where arrow meets source node edge (0-1 normalized), computed by Graphviz */
  startFixedPoint?: [number, number];
  /** Where arrow meets target node edge (0-1 normalized), computed by Graphviz */
  endFixedPoint?: [number, number];
}

export interface GroupBounds {
  id: string;
  x: number; y: number;
  width: number; height: number;
}

export interface WasmLayoutResult {
  nodes: { id: string; x: number; y: number }[];
  edgeRoutes: Map<string, EdgeRoute>;
  groupBounds?: GroupBounds[];
}

// ── WASM Instance ──

interface WasmLayoutExports {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
  dealloc: (ptr: number, size: number) => void;
  resetHeap: () => void;
  layoutGraph: (nodesPtr: number, nodesLen: number, edgesPtr: number, edgesLen: number, groupsPtr: number, groupsLen: number, outPtr: number, outCap: number, optsPtr: number, optsLen: number) => number;
  validate: (elemPtr: number, elemLen: number, outPtr: number, outCap: number) => number;
  zlibCompress: (inPtr: number, inLen: number, outPtr: number, outCap: number) => number;
}

let wasmInstance: WasmLayoutExports | null = null;

const WasmLayoutOutputSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), x: z.number(), y: z.number() })),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    points: z.array(z.tuple([z.number(), z.number()])),
    startFixedPoint: z.tuple([z.number(), z.number()]).optional(),
    endFixedPoint: z.tuple([z.number(), z.number()]).optional(),
    labelX: z.number().optional(),
    labelY: z.number().optional(),
  })).optional(),
  groups: z.array(z.object({
    id: z.string(),
    x: z.number(), y: z.number(),
    width: z.number(), height: z.number(),
  })).optional(),
});

export async function loadWasm(wasmPath?: string): Promise<void> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = await getDirname();
    const path = wasmPath ?? join(dir, "..", "wasm", "zig-out", "bin", "drawmode.wasm");
    const bytes = await readFile(path);
    // WASI imports — the WASM module targets wasm32-wasi and requires these syscalls.
    // We provide minimal implementations since only layout computation is used (no I/O).
    const ref: { memory: WebAssembly.Memory | null } = { memory: null };
    const wasiImports = {
      wasi_snapshot_preview1: {
        environ_get: () => 0,
        environ_sizes_get: (_countPtr: number, _sizePtr: number) => {
          if (ref.memory) {
            const view = new DataView(ref.memory.buffer);
            view.setUint32(_countPtr, 0, true);
            view.setUint32(_sizePtr, 0, true);
          }
          return 0;
        },
        clock_time_get: (_id: number, _precision: bigint, resultPtr: number) => {
          if (ref.memory) {
            new DataView(ref.memory.buffer).setBigUint64(resultPtr, BigInt(0), true);
          }
          return 0;
        },
        fd_close: () => 0,
        fd_fdstat_get: () => 0,
        fd_filestat_get: () => 8, // EBADF
        fd_prestat_get: () => 8, // EBADF — no preopened dirs
        fd_prestat_dir_name: () => 8,
        fd_pwrite: () => 0,
        fd_read: () => 0,
        fd_seek: () => 0,
        fd_write: (_fd: number, _iovs: number, _iovsLen: number, nwrittenPtr: number) => {
          if (ref.memory) {
            new DataView(ref.memory.buffer).setUint32(nwrittenPtr, 0, true);
          }
          return 0;
        },
        path_filestat_get: () => 8, // EBADF
        proc_exit: (code: number) => { throw new WasiExit(code); },
      },
    };
    const { instance } = await WebAssembly.instantiate(bytes, wasiImports);
    ref.memory = (instance.exports as Record<string, unknown>).memory as WebAssembly.Memory;
    // Initialize WASI C runtime (libc, malloc, etc.)
    // _start calls main() then proc_exit(). We throw from proc_exit to break out.
    const start = (instance.exports as Record<string, unknown>)._start as (() => void) | undefined;
    if (start) {
      try { start(); } catch (e) {
        if (!(e instanceof WasiExit)) throw e;
      }
    }
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
  return written > 0 ? new TextDecoder().decode(readFromWasm(outPtr, written)) : null;
}

/**
 * Run WASM Sugiyama layout on nodes and edges.
 * Returns positioned nodes and edge routes with orthogonal routing points.
 */
export async function layoutGraphWasm(
  nodes: { id: string; width: number; height: number; row?: number; col?: number; absX?: number; absY?: number; type?: string }[],
  edges: { from: string; to: string; label?: string }[],
  groups?: { id: string; label: string; children: string[]; parent?: string }[],
  options?: { rankdir?: string },
): Promise<WasmLayoutResult | null> {
  if (!wasmInstance) return null;

  const nodesJson = JSON.stringify(
    nodes.map(n => ({
      id: n.id,
      width: n.width,
      height: n.height,
      row: n.row ?? null,
      col: n.col ?? null,
      absX: n.absX ?? null,
      absY: n.absY ?? null,
    })),
  );
  const edgesJson = JSON.stringify(
    edges.map(e => ({ from: e.from, to: e.to, label: e.label ?? "" })),
  );
  const groupsJson = JSON.stringify(
    (groups ?? []).map(g => ({ id: g.id, label: g.label, children: g.children, parent: g.parent ?? "" })),
  );

  const optsJson = JSON.stringify({ rankdir: options?.rankdir ?? "TB" });

  wasmInstance.resetHeap();
  const nodesBytes = new TextEncoder().encode(nodesJson);
  const edgesBytes = new TextEncoder().encode(edgesJson);
  const groupsBytes = new TextEncoder().encode(groupsJson);
  const optsBytes = new TextEncoder().encode(optsJson);
  const outCap = 128 * 1024;
  const nodesPtr = writeToWasm(nodesBytes);
  const edgesPtr = writeToWasm(edgesBytes);
  const groupsPtr = writeToWasm(groupsBytes);
  const optsPtr = writeToWasm(optsBytes);
  const outPtr = wasmInstance.alloc(outCap);
  const written = wasmInstance.layoutGraph(
    nodesPtr, nodesBytes.byteLength,
    edgesPtr, edgesBytes.byteLength,
    groupsPtr, groupsBytes.byteLength,
    outPtr, outCap,
    optsPtr, optsBytes.byteLength,
  );

  if (written === 0) return null;

  try {
    const resultStr = new TextDecoder().decode(readFromWasm(outPtr, written));
    const result = WasmLayoutOutputSchema.parse(JSON.parse(resultStr));

    // Build edge routes map
    const edgeRoutes = new Map<string, EdgeRoute>();
    const edgePairCounts = new Map<string, number>();

    for (const edge of result.edges ?? []) {
      const baseKey = `${edge.from}->${edge.to}`;
      const pairIdx = edgePairCounts.get(baseKey) ?? 0;
      edgePairCounts.set(baseKey, pairIdx + 1);
      const key = pairIdx === 0 ? baseKey : `${baseKey}#${pairIdx}`;

      if (edge.points && edge.points.length >= 2) {
        // Use Zig-computed label position (with collision avoidance),
        // fall back to midpoint of longest segment
        let labelPos: { x: number; y: number };
        if (edge.labelX !== undefined && edge.labelY !== undefined) {
          labelPos = { x: edge.labelX, y: edge.labelY };
        } else {
          let bestLen = 0, bestSeg = 0;
          for (let s = 0; s < edge.points.length - 1; s++) {
            const dx = edge.points[s + 1][0] - edge.points[s][0];
            const dy = edge.points[s + 1][1] - edge.points[s][1];
            const segLen = Math.abs(dx) + Math.abs(dy);
            if (segLen > bestLen) { bestLen = segLen; bestSeg = s; }
          }
          const p1 = edge.points[bestSeg], p2 = edge.points[bestSeg + 1];
          labelPos = { x: Math.round((p1[0] + p2[0]) / 2), y: Math.round((p1[1] + p2[1]) / 2) };
        }

        edgeRoutes.set(key, {
          points: edge.points,
          labelPos,
          startFixedPoint: edge.startFixedPoint,
          endFixedPoint: edge.endFixedPoint,
        });
      }
    }

    return { nodes: result.nodes, edgeRoutes, groupBounds: result.groups };
  } catch {
    return null;
  }
}

/** Validate Excalidraw elements. Returns validation errors JSON, or null. */
export function validateElements(elementsJson: string): string | null {
  if (!wasmInstance) return null;
  return callWasm(wasmInstance.validate.bind(wasmInstance), elementsJson, 16 * 1024);
}

/** Compress data using zlib format (matching pako.deflate). Returns compressed bytes or null. */
export function zlibCompress(data: Uint8Array): Uint8Array | null {
  if (!wasmInstance) return null;
  wasmInstance.resetHeap();
  const inPtr = writeToWasm(data);
  const outCap = data.byteLength + 1024; // compressed + zlib overhead
  const outPtr = wasmInstance.alloc(outCap);
  const written = wasmInstance.zlibCompress(inPtr, data.byteLength, outPtr, outCap);
  return written > 0 ? readFromWasm(outPtr, written) : null;
}

