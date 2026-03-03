/** Color presets for diagram components */
export type ColorPreset =
  | "frontend" | "backend" | "database" | "storage"
  | "ai" | "external" | "orchestration" | "queue"
  | "cache" | "users";

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
};

/** Options for adding a box/ellipse to the diagram */
export interface ShapeOpts {
  row?: number;
  col?: number;
  color?: ColorPreset;
  width?: number;
  height?: number;
}

/** Options for connecting two elements */
export interface ConnectOpts {
  style?: "solid" | "dashed";
}

/** Output format options */
export type OutputFormat = "excalidraw" | "url" | "png" | "svg";

/** Result from rendering a diagram */
export interface RenderResult {
  json: object;
  url?: string;
  filePath?: string;
  png?: Uint8Array;
  svg?: string;
}

/** Render options */
export interface RenderOpts {
  format?: OutputFormat;
  path?: string;
}

/** Internal node representation before layout */
export interface GraphNode {
  id: string;
  label: string;
  type: "rectangle" | "ellipse";
  row?: number;
  col?: number;
  width: number;
  height: number;
  color: ColorPair;
}

/** Internal edge representation before layout */
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  style: "solid" | "dashed";
}
