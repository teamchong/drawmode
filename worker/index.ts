/**
 * Cloudflare Worker entry — remote MCP server for drawmode.
 *
 * Handles:
 * - POST /mcp — Streamable HTTP MCP transport (stateless)
 * - GET /health — Health check
 * - POST /proxy/excalidraw — Proxy for excalidraw.com upload (no CORS on their API)
 *
 * Note: No WASM support in Worker — uses TS-only grid layout via the SDK.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Diagram } from "../src/sdk.js";
import type { RenderOpts } from "../src/types.js";

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
  render(opts?: { format?: "excalidraw" | "url"; path?: string }): Promise<{ json: object; url?: string; filePath?: string }>;
}
`;

async function executeCodeInWorker(code: string, renderOpts: RenderOpts): Promise<{ result: { json: object; url?: string; filePath?: string }; error?: string }> {
  try {
    const origRender = Diagram.prototype.render;
    Diagram.prototype.render = function(opts?: RenderOpts) {
      return origRender.call(this, { ...renderOpts, ...opts });
    };

    const wrappedCode = `
      return (async () => {
        ${code}
      })();
    `;

    const fn = new Function("Diagram", wrappedCode);
    const result = await fn(Diagram);

    // Restore prototype
    Diagram.prototype.render = origRender;

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

function createServer(): McpServer {
  const server = new McpServer({
    name: "drawmode",
    version: "0.1.0",
  });

  server.tool(
    "draw",
    `Generate an Excalidraw architecture diagram by writing TypeScript code.

You have access to the \`Diagram\` class. Create a new diagram, add shapes, connect them, and return the render result.

TypeScript types available:
${SDK_TYPES}

Example:
\`\`\`typescript
const d = new Diagram();
const api = d.addBox("API Gateway", { row: 0, col: 1, color: "backend" });
const db = d.addBox("Postgres", { row: 1, col: 0, color: "database" });
d.connect(api, db, "queries");
return d.render({ format: "url" });
\`\`\`

Grid layout: row 0 is top, col 0 is left. Elements auto-position if row/col omitted.
Running in Cloudflare Worker mode — TS grid layout (no WASM). Formats: "excalidraw" and "url" only.`,
    {
      code: z.string().describe("TypeScript code using the Diagram class. Must return d.render()."),
      format: z.enum(["excalidraw", "url"]).default("excalidraw").describe("Output format"),
    },
    async ({ code, format }) => {
      const { result, error } = await executeCodeInWorker(code, { format });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error}` }],
          isError: true,
        };
      }

      const parts: { type: "text"; text: string }[] = [];

      if (result.url) {
        parts.push({ type: "text" as const, text: `Excalidraw URL: ${result.url}` });
      }

      const elementCount = Array.isArray((result.json as { elements?: unknown[] }).elements)
        ? (result.json as { elements: unknown[] }).elements.length
        : 0;
      parts.push({ type: "text" as const, text: `Generated ${elementCount} elements` });

      if (format === "excalidraw") {
        parts.push({ type: "text" as const, text: JSON.stringify(result.json, null, 2) });
      }

      return { content: parts };
    },
  );

  server.tool(
    "draw_info",
    "Get information about drawmode capabilities, color presets, and SDK reference.",
    {},
    async () => {
      return {
        content: [{
          type: "text" as const,
          text: `drawmode — Code Mode MCP for Excalidraw diagrams (Worker mode)

## Color Presets
| Preset        | Use for                    |
|---------------|----------------------------|
| frontend      | UI, browser, React         |
| backend       | APIs, services, servers    |
| database      | Postgres, MySQL, DynamoDB  |
| storage       | S3, R2, blob storage       |
| ai            | ML models, embeddings      |
| external      | Third-party APIs           |
| orchestration | K8s, Docker, schedulers    |
| queue         | Kafka, SQS, RabbitMQ       |
| cache         | Redis, Memcached           |
| users         | End users, actors          |

## SDK Reference
${SDK_TYPES}

WASM layout: not available (Worker mode — using TS grid layout)`,
        }],
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "drawmode", mode: "worker" });
    }

    // MCP endpoint — create a fresh server per request (stateless)
    if (request.method === "POST" && url.pathname === "/mcp") {
      try {
        const server = createServer();

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
                      format: { type: "string", enum: ["excalidraw", "url"], default: "excalidraw" },
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
            const format = (args.format as "excalidraw" | "url") ?? "excalidraw";
            const { result, error } = await executeCodeInWorker(code, { format });

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

            const parts: { type: "text"; text: string }[] = [];
            if (result.url) {
              parts.push({ type: "text", text: `Excalidraw URL: ${result.url}` });
            }
            const elementCount = Array.isArray((result.json as { elements?: unknown[] }).elements)
              ? (result.json as { elements: unknown[] }).elements.length
              : 0;
            parts.push({ type: "text", text: `Generated ${elementCount} elements` });
            if (format === "excalidraw") {
              parts.push({ type: "text", text: JSON.stringify(result.json, null, 2) });
            }

            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: parts },
            }, {
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
          }

          if (toolName === "draw_info") {
            // Re-use the server's tool handler by calling it directly
            void server; // server created but we handle inline for stateless
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
