/**
 * Shared SDK type declarations string — used in tool descriptions for both
 * the local MCP server (src/index.ts) and the Cloudflare Worker (worker/index.ts).
 */
export const SDK_TYPES = `
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
  icon?: string;  // Preset: "database","cloud","lock","server","docker","lambda","api","queue","cache","user","k8s" or raw emoji
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
  /** Create a diagram. Optional theme sets defaults for all shapes. */
  constructor(opts?: { theme?: "default" | "sketch" | "blueprint" | "minimal" });

  /** Set a theme preset. "sketch"=hachure/rough, "blueprint"=clean/monospace, "minimal"=thin/helvetica */
  setTheme(theme: "default" | "sketch" | "blueprint" | "minimal"): void;

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

  /** Import a Mermaid graph definition. Supports graph TD/LR, nodes, edges, subgraphs. */
  static fromMermaid(syntax: string): Diagram;

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
    format?: "excalidraw" | "url" | "png" | "svg";
    path?: string;
  }): Promise<{ json: object; url?: string; filePath?: string; pngBase64?: string }>;
}
`;
