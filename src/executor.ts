/**
 * LocalExecutor — runs LLM-generated diagram code in the current process.
 *
 * Defense-in-depth: common globals (fetch, eval, Function, etc.) are shadowed
 * so LLM code can only use the Diagram API in the normal case. This is NOT a
 * security sandbox — constructor chain escapes and dynamic import() bypass
 * shadowing. For true isolation, use Cloudflare's Dynamic Worker Loader.
 *
 * Acceptable because: locally the LLM already has full system access, and on
 * Workers the env only contains non-secret bindings (WASM module, browser).
 */

import { Diagram } from "./sdk.js";
import { EXCALIDRAW_VERSION } from "./types.js";
import type { RenderResult, RenderOpts, ExcalidrawFile } from "./types.js";

const EMPTY_FILE: ExcalidrawFile = { type: "excalidraw", version: EXCALIDRAW_VERSION, elements: [] };

export interface ExecuteResult {
  result: RenderResult;
  error?: string;
}

/**
 * Execute LLM-generated diagram code. Two styles supported:
 *
 *   1. Legacy: `const d = new Diagram(); d.addBox(...); return d.render();`
 *      The code declares its own `d` (or uses Diagram.fromMermaid / fromFile)
 *      and explicitly returns d.render(). Result comes from the return value.
 *
 *   2. Bare: `addBox(...); connect(...);` — no `const d`, no return.
 *      All SDK methods are injected as globals. The executor creates the
 *      Diagram internally and renders it after the body completes.
 *
 * Best-effort: if the body throws (legacy or bare style), nodes added before
 * the throw are still rendered.
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
    class ConfiguredDiagram extends Diagram {
      override async render(opts?: RenderOpts): Promise<RenderResult> {
        const merged = { ...renderOpts, ...opts };
        if (formatMap && typeof merged.format === "string" && merged.format in formatMap) {
          merged.format = formatMap[merged.format] as RenderOpts["format"];
        }
        return super.render(merged);
      }
    }

    // Legacy style: code declares `const|let|var d = ...`. We don't touch the
    // code; user owns `d`. Bare style: no own `d` declaration — we inject SDK
    // method globals bound to an internal Diagram instance.
    const isLegacyStyle = /\b(?:const|let|var)\s+d\s*=/.test(code);

    const TIMEOUT_MS = 60_000;
    let timer: ReturnType<typeof setTimeout>;

    if (isLegacyStyle) {
      // Old style: run code as-is. User must `return d.render(...)`.
      const wrappedCode = `
        return (async () => {
          ${code}
        })();
      `;
      const fn = new Function(
        "Diagram",
        "fetch", "globalThis", "self", "process", "require",
        "eval", "Function",
        wrappedCode,
      );

      try {
        const result = await Promise.race([
          fn(ConfiguredDiagram, undefined, undefined, undefined, undefined, undefined, undefined, undefined),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Execution timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
          }),
        ]);

        if (!result || typeof result !== "object") {
          return {
            result: { json: EMPTY_FILE },
            error: "Code did not return a RenderResult. Make sure to return d.render().",
          };
        }

        return { result: result as RenderResult };
      } finally {
        clearTimeout(timer!);
      }
    }

    // Bare style: inject method globals, render automatically.
    const d = new ConfiguredDiagram();

    const globals: Record<string, Function> = {
      addBox: d.addBox.bind(d),
      addEllipse: d.addEllipse.bind(d),
      addDiamond: d.addDiamond.bind(d),
      addTable: d.addTable.bind(d),
      addClass: d.addClass.bind(d),
      addText: d.addText.bind(d),
      addLine: d.addLine.bind(d),
      addGroup: d.addGroup.bind(d),
      addFrame: d.addFrame.bind(d),
      connect: d.connect.bind(d),
      addLane: d.addLane.bind(d),
      addActor: d.addActor.bind(d),
      message: d.message.bind(d),
      setDirection: d.setDirection.bind(d),
      setType: d.setType.bind(d),
      setTheme: d.setTheme.bind(d),
    };

    // Capture user's `return render(...)` opts if present.
    let cleaned = code;
    let userRenderOpts: RenderOpts | undefined;
    const renderMatch = cleaned.match(/\breturn\s+render\s*\((\{[^}]*\})?\s*\)\s*;?\s*$/m);
    if (renderMatch) {
      if (renderMatch[1]) {
        try {
          userRenderOpts = JSON.parse(renderMatch[1].replace(/'/g, '"').replace(/(\w+)\s*:/g, '"$1":'));
        } catch { /* keep undefined */ }
      } else {
        userRenderOpts = {};
      }
      cleaned = cleaned.replace(renderMatch[0], "");
    }

    const paramNames = Object.keys(globals);
    const paramValues = Object.values(globals);

    const wrappedCode = `
      return (async () => {
        ${cleaned}
      })();
    `;
    const fn = new Function(
      ...paramNames,
      "Diagram",
      "fetch", "globalThis", "self", "process", "require",
      "eval", "Function",
      wrappedCode,
    );

    let codeError: string | undefined;
    try {
      await Promise.race([
        fn(...paramValues, ConfiguredDiagram, undefined, undefined, undefined, undefined, undefined, undefined, undefined),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Execution timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      codeError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer!);
    }

    try {
      const mergedOpts: RenderOpts = { ...renderOpts, ...userRenderOpts };
      const result = await d.render(mergedOpts);
      return codeError ? { result, error: codeError } : { result };
    } catch (e) {
      const renderErr = e instanceof Error ? e.message : String(e);
      return { result: { json: EMPTY_FILE }, error: codeError ?? renderErr };
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      result: { json: EMPTY_FILE },
      error: message,
    };
  }
}
