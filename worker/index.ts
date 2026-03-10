/**
 * Cloudflare Worker entry — remote MCP server for drawmode.
 *
 * Uses the same McpServer + tool registration pattern as the local server (src/index.ts),
 * with WebStandardStreamableHTTPServerTransport for CF Workers compatibility.
 *
 * Handles:
 * - POST/GET/DELETE /mcp — MCP Streamable HTTP transport (stateless)
 * - GET /health — Health check
 * - POST /proxy/excalidraw — Proxy for excalidraw.com upload (no CORS on their API)
 *
 * WASM (Graphviz layout + validation + PlutoSVG PNG rasterization) is loaded from DRAWMODE_WASM.
 * PNG export uses linkedom + PlutoSVG WASM — zero config, no browser binding needed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { SDK_TYPES } from "../src/sdk-types.js";
import { executeCode } from "../src/executor.js";
import { loadWasm, isWasmLoaded } from "../src/layout.js";
import { renderPngWasm } from "../src/png.js";
import wasmModule from "./wasm-module.js";

/** Worker has no filesystem — coerce excalidraw format to url */
const WORKER_FORMAT_MAP = { excalidraw: "url" } as const;

/**
 * Render Excalidraw elements to PNG via linkedom + PlutoSVG WASM.
 * No browser binding needed — runs entirely in-process.
 */
async function renderPng(elements: unknown[]): Promise<string | null> {
  const result = await renderPngWasm(elements);
  return result?.pngBase64 ?? null;
}

/** Create an McpServer with draw tools registered. */
function createServer(): McpServer {
  const server = new McpServer({ name: "drawmode", version: "0.1.0" });

  server.tool(
    "draw",
    `Generate or edit an Excalidraw architecture diagram by writing TypeScript code.

You have access to the \`Diagram\` class. Create a new diagram, add shapes, connect them, and return the render result.

TypeScript types available:
${SDK_TYPES}

Example — new diagram:
\`\`\`typescript
const d = new Diagram();
const api = d.addBox("API Gateway", { row: 0, col: 1, color: "backend" });
const db = d.addBox("Postgres", { row: 1, col: 0, color: "database" });
const cache = d.addBox("Redis", { row: 1, col: 2, color: "cache" });
d.connect(api, db, "queries");
d.connect(api, cache, "reads", { style: "dashed" });
d.addGroup("Data Layer", [db, cache]);
return d.render({ format: "url" });
\`\`\`

Grid layout: row 0 is top, col 0 is left. Elements auto-position if row/col omitted.`,
    {
      code: z.string().describe("TypeScript code using the Diagram class. Must return d.render()."),
      format: z.enum(["excalidraw", "url", "png"]).default("excalidraw").describe("Output format"),
    },
    async ({ code, format }) => {
      const wantsPng = format === "png";
      const { result, error } = await executeCode(code, { format: "url" }, WORKER_FORMAT_MAP);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error}` }],
          isError: true,
        };
      }

      const elements = result.json.elements ?? [];
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      if (wantsPng) {
        try {
          const pngBase64 = await renderPng(elements);
          if (pngBase64) {
            parts.push({ type: "image", data: pngBase64, mimeType: "image/png" });
          } else {
            if (result.url) parts.push({ type: "text", text: result.url });
            parts.push({ type: "text", text: "PNG export: WASM rasterization returned null. Fell back to URL." });
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (result.url) parts.push({ type: "text", text: result.url });
          parts.push({ type: "text", text: `PNG export failed: ${msg}. Fell back to URL.` });
        }
      } else if (result.url) {
        parts.push({ type: "text", text: result.url });
      }

      parts.push({ type: "text", text: `Generated ${elements.length} elements` });

      return { content: parts };
    },
  );

  server.tool(
    "draw_describe",
    `Convert Excalidraw JSON to editable TypeScript code.
Returns compact SDK code that recreates the diagram — much smaller than raw JSON.
Use this instead of reading .excalidraw JSON directly. Then modify the code and pass it to the draw tool.`,
    {
      json: z.string().describe("Excalidraw JSON string (the full .excalidraw file contents)"),
    },
    async ({ json }) => {
      try {
        const { Diagram } = await import("../src/sdk.js");
        const parsed = JSON.parse(json);
        const elements = parsed.elements ?? parsed;
        const d = Diagram.fromElements(elements);
        const code = d.toCode();
        return { content: [{ type: "text" as const, text: code }] };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    "draw_info",
    "Get information about drawmode capabilities, color presets, and SDK reference.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: `drawmode — Code Mode MCP for Excalidraw diagrams (Worker mode)\n\nColor presets: frontend, backend, database, storage, ai, external, orchestration, queue, cache, users\n\n${SDK_TYPES}\n\nWASM layout: ${isWasmLoaded() ? "active (Graphviz + validation + PlutoSVG PNG)" : "not loaded"}`,
      }],
    }),
  );

  return server;
}

/** Add CORS headers to a Response */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, _env?: Record<string, unknown>): Promise<Response> {
    // Load WASM on first request (Graphviz layout + validation + PlutoSVG)
    if (!isWasmLoaded()) {
      await loadWasm(wasmModule ?? undefined);
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "drawmode", mode: "worker", wasm: isWasmLoaded() });
    }

    // CORS preflight — must be handled before MCP transport (which rejects OPTIONS as 405)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version",
        },
      });
    }

    // MCP endpoint — stateless via WebStandardStreamableHTTPServerTransport
    if (url.pathname === "/mcp") {
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      return withCors(response);
    }

    // Proxy excalidraw.com upload (their API has no CORS headers)
    if (request.method === "POST" && url.pathname === "/proxy/excalidraw") {
      const body = await request.arrayBuffer();
      const resp = await fetch("https://json.excalidraw.com/api/v2/post/", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      });

      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
