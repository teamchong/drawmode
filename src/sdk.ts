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
  type GraphvizEdgeRoute, type GraphvizLayoutResult,
} from "./layout.js";

const DEFAULT_WIDTH = 180;
const DEFAULT_HEIGHT = 80;
const LINE_HEIGHT = 24; // extra height per additional line of text
const COL_SPACING = 280;
const ROW_SPACING = 220;
const BASE_X = 100;
const BASE_Y = 100;

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${++idCounter}_${Date.now().toString(36)}`;
}

function randSeed(): number {
  return Math.floor(Math.random() * 2000000000);
}

export class Diagram {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private groups = new Map<string, { label: string; children: string[] }>();
  /** Passthrough elements from fromFile() — re-emitted unchanged */
  private passthrough: object[] = [];

  /** Add a rectangle to the diagram. Returns the element ID. */
  addBox(label: string, opts?: ShapeOpts): string {
    const id = nextId("box");
    const color = resolveColor(opts);
    const extraLines = (label.split("\n").length - 1);
    this.nodes.set(id, {
      id, label, type: "rectangle",
      row: opts?.row, col: opts?.col,
      width: opts?.width ?? DEFAULT_WIDTH,
      height: opts?.height ?? (DEFAULT_HEIGHT + extraLines * LINE_HEIGHT),
      color,
      opts,
      absX: opts?.x,
      absY: opts?.y,
    });
    return id;
  }

  /** Add an ellipse to the diagram. Returns the element ID. */
  addEllipse(label: string, opts?: ShapeOpts): string {
    const id = nextId("ell");
    const defaultPreset: ColorPreset = "users";
    const color = resolveColor(opts, defaultPreset);
    const extraLines = (label.split("\n").length - 1);
    this.nodes.set(id, {
      id, label, type: "ellipse",
      row: opts?.row, col: opts?.col,
      width: opts?.width ?? DEFAULT_WIDTH,
      height: opts?.height ?? (DEFAULT_HEIGHT + extraLines * LINE_HEIGHT),
      color,
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
    const id = nextId("txt");
    const preset = opts?.color ?? "backend";
    const paletteColor = COLOR_PALETTE[preset];
    const strokeColor = opts?.strokeColor ?? paletteColor.stroke;
    this.nodes.set(id, {
      id, label: text, type: "text",
      width: text.length * (opts?.fontSize ?? 16) * 0.6 + 16,
      height: (opts?.fontSize ?? 16) + 8,
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
    const id = nextId("line");
    // Compute bounding box
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
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
    const id = nextId("grp");
    this.groups.set(id, { label, children });
    return id;
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
  static async fromFile(path: string): Promise<Diagram> {
    const { readFile } = await import("node:fs/promises");

    // Check for sidecar .drawmode.ts first
    const sidecarPath = path.replace(/\.excalidraw$/, ".drawmode.ts");
    try {
      const { stat } = await import("node:fs/promises");
      await stat(sidecarPath);
      // Sidecar exists — but we still parse JSON so caller can edit
    } catch {
      // No sidecar, fine
    }

    const raw = await readFile(path, "utf-8");
    const json = JSON.parse(raw);
    const elements: Record<string, unknown>[] = json.elements ?? [];

    const d = new Diagram();

    // Index text elements by containerId for label lookup
    const textByContainer = new Map<string, Record<string, unknown>>();
    for (const el of elements) {
      if (el.type === "text" && el.containerId) {
        textByContainer.set(el.containerId as string, el);
      }
    }

    // Reconstruct nodes from shapes
    for (const el of elements) {
      const elType = el.type as string;
      const elId = el.id as string;

      if (elType === "rectangle" || elType === "ellipse") {
        // Check if this is a group boundary (dashed + low opacity)
        if (el.strokeStyle === "dashed" && (el.opacity as number) <= 50) {
          const labelEl = elements.find(
            e => e.type === "text" && e.id === `${elId}-label`,
          );
          d.groups.set(elId, {
            label: (labelEl?.text as string) ?? "",
            children: [], // We can't perfectly reconstruct children from JSON
          });
          continue;
        }

        const boundText = textByContainer.get(elId);
        const label = (boundText?.text as string) ?? "";

        const node: GraphNode = {
          id: elId,
          label,
          type: elType,
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
      } else if (elType === "text" && el.containerId) {
        // Bound text — already handled via textByContainer, skip
      } else {
        // Unknown element type — passthrough
        d.passthrough.push(el);
      }
    }

    return d;
  }

  /** Find node IDs by label substring match. */
  findByLabel(label: string): string[] {
    const lower = label.toLowerCase();
    const results: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.label.toLowerCase().includes(lower)) {
        results.push(node.id);
      }
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

    // Merge remaining opts
    node.opts = { ...node.opts, ...update };
  }

  /** Remove a node and all its connected edges. */
  removeNode(id: string): void {
    this.nodes.delete(id);
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    // Also remove from groups
    for (const group of this.groups.values()) {
      group.children = group.children.filter(c => c !== id);
    }
  }

  /** Remove an edge between two nodes. */
  removeEdge(from: string, to: string): void {
    this.edges = this.edges.filter(e => !(e.from === from && e.to === to));
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
              process.stderr.write(`[drawmode] validation warning: ${err.msg} (${err.id})\n`);
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
    const { writeFile } = await import("node:fs/promises");

    if (format === "excalidraw") {
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

    if (format === "svg") {
      const { exportToSvg } = await import("./export.js");
      result.svg = exportToSvg(elements);
      const path = opts?.path ?? "diagram.svg";
      await writeFile(path, result.svg);
      result.filePath = path;
    }

    if (format === "png") {
      const { exportToPng } = await import("./export.js");
      result.png = await exportToPng(elements);
      const path = opts?.path ?? "diagram.png";
      await writeFile(path, result.png);
      result.filePath = path;
    }

    return result;
  }

  /** Convert the graph to Excalidraw elements with layout. */
  private async buildElements(): Promise<object[]> {
    const elements: object[] = [];
    const { positioned, edgeRoutes } = await this.layoutNodes();

    // Create shape + bound text for each node
    for (const node of positioned.values()) {
      const o = node.opts;

      // Standalone text node
      if (node.type === "text") {
        elements.push({
          id: node.id,
          type: "text",
          x: node.x!, y: node.y!,
          width: node.width,
          height: node.height,
          text: node.label,
          fontSize: o?.fontSize ?? 16,
          fontFamily: o?.fontFamily ?? 1,
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
          groupIds: [],
          frameId: null,
          isDeleted: false,
          boundElements: null,
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
        boundElements: [{ type: "text", id: textId }],
        groupIds: [],
        frameId: null,
        isDeleted: false,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
      });

      const textWidth = node.width - 20;
      const textHeight = 20;

      elements.push({
        id: textId,
        type: "text",
        x: node.x! + (node.width - textWidth) / 2,
        y: node.y! + (node.height - textHeight) / 2,
        width: textWidth,
        height: textHeight,
        text: node.label,
        fontSize: o?.fontSize ?? 16,
        fontFamily: o?.fontFamily ?? 1,
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
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
      });
    }

    // Create arrows for edges
    const edgeCounts = new Map<string, number>();
    const edgeIndexes = new Map<string, number>();

    for (const edge of this.edges) {
      edgeCounts.set(edge.from, (edgeCounts.get(edge.from) ?? 0) + 1);
    }

    for (const edge of this.edges) {
      const fromNode = positioned.get(edge.from);
      const toNode = positioned.get(edge.to);
      if (!fromNode || !toNode) continue;

      const co = edge.opts;
      const arrowId = nextId("arr");
      const outCount = edgeCounts.get(edge.from) ?? 1;
      const outIdx = edgeIndexes.get(edge.from) ?? 0;
      edgeIndexes.set(edge.from, outIdx + 1);

      const isElbowed = co?.elbowed !== false; // default true

      // Check for Graphviz-computed edge route
      const routeKey = `${edge.from}->${edge.to}`;
      const gvRoute = edgeRoutes?.get(routeKey);

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

        if (isElbowed) {
          if (sourceEdge === "bottom" && targetEdge === "top") {
            if (Math.abs(dx) < 10) {
              points = [[0, 0], [0, dy]];
            } else {
              const midY = Math.round(dy / 2);
              points = [[0, 0], [0, midY], [dx, midY], [dx, dy]];
            }
          } else if (sourceEdge === "top" && targetEdge === "bottom") {
            if (Math.abs(dx) < 10) {
              points = [[0, 0], [0, dy]];
            } else {
              const midY = Math.round(dy / 2);
              points = [[0, 0], [0, midY], [dx, midY], [dx, dy]];
            }
          } else if (sourceEdge === "right" && targetEdge === "left") {
            if (Math.abs(dy) < 10) {
              points = [[0, 0], [dx, 0]];
            } else {
              const midX = Math.round(dx / 2);
              points = [[0, 0], [midX, 0], [midX, dy], [dx, dy]];
            }
          } else if (sourceEdge === "left" && targetEdge === "right") {
            if (Math.abs(dy) < 10) {
              points = [[0, 0], [dx, 0]];
            } else {
              const midX = Math.round(dx / 2);
              points = [[0, 0], [midX, 0], [midX, dy], [dx, dy]];
            }
          } else {
            const midY = Math.round(dy / 2);
            points = [[0, 0], [0, midY], [dx, midY], [dx, dy]];
          }
        } else {
          points = [[0, 0], [dx, dy]];
        }
      }

      const allX = points.map(p => p[0]);
      const allY = points.map(p => p[1]);
      const boundsWidth = Math.max(...allX) - Math.min(...allX);
      const boundsHeight = Math.max(...allY) - Math.min(...allY);

      const labelTextId = edge.label ? nextId("arrlbl") : undefined;

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
        roundness: isElbowed ? null : undefined,
        elbowed: isElbowed,
        opacity: co?.opacity ?? 100,
        angle: 0,
        startBinding: { elementId: edge.from, focus: 0, gap: 1, fixedPoint: null },
        endBinding: { elementId: edge.to, focus: 0, gap: 1, fixedPoint: null },
        startArrowhead: co?.startArrowhead ?? null,
        endArrowhead: co?.endArrowhead ?? "arrow",
        groupIds: [],
        frameId: null,
        isDeleted: false,
        boundElements: labelTextId ? [{ type: "text", id: labelTextId }] : null,
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
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

        elements.push({
          id: labelTextId,
          type: "text",
          x: labelX,
          y: labelY,
          width: edge.label.length * 8 + 16,
          height: 20,
          text: edge.label,
          fontSize: co?.labelFontSize ?? 14,
          fontFamily: 1,
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
      const minX = Math.min(...childNodes.map(n => n.x!)) - padding;
      const minY = Math.min(...childNodes.map(n => n.y!)) - padding - 20;
      const maxX = Math.max(...childNodes.map(n => n.x! + n.width)) + padding;
      const maxY = Math.max(...childNodes.map(n => n.y! + n.height)) + padding;

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
        seed: randSeed(),
        version: 1,
        versionNonce: randSeed(),
      });
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
    // Only layout graph-relevant nodes (rectangles, ellipses) via Graphviz
    const graphNodes = Array.from(this.nodes.values()).filter(
      n => n.type === "rectangle" || n.type === "ellipse",
    );
    if (graphNodes.length === 0) return null;

    const gvNodes = graphNodes.map(n => ({
      id: n.id, width: n.width, height: n.height,
      row: n.row, col: n.col, absX: n.absX, absY: n.absY,
    }));
    const gvEdges = this.edges.map(e => ({
      from: e.from, to: e.to, label: e.label,
    }));
    const gvGroups = Array.from(this.groups.entries()).map(([id, g]) => ({
      id, label: g.label, children: g.children,
    }));

    const result = await layoutGraphGraphviz(gvNodes, gvEdges, gvGroups.length > 0 ? gvGroups : undefined);
    if (!result) return null;

    const positioned = new Map<string, PositionedNode>();

    // Apply Graphviz positions (absX/absY overrides)
    for (const pos of result.nodes) {
      const node = this.nodes.get(pos.id);
      if (node) {
        const x = node.absX ?? pos.x;
        const y = node.absY ?? pos.y;
        positioned.set(pos.id, { ...node, x, y });
      }
    }

    // Position non-graph nodes (text, lines) using absX/absY
    for (const node of this.nodes.values()) {
      if (!positioned.has(node.id)) {
        positioned.set(node.id, { ...node, x: node.absX ?? BASE_X, y: node.absY ?? BASE_Y });
      }
    }

    return { positioned, edgeRoutes: result.edgeRoutes };
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
      const result = new Map<string, PositionedNode>();

      for (const pos of laid) {
        const node = this.nodes.get(pos.id);
        if (node) {
          const x = node.absX ?? pos.x;
          const y = node.absY ?? pos.y;
          result.set(pos.id, { ...node, x, y });
        }
      }

      for (const node of this.nodes.values()) {
        if (!result.has(node.id)) {
          result.set(node.id, { ...node, x: node.absX ?? BASE_X, y: node.absY ?? BASE_Y });
        }
      }

      return result;
    } catch {
      return null;
    }
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

  // Prefer vertical routing when there's a clear row gap (avoids crossing boxes in same row)
  const preferVertical = hasVerticalGap && !(hasHorizontalGap && !hasVerticalGap);
  if (preferVertical ? (Math.abs(dy) > 0) : (Math.abs(dy) > Math.abs(dx))) {
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
