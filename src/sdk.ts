/**
 * Diagram SDK — high-level API for building Excalidraw diagrams.
 * Hides all Excalidraw JSON complexity (bound text, arrow routing, edge math).
 */

import type {
  ColorPreset, ShapeOpts, ConnectOpts, RenderOpts, RenderResult,
  GraphNode, GraphEdge, FillStyle, StrokeStyle, FontFamily,
  Arrowhead, TextAlign, VerticalAlign, ColorPair,
  ExcalidrawElement, ExcalidrawFile,
} from "./types.js";
import { COLOR_PALETTE, ExcalidrawFileSchema } from "./types.js";
import {
  validateElements, isWasmLoaded,
  layoutGraphWasm,
  type EdgeRoute,
  type GroupBounds,
} from "./layout.js";

const DEFAULT_WIDTH = 180;
const DEFAULT_HEIGHT = 80;
const LINE_HEIGHT = 24; // extra height per additional line of text
const COL_SPACING = 280;
const ROW_SPACING = 220;
const BASE_X = 100;
const BASE_Y = 100;

/** Excalidraw lineHeight per font family: 1=Virgil→1.25, 2=Helvetica→1.15, 3=Cascadia→1.2 */
function getLineHeight(fontFamily: FontFamily): number {
  if (fontFamily === 2) return 1.15;
  if (fontFamily === 3) return 1.2;
  return 1.25; // Virgil (1) and default
}

const SESSION_SEED = Date.now().toString(36);

function randSeed(): number {
  return Math.floor(Math.random() * 2000000000);
}

function computeNodeBounds(nodes: { x?: number; y?: number; width: number; height: number }[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const nx = n.x ?? 0, ny = n.y ?? 0;
    if (nx < minX) minX = nx;
    if (ny < minY) minY = ny;
    if (nx + n.width > maxX) maxX = nx + n.width;
    if (ny + n.height > maxY) maxY = ny + n.height;
  }
  return { minX, minY, maxX, maxY };
}

