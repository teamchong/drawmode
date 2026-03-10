// Wrangler bundles this .wasm import as a CompiledWasm module.
// In vitest, this file is mocked (see worker.test.ts).
import wasmModule from "../wasm/zig-out/bin/drawmode.wasm";
export default wasmModule;
