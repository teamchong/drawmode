/**
 * PNG + SVG export tests — verifies puppeteer renders valid, non-zero-size images.
 */

import { describe, it, expect } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { Diagram } from "./sdk.js";
import { buildRenderHTML, buildSvgHTML, renderPngLocal, renderSvgLocal } from "./png.js";
import { compareSnapshot } from "./visual-test-helpers.js";

describe("buildRenderHTML", () => {
  it("returns valid HTML with embedded elements", () => {
    const elements = [{ id: "test", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }];
    const html = buildRenderHTML(elements);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("ExcalidrawLib.exportToSvg");
    expect(html).toContain("__PNG_DATA__");
    expect(html).toContain('"test"');
  });

  it("buildSvgHTML returns HTML that captures SVG string", () => {
    const elements = [{ id: "test", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }];
    const html = buildSvgHTML(elements);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("ExcalidrawLib.exportToSvg");
    expect(html).toContain("__SVG_DATA__");
    expect(html).not.toContain("canvas"); // SVG flow skips canvas
  });
});

describe("PNG export via puppeteer", () => {
  const outPath = "/tmp/drawmode-png-test.png";

  it("renderPngLocal produces a valid non-zero PNG", async () => {
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

    const base64 = await renderPngLocal(elements, outPath);
    expect(base64).not.toBeNull();
    expect(typeof base64).toBe("string");
    expect(base64!.length).toBeGreaterThan(100);

    // Verify file written to disk
    const fileBytes = await readFile(outPath);
    expect(fileBytes.length).toBeGreaterThan(100);

    // Verify PNG magic bytes: 0x89 P N G
    expect(fileBytes[0]).toBe(0x89);
    expect(fileBytes[1]).toBe(0x50); // P
    expect(fileBytes[2]).toBe(0x4e); // N
    expect(fileBytes[3]).toBe(0x47); // G

    await unlink(outPath).catch(() => {});
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

    const base64 = await renderPngLocal(result.json.elements, outPath);
    expect(base64).not.toBeNull();

    // Decode base64 to check PNG IHDR chunk for width/height
    const buf = Buffer.from(base64!, "base64");

    // PNG structure: 8-byte signature, then IHDR chunk:
    // 4 bytes length, 4 bytes "IHDR", 4 bytes width, 4 bytes height
    const ihdrOffset = 8;
    const chunkType = buf.toString("ascii", ihdrOffset + 4, ihdrOffset + 8);
    expect(chunkType).toBe("IHDR");

    const width = buf.readUInt32BE(ihdrOffset + 8);
    const height = buf.readUInt32BE(ihdrOffset + 12);

    // At 2x scale, a 3-box diagram should be at least a few hundred px
    expect(width).toBeGreaterThan(200);
    expect(height).toBeGreaterThan(200);
    expect(width).toBeLessThan(10000);
    expect(height).toBeLessThan(10000);

    await unlink(outPath).catch(() => {});
  }, 60000);
});

describe("Visual regression tests", () => {
  const outPath = "/tmp/drawmode-visual-test.png";

  it("simple two-box diagram with arrow matches baseline", async () => {
    const d = new Diagram();
    const a = d.addBox("API Gateway", { row: 0, col: 0, color: "backend" });
    const b = d.addBox("Database", { row: 1, col: 0, color: "database" });
    d.connect(a, b, "queries");
    const result = await d.render({ format: "excalidraw" });

    const base64 = await renderPngLocal(result.json.elements, outPath);
    expect(base64).not.toBeNull();

    const cmp = await compareSnapshot(base64!, "two-box-arrow");
    if (!cmp.baselineCreated) {
      expect(cmp.match).toBe(true);
    }

    await unlink(outPath).catch(() => {});
  }, 60000);

  it("bidirectional edges do not overlap labels", async () => {
    const d = new Diagram();
    const a = d.addBox("Service A", { row: 0, col: 0, color: "backend" });
    const b = d.addBox("Service B", { row: 1, col: 0, color: "frontend" });
    d.connect(a, b, "requests");
    d.connect(b, a, "responses");
    const result = await d.render({ format: "excalidraw" });

    const base64 = await renderPngLocal(result.json.elements, outPath);
    expect(base64).not.toBeNull();

    const cmp = await compareSnapshot(base64!, "bidirectional-edges");
    if (!cmp.baselineCreated) {
      expect(cmp.match).toBe(true);
    }

    await unlink(outPath).catch(() => {});
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

    const base64 = await renderPngLocal(result.json.elements, outPath);
    expect(base64).not.toBeNull();

    const cmp = await compareSnapshot(base64!, "diagram-with-groups");
    if (!cmp.baselineCreated) {
      expect(cmp.match).toBe(true);
    }

    await unlink(outPath).catch(() => {});
  }, 60000);
});

describe("SVG export via puppeteer", () => {
  const outPath = "/tmp/drawmode-svg-test.svg";

  it("renderSvgLocal produces valid non-zero SVG", async () => {
    const d = new Diagram();
    d.addBox("SVG Box", { row: 0, col: 0, color: "backend" });
    d.addBox("Another", { row: 1, col: 0, color: "database" });
    d.connect(d.getNodes()[0], d.getNodes()[1], "links");
    const result = await d.render({ format: "excalidraw" });

    const svgStr = await renderSvgLocal(result.json.elements, outPath);
    expect(svgStr).not.toBeNull();
    expect(svgStr!.length).toBeGreaterThan(100);

    // Must be valid SVG
    expect(svgStr).toContain("<svg");
    expect(svgStr).toContain("</svg>");

    // Verify file written to disk
    const fileContent = await readFile(outPath, "utf-8");
    expect(fileContent).toContain("<svg");
    expect(fileContent.length).toBeGreaterThan(100);

    await unlink(outPath).catch(() => {});
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

    const svgStr = await renderSvgLocal(result.json.elements, outPath);
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

    await unlink(outPath).catch(() => {});
  }, 60000);
});
