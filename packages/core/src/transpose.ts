/**
 * Transposition: the whole document moved by an interval, as one operation.
 *
 * The everyday case is a singer: the song is right and the key is not, and every tool a
 * musician reaches for has to be able to move it. What makes it more than `pitch += n`
 * is that a tablature document holds three statements of the music, and all three have
 * to move together or the document contradicts itself:
 *
 * - **Pitches** move by the interval. The easy third.
 * - **Fingerings** do not move by anything — they are *re-solved*. A shape shifted two
 *   frets up is wrong the moment it used an open string, and wrong again when a note
 *   falls off the neck; so every fretted track is refingered from its transposed
 *   pitches by the same solver the fretboard reader and MIDI import use, whole track
 *   at once so the hand stays put.
 * - **Chord symbols** are respelled, not shifted: "Am7" up two is "Bm7" because the
 *   symbol is text with a grammar, and `transposeChord` understands it (including the
 *   slash bass). Spelling follows the *destination* key, so a chart moved into F reads
 *   Bb rather than A#.
 *
 * ## Refusal over mutilation
 *
 * A fretted track whose lowest note would fall off the neck cannot be transposed by
 * that interval, and the honest answer is to refuse with the reason rather than to
 * clamp, drop, or octave-shift notes one at a time — any of which changes the music in
 * a way the user did not ask for and might not notice. The report names how many notes
 * are out of reach and in which direction, which is what tells a user "down two won't
 * fit, but down one will" or "raise it an octave instead".
 *
 * Everything returned is one list of ops, so the whole key change is one entry in the
 * undo history and one batch through a live session.
 */
import { fingerSequence } from "./fingering.js";
import { keyPrefersFlats, parseChord, transposeChord } from "./harmony.js";
import type { KeySignature, Score, Track } from "./score.js";
import type { OpKind } from "./ops.js";

export interface TransposeReport {
  semitones: number;
  notesMoved: number;
  chordsMoved: number;
  /** Chord symbols the grammar could not read, kept as they were and named here. */
  chordsKept: string[];
  /** Tracks skipped because transposing them means nothing (drums). */
  tracksSkipped: number;
  /** Human-readable lines for the same banner every other report feeds. */
  notes: string[];
}

export interface TransposeResult {
  /** Empty when the transposition was refused; `report.notes` says why. */
  ops: OpKind[];
  report: TransposeReport;
}

/**
 * The key signature the transposed music is in, for spelling its chords.
 *
 * Seven fifths per semitone, folded into -6..6 the way `tonicOf` folds the reverse.
 * The score's key *signature* is not rewritten — the model states one only where a bar
 * declares it, and inventing declarations is not this function's business — but the
 * spelling of every chord follows where the music has gone, because a chart moved into
 * F that reads A# instead of Bb is wrong in the way musicians notice instantly.
 */
function transposedKey(key: KeySignature | undefined, semitones: number): KeySignature {
  const fifths = key?.fifths ?? 0;
  let next = (fifths + semitones * 7) % 12;
  if (next > 6) next -= 12;
  if (next < -6) next += 12;
  return { fifths: next, mode: key?.mode ?? "major" };
}

/** The first stated key on any track, which is what the document is "in". */
function firstKey(score: Score): KeySignature | undefined {
  for (const track of score.tracks) {
    for (const bar of track.bars) {
      if (bar.keySignature) return bar.keySignature;
    }
  }
  return undefined;
}

