/** Share-link client. The API is same-origin; vite proxies /api in dev and preview. */
import type { LibraryEntry } from "./library/db";

export interface SharedScorePayload {
  id: string;
  title: string;
  artist: string;
  format: "gp" | "altex";
  tex: string | null;
  bytesB64: string | null;
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Uploads a library entry and returns the share URL. */
export async function shareEntry(entry: LibraryEntry): Promise<string> {
  const response = await fetch("/api/scores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: entry.title,
      artist: entry.artist,
      format: entry.format,
      tex: entry.tex,
      bytesB64: entry.bytes ? bytesToBase64(entry.bytes) : null,
    }),
  });
  if (!response.ok) throw new Error(`share failed: ${response.status}`);
  const { id } = (await response.json()) as { id: string };
  return `${location.origin}${location.pathname}#s=${id}`;
}

export async function fetchShared(id: string): Promise<SharedScorePayload> {
  const response = await fetch(`/api/scores/${encodeURIComponent(id)}`);
  if (response.status === 404) throw new Error("This share link does not exist or was removed.");
  if (!response.ok) throw new Error(`could not load shared score (${response.status})`);
  return (await response.json()) as SharedScorePayload;
}

/** Share id from the current URL hash, if the app was opened via a link. */
export function sharedIdFromLocation(): string | null {
  const match = /^#s=([A-Za-z0-9_-]{1,64})$/.exec(location.hash);
  return match?.[1] ?? null;
}
