/**
 * Export Excalidraw elements to SVG and PNG.
 *
 * SVG: Uses WASM renderSvg when available, falls back to TS renderer.
 * PNG: Converts SVG to PNG via @resvg/resvg-js (pure WASM, no browser).
 */

import { renderSvg as wasmRenderSvg, isWasmLoaded } from "./layout.js";

/** Export Excalidraw elements to SVG string. */
export function exportToSvg(elements: object[]): string {
  // Try WASM renderer first
  if (isWasmLoaded()) {
    const result = wasmRenderSvg(JSON.stringify(elements));
    if (result) return result;
  }

  // Fallback: TS SVG renderer
  return renderSvgTs(elements);
}

/** Export Excalidraw elements to PNG bytes. */
export async function exportToPng(elements: object[]): Promise<Uint8Array> {
  const svg = exportToSvg(elements);
  const { Resvg } = await import("@resvg/resvg-js");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width" as const, value: 1200 },
  });
  const rendered = resvg.render();
  return rendered.asPng();
}

type Elem = Record<string, unknown>;

/** Fallback TS SVG renderer for when WASM is unavailable. */
function renderSvgTs(elements: object[]): string {
  const elems = elements as Elem[];

  // Calculate viewBox from element bounding boxes
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const el of elems) {
    const x = (el.x as number) ?? 0;
    const y = (el.y as number) ?? 0;
    const w = (el.width as number) ?? 0;
    const h = (el.height as number) ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }

  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" style="background:#ffffff">`);
  parts.push(`<defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#333"/></marker></defs>`);

  for (const el of elems) {
    const type = el.type as string;
    const x = (el.x as number) ?? 0;
    const y = (el.y as number) ?? 0;
    const w = (el.width as number) ?? 0;
    const h = (el.height as number) ?? 0;
    const fill = (el.backgroundColor as string) ?? "#ffffff";
    const stroke = (el.strokeColor as string) ?? "#333333";
    const strokeStyle = (el.strokeStyle as string) ?? "solid";
    const isDashed = strokeStyle === "dashed";

    if (type === "rectangle") {
      const dashAttr = isDashed ? ` stroke-dasharray="5,5" opacity="0.4"` : "";
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${isDashed ? "none" : escapeAttr(fill)}" stroke="${isDashed ? "#868e96" : escapeAttr(stroke)}" stroke-width="2" rx="8"${dashAttr}/>`);
    } else if (type === "ellipse") {
      const cx = x + w / 2, cy = y + h / 2;
      parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="2"/>`);
    } else if (type === "text") {
      const rawText = String(el.text ?? "");
      const fontSize = (el.fontSize as number) ?? 16;
      // Center text in its bounding box
      const cx = x + w / 2;
      const cy = y + h / 2;

      // Split on actual newlines
      const lines = rawText.split("\n");
      if (lines.length === 1) {
        parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${fontSize}" fill="${escapeAttr(stroke)}">${escapeXml(rawText)}</text>`);
      } else {
        // Multiline: use tspan elements with absolute y positioning
        const lineHeight = fontSize * 1.2;
        const totalHeight = lineHeight * lines.length;
        const startY = cy - totalHeight / 2 + lineHeight / 2;
        const tspans = lines.map((line, i) =>
          `<tspan x="${cx}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`,
        ).join("");
        parts.push(`<text text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${fontSize}" fill="${escapeAttr(stroke)}">${tspans}</text>`);
      }
    } else if (type === "arrow") {
      const points = el.points as number[][] | undefined;
      if (points && points.length > 0) {
        const d = points.map((p, i) =>
          `${i === 0 ? "M" : "L"}${x + p[0]} ${y + p[1]}`,
        ).join("");
        const dashAttr = isDashed ? ` stroke-dasharray="5,5"` : "";
        parts.push(`<path d="${d}" fill="none" stroke="${escapeAttr(stroke)}" stroke-width="2" marker-end="url(#arrowhead)"${dashAttr}/>`);
      }
    }
  }

  parts.push("</svg>");
  return parts.join("\n");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
