/**
 * Diagram SDK — high-level API for building Excalidraw diagrams.
 * Hides all Excalidraw JSON complexity (bound text, arrow routing, edge math).
 */

import type {
  ColorPreset, ShapeOpts, ConnectOpts, RenderOpts, RenderResult,
  GraphNode, GraphEdge,
} from "./types.js";
import { COLOR_PALETTE } from "./types.js";

const DEFAULT_WIDTH = 180;
const DEFAULT_HEIGHT = 80;
const COL_SPACING = 240;
const ROW_SPACING = 160;
const BASE_X = 100;
const BASE_Y = 100;

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${++idCounter}_${Date.now().toString(36)}`;
}

export class Diagram {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private groups = new Map<string, { label: string; children: string[] }>();

  /** Add a rectangle to the diagram. Returns the element ID. */
  addBox(label: string, opts?: ShapeOpts): string {
    const id = nextId("box");
    const color = COLOR_PALETTE[opts?.color ?? "backend"];
    this.nodes.set(id, {
      id, label, type: "rectangle",
      row: opts?.row, col: opts?.col,
      width: opts?.width ?? DEFAULT_WIDTH,
      height: opts?.height ?? DEFAULT_HEIGHT,
      color,
    });
    return id;
  }

  /** Add an ellipse to the diagram. Returns the element ID. */
  addEllipse(label: string, opts?: ShapeOpts): string {
    const id = nextId("ell");
    const color = COLOR_PALETTE[opts?.color ?? "users"];
    this.nodes.set(id, {
      id, label, type: "ellipse",
      row: opts?.row, col: opts?.col,
      width: opts?.width ?? DEFAULT_WIDTH,
      height: opts?.height ?? DEFAULT_HEIGHT,
      color,
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
    this.edges.push({ from, to, label, style: opts?.style ?? "solid" });
  }

  /** Render the diagram to the specified format. */
  async render(opts?: RenderOpts): Promise<RenderResult> {
    const elements = this.buildElements();
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

    if (opts?.path || format === "excalidraw") {
      const path = opts?.path ?? "diagram.excalidraw";
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, JSON.stringify(excalidrawJson, null, 2));
      result.filePath = path;
    }

    if (format === "url") {
      const { uploadToExcalidraw } = await import("./upload.js");
      result.url = await uploadToExcalidraw(JSON.stringify(excalidrawJson));
    }

    return result;
  }

  /** Convert the graph to Excalidraw elements with layout. */
  private buildElements(): object[] {
    const elements: object[] = [];
    const positioned = this.layoutNodes();

    // Create shape + bound text for each node
    for (const node of positioned.values()) {
      const textId = `${node.id}-text`;

      elements.push({
        id: node.id,
        type: node.type,
        x: node.x!, y: node.y!,
        width: node.width, height: node.height,
        backgroundColor: node.color.background,
        strokeColor: node.color.stroke,
        fillStyle: "solid",
        strokeWidth: 2,
        roughness: 1,
        opacity: 100,
        angle: 0,
        strokeStyle: "solid",
        roundness: { type: 3 },
        boundElements: [{ type: "text", id: textId }],
        groupIds: [],
        frameId: null,
        isDeleted: false,
        seed: Math.floor(Math.random() * 2000000000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 2000000000),
      });

      elements.push({
        id: textId,
        type: "text",
        x: node.x! + node.width / 2,
        y: node.y! + node.height / 2,
        width: node.width - 20,
        height: 20,
        text: node.label,
        fontSize: 16,
        fontFamily: 1,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: node.id,
        originalText: node.label,
        autoResize: true,
        strokeColor: node.color.stroke,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 0,
        opacity: 100,
        angle: 0,
        groupIds: [],
        frameId: null,
        isDeleted: false,
        boundElements: null,
        seed: Math.floor(Math.random() * 2000000000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 2000000000),
      });
    }

    // Create arrows for edges
    const edgeCounts = new Map<string, number>();
    const edgeIndexes = new Map<string, number>();

    for (const edge of this.edges) {
      const key = `${edge.from}->${edge.to}`;
      edgeCounts.set(edge.from, (edgeCounts.get(edge.from) ?? 0) + 1);
    }

    for (const edge of this.edges) {
      const fromNode = positioned.get(edge.from);
      const toNode = positioned.get(edge.to);
      if (!fromNode || !toNode) continue;

      const arrowId = nextId("arr");
      const outCount = edgeCounts.get(edge.from) ?? 1;
      const outIdx = edgeIndexes.get(edge.from) ?? 0;
      edgeIndexes.set(edge.from, outIdx + 1);

      // Determine source/target edges and calculate staggered positions
      const { sourcePoint, targetPoint, sourceEdge, targetEdge } =
        calculateArrowEndpoints(fromNode, toNode, outIdx, outCount);

      const dx = targetPoint.x - sourcePoint.x;
      const dy = targetPoint.y - sourcePoint.y;

      // Elbow routing
      let points: number[][];
      if (sourceEdge === "bottom" && targetEdge === "top") {
        if (Math.abs(dx) < 10) {
          points = [[0, 0], [0, dy]];
        } else {
          points = [[0, 0], [dx, 0], [dx, dy]];
        }
      } else if (sourceEdge === "right" && targetEdge === "left") {
        if (Math.abs(dy) < 10) {
          points = [[0, 0], [dx, 0]];
        } else {
          points = [[0, 0], [0, dy], [dx, dy]];
        }
      } else {
        points = [[0, 0], [dx, dy]];
      }

      const allX = points.map(p => p[0]);
      const allY = points.map(p => p[1]);
      const boundsWidth = Math.max(...allX) - Math.min(...allX);
      const boundsHeight = Math.max(...allY) - Math.min(...allY);

      elements.push({
        id: arrowId,
        type: "arrow",
        x: sourcePoint.x,
        y: sourcePoint.y,
        width: boundsWidth || 1,
        height: boundsHeight || 1,
        points,
        strokeColor: toNode.color.stroke,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: edge.style,
        roughness: 0,
        roundness: null,
        elbowed: true,
        opacity: 100,
        angle: 0,
        startBinding: { elementId: edge.from, focus: 0, gap: 1, fixedPoint: null },
        endBinding: { elementId: edge.to, focus: 0, gap: 1, fixedPoint: null },
        startArrowhead: null,
        endArrowhead: "arrow",
        groupIds: [],
        frameId: null,
        isDeleted: false,
        boundElements: null,
        seed: Math.floor(Math.random() * 2000000000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 2000000000),
      });
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
        seed: Math.floor(Math.random() * 2000000000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 2000000000),
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
        seed: Math.floor(Math.random() * 2000000000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 2000000000),
      });
    }

    return elements;
  }

  /** Assign x,y positions to all nodes using row/col grid or auto-layout. */
  private layoutNodes(): Map<string, PositionedNode> {
    const result = new Map<string, PositionedNode>();

    // Assign rows/cols for nodes that don't have them
    let autoRow = 0;
    let autoCol = 0;
    const maxColsPerRow = 5;

    for (const node of this.nodes.values()) {
      const row = node.row ?? autoRow;
      const col = node.col ?? autoCol;

      result.set(node.id, {
        ...node,
        x: BASE_X + col * COL_SPACING,
        y: BASE_Y + row * ROW_SPACING,
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

  let sourceEdge: string, targetEdge: string;
  let sourcePoint: Point, targetPoint: Point;

  if (Math.abs(dy) > Math.abs(dx)) {
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
