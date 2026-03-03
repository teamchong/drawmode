import { describe, it, expect, afterEach } from "vitest";
import { executeCode } from "./executor.js";
import { readFile, unlink } from "node:fs/promises";

describe("executeCode", () => {
  it("valid code returns RenderResult", async () => {
    const code = `
      const d = new Diagram();
      d.addBox("Test", { row: 0, col: 0 });
      return d.render({ format: "excalidraw" });
    `;
    const { result, error } = await executeCode(code);
    expect(error).toBeUndefined();
    expect(result.json).toBeDefined();

    const json = result.json as { type: string; elements: unknown[] };
    expect(json.type).toBe("excalidraw");
    expect(json.elements.length).toBeGreaterThan(0);
  });

  it("syntax error returns error message", async () => {
    const code = `const d = new Diagram(; broken syntax`;
    const { result, error } = await executeCode(code);
    expect(error).toBeDefined();
    expect(error).toMatch(/Unexpected/i);
    expect(result.json).toEqual({});
  });

  it("runtime error returns error message", async () => {
    const code = `
      const d = new Diagram();
      d.nonExistentMethod();
      return d.render();
    `;
    const { result, error } = await executeCode(code);
    expect(error).toBeDefined();
    expect(error).toMatch(/not a function|nonExistentMethod/i);
    expect(result.json).toEqual({});
  });

  it("code not returning result produces error", async () => {
    const code = `
      const d = new Diagram();
      d.addBox("Test");
      // Forgot to return d.render()
    `;
    const { result, error } = await executeCode(code);
    expect(error).toBeDefined();
    expect(error).toContain("did not return");
  });

  it("renderOpts are forwarded as defaults", async () => {
    const code = `
      const d = new Diagram();
      d.addBox("Test", { row: 0, col: 0 });
      return d.render();
    `;
    // Pass renderOpts with format — the code calls render() without opts,
    // but the executor should merge renderOpts as defaults
    const { result, error } = await executeCode(code, { format: "excalidraw" });
    expect(error).toBeUndefined();
    expect(result.json).toBeDefined();
    expect(result.filePath).toBeDefined();
  });

  it("user opts override renderOpts", async () => {
    const code = `
      const d = new Diagram();
      d.addBox("Test", { row: 0, col: 0 });
      return d.render({ format: "excalidraw" });
    `;
    // Even though renderOpts says url, user code says excalidraw — user wins
    const { result, error } = await executeCode(code, { format: "url" });
    expect(error).toBeUndefined();
    // Should have filePath since format=excalidraw writes to file
    expect(result.filePath).toBeDefined();
  });

  // ── New: Sidecar file creation ──

  const sidecarTestFile = "/tmp/drawmode-sidecar-test.excalidraw";
  const sidecarTsFile = "/tmp/drawmode-sidecar-test.drawmode.ts";

  afterEach(async () => {
    try { await unlink(sidecarTestFile); } catch { /* ok */ }
    try { await unlink(sidecarTsFile); } catch { /* ok */ }
  });

  it("executor writes sidecar .drawmode.ts alongside .excalidraw", async () => {
    const code = `
      const d = new Diagram();
      d.addBox("Test", { row: 0, col: 0 });
      return d.render();
    `;

    const { result, error } = await executeCode(code, {
      format: "excalidraw",
      path: sidecarTestFile,
    });

    expect(error).toBeUndefined();
    expect(result.filePath).toBe(sidecarTestFile);

    // Sidecar should exist with the source code
    const sidecar = await readFile(sidecarTsFile, "utf-8");
    expect(sidecar).toContain("d.addBox");
    expect(sidecar).toContain("d.render()");
  });
});
