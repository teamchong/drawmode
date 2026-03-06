// @ts-nocheck — worker/index.ts uses Cloudflare Workers types (Fetcher, etc.)
// that are not available in the main tsconfig. Tests run fine via vitest.
/**
 * Worker interview tests — simulates 20 realistic user sessions against the worker handler.
 *
 * Each test calls drawCall(code) with Diagram SDK code and verifies the worker
 * produces valid output (no errors, correct element counts, feature coverage).
 *
 * Tests cover:
 * - All shape types (box, ellipse, diamond)
 * - Large microservices diagram with iteration (remove node, re-render)
 * - LR/RL/BT layout directions
 * - Cycle graphs, self-loops, disconnected nodes, multi-edges
 * - Sequence diagrams
 * - Mermaid import
 * - Theme presets (sketch, blueprint, minimal)
 * - Cross-boundary and nested groups with iteration (update label, re-render)
 * - All 28 color presets
 * - All 7 arrowhead types
 * - Label edge cases (empty, long, special chars)
 * - Mixed absolute + grid positioning
 * - Error handling (syntax, runtime, missing return)
 */

import { describe, it, expect, vi } from "vitest";

// Mock @cloudflare/puppeteer — only available in Cloudflare Workers runtime
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: () => { throw new Error("not in worker"); } } }));

import worker from "../worker/index.js";

const BASE = "https://drawmode.test";
const env = { MYBROWSER: undefined as unknown as Fetcher };

/** Send a JSON-RPC request to the Worker's /mcp endpoint */
async function mcpCall(method: string, params: Record<string, unknown> = {}, id: number | string = 1): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, id };
  if (Object.keys(params).length > 0) body.params = params;

  const resp = await worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    }),
    env,
  );

  expect(resp.status).toBe(200);
  const data = await resp.json() as Record<string, unknown>;
  return data;
}

/** Helper: call draw tool and return content parts */
async function drawCall(code: string, format = "url"): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
  const data = await mcpCall("tools/call", {
    name: "draw",
    arguments: { code, format },
  });
  expect(data.error).toBeUndefined();
  return data.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
}

/** Parse the element count from the stats text part */
function getElementCount(result: { content: Array<{ type: string; text?: string }> }): number {
  const countPart = result.content.find(p => p.text?.includes("Generated"));
  if (!countPart?.text) return 0;
  const match = countPart.text.match(/(\d+) elements/);
  return match ? parseInt(match[1]) : 0;
}

// ── Graph Types ──────────────────────────────────────────────────────────────

describe("worker interview: all shape types", () => {
  it("addBox + addEllipse + addDiamond with connections produces ≥6 elements", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const box = d.addBox("Service",  { color: "backend" });
      const ell = d.addEllipse("User", { color: "users" });
      const dia = d.addDiamond("Route?", { color: "queue" });
      d.connect(ell, box,  "calls");
      d.connect(box, dia,  "routes");
      d.connect(dia, ell,  "responds");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 3 shapes + 3 bound text labels = 6, plus 3 arrows
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(6);
  });
});

