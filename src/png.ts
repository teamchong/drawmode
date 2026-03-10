/**
 * Image export — linkedom + Excalidraw exportToSvg() → PlutoSVG WASM → PNG.
 *
 * `renderPngWasm(elements)` — PNG via linkedom + PlutoSVG WASM (no browser).
 * `renderSvgWasm(elements)` — SVG via linkedom (no browser).
 */

/**
 * Render Excalidraw elements to PNG via linkedom + PlutoSVG WASM.
 * Returns { pngBase64, pngBytes } or null if WASM/linkedom unavailable.
 */
export async function renderPngWasm(elements: unknown[]): Promise<{ pngBase64: string; pngBytes: Uint8Array } | null> {
  const { renderSvgString } = await import("./svg-render.js");
  const { svgToPngWasm, loadWasm, isWasmLoaded } = await import("./layout.js");

  if (!isWasmLoaded()) await loadWasm();

  const svgString = await renderSvgString(elements);
  const pngBytes = await svgToPngWasm(svgString);
  if (!pngBytes) return null;

  // Convert to base64
  let pngBase64: string;
  if (typeof Buffer !== "undefined") {
    pngBase64 = Buffer.from(pngBytes).toString("base64");
  } else {
    // Cloudflare Workers: no Buffer, use btoa
    let binary = "";
    for (let i = 0; i < pngBytes.length; i++) {
      binary += String.fromCharCode(pngBytes[i]);
    }
    pngBase64 = btoa(binary);
  }

  return { pngBase64, pngBytes };
}

/**
 * Render Excalidraw elements to SVG string via linkedom.
 * No browser or WASM needed — just linkedom + Excalidraw.
 */
export async function renderSvgWasm(elements: unknown[]): Promise<string | null> {
  const { renderSvgString } = await import("./svg-render.js");
  return renderSvgString(elements);
}
