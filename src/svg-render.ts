/**
 * Server-side Excalidraw SVG rendering via linkedom.
 *
 * Uses linkedom (lightweight DOM) + Excalidraw's exportToSvg() to produce
 * the same hand-drawn roughjs SVGs that the browser would generate.
 *
 * Works in Node.js, Cloudflare Workers, and any JS runtime — no browser needed.
 */

import { createRequire } from "node:module";

type ExcalidrawExportFn = (opts: unknown) => Promise<{ outerHTML: string }>;

let _exportToSvg: ExcalidrawExportFn | null = null;

/**
 * Initialize the linkedom DOM environment + Excalidraw library.
 * Must be called lazily (not at module load) because Excalidraw's UMD bundle
 * reads globals (React, document, window) at require() time.
 */
function init(): ExcalidrawExportFn {
  if (_exportToSvg) return _exportToSvg;

  const cjsRequire = createRequire(import.meta.url);

  // 1. Set up linkedom DOM environment
  const { parseHTML } = cjsRequire("linkedom") as { parseHTML: (html: string) => Record<string, unknown> };

  const { document, window, HTMLElement, SVGElement } = parseHTML(
    "<!DOCTYPE html><html><head></head><body></body></html>",
  ) as {
    document: Document;
    window: Window & Record<string, unknown>;
    HTMLElement: typeof globalThis.HTMLElement;
    SVGElement: typeof globalThis.SVGElement;
  };

  Object.defineProperty(window, "location", {
    value: {
      href: "http://localhost",
      origin: "http://localhost",
      protocol: "http:",
      host: "localhost",
      pathname: "/",
      search: "",
      hash: "",
    },
  });

  const g = globalThis as Record<string, unknown>;

  // Some globals (navigator, location, performance) are read-only in Node.js.
  // Use Object.defineProperty with configurable:true to override them.
  function setGlobal(key: string, value: unknown): void {
    try {
      Object.defineProperty(g, key, { value, writable: true, configurable: true });
    } catch { /* skip if truly immutable */ }
  }

  setGlobal("window", window);
  setGlobal("document", document);
  setGlobal("location", window.location);
  if (!g.navigator) setGlobal("navigator", { userAgent: "node", language: "en", languages: ["en"], platform: "linux" });
  setGlobal("HTMLElement", HTMLElement);
  setGlobal("SVGElement", SVGElement);
  setGlobal("self", window);
  if (!g.requestAnimationFrame) setGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
  if (!g.cancelAnimationFrame) setGlobal("cancelAnimationFrame", clearTimeout);
  setGlobal("getComputedStyle", () => new Proxy({}, { get: () => "" }));
  if (!g.ResizeObserver) setGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  if (!g.MutationObserver) setGlobal("MutationObserver", class { observe() {} disconnect() {} });
  if (!g.performance) setGlobal("performance", { now: () => Date.now(), mark: () => {}, measure: () => {} });
  if (!g.matchMedia) setGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  if (!g.CSS) setGlobal("CSS", { supports: () => false });
  if (!g.Image) setGlobal("Image", class { set src(_v: string) {} });
  if (!g.Blob) setGlobal("Blob", class { constructor() {} });
  if (!g.DOMMatrix) setGlobal("DOMMatrix", class { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; });
  if (!g.FontFace) setGlobal("FontFace", class { load() { return Promise.resolve(this); } });
  if (!g.devicePixelRatio) setGlobal("devicePixelRatio", 2);
  if (!g.Path2D) setGlobal("Path2D", class {
    moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {}
    arc() {} closePath() {} addPath() {} rect() {}
  });
  setGlobal("Element", (window as Record<string, unknown>).Element || HTMLElement);
  setGlobal("Node", (window as Record<string, unknown>).Node || class {});
  if (!g.HTMLCanvasElement) setGlobal("HTMLCanvasElement", class {});
  if (!g.HTMLImageElement) setGlobal("HTMLImageElement", class {});
  setGlobal("EventTarget", (window as Record<string, unknown>).EventTarget || class {
    addEventListener() {} removeEventListener() {} dispatchEvent() {}
  });
  if (!g.ClipboardItem) setGlobal("ClipboardItem", class {});

  // Canvas mock — rough.js uses SVG mode for exportToSvg, but measureText is needed
  const mockCtx = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === "measureText") return (text: string) => ({
        width: text.length * 8,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
      });
      if (prop === "canvas") return { width: 1000, height: 1000 };
      if (prop === "getLineDash") return () => [];
      if (prop === "createLinearGradient" || prop === "createRadialGradient")
        return () => ({ addColorStop: () => {} });
      if (prop === "createPattern") return () => ({});
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (typeof target[prop] === "function") return target[prop];
      if (target[prop] !== undefined) return target[prop];
      return () => {};
    },
    set(target, prop: string, value: unknown) { target[prop] = value; return true; },
  });

  // Patch createElement to handle canvas mock and ensure innerText is writable
  const origCE = (document as unknown as Document).createElement.bind(document);
  (document as unknown as Document).createElement = function (tag: string) {
    const el = origCE(tag) as HTMLElement & Record<string, unknown>;
    if (tag === "canvas") {
      el.getContext = () => mockCtx;
      el.toDataURL = () => "";
      el.width = 1000;
      el.height = 1000;
    }
    return el;
  } as unknown as typeof document.createElement;

  // Also patch createElementNS for SVG elements
  const origCENS = (document as unknown as Document).createElementNS.bind(document);
  (document as unknown as Document).createElementNS = function (ns: string, tag: string) {
    const el = origCENS(ns, tag) as Element & Record<string, unknown>;
    // Ensure innerText is writable (some linkedom elements have getter-only innerText)
    try {
      const desc = Object.getOwnPropertyDescriptor(el, "innerText") ??
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "innerText");
      if (desc && !desc.writable && !desc.set) {
        Object.defineProperty(el, "innerText", {
          get() { return (el as unknown as { textContent: string }).textContent || ""; },
          set(v: string) { (el as unknown as { textContent: string }).textContent = v; },
          configurable: true,
        });
      }
    } catch { /* skip */ }
    return el;
  } as unknown as typeof document.createElementNS;

  // Ensure innerText is writable on all element prototypes.
  // Some linkedom elements have getter-only innerText that Excalidraw tries to set.
  for (const proto of [
    HTMLElement.prototype,
    SVGElement.prototype,
    ((window as Record<string, unknown>).Element as { prototype?: object } | undefined)?.prototype,
  ].filter(Boolean) as object[]) {
    const desc = Object.getOwnPropertyDescriptor(proto, "innerText");
    if (desc && desc.get && !desc.set) {
      Object.defineProperty(proto, "innerText", {
        get: desc.get,
        set(v: string) { (this as { textContent: string }).textContent = v; },
        configurable: true,
      });
    }
  }

  // 2. Load React (must be global before Excalidraw)
  g.React = cjsRequire("react");
  g.ReactDOM = cjsRequire("react-dom");

  // 3. Load Excalidraw (reads React + DOM globals at require time)
  const excalidraw = cjsRequire("@excalidraw/excalidraw/dist/excalidraw.production.min.js") as Record<string, unknown>;
  if (!excalidraw.exportToSvg) {
    throw new Error("Failed to load Excalidraw: exportToSvg not found");
  }

  _exportToSvg = excalidraw.exportToSvg as ExcalidrawExportFn;
  return _exportToSvg;
}

