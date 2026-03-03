/**
 * WASM layout bridge — calls Zig auto-layout engine.
 *
 * When WASM is available, uses it for precise layout, arrow routing,
 * and validation. Falls back to the built-in TS grid layout in sdk.ts
 * when WASM is not loaded (e.g., first run before building Zig).
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WasmLayoutExports {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
  dealloc: (ptr: number, size: number) => void;
  layoutGraph: (nodesPtr: number, nodesLen: number, edgesPtr: number, edgesLen: number, outPtr: number, outCap: number) => number;
  routeArrows: (elemPtr: number, elemLen: number, outPtr: number, outCap: number) => number;
  validate: (elemPtr: number, elemLen: number, outPtr: number, outCap: number) => number;
}

let wasmInstance: WasmLayoutExports | null = null;

export async function loadWasm(wasmPath?: string): Promise<void> {
  const path = wasmPath ?? join(__dirname, "..", "wasm", "zig-out", "bin", "drawmode.wasm");
  try {
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

/**
 * Run WASM auto-layout on nodes and edges.
 * Returns positioned node JSON, or null if WASM unavailable.
 */
export function layoutGraph(nodesJson: string, edgesJson: string): string | null {
  if (!wasmInstance) return null;

  const nodesBytes = new TextEncoder().encode(nodesJson);
  const edgesBytes = new TextEncoder().encode(edgesJson);
  const outCap = 64 * 1024; // 64KB output buffer

  const nodesPtr = writeToWasm(nodesBytes);
  const edgesPtr = writeToWasm(edgesBytes);
  const outPtr = wasmInstance.alloc(outCap);

  const written = wasmInstance.layoutGraph(
    nodesPtr, nodesBytes.byteLength,
    edgesPtr, edgesBytes.byteLength,
    outPtr, outCap,
  );

  const result = written > 0 ? new TextDecoder().decode(readFromWasm(outPtr, written)) : null;

  wasmInstance.dealloc(nodesPtr, nodesBytes.byteLength);
  wasmInstance.dealloc(edgesPtr, edgesBytes.byteLength);
  wasmInstance.dealloc(outPtr, outCap);

  return result;
}

/**
 * Run WASM arrow routing on elements.
 * Returns elements with corrected arrow positions, or null if WASM unavailable.
 */
export function routeArrows(elementsJson: string): string | null {
  if (!wasmInstance) return null;

  const elemBytes = new TextEncoder().encode(elementsJson);
  const outCap = 128 * 1024;

  const elemPtr = writeToWasm(elemBytes);
  const outPtr = wasmInstance.alloc(outCap);

  const written = wasmInstance.routeArrows(elemPtr, elemBytes.byteLength, outPtr, outCap);
  const result = written > 0 ? new TextDecoder().decode(readFromWasm(outPtr, written)) : null;

  wasmInstance.dealloc(elemPtr, elemBytes.byteLength);
  wasmInstance.dealloc(outPtr, outCap);

  return result;
}

/**
 * Validate Excalidraw elements.
 * Returns validation errors JSON, or null (no errors / WASM unavailable).
 */
export function validateElements(elementsJson: string): string | null {
  if (!wasmInstance) return null;

  const elemBytes = new TextEncoder().encode(elementsJson);
  const outCap = 16 * 1024;

  const elemPtr = writeToWasm(elemBytes);
  const outPtr = wasmInstance.alloc(outCap);

  const written = wasmInstance.validate(elemPtr, elemBytes.byteLength, outPtr, outCap);
  const result = written > 0 ? new TextDecoder().decode(readFromWasm(outPtr, written)) : null;

  wasmInstance.dealloc(elemPtr, elemBytes.byteLength);
  wasmInstance.dealloc(outPtr, outCap);

  return result;
}
