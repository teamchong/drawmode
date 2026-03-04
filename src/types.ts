import { z } from "zod";

/** Excalidraw fill styles */
export type FillStyle = "solid" | "hachure" | "cross-hatch" | "zigzag";

/** Excalidraw stroke styles */
export type StrokeStyle = "solid" | "dashed" | "dotted";

/** Excalidraw font families: 1=Virgil, 2=Helvetica, 3=Cascadia */
export type FontFamily = 1 | 2 | 3;

/** Excalidraw arrowhead types */
export type Arrowhead = null | "arrow" | "bar" | "dot" | "triangle" | "diamond" | "diamond_outline";

/** Excalidraw text alignment */
export type TextAlign = "left" | "center" | "right";

/** Excalidraw vertical alignment */
export type VerticalAlign = "top" | "middle";

/** Color presets for diagram components */
export type ColorPreset =
  | "frontend" | "backend" | "database" | "storage"
  | "ai" | "external" | "orchestration" | "queue"
  | "cache" | "users"
  // AWS
  | "aws-compute" | "aws-storage" | "aws-database" | "aws-network" | "aws-security" | "aws-ml"
  // Azure
  | "azure-compute" | "azure-data" | "azure-network" | "azure-ai"
  // GCP
  | "gcp-compute" | "gcp-data" | "gcp-network" | "gcp-ai"
  // K8s
  | "k8s-pod" | "k8s-service" | "k8s-ingress" | "k8s-volume";

export interface ColorPair {
  background: string;
  stroke: string;
}

export const COLOR_PALETTE: Record<ColorPreset, ColorPair> = {
  frontend:      { background: "#a5d8ff", stroke: "#1971c2" },
  backend:       { background: "#d0bfff", stroke: "#7048e8" },
  database:      { background: "#b2f2bb", stroke: "#2f9e44" },
  storage:       { background: "#ffec99", stroke: "#f08c00" },
  ai:            { background: "#e599f7", stroke: "#9c36b5" },
  external:      { background: "#ffc9c9", stroke: "#e03131" },
  orchestration: { background: "#ffa8a8", stroke: "#c92a2a" },
  queue:         { background: "#fff3bf", stroke: "#fab005" },
  cache:         { background: "#ffe8cc", stroke: "#fd7e14" },
  users:         { background: "#e7f5ff", stroke: "#1971c2" },
  // AWS
  "aws-compute":  { background: "#FF9900", stroke: "#C27400" },
  "aws-storage":  { background: "#3F8624", stroke: "#2D6119" },
  "aws-database": { background: "#3B48CC", stroke: "#2C3699" },
  "aws-network":  { background: "#8C4FFF", stroke: "#6B3DBF" },
  "aws-security": { background: "#DD344C", stroke: "#A52739" },
  "aws-ml":       { background: "#01A88D", stroke: "#017D69" },
  // Azure
  "azure-compute": { background: "#0078D4", stroke: "#005BA1" },
  "azure-data":    { background: "#50E6FF", stroke: "#3CB8CC" },
  "azure-network": { background: "#773ADC", stroke: "#5A2CA5" },
  "azure-ai":      { background: "#0078D4", stroke: "#005BA1" },
  // GCP
  "gcp-compute": { background: "#4285F4", stroke: "#3267B8" },
  "gcp-data":    { background: "#34A853", stroke: "#27803E" },
  "gcp-network": { background: "#FBBC04", stroke: "#C99603" },
  "gcp-ai":      { background: "#EA4335", stroke: "#B23228" },
  // K8s
  "k8s-pod":     { background: "#326CE5", stroke: "#264FAB" },
  "k8s-service": { background: "#5B9BD5", stroke: "#4577A0" },
  "k8s-ingress": { background: "#00BCD4", stroke: "#0097A7" },
  "k8s-volume":  { background: "#FFC107", stroke: "#C99605" },
};

