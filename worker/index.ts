/**
 * Cloudflare Worker entry — remote MCP server for drawmode.
 *
 * Handles:
 * - POST /mcp — Streamable HTTP MCP transport (stateless)
 * - GET /health — Health check
 * - POST /proxy/excalidraw — Proxy for excalidraw.com upload (no CORS on their API)
 *
 * Note: No WASM support in Worker — uses TS-only grid layout via the SDK.
 * PNG export uses Cloudflare Browser Rendering (puppeteer) when available.
 */

import { Diagram } from "../src/sdk.js";
import type { RenderOpts, RenderResult } from "../src/types.js";
import { buildRenderHTML } from "../src/png.js";
import { SDK_TYPES } from "../src/sdk-types.js";
import puppeteer from "@cloudflare/puppeteer";

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
} as const;

interface Env {
  MYBROWSER: Fetcher;
}

/**
 * Render Excalidraw elements to PNG via Cloudflare Browser Rendering.
 * Returns base64-encoded PNG string, or null if browser binding unavailable.
 */
async function renderPng(elements: unknown[], env: Env): Promise<string | null> {
  if (!env.MYBROWSER) return null;

  const renderHTML = buildRenderHTML(elements);

  let browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setContent(renderHTML, { waitUntil: "networkidle0" });
    await page.waitForFunction("window.__DONE", { timeout: 15000 });

    const error = await page.evaluate(() => (window as unknown as Record<string, string>).__ERROR);
    if (error) throw new Error(error);

    const pngBase64 = await page.evaluate(() => (window as unknown as Record<string, string>).__PNG_DATA__);
    return pngBase64 as string;
  } finally {
    if (browser) await browser.close();
  }
}

async function executeCodeInWorker(code: string, renderOpts: RenderOpts): Promise<{ result: { json: object; url?: string; filePath?: string }; error?: string }> {
  try {
    // Per-execution subclass avoids mutating Diagram.prototype across concurrent requests.
    // Worker has no filesystem — force file-writing formats to "url".
    class ConfiguredDiagram extends Diagram {
      override async render(opts?: RenderOpts): Promise<RenderResult> {
        const merged = { ...renderOpts, ...opts };
        if (merged.format === "excalidraw") {
          merged.format = "url";
        }
        return super.render(merged);
      }
    }

    const wrappedCode = `
      return (async () => {
        ${code}
      })();
    `;

    const fn = new Function("Diagram", wrappedCode);
    const result = await fn(ConfiguredDiagram);

    if (!result || typeof result !== "object") {
      return {
        result: { json: {} },
        error: "Code did not return a RenderResult. Make sure to return d.render().",
      };
    }

    return { result };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { result: { json: {} }, error: message };
  }
}



export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "drawmode", mode: "worker" });
    }

    // MCP endpoint — stateless JSON-RPC handler
    if (request.method === "POST" && url.pathname === "/mcp") {
      try {
        // Parse the JSON-RPC request from the body
        const body = await request.json() as { method: string; id?: string | number; params?: Record<string, unknown> };

        // Handle JSON-RPC methods directly for stateless Worker deployment
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "drawmode", version: "0.1.0" },
              capabilities: { tools: {} },
            },
          }, { headers: corsHeaders });
        }

        if (body.method === "tools/list") {
          // Return tool definitions
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "draw",
                  description: "Generate an Excalidraw architecture diagram by writing TypeScript code.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "TypeScript code using the Diagram class." },
                      format: { type: "string", enum: ["excalidraw", "url", "png"], default: "excalidraw" },
                    },
                    required: ["code"],
                  },
                },
                {
                  name: "draw_info",
                  description: "Get information about drawmode capabilities, color presets, and SDK reference.",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }, { headers: corsHeaders });
        }

        if (body.method === "tools/call") {
          const params = body.params as { name: string; arguments?: Record<string, unknown> } | undefined;
          const toolName = params?.name;
          const args = params?.arguments ?? {};

          if (toolName === "draw") {
            const code = args.code as string;
            const wantsPng = (args.format as string) === "png";
            // Always build as "url" internally — PNG is a post-processing step
            const { result, error } = await executeCodeInWorker(code, { format: "url" });

            if (error) {
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  content: [{ type: "text", text: `Error: ${error}` }],
                  isError: true,
                },
              }, { headers: corsHeaders });
            }

            const elements = Array.isArray((result.json as { elements?: unknown[] }).elements)
              ? (result.json as { elements: unknown[] }).elements
              : [];
            const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

            // PNG export via Cloudflare Browser Rendering
            if (wantsPng) {
              try {
                const pngBase64 = await renderPng(elements, env);
                if (pngBase64) {
                  parts.push({ type: "image", data: pngBase64, mimeType: "image/png" });
                } else {
                  // Browser binding unavailable — fall back to URL
                  if (result.url) parts.push({ type: "text", text: result.url });
                  parts.push({ type: "text", text: "PNG export unavailable (no browser binding). Fell back to URL." });
                }
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                if (result.url) parts.push({ type: "text", text: result.url });
                parts.push({ type: "text", text: `PNG export failed: ${msg}. Fell back to URL.` });
              }
            } else {
              if (result.url) {
                parts.push({ type: "text", text: result.url });
              }
            }

            parts.push({ type: "text", text: `Generated ${elements.length} elements` });

            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: parts },
            }, { headers: corsHeaders });
          }

          if (toolName === "draw_info") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{
                  type: "text",
                  text: `drawmode — Code Mode MCP for Excalidraw diagrams (Worker mode)\n\nColor presets: frontend, backend, database, storage, ai, external, orchestration, queue, cache, users\n\n${SDK_TYPES}\n\nWASM layout: not available (Worker mode)`,
                }],
              },
            }, { headers: corsHeaders });
          }

          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          }, { headers: corsHeaders });
        }

        // JSON-RPC notifications (no id) should be silently accepted
        if (body.id === undefined || body.id === null) {
          return new Response(null, { status: 204 });
        }

        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `Method not found: ${body.method}` },
        }, { headers: corsHeaders });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return Response.json({ jsonrpc: "2.0", error: { code: -32603, message } }, { status: 500 });
      }
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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