// Font cache: name → base64 data URI
let fontCache: Map<string, string> | null = null;

/**
 * Load Excalidraw's font files from node_modules and return base64 data URIs.
 * These are embedded into the SVG so PlutoSVG can render text correctly.
 */
function loadFonts(cjsRequire: NodeRequire): Map<string, string> {
  if (fontCache) return fontCache;
  fontCache = new Map();

  const fontFiles: Record<string, string> = {
    "Virgil": "Virgil.woff2",
    "Cascadia": "Cascadia.woff2",
    "Assistant": "Assistant-Regular.woff2",
  };

  // Resolve the excalidraw package's assets directory
  let assetsDir: string;
  try {
    const excalidrawPkg = cjsRequire.resolve("@excalidraw/excalidraw/dist/excalidraw.production.min.js");
    const path = cjsRequire("path") as typeof import("path");
    assetsDir = path.join(path.dirname(excalidrawPkg), "excalidraw-assets");
  } catch {
    return fontCache; // Can't find fonts — will fall back to default rendering
  }

  const fs = cjsRequire("fs") as typeof import("fs");
  const path = cjsRequire("path") as typeof import("path");

  for (const [name, file] of Object.entries(fontFiles)) {
    try {
      const fontPath = path.join(assetsDir, file);
      const fontData = fs.readFileSync(fontPath);
      const b64 = fontData.toString("base64");
      fontCache.set(name, `url("data:font/woff2;base64,${b64}")`);
    } catch {
      // Font not available — skip
    }
  }

  return fontCache;
}

/**
 * Replace broken @font-face URLs in the SVG with embedded base64 data URIs.
 * Excalidraw generates URLs like `https://unpkg.com/@excalidraw/excalidraw@undefined/...`
 * which PlutoSVG can't fetch. Embedding the fonts ensures correct text rendering.
 */
function embedFontsInSvg(svgString: string, cjsRequire: NodeRequire): string {
  const fonts = loadFonts(cjsRequire);
  if (fonts.size === 0) return svgString;

  return svgString.replace(
    /src:\s*url\("[^"]*\/([^"/]+\.woff2)"\);/g,
    (_match, filename: string) => {
      // Map filename back to font name
      const nameMap: Record<string, string> = {
        "Virgil.woff2": "Virgil",
        "Cascadia.woff2": "Cascadia",
        "Assistant-Regular.woff2": "Assistant",
      };
      const fontName = nameMap[filename];
      const dataUri = fontName ? fonts.get(fontName) : undefined;
      if (dataUri) {
        return `src: ${dataUri};`;
      }
      return _match; // Keep original if font not found
    },
  );
}

/**
 * Render Excalidraw elements to an SVG string using linkedom.
 * Fonts are embedded as base64 data URIs for correct PlutoSVG rendering.
 * No browser needed.
 */
export async function renderSvgString(elements: unknown[]): Promise<string> {
  const exportToSvg = init();
  const svg = await exportToSvg({
    elements,
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
    files: null,
  });
  const cjsRequire = createRequire(import.meta.url);
  return embedFontsInSvg(svg.outerHTML, cjsRequire);
}
