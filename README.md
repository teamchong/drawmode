# drawmode

Code Mode MCP server for generating Excalidraw diagrams. LLMs write ~10 lines of TypeScript instead of ~500 lines of raw Excalidraw JSON. The SDK handles all the complexity (bound text elements, arrow binding math, elbow routing flags), and Graphviz handles layout.

```
Traditional:  LLM  ->  500 lines of JSON  ->  broken diagrams
drawmode:     LLM  ->  10 lines of TypeScript  ->  SDK + Graphviz  ->  valid diagrams
```

## Quick Start

### Claude Code

```bash
claude mcp add drawmode -- npx drawmode --stdio
```

### Claude Desktop / Cursor

Add to your MCP config (`claude_desktop_config.json` or Cursor settings):

```json
{
  "mcpServers": {
    "drawmode": {
      "command": "npx",
      "args": ["drawmode", "--stdio"]
    }
  }
}
```

### HTTP Mode

```bash
npx drawmode
# Streamable HTTP server on port 3001
```

### Remote (Cloudflare Workers)

Deploy the `worker/` directory to Cloudflare Workers for remote MCP access. Requires `nodejs_compat` and `unsafe_eval` compatibility flags.

## How It Works

1. The LLM receives the `draw` tool with TypeScript type definitions (~100 lines). Two companion tools — `draw_describe` (convert `.excalidraw` to TypeScript) and `draw_info` (capabilities reference) — support the workflow
2. The LLM writes code against the `Diagram` SDK
3. The executor runs the code via `new Function()` -- the SDK handles labels, colors, and IDs
4. Graphviz (C library statically linked in a Zig WASM module) handles layout positioning and edge routing
5. WASM validation checks the output for structural correctness
6. Output is returned as `.excalidraw` files, excalidraw.com URLs, PNGs, SVGs, or any combination

A `.drawmode.ts` sidecar file is always written alongside file output, preserving the source code for future iteration.

## SDK API Reference

### Constructor

```typescript
const d = new Diagram(opts?: {
  theme?: "default" | "sketch" | "blueprint" | "minimal";
  direction?: "TB" | "LR" | "RL" | "BT";
  type?: "architecture" | "sequence";
});
```

### Adding Elements

| Method | Description |
|--------|-------------|
| `addBox(label, opts?)` | Add a rectangle. Returns element ID. |
| `addEllipse(label, opts?)` | Add an ellipse. Returns element ID. |
| `addDiamond(label, opts?)` | Add a diamond. Returns element ID. |
| `addText(text, opts?)` | Add standalone text. Options: `x`, `y`, `fontSize`, `fontFamily`, `color`, `strokeColor`. |
| `addLine(points, opts?)` | Add a line from `[x, y][]` points. Options: `strokeColor`, `strokeWidth`, `strokeStyle`. |
| `addGroup(label, children, opts?)` | Add a visual group around children. Returns group ID. |
| `addFrame(name, children)` | Add an Excalidraw frame container. Returns frame ID. |
| `addActor(label, opts?)` | Add a sequence diagram actor. Returns element ID. |

### Connections

| Method | Description |
|--------|-------------|
| `connect(from, to, label?, opts?)` | Connect two elements with an arrow. |
| `message(from, to, label?, opts?)` | Sequence diagram message (alias for connect). |

### Querying

| Method | Description |
|--------|-------------|
| `findByLabel(label, opts?)` | Find element IDs by label substring. Pass `{ exact: true }` for exact match. |
| `getNodes()` | Get all node IDs. |
| `getEdges()` | Get all edges as `{ from, to, label }[]`. |
| `getNode(id)` | Get node details: label, type, width, height, etc. |

### Editing

| Method | Description |
|--------|-------------|
| `updateNode(id, update)` | Update a node's label, color, or any ShapeOpts property. |
| `updateEdge(from, to, update, matchLabel?)` | Update an edge's label, style, or any ConnectOpts property. |
| `removeNode(id)` | Remove a node and all its connected edges. |
| `removeEdge(from, to, label?)` | Remove a specific edge. |
| `removeGroup(id)` | Remove a group boundary (children are kept). |
| `removeFrame(id)` | Remove a frame (children are kept). |

### Configuration