/** Options for adding a box/ellipse to the diagram */
export interface ShapeOpts {
  row?: number;
  col?: number;
  color?: ColorPreset;
  width?: number;
  height?: number;
  /** Absolute x position (bypasses grid layout) */
  x?: number;
  /** Absolute y position (bypasses grid layout) */
  y?: number;
  /** Hex stroke color override (takes precedence over ColorPreset) */
  strokeColor?: string;
  /** Hex background color override (takes precedence over ColorPreset) */
  backgroundColor?: string;
  fillStyle?: FillStyle;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  /** 0=architect, 1=artist, 2=cartoonist */
  roughness?: number;
  /** 0-100 */
  opacity?: number;
  roundness?: { type: number } | null;
  fontSize?: number;
  fontFamily?: FontFamily;
  textAlign?: TextAlign;
  verticalAlign?: VerticalAlign;
  /** Hyperlink URL attached to the element */
  link?: string | null;
  /** Arbitrary custom metadata stored on the element */
  customData?: Record<string, unknown> | null;
}

/** Options for connecting two elements */
export interface ConnectOpts {
  style?: StrokeStyle;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  /** 0-100 */
  opacity?: number;
  startArrowhead?: Arrowhead;
  endArrowhead?: Arrowhead;
  /** Whether to use elbow routing (default true) */
  elbowed?: boolean;
  labelFontSize?: number;
  /** Arbitrary custom metadata stored on the arrow element */
  customData?: Record<string, unknown> | null;
}

// ── Zod Schemas for Excalidraw elements ──

const BindingSchema = z.object({
  elementId: z.string(),
  focus: z.number(),
  gap: z.number(),
}).passthrough();

export const ExcalidrawElementSchema = z.object({
  id: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  angle: z.number().optional(),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  roundness: z.object({ type: z.number() }).nullable().optional(),
  seed: z.number().optional(),
  version: z.number().optional(),
  versionNonce: z.number().optional(),
  isDeleted: z.boolean().optional(),
  groupIds: z.array(z.string()).optional(),
  frameId: z.string().nullable().optional(),
  boundElements: z.array(z.object({ type: z.string(), id: z.string() })).nullable().optional(),
  updated: z.number().optional(),
  locked: z.boolean().optional(),
  link: z.string().nullable().optional(),
  customData: z.record(z.unknown()).nullable().optional(),
  // Text fields
  text: z.string().optional(),
  fontSize: z.number().optional(),
  fontFamily: z.number().optional(),
  lineHeight: z.number().optional(),
  textAlign: z.string().optional(),
  verticalAlign: z.string().optional(),
  containerId: z.string().nullable().optional(),
  originalText: z.string().optional(),
  autoResize: z.boolean().optional(),
  // Arrow/Line fields
  points: z.array(z.array(z.number())).optional(),
  startBinding: BindingSchema.nullable().optional(),
  endBinding: BindingSchema.nullable().optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Frame fields
  name: z.string().optional(),
}).passthrough();

export type ExcalidrawElement = z.infer<typeof ExcalidrawElementSchema>;

export const ExcalidrawFileSchema = z.object({
  type: z.literal("excalidraw"),
  version: z.number(),
  source: z.string().optional(),
  elements: z.array(ExcalidrawElementSchema),
  appState: z.record(z.unknown()).optional(),
  files: z.record(z.unknown()).optional(),
}).passthrough();

export type ExcalidrawFile = z.infer<typeof ExcalidrawFileSchema>;

/** Output format options */
export type OutputFormat = "excalidraw" | "url" | "png" | "svg";

/** Result from rendering a diagram */
export interface RenderResult {
  json: ExcalidrawFile;
  url?: string;
  filePath?: string;
  png?: Uint8Array;
  svg?: string;
}

/** Render options */
export interface RenderOpts {
  format?: OutputFormat;
  path?: string;
  /** Source code for sidecar file */
  sourceCode?: string;
}

/** Internal node representation before layout */
export interface GraphNode {
  id: string;
  label: string;
  type: "rectangle" | "ellipse" | "diamond" | "text" | "line";
  row?: number;
  col?: number;
  width: number;
  height: number;
  color: ColorPair;
  /** Stored ShapeOpts for property pass-through */
  opts?: ShapeOpts;
  /** Absolute position override */
  absX?: number;
  absY?: number;
  /** For line elements: array of [x,y] point pairs */
  linePoints?: [number, number][];
}

/** Internal edge representation before layout */
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  style: StrokeStyle;
  /** Full connect opts for property pass-through */
  opts?: ConnectOpts;
}