function computeBounds(points: number[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

export class Diagram {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private groups = new Map<string, { label: string; children: string[] }>();
  private frames = new Map<string, { name: string; children: string[] }>();
  /** Passthrough elements from fromFile() — re-emitted unchanged */
  private passthrough: ExcalidrawElement[] = [];
  private idCounter = 0;

  private nextId(prefix: string): string {
    return `${prefix}_${++this.idCounter}_${SESSION_SEED}`;
  }

  /** Add a rectangle to the diagram. Returns the element ID. */
  addBox(label: string, opts?: ShapeOpts): string {
    return this.addShape("box", "rectangle", label, opts);
  }

  /** Add an ellipse to the diagram. Returns the element ID. */
  addEllipse(label: string, opts?: ShapeOpts): string {
    return this.addShape("ell", "ellipse", label, opts, "users");
  }

  /** Add a diamond to the diagram (for flowchart decisions). Returns the element ID. */
  addDiamond(label: string, opts?: ShapeOpts): string {
    return this.addShape("dia", "diamond", label, opts);
  }

  private addShape(prefix: string, type: GraphNode["type"], label: string, opts?: ShapeOpts, defaultPreset: ColorPreset = "backend"): string {
    const id = this.nextId(prefix);
    const lines = label.split("\n");
    const extraLines = lines.length - 1;
    // Auto-size width from longest line (~9px per char + 40px padding)
    const longestLine = Math.max(...lines.map(l => l.length));
    const autoWidth = Math.max(DEFAULT_WIDTH, longestLine * 9 + 40);
    this.nodes.set(id, {
      id, label, type,
      row: opts?.row, col: opts?.col,
      width: opts?.width ?? autoWidth,
      height: opts?.height ?? (DEFAULT_HEIGHT + extraLines * LINE_HEIGHT),
      color: resolveColor(opts, defaultPreset),
      opts,
      absX: opts?.x,
      absY: opts?.y,
    });
    return id;
  }

  /** Add standalone text (no container shape). Returns the element ID. */
  addText(text: string, opts?: {
    x?: number; y?: number;
    fontSize?: number; fontFamily?: FontFamily;
    color?: ColorPreset; strokeColor?: string;
  }): string {
    const id = this.nextId("txt");
    const preset = opts?.color ?? "backend";
    const paletteColor = COLOR_PALETTE[preset];
    const strokeColor = opts?.strokeColor ?? paletteColor.stroke;
    const fontSize = opts?.fontSize ?? 16;
    const textLines = text.split("\n");
    const maxLineLen = textLines.reduce((max, l) => Math.max(max, l.length), 0);
    this.nodes.set(id, {
      id, label: text, type: "text",
      width: maxLineLen * fontSize * 0.6 + 16,
      height: textLines.length * (fontSize * 1.5) + 8,
      color: { background: "transparent", stroke: strokeColor },
      opts: { x: opts?.x, y: opts?.y, fontSize: opts?.fontSize, fontFamily: opts?.fontFamily },
      absX: opts?.x,
      absY: opts?.y,
    });
    return id;
  }

  /** Add a line element (for dividers/boundaries). Returns the element ID. */
  addLine(points: [number, number][], opts?: {
    strokeColor?: string; strokeWidth?: number; strokeStyle?: StrokeStyle;
  }): string {
    if (points.length < 2) throw new Error("addLine requires at least two points");
    const id = this.nextId("line");
    const { minX, minY, maxX, maxY } = computeBounds(points);
    this.nodes.set(id, {
      id, label: "", type: "line",
      width: maxX - minX || 1,
      height: maxY - minY || 1,
      color: { background: "transparent", stroke: opts?.strokeColor ?? "#868e96" },
      opts: { strokeWidth: opts?.strokeWidth, strokeStyle: opts?.strokeStyle },
      absX: minX,
      absY: minY,
      linePoints: points.map(p => [p[0] - minX, p[1] - minY] as [number, number]),
    });
    return id;
  }

  /** Group elements together with a dashed boundary and label. */
  addGroup(label: string, children: string[]): string {
    const id = this.nextId("grp");
    this.groups.set(id, { label, children });
    return id;
  }

  /** Add a native Excalidraw frame container. Returns the frame ID. */
  addFrame(name: string, children: string[]): string {
    const id = this.nextId("frm");
    this.frames.set(id, { name, children });
    return id;
  }

  /** Remove a group container. Children are kept. */
  removeGroup(id: string): void {
    this.groups.delete(id);
  }

  /** Remove a frame container. Children are kept. */
  removeFrame(id: string): void {
    this.frames.delete(id);
  }

  /** Connect two elements with an arrow. */
  connect(from: string, to: string, label?: string, opts?: ConnectOpts): void {
    this.edges.push({
      from, to, label,
      style: opts?.style ?? "solid",
      opts,
    });
  }

  // ── Editing / Query Methods ──

  /** Load an existing .excalidraw file for editing. */
  static async fromFile(this: new () => Diagram, path: string): Promise<Diagram> {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path, "utf-8");
    const parsed = ExcalidrawFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`Invalid .excalidraw file: ${parsed.error.message}`);
    const elements = parsed.data.elements;

    const d = new this();

    // Index text elements by containerId for label lookup
    const textByContainer = new Map<string, ExcalidrawElement>();
    for (const el of elements) {
      if (el.type === "text" && el.containerId) {
        textByContainer.set(el.containerId, el);
      }
    }

    // Index label text elements by their parent ID (e.g. "grp_1-label" → keyed by "grp_1")
    const labelTextById = new Map<string, ExcalidrawElement>();
    for (const el of elements) {
      if (el.type === "text" && el.id.endsWith("-label")) {
        labelTextById.set(el.id.replace(/-label$/, ""), el);
      }
    }

    // Index all elements by ID for cross-referencing (e.g. arrow _labelId → text element)
    const elemById = new Map<string, ExcalidrawElement>();
    for (const el of elements) elemById.set(el.id, el);

    // Collect arrow label text IDs so they can be skipped when processing standalone text
    const arrowLabelIds = new Set<string>();
    for (const el of elements) {
      if (el.type === "arrow") {
        const labelId = (el.customData as Record<string, unknown> | undefined)?._labelId as string | undefined;
        if (labelId) arrowLabelIds.add(labelId);
      }
    }

    // Pre-detect group IDs so label text nodes can be skipped regardless of element order
    const groupIds = new Set<string>();
    for (const el of elements) {
      if ((el.type === "rectangle" || el.type === "ellipse") &&
          el.strokeStyle === "dashed" && el.backgroundColor === "transparent" &&
          (el.opacity ?? 100) <= 70) {
        if (labelTextById.has(el.id)) groupIds.add(el.id);
      }
    }

    // Reconstruct nodes from shapes
    for (const el of elements) {
      if (el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond") {
        // Detect group boundaries: must have companion "-label" text, dashed stroke,
        // transparent background, and low opacity. The "-label" check distinguishes
        // drawmode groups from user shapes that happen to be dashed + low opacity.
        const labelEl = labelTextById.get(el.id);
        if (el.type !== "diamond" && labelEl && el.strokeStyle === "dashed" &&
            el.backgroundColor === "transparent" && (el.opacity ?? 100) <= 70) {
          d.groups.set(el.id, {
            label: labelEl?.text ?? "",
            children: [], // Reconstructed below after all nodes are loaded
            _bounds: { x: el.x, y: el.y, w: el.width, h: el.height },
          } as { label: string; children: string[]; _bounds?: { x: number; y: number; w: number; h: number } });
          continue;
        }

        const boundText = textByContainer.get(el.id);
        const label = boundText?.text ?? "";

        const node: GraphNode = {
          id: el.id,
          label,
          type: el.type as GraphNode["type"],
          width: el.width,
          height: el.height,
          color: {
            background: el.backgroundColor ?? "",
            stroke: el.strokeColor ?? "",
          },
          opts: {
            fillStyle: el.fillStyle as FillStyle | undefined,
            strokeWidth: el.strokeWidth,
            strokeStyle: el.strokeStyle as StrokeStyle | undefined,
            roughness: el.roughness,
            opacity: el.opacity,
            roundness: el.roundness,
            strokeColor: el.strokeColor,
            backgroundColor: el.backgroundColor,
            fontSize: boundText?.fontSize,
            fontFamily: boundText?.fontFamily as FontFamily | undefined,
            textAlign: boundText?.textAlign as TextAlign | undefined,
            verticalAlign: boundText?.verticalAlign as VerticalAlign | undefined,
            link: el.link,
            ...(el.customData !== undefined ? { customData: el.customData as Record<string, unknown> } : {}),
          },
          absX: el.x,
          absY: el.y,
        };
        d.nodes.set(el.id, node);
      } else if (el.type === "arrow") {
        // Recover edge endpoints from customData (preferred) or legacy bindings
        const startId = (el.customData as Record<string, unknown> | undefined)?._from as string | undefined
          ?? el.startBinding?.elementId;
        const endId = (el.customData as Record<string, unknown> | undefined)?._to as string | undefined
          ?? el.endBinding?.elementId;
        if (startId && endId) {
          const labelId = (el.customData as Record<string, unknown> | undefined)?._labelId as string | undefined;
          const arrowLabel = labelId ? elemById.get(labelId) : textByContainer.get(el.id);
          d.edges.push({
            from: startId,
            to: endId,
            label: arrowLabel?.text,
            style: (el.strokeStyle as StrokeStyle) ?? "solid",
            opts: {
              strokeColor: el.strokeColor,
              strokeWidth: el.strokeWidth,
              roughness: el.roughness,
              opacity: el.opacity,
              startArrowhead: el.startArrowhead as Arrowhead | undefined,
              endArrowhead: el.endArrowhead as Arrowhead | undefined,
              elbowed: el.elbowed,
              labelFontSize: arrowLabel?.fontSize,
            },
          });
        } else {
          // Arrow without both bindings — passthrough
          d.passthrough.push(el);
        }
      } else if (el.type === "text" && !el.containerId) {
        // Skip group label text elements (detected in pre-scan above)
        if (el.id.endsWith("-label") && groupIds.has(el.id.replace(/-label$/, ""))) continue;
        // Skip arrow label text elements (identified via arrow customData._labelId)
        if (arrowLabelIds.has(el.id)) continue;

        // Standalone text — add as text node
        d.nodes.set(el.id, {
          id: el.id,
          label: el.text ?? "",
          type: "text",
          width: el.width,
          height: el.height,
          color: { background: "transparent", stroke: el.strokeColor ?? "" },
          opts: { fontSize: el.fontSize, fontFamily: el.fontFamily as FontFamily | undefined },
          absX: el.x,
          absY: el.y,
        });
      } else if (el.type === "frame") {
        // Native Excalidraw frame — reconstruct into frames map
        d.frames.set(el.id, {
          name: el.name ?? "",
          children: [], // Populated below using frameId references
        });
      } else if (el.type === "text" && el.containerId) {
        // Bound text — already handled via textByContainer, skip
      } else {
        // Unknown element type — passthrough
        d.passthrough.push(el);
      }
    }

    // Reconstruct group children: nodes whose position falls within group bounds
    for (const [groupId, group] of d.groups) {
      const gb = (group as { _bounds?: { x: number; y: number; w: number; h: number } })._bounds;
      if (!gb) continue;
      for (const node of d.nodes.values()) {
        const nx = node.absX ?? 0;
        const ny = node.absY ?? 0;
        if (nx >= gb.x && ny >= gb.y && nx + node.width <= gb.x + gb.w && ny + node.height <= gb.y + gb.h) {
          group.children.push(node.id);
        }
      }
      delete (group as Record<string, unknown>)._bounds;
    }

    // Reconstruct frame children: nodes whose element had frameId set
    for (const el of elements) {
      if (el.frameId && d.frames.has(el.frameId)) {
        // Only add shape nodes (not bound text elements) as frame children
        if (d.nodes.has(el.id)) {
          d.frames.get(el.frameId)!.children.push(el.id);
        }
      }
    }

    return d;
  }

  /** Find node IDs by label match. Substring by default, exact with opts. */
  findByLabel(label: string, opts?: { exact?: boolean }): string[] {
    const lower = label.toLowerCase();
    const results: string[] = [];
    for (const node of this.nodes.values()) {
      const match = opts?.exact
        ? node.label.toLowerCase() === lower
        : node.label.toLowerCase().includes(lower);
      if (match) results.push(node.id);
    }
    return results;
  }

  /** Get all node IDs. */
  getNodes(): string[] {
    return Array.from(this.nodes.keys());
  }

  /** Get all edges. */
  getEdges(): Array<{ from: string; to: string; label?: string }> {
    return this.edges.map(e => ({ from: e.from, to: e.to, label: e.label }));
  }

  /** Update a node's properties. */
  updateNode(id: string, update: Partial<ShapeOpts> & { label?: string }): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Node not found: ${id}`);

    if (update.label !== undefined) node.label = update.label;
    if (update.width !== undefined) node.width = update.width;
    if (update.height !== undefined) node.height = update.height;
    if (update.x !== undefined) node.absX = update.x;
    if (update.y !== undefined) node.absY = update.y;

    // Update color
    if (update.color) {
      node.color = COLOR_PALETTE[update.color];
    }
    if (update.strokeColor) {
      node.color = { ...node.color, stroke: update.strokeColor };
    }
    if (update.backgroundColor) {
      node.color = { ...node.color, background: update.backgroundColor };
    }

    // Merge remaining opts (exclude non-ShapeOpts fields)
    const { label: _, ...shapeUpdates } = update;
    node.opts = { ...node.opts, ...shapeUpdates };
  }

  /** Remove a node and all its connected edges. */
  removeNode(id: string): void {
    this.nodes.delete(id);
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    // Also remove from groups and frames
    for (const group of this.groups.values()) {
      group.children = group.children.filter(c => c !== id);
    }
    for (const frame of this.frames.values()) {
      frame.children = frame.children.filter(c => c !== id);
    }
  }

  /** Remove an edge between two nodes. Optional label disambiguates multi-edges. */
  removeEdge(from: string, to: string, label?: string): void {
    let removed = false;
    this.edges = this.edges.filter(e => {
      if (e.from !== from || e.to !== to) return true;
      if (label !== undefined && e.label !== label) return true;
      if (removed) return true; // only remove first match
      removed = true;
      return false;
    });
  }

  /** Update an existing edge's properties. Optional matchLabel disambiguates multi-edges. */
  updateEdge(from: string, to: string, update: Partial<ConnectOpts> & { label?: string }, matchLabel?: string): void {
    const edge = this.edges.find(e =>
      e.from === from && e.to === to &&
      (matchLabel === undefined || e.label === matchLabel),
    );
    if (!edge) throw new Error(`Edge not found: ${from} -> ${to}`);
    if (update.label !== undefined) edge.label = update.label;
    if (update.style !== undefined) edge.style = update.style;
    edge.opts = { ...edge.opts, ...update };
  }

  /** Render the diagram to the specified format. */
  async render(opts?: RenderOpts): Promise<RenderResult> {
    const elements = await this.buildElements();

    // WASM validation: log warnings to stderr if available
    if (isWasmLoaded()) {
      const errorsJson = validateElements(JSON.stringify(elements));
      if (errorsJson) {
        try {
          const errors = JSON.parse(errorsJson);
          if (Array.isArray(errors) && errors.length > 0) {
            for (const err of errors) {
              if (typeof process !== "undefined") {
                process.stderr.write(`[drawmode] validation warning: ${err.msg} (${err.id})\n`);
              }
            }
          }
        } catch (e) {
          if (typeof process !== "undefined") process.stderr.write(`[drawmode] validation parse error: ${e}\n`);
        }
      }
    }

    const excalidrawJson: ExcalidrawFile = {
      type: "excalidraw" as const,
      version: 2,
      source: "drawmode",
      elements,
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: {},
    };

    const result: RenderResult = { json: excalidrawJson };
    const format = opts?.format ?? "excalidraw";

    if (format === "excalidraw") {
      const { writeFile } = await import("node:fs/promises");
      const path = opts?.path ?? "diagram.excalidraw";
      await writeFile(path, JSON.stringify(excalidrawJson, null, 2));
      result.filePath = path;

      // Write sidecar .drawmode.ts if source code provided
      if (opts?.sourceCode && path.endsWith(".excalidraw")) {
        const sidecarPath = path.replace(/\.excalidraw$/, ".drawmode.ts");
        await writeFile(sidecarPath, opts.sourceCode);
      }
    }

    if (format === "url") {
      const { uploadToExcalidraw } = await import("./upload.js");
      result.url = await uploadToExcalidraw(JSON.stringify(excalidrawJson));
    }

    if (format === "png") {
      const { renderPngLocal } = await import("./png.js");
      const pngPath = (opts?.path ?? "diagram").replace(/\.(excalidraw|png|svg)$/, "") + ".png";
      const pngData = await renderPngLocal(elements, pngPath);
      if (pngData) {
        result.pngBase64 = pngData;
        result.filePath = pngPath;
      } else {
        throw new Error("PNG export requires puppeteer. Install it with: npm install puppeteer");
      }
    }

    if (format === "svg") {
      const { renderSvgLocal } = await import("./png.js");
      const svgPath = (opts?.path ?? "diagram").replace(/\.(excalidraw|png|svg)$/, "") + ".svg";
      const svgData = await renderSvgLocal(elements, svgPath);
      if (svgData) {
        result.svgString = svgData;
        result.filePath = svgPath;
      } else {
        throw new Error("SVG export requires puppeteer. Install it with: npm install puppeteer");
      }
    }

    return result;
  }

  /** Convert the graph to Excalidraw elements with layout. */
  private async buildElements(): Promise<ExcalidrawElement[]> {
    const elements: ExcalidrawElement[] = [];
    const { positioned, edgeRoutes, groupBounds } = await this.layoutNodes();

    // Pre-compute arrow IDs (one per edge, in order)
    const arrowIds: string[] = [];
    for (let i = 0; i < this.edges.length; i++) {
      arrowIds.push(this.nextId("arr"));
    }

    // Create shape + bound text for each node
    for (const node of positioned.values()) {
      const o = node.opts;

      // Standalone text node
      if (node.type === "text") {
        const ff: FontFamily = o?.fontFamily ?? 1;
        elements.push({
          id: node.id,
          type: "text",
          x: node.x!, y: node.y!,
          width: node.width,
          height: node.height,
          text: node.label,
          fontSize: o?.fontSize ?? 16,
          fontFamily: ff,
          lineHeight: getLineHeight(ff),
          textAlign: o?.textAlign ?? "left",
          verticalAlign: o?.verticalAlign ?? "top",
          containerId: null,
          originalText: node.label,
          autoResize: true,
          strokeColor: node.color.stroke,
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          roughness: 0,
          opacity: o?.opacity ?? 100,
          angle: 0,
          groupIds: [],
          frameId: null,
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          locked: false,
          link: null,
          seed: randSeed(),
          version: 1,
          versionNonce: randSeed(),
        });
        continue;
      }

      // Line element
      if (node.type === "line") {
        elements.push({
          id: node.id,
          type: "line",
          x: node.x!, y: node.y!,
          width: node.width,
          height: node.height,
          points: node.linePoints ?? [[0, 0], [node.width, 0]],
          strokeColor: node.color.stroke,
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: o?.strokeWidth ?? 2,
          strokeStyle: o?.strokeStyle ?? "solid",
          roughness: o?.roughness ?? 1,
          opacity: o?.opacity ?? 100,
          angle: 0,
          roundness: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: null,
          groupIds: [],
          frameId: null,
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          locked: false,
          link: null,
          seed: randSeed(),
          version: 1,
          versionNonce: randSeed(),
        });
        continue;
      }

      // Rectangle / Ellipse
      const textId = `${node.id}-text`;

      elements.push({
        id: node.id,
        type: node.type,
        x: node.x!, y: node.y!,
        width: node.width, height: node.height,
        backgroundColor: o?.backgroundColor ?? node.color.background,
        strokeColor: o?.strokeColor ?? node.color.stroke,
        fillStyle: o?.fillStyle ?? "solid",
        strokeWidth: o?.strokeWidth ?? 2,
        roughness: o?.roughness ?? 1,
        opacity: o?.opacity ?? 100,
        angle: 0,
        strokeStyle: o?.strokeStyle ?? "solid",
        roundness: o?.roundness !== undefined ? o.roundness : { type: 3 },
        boundElements: [
          { type: "text", id: textId },
        ],
        groupIds: [],
        frameId: null,
        isDeleted: false,
        updated: Date.now(),
        locked: false,
        link: o?.link ?? null,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
        ...(o?.customData !== undefined ? { customData: o.customData } : {}),
      });

      const textWidth = node.width - 20;
      const textHeight = 20;

      const boundFf: FontFamily = o?.fontFamily ?? 1;
      elements.push({
        id: textId,
        type: "text",
        x: node.x! + (node.width - textWidth) / 2,
        y: node.y! + (node.height - textHeight) / 2,
        width: textWidth,
        height: textHeight,
        text: node.label,
        fontSize: o?.fontSize ?? 16,
        fontFamily: boundFf,
        lineHeight: getLineHeight(boundFf),
        textAlign: o?.textAlign ?? "center",
        verticalAlign: o?.verticalAlign ?? "middle",
        containerId: node.id,
        originalText: node.label,
        autoResize: true,
        strokeColor: o?.strokeColor ?? node.color.stroke,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 0,
        opacity: o?.opacity ?? 100,
        angle: 0,
        groupIds: [],
        frameId: null,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        locked: false,
        link: null,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
      });
    }

    // Create arrows for edges
    const edgePairCounts = new Map<string, number>(); // track multi-edges between same nodes

    for (let ei = 0; ei < this.edges.length; ei++) {
      const edge = this.edges[ei];
      const fromNode = positioned.get(edge.from);
      const toNode = positioned.get(edge.to);
      if (!fromNode || !toNode) continue;

      const co = edge.opts;
      const arrowId = arrowIds[ei];

      // Check for WASM-computed edge route (with index for multi-edges)
      const baseRouteKey = `${edge.from}->${edge.to}`;
      const edgePairIdx = edgePairCounts.get(baseRouteKey) ?? 0;
      edgePairCounts.set(baseRouteKey, edgePairIdx + 1);
      const routeKey = edgePairIdx === 0 ? baseRouteKey : `${baseRouteKey}#${edgePairIdx}`;
      const edgeRoute = edgeRoutes?.get(routeKey);
      const hasEdgeRoute = edgeRoute && edgeRoute.points.length >= 2;

      // Always elbowed=false — arrows are static polylines (no bindings).
      // Excalidraw renders our exact points without recalculating on interaction.
      const isElbowed = false;

      let arrowX: number, arrowY: number;
      let points: number[][];

      if (hasEdgeRoute) {
        // Use Graphviz-computed route (orthogonal spline points)
        arrowX = edgeRoute.points[0][0];
        arrowY = edgeRoute.points[0][1];
        points = edgeRoute.points.map(([px, py]) => [px - arrowX, py - arrowY]);
      } else {
        // Fallback: orthogonal route from source edge to target edge
        const fx = (fromNode.x ?? 0) + fromNode.width / 2;
        const fy = (fromNode.y ?? 0) + fromNode.height;  // bottom edge of source
        const tx = (toNode.x ?? 0) + toNode.width / 2;
        const ty = (toNode.y ?? 0);                       // top edge of target
        arrowX = fx;
        arrowY = fy;
        if (Math.abs(fx - tx) < 1) {
          // Vertically aligned — straight line
          points = [[0, 0], [0, ty - fy]];
        } else {
          // L-shaped orthogonal route: down to midpoint, across, then down
          const midY = Math.round((fy + ty) / 2);
          points = [[0, 0], [0, midY - fy], [tx - fx, midY - fy], [tx - fx, ty - fy]];
        }
      }

      const { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY } = computeBounds(points);
      const boundsWidth = bMaxX - bMinX;
      const boundsHeight = bMaxY - bMinY;

      const labelTextId = edge.label ? this.nextId("arrlbl") : undefined;

      elements.push({
        id: arrowId,
        type: "arrow",
        x: arrowX,
        y: arrowY,
        width: boundsWidth || 1,
        height: boundsHeight || 1,
        points,
        strokeColor: co?.strokeColor ?? toNode.color.stroke,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: co?.strokeWidth ?? 2,
        strokeStyle: edge.style,
        roughness: co?.roughness ?? 0,
        roundness: isElbowed ? null : { type: 2 },
        elbowed: isElbowed,
        opacity: co?.opacity ?? 100,
        angle: 0,
        startBinding: null,
        endBinding: null,
        startArrowhead: co?.startArrowhead ?? null,
        endArrowhead: co?.endArrowhead ?? "arrow",
        groupIds: [],
        frameId: null,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        locked: false,
        link: null,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
        customData: { ...(co?.customData ?? {}), _from: edge.from, _to: edge.to, ...(labelTextId ? { _labelId: labelTextId } : {}) },
      });

      // Arrow label placement
      if (edge.label && labelTextId) {
        const labelWidth = edge.label.length * 8 + 16;
        let labelX: number, labelY: number;

        if (edgeRoute?.labelPos) {
          // Use Zig-computed label position (center-based, with collision avoidance)
          labelX = edgeRoute.labelPos.x - labelWidth / 2;
          labelY = edgeRoute.labelPos.y - 12;
        } else if (points.length >= 2) {
          // Fallback: midpoint of longest segment
          let bestLen = 0, bestSeg = 0;
          for (let s = 0; s < points.length - 1; s++) {
            const segDx = points[s + 1][0] - points[s][0];
            const segDy = points[s + 1][1] - points[s][1];
            const segLen = Math.abs(segDx) + Math.abs(segDy);
            if (segLen > bestLen) { bestLen = segLen; bestSeg = s; }
          }
          const p1 = points[bestSeg], p2 = points[bestSeg + 1];
          labelX = arrowX + (p1[0] + p2[0]) / 2;
          labelY = arrowY + (p1[1] + p2[1]) / 2 - 12;
        } else {
          labelX = arrowX;
          labelY = arrowY - 12;
        }

        const labelFf: FontFamily = 1;
        elements.push({
          id: labelTextId,
          type: "text",
          x: labelX,
          y: labelY,
          width: edge.label.length * 8 + 16,
          height: 20,
          text: edge.label,
          fontSize: co?.labelFontSize ?? 14,
          fontFamily: labelFf,
          lineHeight: getLineHeight(labelFf),
          textAlign: "center",
          verticalAlign: "middle",
          containerId: null,
          originalText: edge.label,
          autoResize: true,
          strokeColor: "#1e1e1e",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          roughness: 0,
          opacity: co?.opacity ?? 100,
          angle: 0,
          groupIds: [],
          frameId: null,
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          locked: false,
          link: null,
          seed: randSeed(),
          version: 1,
          versionNonce: randSeed(),
        });
      }
    }

    // Arrow label collision avoidance: shift overlapping labels vertically
    const labelElements = elements.filter(
      el => el.type === "text" && el.containerId && arrowIds.includes(el.containerId),
    );
    for (let i = 1; i < labelElements.length; i++) {
      const cur = labelElements[i];
      const curW = cur.width;
      const curH = cur.height;
      for (let j = 0; j < i; j++) {
        const prev = labelElements[j];
        // Check overlap
        if (
          cur.x < prev.x + prev.width &&
          cur.x + curW > prev.x &&
          cur.y < prev.y + prev.height &&
          cur.y + curH > prev.y
        ) {
          // Shift current label below the overlapping one
          cur.y = prev.y + prev.height + 4;
        }
      }
    }

    // Groups: dashed rectangle around children + label
    // Use Graphviz cluster bounding boxes when available (guaranteed non-overlapping)
    const groupBoundsMap = new Map<string, GroupBounds>();
    if (groupBounds) {
      for (const gb of groupBounds) groupBoundsMap.set(gb.id, gb);
    }

    for (const [groupId, group] of this.groups) {
      let gx: number, gy: number, gw: number, gh: number;

      const gb = groupBoundsMap.get(groupId);
      if (gb) {
        // Use Graphviz-computed cluster bounding box (non-overlapping)
        gx = gb.x; gy = gb.y; gw = gb.width; gh = gb.height;
      } else {
        // Fallback: compute from child node positions
        const childNodes = group.children
          .map(c => positioned.get(c))
          .filter((n): n is PositionedNode => n !== undefined);
        if (childNodes.length === 0) continue;

        const padding = 30;
        const { minX, minY, maxX, maxY } = computeNodeBounds(childNodes);
        gx = minX - padding;
        gy = minY - padding - 20;
        gw = (maxX + padding) - gx;
        gh = (maxY + padding) - gy;
      }

      elements.push({
        id: groupId,
        type: "rectangle",
        x: gx, y: gy,
        width: gw, height: gh,
        backgroundColor: "transparent",
        strokeColor: "#868e96",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "dashed",
        roughness: 0,
        opacity: 60,
        angle: 0,
        roundness: { type: 3 },
        boundElements: null,
        groupIds: [],
        frameId: null,
        isDeleted: false,
        updated: Date.now(),
        locked: false,
        link: null,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
      });

      elements.push({
        id: `${groupId}-label`,
        type: "text",
        x: gx + 10, y: gy + 5,
        width: group.label.length * 8 + 16, height: 20,
        text: group.label,
        fontSize: 14,
        fontFamily: 1,
        lineHeight: 1.25,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        originalText: group.label,
        autoResize: true,
        strokeColor: "#868e96",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 0,
        opacity: 60,
        angle: 0,
        groupIds: [],
        frameId: null,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        locked: false,
        link: null,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
      });
    }

    // Frames: native Excalidraw frame containers
    for (const [frameId, frame] of this.frames) {
      const childNodes = frame.children
        .map(c => positioned.get(c))
        .filter((n): n is PositionedNode => n !== undefined);
      if (childNodes.length === 0) continue;

      const padding = 30;
      let { minX, minY, maxX, maxY } = computeNodeBounds(childNodes);
      minX -= padding;
      minY -= padding + 20;
      maxX += padding;
      maxY += padding;

      elements.push({
        id: frameId,
        type: "frame",
        x: minX, y: minY,
        width: maxX - minX, height: maxY - minY,
        name: frame.name,
        backgroundColor: "transparent",
        strokeColor: "#bbb",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        angle: 0,
        roundness: null,
        boundElements: null,
        groupIds: [],
        frameId: null,
        isDeleted: false,
        updated: Date.now(),
        locked: false,
        link: null,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
      });

      // Set frameId on child elements
      for (const el of elements) {
        if (frame.children.includes(el.id)) {
          el.frameId = frameId;
        }
        // Also tag bound text elements
        if (el.containerId && frame.children.includes(el.containerId)) {
          el.frameId = frameId;
        }
      }
    }

    // Append passthrough elements
    elements.push(...this.passthrough);

    return elements;
  }

  /** Assign x,y positions to all nodes. Priority: WASM Graphviz → TS grid. */
  private async layoutNodes(): Promise<{ positioned: Map<string, PositionedNode>; edgeRoutes?: Map<string, EdgeRoute>; groupBounds?: GroupBounds[] }> {
    // Try WASM Graphviz layout (async)
    const wasmResult = await this.layoutNodesWasm();
    if (wasmResult) return wasmResult;

    // Fallback: TS grid layout
    return { positioned: this.layoutNodesGrid() };
  }

  private async layoutNodesWasm(): Promise<{ positioned: Map<string, PositionedNode>; edgeRoutes: Map<string, EdgeRoute>; groupBounds?: GroupBounds[] } | null> {
    const graphNodes = Array.from(this.nodes.values()).filter(
      n => n.type === "rectangle" || n.type === "ellipse" || n.type === "diamond",
    );
    if (graphNodes.length === 0) return null;

    const wasmNodes = graphNodes.map(n => ({
      id: n.id, width: n.width, height: n.height,
      row: n.row, col: n.col, absX: n.absX, absY: n.absY,
      type: n.type,
    }));
    const wasmEdges = this.edges.map(e => ({ from: e.from, to: e.to, label: e.label }));
    const wasmGroups = Array.from(this.groups.entries()).map(([id, g]) => ({
      id, label: g.label, children: g.children,
    }));

    const result = await layoutGraphWasm(wasmNodes, wasmEdges, wasmGroups.length > 0 ? wasmGroups : undefined);
    if (!result) return null;

    return { positioned: this.applyPositions(result.nodes), edgeRoutes: result.edgeRoutes, groupBounds: result.groupBounds };
  }

  /** Apply layout positions to nodes, with absX/absY overrides and fallback for unpositioned nodes. */
  private applyPositions(positions: { id: string; x: number; y: number }[]): Map<string, PositionedNode> {
    const result = new Map<string, PositionedNode>();
    for (const pos of positions) {
      const node = this.nodes.get(pos.id);
      if (node) {
        result.set(pos.id, { ...node, x: node.absX ?? pos.x, y: node.absY ?? pos.y });
      }
    }
    // Place unpositioned nodes (text, line) below the positioned graph
    let maxBottom = BASE_Y;
    for (const n of result.values()) {
      const bottom = (n.y ?? 0) + n.height;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    let offsetX = BASE_X;
    for (const node of this.nodes.values()) {
      if (!result.has(node.id)) {
        const x = node.absX ?? offsetX;
        const y = node.absY ?? (maxBottom + ROW_SPACING);
        result.set(node.id, { ...node, x, y });
        if (node.absX === undefined) offsetX += node.width + 40;
      }
    }
    return result;
  }

  private layoutNodesGrid(): Map<string, PositionedNode> {
    const result = new Map<string, PositionedNode>();

    let autoRow = 0;
    let autoCol = 0;
    const maxColsPerRow = 5;

    for (const node of this.nodes.values()) {
      // Absolute position takes precedence
      if (node.absX !== undefined && node.absY !== undefined) {
        result.set(node.id, { ...node, x: node.absX, y: node.absY });
        continue;
      }

      const row = node.row ?? autoRow;
      const col = node.col ?? autoCol;

      result.set(node.id, {
        ...node,
        x: node.absX ?? (BASE_X + col * COL_SPACING),
        y: node.absY ?? (BASE_Y + row * ROW_SPACING),
      });

      if (node.row === undefined && node.col === undefined) {
        autoCol++;
        if (autoCol >= maxColsPerRow) {
          autoCol = 0;
          autoRow++;
        }
      }
    }

    return result;
  }
}

/** Resolve color from opts: hex overrides > preset > default */
function resolveColor(opts?: ShapeOpts, defaultPreset: ColorPreset = "backend"): ColorPair {
  const preset = opts?.color ?? defaultPreset;
  const palette = COLOR_PALETTE[preset];
  return {
    background: opts?.backgroundColor ?? palette.background,
    stroke: opts?.strokeColor ?? palette.stroke,
  };
}

interface PositionedNode extends GraphNode {
  x?: number;
  y?: number;
}
