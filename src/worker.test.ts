// @ts-nocheck — worker/index.ts uses Cloudflare Workers types (Fetcher, etc.)
// that are not available in the main tsconfig. Tests run fine via vitest.
/**
 * Cloudflare Worker tests — exercises the Worker fetch handler directly.
 *
 * Imports the Worker's default export and calls fetch() with constructed
 * Request objects. No wrangler or Cloudflare runtime needed — tests run
 * in vitest with the same Node.js environment as other tests.
 *
 * Tests cover:
 * - Health endpoint
 * - CORS preflight
 * - MCP tool listing (draw, draw_info)
 * - MCP draw tool — single box diagram
 * - MCP draw tool — complex diagram with arrows and groups
 * - MCP draw tool — error handling (syntax, runtime, missing return)
 * - MCP draw_info tool
 * - PNG format fallback (no browser binding)
 * - Format coercion (excalidraw → url)
 * - 404 for unknown routes
 */

import { describe, it, expect, vi } from "vitest";

// Mock @cloudflare/puppeteer — only available in Cloudflare Workers runtime
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: () => { throw new Error("not in worker"); } } }));

import worker from "../worker/index.js";

const BASE = "https://drawmode.test";
const env = { MYBROWSER: undefined as unknown as Fetcher };

/** Send a JSON-RPC request to the Worker's /mcp endpoint */
async function mcpCall(method: string, params: Record<string, unknown> = {}, id: number | string = 1): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, id };
  if (Object.keys(params).length > 0) body.params = params;

  const resp = await worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    }),
    env,
  );

  expect(resp.status).toBe(200);
  const data = await resp.json() as Record<string, unknown>;
  return data;
}

/** Helper: call draw tool and return content parts */
async function drawCall(code: string, format = "url"): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
  const data = await mcpCall("tools/call", {
    name: "draw",
    arguments: { code, format },
  });
  expect(data.error).toBeUndefined();
  return data.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
}

describe("worker: health and routing", () => {
  it("GET /health returns ok", async () => {
    const resp = await worker.fetch(new Request(`${BASE}/health`), env);
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("drawmode");
    expect(body.mode).toBe("worker");
  });

  it("OPTIONS returns CORS headers", async () => {
    const resp = await worker.fetch(
      new Request(`${BASE}/mcp`, { method: "OPTIONS" }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(resp.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("GET /unknown returns 404", async () => {
    const resp = await worker.fetch(new Request(`${BASE}/unknown`), env);
    expect(resp.status).toBe(404);
  });
});

describe("worker: MCP protocol", () => {
  it("initialize handshake succeeds", async () => {
    const data = await mcpCall("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    expect(data.result).toBeDefined();
    const result = data.result as Record<string, unknown>;
    expect(result.protocolVersion).toBeDefined();
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("drawmode");
  });

  it("lists draw and draw_info tools", async () => {
    await mcpCall("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    }, "init");

    const data = await mcpCall("tools/list", {}, "list");
    const result = data.result as { tools: Array<{ name: string }> };
    const names = result.tools.map(t => t.name);
    expect(names).toContain("draw");
    expect(names).toContain("draw_info");
  });
});

describe("worker: MCP draw tool", () => {
  it("single box produces valid elements", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      d.addBox("API Gateway", { row: 0, col: 0, color: "backend" });
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 1 box = 1 rect + 1 text = 2 elements
    const countPart = result.content.find(p => p.text?.includes("Generated"));
    expect(countPart).toBeDefined();
    expect(countPart!.text).toContain("2 elements");
  });

  it("complex diagram with arrows and groups", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const api = d.addBox("API", { row: 0, col: 1, color: "backend" });
      const db = d.addBox("DB", { row: 1, col: 0, color: "database" });
      const cache = d.addBox("Cache", { row: 1, col: 2, color: "cache" });
      d.connect(api, db, "writes");
      d.connect(api, cache, "reads", { style: "dashed" });
      d.addGroup("Data", [db, cache]);
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const countPart = result.content.find(p => p.text?.includes("Generated"));
    expect(countPart).toBeDefined();
    const count = parseInt(countPart!.text!.match(/(\d+) elements/)![1]);
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it("handles syntax errors", async () => {
    const result = await drawCall("const d = new Diagram(; broken");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("handles runtime errors", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      d.nonExistent();
      return d.render();
    `);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("handles missing return", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      d.addBox("Test");
    `);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("PNG format falls back when no browser binding", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      d.addBox("PNG Test", { color: "ai" });
      return d.render({ format: "url" });
    `, "png");

    expect(result.isError).toBeFalsy();
    // Should mention unavailability or failure since MYBROWSER is undefined
    const hasNote = result.content.some(p =>
      p.text?.includes("unavailable") || p.text?.includes("failed") || p.text?.includes("PNG"),
    );
    expect(hasNote).toBe(true);

    // Should still produce elements
    const countPart = result.content.find(p => p.text?.includes("Generated"));
    expect(countPart).toBeDefined();
  });

  it("excalidraw format is coerced to url in worker", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      d.addBox("Coerce Test");
      return d.render({ format: "excalidraw" });
    `, "excalidraw");

    expect(result.isError).toBeFalsy();
    // Worker coerces excalidraw → url via WORKER_FORMAT_MAP
    // Should produce elements regardless of upload success
    const countPart = result.content.find(p => p.text?.includes("Generated"));
    expect(countPart).toBeDefined();
  });
});

describe("worker: MCP draw_info tool", () => {
  it("returns capabilities info", async () => {
    const data = await mcpCall("tools/call", {
      name: "draw_info",
      arguments: {},
    });

    expect(data.error).toBeUndefined();
    const result = data.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toContain("drawmode");
    expect(result.content[0].text).toContain("Worker mode");
  });
});

describe("worker: CORS on MCP responses", () => {
  it("MCP responses include CORS headers", async () => {
    const resp = await worker.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      }),
      env,
    );

    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