| Method | Description |
|--------|-------------|
| `setTheme(theme)` | Apply a theme preset to all subsequent shapes. |
| `setDirection(direction)` | Set layout direction: `"TB"`, `"LR"`, `"RL"`, or `"BT"`. |

### Loading

| Method | Description |
|--------|-------------|
| `Diagram.fromFile(path)` | Load an existing `.excalidraw` file for editing. Returns `Promise<Diagram>`. |
| `Diagram.fromMermaid(syntax)` | Parse Mermaid syntax into a Diagram. Returns `Diagram`. |
| `d.toCode(opts?)` | Convert diagram state back to TypeScript SDK code. Used by `draw_describe` tool. |

### Rendering

```typescript
const result = await d.render(opts?: {
  format?: "excalidraw" | "url" | "png" | "svg" | Array<...>;
  path?: string;
});
```

Returns a `RenderResult`:

| Field | Description |
|-------|-------------|
| `json` | Raw Excalidraw JSON object |
| `url` | Shareable excalidraw.com link (format `"url"`) |
| `filePath` | Local file path written (format `"excalidraw"`) |
| `filePaths` | All file paths written (multi-format) |
| `pngBase64` | Base64-encoded PNG (format `"png"`) |
| `svgString` | SVG markup string (format `"svg"`) |
| `warnings` | Layout or validation warnings |
| `changeSummary` | Human-readable diff when overwriting an existing file |
| `stats` | `{ nodes, edges, groups }` |

### Shape Options

All fields optional. Sensible defaults are applied.

```typescript
interface ShapeOpts {
  row?: number; col?: number;         // Grid positioning (used by Graphviz layout)
  x?: number; y?: number;            // Absolute positioning (bypasses grid)
  color?: ColorPreset;               // Semantic color preset
  width?: number; height?: number;
  strokeColor?: string;              // Hex color override
  backgroundColor?: string;          // Hex color override
  fillStyle?: "solid" | "hachure" | "cross-hatch" | "zigzag";
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  roughness?: number;                // 0=architect, 1=artist, 2=cartoonist
  opacity?: number;                  // 0-100
  fontSize?: number;
  fontFamily?: 1 | 2 | 3;           // 1=Virgil, 2=Helvetica, 3=Cascadia
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle";
  roundness?: { type: number } | null;
  link?: string;                     // Hyperlink URL
  icon?: string;                     // Preset name or emoji, shown above label
  customData?: Record<string, unknown>;
}
```

### Connect Options

```typescript
interface ConnectOpts {
  style?: "solid" | "dashed" | "dotted";
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;                  // 0-100
  startArrowhead?: null | "arrow" | "bar" | "dot" | "triangle" | "diamond" | "diamond_outline";
  endArrowhead?: null | "arrow" | "bar" | "dot" | "triangle" | "diamond" | "diamond_outline";   // default "arrow"
  elbowed?: boolean;                 // default true (orthogonal routing)
  labelFontSize?: number;
  labelPosition?: "start" | "middle" | "end";
  customData?: Record<string, unknown>;
}
```

### Group Options

```typescript
interface GroupOpts {
  padding?: number;          // Pixels around children (default 30)
  strokeColor?: string;      // Hex color for boundary
  strokeStyle?: StrokeStyle; // Default "dashed"
  opacity?: number;          // 0-100 (default 60)
}
```

## Output Formats

| Format | Description | Requires |
|--------|-------------|----------|
| `excalidraw` | `.excalidraw` JSON file | File system access |
| `url` | Shareable excalidraw.com link (no auth needed) | Network access |
| `png` | PNG image at 2x resolution | puppeteer (optional dep) |
| `svg` | SVG markup | puppeteer (optional dep) |

Pass an array for multiple formats in one call: `format: ["excalidraw", "png"]`.

PNG and SVG export uses headless Chrome via puppeteer to render through the official Excalidraw library. puppeteer is an optional dependency -- export gracefully fails if not installed.

## Themes

| Theme | Style |
|-------|-------|
| `default` | Standard Excalidraw look |
| `sketch` | Hand-drawn feel (hachure fill, high roughness, Virgil font) |
| `blueprint` | Clean technical style (solid fill, no roughness, Cascadia font) |
| `minimal` | Light and clean (solid fill, no roughness, Helvetica font) |

## Color Presets

### General Purpose

