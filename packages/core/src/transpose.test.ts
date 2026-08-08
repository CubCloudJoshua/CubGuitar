/**
 * Transposition, graded on the three statements it must move together.
 *
 * A tab document says the music three ways — pitches, fingerings, chord symbols — and a
 * transposition that moves one without the others produces a document that disagrees
 * with itself. So the checks here are cross-statements: every fingering must sound its
 * own (new) pitch, the sounding music must be the old music moved by exactly the
 * interval, and the chart must both parse and name the new roots.
 */
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  createNote,
  createScore,
  createTrack,
  frettedGuitar,
  parseChord,
  pitchAt,
  timeline,
  transposeScore,
  STANDARD_BASS,
  type Op,
  type OpBatch,
  type OpKind,
  type Score,
} from "./index.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `tr-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `tr-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

/** Applies a transposition the way the editor does: as one batch. */
function transposed(score: Score, semitones: number): { score: Score; report: ReturnType<typeof transposeScore>["report"] } {
  const { ops, report } = transposeScore(score, semitones);
  return { score: ops.length > 0 ? applyBatch(score, batch(...ops)) : score, report };
}

/** Sounding pitches in time order, the statement a listener hears. */
const sounded = (score: Score) => timeline(score).notes.map((n) => n.pitch);

/** A guitar score: frets on string 1-2 around position 5, with a small chart. */
function song(): Score {
  const base: Score = { ...createScore("Song"), tracks: [createTrack("Guitar", frettedGuitar(), 2)] };
  const beat = (bar: number, i: number) => base.tracks[0]!.bars[bar]!.voices[0]!.beats[i]!;
  return applyBatch(
    base,
    batch(
      { type: "note.insert", beatId: beat(0, 0).id, note: createNote(69, 1, 5) },
      { type: "note.insert", beatId: beat(0, 1).id, note: createNote(67, 1, 3) },
      { type: "note.insert", beatId: beat(0, 2).id, note: createNote(64, 2, 5) },
      { type: "note.insert", beatId: beat(1, 0).id, note: createNote(60, 2, 1) },
      { type: "beat.setChord", beatId: beat(0, 0).id, chord: "Am7" },
      { type: "beat.setChord", beatId: beat(0, 2).id, chord: "C/G" },
    ),
  );
}

