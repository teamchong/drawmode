/**
 * Visual regression testing helpers — pixel comparison with tolerance
 * for Excalidraw's hand-drawn style variations.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const SNAPSHOT_DIR = join(dirname(new URL(import.meta.url).pathname), "__snapshots__");
const DIFF_DIR = join(SNAPSHOT_DIR, "diffs");

export interface CompareResult {
  match: boolean;
  mismatchPixels: number;
  mismatchPercent: number;
  baselineCreated: boolean;
}

/**
 * Compare a rendered PNG against a golden baseline snapshot.
 * First run creates the baseline. Subsequent runs compare against it.
 *
 * @param pngBase64 - Base64-encoded PNG from renderPngLocal
 * @param snapshotName - Name for this snapshot (e.g., "two-box-arrow")
 * @param threshold - Pixel match threshold 0-1 (default 0.05 = 5%)
 */
export async function compareSnapshot(
  pngBase64: string,
  snapshotName: string,
  threshold = 0.05,
): Promise<CompareResult> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });

  const baselinePath = join(SNAPSHOT_DIR, `${snapshotName}.png`);
  const actualBuf = Buffer.from(pngBase64, "base64");

  // First run — create baseline
  if (!existsSync(baselinePath)) {
    await writeFile(baselinePath, actualBuf);
    return { match: true, mismatchPixels: 0, mismatchPercent: 0, baselineCreated: true };
  }

  // Subsequent runs — compare
  const baselineBuf = await readFile(baselinePath);
  const baseline = PNG.sync.read(baselineBuf);
  const actual = PNG.sync.read(actualBuf);

  // Handle size mismatch: use the larger dimensions for comparison
  const width = Math.max(baseline.width, actual.width);
  const height = Math.max(baseline.height, actual.height);

  // Pad images to same size if needed
  const baselinePadded = padImage(baseline, width, height);
  const actualPadded = padImage(actual, width, height);

  const diff = new PNG({ width, height });
  const mismatchPixels = pixelmatch(
    baselinePadded.data,
    actualPadded.data,
    diff.data,
    width,
    height,
    { threshold: 0.1 }, // per-pixel color distance threshold
  );

  const totalPixels = width * height;
  const mismatchPercent = mismatchPixels / totalPixels;
  const match = mismatchPercent <= threshold;

  // Write diff image on failure for debugging
  if (!match) {
    await mkdir(DIFF_DIR, { recursive: true });
    await writeFile(join(DIFF_DIR, `${snapshotName}-diff.png`), PNG.sync.write(diff));
    await writeFile(join(DIFF_DIR, `${snapshotName}-actual.png`), actualBuf);
  }

  return { match, mismatchPixels, mismatchPercent, baselineCreated: false };
}

/** Pad a PNG to target dimensions with transparent pixels. */
function padImage(img: PNG, targetWidth: number, targetHeight: number): PNG {
  if (img.width === targetWidth && img.height === targetHeight) return img;

  const padded = new PNG({ width: targetWidth, height: targetHeight, fill: true });
  // fill with transparent black
  padded.data.fill(0);

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const srcIdx = (y * img.width + x) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      padded.data[dstIdx] = img.data[srcIdx];
      padded.data[dstIdx + 1] = img.data[srcIdx + 1];
      padded.data[dstIdx + 2] = img.data[srcIdx + 2];
      padded.data[dstIdx + 3] = img.data[srcIdx + 3];
    }
  }

  return padded;
}
