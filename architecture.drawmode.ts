
const d = new Diagram();

const llm = d.addEllipse("LLM\n(Claude, etc.)", { row: 0, col: 1, color: "ai" });
const mcp = d.addBox("MCP Server\n(index.ts)", { row: 1, col: 1, color: "orchestration" });
const exec = d.addBox("Executor\n(new Function)", { row: 2, col: 1, color: "backend" });
const sdk = d.addBox("Diagram SDK\n(sdk.ts)", { row: 3, col: 1, color: "backend" });

// Helpers flanking SDK (no edges — internal to SDK)
const graphviz = d.addBox("Graphviz WASM\n(layout)", { row: 3, col: 0, color: "database" });
const zigwasm = d.addBox("Zig WASM\n(validate)", { row: 3, col: 2, color: "storage" });

// Outputs
const urlOut = d.addBox("excalidraw.com\nURL", { row: 4, col: 0, color: "frontend" });
const fileOut = d.addBox(".excalidraw +\n.drawmode.ts", { row: 4, col: 1, color: "frontend" });
const pngOut = d.addBox("PNG / SVG\nfile", { row: 4, col: 2, color: "frontend" });

d.connect(llm, mcp, "draw tool");
d.connect(mcp, exec, "code");
d.connect(exec, sdk, "Diagram API");
d.connect(sdk, urlOut, "upload");
d.connect(sdk, fileOut, "write");
d.connect(sdk, pngOut, "render");

d.addGroup("Core", [exec, sdk, graphviz, zigwasm]);
d.addGroup("Outputs", [urlOut, fileOut, pngOut]);

return d.render({ format: ["excalidraw", "png", "svg"], path: "architecture.excalidraw" });