export function transposeScore(score: Score, semitones: number): TransposeResult {
  const report: TransposeReport = {
    semitones,
    notesMoved: 0,
    chordsMoved: 0,
    chordsKept: [],
    tracksSkipped: 0,
    notes: [],
  };
  if (!Number.isInteger(semitones) || semitones === 0 || Math.abs(semitones) > 24) {
    report.notes.push("transposition must be a whole number of semitones, up to two octaves");
    return { ops: [], report };
  }

  const preferFlats = keyPrefersFlats(transposedKey(firstKey(score), semitones));
  const ops: OpKind[] = [];

  for (const track of score.tracks) {
    // A drum's "pitch" is which drum it is; moving it swaps instruments, not keys.
    if (track.instrument.kind === "drums") {
      report.tracksSkipped += 1;
      continue;
    }
    const trackOps = transposeTrack(track, semitones, preferFlats, report);
    // One unreachable track refuses the whole command: a score whose guitar moved and
    // whose bass did not is not the same music in a new key, it is two keys at once.
    if (trackOps === null) return { ops: [], report };
    ops.push(...trackOps);
  }

  if (report.notesMoved === 0 && report.chordsMoved === 0) {
    report.notes.push("nothing to transpose");
    return { ops: [], report };
  }
  return { ops, report };
}

/** Ops for one track, or null when the interval does not fit the instrument. */
function transposeTrack(
  track: Track,
  semitones: number,
  preferFlats: boolean,
  report: TransposeReport,
): OpKind[] | null {
  const ops: OpKind[] = [];

  // The chord chart moves regardless of instrument kind: a chart over a vocal staff is
  // still a chart. Symbols the grammar cannot read are kept unchanged and named, the
  // same bargain the chord editor makes — the writer may mean something we cannot parse,
  // and mangling it would be worse than leaving it.
  for (const bar of track.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.chord === undefined) continue;
        const moved = transposeChord(beat.chord, semitones, preferFlats);
        if (moved === null) {
          report.chordsKept.push(beat.chord);
          continue;
        }
        ops.push({ type: "beat.setChord", beatId: beat.id, chord: moved });
        report.chordsMoved += 1;
      }
    }
  }

  if (track.instrument.kind === "pitched") {
    for (const bar of track.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) {
            ops.push({ type: "note.setPitch", noteId: note.id, pitch: note.pitch + semitones });
            report.notesMoved += 1;
          }
        }
      }
    }
    return ops;
  }

  // Fretted: refinger the whole track from its transposed pitches, in beat order, so
  // the solver sees the same sequence a hand plays and keeps it in one position. Beat
  // order across voices matches how fingerings were assigned everywhere else.
  const beats: Array<{ noteIds: string[]; pitches: number[] }> = [];
  for (const bar of track.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.notes.length === 0) continue;
        beats.push({
          noteIds: beat.notes.map((n) => n.id),
          pitches: beat.notes.map((n) => n.pitch + semitones),
        });
      }
    }
  }
  if (beats.length === 0) return ops;

  const fingering = fingerSequence(track.instrument, beats.map((b) => b.pitches));
  if (fingering.unreachable.length > 0) {
    const direction = semitones > 0 ? "above the top of the neck" : "below the instrument's range";
    report.notes.push(
      `"${track.name}": ${fingering.unreachable.length} notes would land ${direction} — ` +
        `transpose by a smaller interval, or the other way by ${12 - Math.abs(semitones % 12)} and change octave`,
    );
    return null;
  }

  for (const [i, beat] of beats.entries()) {
    // Positional indexing is safe *here*, and only because of the refusal above.
    // `fingerSequence` compacts its answer — an unplaceable pitch leaves no entry — and
    // consuming it positionally is the bug the transcription gate caught in the
    // quantiser (see `alignToPitches`). The quantiser needs the aligner because it
    // carries on past unreachable pitches; this function refuses instead, so a complete,
    // in-order answer is guaranteed, and the check below turns any break in that
    // guarantee into a loud refusal rather than a fret that sounds the wrong note.
    const positions = fingering.chords[i] ?? [];
    if (positions.length !== beat.pitches.length) {
      report.notes.push(`"${track.name}": a fingering went missing during transposition; nothing was changed`);
      return null;
    }
    for (const [n, noteId] of beat.noteIds.entries()) {
      const position = positions[n]!;
      ops.push({ type: "note.setPitch", noteId, pitch: beat.pitches[n]! });
      ops.push({ type: "note.setFingering", noteId, string: position.string, fret: position.fret });
      report.notesMoved += 1;
    }
  }
  return ops;
}