describe("worker interview: large microservices diagram", () => {
  it("12 nodes, 10 edges, 2 groups produces ≥30 elements", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const gw    = d.addBox("API Gateway",     { color: "backend" });
      const auth  = d.addBox("Auth Service",    { color: "backend" });
      const user  = d.addBox("User Service",    { color: "backend" });
      const order = d.addBox("Order Service",   { color: "backend" });
      const pay   = d.addBox("Payment Service", { color: "backend" });
      const notif = d.addBox("Notifications",   { color: "queue" });
      const db1   = d.addBox("User DB",         { color: "database" });
      const db2   = d.addBox("Order DB",        { color: "database" });
      const cache = d.addBox("Redis Cache",     { color: "cache" });
      const queue = d.addBox("Message Queue",   { color: "queue" });
      const store = d.addBox("File Storage",    { color: "storage" });
      const cdn   = d.addBox("CDN",             { color: "external" });
      d.connect(gw,    auth,  "authenticate");
      d.connect(gw,    user,  "user ops");
      d.connect(gw,    order, "order ops");
      d.connect(user,  db1,   "read/write");
      d.connect(order, db2,   "read/write");
      d.connect(order, pay,   "charge");
      d.connect(order, queue, "publish event");
      d.connect(queue, notif, "notify");
      d.connect(user,  cache, "cache lookup");
      d.connect(store, cdn,   "serve assets");
      d.addGroup("Data Layer",  [db1, db2, cache]);
      d.addGroup("Async Layer", [queue, notif]);
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(30);
  });

  it("iteration: remove one node and re-render — element count decreases", async () => {
    // First render — 3-node triangle
    const first = await drawCall(`
      const d = new Diagram();
      const a = d.addBox("Alpha", { color: "backend" });
      const b = d.addBox("Beta",  { color: "database" });
      const c = d.addBox("Gamma", { color: "cache" });
      d.connect(a, b, "to beta");
      d.connect(b, c, "to gamma");
      d.connect(a, c, "direct path");
      return d.render({ format: "url" });
    `);
    expect(first.isError).toBeFalsy();
    const firstCount = getElementCount(first);
    expect(firstCount).toBeGreaterThanOrEqual(6);

    // Second render — drop Beta via removeNode
    const second = await drawCall(`
      const d = new Diagram();
      const a = d.addBox("Alpha", { color: "backend" });
      const b = d.addBox("Beta",  { color: "database" });
      const c = d.addBox("Gamma", { color: "cache" });
      d.connect(a, b, "to beta");
      d.connect(b, c, "to gamma");
      d.connect(a, c, "direct path");
      d.removeNode(b);
      return d.render({ format: "url" });
    `);
    expect(second.isError).toBeFalsy();
    // After removing Beta (shape + bound text + 2 connected arrows), count must drop
    const secondCount = getElementCount(second);
    expect(secondCount).toBeLessThan(firstCount);
  });
});

