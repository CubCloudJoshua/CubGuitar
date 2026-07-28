/**
 * Cloud sync for the local library.
 *
 * v1 policy, chosen for predictability over cleverness: push overwrites the
 * cloud copy of every local entry, pull adds cloud entries missing locally.
 * The local library stays the source of truth on this device; the cloud is
 * backup and transfer. Real multi-device merge arrives with the CRDT sync
 * service, which the op log was designed for.
 */
import { listEntries, putEntry, type LibraryEntry } from "./db";
import { base64ToBytes } from "../share";

export interface SyncResult {
  pushed: number;
  pulled: number;
}

interface CloudMeta {
  id: string;
  title: string;
  artist: string;
  format: "gp" | "altex";
  authored: boolean;
  tracks: number;
  bars: number;
  addedAt: number;
  updatedAt: number;
}

interface CloudFull extends CloudMeta {
  tex: string | null;
  bytesB64: string | null;
  core: string | null;
  report: string | null;
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

async function pushEntry(entry: LibraryEntry): Promise<void> {
  const response = await fetch(`/api/library/${encodeURIComponent(entry.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: entry.title,
      artist: entry.artist,
      format: entry.format,
      tex: entry.tex,
      bytesB64: entry.bytes ? bytesToBase64(entry.bytes) : null,
      core: entry.core,
      report: entry.report,
      authored: entry.authored,
      tracks: entry.tracks,
      bars: entry.bars,
      addedAt: entry.addedAt,
    }),
  });
  if (!response.ok) throw new Error(`push failed for "${entry.title}" (${response.status})`);
}

export async function syncNow(): Promise<SyncResult> {
  const local = await listEntries();
  const localIds = new Set(local.map((e) => e.id));

  for (const entry of local) await pushEntry(entry);

  const listResponse = await fetch("/api/library");
  if (!listResponse.ok) throw new Error(`could not list cloud library (${listResponse.status})`);
  const remote = (await listResponse.json()) as CloudMeta[];

  let pulled = 0;
  for (const meta of remote) {
    if (localIds.has(meta.id)) continue;
    const response = await fetch(`/api/library/${encodeURIComponent(meta.id)}`);
    if (!response.ok) continue;
    const full = (await response.json()) as CloudFull;
    await putEntry({
      id: full.id,
      title: full.title,
      artist: full.artist,
      format: full.format,
      tex: full.tex,
      bytes: full.bytesB64 ? base64ToBytes(full.bytesB64) : null,
      core: full.core,
      report: full.report,
      authored: full.authored,
      fileName: null,
      addedAt: full.addedAt,
      openedAt: full.updatedAt,
      tracks: full.tracks,
      bars: full.bars,
    });
    pulled += 1;
  }

  return { pushed: local.length, pulled };
}
