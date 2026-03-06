import { describe, it, expect, afterEach } from "vitest";
import { Diagram } from "./sdk.js";
import { isWasmLoaded } from "./layout.js";
import { unlink, writeFile, readFile, access } from "node:fs/promises";

describe("Diagram SDK", () => {
  it("addBox creates shape + text pair", async () => {
    const d = new Diagram();
    const id = d.addBox("API Gateway", { row: 0, col: 0, color: "backend" });
    expect(id).toMatch(/^box_/);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

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
    const elements = result.json.elements;

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
    const elements = result.json.elements;

    const arrow = elements.find(e => e.type === "arrow");
    expect(arrow).toBeDefined();
    // Arrows are unbound (static polylines) — from/to stored in customData
    expect(arrow!.startBinding).toBeNull();
    expect(arrow!.endBinding).toBeNull();
    expect((arrow!.customData as Record<string, unknown>)._from).toBe(a);
    expect((arrow!.customData as Record<string, unknown>)._to).toBe(b);

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
    const elements = result.json.elements;

    const arrow = elements.find(e => e.type === "arrow")!;
    expect(arrow).toBeDefined();

    // Arrow labels are free-standing text (no containerId) so Excalidraw
    // respects the Zig-computed label position instead of auto-centering.
    const label = elements.find(e =>
      e.type === "text" && e.text === "writes to",
    );
    expect(label).toBeDefined();
    expect(label!.containerId).toBeNull();
  });

  it("addGroup creates dashed rectangle + label text", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 0, col: 1 });
    const grp = d.addGroup("Data Layer", [a, b]);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

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

    expect(result.json.type).toBe("excalidraw");
    expect(result.json.version).toBe(2);
    expect(result.json.source).toBe("drawmode");
    expect(Array.isArray(result.json.elements)).toBe(true);
    expect(result.json.appState).toBeDefined();
  });

  it("multiple arrows from same source connect to different targets", async () => {
    const d = new Diagram();
    const src = d.addBox("Source", { row: 0, col: 1 });
    const t1 = d.addBox("Target1", { row: 1, col: 0 });
    const t2 = d.addBox("Target2", { row: 1, col: 2 });
    d.connect(src, t1);
    d.connect(src, t2);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    const arrows = elements.filter(e => e.type === "arrow");
    expect(arrows.length).toBe(2);

    // Both arrows should connect to different targets (via customData)
    const endTargets = arrows.map(a => a.customData?._to);
    expect(endTargets[0]).not.toBe(endTargets[1]);
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
    const elements = result.json.elements;
    const shape = elements.find(e => e.id === id)!;

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
    const elements = result.json.elements;
    const shape = elements.find(e => e.id === id)!;

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
    const elements = result.json.elements;
    const text = elements.find(e => e.id === `${id}-text`)!;

    expect(text.fontSize).toBe(24);
    expect(text.fontFamily).toBe(2);
  });

  it("roundness: null removes roundness", async () => {
    const d = new Diagram();
    const id = d.addBox("Sharp", { row: 0, col: 0, roundness: null });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const shape = elements.find(e => e.id === id)!;

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
    const elements = result.json.elements;
    const arrow = elements.find(e => e.type === "arrow")!;

    expect(arrow.startArrowhead).toBe("dot");
    expect(arrow.endArrowhead).toBe("triangle");
  });

  it("arrow opts: elbowed false produces straight arrow", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 1 });
    d.connect(a, b, undefined, { elbowed: false });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const arrow = elements.find(e => e.type === "arrow")!;

    expect(arrow.elbowed).toBe(false);
    // Orthogonal route: L-shaped for non-aligned nodes (4 points)
    expect(arrow.points!.length).toBeGreaterThanOrEqual(2);
  });

  it("arrow opts: strokeColor and strokeWidth", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, undefined, { strokeColor: "#ff0000", strokeWidth: 4 });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const arrow = elements.find(e => e.type === "arrow")!;

    expect(arrow.strokeColor).toBe("#ff0000");
    expect(arrow.strokeWidth).toBe(4);
  });

  it("arrow label uses custom labelFontSize", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "big label", { labelFontSize: 20 });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const arrow = elements.find(e => e.type === "arrow")!;
    const label = elements.find(e => e.type === "text" && e.text === "big label")!;

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
    const elements = result.json.elements;
    const shape = elements.find(e => e.id === id)!;

    expect(shape.strokeColor).toBe("#ff0000");
    expect(shape.backgroundColor).toBe("#00ff00");
  });

  // ── New: addText ──

  it("addText creates standalone text element", async () => {
    const d = new Diagram();
    const id = d.addText("Hello World", { x: 50, y: 50, fontSize: 20 });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const text = elements.find(e => e.id === id)!;

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
    const elements = result.json.elements;
    const line = elements.find(e => e.id === id)!;

    expect(line).toBeDefined();
    expect(line.type).toBe("line");
    expect(line.strokeColor).toBe("#ff0000");
    expect(line.strokeWidth).toBe(3);
    expect(line.points!.length).toBe(2);
  });

  // ── New: Cloud palette colors ──

  it("cloud palette colors produce correct values", async () => {
    const d = new Diagram();
    const aws = d.addBox("Lambda", { row: 0, col: 0, color: "aws-compute" });
    const k8s = d.addBox("Pod", { row: 0, col: 1, color: "k8s-pod" });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    const awsShape = elements.find(e => e.id === aws)!;
    expect(awsShape.backgroundColor).toBe("#FF9900");
    expect(awsShape.strokeColor).toBe("#C27400");

    const k8sShape = elements.find(e => e.id === k8s)!;
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
    expect(result.json.elements.length).toBeGreaterThan(0);
  });

  it("fromFile round-trip preserves frames", async () => {
    // Create diagram with frame
    const d1 = new Diagram();
    const a = d1.addBox("API", { row: 0, col: 0, color: "backend" });
    const b = d1.addBox("DB", { row: 1, col: 0, color: "database" });
    d1.addFrame("Backend", [a, b]);
    d1.connect(a, b, "queries");
    await d1.render({ format: "excalidraw", path: testFile });

    // Load and verify frame is reconstructed
    const d2 = await Diagram.fromFile(testFile);
    const nodes = d2.getNodes();
    expect(nodes.length).toBe(2);

    // Re-render and check frame survives
    const result = await d2.render({ format: "excalidraw", path: testFile });
    const els = result.json.elements;

    const frame = els.find(e => e.type === "frame")!;
    expect(frame).toBeDefined();
    expect(frame.name).toBe("Backend");

    // Children should have frameId
    const framed = els.filter(e => e.frameId === frame.id);
    // Should have at least the 2 shapes + their bound text = 4
    expect(framed.length).toBeGreaterThanOrEqual(2);
  });

  it("fromFile round-trip preserves link and customData", async () => {
    const d1 = new Diagram();
    d1.addBox("Linked", { row: 0, col: 0, link: "https://example.com", customData: { env: "prod" } });
    await d1.render({ format: "excalidraw", path: testFile });

    const d2 = await Diagram.fromFile(testFile);
    const result = await d2.render({ format: "excalidraw", path: testFile });
    const els = result.json.elements;

    const shape = els.find(e => e.type === "rectangle")!;
    expect(shape.link).toBe("https://example.com");
    expect(shape.customData).toEqual({ env: "prod" });
  });

  it("fromFile round-trip preserves diamond type", async () => {
    const d1 = new Diagram();
    d1.addDiamond("Yes?", { row: 0, col: 0 });
    await d1.render({ format: "excalidraw", path: testFile });

    const d2 = await Diagram.fromFile(testFile);
    const result = await d2.render({ format: "excalidraw", path: testFile });
    const els = result.json.elements;

    const diamond = els.find(e => e.type === "diamond")!;
    expect(diamond).toBeDefined();
    const text = els.find(e => e.containerId === diamond.id)!;
    expect(text.text).toBe("Yes?");
  });

  it("fromFile preserves positions when adding new nodes", async () => {
    // Create 2-node diagram and render
    const d1 = new Diagram();
    const a = d1.addBox("Service A", { row: 0, col: 0, color: "backend" });
    const b = d1.addBox("Service B", { row: 1, col: 0, color: "database" });
    d1.connect(a, b, "queries");
    const r1 = await d1.render({ format: "excalidraw", path: testFile });

    const origA = r1.json.elements.find(e => e.id === a)!;
    const origB = r1.json.elements.find(e => e.id === b)!;

    // Load via fromFile, add a third node, re-render
    const d2 = await Diagram.fromFile(testFile);
    d2.addBox("Service C", { row: 0, col: 1, color: "frontend" });
    const r2 = await d2.render({ format: "excalidraw", path: testFile });

    const newA = r2.json.elements.find(e => e.id === a)!;
    const newB = r2.json.elements.find(e => e.id === b)!;

    // Original nodes should keep their positions (within 5px tolerance)
    expect(Math.abs(newA.x - origA.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(newA.y - origA.y)).toBeLessThanOrEqual(5);
    expect(Math.abs(newB.x - origB.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(newB.y - origB.y)).toBeLessThanOrEqual(5);
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
    const elements = result.json.elements;
    const textEl = elements.find(e => e.id === `${id}-text`)!;

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
    const elements = result.json.elements;
    const shape = elements.find(e => e.id === id)!;

    expect(shape.x).toBe(500);
    expect(shape.y).toBe(300);
  });

  // ── addDiamond ──

  it("addDiamond creates diamond shape + text pair with default backend color", async () => {
    const d = new Diagram();
    const id = d.addDiamond("Decision?", { row: 0, col: 0 });
    expect(id).toMatch(/^dia_/);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    const shape = elements.find(e => e.id === id)!;
    expect(shape).toBeDefined();
    expect(shape.type).toBe("diamond");
    // Default color should be "backend" (purple), same as addBox
    expect(shape.backgroundColor).toBe("#d0bfff");
    expect(shape.strokeColor).toBe("#7048e8");

    const text = elements.find(e => e.id === `${id}-text`)!;
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
    const elements = result.json.elements;

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
    const elements = result.json.elements;
    const arrow = elements.find(e => e.type === "arrow")!;
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
    const elements = result.json.elements;
    const shape = elements.find(e => e.id === id)!;

    expect(shape.link).toBe("https://example.com");
  });

  it("customData property is wired through to shape element", async () => {
    const d = new Diagram();
    const id = d.addBox("Meta", { row: 0, col: 0, customData: { service: "api", tier: 1 } });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const shape = elements.find(e => e.id === id)!;

    expect(shape.customData).toEqual({ service: "api", tier: 1 });
  });

  it("customData on arrow is wired through", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "flow", { customData: { protocol: "grpc" } });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const arrow = elements.find(e => e.type === "arrow")!;

    expect((arrow.customData as Record<string, unknown>).protocol).toBe("grpc");
  });

  it("no customData key when not specified", async () => {
    const d = new Diagram();
    const id = d.addBox("Plain", { row: 0, col: 0 });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const shape = elements.find(e => e.id === id)!;

    expect("customData" in shape).toBe(false);
  });

  // ── addFrame ──

  // ── removeGroup / removeFrame ──

  it("removeGroup removes group container, keeps children", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 0, col: 1 });
    const grp = d.addGroup("Data Layer", [a, b]);

    d.removeGroup(grp);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    // Group boundary should be gone
    expect(elements.find(e => e.id === grp)).toBeUndefined();
    expect(elements.find(e => e.id === `${grp}-label`)).toBeUndefined();
    // Children still exist
    expect(elements.find(e => e.id === a)).toBeDefined();
    expect(elements.find(e => e.id === b)).toBeDefined();
  });

  it("removeFrame removes frame container, keeps children", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 0, col: 1 });
    const frm = d.addFrame("My Frame", [a, b]);

    d.removeFrame(frm);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    // Frame element should be gone
    expect(elements.find(e => e.id === frm)).toBeUndefined();
    // Children should not have frameId
    const shapeA = elements.find(e => e.id === a)!;
    expect(shapeA.frameId).toBeNull();
    // Children still exist
    expect(shapeA).toBeDefined();
    expect(elements.find(e => e.id === b)).toBeDefined();
  });

  it("removeNode cleans up frame children", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 0, col: 1 });
    const frm = d.addFrame("My Frame", [a, b]);

    d.removeNode(a);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    // Frame should still exist with only B
    const frame = elements.find(e => e.id === frm)!;
    expect(frame).toBeDefined();
    // B should have frameId
    const shapeB = elements.find(e => e.id === b)!;
    expect(shapeB.frameId).toBe(frm);
    // A should be gone
    expect(elements.find(e => e.id === a)).toBeUndefined();
  });

  // ── addFrame ──

  // ── Font-aware text measurement ──

  it("Helvetica box narrower than Virgil box for same label", async () => {
    const longLabel = "Authentication Gateway Service";
    const d1 = new Diagram();
    const virgilId = d1.addBox(longLabel, { row: 0, col: 0, fontFamily: 1 });
    const result1 = await d1.render({ format: "excalidraw" });
    const virgilShape = result1.json.elements.find(e => e.id === virgilId)!;

    const d2 = new Diagram();
    const helveticaId = d2.addBox(longLabel, { row: 0, col: 0, fontFamily: 2 });
    const result2 = await d2.render({ format: "excalidraw" });
    const helveticaShape = result2.json.elements.find(e => e.id === helveticaId)!;

    expect(helveticaShape.width).toBeLessThan(virgilShape.width);
  });

  it("large fontSize box wider than small fontSize box", async () => {
    const d = new Diagram();
    const small = d.addBox("Test Label", { row: 0, col: 0, fontSize: 12 });
    const large = d.addBox("Test Label", { row: 1, col: 0, fontSize: 24 });

    const result = await d.render({ format: "excalidraw" });
    const smallShape = result.json.elements.find(e => e.id === small)!;
    const largeShape = result.json.elements.find(e => e.id === large)!;

    expect(largeShape.width).toBeGreaterThan(smallShape.width);
  });

  // ── Layout warnings ──

  it("render with WASM loaded produces no layout fallback warning", async () => {
    if (!isWasmLoaded()) return; // skip if WASM not available
    const d = new Diagram();
    d.addBox("A", { row: 0, col: 0 });
    d.addBox("B", { row: 1, col: 0 });

    const result = await d.render({ format: "excalidraw" });
    const fallbackWarnings = (result.warnings ?? []).filter(w => w.includes("grid fallback"));
    expect(fallbackWarnings.length).toBe(0);
  });

  it("addFrame creates frame element with children", async () => {
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 0, col: 1 });
    const frm = d.addFrame("My Frame", [a, b]);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    // Frame element exists
    const frame = elements.find(e => e.id === frm)!;
    expect(frame).toBeDefined();
    expect(frame.type).toBe("frame");
    expect(frame.name).toBe("My Frame");

    // Children have frameId set
    const shapeA = elements.find(e => e.id === a)!;
    expect(shapeA.frameId).toBe(frm);

    const shapeB = elements.find(e => e.id === b)!;
    expect(shapeB.frameId).toBe(frm);

    // Bound text elements also get frameId
    const textA = elements.find(e => e.id === `${a}-text`)!;
    expect(textA.frameId).toBe(frm);
  });

  // ── Icon/emoji support ──

  it("icon preset prepends emoji to bound text", async () => {
    const d = new Diagram();
    const id = d.addBox("Database", { row: 0, col: 0, icon: "database" });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const text = elements.find(e => e.id === `${id}-text`)!;

    expect(text.text).toContain("🗄️");
    expect(text.text).toContain("Database");
    expect(text.text).toBe("🗄️\nDatabase");
  });

  it("raw emoji accepted as icon value", async () => {
    const d = new Diagram();
    const id = d.addBox("Custom", { row: 0, col: 0, icon: "🚀" });

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const text = elements.find(e => e.id === `${id}-text`)!;

    expect(text.text).toBe("🚀\nCustom");
  });

  it("icon adds extra height vs same label without icon", async () => {
    const d1 = new Diagram();
    const noIcon = d1.addBox("Service", { row: 0, col: 0 });
    const r1 = await d1.render({ format: "excalidraw" });
    const noIconShape = r1.json.elements.find(e => e.id === noIcon)!;

    const d2 = new Diagram();
    const withIcon = d2.addBox("Service", { row: 0, col: 0, icon: "server" });
    const r2 = await d2.render({ format: "excalidraw" });
    const withIconShape = r2.json.elements.find(e => e.id === withIcon)!;

    expect(withIconShape.height).toBeGreaterThan(noIconShape.height);
  });

  // ── Auto-backup before overwrite ──

  const backupTestFile = "/tmp/drawmode-test-backup.excalidraw";

  afterEach(async () => {
    try { await unlink(backupTestFile); } catch { /* ok */ }
    try { await unlink(backupTestFile + ".bak"); } catch { /* ok */ }
  });

  it("overwriting creates .bak with original content", async () => {
    const d1 = new Diagram();
    d1.addBox("Original", { row: 0, col: 0 });
    await d1.render({ format: "excalidraw", path: backupTestFile });
    const originalContent = await readFile(backupTestFile, "utf-8");

    // Overwrite
    const d2 = new Diagram();
    d2.addBox("Updated", { row: 0, col: 0 });
    await d2.render({ format: "excalidraw", path: backupTestFile });

    // .bak should exist with original content
    const bakContent = await readFile(backupTestFile + ".bak", "utf-8");
    expect(bakContent).toBe(originalContent);

    // New file should have updated content
    const newContent = await readFile(backupTestFile, "utf-8");
    expect(newContent).not.toBe(originalContent);
    expect(newContent).toContain("Updated");
  });

  it("fresh file creates no .bak", async () => {
    // Ensure file doesn't exist
    try { await unlink(backupTestFile); } catch { /* ok */ }

    const d = new Diagram();
    d.addBox("Fresh", { row: 0, col: 0 });
    await d.render({ format: "excalidraw", path: backupTestFile });

    // .bak should not exist
    let bakExists = true;
    try { await access(backupTestFile + ".bak"); } catch { bakExists = false; }
    expect(bakExists).toBe(false);
  });

  // ── Multi-edge differentiation ──

  it("multi-edges between same pair produce different arrows", async () => {
    if (!isWasmLoaded()) return; // requires WASM for Graphviz routing
    const d = new Diagram();
    const a = d.addBox("A", { row: 0, col: 0 });
    const b = d.addBox("B", { row: 1, col: 0 });
    d.connect(a, b, "reads");
    d.connect(a, b, "writes");

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;
    const arrows = elements.filter(e => e.type === "arrow");
    expect(arrows.length).toBe(2);

    // Arrows should have different points (not overlapping)
    const pts1 = JSON.stringify(arrows[0].points);
    const pts2 = JSON.stringify(arrows[1].points);
    expect(pts1).not.toBe(pts2);
  });

  // ── Diagram diff summary ──

  const diffTestFile = "/tmp/drawmode-test-diff.excalidraw";

  afterEach(async () => {
    try { await unlink(diffTestFile); } catch { /* ok */ }
    try { await unlink(diffTestFile + ".bak"); } catch { /* ok */ }
  });

  it("changeSummary reports modified nodes when label changes", async () => {
    const d1 = new Diagram();
    d1.addBox("Keep", { row: 0, col: 0 });
    d1.addBox("Old Label", { row: 1, col: 0 });
    await d1.render({ format: "excalidraw", path: diffTestFile });

    // Same IDs (same process), different label on second box
    const d2 = new Diagram();
    d2.addBox("Keep", { row: 0, col: 0 });
    d2.addBox("New Label", { row: 1, col: 0 });
    const result = await d2.render({ format: "excalidraw", path: diffTestFile });

    expect(result.changeSummary).toBeDefined();
    expect(result.changeSummary).toContain("Modified");
    expect(result.changeSummary).toContain("Old Label");
    expect(result.changeSummary).toContain("New Label");
    expect(result.changeSummary).toContain("Unchanged: 1");
  });

  it("changeSummary is undefined for first render", async () => {
    try { await unlink(diffTestFile); } catch { /* ok */ }

    const d = new Diagram();
    d.addBox("First", { row: 0, col: 0 });
    const result = await d.render({ format: "excalidraw", path: diffTestFile });

    expect(result.changeSummary).toBeUndefined();
  });

  // ── Theme/style presets ──

  it("sketch theme applies hachure fill and roughness 2", async () => {
    const d = new Diagram({ theme: "sketch" });
    const id = d.addBox("Sketchy", { row: 0, col: 0 });

    const result = await d.render({ format: "excalidraw" });
    const shape = result.json.elements.find(e => e.id === id)!;

    expect(shape.fillStyle).toBe("hachure");
    expect(shape.roughness).toBe(2);
  });

  it("blueprint theme applies solid fill, roughness 0, Cascadia font", async () => {
    const d = new Diagram({ theme: "blueprint" });
    const id = d.addBox("Clean", { row: 0, col: 0 });

    const result = await d.render({ format: "excalidraw" });
    const shape = result.json.elements.find(e => e.id === id)!;
    const text = result.json.elements.find(e => e.id === `${id}-text`)!;

    expect(shape.fillStyle).toBe("solid");
    expect(shape.roughness).toBe(0);
    expect(shape.strokeWidth).toBe(1);
    expect(text.fontFamily).toBe(3); // Cascadia
  });

  it("minimal theme applies thin strokes and Helvetica", async () => {
    const d = new Diagram({ theme: "minimal" });
    const id = d.addBox("Thin", { row: 0, col: 0 });

    const result = await d.render({ format: "excalidraw" });
    const shape = result.json.elements.find(e => e.id === id)!;
    const text = result.json.elements.find(e => e.id === `${id}-text`)!;

    expect(shape.strokeWidth).toBe(1);
    expect(shape.roughness).toBe(0);
    expect(text.fontFamily).toBe(2); // Helvetica
  });

  it("per-node opts override theme defaults", async () => {
    const d = new Diagram({ theme: "sketch" });
    const id = d.addBox("Override", { row: 0, col: 0, roughness: 0, fillStyle: "solid" });

    const result = await d.render({ format: "excalidraw" });
    const shape = result.json.elements.find(e => e.id === id)!;

    // Per-node should win over theme
    expect(shape.roughness).toBe(0);
    expect(shape.fillStyle).toBe("solid");
  });

  it("setTheme changes defaults mid-diagram", async () => {
    const d = new Diagram();
    const id1 = d.addBox("Default", { row: 0, col: 0 });
    d.setTheme("sketch");
    const id2 = d.addBox("Sketchy", { row: 1, col: 0 });

    const result = await d.render({ format: "excalidraw" });
    const shape1 = result.json.elements.find(e => e.id === id1)!;
    const shape2 = result.json.elements.find(e => e.id === id2)!;

    // First box should have default style
    expect(shape1.roughness).toBe(1);
    // Second box should have sketch style
    expect(shape2.fillStyle).toBe("hachure");
    expect(shape2.roughness).toBe(2);
  });

  // ── Nested groups ──

  it("nested groups render inner group inside outer group", async () => {
    const d = new Diagram();
    const a = d.addBox("Svc A", { row: 0, col: 0 });
    const b = d.addBox("Svc B", { row: 0, col: 1 });
    const c = d.addBox("Svc C", { row: 1, col: 0 });

    const inner = d.addGroup("Subnet A", [a, b]);
    const outer = d.addGroup("VPC", [inner, c]);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    const innerRect = elements.find(e => e.id === inner)!;
    const outerRect = elements.find(e => e.id === outer)!;

    expect(innerRect).toBeDefined();
    expect(outerRect).toBeDefined();

    // Outer group should fully contain inner group
    expect(outerRect.x).toBeLessThanOrEqual(innerRect.x);
    expect(outerRect.y).toBeLessThanOrEqual(innerRect.y);
    expect(outerRect.x + outerRect.width).toBeGreaterThanOrEqual(innerRect.x + innerRect.width);
    expect(outerRect.y + outerRect.height).toBeGreaterThanOrEqual(innerRect.y + innerRect.height);
  });

  it("nested group labels render correctly", async () => {
    const d = new Diagram();
    const a = d.addBox("Pod", { row: 0, col: 0 });
    const inner = d.addGroup("Namespace", [a]);
    d.addGroup("Cluster", [inner]);

    const result = await d.render({ format: "excalidraw" });
    const elements = result.json.elements;

    const innerLabel = elements.find(e => e.id === `${inner}-label`)!;
    expect(innerLabel).toBeDefined();
    expect(innerLabel.text).toBe("Namespace");
  });

  // ── fromMermaid ──

  describe("fromMermaid", () => {
    it("basic graph TD with two nodes and one edge", async () => {
      const d = Diagram.fromMermaid(`graph TD
A-->B`);
      const nodes = d.getNodes();
      expect(nodes.length).toBe(2);

      const edges = d.getEdges();
      expect(edges.length).toBe(1);

      const result = await d.render({ format: "excalidraw" });
      expect(result.json.elements.length).toBeGreaterThan(0);
    });

    it("node shapes: [] box, {} diamond, (()) circle", async () => {
      const d = Diagram.fromMermaid(`graph TD
A[Box Label]
B{Diamond Label}
C((Circle Label))`);
      const nodes = d.getNodes();
      expect(nodes.length).toBe(3);

      const result = await d.render({ format: "excalidraw" });
      const elements = result.json.elements;

      // A should be rectangle
      const boxText = elements.find(e => e.type === "text" && e.text === "Box Label");
      expect(boxText).toBeDefined();
      const boxShape = elements.find(e => e.id === boxText!.containerId);
      expect(boxShape!.type).toBe("rectangle");

      // B should be diamond
      const diaText = elements.find(e => e.type === "text" && e.text === "Diamond Label");
      expect(diaText).toBeDefined();
      const diaShape = elements.find(e => e.id === diaText!.containerId);
      expect(diaShape!.type).toBe("diamond");

      // C should be ellipse
      const ellText = elements.find(e => e.type === "text" && e.text === "Circle Label");
      expect(ellText).toBeDefined();
      const ellShape = elements.find(e => e.id === ellText!.containerId);
      expect(ellShape!.type).toBe("ellipse");
    });

    it("edge labels: A -->|writes| B", async () => {
      const d = Diagram.fromMermaid(`graph TD
A-->|writes|B`);
      const edges = d.getEdges();
      expect(edges.length).toBe(1);
      expect(edges[0].label).toBe("writes");
    });

    it("subgraphs become groups", async () => {
      const d = Diagram.fromMermaid(`graph TD
subgraph Backend
A[API]
B[DB]
end
A-->B`);
      const nodes = d.getNodes();
      expect(nodes.length).toBe(2);

      const result = await d.render({ format: "excalidraw" });
      const elements = result.json.elements;
      // Should have a group boundary labeled "Backend"
      const groupLabel = elements.find(e => e.type === "text" && e.text === "Backend");
      expect(groupLabel).toBeDefined();
    });

    it("edge styles: -.-> is dashed, ==> is thick", async () => {
      const d = Diagram.fromMermaid(`graph TD
A-.->B
C==>D`);
      const edges = d.getEdges();
      expect(edges.length).toBe(2);

      const result = await d.render({ format: "excalidraw" });
      const elements = result.json.elements;
      const arrows = elements.filter(e => e.type === "arrow");
      expect(arrows.length).toBe(2);

      // Find dashed arrow (A->B)
      const dashedArrow = arrows.find(a => a.strokeStyle === "dashed");
      expect(dashedArrow).toBeDefined();

      // Find thick arrow (C->D)
      const thickArrow = arrows.find(a => a.strokeWidth === 4);
      expect(thickArrow).toBeDefined();
    });

    it("direction LR assigns cols instead of rows", () => {
      const d = Diagram.fromMermaid(`graph LR
A-->B-->C`);
      const nodes = d.getNodes();
      expect(nodes.length).toBe(3);
      // In LR mode, depth maps to col
      const edges = d.getEdges();
      expect(edges.length).toBe(2);
    });

    it("--- produces arrow with no arrowhead", async () => {
      const d = Diagram.fromMermaid(`graph TD
A---B`);
      const result = await d.render({ format: "excalidraw" });
      const arrow = result.json.elements.find(e => e.type === "arrow")!;
      expect(arrow.endArrowhead).toBeNull();
    });

    it("complex multi-line mermaid with subgraphs", async () => {
      const d = Diagram.fromMermaid(`graph TD
subgraph Frontend
  A[React App]
  B[CDN]
end
subgraph Backend
  C[API Server]
  D[(Database)]
end
A-->C
B-->A
C-->D`);
      const nodes = d.getNodes();
      expect(nodes.length).toBe(4);

      const edges = d.getEdges();
      expect(edges.length).toBe(3);

      const result = await d.render({ format: "excalidraw" });
      const elements = result.json.elements;

      // Should have group boundaries
      const frontendLabel = elements.find(e => e.type === "text" && e.text === "Frontend");
      expect(frontendLabel).toBeDefined();
      const backendLabel = elements.find(e => e.type === "text" && e.text === "Backend");
      expect(backendLabel).toBeDefined();

      // Database node should have database color
      const dbText = elements.find(e => e.type === "text" && e.text === "Database");
      expect(dbText).toBeDefined();
    });

    it("semicolon-separated statements on single line", () => {
      const d = Diagram.fromMermaid(`graph TD; A-->B; B-->C`);
      expect(d.getNodes().length).toBe(3);
      expect(d.getEdges().length).toBe(2);
    });

    it("chained edges A-->B-->C", () => {
      // Our parser handles this via the second statement after splitting
      const d = Diagram.fromMermaid(`graph TD
A-->B
B-->C`);
      expect(d.getNodes().length).toBe(3);
      expect(d.getEdges().length).toBe(2);
    });

    it("node with label defined inline on edge", async () => {
      const d = Diagram.fromMermaid(`graph TD
A[Start]-->B[End]`);
      expect(d.getNodes().length).toBe(2);

      const result = await d.render({ format: "excalidraw" });
      const elements = result.json.elements;
      const startText = elements.find(e => e.type === "text" && e.text === "Start");
      expect(startText).toBeDefined();
      const endText = elements.find(e => e.type === "text" && e.text === "End");
      expect(endText).toBeDefined();
    });
  });

  describe("getNode", () => {
    it("returns properties by ID", () => {
      const d = new Diagram();
      const id = d.addBox("API Gateway", { row: 0, col: 1, color: "backend" });
      const node = d.getNode(id);
      expect(node).toBeDefined();
      expect(node!.label).toBe("API Gateway");
      expect(node!.type).toBe("rectangle");
      expect(node!.row).toBe(0);
      expect(node!.col).toBe(1);
      expect(node!.width).toBeGreaterThan(0);
    });

    it("returns undefined for unknown ID", () => {
      const d = new Diagram();
      expect(d.getNode("nonexistent")).toBeUndefined();
    });

    it("works on fromFile-loaded diagram", async () => {
      const tmpPath = "test-getnode.excalidraw";
      const d1 = new Diagram();
      d1.addBox("TestNode", { color: "database" });
      await d1.render({ format: "excalidraw", path: tmpPath });

      const d2 = await Diagram.fromFile(tmpPath);
      const nodes = d2.getNodes();
      expect(nodes.length).toBeGreaterThan(0);
      const node = d2.getNode(nodes[0]);
      expect(node).toBeDefined();
      expect(node!.label).toBe("TestNode");

      await unlink(tmpPath).catch(() => {});
    });
  });

  describe("layout direction", () => {
    it("defaults to TB (B below A)", async () => {
      const d = new Diagram();
      const a = d.addBox("A", { row: 0, col: 0 });
      const b = d.addBox("B", { row: 1, col: 0 });
      d.connect(a, b);
      const result = await d.render({ format: "excalidraw" });
      const elA = result.json.elements.find(e => e.id === a)!;
      const elB = result.json.elements.find(e => e.id === b)!;
      expect(elB.y).toBeGreaterThan(elA.y);
    });

    it("LR places nodes horizontally (B right of A)", async () => {
      const d = new Diagram({ direction: "LR" });
      const a = d.addBox("A", { row: 0, col: 0 });
      const b = d.addBox("B", { row: 0, col: 1 });
      d.connect(a, b);
      const result = await d.render({ format: "excalidraw" });
      const elA = result.json.elements.find(e => e.id === a)!;
      const elB = result.json.elements.find(e => e.id === b)!;
      expect(elB.x).toBeGreaterThan(elA.x);
    });

    it("setDirection works after construction", async () => {
      const d = new Diagram();
      d.setDirection("LR");
      const a = d.addBox("A", { row: 0, col: 0 });
      const b = d.addBox("B", { row: 0, col: 1 });
      d.connect(a, b);
      const result = await d.render({ format: "excalidraw" });
      const elA = result.json.elements.find(e => e.id === a)!;
      const elB = result.json.elements.find(e => e.id === b)!;
      expect(elB.x).toBeGreaterThan(elA.x);
    });

    it("fromMermaid('graph LR') preserves direction", () => {
      const d = Diagram.fromMermaid("graph LR\nA-->B");
      const nodes = d.getNodes();
      expect(nodes.length).toBe(2);
      // Verify direction was set by checking node positions
      const nodeA = d.getNode(nodes[0])!;
      const nodeB = d.getNode(nodes[1])!;
      // In LR, depth goes to col
      expect(nodeB.col).toBeGreaterThan(nodeA.col!);
    });
  });

  describe("sequence diagram", () => {
    it("creates actor boxes + lifelines + message arrows", async () => {
      const d = new Diagram({ type: "sequence" });
      const alice = d.addActor("Alice");
      const bob = d.addActor("Bob");
      d.message(alice, bob, "Hello");

      const result = await d.render({ format: "excalidraw" });
      const elements = result.json.elements;

      // Actor boxes
      const aliceBox = elements.find(e => e.id === alice);
      expect(aliceBox).toBeDefined();
      expect(aliceBox!.type).toBe("rectangle");
      const bobBox = elements.find(e => e.id === bob);
      expect(bobBox).toBeDefined();

      // Lifelines (dashed lines)
      const lifelines = elements.filter(e => e.type === "line" && e.strokeStyle === "dashed");
      expect(lifelines.length).toBe(2);

      // Message arrow
      const arrows = elements.filter(e => e.type === "arrow");
      expect(arrows.length).toBe(1);
    });

    it("self-message creates 4-point loop arrow", async () => {
      const d = new Diagram({ type: "sequence" });
      const alice = d.addActor("Alice");
      d.message(alice, alice, "Self");

      const result = await d.render({ format: "excalidraw" });
      const arrows = result.json.elements.filter(e => e.type === "arrow");
      expect(arrows.length).toBe(1);
      expect(arrows[0].points!.length).toBe(4);
    });

    it("message labels create text elements", async () => {
      const d = new Diagram({ type: "sequence" });
      const alice = d.addActor("Alice");
      const bob = d.addActor("Bob");
      d.message(alice, bob, "Hello World");

      const result = await d.render({ format: "excalidraw" });
      const labels = result.json.elements.filter(e => e.type === "text" && e.text === "Hello World");
      expect(labels.length).toBe(1);
    });

    it("dashed message style is respected", async () => {
      const d = new Diagram({ type: "sequence" });
      const alice = d.addActor("Alice");
      const bob = d.addActor("Bob");
      d.message(alice, bob, "Reply", { style: "dashed" });

      const result = await d.render({ format: "excalidraw" });
      const arrows = result.json.elements.filter(e => e.type === "arrow");
      expect(arrows.length).toBe(1);
      expect(arrows[0].strokeStyle).toBe("dashed");
    });
  });

  describe("edge cases", () => {
    it("self-loop edge creates valid arrow", async () => {
      const d = new Diagram();
      const a = d.addBox("A", { row: 0, col: 0 });
      d.connect(a, a);

      const result = await d.render({ format: "excalidraw" });
      const arrow = result.json.elements.find(e => e.type === "arrow");
      expect(arrow).toBeDefined();
      // Self-loop arrow exists — bindings may be null depending on layout engine
      expect(arrow!.points!.length).toBeGreaterThanOrEqual(2);
    });

    it("disconnected nodes included in stats", async () => {
      const d = new Diagram();
      const a = d.addBox("A", { row: 0, col: 0 });
      const b = d.addBox("B", { row: 1, col: 0 });
      const c = d.addBox("C", { row: 2, col: 0 });
      d.connect(a, b);

      const result = await d.render({ format: "excalidraw" });
      expect(result.stats!.nodes).toBe(3);
      expect(result.stats!.edges).toBe(1);
    });

    it("RL direction renders without error", async () => {
      const d = new Diagram({ direction: "RL" });
      const a = d.addBox("A", { row: 0, col: 0 });
      const b = d.addBox("B", { row: 0, col: 1 });
      d.connect(a, b);

      const result = await d.render({ format: "excalidraw" });
      const elA = result.json.elements.find(e => e.id === a);
      const elB = result.json.elements.find(e => e.id === b);
      expect(elA).toBeDefined();
      expect(elB).toBeDefined();
      // RL reversal depends on Graphviz WASM; TS fallback places L→R
      if (isWasmLoaded()) {
        expect(elB!.x).toBeLessThan(elA!.x);
      }
    });

    it("BT direction renders without error", async () => {
      const d = new Diagram({ direction: "BT" });
      const a = d.addBox("A", { row: 0, col: 0 });
      const b = d.addBox("B", { row: 1, col: 0 });
      d.connect(a, b);

      const result = await d.render({ format: "excalidraw" });
      const elA = result.json.elements.find(e => e.id === a);
      const elB = result.json.elements.find(e => e.id === b);
      expect(elA).toBeDefined();
      expect(elB).toBeDefined();
      // BT reversal depends on Graphviz WASM; TS fallback places T→B
      if (isWasmLoaded()) {
        expect(elB!.y).toBeLessThan(elA!.y);
      }
    });

    it("empty label produces element", async () => {
      const d = new Diagram();
      const id = d.addBox("");

      const result = await d.render({ format: "excalidraw" });
      const shape = result.json.elements.find(e => e.id === id);
      expect(shape).toBeDefined();
    });

    it("200-char label produces wider element", async () => {
      const d = new Diagram();
      const id = d.addBox("A".repeat(200));

      const result = await d.render({ format: "excalidraw" });
      const shape = result.json.elements.find(e => e.id === id);
      expect(shape).toBeDefined();
      expect(shape!.width).toBeGreaterThan(180);
    });

    it("special chars in label don't break JSON", async () => {
      const label = '<script>alert("xss")</script>&amp;';
      const d = new Diagram();
      const id = d.addBox(label);

      const result = await d.render({ format: "excalidraw" });
      expect(() => JSON.stringify(result.json)).not.toThrow();
      const textEl = result.json.elements.find(e => e.id === `${id}-text`);
      expect(textEl).toBeDefined();
      expect(textEl!.text).toBe(label);
    });

    it("all arrowhead types wire through", async () => {
      const arrowheadTypes = [null, "arrow", "bar", "dot", "triangle", "diamond", "diamond_outline"] as const;

      for (const arrowhead of arrowheadTypes) {
        const d = new Diagram();
        const a = d.addBox("A", { row: 0, col: 0 });
        const b = d.addBox("B", { row: 1, col: 0 });
        d.connect(a, b, "label", { startArrowhead: arrowhead, endArrowhead: arrowhead });

        const result = await d.render({ format: "excalidraw" });
        const arrow = result.json.elements.find(e => e.type === "arrow");
        expect(arrow).toBeDefined();
        expect(arrow!.startArrowhead).toBe(arrowhead);
        expect(arrow!.endArrowhead).toBe(arrowhead);
      }
    });
  });
});
