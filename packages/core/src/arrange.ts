/**
 * Arranging a part for a fretted instrument.
 *
 * A piano line, a vocal line, a MIDI file, a horn part: music that says which
 * pitches and not where a hand goes. Turning one into tablature is the operation
 * every guitarist does by ear, and no notation product offers it as a button.
 *
 * The reason it can be a button here is structural rather than clever. Arranging is
 * a transformation of the semantic model, every transformation of the model is an op
 * batch, and every op batch is undoable and travels through a live session. Without
 * an op log an arrangement is a destructive edit you cannot take back, which is why
 * nobody ships it: the feature is not the algorithm, it is being able to press
 * Ctrl+Z afterwards.
 *
 * What it does *not* do is claim to arrange well. It finds the most playable
 * fingering for the notes as written (`fingering.ts`) and octave-shifts a part that
 * sits outside the instrument's range, and it reports what it could not place. A
 * human arranger reharmonises, drops inner voices and rewrites rhythms; this moves
 * pitches onto strings. That is the honest boundary and it is worth keeping visible.
 *
 * One limitation worth naming specifically, because it is visible in the output: the
 * fingering cost is *consecutive* movement, not total excursion, so an ascending
 * scale comes out walked up one string rather than played across strings in one
 * position. Every consecutive step stays within a hand's reach — the part is
 * playable — but a guitarist reading it would finger it differently. Fixing that
 * means a position-preference term in `fingering.ts`, which is a change to make with
 * a corpus of real parts to measure against rather than by intuition.
 */
import { DEFAULT_WEIGHTS, fingerSequence, type FingeringWeights } from "./fingering.js";
import type { Beat, Instrument, OpKind, Score, Track } from "./index.js";

export interface ArrangeReport {
  /** Notes placed on a string and fret. */
  placed: number;
  /**
   * Notes no string could reach even after transposing, which the ops remove.
   *
   * Removed rather than left pitch-only, because a fretted track holding a note
   * with no string is a note the editor cannot show, the tab writer cannot write
   * and fret entry cannot replace — a silent corruption rather than a visible gap.
   */
  dropped: number;
  /** Octaves the part was shifted by to fit the instrument. Zero means it fitted. */
  octaveShift: number;
  /** Human-readable notes on what the arrangement cost, for the UI to show. */
  notes: string[];
}

export interface ArrangeResult {
  ops: OpKind[];
  report: ArrangeReport;
}

/** Every note of a track, grouped by the beat it sounds in, in playing order. */
function beatsOf(track: Track): Beat[] {
  const out: Beat[] = [];
  for (const bar of track.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) if (beat.notes.length > 0) out.push(beat);
    }
  }
  return out;
}

/**
 * How many octaves to shift so the most notes land on the instrument.
 *
 * A cello line or a piano left hand sits below a guitar entirely, and fingering it
 * as written would drop every note. Shifting by octaves rather than by semitones is
 * what a guitarist does — it keeps the part recognisable, because the pitch classes
 * and therefore the harmony are unchanged.
 *
 * Zero wins ties, so a part that already fits is never moved.
 */
function bestOctaveShift(pitches: readonly number[], instrument: Instrument): number {
  if (instrument.kind !== "fretted" || pitches.length === 0) return 0;
  const lowest = Math.min(...instrument.tuning) + instrument.capo;
  const highest = Math.max(...instrument.tuning) + instrument.capo + instrument.frets;
  const reachable = (shift: number) =>
    pitches.filter((p) => {
      const moved = p + shift * 12;
      return moved >= lowest && moved <= highest;
    }).length;

  let best = 0;
  let bestCount = reachable(0);
  for (const shift of [-1, 1, -2, 2, -3, 3]) {
    const count = reachable(shift);
    if (count > bestCount) {
      bestCount = count;
      best = shift;
    }
  }
  return best;
}

/**
 * Ops that turn a track into a playable part for `instrument`.
 *
 * Returns ops rather than a score so the caller commits them as one batch through
 * the editor — which is what makes the whole arrangement a single undo step and a
 * single thing for collaborators to receive, rather than several hundred edits.
 */
export function arrangeForFretted(
  score: Score,
  trackIndex: number,
  instrument: Instrument,
  weights: FingeringWeights = DEFAULT_WEIGHTS,
): ArrangeResult {
  const track = score.tracks[trackIndex];
  const empty: ArrangeResult = {
    ops: [],
    report: { placed: 0, dropped: 0, octaveShift: 0, notes: ["nothing to arrange"] },
  };
  if (!track || instrument.kind !== "fretted") return empty;

  const beats = beatsOf(track);
  if (beats.length === 0) return empty;

  const allPitches = beats.flatMap((beat) => beat.notes.map((n) => n.pitch));
  const octaveShift = bestOctaveShift(allPitches, instrument);
  const shift = octaveShift * 12;

  const { chords, unreachable } = fingerSequence(
    instrument,
    beats.map((beat) => beat.notes.map((n) => n.pitch + shift)),
    weights,
  );

  const ops: OpKind[] = [{ type: "track.setInstrument", trackId: track.id, instrument }];
  let placed = 0;
  let dropped = 0;

  for (const [index, beat] of beats.entries()) {
    const positions = chords[index] ?? [];
    for (const [j, note] of beat.notes.entries()) {
      const position = positions[j];
      if (!position) {
        ops.push({ type: "note.remove", noteId: note.id });
        dropped += 1;
        continue;
      }
      // Pitch and fingering both, because a shifted note's pitch changed and a
      // fretted note whose pitch disagrees with its fret plays one thing and shows
      // another.
      if (shift !== 0) ops.push({ type: "note.setPitch", noteId: note.id, pitch: note.pitch + shift });
      ops.push({
        type: "note.setFingering",
        noteId: note.id,
        string: position.string,
        fret: position.fret,
      });
      placed += 1;
    }
  }

  const notes: string[] = [];
  if (octaveShift !== 0) {
    notes.push(
      `Transposed ${Math.abs(octaveShift)} octave${Math.abs(octaveShift) === 1 ? "" : "s"} ` +
        `${octaveShift > 0 ? "up" : "down"} to fit the instrument's range.`,
    );
  }
  if (dropped > 0) {
    notes.push(
      `${dropped} note${dropped === 1 ? "" : "s"} could not be reached on any string and ` +
        `${dropped === 1 ? "was" : "were"} removed.`,
    );
  }
  if (unreachable.length > 0 && dropped === 0) {
    notes.push("Some pitches were out of range but every beat still placed a note.");
  }
  if (notes.length === 0) notes.push("Every note placed, in range, with no transposition.");

  return { ops, report: { placed, dropped, octaveShift, notes } };
}
