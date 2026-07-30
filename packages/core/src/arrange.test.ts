/**
 * Arranging a part for a fretted instrument.
 *
 * The claims worth pinning are the ones a musician would check: every note that
 * could be placed is placed, on a real string at a real fret; a part outside the
 * instrument's range is moved by octaves rather than abandoned or mangled; and a
 * note that genuinely cannot be played is removed and *reported* rather than left
 * as a pitch the editor cannot show.
 *
 * And the structural one, which is the reason this can exist as a button at all: the
 * whole arrangement is one op batch, so it is one undo step.
 */
import { describe, expect, it } from "vitest";
import { applyBatch } from "./apply.js";
import { arrangeForFretted } from "./arrange.js";
import { createNote, createScore, createTrack, frettedGuitar, STANDARD_BASS } from "./build.js";
import { invertBatch } from "./invert.js";
import type { Instrument, Op, OpBatch, OpKind, Score } from "./index.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `arr-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `arr-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

const guitar = frettedGuitar();
const bass: Instrument = { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 };

/** A pitched track holding one pitch per beat, in the order given. */
function pitchedPart(pitches: number[], barCount = 4): Score {
  const base: Score = {
    ...createScore("Piano part"),
    tracks: [createTrack("Piano", { kind: "pitched", midiProgram: 0 }, barCount)],
  };
  const beats = base.tracks[0]!.bars.flatMap((bar) => bar.voices[0]!.beats);
  return applyBatch(
    base,
    batch(
      ...pitches.map(
        (pitch, i): OpKind => ({
          type: "note.insert",
          beatId: beats[i % beats.length]!.id,
          // No string or fret: this is what a pitched staff carries.
          note: { id: `p-${i}`, pitch, articulations: [] },
        }),
      ),
    ),
  );
}

/** Every note of the first track, after arranging. */
function notesOf(score: Score) {
  return score.tracks[0]!.bars.flatMap((bar) =>
    bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes)),
  );
}

function arrange(score: Score, instrument: Instrument = guitar) {
  const { ops, report } = arrangeForFretted(score, 0, instrument);
  return { report, ops, after: applyBatch(score, batch(...ops)) };
}

describe("arranging a pitched part", () => {
  it("makes the track a guitar", () => {
    const { after } = arrange(pitchedPart([64, 67, 71, 72]));
    expect(after.tracks[0]?.instrument.kind).toBe("fretted");
  });

  it("gives every note a string and a fret", () => {
    const { after, report } = arrange(pitchedPart([64, 67, 71, 72]));
    const notes = notesOf(after);
    expect(notes).toHaveLength(4);
    expect(report.placed).toBe(4);
    for (const note of notes) {
      expect(note.string).toBeGreaterThanOrEqual(1);
      expect(note.string).toBeLessThanOrEqual(6);
      expect(note.fret).toBeGreaterThanOrEqual(0);
      expect(note.fret).toBeLessThanOrEqual(24);
    }
  });

  it("puts each note where its pitch actually is on that string", () => {
    // The check that separates arranging from decorating: string 1 is E4 (64), so a
    // note at fret 3 of it must sound G4 (67), and nothing else.
    const { after } = arrange(pitchedPart([64, 67, 71, 72]));
    const open = [64, 59, 55, 50, 45, 40];
    for (const note of notesOf(after)) {
      expect(open[note.string! - 1]! + note.fret!).toBe(note.pitch);
    }
  });

  it("never asks the hand to jump between consecutive notes", () => {
    // This is the guarantee the solver actually makes, and it is the one that
    // matters for playability: consecutive notes are within a hand's reach, so the
    // part can be played at tempo. It is *not* the same as the whole phrase sitting
    // in one position — the cost is consecutive movement, so an ascending scale
    // comes out walked up one string rather than played across strings in position.
    // That is a real limitation, named in arrange.ts, and asserting the stronger
    // property here would have been asserting something untrue.
    const { after } = arrange(pitchedPart([64, 66, 67, 69, 71, 72, 74, 76]));
    const frets = notesOf(after).map((n) => n.fret!);
    for (let i = 1; i < frets.length; i += 1) {
      // Open strings are free and move nothing, so they are not a jump.
      if (frets[i] === 0 || frets[i - 1] === 0) continue;
      expect(Math.abs(frets[i]! - frets[i - 1]!)).toBeLessThanOrEqual(4);
    }
  });

  it("reports plainly when nothing had to be compromised", () => {
    const { report } = arrange(pitchedPart([64, 67, 71]));
    expect(report.dropped).toBe(0);
    expect(report.octaveShift).toBe(0);
    expect(report.notes.join(" ")).toMatch(/Every note placed/);
  });
});

