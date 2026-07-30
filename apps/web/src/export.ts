/**
 * Score export.
 *
 * MIDI is ours: `packages/formats/src/to-midi.ts` writes it from the semantic
 * model, so what leaves here is what the document says rather than what a
 * renderer happened to load. Guitar Pro and alphaTex still come from alphaTab's
 * exporters, and PDF from the browser print pipeline; STANDALONE.md is the plan
 * for the rest.
 */
import * as alphaTab from "@coderline/alphatab";
import type { Score as CoreScore } from "@cubscore/core";
import { toMidi } from "@cubscore/formats";

function download(data: Uint8Array, fileName: string, mime: string) {
  // Copy into a plain ArrayBuffer: alphaTab's Uint8Array may be backed by a
  // SharedArrayBuffer, which Blob does not accept.
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick so the click has committed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Filesystem-safe base name derived from the score title. */
export function baseName(title: string): string {
  const cleaned = title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
  return cleaned || "score";
}

export function exportGp(score: alphaTab.model.Score): void {
  const bytes = new alphaTab.exporter.Gp7Exporter().export(score);
  download(bytes, `${baseName(score.title)}.gp`, "application/octet-stream");
}

export function exportTex(score: alphaTab.model.Score): void {
  const bytes = new alphaTab.exporter.AlphaTexExporter().export(score);
  download(bytes, `${baseName(score.title)}.altex`, "text/plain");
}

/**
 * MIDI from our own model, with a report of what the format could not carry.
 *
 * Ours rather than `api.downloadMidi()` for a reason that is not only
 * architectural: the file the user gets is now built from the document they have
 * been editing, expanded through its repeats, with ties held rather than
 * re-articulated. `pnpm midi` grades it against alphaTab's own MIDI on every score
 * in the corpus, which is how the tie bug was found.
 */
export function exportMidi(score: CoreScore): { unsupported: string[] } {
  const { bytes, report } = toMidi(score);
  download(bytes, `${baseName(score.title)}.mid`, "audio/midi");
  return { unsupported: report.unsupported };
}

/** Opens the browser print dialog; the user picks "Save as PDF". */
export function printPdf(api: alphaTab.AlphaTabApi): void {
  api.print();
}