| Preset | Use for |
|--------|---------|
| `frontend` | UI, browser, React |
| `backend` | APIs, services, servers |
| `database` | Postgres, MySQL, DynamoDB |
| `storage` | S3, R2, blob storage |
| `ai` | ML models, embeddings |
| `external` | Third-party APIs |
| `orchestration` | K8s, Docker, schedulers |
| `queue` | Kafka, SQS, RabbitMQ |
| `cache` | Redis, Memcached |
| `users` | End users, actors |

### Cloud Providers

**AWS**: `aws-compute`, `aws-storage`, `aws-database`, `aws-network`, `aws-security`, `aws-ml`

**Azure**: `azure-compute`, `azure-data`, `azure-network`, `azure-ai`

**GCP**: `gcp-compute`, `gcp-data`, `gcp-network`, `gcp-ai`

**Kubernetes**: `k8s-pod`, `k8s-service`, `k8s-ingress`, `k8s-volume`

## Examples

### Architecture Diagram

```typescript
const d = new Diagram({ direction: "TB" });

const client = d.addBox("Browser", { color: "frontend" });
const api = d.addBox("API Gateway", { color: "backend" });
const auth = d.addBox("Auth Service", { color: "backend" });
const db = d.addBox("Postgres", { color: "database" });
const cache = d.addBox("Redis", { color: "cache" });

d.connect(client, api, "HTTPS");
d.connect(api, auth, "validate token");
d.connect(api, db, "queries");
d.connect(api, cache, "session lookup", { style: "dashed" });

d.addGroup("Backend", [api, auth, db, cache]);

return d.render({ format: ["excalidraw", "url"], path: "architecture" });
```

### Edit an Existing Diagram

**Best workflow**: Use the `draw_describe` tool first to get compact TypeScript, then modify and re-render:

```
1. Call draw_describe("architecture.excalidraw") → get TypeScript code
2. Modify the code (add/remove nodes, change colors, etc.)
3. Pass modified code to the draw tool
```

You can also use `fromFile()` for programmatic edits:

```typescript
const d = await Diagram.fromFile("architecture.excalidraw");

// Add a new service
const queue = d.addBox("SQS Queue", { color: "queue" });
const worker = d.addBox("Worker", { color: "backend" });

// Wire it up
const api = d.findByLabel("API Gateway")[0];
d.connect(api, queue, "enqueue jobs");
d.connect(queue, worker, "process");

// Update an existing node
const db = d.findByLabel("Postgres")[0];
d.updateNode(db, { label: "Aurora Postgres", color: "aws-database" });

return d.render({ path: "architecture.excalidraw" });
```

### Groups and Frames

```typescript
const d = new Diagram({ theme: "blueprint" });

const fe1 = d.addBox("React App", { color: "frontend" });
const fe2 = d.addBox("Admin Panel", { color: "frontend" });

const svc1 = d.addBox("User Service", { color: "backend" });
const svc2 = d.addBox("Order Service", { color: "backend" });
const svc3 = d.addBox("Payment Service", { color: "backend" });

const db1 = d.addBox("Users DB", { color: "database" });
const db2 = d.addBox("Orders DB", { color: "database" });

d.addGroup("Frontend", [fe1, fe2], { strokeColor: "#1971c2" });
d.addGroup("Microservices", [svc1, svc2, svc3], { strokeColor: "#7048e8" });
d.addGroup("Data Layer", [db1, db2], { strokeColor: "#2f9e44" });

d.connect(fe1, svc1, "REST");
d.connect(fe1, svc2, "REST");
d.connect(fe2, svc1, "REST");
d.connect(svc2, svc3, "gRPC");
d.connect(svc1, db1);
d.connect(svc2, db2);

return d.render({ format: "url" });
```

### Sequence Diagram

```typescript
const d = new Diagram({ type: "sequence" });

const user = d.addActor("User", { color: "users" });
const app = d.addActor("App", { color: "frontend" });
const api = d.addActor("API", { color: "backend" });
const db = d.addActor("Database", { color: "database" });

d.message(user, app, "Click Login");
d.message(app, api, "POST /auth");
d.message(api, db, "SELECT user");
d.message(db, api, "user row", { style: "dashed" });
d.message(api, app, "JWT token", { style: "dashed" });
d.message(app, user, "Dashboard", { style: "dashed" });

return d.render({ format: "url" });
```

## Development

