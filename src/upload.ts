/**
 * Upload Excalidraw JSON to excalidraw.com — no auth, E2E encrypted.
 *
 * Flow:
 * 1. Generate random AES-GCM key
 * 2. Encrypt JSON with key
 * 3. POST encrypted payload to json.excalidraw.com/api/v2/post/
 * 4. Build URL: excalidraw.com/#json=ID,KEY (key in hash fragment, never sent to server)
 *
 * No CORS on excalidraw.com API — must run server-side (Node, Workers, etc).
 */

const EXCALIDRAW_API = "https://json.excalidraw.com/api/v2/post/";

export async function uploadToExcalidraw(jsonString: string): Promise<string> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"],
  );

  const encoded = new TextEncoder().encode(jsonString);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, cryptoKey, encoded,
  );

  // Payload: 2-byte version + 12-byte IV + ciphertext
  const payload = new Uint8Array(2 + iv.byteLength + encrypted.byteLength);
  payload.set([0, 2], 0); // version 2
  payload.set(iv, 2);
  payload.set(new Uint8Array(encrypted), 2 + iv.byteLength);

  const resp = await fetch(EXCALIDRAW_API, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: payload,
  });

  if (!resp.ok) {
    throw new Error(`Excalidraw upload failed: ${resp.status} ${resp.statusText}`);
  }

  const { id } = (await resp.json()) as { id: string };
  const keyB64 = bytesToBase64Url(keyBytes);

  return `https://excalidraw.com/#json=${id},${keyB64}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