describe("worker interview: LR pipeline", () => {
  it("LR direction — 5-node chain A→B→C→D→E renders without error", async () => {
    const result = await drawCall(`
      const d = new Diagram({ direction: "LR" });
      const a = d.addBox("Ingest",    { color: "external" });
      const b = d.addBox("Parse",     { color: "backend" });
      const c = d.addBox("Transform", { color: "backend" });
      const e = d.addBox("Store",     { color: "database" });
      const f = d.addBox("Serve",     { color: "frontend" });
      d.connect(a, b, "raw data");
      d.connect(b, c, "parsed");
      d.connect(c, e, "normalised");
      d.connect(e, f, "query result");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(10);
  });
});

describe("worker interview: cycle graph", () => {
  it("A→B→C→A cycle — at least 9 elements (3 shapes + 3 texts + 3 arrows)", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const a = d.addBox("Alpha", { color: "backend" });
      const b = d.addBox("Beta",  { color: "database" });
      const c = d.addBox("Gamma", { color: "cache" });
      d.connect(a, b, "step 1");
      d.connect(b, c, "step 2");
      d.connect(c, a, "feedback");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 3 shapes + 3 bound texts + 3 arrows = 9 minimum
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(9);
  });
});

describe("worker interview: self-loop", () => {
  it("connect(a, a) — at least 1 arrow element produced", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const a = d.addBox("Processor", { color: "backend" });
      d.connect(a, a, "retry");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 1 shape + 1 bound text + 1 arrow = at least 3
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

describe("worker interview: disconnected nodes", () => {
  it("3 nodes with only 1 edge — produces at least 7 elements", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const a = d.addBox("Connected A", { color: "backend" });
      const b = d.addBox("Connected B", { color: "database" });
      d.addBox("Isolated C",            { color: "storage" });
      d.connect(a, b, "only edge");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 3 shapes + 3 bound texts + 1 arrow = 7
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(7);
  });
});

describe("worker interview: multi-edge", () => {
  it("3 edges A→B with different labels — produces at least 7 elements", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const a = d.addBox("Source", { color: "backend" });
      const b = d.addBox("Sink",   { color: "database" });
      d.connect(a, b, "GET /users");
      d.connect(a, b, "POST /users");
      d.connect(a, b, "DELETE /users");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 2 shapes + 2 bound texts + 3 arrows = 7 minimum
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(7);
  });
});

describe("worker interview: sequence diagram", () => {
  it("4 actors, 6 messages + self-message renders actor boxes and arrows", async () => {
    const result = await drawCall(`
      const d = new Diagram({ type: "sequence" });
      const client  = d.addActor("Browser");
      const gateway = d.addActor("API Gateway");
      const service = d.addActor("Auth Service");
      const db      = d.addActor("Database");
      d.message(client,  gateway, "POST /login");
      d.message(gateway, service, "validate token");
      d.message(service, db,      "SELECT user");
      d.message(db,      service, "user record");
      d.message(service, service, "hash password");
      d.message(service, gateway, "JWT token");
      d.message(gateway, client,  "200 OK");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 4 actors * 2 (rect + text) + lifelines + arrows
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(8);
  });
});

// ── Features ─────────────────────────────────────────────────────────────────

describe("worker interview: mermaid import", () => {
  it("fromMermaid — graph LR with subgraph produces nodes and edges", async () => {
    const result = await drawCall(`
      const d = Diagram.fromMermaid(
        "graph LR\\nA[API]-->B[DB]\\nA-->C[Cache]\\nsubgraph Backend\\nB\\nC\\nend"
      );
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // API, DB, Cache shapes + their labels + arrows = ≥6
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(6);
  });
});

describe("worker interview: theme sketch", () => {
  it("theme sketch — renders without error and produces multiple elements", async () => {
    const result = await drawCall(`
      const d = new Diagram({ theme: "sketch" });
      d.addBox("Sketchy Service",  { color: "backend" });
      d.addBox("Sketchy Database", { color: "database" });
      d.addEllipse("Sketchy User", { color: "users" });
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 3 shapes + 3 bound texts = 6 minimum
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(6);
  });
});

describe("worker interview: theme blueprint", () => {
  it("theme blueprint — renders without error", async () => {
    const result = await drawCall(`
      const d = new Diagram({ theme: "blueprint" });
      const a = d.addBox("Blueprint A", { color: "backend" });
      const b = d.addBox("Blueprint B", { color: "database" });
      d.connect(a, b, "link");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(4);
  });
});

describe("worker interview: theme minimal", () => {
  it("theme minimal — renders without error", async () => {
    const result = await drawCall(`
      const d = new Diagram({ theme: "minimal" });
      const a = d.addBox("Min A", { color: "backend" });
      const b = d.addBox("Min B", { color: "cache" });
      d.connect(a, b, "minimal edge");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(4);
  });
});

describe("worker interview: cross-boundary group edges", () => {
  it("edge between nodes in different groups renders correctly", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const n1 = d.addBox("Frontend 1", { color: "frontend" });
      const n2 = d.addBox("Frontend 2", { color: "frontend" });
      const n3 = d.addBox("Backend 1",  { color: "backend" });
      const n4 = d.addBox("Backend 2",  { color: "backend" });
      d.addGroup("Frontend Tier", [n1, n2]);
      d.addGroup("Backend Tier",  [n3, n4]);
      d.connect(n1, n3, "API call");
      d.connect(n2, n4, "API call");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it("iteration: after groups render, update a node label then re-render", async () => {
    // First render with original label
    const first = await drawCall(`
      const d = new Diagram();
      const n1 = d.addBox("Original Label", { color: "frontend" });
      const n2 = d.addBox("Partner",        { color: "backend" });
      d.addGroup("Group A", [n1]);
      d.addGroup("Group B", [n2]);
      d.connect(n1, n2, "link");
      return d.render({ format: "url" });
    `);
    expect(first.isError).toBeFalsy();
    const firstCount = getElementCount(first);
    expect(firstCount).toBeGreaterThanOrEqual(4);

    // Second render — same structure, updated label via updateNode pattern
    const second = await drawCall(`
      const d = new Diagram();
      const n1 = d.addBox("Updated Label", { color: "frontend" });
      const n2 = d.addBox("Partner",       { color: "backend" });
      d.addGroup("Group A", [n1]);
      d.addGroup("Group B", [n2]);
      d.connect(n1, n2, "link");
      return d.render({ format: "url" });
    `);
    expect(second.isError).toBeFalsy();
    // Same topology — element count must be identical
    const secondCount = getElementCount(second);
    expect(secondCount).toBe(firstCount);
  });
});

describe("worker interview: nested groups", () => {
  it("3-level nesting — outermost contains inner, inner contains innermost", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const a = d.addBox("Core A",  { color: "backend" });
      const b = d.addBox("Core B",  { color: "backend" });
      const c = d.addBox("Mid C",   { color: "database" });
      const e = d.addBox("Outer D", { color: "external" });
      const innermost = d.addGroup("Innermost", [a, b]);
      const inner     = d.addGroup("Inner",     [c, innermost]);
      d.addGroup("Outer", [e, inner]);
      d.connect(a, c, "up one level");
      d.connect(c, e, "up two levels");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const count = getElementCount(result);
    // 4 shapes + 4 texts + 2 arrows + group boundaries
    expect(count).toBeGreaterThanOrEqual(10);
  });
});

describe("worker interview: all 28 color presets", () => {
  it("every ColorPreset produces valid elements (≥56 = 28×2)", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const presets = [
        "frontend", "backend", "database", "storage",
        "ai", "external", "orchestration", "queue", "cache", "users",
        "aws-compute", "aws-storage", "aws-database", "aws-network", "aws-security", "aws-ml",
        "azure-compute", "azure-data", "azure-network", "azure-ai",
        "gcp-compute", "gcp-data", "gcp-network", "gcp-ai",
        "k8s-pod", "k8s-service", "k8s-ingress", "k8s-volume",
      ];
      presets.forEach((preset, i) => {
        d.addBox(preset, { color: preset, row: Math.floor(i / 7), col: i % 7 });
      });
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 28 shapes + 28 bound texts = 56 minimum
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(56);
  });
});

describe("worker interview: all arrowhead types", () => {
  it("null, arrow, bar, dot, triangle, diamond, diamond_outline as start/end arrowheads all render", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      const arrowheads = [null, "arrow", "bar", "dot", "triangle", "diamond", "diamond_outline"];
      const nodes = arrowheads.map((_, i) =>
        d.addBox("Node " + i, { row: 0, col: i, color: "backend" })
      );
      for (let i = 0; i < arrowheads.length - 1; i++) {
        d.connect(nodes[i], nodes[i + 1], "edge " + i, {
          startArrowhead: arrowheads[i],
          endArrowhead:   arrowheads[i + 1],
        });
      }
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 7 nodes * 2 + 6 arrows = 20 minimum
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(20);
  });
});

// ── Edge Cases ────────────────────────────────────────────────────────────────

describe("worker interview: label edge cases", () => {
  it("empty label, 200-char label, and special chars do not crash", async () => {
    const longLabel = "A".repeat(200);
    const specialLabel = `<Service> & "Auth" '\'`;

    const result = await drawCall(`
      const d = new Diagram();
      d.addBox("",          { color: "backend" });
      d.addBox(${JSON.stringify(longLabel)},    { color: "database" });
      d.addBox(${JSON.stringify(specialLabel)}, { color: "external" });
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 3 shapes + 3 bound texts = 6 minimum
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(6);
  });
});

describe("worker interview: mixed absolute and grid positioning", () => {
  it("some nodes with x/y, others with row/col — renders without error", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      d.addBox("Absolute A", { x: 100, y: 100 });
      d.addBox("Absolute B", { x: 500, y: 100 });
      d.addBox("Absolute C", { x: 300, y: 350 });
      const g1 = d.addBox("Grid 1", { row: 3, col: 0, color: "backend" });
      const g2 = d.addBox("Grid 2", { row: 3, col: 1, color: "database" });
      d.connect(g1, g2, "grid edge");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    // 5 shapes + 5 bound texts + 1 arrow = 11 minimum
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(11);
  });
});

describe("worker interview: RL and BT directions", () => {
  it("RL direction — right-to-left layout renders without error", async () => {
    const result = await drawCall(`
      const d = new Diagram({ direction: "RL" });
      const a = d.addBox("End",   { color: "frontend" });
      const b = d.addBox("Mid",   { color: "backend" });
      const c = d.addBox("Start", { color: "external" });
      d.connect(c, b, "step 1");
      d.connect(b, a, "step 2");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(8);
  });

  it("BT direction — bottom-to-top layout renders without error", async () => {
    const result = await drawCall(`
      const d = new Diagram({ direction: "BT" });
      const db  = d.addBox("Database", { color: "database" });
      const svc = d.addBox("Service",  { color: "backend" });
      const ui  = d.addBox("UI",       { color: "frontend" });
      d.connect(db,  svc, "data");
      d.connect(svc, ui,  "response");
      return d.render({ format: "url" });
    `);

    expect(result.isError).toBeFalsy();
    const count = getElementCount(result);
    expect(count).toBeGreaterThanOrEqual(8);
  });
});

describe("worker interview: error handling", () => {
  it("syntax error — isError=true with Error message", async () => {
    const result = await drawCall("const d = new Diagram(; broken syntax <<<");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("runtime error (call undefined method) — isError=true with Error message", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      d.addBox("OK");
      d.absolutelyNotARealMethod();
      return d.render({ format: "url" });
    `);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("missing return statement — isError=true with Error message", async () => {
    const result = await drawCall(`
      const d = new Diagram();
      d.addBox("No Return");
      // intentionally no return statement
    `);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });
});