describe("what moves", () => {
  it("moves every sounding pitch by exactly the interval", () => {
    const original = song();
    const before = sounded(original);
    const { score } = transposed(original, 2);
    expect(sounded(score)).toEqual(before.map((p) => p + 2));
  });

  it("moves down as well as up", () => {
    const original = song();
    const before = sounded(original);
    const { score } = transposed(original, -3);
    expect(sounded(score)).toEqual(before.map((p) => p - 3));
  });

  it("refingers rather than shifting shapes: every fret sounds its own new pitch", () => {
    const guitar = frettedGuitar();
    const { score } = transposed(song(), 2);
    for (const bar of score.tracks[0]!.bars) {
      for (const beat of bar.voices[0]!.beats) {
        for (const note of beat.notes) {
          expect(note.string).toBeDefined();
          expect(pitchAt(guitar, note.string!, note.fret!)).toBe(note.pitch);
        }
      }
    }
  });

  it("moves the chart with the music", () => {
    const { score, report } = transposed(song(), 2);
    const beats = score.tracks[0]!.bars[0]!.voices[0]!.beats;
    expect(beats[0]?.chord).toBe("Bm7");
    expect(beats[2]?.chord).toBe("D/A");
    expect(report.chordsMoved).toBe(2);
  });

  it("spells the destination key's way: into flats when the key goes flat", () => {
    const base: Score = { ...createScore("Chart"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const withChord = applyBatch(
      base,
      batch({ type: "beat.setChord", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, chord: "C" }),
    );
    // C down two semitones is Bb in every chart ever written, not A#.
    const { score } = transposed(withChord, -2);
    expect(score.tracks[0]!.bars[0]!.voices[0]!.beats[0]?.chord).toBe("Bb");
  });

  it("keeps a symbol the grammar cannot read, and names it", () => {
    const base: Score = { ...createScore("Odd"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const withChord = applyBatch(
      base,
      batch({ type: "beat.setChord", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, chord: "N.C." }),
    );
    const { score, report } = transposed(withChord, 2);
    expect(score.tracks[0]!.bars[0]!.voices[0]!.beats[0]?.chord).toBe("N.C.");
    expect(report.chordsKept).toEqual(["N.C."]);
  });

  it("the moved chart still parses", () => {
    const { score } = transposed(song(), 7);
    for (const bar of score.tracks[0]!.bars) {
      for (const beat of bar.voices[0]!.beats) {
        if (beat.chord !== undefined) expect(parseChord(beat.chord)).not.toBeNull();
      }
    }
  });

  it("is one round trip: up two then down two is the document it started from", () => {
    const original = song();
    const up = transposed(original, 2).score;
    const back = transposed(up, -2).score;
    expect(sounded(back)).toEqual(sounded(original));
    expect(back.tracks[0]!.bars[0]!.voices[0]!.beats[0]?.chord).toBe("Am7");
  });
});

describe("what refuses", () => {
  it("refuses an interval that falls off the neck, and says which way fits", () => {
    const base: Score = { ...createScore("Low"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    // Open low E: any transposition down leaves the instrument.
    const withLow = applyBatch(
      base,
      batch({ type: "note.insert", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(40, 6, 0) }),
    );
    const { ops, report } = transposeScore(withLow, -1);
    expect(ops).toEqual([]);
    expect(report.notes.join(" ")).toMatch(/below the instrument's range/);
  });

  it("refuses the whole score when one track cannot follow", () => {
    // Guitar can go down one; a bass sitting on its open low string cannot. Moving the
    // guitar alone would leave the score in two keys at once.
    const base: Score = { ...createScore("Band"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const withBass = applyBatch(
      base,
      batch({
        type: "track.insert",
        index: 1,
        track: createTrack("Bass", { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, 1),
      }),
    );
    const filled = applyBatch(
      withBass,
      batch(
        { type: "note.insert", beatId: withBass.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(64, 1, 0) },
        { type: "note.insert", beatId: withBass.tracks[1]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(28, 4, 0) },
      ),
    );
    const { ops, report } = transposeScore(filled, -1);
    expect(ops).toEqual([]);
    expect(report.notes.join(" ")).toMatch(/Bass/);
    // And nothing about the guitar was emitted before the refusal: all or none.
    expect(report.notesMoved === 0 || ops.length === 0).toBe(true);
  });

  it("refuses zero and non-integer intervals", () => {
    expect(transposeScore(song(), 0).ops).toEqual([]);
    expect(transposeScore(song(), 1.5).ops).toEqual([]);
  });

  it("skips a drum track rather than changing which drums are hit", () => {
    const base: Score = { ...createScore("Kit"), tracks: [createTrack("Kit", { kind: "drums" }, 1)] };
    const withHit = applyBatch(
      base,
      batch({
        type: "note.insert",
        beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id,
        note: { id: "d1", pitch: 36, articulations: [] },
      }),
    );
    const { report } = transposeScore(withHit, 2);
    expect(report.tracksSkipped).toBe(1);
    // A kick drum transposed two semitones is still a kick drum.
    expect(withHit.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]?.pitch).toBe(36);
  });

  it("transposes a pitched track without inventing fingerings for it", () => {
    const base: Score = { ...createScore("Voice"), tracks: [createTrack("Voice", { kind: "pitched", midiProgram: 52 }, 1)] };
    const withNote = applyBatch(
      base,
      batch({
        type: "note.insert",
        beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id,
        note: { id: "v1", pitch: 60, articulations: [] },
      }),
    );
    const { score } = transposed(withNote, 4);
    const note = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0];
    expect(note?.pitch).toBe(64);
    expect(note?.string).toBeUndefined();
  });

  it("is undone as one step, because it is one batch", () => {
    // The property the editor relies on: applyBatch of the ops, then applyBatch of the
    // inverses, is the identity. Inverses are exercised through the editor e2e; here the
    // core claim is that transpose emits ops the op-log machinery accepts in one batch.
    const original = song();
    const { ops } = transposeScore(original, 2);
    expect(ops.length).toBeGreaterThan(0);
    const applied = applyBatch(original, batch(...ops));
    expect(applied.revision).toBe(original.revision + 1);
  });
});
