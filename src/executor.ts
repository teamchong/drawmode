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
  // Wrap user code in an async function that returns the result
  const wrappedCode = `
    return (async () => {
      ${code}
    })();
  `;

  const fn = new Function("Diagram", wrappedCode);
  const result = await fn(Diagram);

  if (!result || typeof result !== "object") {
    return {
      result: { json: {} },
      error: "Code did not return a RenderResult. Make sure to return d.render().",
    };
  }

  return { result };
}
