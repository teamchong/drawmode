/**
 * LocalExecutor — runs LLM-generated diagram code in the current process.
 *
 * No sandbox needed: the generated code only calls the Diagram SDK which
 * produces JSON. No filesystem, network, or eval risk beyond what the
 * SDK exposes.
 */

import { Diagram } from "./sdk.js";
import type { RenderResult, RenderOpts, ExcalidrawFile } from "./types.js";

const EMPTY_FILE: ExcalidrawFile = { type: "excalidraw", version: 2, elements: [] };

export interface ExecuteResult {
  result: RenderResult;
  error?: string;
}

/**
 * Execute LLM-generated TypeScript code that uses the Diagram SDK.
 * The code receives `Diagram` as a global and must return a `RenderResult`
 * (i.e., call `d.render()`).
 *
 * `formatMap` coerces output formats — e.g. `{ excalidraw: "url" }` forces
 * excalidraw format to url (useful when there's no filesystem).
 */
export async function executeCode(
  code: string,
  renderOpts?: RenderOpts,
  formatMap?: Partial<Record<string, string>>,
): Promise<ExecuteResult> {
  try {
    // Merge sourceCode into renderOpts so render() can write sidecar
    const mergedOpts: RenderOpts = { ...renderOpts, sourceCode: code };

    // Create a per-execution Diagram subclass that merges renderOpts as defaults.
    // This avoids mutating Diagram.prototype which would stack across concurrent requests.
    class ConfiguredDiagram extends Diagram {
      override async render(opts?: RenderOpts): Promise<RenderResult> {
        const merged = { ...mergedOpts, ...opts };
        if (formatMap && typeof merged.format === "string" && merged.format in formatMap) {
          merged.format = formatMap[merged.format] as RenderOpts["format"];
        }
        return super.render(merged);
      }
    }

    const wrappedCode = `
      return (async () => {
        ${code}
      })();
    `;

    const fn = new Function("Diagram", wrappedCode);

    // 60s timeout — prevents infinite loops / stuck awaits from hanging forever
    const TIMEOUT_MS = 60_000;
    const result = await Promise.race([
      fn(ConfiguredDiagram),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
      ),
    ]);

    if (!result || typeof result !== "object") {
      return {
        result: { json: EMPTY_FILE },
        error: "Code did not return a RenderResult. Make sure to return d.render().",
      };
    }

    return { result };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      result: { json: EMPTY_FILE },
      error: message,
    };
  }
}
