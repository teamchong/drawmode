/**
 * Image export — shared HTML template + local Puppeteer renderer.
 *
 * `buildRenderHTML(elements)` returns the HTML page that loads Excalidraw from CDN,
 * renders elements to SVG → canvas → PNG at 2x resolution.
 *
 * `renderPngLocal(elements, outputPath)` — PNG via headless Chrome.
 * `renderSvgLocal(elements, outputPath)` — SVG via headless Chrome (no canvas step).
 *
 * Both return null if puppeteer is not installed.
 */

// Pin to 0.17.6 — 0.18.0 moved the UMD bundle path
const EXCALIDRAW_CDN = "https://unpkg.com/@excalidraw/excalidraw@0.17.6/dist/excalidraw.production.min.js";

/**
 * Build HTML template that loads Excalidraw from CDN, calls exportToSvg(),
 * then runs the provided renderScript to produce the final output.
 * The renderScript receives the SVG element as `svg` and must set window.__DONE = true.
 */
function buildExcalidrawHTML(elements: unknown[], renderScript: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>html, body { margin: 0; padding: 0; background: white; }</style>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="${EXCALIDRAW_CDN}"></script>
</head>
<body>
<script>
(async () => {
  try {
    const elements = ${JSON.stringify(elements)};
    const svg = await ExcalidrawLib.exportToSvg({
      elements,
      appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
      files: null,
    });
    ${renderScript}
  } catch (e) {
    window.__ERROR = e.message || String(e);
    window.__DONE = true;
  }
})();
</script>
</body>
</html>`;
}

/**
 * Build the HTML template that renders Excalidraw elements to PNG.
 * Used by both local puppeteer and Cloudflare Browser Rendering.
 */
export function buildRenderHTML(elements: unknown[]): string {
  return buildExcalidrawHTML(elements, `
    const svgStr = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        window.__ERROR = "SVG rendered with zero dimensions";
        window.__DONE = true;
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth * 2;
      canvas.height = img.naturalHeight * 2;
      const ctx = canvas.getContext("2d");
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      window.__PNG_DATA__ = canvas.toDataURL("image/png").split(",")[1];
      window.__DONE = true;
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      window.__ERROR = "Failed to load SVG as image";
      window.__DONE = true;
    };
    img.src = url;
  `);
}

/**
 * Build HTML template that renders Excalidraw elements to SVG string.
 */
export function buildSvgHTML(elements: unknown[]): string {
  return buildExcalidrawHTML(elements, `
    window.__SVG_DATA__ = new XMLSerializer().serializeToString(svg);
    window.__DONE = true;
  `);
}

/**
 * Launch a puppeteer browser with CDN-friendly flags.
 * Returns { browser, userDataDir } or null if puppeteer not installed.
 */
async function launchBrowser(): Promise<{ browser: any; userDataDir: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let puppeteerMod: any;
  try {
    const mod = "puppeteer";
    puppeteerMod = await import(mod);
  } catch {
    return null;
  }

  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const userDataDir = await mkdtemp(join(tmpdir(), "drawmode-pup-"));

  try {
    const browser = await (puppeteerMod.default ?? puppeteerMod).launch({
      headless: true,
      args: [
        "--disable-web-security",
        "--disable-features=OpaqueResponseBlockingV02",
        "--user-data-dir=" + userDataDir,
        "--no-sandbox",
      ],
    });
    return { browser, userDataDir };
  } catch {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

/**
 * Shared browser render pipeline: launch → setContent → waitForFunction → extract result → cleanup.
 * Returns the value of window[resultKey], or null if puppeteer is not installed.
 */
async function renderInBrowser(html: string, resultKey: string): Promise<string | null> {
  const ctx = await launchBrowser();
  if (!ctx) return null;

  const { browser, userDataDir } = ctx;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.waitForFunction("window.__DONE", { timeout: 30000 });

    const error = await page.evaluate(() => (window as unknown as Record<string, string>).__ERROR);
    if (error) throw new Error(error);

    return await page.evaluate((key: string) => (window as unknown as Record<string, string>)[key], resultKey) as string;
  } finally {
    await browser.close();
    const { rm } = await import("node:fs/promises");
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render elements to SVG locally using puppeteer.
 * Returns SVG string, or null if puppeteer is not installed.
 * Writes the SVG file to outputPath.
 */
export async function renderSvgLocal(elements: unknown[], outputPath: string): Promise<string | null> {
  const svgString = await renderInBrowser(buildSvgHTML(elements), "__SVG_DATA__");
  if (!svgString) return null;

  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputPath, svgString, "utf-8");
  return svgString;
}

/**
 * Render elements to PNG locally using puppeteer.
 * Returns base64-encoded PNG string, or null if puppeteer is not installed.
 * Writes the PNG file to outputPath.
 */
export async function renderPngLocal(elements: unknown[], outputPath: string): Promise<string | null> {
  const pngBase64 = await renderInBrowser(buildRenderHTML(elements), "__PNG_DATA__");
  if (!pngBase64) return null;

  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputPath, Buffer.from(pngBase64, "base64"));
  return pngBase64;
}
