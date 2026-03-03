# drawmode

Code Mode MCP server for generating Excalidraw architecture diagrams. Instead of having LLMs write raw Excalidraw JSON (error-prone), they write TypeScript code against a typed SDK. A Zig WASM module handles auto-layout, arrow routing, and validation.

## Quick Start

```bash
# Claude Code / Cursor
npx drawmode --stdio

# HTTP mode
npx drawmode
```

### Claude Desktop / Cursor config

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

## How It Works

1. LLM receives one tool (`draw`) with TypeScript type definitions (~100 lines)
2. LLM writes code against the `Diagram` SDK
3. Local executor runs it — SDK handles labels, colors, IDs
4. Zig WASM handles layout positioning, arrow routing, validation
5. Output: `.excalidraw` file + excalidraw.com URL + optional PNG/SVG

```typescript
const d = new Diagram();
const api = d.addBox("API Gateway", { row: 0, col: 1, color: "backend" });
const db = d.addBox("Postgres", { row: 1, col: 0, color: "database" });
const cache = d.addBox("Redis", { row: 1, col: 2, color: "cache" });
d.connect(api, db, "queries");
d.connect(api, cache, "reads", { style: "dashed" });
d.addGroup("Data Layer", [db, cache]);
return d.render({ format: "url" });
```

## SDK API

### Creating Elements

```typescript
// Rectangles and ellipses
d.addBox(label, opts?)    // → element ID
d.addEllipse(label, opts?)

// Standalone text and lines
d.addText(text, opts?)
d.addLine(points, opts?)

// Groups
d.addGroup(label, children[])

// Connections
d.connect(from, to, label?, opts?)
```

### Shape Options

All optional — sensible defaults are applied:

```typescript
interface ShapeOpts {
  row?: number; col?: number;           // grid positioning
  x?: number; y?: number;               // absolute positioning (bypasses grid)
  color?: ColorPreset;                  // semantic color preset
  width?: number; height?: number;
  strokeColor?: string;                 // hex override
  backgroundColor?: string;            // hex override
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  strokeWidth?: number;                 // default 2
  strokeStyle?: "solid" | "dashed" | "dotted";
  roughness?: number;                   // 0=architect, 1=artist, 2=cartoonist
  opacity?: number;                     // 0-100
  roundness?: { type: number } | null;
  fontSize?: number;                    // default 16
  fontFamily?: 1 | 2 | 3;              // Virgil / Helvetica / Cascadia
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle";
}
```

### Connect Options

```typescript
interface ConnectOpts {
  style?: "solid" | "dashed" | "dotted";
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  startArrowhead?: null | "arrow" | "bar" | "dot" | "triangle";
  endArrowhead?: null | "arrow" | "bar" | "dot" | "triangle";  // default "arrow"
  elbowed?: boolean;          // default true
  labelFontSize?: number;
}
```

### Editing Existing Diagrams

```typescript
const d = await Diagram.fromFile("diagram.excalidraw");
const ids = d.findByLabel("API");       // substring search
d.updateNode(ids[0], { label: "New API", color: "ai" });
d.removeNode(d.findByLabel("Old")[0]);  // removes node + connected edges
return d.render({ path: "diagram.excalidraw" });
```

## Color Presets

### General

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

## Output Formats

| Format | Description | Works in |
|--------|-------------|----------|
| `excalidraw` | `.excalidraw` JSON file | Claude Code, Cursor, VS Code |
| `url` | Shareable excalidraw.com link | All clients |
| `png` | PNG image | Claude Desktop, file |
| `svg` | SVG markup | Claude Desktop, file |

## Architecture

```
drawmode/
├── src/                     # TypeScript (MCP server + SDK)
│   ├── index.ts             # MCP server entry point (stdio + HTTP)
│   ├── sdk.ts               # Diagram SDK (addBox, connect, render, etc.)
│   ├── executor.ts          # Local executor
│   ├── layout.ts            # WASM layout bridge
│   ├── upload.ts            # Excalidraw.com upload
│   ├── export.ts            # PNG/SVG export
│   ├── types.ts             # Shared types
│   └── widget.html          # MCP Apps HTML widget
├── wasm/                    # Zig WASM module
│   └── src/
│       ├── main.zig         # WASM exports
│       ├── layout.zig       # Auto-layout engine
│       ├── arrows.zig       # Arrow routing
│       ├── svg.zig          # SVG generation
│       └── validate.zig     # Structural validation
└── worker/                  # Cloudflare Worker (remote MCP)
    ├── index.ts
    └── wrangler.toml
```

The Zig WASM module handles what LLMs can't do reliably:
- **Auto-layout** — layered graph layout (dagre-style), nodes placed by row with minimal edge crossings
- **Arrow routing** — edge point calculation, elbow routing with 90-degree corners, staggering multiple arrows from same edge
- **Validation** — bound text elements, no duplicate IDs, arrow endpoints on shape edges, no overlapping elements

## Development

```bash
pnpm install              # Install dependencies
pnpm build                # Build TS + WASM
pnpm dev                  # Dev server (HTTP mode)
pnpm test                 # Run tests (45 tests)

cd wasm && zig build       # Build WASM module only
cd wasm && zig build test  # Run Zig tests
```

## Deployment

**Local (stdio)**: `npx drawmode --stdio`

**Local (HTTP)**: `npx drawmode` — Streamable HTTP on port 3001

**Remote (Cloudflare)**: Deploy `worker/` to Cloudflare Workers

## License

MIT