### Prerequisites

- Node.js >= 18
- pnpm
- Zig (for WASM module builds)

### Commands

```bash
pnpm install              # Install dependencies
pnpm build                # Build TS + WASM (Zig failure is non-fatal)
pnpm build:wasm           # Build WASM module + wasm-opt
pnpm dev                  # Dev server (HTTP mode on port 3001)
pnpm test                 # Run vitest tests
pnpm typecheck            # TypeScript type checking

cd wasm && zig build       # Build WASM module only
cd wasm && zig build test  # Run Zig tests
```

### Project Structure

```
drawmode/
├── src/
│   ├── index.ts          # MCP server entry (stdio + HTTP)
│   ├── sdk.ts            # Diagram SDK (addBox, connect, render, etc.)
│   ├── executor.ts       # Code executor (new Function + Diagram subclass)
│   ├── layout.ts         # Layout bridge (loads Zig WASM with Graphviz)
│   ├── upload.ts         # Excalidraw.com upload (encrypt + POST)
│   ├── png.ts            # PNG/SVG export (puppeteer + Excalidraw CDN)
│   ├── types.ts          # Shared types
│   ├── sdk-types.ts      # SDK type definitions string (embedded in tool description)
│   └── widget.html       # HTML widget for Claude Desktop / Cowork
├── wasm/
│   └── src/
│       ├── main.zig      # WASM exports (layoutGraph, validate)
│       ├── layout.zig    # Graphviz layout (C lib statically linked)
│       ├── validate.zig  # Structural validation
│       └── util.zig      # Shared utilities
└── worker/
    ├── index.ts          # Cloudflare Worker entry
    └── wrangler.toml
```

### Layout Engine

Graphviz (C library statically linked in the Zig WASM module):

- **Sugiyama algorithm** -- layered graph layout with crossing minimization
- **Orthogonal edge routing** (`splines=ortho`) -- 90-degree elbows matching Excalidraw style, falls back to polyline if ortho fails
- **Cluster subgraphs** -- groups rendered as Graphviz clusters for proper containment
- **Rank constraints** -- nodes with same `row` value are placed on the same rank

## Why Code Mode?

drawmode exists to prove a thesis: **code is the optimal serialization format for LLM context windows.**

### The problem with JSON-first MCP tools

The official Excalidraw MCP sends raw JSON to the LLM. A 50-node diagram is ~100KB / ~25,000 tokens of Excalidraw JSON. This blows up context windows, leaves less room for reasoning, and the LLM still produces broken output because Excalidraw JSON has dozens of non-obvious invariants (bound text elements need TWO elements, arrow endpoints must be on shape edges, elbow arrows need specific flag combinations, etc.).

### Code as compression

drawmode's approach: the LLM writes ~2KB of TypeScript SDK calls instead. Same 50-node diagram, ~500 tokens. That's a **50x compression ratio** -- and the code version is *more* useful because it's editable, diffable, and semantically meaningful.

```
JSON:   {"type":"rectangle","x":100,"y":200,"width":180,"height":80,
         "backgroundColor":"#d0bfff","strokeColor":"#7048e8",
         "boundElements":[{"type":"text","id":"text_1"}],...}  // 50+ lines per node

Code:   const api = d.addBox("API Gateway", { color: "backend" });  // 1 line
```

This works because code has three properties that JSON lacks:

1. **Semantic density** -- variable names carry meaning. `d.connect(api, db)` is self-documenting
2. **Compositionality** -- loops, functions, and variables eliminate repetition
3. **LLM-native** -- models have seen billions of lines of code during training. Code is a compression language they already understand

### The `toCode()` decompiler

The `draw_describe` tool and `toCode()` method close the loop: they convert existing Excalidraw JSON *back* to compact TypeScript. This means agents never need to read raw JSON -- they work entirely in code, even when editing existing diagrams.

### The broader idea

This pattern generalizes beyond diagrams. For any domain where LLMs currently consume raw data (JSON configs, database schemas, API responses, infrastructure state), you can build an SDK + decompiler that converts data into code. The SDK is the compression layer. The decompiler (`toCode()`) makes it bidirectional.

drawmode is a proof of concept for **code-first context management** -- the idea that well-designed SDKs can replace RAG, chunking, and summarization for fitting structured data into LLM context windows.

## License

MIT
