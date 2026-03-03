#!/usr/bin/env node
/**
 * drawmode — Code Mode MCP server for Excalidraw architecture diagrams.
 *
 * Usage:
 *   npx drawmode --stdio   # For Claude Code, Claude Desktop, Cursor
 *   npx drawmode            # Streamable HTTP on port 3001
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeCode } from "./executor.js";
import { loadWasm, isWasmLoaded } from "./layout.js";
import { Diagram } from "./sdk.js";

const SDK_TYPES = `
declare class Diagram {
  /** Add a rectangle. Returns element ID. */
  addBox(label: string, opts?: {
    row?: number; col?: number;
    color?: "frontend" | "backend" | "database" | "storage" | "ai" | "external" | "orchestration" | "queue" | "cache" | "users";
    width?: number; height?: number;
  }): string;

  /** Add an ellipse. Returns element ID. */
  addEllipse(label: string, opts?: {
    row?: number; col?: number;
    color?: "frontend" | "backend" | "database" | "storage" | "ai" | "external" | "orchestration" | "queue" | "cache" | "users";
  }): string;

  /** Group elements with a dashed boundary. Returns group ID. */
  addGroup(label: string, children: string[]): string;

  /** Connect two elements with an arrow. */
  connect(from: string, to: string, label?: string, opts?: { style?: "solid" | "dashed" }): void;

  /** Render the diagram. Always return this from your code. */
  render(opts?: {
    format?: "excalidraw" | "url" | "png" | "svg";
    path?: string;
  }): Promise<{ json: object; url?: string; filePath?: string }>;
}
`;

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
const cache = d.addBox("Redis", { row: 1, col: 2, color: "cache" });
d.connect(api, db, "queries");
d.connect(api, cache, "reads", { style: "dashed" });
d.addGroup("Data Layer", [db, cache]);
return d.render({ format: "url" });
\`\`\`

Grid layout: row 0 is top, col 0 is left. Elements auto-position if row/col omitted.`,
  {
    code: z.string().describe("TypeScript code using the Diagram class. Must return d.render()."),
    format: z.enum(["excalidraw", "url"]).default("excalidraw").describe("Output format"),
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

    const parts: { type: "text"; text: string }[] = [];

    if (result.url) {
      parts.push({ type: "text" as const, text: `Excalidraw URL: ${result.url}` });
    }
    if (result.filePath) {
      parts.push({ type: "text" as const, text: `Saved to: ${result.filePath}` });
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
        text: `drawmode — Code Mode MCP for Excalidraw diagrams

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

WASM layout: ${isWasmLoaded() ? "loaded" : "not loaded (using TS grid layout)"}`,
      }],
    };
  },
);

async function main(): Promise<void> {
  // Try to load WASM layout engine (non-fatal if missing)
  await loadWasm();

  const args = process.argv.slice(2);
  const useStdio = args.includes("--stdio");

  if (useStdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    // Streamable HTTP mode
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const http = await import("node:http");

    const httpServer = http.createServer(async (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", wasm: isWasmLoaded() }));
        return;
      }

      if (req.method === "POST" && req.url === "/mcp") {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    const port = parseInt(process.env.PORT ?? "3001", 10);
    httpServer.listen(port, () => {
      console.log(`drawmode MCP server listening on http://localhost:${port}/mcp`);
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
