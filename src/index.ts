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
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { executeCode } from "./executor.js";
import { loadWasm, isWasmLoaded } from "./layout.js";
import { Diagram } from "./sdk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  x?: number; y?: number;               // absolute positioning (bypasses grid)
  strokeColor?: string;                  // hex override
  backgroundColor?: string;             // hex override
  fillStyle?: FillStyle;                 // default "solid"
  strokeWidth?: number;                  // default 2
  strokeStyle?: StrokeStyle;             // default "solid"
  roughness?: number;                    // 0=architect, 1=artist, 2=cartoonist
  opacity?: number;                      // 0-100
  roundness?: { type: number } | null;
  fontSize?: number;                     // default 16
  fontFamily?: FontFamily;               // default 1
  textAlign?: TextAlign;
  verticalAlign?: VerticalAlign;
  link?: string | null;                  // hyperlink URL
  customData?: Record<string, unknown> | null; // arbitrary metadata
}

interface ConnectOpts {
  style?: StrokeStyle;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  startArrowhead?: Arrowhead;            // default null
  endArrowhead?: Arrowhead;              // default "arrow"
  elbowed?: boolean;                     // default true
  labelFontSize?: number;
  customData?: Record<string, unknown> | null; // arbitrary metadata
}

declare class Diagram {
  /** Add a rectangle. Returns element ID. */
  addBox(label: string, opts?: ShapeOpts): string;

  /** Add an ellipse. Returns element ID. */
  addEllipse(label: string, opts?: ShapeOpts): string;

  /** Add a diamond shape (for flowchart decisions). Returns element ID. */
  addDiamond(label: string, opts?: ShapeOpts): string;

  /** Add standalone text (no container). Returns element ID. */
  addText(text: string, opts?: {
    x?: number; y?: number;
    fontSize?: number; fontFamily?: FontFamily;
    color?: ColorPreset; strokeColor?: string;
  }): string;

  /** Add a line element. Returns element ID. */
  addLine(points: [number, number][], opts?: {
    strokeColor?: string; strokeWidth?: number; strokeStyle?: StrokeStyle;
  }): string;

  /** Group elements with a dashed boundary. Returns group ID. */
  addGroup(label: string, children: string[]): string;

  /** Add a native Excalidraw frame container. Returns frame ID. */
  addFrame(name: string, children: string[]): string;

  /** Remove a group container. Children are kept. */
  removeGroup(id: string): void;

  /** Remove a frame container. Children are kept. */
  removeFrame(id: string): void;

  /** Connect two elements with an arrow. */
  connect(from: string, to: string, label?: string, opts?: ConnectOpts): void;

  /** Load existing .excalidraw file for editing. */
  static fromFile(path: string): Promise<Diagram>;

  /** Find node IDs by label match. Substring by default, exact with opts. */
  findByLabel(label: string, opts?: { exact?: boolean }): string[];

  /** Get all node IDs. */
  getNodes(): string[];

  /** Get all edges. */
  getEdges(): Array<{ from: string; to: string; label?: string }>;

  /** Update a node's properties. */
  updateNode(id: string, opts: Partial<ShapeOpts> & { label?: string }): void;

  /** Update an existing edge's properties. Optional matchLabel disambiguates multi-edges. */
  updateEdge(from: string, to: string, update: Partial<ConnectOpts> & { label?: string }, matchLabel?: string): void;

  /** Remove a node and its connected edges. */
  removeNode(id: string): void;

  /** Remove an edge between two nodes. Optional label disambiguates multi-edges. */
  removeEdge(from: string, to: string, label?: string): void;

