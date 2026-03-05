/**
 * Upload Excalidraw JSON to excalidraw.com — no auth, E2E encrypted.
 *
 * Must match excalidraw's compressData/decompressData format exactly:
 * 1. Generate AES-GCM key, export as JWK (k field = base64url key in URL)
 * 2. Build payload: concatBuffers(encodingMetadata, iv, encrypted(deflate(concatBuffers(contentsMetadata, data))))
 * 3. POST to json.excalidraw.com/api/v2/post/
 * 4. URL: excalidraw.com/#json=ID,KEY (KEY = JWK k field)
 *
 * Reference: packages/excalidraw/data/encode.ts in excalidraw/excalidraw
 */

import { z } from "zod";
import { zlibCompress } from "./layout.js";

const EXCALIDRAW_API = "https://json.excalidraw.com/api/v2/post/";
const IV_LENGTH_BYTES = 12;
const CONCAT_BUFFERS_VERSION = 1;
const VERSION_DATAVIEW_BYTES = 4;
const NEXT_CHUNK_SIZE_DATAVIEW_BYTES = 4;

/**
 * Matches excalidraw's concatBuffers: [version(4B), chunkSize(4B), chunk, ...]
 */
function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
  const totalSize =
    VERSION_DATAVIEW_BYTES +
    NEXT_CHUNK_SIZE_DATAVIEW_BYTES * buffers.length +
    buffers.reduce((acc, b) => acc + b.byteLength, 0);

  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let cursor = 0;

  // Version
  view.setUint32(cursor, CONCAT_BUFFERS_VERSION);
  cursor += VERSION_DATAVIEW_BYTES;

  for (const buffer of buffers) {
    view.setUint32(cursor, buffer.byteLength);
    cursor += NEXT_CHUNK_SIZE_DATAVIEW_BYTES;
    result.set(buffer, cursor);
    cursor += buffer.byteLength;
  }

  return result;
}

export async function uploadToExcalidraw(jsonString: string): Promise<string> {
  // 1. Generate key and export as JWK to get the base64url key for the URL
  const cryptoKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 128 },
    true, // extractable (needed for JWK export)
    ["encrypt"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", cryptoKey);
  const encryptionKey = jwk.k!; // base64url-encoded raw key

  // 2. Build inner payload: concatBuffers(contentsMetadata, dataBuffer)
  const contentsMetadata = new TextEncoder().encode(JSON.stringify(null));
  const dataBuffer = new TextEncoder().encode(jsonString);
  const innerConcat = concatBuffers(contentsMetadata, dataBuffer);

  // 3. zlib compress (Zig WASM fixed-Huffman deflate) → encrypt
  const compressed = zlibCompress(innerConcat);
  if (!compressed) {
    throw new Error("WASM zlib compression failed — WASM module not loaded");
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new Uint8Array(compressed.buffer as ArrayBuffer, compressed.byteOffset, compressed.byteLength),
  );

  // 4. Build outer payload: concatBuffers(encodingMetadata, iv, encryptedData)
  const encodingMetadata = new TextEncoder().encode(
    JSON.stringify({ version: 2, compression: "pako@1", encryption: "AES-GCM" }),
  );
  const payload = concatBuffers(encodingMetadata, iv, new Uint8Array(encryptedBuffer));

  // 5. POST
  const resp = await fetch(EXCALIDRAW_API, {
    method: "POST",
    body: payload as unknown as BodyInit,
  });

  if (!resp.ok) {
    throw new Error(`Excalidraw upload failed: ${resp.status} ${resp.statusText}`);
  }

  const { id } = z.object({ id: z.string() }).parse(await resp.json());
  return `https://excalidraw.com/#json=${id},${encryptionKey}`;
}
