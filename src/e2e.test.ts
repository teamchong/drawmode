/**
 * End-to-end tests — real MCP client ↔ server via InMemoryTransport.
 * Exercises the full pipeline: MCP call → executor → SDK → layout → render → response.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { executeCode } from "./executor.js";
import { loadWasm, isWasmLoaded } from "./layout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build the same server as index.ts but without process-level side effects
function buildServer(): McpServer {
  const SDK_TYPES = `
declare class Diagram {
  addBox(label: string, opts?: {
    row?: number; col?: number;
    color?: "frontend" | "backend" | "database" | "storage" | "ai" | "external" | "orchestration" | "queue" | "cache" | "users";
    width?: number; height?: number;
  }): string;
  addEllipse(label: string, opts?: {
    row?: number; col?: number;
    color?: "frontend" | "backend" | "database" | "storage" | "ai" | "external" | "orchestration" | "queue" | "cache" | "users";
  }): string;
  addGroup(label: string, children: string[]): string;
  connect(from: string, to: string, label?: string, opts?: { style?: "solid" | "dashed" }): void;
  render(opts?: { format?: "excalidraw" | "url" | "png" | "svg"; path?: string }): Promise<{ json: object; url?: string; filePath?: string }>;
}
`;

  const server = new McpServer({
    name: "drawmode",
    version: "0.1.0",
  });

  server.resource(
    "widget",
    "ui://widget",
    { description: "Interactive Excalidraw diagram widget", mimeType: "text/html" },
    async () => {
      const widgetPath = join(__dirname, "widget.html");
      let html: string;
      try {
        html = await readFile(widgetPath, "utf-8");
      } catch {
        html = await readFile(join(__dirname, "..", "src", "widget.html"), "utf-8");
      }
      return { contents: [{ uri: "ui://widget", mimeType: "text/html", text: html }] };
    },
  );

  server.tool(
    "draw",
    `Generate an Excalidraw architecture diagram by writing TypeScript code.\n\nTypescript types:\n${SDK_TYPES}`,
    {
      code: z.string().describe("TypeScript code using the Diagram class. Must return d.render()."),
      format: z.enum(["excalidraw", "url", "png", "svg"]).default("excalidraw").describe("Output format"),
      path: z.string().optional().describe("File path for .excalidraw output"),
    },
    async ({ code, format, path }) => {
      const { result, error } = await executeCode(code, { format, path });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error}` }],
          isError: true,
        };
      }

      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      if (result.url) {
        parts.push({ type: "text" as const, text: `Excalidraw URL: ${result.url}` });
      }
      if (result.filePath) {
        parts.push({ type: "text" as const, text: `Saved to: ${result.filePath}` });
      }

      const elementCount = result.json.elements.length;
      parts.push({ type: "text" as const, text: `Generated ${elementCount} elements` });

      if (format === "excalidraw") {
        parts.push({ type: "text" as const, text: JSON.stringify(result.json, null, 2) });
      }

      if (format === "svg" && result.svg) {
        parts.push({ type: "text" as const, text: result.svg });
      }

      if (format === "png" && result.png) {
        const base64 = Buffer.from(result.png).toString("base64");
        parts.push({ type: "image" as const, data: base64, mimeType: "image/png" });
      }

      const { elements } = result.json;
      if (elements.length > 0) {
        return {
          content: parts,
          structuredContent: {
            type: "resource" as const,
            resource: { uri: "ui://widget", mimeType: "text/html" },
            context: { elements, appState: { viewBackgroundColor: "#ffffff" } },
          },
        };
      }

      return { content: parts };
    },
  );

  server.tool(
    "draw_info",
    "Get information about drawmode capabilities.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: `drawmode — WASM: ${isWasmLoaded() ? "loaded" : "not loaded"}`,
      }],
    }),
  );

  return server;
}

let client: Client;
let server: McpServer;

beforeAll(async () => {
  await loadWasm();

  server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "e2e-test", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe("e2e: MCP draw tool", () => {
  it("lists draw and draw_info tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain("draw");
    expect(names).toContain("draw_info");
  });

  it("draw_info returns capabilities", async () => {
    const result = await client.callTool({ name: "draw_info", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("drawmode");
  });

  it("draw with single box produces valid excalidraw JSON", async () => {
    const result = await client.callTool({
      name: "draw",
      arguments: {
        code: `
          const d = new Diagram();
          d.addBox("API Gateway", { row: 0, col: 0, color: "backend" });
          return d.render({ format: "excalidraw" });
        `,
        format: "excalidraw",
        path: "/tmp/e2e-test-single.excalidraw",
      },
    });

    expect(result.isError).toBeFalsy();
    const parts = result.content as Array<{ type: string; text: string }>;

    // Should have "Saved to" and "Generated N elements"
    const savedPart = parts.find(p => p.text.includes("Saved to"));
    expect(savedPart).toBeDefined();

    const countPart = parts.find(p => p.text.includes("Generated"));
    expect(countPart).toBeDefined();
    // 1 box = 1 rect + 1 text = 2 elements
    expect(countPart!.text).toContain("2 elements");

    // Parse the JSON output
    const jsonPart = parts.find(p => p.text.startsWith("{"));
    expect(jsonPart).toBeDefined();
    const excalidraw = JSON.parse(jsonPart!.text);
    expect(excalidraw.type).toBe("excalidraw");
    expect(excalidraw.version).toBe(2);
    expect(excalidraw.source).toBe("drawmode");
    expect(excalidraw.elements).toHaveLength(2);

    // Verify shape + text pair
    const rect = excalidraw.elements.find((e: Record<string, unknown>) => e.type === "rectangle");
    const text = excalidraw.elements.find((e: Record<string, unknown>) => e.type === "text");
    expect(rect).toBeDefined();
    expect(text).toBeDefined();
    expect(text.containerId).toBe(rect.id);
    expect(text.text).toBe("API Gateway");
    expect(rect.backgroundColor).toBe("#d0bfff"); // backend color
    expect(rect.strokeColor).toBe("#7048e8");
  });

  it("draw with multiple boxes, arrows, labels, and groups", async () => {
    const result = await client.callTool({
      name: "draw",
      arguments: {
        code: `
          const d = new Diagram();
          const user = d.addEllipse("User", { row: 0, col: 1, color: "users" });
          const api = d.addBox("API Gateway", { row: 1, col: 1, color: "backend" });
          const db = d.addBox("Postgres", { row: 2, col: 0, color: "database" });
          const cache = d.addBox("Redis", { row: 2, col: 2, color: "cache" });
          d.connect(user, api, "requests");
          d.connect(api, db, "queries");
          d.connect(api, cache, "reads", { style: "dashed" });
          d.addGroup("Data Layer", [db, cache]);
          return d.render({ format: "excalidraw" });
        `,
        format: "excalidraw",
        path: "/tmp/e2e-test-full.excalidraw",
      },
    });

    expect(result.isError).toBeFalsy();
    const parts = result.content as Array<{ type: string; text: string }>;
    const jsonPart = parts.find(p => p.text.startsWith("{"));
    expect(jsonPart).toBeDefined();
    const excalidraw = JSON.parse(jsonPart!.text);

    const elements = excalidraw.elements as Record<string, unknown>[];

    // 4 shapes × 2 (rect/ellipse + text) = 8
    // 3 arrows = 3
    // 3 arrow labels (each has bound text) = 3
    // 1 group rect + 1 group label = 2
    // Total = 16
    expect(elements.length).toBe(16);

    // Verify element types present
    const types = elements.map(e => e.type);
    expect(types.filter(t => t === "rectangle").length).toBeGreaterThanOrEqual(4); // 3 boxes + 1 group rect
    expect(types.filter(t => t === "ellipse").length).toBe(1);
    expect(types.filter(t => t === "arrow").length).toBe(3);
    expect(types.filter(t => t === "text").length).toBeGreaterThanOrEqual(7); // 4 shape labels + 3 arrow labels

    // Verify arrows have correct bindings
    const arrows = elements.filter(e => e.type === "arrow");
    for (const arrow of arrows) {
      const startBinding = arrow.startBinding as { elementId: string } | null;
      const endBinding = arrow.endBinding as { elementId: string } | null;
      expect(startBinding).toBeDefined();
      expect(endBinding).toBeDefined();

      // Source and target should exist in elements
      expect(elements.find(e => e.id === startBinding!.elementId)).toBeDefined();
      expect(elements.find(e => e.id === endBinding!.elementId)).toBeDefined();
    }

    // Verify arrow labels
    for (const arrow of arrows) {
      const bound = arrow.boundElements as Array<{ type: string; id: string }> | null;
      expect(bound).toBeTruthy();
      expect(bound!.length).toBe(1);
      const labelEl = elements.find(e => e.id === bound![0].id);
      expect(labelEl).toBeDefined();
      expect(labelEl!.type).toBe("text");
      expect(labelEl!.containerId).toBe(arrow.id);
    }

    // Verify dashed arrow
    const dashedArrow = arrows.find(a => a.strokeStyle === "dashed");
    expect(dashedArrow).toBeDefined();

    // Verify group rectangle
    const groupRects = elements.filter(
      e => e.type === "rectangle" && e.strokeStyle === "dashed",
    );
    expect(groupRects.length).toBe(1);

    // Verify elbow routing: bottom-to-top arrow should have points
    for (const arrow of arrows) {
      const points = arrow.points as number[][];
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(points[0]).toEqual([0, 0]); // Always starts at origin
    }

    // Verify structuredContent for widget
    expect(result.structuredContent).toBeDefined();
  });

  it("draw produces SVG output", async () => {
    const result = await client.callTool({
      name: "draw",
      arguments: {
        code: `
          const d = new Diagram();
          d.addBox("Service A", { row: 0, col: 0, color: "backend" });
          d.addBox("Service B", { row: 0, col: 1, color: "frontend" });
          return d.render({ format: "svg" });
        `,
        format: "svg",
      },
    });

    expect(result.isError).toBeFalsy();
    const parts = result.content as Array<{ type: string; text: string }>;

    const svgPart = parts.find(p => p.text.includes("<svg"));
    expect(svgPart).toBeDefined();
    expect(svgPart!.text).toContain("<rect");
    expect(svgPart!.text).toContain("</svg>");
    expect(svgPart!.text).toContain("viewBox");
  });

  it("draw produces PNG output", async () => {
    const result = await client.callTool({
      name: "draw",
      arguments: {
        code: `
          const d = new Diagram();
          d.addBox("PNG Test", { row: 0, col: 0 });
          return d.render({ format: "png" });
        `,
        format: "png",
      },
    });

    expect(result.isError).toBeFalsy();
    const parts = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

    const imgPart = parts.find(p => p.type === "image");
    expect(imgPart).toBeDefined();
    expect(imgPart!.mimeType).toBe("image/png");
    expect(imgPart!.data!.length).toBeGreaterThan(100); // PNG base64 should be substantial

    // Verify it's valid base64
    const pngBytes = Buffer.from(imgPart!.data!, "base64");
    // PNG magic bytes: 137 80 78 71
    expect(pngBytes[0]).toBe(137);
    expect(pngBytes[1]).toBe(80);
    expect(pngBytes[2]).toBe(78);
    expect(pngBytes[3]).toBe(71);
  });

  it("draw handles syntax errors gracefully", async () => {
    const result = await client.callTool({
      name: "draw",
      arguments: {
        code: `const d = new Diagram(; broken`,
        format: "excalidraw",
      },
    });

    expect(result.isError).toBe(true);
    const parts = result.content as Array<{ type: string; text: string }>;
    expect(parts[0].text).toContain("Error:");
  });

  it("draw handles runtime errors gracefully", async () => {
    const result = await client.callTool({
      name: "draw",
      arguments: {
        code: `
          const d = new Diagram();
          d.nonExistent();
          return d.render();
        `,
        format: "excalidraw",
      },
    });

    expect(result.isError).toBe(true);
    const parts = result.content as Array<{ type: string; text: string }>;
    expect(parts[0].text).toContain("Error:");
  });

  it("draw handles missing return gracefully", async () => {
    const result = await client.callTool({
      name: "draw",
      arguments: {
        code: `
          const d = new Diagram();
          d.addBox("Test");
        `,
        format: "excalidraw",
      },
    });

    expect(result.isError).toBe(true);
    const parts = result.content as Array<{ type: string; text: string }>;
    expect(parts[0].text).toContain("Error:");
    expect(parts[0].text).toContain("return");
  });

  it("excalidraw file is written to disk and valid JSON", async () => {
    const outPath = "/tmp/e2e-disk-test.excalidraw";

    await client.callTool({
      name: "draw",
      arguments: {
        code: `
          const d = new Diagram();
          d.addBox("Disk Test", { row: 0, col: 0 });
          return d.render({ format: "excalidraw" });
        `,
        format: "excalidraw",
        path: outPath,
      },
    });

    // Verify file was written
    const content = await readFile(outPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe("excalidraw");
    expect(parsed.elements.length).toBe(2);
  });

  it("structuredContent includes widget resource and elements", async () => {
    const result = await client.callTool({
      name: "draw",
      arguments: {
        code: `
          const d = new Diagram();
          d.addBox("Widget Test", { row: 0, col: 0 });
          return d.render({ format: "excalidraw" });
        `,
        format: "excalidraw",
        path: "/tmp/e2e-widget-test.excalidraw",
      },
    });

    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.type).toBe("resource");

    const resource = sc.resource as Record<string, unknown>;
    expect(resource.uri).toBe("ui://widget");
    expect(resource.mimeType).toBe("text/html");

    const context = sc.context as Record<string, unknown>;
    expect(context.elements).toBeDefined();
    expect(Array.isArray(context.elements)).toBe(true);
    expect((context.elements as unknown[]).length).toBe(2);
  });

  it("widget resource serves HTML", async () => {
    const { resources } = await client.listResources();
    const widget = resources.find(r => r.uri === "ui://widget");
    expect(widget).toBeDefined();

    const result = await client.readResource({ uri: "ui://widget" });
    const content = result.contents[0] as { uri: string; text: string; mimeType?: string };
    expect(content.mimeType).toBe("text/html");
    expect(content.text).toContain("<!DOCTYPE html>");
    expect(content.text).toContain("excalidraw");
    expect(content.text).toContain("postMessage");
  });
});
