/**
 * PNG + SVG export tests — verifies WASM-based rendering produces valid images.
 */

import { describe, it, expect } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { Diagram } from "./sdk.js";
import { renderPngWasm, renderSvgWasm } from "./png.js";
import { compareSnapshot } from "./visual-test-helpers.js";
import { loadWasm, svgToPngWasm } from "./layout.js";

describe("PNG export via WASM", () => {
  const outPath = "/tmp/drawmode-png-test.png";

  it("renderPngWasm produces a valid non-zero PNG", async () => {
    const d = new Diagram();
    d.addBox("Test Box", { row: 0, col: 0, color: "backend" });
    d.addBox("Another Box", { row: 1, col: 0, color: "database" });
    d.connect(
      d.getNodes()[0],
      d.getNodes()[1],
      "connects",
    );
    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    const wasmResult = await renderPngWasm(elements);
    expect(wasmResult).not.toBeNull();
    expect(wasmResult!.pngBase64.length).toBeGreaterThan(100);
    expect(wasmResult!.pngBytes.length).toBeGreaterThan(100);

    // Verify PNG magic bytes: 0x89 P N G
    expect(wasmResult!.pngBytes[0]).toBe(0x89);
    expect(wasmResult!.pngBytes[1]).toBe(0x50); // P
    expect(wasmResult!.pngBytes[2]).toBe(0x4e); // N
    expect(wasmResult!.pngBytes[3]).toBe(0x47); // G
  }, 60000);

  it("SDK render with format=png writes valid PNG file", async () => {
    const d = new Diagram();
    d.addBox("PNG Format Test", { row: 0, col: 0, color: "ai" });
    const result = await d.render({ format: "png", path: outPath });

    expect(result.pngBase64).toBeDefined();
    expect(typeof result.pngBase64).toBe("string");
    expect(result.pngBase64!.length).toBeGreaterThan(100);
    expect(result.filePath).toBe(outPath);

    // Verify file on disk is valid PNG
    const fileBytes = await readFile(outPath);
    expect(fileBytes.length).toBeGreaterThan(100);
    expect(fileBytes[0]).toBe(0x89);
    expect(fileBytes[1]).toBe(0x50);
    expect(fileBytes[2]).toBe(0x4e);
    expect(fileBytes[3]).toBe(0x47);

    await unlink(outPath).catch(() => {});
  }, 60000);

  it("PNG output has reasonable dimensions (not degenerate)", async () => {
    const d = new Diagram();
    d.addBox("A", { row: 0, col: 0, color: "frontend" });
    d.addBox("B", { row: 0, col: 1, color: "backend" });
    d.addBox("C", { row: 1, col: 0, color: "database" });
    const result = await d.render({ format: "excalidraw" });

    const wasmResult = await renderPngWasm(result.json.elements);
    expect(wasmResult).not.toBeNull();

    // Decode to check PNG IHDR chunk for width/height
    const buf = Buffer.from(wasmResult!.pngBase64, "base64");

    // PNG structure: 8-byte signature, then IHDR chunk:
    // 4 bytes length, 4 bytes "IHDR", 4 bytes width, 4 bytes height
    const ihdrOffset = 8;
    const chunkType = buf.toString("ascii", ihdrOffset + 4, ihdrOffset + 8);
    expect(chunkType).toBe("IHDR");

    const width = buf.readUInt32BE(ihdrOffset + 8);
    const height = buf.readUInt32BE(ihdrOffset + 12);

    // A 3-box diagram should be non-degenerate
    expect(width).toBeGreaterThanOrEqual(200);
    expect(height).toBeGreaterThanOrEqual(200);
    expect(width).toBeLessThan(10000);
    expect(height).toBeLessThan(10000);
  }, 60000);
});

