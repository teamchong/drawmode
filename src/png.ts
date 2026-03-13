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

  // Extract width/height from SVG root element so PlutoSVG renders at full resolution.
  // Excalidraw's exportToSvg sets width/height to 2x the viewBox for retina.
  let width = 0, height = 0;
  const svgTag = svgString.match(/<svg[^>]+>/);
  if (svgTag) {
    const wm = svgTag[0].match(/\bwidth="([\d.]+)"/);
    const hm = svgTag[0].match(/\bheight="([\d.]+)"/);
    if (wm) width = Math.round(parseFloat(wm[1]));
    if (hm) height = Math.round(parseFloat(hm[1]));
  }

  const pngBytes = await svgToPngWasm(svgString, width, height);
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