describe("a part outside the instrument's range", () => {
  it("shifts a low part up by octaves instead of dropping it", () => {
    // A cello line, an octave and a half below a guitar. Fingering it as written
    // would place nothing at all.
    const low = [36, 38, 40, 41];
    const { after, report } = arrange(pitchedPart(low));
    expect(report.octaveShift).toBeGreaterThan(0);
    expect(report.placed).toBe(4);
    expect(report.dropped).toBe(0);
    // Pitch classes are unchanged, which is what makes an octave shift the right
    // move: the harmony survives.
    expect(notesOf(after).map((n) => n.pitch % 12)).toEqual(low.map((p) => p % 12));
    expect(report.notes.join(" ")).toMatch(/Transposed 1 octave up/);
  });

  it("shifts a high part down", () => {
    const high = [100, 102, 104];
    const { report } = arrange(pitchedPart(high));
    expect(report.octaveShift).toBeLessThan(0);
    expect(report.placed).toBe(3);
    expect(report.notes.join(" ")).toMatch(/down/);
  });

  it("does not move a part that already fits", () => {
    const { report, after } = arrange(pitchedPart([64, 67, 71]));
    expect(report.octaveShift).toBe(0);
    expect(notesOf(after).map((n) => n.pitch)).toEqual([64, 67, 71]);
  });

  it("removes a note nothing can reach, and says so", () => {
    // One note far outside any octave shift's reach, among notes that fit.
    const { after, report } = arrange(pitchedPart([64, 67, 5, 71]));
    expect(report.dropped).toBe(1);
    expect(notesOf(after)).toHaveLength(3);
    expect(report.notes.join(" ")).toMatch(/1 note could not be reached/);
    // And what is left is intact rather than half-converted.
    for (const note of notesOf(after)) expect(note.fret).toBeDefined();
  });

  it("arranges for a bass as readily as for a guitar", () => {
    const { after, report } = arrange(pitchedPart([43, 45, 47, 48]), bass);
    expect(report.placed).toBe(4);
    const instrument = after.tracks[0]!.instrument;
    expect(instrument.kind === "fretted" && instrument.tuning).toHaveLength(4);
    for (const note of notesOf(after)) expect(note.string).toBeLessThanOrEqual(4);
  });
});

describe("chords", () => {
  it("puts a chord's notes on different strings", () => {
    const base: Score = {
      ...createScore("Chords"),
      tracks: [createTrack("Piano", { kind: "pitched", midiProgram: 0 }, 2)],
    };
    const beat = base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!;
    const chord = applyBatch(
      base,
      batch(
        { type: "note.insert", beatId: beat.id, note: { id: "c1", pitch: 60, articulations: [] } },
        { type: "note.insert", beatId: beat.id, note: { id: "c2", pitch: 64, articulations: [] } },
        { type: "note.insert", beatId: beat.id, note: { id: "c3", pitch: 67, articulations: [] } },
      ),
    );
    const { after, report } = arrange(chord);
    expect(report.placed).toBe(3);
    const strings = notesOf(after).map((n) => n.string);
    expect(new Set(strings).size).toBe(3);
  });
});

describe("it is one edit", () => {
  it("arranges as a single op batch, so it is a single undo step", () => {
    // The structural claim, and the reason this can be a button rather than a
    // destructive command with a warning dialog.
    const original = pitchedPart([64, 67, 71, 72]);
    const { ops } = arrangeForFretted(original, 0, guitar);
    const one = batch(...ops);
    const arranged = applyBatch(original, one);
    expect(arranged.tracks[0]?.instrument.kind).toBe("fretted");

    const undone = applyBatch(arranged, batch(...invertBatch(original, one)));
    expect({ ...undone, revision: 0 }).toEqual({ ...original, revision: 0 });
  });

  it("undoes a transposing arrangement back to the original pitches", () => {
    const original = pitchedPart([36, 38, 40, 41]);
    const one = batch(...arrangeForFretted(original, 0, guitar).ops);
    const arranged = applyBatch(original, one);
    expect(notesOf(arranged)[0]?.pitch).not.toBe(36);

    const undone = applyBatch(arranged, batch(...invertBatch(original, one)));
    expect(notesOf(undone).map((n) => n.pitch)).toEqual([36, 38, 40, 41]);
    expect(undone.tracks[0]?.instrument.kind).toBe("pitched");
  });

  it("undoes an arrangement that dropped a note, putting it back", () => {
    const original = pitchedPart([64, 67, 5, 71]);
    const one = batch(...arrangeForFretted(original, 0, guitar).ops);
    const arranged = applyBatch(original, one);
    expect(notesOf(arranged)).toHaveLength(3);

    const undone = applyBatch(arranged, batch(...invertBatch(original, one)));
    expect(notesOf(undone).map((n) => n.pitch)).toEqual([64, 67, 5, 71]);
  });
});

describe("nothing to do", () => {
  it("returns no ops for a track with no notes", () => {
    const bare: Score = {
      ...createScore("Empty"),
      tracks: [createTrack("Piano", { kind: "pitched", midiProgram: 0 }, 2)],
    };
    const { ops, report } = arrangeForFretted(bare, 0, guitar);
    expect(ops).toEqual([]);
    expect(report.notes).toEqual(["nothing to arrange"]);
  });

  it("returns no ops for a track index that is not there", () => {
    expect(arrangeForFretted(pitchedPart([64]), 9, guitar).ops).toEqual([]);
  });

  it("refuses to arrange for an instrument with no strings", () => {
    const { ops } = arrangeForFretted(pitchedPart([64]), 0, { kind: "pitched", midiProgram: 0 });
    expect(ops).toEqual([]);
  });
});
