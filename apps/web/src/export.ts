/**
 * Score export.
 *
 * Guitar Pro (.gp) and alphaTex come from alphaTab's exporters, MIDI from
 * the synth, and PDF from the browser print pipeline. Audio rendering and
 * our own engraved PDF are Phase 2+ (PLAN.md).
 */
import * as alphaTab from "@coderline/alphatab";

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

export function exportMidi(api: alphaTab.AlphaTabApi): void {
  api.downloadMidi();
}

/** Opens the browser print dialog; the user picks "Save as PDF". */
export function printPdf(api: alphaTab.AlphaTabApi): void {
  api.print();
}
