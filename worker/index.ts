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
import puppeteer from "@cloudflare/puppeteer";

interface Env {
  MYBROWSER: Fetcher;
}

/**
 * Render Excalidraw elements to PNG via Cloudflare Browser Rendering.
 * Returns base64-encoded PNG string, or null if browser binding unavailable.
 */
async function renderPng(elements: unknown[], env: Env): Promise<string | null> {
  if (!env.MYBROWSER) return null;

  const renderHTML = `<!DOCTYPE html>
<html>
<head>
<style>html, body { margin: 0; padding: 0; background: white; }</style>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@excalidraw/excalidraw/dist/excalidraw.production.min.js"></script>
</head>
<body>
<script>
(async () => {
  try {
    const elements = ${JSON.stringify(elements)};
    const svg = await ExcalidrawLib.exportToSvg({
      elements,
      appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
      files: null,
    });
    const svgStr = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth * 2;
      canvas.height = img.naturalHeight * 2;
      const ctx = canvas.getContext("2d");
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      window.__PNG_DATA__ = canvas.toDataURL("image/png").split(",")[1];
      window.__DONE = true;
    };
    img.onerror = () => {
      window.__ERROR = "Failed to load SVG as image";
      window.__DONE = true;
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
  } catch (e) {
    window.__ERROR = e.message || String(e);
    window.__DONE = true;
  }
})();
</script>
</body>
</html>`;

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

const SDK_TYPES = `
type FillStyle = "solid" | "hachure" | "cross-hatch" | "zigzag";
type StrokeStyle = "solid" | "dashed" | "dotted";
type FontFamily = 1 | 2 | 3;  // Virgil / Helvetica / Cascadia
type Arrowhead = null | "arrow" | "bar" | "dot" | "triangle" | "diamond" | "diamond_outline";
type TextAlign = "left" | "center" | "right";
type VerticalAlign = "top" | "middle";

type ColorPreset =
  | "frontend" | "backend" | "database" | "storage" | "ai" | "external" | "orchestration" | "queue" | "cache" | "users"
  | "aws-compute" | "aws-storage" | "aws-database" | "aws-network" | "aws-security" | "aws-ml"
  | "azure-compute" | "azure-data" | "azure-network" | "azure-ai"
  | "gcp-compute" | "gcp-data" | "gcp-network" | "gcp-ai"
  | "k8s-pod" | "k8s-service" | "k8s-ingress" | "k8s-volume";

interface ShapeOpts {
  row?: number; col?: number;
  color?: ColorPreset;
  width?: number; height?: number;
  x?: number; y?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: FillStyle;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  roughness?: number;
  opacity?: number;
  roundness?: { type: number } | null;
  fontSize?: number;
  fontFamily?: FontFamily;
  textAlign?: TextAlign;
  verticalAlign?: VerticalAlign;
  link?: string | null;
  customData?: Record<string, unknown> | null;
}

interface ConnectOpts {
  style?: StrokeStyle;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  startArrowhead?: Arrowhead;
  endArrowhead?: Arrowhead;
  elbowed?: boolean;
  labelFontSize?: number;
  customData?: Record<string, unknown> | null;
}

declare class Diagram {
  addBox(label: string, opts?: ShapeOpts): string;
  addEllipse(label: string, opts?: ShapeOpts): string;
  addDiamond(label: string, opts?: ShapeOpts): string;
  addText(text: string, opts?: { x?: number; y?: number; fontSize?: number; fontFamily?: FontFamily; color?: ColorPreset; strokeColor?: string }): string;
  addLine(points: [number, number][], opts?: { strokeColor?: string; strokeWidth?: number; strokeStyle?: StrokeStyle }): string;
  addGroup(label: string, children: string[]): string;
  addFrame(name: string, children: string[]): string;
  removeGroup(id: string): void;
  removeFrame(id: string): void;
  connect(from: string, to: string, label?: string, opts?: ConnectOpts): void;
  findByLabel(label: string, opts?: { exact?: boolean }): string[];
  getNodes(): string[];
  getEdges(): Array<{ from: string; to: string; label?: string }>;
  updateNode(id: string, opts: Partial<ShapeOpts> & { label?: string }): void;
  updateEdge(from: string, to: string, update: Partial<ConnectOpts> & { label?: string }, matchLabel?: string): void;
  removeNode(id: string): void;
  removeEdge(from: string, to: string, label?: string): void;
  render(opts?: { format?: "url" | "png" }): Promise<{ json: object; url?: string }>;
}
`;

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
          }, {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
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
          }, {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        if (body.method === "tools/call") {
          const params = body.params as { name: string; arguments?: Record<string, unknown> } | undefined;
          const toolName = params?.name;
          const args = params?.arguments ?? {};

          if (toolName === "draw") {
            const code = args.code as string;
            const requestedFormat = (args.format as string) ?? "url";
            const wantsPng = requestedFormat === "png";
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
              }, {
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
              });
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
            }, {
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
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
            }, {
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
          }

          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          }, {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // JSON-RPC notifications (no id) should be silently accepted
        if (body.id === undefined || body.id === null) {
          return new Response(null, { status: 204 });
        }

        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `Method not found: ${body.method}` },
        }, {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
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
