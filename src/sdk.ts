/**
 * Diagram SDK — high-level API for building Excalidraw diagrams.
 * Hides all Excalidraw JSON complexity (bound text, arrow routing, edge math).
 */

import type {
  ColorPreset, ShapeOpts, ConnectOpts, RenderOpts, RenderResult,
  GraphNode, GraphEdge, FillStyle, StrokeStyle, FontFamily,
  Arrowhead, TextAlign, VerticalAlign, ColorPair,
} from "./types.js";
import { COLOR_PALETTE } from "./types.js";
import {
  layoutGraph, validateElements, isWasmLoaded,
  layoutGraphGraphviz,
  type GraphvizEdgeRoute,
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
let globalIdCounter = 0;

function randSeed(): number {
  return Math.floor(Math.random() * 2000000000);
}

export class Diagram {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private groups = new Map<string, { label: string; children: string[] }>();
  private frames = new Map<string, { name: string; children: string[] }>();
  /** Passthrough elements from fromFile() — re-emitted unchanged */
  private passthrough: object[] = [];
  private idCounter = 0;

  private nextId(prefix: string): string {
    return `${prefix}_${++this.idCounter}_${SESSION_SEED}_${++globalIdCounter}`;
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
    const extraLines = label.split("\n").length - 1;
    this.nodes.set(id, {
      id, label, type,
      row: opts?.row, col: opts?.col,
      width: opts?.width ?? DEFAULT_WIDTH,
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
    // Compute bounding box in single pass
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
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
    const json = JSON.parse(raw);
    const elements: Record<string, unknown>[] = json.elements ?? [];

    const d = new this();

    // Index text elements by containerId for label lookup
    const textByContainer = new Map<string, Record<string, unknown>>();
    for (const el of elements) {
      if (el.type === "text" && el.containerId) {
        textByContainer.set(el.containerId as string, el);
      }
    }

    // Pre-detect group IDs so label text nodes can be skipped regardless of element order
    const groupIds = new Set<string>();
    for (const el of elements) {
      if ((el.type === "rectangle" || el.type === "ellipse") &&
          el.strokeStyle === "dashed" && el.backgroundColor === "transparent" &&
          (el.opacity as number) <= 50) {
        const elId = el.id as string;
        const labelEl = elements.find(e => e.type === "text" && e.id === `${elId}-label`);
        if (labelEl) groupIds.add(elId);
      }
    }

    // Reconstruct nodes from shapes
    for (const el of elements) {
      const elType = el.type as string;
      const elId = el.id as string;

      if (elType === "rectangle" || elType === "ellipse" || elType === "diamond") {
        // Detect group boundaries: must have companion "-label" text, dashed stroke,
        // transparent background, and low opacity. The "-label" check distinguishes
        // drawmode groups from user shapes that happen to be dashed + low opacity.
        const labelEl = elements.find(
          e => e.type === "text" && e.id === `${elId}-label`,
        );
        if (elType !== "diamond" && labelEl && el.strokeStyle === "dashed" &&
            el.backgroundColor === "transparent" && (el.opacity as number) <= 50) {
          d.groups.set(elId, {
            label: (labelEl?.text as string) ?? "",
            children: [], // Reconstructed below after all nodes are loaded
            _bounds: { x: el.x as number, y: el.y as number, w: el.width as number, h: el.height as number },
          } as { label: string; children: string[]; _bounds?: { x: number; y: number; w: number; h: number } });
          continue;
        }

        const boundText = textByContainer.get(elId);
        const label = (boundText?.text as string) ?? "";

        const node: GraphNode = {
          id: elId,
          label,
          type: elType as GraphNode["type"],
          width: el.width as number,
          height: el.height as number,
          color: {
            background: el.backgroundColor as string,
            stroke: el.strokeColor as string,
          },
          opts: {
            fillStyle: el.fillStyle as FillStyle | undefined,
            strokeWidth: el.strokeWidth as number | undefined,
            strokeStyle: el.strokeStyle as StrokeStyle | undefined,
            roughness: el.roughness as number | undefined,
            opacity: el.opacity as number | undefined,
            roundness: el.roundness as { type: number } | null | undefined,
            strokeColor: el.strokeColor as string | undefined,
            backgroundColor: el.backgroundColor as string | undefined,
            fontSize: boundText?.fontSize as number | undefined,
            fontFamily: boundText?.fontFamily as FontFamily | undefined,
            textAlign: boundText?.textAlign as TextAlign | undefined,
            verticalAlign: boundText?.verticalAlign as VerticalAlign | undefined,
            link: el.link as string | null | undefined,
            ...(el.customData !== undefined ? { customData: el.customData as Record<string, unknown> } : {}),
          },
          absX: el.x as number,
          absY: el.y as number,
        };
        d.nodes.set(elId, node);
      } else if (elType === "arrow") {
        const startId = (el.startBinding as { elementId?: string })?.elementId;
        const endId = (el.endBinding as { elementId?: string })?.elementId;
        if (startId && endId) {
          const arrowLabel = textByContainer.get(elId);
          d.edges.push({
            from: startId,
            to: endId,
            label: arrowLabel?.text as string | undefined,
            style: (el.strokeStyle as StrokeStyle) ?? "solid",
            opts: {
              strokeColor: el.strokeColor as string | undefined,
              strokeWidth: el.strokeWidth as number | undefined,
              roughness: el.roughness as number | undefined,
              opacity: el.opacity as number | undefined,
              startArrowhead: el.startArrowhead as Arrowhead | undefined,
              endArrowhead: el.endArrowhead as Arrowhead | undefined,
              elbowed: el.elbowed as boolean | undefined,
              labelFontSize: arrowLabel?.fontSize as number | undefined,
            },
          });
        } else {
          // Arrow without both bindings — passthrough
          d.passthrough.push(el);
        }
      } else if (elType === "text" && !el.containerId) {
        // Skip group label text elements (detected in pre-scan above)
        if (elId.endsWith("-label") && groupIds.has(elId.replace(/-label$/, ""))) continue;

        // Standalone text — add as text node
        d.nodes.set(elId, {
          id: elId,
          label: el.text as string,
          type: "text",
          width: el.width as number,
          height: el.height as number,
          color: { background: "transparent", stroke: el.strokeColor as string },
          opts: { fontSize: el.fontSize as number, fontFamily: el.fontFamily as FontFamily },
          absX: el.x as number,
          absY: el.y as number,
        });
      } else if (elType === "frame") {
        // Native Excalidraw frame — reconstruct into frames map
        d.frames.set(elId, {
          name: (el.name as string) ?? "",
          children: [], // Populated below using frameId references
        });
      } else if (elType === "text" && el.containerId) {
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
      const fid = el.frameId as string | null | undefined;
      if (fid && d.frames.has(fid)) {
        const elId = el.id as string;
        // Only add shape nodes (not bound text elements) as frame children
        if (d.nodes.has(elId)) {
          d.frames.get(fid)!.children.push(elId);
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
              if (typeof globalThis.process !== "undefined") {
                process.stderr.write(`[drawmode] validation warning: ${err.msg} (${err.id})\n`);
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    const excalidrawJson = {
      type: "excalidraw",
      version: 2,
      source: "drawmode",
      elements,
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: {},
    };

    const result: RenderResult = { json: excalidrawJson };
    const format = opts?.format ?? "excalidraw";

    // Lazily import writeFile only when a file-writing format is used
    const needsFs = format === "excalidraw" || format === "svg" || format === "png";
    const writeFile = needsFs ? (await import("node:fs/promises")).writeFile : undefined;

    if (format === "excalidraw") {
      const path = opts?.path ?? "diagram.excalidraw";
      await writeFile!(path, JSON.stringify(excalidrawJson, null, 2));
      result.filePath = path;

      // Write sidecar .drawmode.ts if source code provided
      if (opts?.sourceCode && path.endsWith(".excalidraw")) {
        const sidecarPath = path.replace(/\.excalidraw$/, ".drawmode.ts");
        await writeFile!(sidecarPath, opts.sourceCode);
      }
    }

    if (format === "url") {
      const { uploadToExcalidraw } = await import("./upload.js");
      result.url = await uploadToExcalidraw(JSON.stringify(excalidrawJson));
    }

    if (format === "svg") {
      const { exportToSvg } = await import("./export.js");
      result.svg = exportToSvg(elements);
      const path = opts?.path ?? "diagram.svg";
      await writeFile!(path, result.svg);
      result.filePath = path;
    }

    if (format === "png") {
      const { exportToPng } = await import("./export.js");
      result.png = await exportToPng(elements);
      const path = opts?.path ?? "diagram.png";
      await writeFile!(path, result.png);
      result.filePath = path;
    }

    return result;
  }

  /** Convert the graph to Excalidraw elements with layout. */
  private async buildElements(): Promise<object[]> {
    const elements: object[] = [];
    const { positioned, edgeRoutes } = await this.layoutNodes();

    // Pre-compute arrow bindings per shape: arrowId will be assigned later,
    // so we use edge index to track and fill in the ID after arrow creation.
    const arrowBindingsPerNode = new Map<string, { type: "arrow"; id: string }[]>();
    const arrowIds: string[] = [];
    for (let i = 0; i < this.edges.length; i++) {
      const edge = this.edges[i];
      const arrowId = this.nextId("arr");
      arrowIds.push(arrowId);
      for (const nodeId of [edge.from, edge.to]) {
        if (!arrowBindingsPerNode.has(nodeId)) arrowBindingsPerNode.set(nodeId, []);
        arrowBindingsPerNode.get(nodeId)!.push({ type: "arrow", id: arrowId });
      }
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
          ...(arrowBindingsPerNode.get(node.id) ?? []),
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
    let edgeCounts: Map<string, number> | undefined;
    const edgeIndexes = new Map<string, number>();
    const edgePairCounts = new Map<string, number>(); // track multi-edges between same nodes

    const needsStagger = !edgeRoutes || this.edges.some(e => !edgeRoutes.has(`${e.from}->${e.to}`));
    if (needsStagger) {
      edgeCounts = new Map();
      // Only count non-Graphviz-routed edges for stagger computation
      for (const edge of this.edges) {
        if (!edgeRoutes?.has(`${edge.from}->${edge.to}`)) {
          edgeCounts.set(edge.from, (edgeCounts.get(edge.from) ?? 0) + 1);
        }
      }
    }

    for (let ei = 0; ei < this.edges.length; ei++) {
      const edge = this.edges[ei];
      const fromNode = positioned.get(edge.from);
      const toNode = positioned.get(edge.to);
      if (!fromNode || !toNode) continue;

      const co = edge.opts;
      const arrowId = arrowIds[ei];
      const isElbowed = co?.elbowed !== false; // default true

      // Check for Graphviz-computed edge route (with index for multi-edges)
      const baseRouteKey = `${edge.from}->${edge.to}`;
      const edgePairIdx = edgePairCounts.get(baseRouteKey) ?? 0;
      edgePairCounts.set(baseRouteKey, edgePairIdx + 1);
      const routeKey = edgePairIdx === 0 ? baseRouteKey : `${baseRouteKey}#${edgePairIdx}`;
      const gvRoute = edgeRoutes?.get(routeKey);

      // Only track stagger indexes for TS-routed edges
      const outCount = edgeCounts?.get(edge.from) ?? 1;
      const outIdx = gvRoute ? 0 : (edgeIndexes.get(edge.from) ?? 0);
      if (!gvRoute) edgeIndexes.set(edge.from, outIdx + 1);

      let arrowX: number, arrowY: number;
      let points: number[][];

      if (gvRoute && gvRoute.points.length >= 2) {
        // Use Graphviz-computed route
        arrowX = gvRoute.points[0][0];
        arrowY = gvRoute.points[0][1];
        points = gvRoute.points.map(([px, py]) => [px - arrowX, py - arrowY]);
      } else {
        // Fallback: TS elbow routing
        const { sourcePoint, targetPoint, sourceEdge, targetEdge } =
          calculateArrowEndpoints(fromNode, toNode, outIdx, outCount);

        arrowX = sourcePoint.x;
        arrowY = sourcePoint.y;

        const dx = targetPoint.x - sourcePoint.x;
        const dy = targetPoint.y - sourcePoint.y;

        if (!isElbowed) {
          points = [[0, 0], [dx, dy]];
        } else if (sourceEdge === "right" || sourceEdge === "left") {
          // Horizontal source edge → route via midX
          if (Math.abs(dy) < 10) {
            points = [[0, 0], [dx, 0]];
          } else {
            const midX = Math.round(dx / 2);
            points = [[0, 0], [midX, 0], [midX, dy], [dx, dy]];
          }
        } else {
          // Vertical source edge (top/bottom) or default → route via midY
          if (Math.abs(dx) < 10) {
            points = [[0, 0], [0, dy]];
          } else {
            const midY = Math.round(dy / 2);
            points = [[0, 0], [0, midY], [dx, midY], [dx, dy]];
          }
        }
      }

      let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
      for (const p of points) {
        if (p[0] < bMinX) bMinX = p[0];
        if (p[0] > bMaxX) bMaxX = p[0];
        if (p[1] < bMinY) bMinY = p[1];
        if (p[1] > bMaxY) bMaxY = p[1];
      }
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
        startBinding: { elementId: edge.from, focus: 0, gap: 1, fixedPoint: [0.5, 0.5] },
        endBinding: { elementId: edge.to, focus: 0, gap: 1, fixedPoint: [0.5, 0.5] },
        startArrowhead: co?.startArrowhead ?? null,
        endArrowhead: co?.endArrowhead ?? "arrow",
        groupIds: [],
        frameId: null,
        isDeleted: false,
        boundElements: labelTextId ? [{ type: "text", id: labelTextId }] : null,
        updated: Date.now(),
        locked: false,
        link: null,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
        ...(co?.customData !== undefined ? { customData: co.customData } : {}),
      });

      // Arrow label placement
      if (edge.label && labelTextId) {
        let labelX: number, labelY: number;

        if (gvRoute?.labelPos) {
          // Use Graphviz-computed label position
          labelX = gvRoute.labelPos.x;
          labelY = gvRoute.labelPos.y - 12;
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
          containerId: arrowId,
          originalText: edge.label,
          autoResize: true,
          strokeColor: co?.strokeColor ?? toNode.color.stroke,
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

    // Groups: dashed rectangle around children + label
    for (const [groupId, group] of this.groups) {
      const childNodes = group.children
        .map(c => positioned.get(c))
        .filter((n): n is PositionedNode => n !== undefined);
      if (childNodes.length === 0) continue;

      const padding = 30;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of childNodes) {
        if (n.x! < minX) minX = n.x!;
        if (n.y! < minY) minY = n.y!;
        if (n.x! + n.width > maxX) maxX = n.x! + n.width;
        if (n.y! + n.height > maxY) maxY = n.y! + n.height;
      }
      minX -= padding;
      minY -= padding + 20;
      maxX += padding;
      maxY += padding;

      elements.push({
        id: groupId,
        type: "rectangle",
        x: minX, y: minY,
        width: maxX - minX, height: maxY - minY,
        backgroundColor: "transparent",
        strokeColor: "#868e96",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "dashed",
        roughness: 0,
        opacity: 40,
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
        x: minX + 10, y: minY + 5,
        width: 100, height: 20,
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
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of childNodes) {
        if (n.x! < minX) minX = n.x!;
        if (n.y! < minY) minY = n.y!;
        if (n.x! + n.width > maxX) maxX = n.x! + n.width;
        if (n.y! + n.height > maxY) maxY = n.y! + n.height;
      }
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
        const elObj = el as Record<string, unknown>;
        if (frame.children.includes(elObj.id as string)) {
          elObj.frameId = frameId;
        }
        // Also tag bound text elements
        if (elObj.containerId && frame.children.includes(elObj.containerId as string)) {
          elObj.frameId = frameId;
        }
      }
    }

    // Append passthrough elements
    elements.push(...this.passthrough);

    return elements;
  }

  /** Assign x,y positions to all nodes. Priority: Graphviz → WASM grid → TS grid. */
  private async layoutNodes(): Promise<{ positioned: Map<string, PositionedNode>; edgeRoutes?: Map<string, GraphvizEdgeRoute> }> {
    // Try Graphviz layout first (async)
    const gvResult = await this.layoutNodesGraphviz();
    if (gvResult) return gvResult;

    // Try WASM grid layout
    if (isWasmLoaded()) {
      const wasmResult = this.layoutNodesWasm();
      if (wasmResult) return { positioned: wasmResult };
    }

    // Fallback: TS grid layout
    return { positioned: this.layoutNodesGrid() };
  }

  private async layoutNodesGraphviz(): Promise<{ positioned: Map<string, PositionedNode>; edgeRoutes: Map<string, GraphvizEdgeRoute> } | null> {
    const graphNodes = Array.from(this.nodes.values()).filter(
      n => n.type === "rectangle" || n.type === "ellipse" || n.type === "diamond",
    );
    if (graphNodes.length === 0) return null;

    const gvNodes = graphNodes.map(n => ({
      id: n.id, width: n.width, height: n.height,
      row: n.row, col: n.col, absX: n.absX, absY: n.absY,
      type: n.type,
    }));
    const gvEdges = this.edges.map(e => ({ from: e.from, to: e.to, label: e.label }));
    const gvGroups = Array.from(this.groups.entries()).map(([id, g]) => ({
      id, label: g.label, children: g.children,
    }));

    const result = await layoutGraphGraphviz(gvNodes, gvEdges, gvGroups.length > 0 ? gvGroups : undefined);
    if (!result) return null;

    return { positioned: this.applyPositions(result.nodes), edgeRoutes: result.edgeRoutes };
  }

  private layoutNodesWasm(): Map<string, PositionedNode> | null {
    const nodesJson = JSON.stringify(
      Array.from(this.nodes.values()).map(n => ({
        id: n.id, width: n.width, height: n.height,
        row: n.row ?? null, col: n.col ?? null,
      })),
    );
    const edgesJson = JSON.stringify(
      this.edges.map(e => ({ from: e.from, to: e.to })),
    );

    const resultJson = layoutGraph(nodesJson, edgesJson);
    if (!resultJson) return null;

    try {
      const laid = JSON.parse(resultJson) as { id: string; x: number; y: number }[];
      return this.applyPositions(laid);
    } catch {
      return null;
    }
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

interface Point { x: number; y: number; }

function calculateArrowEndpoints(
  from: PositionedNode, to: PositionedNode,
  edgeIdx: number, edgeCount: number,
): { sourcePoint: Point; targetPoint: Point; sourceEdge: string; targetEdge: string } {
  const fx = from.x ?? 0, fy = from.y ?? 0;
  const tx = to.x ?? 0, ty = to.y ?? 0;

  // Stagger ratio: distribute arrows across edge
  const staggerPositions = [0.5, 0.35, 0.65, 0.2, 0.8];
  const stagger = edgeCount === 1 ? 0.5 : (staggerPositions[edgeIdx] ?? 0.5);

  // Determine edges based on relative position
  const dy = (ty + to.height / 2) - (fy + from.height / 2);
  const dx = (tx + to.width / 2) - (fx + from.width / 2);

  // Check if boxes don't overlap vertically (clear row gap) — prefer vertical routing
  const fromBottom = fy + from.height;
  const toBottom = ty + to.height;
  const hasVerticalGap = (fromBottom < ty) || (toBottom < fy);
  // Check if boxes don't overlap horizontally (clear col gap) — prefer horizontal routing
  const fromRight = fx + from.width;
  const toRight = tx + to.width;
  const hasHorizontalGap = (fromRight < tx) || (toRight < fx);

  let sourceEdge: string, targetEdge: string;
  let sourcePoint: Point, targetPoint: Point;

  if (hasVerticalGap || (!hasHorizontalGap && Math.abs(dy) > Math.abs(dx))) {
    // Vertical relationship
    if (dy > 0) {
      sourceEdge = "bottom"; targetEdge = "top";
      sourcePoint = { x: fx + from.width * stagger, y: fy + from.height };
      targetPoint = { x: tx + to.width * stagger, y: ty };
    } else {
      sourceEdge = "top"; targetEdge = "bottom";
      sourcePoint = { x: fx + from.width * stagger, y: fy };
      targetPoint = { x: tx + to.width * stagger, y: ty + to.height };
    }
  } else {
    // Horizontal relationship
    if (dx > 0) {
      sourceEdge = "right"; targetEdge = "left";
      sourcePoint = { x: fx + from.width, y: fy + from.height * stagger };
      targetPoint = { x: tx, y: ty + to.height * stagger };
    } else {
      sourceEdge = "left"; targetEdge = "right";
      sourcePoint = { x: fx, y: fy + from.height * stagger };
      targetPoint = { x: tx + to.width, y: ty + to.height * stagger };
    }
  }

  return { sourcePoint, targetPoint, sourceEdge, targetEdge };
}
