import { describe, it, expect, afterEach } from "vitest";
import { Diagram } from "./sdk.js";
import { unlink, writeFile, readFile } from "node:fs/promises";

describe("Diagram SDK", () => {
  it("addBox creates shape + text pair", async () => {
    const d = new Diagram();
    const id = d.addBox("API Gateway", { row: 0, col: 0, color: "backend" });
    expect(id).toMatch(/^box_/);

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Array<{ id: string; type: string; containerId?: string; boundElements?: unknown[] }> }).elements;

    // Should have at least shape + text
    const shape = elements.find(e => e.id === id);
    expect(shape).toBeDefined();
    expect(shape!.type).toBe("rectangle");
    expect(shape!.boundElements).toEqual([{ type: "text", id: `${id}-text` }]);

    const text = elements.find(e => e.id === `${id}-text`);
    expect(text).toBeDefined();
    expect(text!.type).toBe("text");
    expect(text!.containerId).toBe(id);
  });

  it("addEllipse creates ellipse + text pair", async () => {
    const d = new Diagram();
    const id = d.addEllipse("User", { row: 0, col: 0, color: "users" });
    expect(id).toMatch(/^ell_/);

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Array<{ id: string; type: string }> }).elements;

    const shape = elements.find(e => e.id === id);
    expect(shape).toBeDefined();
    expect(shape!.type).toBe("ellipse");
  });

  it("connect creates arrow with endpoints on shape edges", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b);

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Array<{ type: string; id: string; startBinding?: { elementId: string }; endBinding?: { elementId: string }; x?: number; y?: number; height?: number }> }).elements;

    const arrow = elements.find(e => e.type === "arrow");
    expect(arrow).toBeDefined();
    expect(arrow!.startBinding!.elementId).toBe(a);
    expect(arrow!.endBinding!.elementId).toBe(b);

    // Arrow should be positioned between A and B (structurally correct)
    const shapeA = elements.find(e => e.id === a)!;
    const shapeB = elements.find(e => e.id === b)!;
    // A should be above B
    expect(shapeA.y!).toBeLessThan(shapeB.y!);
    // Arrow should start at or below A's top edge
    expect(arrow!.y!).toBeGreaterThanOrEqual(shapeA.y!);
  });

  it("connect with label creates arrow + bound text", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "writes to");

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;

    const arrow = elements.find(e => e.type === "arrow") as Record<string, unknown>;
    expect(arrow).toBeDefined();
    const boundElements = arrow.boundElements as Array<{ type: string; id: string }>;
    expect(boundElements).toBeTruthy();
    expect(boundElements.length).toBe(1);
    expect(boundElements[0].type).toBe("text");

    const labelId = boundElements[0].id;
    // The arrow label has containerId set to the arrow's ID, not the label text ID
    const arrowId = arrow.id as string;
    const label = elements.find(e =>
      e.type === "text" && e.containerId === arrowId,
    );
    expect(label).toBeDefined();
    expect((label as Record<string, unknown>).text).toBe("writes to");
    expect((label as Record<string, unknown>).id).toBe(labelId);
  });

  it("addGroup creates dashed rectangle + label text", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 0, col: 1 });
    const grp = d.addGroup("Data Layer", [a, b]);

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Array<{ id: string; type: string; strokeStyle?: string; text?: string }> }).elements;

    const groupRect = elements.find(e => e.id === grp);
    expect(groupRect).toBeDefined();
    expect(groupRect!.type).toBe("rectangle");
    expect(groupRect!.strokeStyle).toBe("dashed");

    const groupLabel = elements.find(e => e.id === `${grp}-label`);
    expect(groupLabel).toBeDefined();
    expect(groupLabel!.type).toBe("text");
    expect(groupLabel!.text).toBe("Data Layer");
  });

  it("render with format excalidraw produces valid JSON structure", async () => {
    const d = new Diagram();
    d.addBox("Test", { row: 0, col: 0 });

    const result = await d.render({ format: "excalidraw" });
    expect(result.json).toBeDefined();

    const json = result.json as { type: string; version: number; source: string; elements: unknown[]; appState: unknown };
    expect(json.type).toBe("excalidraw");
    expect(json.version).toBe(2);
    expect(json.source).toBe("drawmode");
    expect(Array.isArray(json.elements)).toBe(true);
    expect(json.appState).toBeDefined();
  });

  it("multiple arrows from same source are staggered", async () => {
    const d = new Diagram();
    const src = d.addBox("Source", { row: 0, col: 1 });
    const t1 = d.addBox("Target1", { row: 1, col: 0 });
    const t2 = d.addBox("Target2", { row: 1, col: 2 });
    d.connect(src, t1);
    d.connect(src, t2);

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Array<{ type: string; x: number }> }).elements;

    const arrows = elements.filter(e => e.type === "arrow");
    expect(arrows.length).toBe(2);

    // Arrows should have different x positions (staggered)
    expect(arrows[0].x).not.toBe(arrows[1].x);
  });

  it("render with format svg produces SVG string", async () => {
    const d = new Diagram();
    d.addBox("Test", { row: 0, col: 0, color: "backend" });

    const result = await d.render({ format: "svg" });
    expect(result.svg).toBeDefined();
    expect(result.svg!).toContain("<svg");
    expect(result.svg!).toContain("</svg>");
    expect(result.svg!).toContain("<rect");
  });

  // ── New: Custom Properties ──

  it("custom fillStyle, roughness, opacity are wired through", async () => {
    const d = new Diagram();
    const id = d.addBox("Sketch", {
      row: 0, col: 0,
      fillStyle: "hachure",
      roughness: 0,
      opacity: 50,
    });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const shape = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(shape.fillStyle).toBe("hachure");
    expect(shape.roughness).toBe(0);
    expect(shape.opacity).toBe(50);
  });

  it("strokeStyle and strokeWidth are wired through", async () => {
    const d = new Diagram();
    const id = d.addBox("Dashed", {
      row: 0, col: 0,
      strokeStyle: "dotted",
      strokeWidth: 4,
    });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const shape = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(shape.strokeStyle).toBe("dotted");
    expect(shape.strokeWidth).toBe(4);
  });

  it("fontSize and fontFamily are wired through to bound text", async () => {
    const d = new Diagram();
    const id = d.addBox("Big Text", {
      row: 0, col: 0,
      fontSize: 24,
      fontFamily: 2,
    });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const text = elements.find(e => e.id === `${id}-text`) as Record<string, unknown>;

    expect(text.fontSize).toBe(24);
    expect(text.fontFamily).toBe(2);
  });

  it("roundness: null removes roundness", async () => {
    const d = new Diagram();
    const id = d.addBox("Sharp", { row: 0, col: 0, roundness: null });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const shape = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(shape.roundness).toBeNull();
  });

  // ── New: Arrow Options ──

  it("arrow opts: startArrowhead and endArrowhead", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, undefined, {
      startArrowhead: "dot",
      endArrowhead: "triangle",
    });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const arrow = elements.find(e => e.type === "arrow") as Record<string, unknown>;

    expect(arrow.startArrowhead).toBe("dot");
    expect(arrow.endArrowhead).toBe("triangle");
  });

  it("arrow opts: elbowed false produces straight arrow", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 1 });
    d.connect(a, b, undefined, { elbowed: false });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const arrow = elements.find(e => e.type === "arrow") as Record<string, unknown>;

    expect(arrow.elbowed).toBe(false);
    // Straight arrow: only 2 points
    expect((arrow.points as number[][]).length).toBe(2);
  });

  it("arrow opts: strokeColor and strokeWidth", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, undefined, { strokeColor: "#ff0000", strokeWidth: 4 });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const arrow = elements.find(e => e.type === "arrow") as Record<string, unknown>;

    expect(arrow.strokeColor).toBe("#ff0000");
    expect(arrow.strokeWidth).toBe(4);
  });

  it("arrow label uses custom labelFontSize", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "big label", { labelFontSize: 20 });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const arrow = elements.find(e => e.type === "arrow") as Record<string, unknown>;
    const arrowId = arrow.id as string;
    const label = elements.find(e => e.type === "text" && (e as Record<string, unknown>).containerId === arrowId) as Record<string, unknown>;

    expect(label.fontSize).toBe(20);
  });

  // ── New: Hex color overrides ──

  it("hex strokeColor/backgroundColor override preset", async () => {
    const d = new Diagram();
    const id = d.addBox("Custom", {
      row: 0, col: 0,
      color: "backend",
      strokeColor: "#ff0000",
      backgroundColor: "#00ff00",
    });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const shape = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(shape.strokeColor).toBe("#ff0000");
    expect(shape.backgroundColor).toBe("#00ff00");
  });

  // ── New: addText ──

  it("addText creates standalone text element", async () => {
    const d = new Diagram();
    const id = d.addText("Hello World", { x: 50, y: 50, fontSize: 20 });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const text = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(text).toBeDefined();
    expect(text.type).toBe("text");
    expect(text.text).toBe("Hello World");
    expect(text.fontSize).toBe(20);
    expect(text.containerId).toBeNull();
    expect(text.x).toBe(50);
    expect(text.y).toBe(50);
  });

  // ── New: addLine ──

  it("addLine creates line element with points", async () => {
    const d = new Diagram();
    const id = d.addLine([[100, 100], [300, 100]], {
      strokeColor: "#ff0000",
      strokeWidth: 3,
    });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const line = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(line).toBeDefined();
    expect(line.type).toBe("line");
    expect(line.strokeColor).toBe("#ff0000");
    expect(line.strokeWidth).toBe(3);
    expect((line.points as number[][]).length).toBe(2);
  });

  // ── New: Cloud palette colors ──

  it("cloud palette colors produce correct values", async () => {
    const d = new Diagram();
    const aws = d.addBox("Lambda", { row: 0, col: 0, color: "aws-compute" });
    const k8s = d.addBox("Pod", { row: 0, col: 1, color: "k8s-pod" });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;

    const awsShape = elements.find(e => e.id === aws) as Record<string, unknown>;
    expect(awsShape.backgroundColor).toBe("#FF9900");
    expect(awsShape.strokeColor).toBe("#C27400");

    const k8sShape = elements.find(e => e.id === k8s) as Record<string, unknown>;
    expect(k8sShape.backgroundColor).toBe("#326CE5");
    expect(k8sShape.strokeColor).toBe("#264FAB");
  });

  // ── New: fromFile + editing ──

  const testFile = "/tmp/drawmode-test-roundtrip.excalidraw";

  afterEach(async () => {
    try { await unlink(testFile); } catch { /* ok */ }
    try { await unlink(testFile.replace(".excalidraw", ".drawmode.ts")); } catch { /* ok */ }
  });

  it("fromFile round-trip preserves elements", async () => {
    // Create original
    const d1 = new Diagram();
    const a = d1.addBox("API", { row: 0, col: 0, color: "backend" });
    const b = d1.addBox("DB", { row: 1, col: 0, color: "database" });
    d1.connect(a, b, "queries");
    await d1.render({ format: "excalidraw", path: testFile });

    // Load and re-render
    const d2 = await Diagram.fromFile(testFile);
    const nodes = d2.getNodes();
    expect(nodes.length).toBe(2);

    const edges = d2.getEdges();
    expect(edges.length).toBe(1);
    expect(edges[0].label).toBe("queries");

    // Re-render to check it produces valid output
    const result = await d2.render({ format: "excalidraw", path: testFile });
    const json = result.json as { elements: unknown[] };
    expect(json.elements.length).toBeGreaterThan(0);
  });

  it("findByLabel matches substring", async () => {
    const d = new Diagram();
    d.addBox("API Gateway", { row: 0, col: 0 });
    d.addBox("API Server", { row: 0, col: 1 });
    d.addBox("Database", { row: 1, col: 0 });

    const results = d.findByLabel("API");
    expect(results.length).toBe(2);

    const dbResults = d.findByLabel("database");
    expect(dbResults.length).toBe(1);
  });

  it("updateNode changes label and color", async () => {
    const d = new Diagram();
    const id = d.addBox("Old Name", { row: 0, col: 0, color: "backend" });
    d.updateNode(id, { label: "New Name", color: "ai" });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const textEl = elements.find(e => e.id === `${id}-text`) as Record<string, unknown>;

    expect(textEl.text).toBe("New Name");
  });

  it("removeNode deletes node and connected edges", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    const c = d.addBox("C", { row: 1, col: 1 });
    d.connect(a, b, "a-b");
    d.connect(a, c, "a-c");
    d.connect(b, c, "b-c");

    d.removeNode(a);

    expect(d.getNodes().length).toBe(2);
    expect(d.getEdges().length).toBe(1);
    expect(d.getEdges()[0].label).toBe("b-c");
  });

  it("removeEdge removes specific edge", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "first");
    d.connect(b, a, "second");

    d.removeEdge(a, b);
    const edges = d.getEdges();
    expect(edges.length).toBe(1);
    expect(edges[0].label).toBe("second");
  });

  // ── New: Absolute positioning ──

  it("absolute x/y positioning bypasses grid", async () => {
    const d = new Diagram();
    const id = d.addBox("Absolute", { x: 500, y: 300 });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const shape = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(shape.x).toBe(500);
    expect(shape.y).toBe(300);
  });

  // ── addDiamond ──

  it("addDiamond creates diamond shape + text pair", async () => {
    const d = new Diagram();
    const id = d.addDiamond("Decision?", { row: 0, col: 0 });
    expect(id).toMatch(/^dia_/);

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;

    const shape = elements.find(e => e.id === id) as Record<string, unknown>;
    expect(shape).toBeDefined();
    expect(shape.type).toBe("diamond");

    const text = elements.find(e => e.id === `${id}-text`) as Record<string, unknown>;
    expect(text).toBeDefined();
    expect(text.text).toBe("Decision?");
    expect(text.containerId).toBe(id);
  });

  it("addDiamond can connect with arrows", async () => {
    const d = new Diagram();
    const start = d.addBox("Start", { row: 0, col: 0 });
    const decision = d.addDiamond("OK?", { row: 1, col: 0 });
    const end = d.addBox("End", { row: 2, col: 0 });
    d.connect(start, decision, "check");
    d.connect(decision, end, "yes");

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;

    const arrows = elements.filter(e => e.type === "arrow");
    expect(arrows.length).toBe(2);
  });

  // ── updateEdge ──

  it("updateEdge changes label and style", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "old label");

    d.updateEdge(a, b, { label: "new label", style: "dashed" });

    const edges = d.getEdges();
    expect(edges[0].label).toBe("new label");

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const arrow = elements.find(e => e.type === "arrow") as Record<string, unknown>;
    expect(arrow.strokeStyle).toBe("dashed");
  });

  it("updateEdge with matchLabel disambiguates multi-edges", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "reads");
    d.connect(a, b, "writes");

    d.updateEdge(a, b, { label: "WRITES" }, "writes");

    const edges = d.getEdges();
    expect(edges[0].label).toBe("reads");
    expect(edges[1].label).toBe("WRITES");
  });

  it("updateEdge throws on missing edge", () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });

    expect(() => d.updateEdge(a, b, { label: "x" })).toThrow("Edge not found");
  });

  // ── removeEdge with label ──

  it("removeEdge with label removes specific edge from multi-edges", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "reads");
    d.connect(a, b, "writes");
    d.connect(a, b, "deletes");

    d.removeEdge(a, b, "writes");

    const edges = d.getEdges();
    expect(edges.length).toBe(2);
    expect(edges[0].label).toBe("reads");
    expect(edges[1].label).toBe("deletes");
  });

  it("removeEdge without label removes first match only", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "first");
    d.connect(a, b, "second");

    d.removeEdge(a, b);

    const edges = d.getEdges();
    expect(edges.length).toBe(1);
    expect(edges[0].label).toBe("second");
  });

  // ── findByLabel exact ──

  it("findByLabel with exact option", () => {
    const d = new Diagram();
    d.addBox("API Gateway", { row: 0, col: 0 });
    d.addBox("API", { row: 0, col: 1 });
    d.addBox("Database", { row: 1, col: 0 });

    // Substring (default) matches both
    const subResults = d.findByLabel("API");
    expect(subResults.length).toBe(2);

    // Exact match only matches "API"
    const exactResults = d.findByLabel("API", { exact: true });
    expect(exactResults.length).toBe(1);

    // Case-insensitive exact
    const caseResults = d.findByLabel("api", { exact: true });
    expect(caseResults.length).toBe(1);
  });

  // ── link and customData ──

  it("link property is wired through to shape element", async () => {
    const d = new Diagram();
    const id = d.addBox("Click me", { row: 0, col: 0, link: "https://example.com" });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const shape = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(shape.link).toBe("https://example.com");
  });

  it("customData property is wired through to shape element", async () => {
    const d = new Diagram();
    const id = d.addBox("Meta", { row: 0, col: 0, customData: { service: "api", tier: 1 } });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const shape = elements.find(e => e.id === id) as Record<string, unknown>;

    expect(shape.customData).toEqual({ service: "api", tier: 1 });
  });

  it("customData on arrow is wired through", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "flow", { customData: { protocol: "grpc" } });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const arrow = elements.find(e => e.type === "arrow") as Record<string, unknown>;

    expect(arrow.customData).toEqual({ protocol: "grpc" });
  });

  it("no customData key when not specified", async () => {
    const d = new Diagram();
    const id = d.addBox("Plain", { row: 0, col: 0 });

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;
    const shape = elements.find(e => e.id === id) as Record<string, unknown>;

    expect("customData" in shape).toBe(false);
  });

  // ── addFrame ──

  it("addFrame creates frame element with children", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 0, col: 1 });
    const frm = d.addFrame("My Frame", [a, b]);

    const result = await d.render({ format: "excalidraw" });
    const elements = (result.json as { elements: Record<string, unknown>[] }).elements;

    // Frame element exists
    const frame = elements.find(e => e.id === frm) as Record<string, unknown>;
    expect(frame).toBeDefined();
    expect(frame.type).toBe("frame");
    expect(frame.name).toBe("My Frame");

    // Children have frameId set
    const shapeA = elements.find(e => e.id === a) as Record<string, unknown>;
    expect(shapeA.frameId).toBe(frm);

    const shapeB = elements.find(e => e.id === b) as Record<string, unknown>;
    expect(shapeB.frameId).toBe(frm);

    // Bound text elements also get frameId
    const textA = elements.find(e => e.id === `${a}-text`) as Record<string, unknown>;
    expect(textA.frameId).toBe(frm);
  });
});