  /** Render the diagram. Always return this from your code. */
  render(opts?: {
    format?: "excalidraw" | "url";
    path?: string;
  }): Promise<{ json: object; url?: string; filePath?: string }>;
}
`;

let cachedWidgetHtml: string | null = null;

async function loadWidgetHtml(): Promise<string> {
  if (cachedWidgetHtml) return cachedWidgetHtml;
  const widgetPath = join(__dirname, "widget.html");
  cachedWidgetHtml = await readFile(widgetPath, "utf-8");
  return cachedWidgetHtml;
}

/** Register tools and resources on an McpServer instance. */
function registerHandlers(server: McpServer): void {
  // Register widget HTML as a ui:// resource for MCP Apps
  server.resource(
    "widget",
    "ui://widget",
    { description: "Interactive Excalidraw diagram widget", mimeType: "text/html" },
    async () => {
      const html = await loadWidgetHtml();
      return { contents: [{ uri: "ui://widget", mimeType: "text/html", text: html }] };
    },
  );

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

Example — custom styling:
\`\`\`typescript
const d = new Diagram();
d.addBox("Sketch Style", { fillStyle: "hachure", roughness: 2 });
d.addBox("Clean Style", { fillStyle: "solid", roughness: 0, opacity: 80 });
d.connect(a, b, "flow", { startArrowhead: "dot", endArrowhead: "triangle" });
return d.render();
\`\`\`

Example — edit existing diagram:
\`\`\`typescript
const d = await Diagram.fromFile("diagram.excalidraw");
const ids = d.findByLabel("Old Service");
if (ids.length > 0) d.updateNode(ids[0], { label: "New Service", color: "ai" });
d.removeNode(d.findByLabel("Deprecated")[0]);
return d.render({ path: "diagram.excalidraw" });
\`\`\`

Grid layout: row 0 is top, col 0 is left. Elements auto-position if row/col omitted.
Use x/y for absolute pixel positioning (bypasses grid).`,
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

      // Return minimal responses to avoid bloating context:
      // - url format: just the URL
      // - excalidraw format: just the file path
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      if (format === "url" && result.url) {
        parts.push({ type: "text" as const, text: result.url });
      } else if (result.filePath) {
        parts.push({ type: "text" as const, text: result.filePath });
      } else if (result.url) {
        parts.push({ type: "text" as const, text: result.url });
      }

      // MCP requires at least one content item
      if (parts.length === 0) {
        parts.push({ type: "text" as const, text: "Diagram generated successfully" });
      }

      const elements = (result.json as { elements?: unknown[] }).elements ?? [];
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
    "Get information about drawmode capabilities, color presets, and SDK reference.",
    {},
    async () => {
      return {
        content: [{
          type: "text" as const,
          text: `drawmode — Code Mode MCP for Excalidraw diagrams

## Color Presets

### General
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

### AWS
| Preset       | Use for              |
|--------------|----------------------|
| aws-compute  | Lambda, EC2, ECS     |
| aws-storage  | S3, EFS, EBS         |
| aws-database | RDS, DynamoDB        |
| aws-network  | VPC, CloudFront, ALB |
| aws-security | IAM, WAF, Cognito    |
| aws-ml       | SageMaker, Bedrock   |

### Azure
| Preset        | Use for              |
|---------------|----------------------|
| azure-compute | VMs, Functions, AKS  |
| azure-data    | SQL, Cosmos, Storage |
| azure-network | VNet, Front Door     |
| azure-ai      | OpenAI, Cognitive    |

### GCP
| Preset      | Use for              |
|-------------|----------------------|
| gcp-compute | GCE, Cloud Run, GKE  |
| gcp-data    | BigQuery, Firestore  |
| gcp-network | VPC, Cloud CDN       |
| gcp-ai      | Vertex AI            |

### Kubernetes
| Preset      | Use for              |
|-------------|----------------------|
| k8s-pod     | Pods, Deployments    |
| k8s-service | Services, Endpoints  |
| k8s-ingress | Ingress, Gateways    |
| k8s-volume  | PVs, PVCs, Storage   |

## Editing Existing Diagrams

\`\`\`typescript
const d = await Diagram.fromFile("diagram.excalidraw");
const ids = d.findByLabel("API");       // substring search
d.updateNode(ids[0], { label: "New API", color: "ai" });
d.removeNode(d.findByLabel("Old")[0]);  // removes node + connected edges
return d.render({ path: "diagram.excalidraw" });
\`\`\`

## SDK Reference
${SDK_TYPES}

WASM layout: ${isWasmLoaded() ? "loaded" : "not loaded (using TS grid layout)"}`,
        }],
      };
    },
  );
}

/** Create a new McpServer with all tools/resources registered. */
function createServer(): McpServer {
  const server = new McpServer({ name: "drawmode", version: "0.1.0" });
  registerHandlers(server);
  return server;
}

async function main(): Promise<void> {
  // Try to load WASM layout engine (non-fatal if missing)
  await loadWasm();

  const args = process.argv.slice(2);
  const useStdio = args.includes("--stdio");

  if (useStdio) {
    // Stdio mode: single client, single server instance
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    // Streamable HTTP mode: one server + transport per session
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const http = await import("node:http");

    const sessions = new Map<string, {
      server: McpServer;
      transport: InstanceType<typeof StreamableHTTPServerTransport>;
      lastActivity: number;
    }>();

    // Cleanup stale sessions every 10 minutes (30-minute TTL)
    const SESSION_TTL = 30 * 60 * 1000;
    setInterval(() => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.lastActivity > SESSION_TTL) {
          session.transport.close?.();
          sessions.delete(id);
        }
      }
    }, 10 * 60 * 1000).unref();

    const httpServer = http.createServer(async (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", wasm: isWasmLoaded() }));
        return;
      }

      if (req.url === "/mcp") {
        // Reuse existing session if session header present
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          session.lastActivity = Date.now();
          await session.transport.handleRequest(req, res);
          return;
        }

        // DELETE without a known session — nothing to clean up
        if (req.method === "DELETE") {
          res.writeHead(404);
          res.end("Session not found");
          return;
        }

        if (req.method === "POST") {
          // New session: create dedicated server + transport pair
          const sessionServer = createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await sessionServer.connect(transport);
          if (transport.sessionId) {
            sessions.set(transport.sessionId, { server: sessionServer, transport, lastActivity: Date.now() });
          }
          await transport.handleRequest(req, res);
          return;
        }

        res.writeHead(405);
        res.end("Method not allowed");
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
