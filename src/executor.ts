/**
 * LocalExecutor — runs LLM-generated diagram code in the current process.
 *
 * No sandbox needed: the generated code only calls the Diagram SDK which
 * produces JSON. No filesystem, network, or eval risk beyond what the
 * SDK exposes.
 */

import { Diagram } from "./sdk.js";
import type { RenderResult, RenderOpts } from "./types.js";

export interface ExecuteResult {
  result: RenderResult;
  error?: string;
}

/**
 * Execute LLM-generated TypeScript code that uses the Diagram SDK.
 * The code receives `Diagram` as a global and must return a `RenderResult`
 * (i.e., call `d.render()`).
 */
export async function executeCode(code: string, renderOpts?: RenderOpts): Promise<ExecuteResult> {
  try {
    // Merge sourceCode into renderOpts so render() can write sidecar
    const mergedOpts: RenderOpts = { ...renderOpts, sourceCode: code };

    // Wrap user code in an async function that returns the result.
    // Monkey-patch Diagram.prototype.render to merge renderOpts as defaults
    // so the caller's format/path preferences are respected even when the
    // LLM calls d.render() without explicit opts.
    const wrappedCode = `
      const _origRender = Diagram.prototype.render;
      Diagram.prototype.render = function(opts) {
        return _origRender.call(this, { ...renderOpts, ...opts });
      };
      return (async () => {
        ${code}
      })();
    `;

    const fn = new Function("Diagram", "renderOpts", wrappedCode);
    const result = await fn(Diagram, mergedOpts);

    if (!result || typeof result !== "object") {
      return {
        result: { json: {} },
        error: "Code did not return a RenderResult. Make sure to return d.render().",
      };
    }

    return { result };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      result: { json: {} },
      error: message,
    };
  }
}