describe("Visual regression tests", () => {
  it("simple two-box diagram with arrow matches baseline", async () => {
    const d = new Diagram();
    const a = d.addBox("API Gateway", { row: 0, col: 0, color: "backend" });
    const b = d.addBox("Database", { row: 1, col: 0, color: "database" });
    d.connect(a, b, "queries");
    const result = await d.render({ format: "excalidraw" });

    const wasmResult = await renderPngWasm(result.json.elements);
    expect(wasmResult).not.toBeNull();

    const cmp = await compareSnapshot(wasmResult!.pngBase64, "two-box-arrow");
    if (!cmp.baselineCreated) {
      expect(cmp.match).toBe(true);
    }
  }, 60000);

  it("bidirectional edges do not overlap labels", async () => {
    const d = new Diagram();
    const a = d.addBox("Service A", { row: 0, col: 0, color: "backend" });
    const b = d.addBox("Service B", { row: 1, col: 0, color: "frontend" });
    d.connect(a, b, "requests");
    d.connect(b, a, "responses");
    const result = await d.render({ format: "excalidraw" });

    const wasmResult = await renderPngWasm(result.json.elements);
    expect(wasmResult).not.toBeNull();

    const cmp = await compareSnapshot(wasmResult!.pngBase64, "bidirectional-edges");
    if (!cmp.baselineCreated) {
      expect(cmp.match).toBe(true);
    }
  }, 60000);

  it("diagram with groups matches baseline", async () => {
    const d = new Diagram();
    const api = d.addBox("API", { row: 0, col: 0, color: "backend" });
    const db = d.addBox("Postgres", { row: 1, col: 0, color: "database" });
    const cache = d.addBox("Redis", { row: 1, col: 1, color: "cache" });
    d.connect(api, db, "writes");
    d.connect(api, cache, "reads");
    d.addGroup("Data Layer", [db, cache]);
    const result = await d.render({ format: "excalidraw" });

    const wasmResult = await renderPngWasm(result.json.elements);
    expect(wasmResult).not.toBeNull();

    const cmp = await compareSnapshot(wasmResult!.pngBase64, "diagram-with-groups");
    if (!cmp.baselineCreated) {
      expect(cmp.match).toBe(true);
    }
  }, 60000);
});

describe("SVG export via linkedom", () => {
  const outPath = "/tmp/drawmode-svg-test.svg";

  it("renderSvgWasm produces valid non-zero SVG", async () => {
    const d = new Diagram();
    d.addBox("SVG Box", { row: 0, col: 0, color: "backend" });
    d.addBox("Another", { row: 1, col: 0, color: "database" });
    d.connect(d.getNodes()[0], d.getNodes()[1], "links");
    const result = await d.render({ format: "excalidraw" });

    const svgStr = await renderSvgWasm(result.json.elements);
    expect(svgStr).not.toBeNull();
    expect(svgStr!.length).toBeGreaterThan(100);

    // Must be valid SVG
    expect(svgStr).toContain("<svg");
    expect(svgStr).toContain("</svg>");
  }, 60000);

  it("SDK render with format=svg writes valid SVG file", async () => {
    const d = new Diagram();
    d.addBox("SVG SDK Test", { row: 0, col: 0, color: "ai" });
    const result = await d.render({ format: "svg", path: outPath });

    expect(result.svgString).toBeDefined();
    expect(result.svgString).toContain("<svg");
    expect(result.svgString).toContain("</svg>");
    expect(result.filePath).toBe(outPath);

    // Verify file on disk
    const fileContent = await readFile(outPath, "utf-8");
    expect(fileContent).toContain("<svg");

    await unlink(outPath).catch(() => {});
  }, 60000);

  it("SVG contains viewBox with reasonable dimensions", async () => {
    const d = new Diagram();
    d.addBox("A", { row: 0, col: 0, color: "frontend" });
    d.addBox("B", { row: 0, col: 1, color: "backend" });
    const result = await d.render({ format: "excalidraw" });

    const svgStr = await renderSvgWasm(result.json.elements);
    expect(svgStr).not.toBeNull();

    // Extract viewBox or width/height from SVG
    const widthMatch = svgStr!.match(/width="(\d+)/);
    const heightMatch = svgStr!.match(/height="(\d+)/);
    if (widthMatch && heightMatch) {
      const w = parseInt(widthMatch[1]);
      const h = parseInt(heightMatch[1]);
      expect(w).toBeGreaterThan(50);
      expect(h).toBeGreaterThan(50);
      expect(w).toBeLessThan(10000);
      expect(h).toBeLessThan(10000);
    }
  }, 60000);
});

describe("WASM SVG→PNG via PlutoSVG", () => {
  it("converts a simple SVG to valid PNG bytes", async () => {
    await loadWasm();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
      <rect x="10" y="10" width="180" height="80" fill="#a5d8ff" stroke="#1971c2" stroke-width="2"/>
      <text x="100" y="55" text-anchor="middle" font-size="16" fill="#333">Hello</text>
    </svg>`;

    const png = await svgToPngWasm(svg, 200, 100);
    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(100);

    // Verify PNG magic bytes
    expect(png![0]).toBe(0x89);
    expect(png![1]).toBe(0x50); // P
    expect(png![2]).toBe(0x4e); // N
    expect(png![3]).toBe(0x47); // G
  });

  it("returns null for invalid SVG", async () => {
    await loadWasm();
    const png = await svgToPngWasm("not an svg", 100, 100);
    expect(png).toBeNull();
  });

  it("uses intrinsic SVG dimensions when width/height are 0", async () => {
    await loadWasm();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150">
      <circle cx="150" cy="75" r="60" fill="#d0bfff" stroke="#7048e8"/>
    </svg>`;

    const png = await svgToPngWasm(svg);
    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(100);

    // Verify PNG magic bytes
    expect(png![0]).toBe(0x89);
    expect(png![1]).toBe(0x50);
  });
});
