/**
 * Operation log, v0 sketch.
 *
 * Every edit to a Score is a serializable operation. The op log is the
 * source of truth: undo, autosave, named versions, real-time sync, and
 * fork lineage are all views over it. See PLAN.md, "The one decision
 * that matters most".
 */

import type { Articulation, Bar, Beat, Duration, Id, Instrument, Note, TimeSignature, Track } from "./score.js";

export interface OpMeta {
  /** Unique op id (client id + counter under CRDT sync). */
  id: Id;
  /** Author's user id. */
  author: Id;
  /** Client wall-clock, informational only; ordering comes from the log. */
  at: number;
}

/**
 * The edit itself, without log metadata. Kept separate so callers can build
 * an edit without inventing an id/author, and so `Omit` never has to be
 * applied to the union (which would collapse the discriminant).
 */
export type OpKind =

    | { type: "score.setTitle"; title: string }
    | { type: "score.setArtist"; artist: string }
    | { type: "track.insert"; index: number; track: Track }
    | { type: "track.remove"; trackId: Id }
    | { type: "track.rename"; trackId: Id; name: string }
    /**
     * Changes what a track *is* — a piano part becoming a guitar part, a guitar
     * being retuned. An op rather than a setting so arranging is undoable and
     * travels through a live session like any other edit.
     */
    | { type: "track.setInstrument"; trackId: Id; instrument: Instrument }
    | { type: "bar.insert"; trackId: Id; index: number; bar: Bar }
    | { type: "bar.remove"; trackId: Id; barId: Id }
    | { type: "bar.setTempo"; barId: Id; tempoBpm: number | null }
    /**
     * `null` clears the bar's own signature so it inherits the previous one
     * again. Needed so a meter change can be undone: without it the inverse
     * would have to write 4/4 into a bar that never carried a signature,
     * engraving one mid-score that was not there before.
     */
    | { type: "bar.setTimeSignature"; barId: Id; timeSignature: TimeSignature | null }
    | { type: "beat.insert"; voiceId: Id; index: number; beat: Beat }
    | { type: "beat.remove"; voiceId: Id; beatId: Id }
    | { type: "beat.setDuration"; beatId: Id; duration: Duration }
    | { type: "beat.setDots"; beatId: Id; dots: 0 | 1 | 2 }
    /**
     * `index` places the note within the beat's chord. Omitted for note entry,
     * which appends; supplied when undo restores a note that was displaced, so
     * a chord's notes come back in the order they were in rather than resorted.
     */
    | { type: "note.insert"; beatId: Id; note: Note; index?: number }
    | { type: "note.remove"; noteId: Id }
    | { type: "note.setPitch"; noteId: Id; pitch: number }
    /**
     * `null` clears the fingering, so a note goes back to being a pitch with no
     * place on a fretboard. Needed so arranging a pitched part for guitar can be
     * undone: without it the inverse could restore the pitch and the instrument and
     * would leave every note carrying a string and fret it never had, which is a
     * half-undone arrangement rather than an undone one. String and fret move
     * together because a string without a fret means nothing.
     */
    | { type: "note.setFingering"; noteId: Id; string: number | null; fret: number | null }
    | { type: "note.addArticulation"; noteId: Id; articulation: Articulation }
    | { type: "note.removeArticulation"; noteId: Id; articulation: Articulation };

export type Op = OpMeta & OpKind;

/** An applied batch: one user gesture, one undo step. */
export interface OpBatch {
  id: Id;
  ops: Op[];
  /** Human label for history UI, e.g. "Paste 4 bars". */
  label?: string;
}
