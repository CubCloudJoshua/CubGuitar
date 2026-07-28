/**
 * Operation log, v0 sketch.
 *
 * Every edit to a Score is a serializable operation. The op log is the
 * source of truth: undo, autosave, named versions, real-time sync, and
 * fork lineage are all views over it. See PLAN.md, "The one decision
 * that matters most".
 */

import type { Articulation, Bar, Beat, Duration, Id, Note, Track } from "./score.js";

export interface OpMeta {
  /** Unique op id (client id + counter under CRDT sync). */
  id: Id;
  /** Author's user id. */
  author: Id;
  /** Client wall-clock, informational only; ordering comes from the log. */
  at: number;
}

export type Op = OpMeta &
  (
    | { type: "score.setTitle"; title: string }
    | { type: "score.setArtist"; artist: string }
    | { type: "track.insert"; index: number; track: Track }
    | { type: "track.remove"; trackId: Id }
    | { type: "track.rename"; trackId: Id; name: string }
    | { type: "bar.insert"; trackId: Id; index: number; bar: Bar }
    | { type: "bar.remove"; trackId: Id; barId: Id }
    | { type: "beat.insert"; voiceId: Id; index: number; beat: Beat }
    | { type: "beat.remove"; voiceId: Id; beatId: Id }
    | { type: "beat.setDuration"; beatId: Id; duration: Duration }
    | { type: "note.insert"; beatId: Id; note: Note }
    | { type: "note.remove"; noteId: Id }
    | { type: "note.setPitch"; noteId: Id; pitch: number }
    | { type: "note.setFingering"; noteId: Id; string: number; fret: number }
    | { type: "note.addArticulation"; noteId: Id; articulation: Articulation }
    | { type: "note.removeArticulation"; noteId: Id; articulation: Articulation }
  );

/** An applied batch: one user gesture, one undo step. */
export interface OpBatch {
  id: Id;
  ops: Op[];
  /** Human label for history UI, e.g. "Paste 4 bars". */
  label?: string;
}
