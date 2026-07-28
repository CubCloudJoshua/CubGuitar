import { describe, expect, it } from "vitest";
import { applyBatch, applyOp } from "./apply.js";
import { createNote, createScore, duration, pitchAt } from "./build.js";
import type { Op, OpKind } from "./ops.js";
import type { Score } from "./score.js";

let counter = 0;
function op(kind: OpKind): Op {
  counter += 1;
  return { id: `test-op-${counter}`, author: "test", at: 0, ...kind };
}

function firstBeat(score: Score) {
  const beat = score.tracks[0]?.bars[0]?.voices[0]?.beats[0];
  if (!beat) throw new Error("score has no first beat");
  return beat;
}

describe("applyOp", () => {
  it("inserts a note into a beat", () => {
    const score = createScore("t");
    const beat = firstBeat(score);
    const note = createNote(64, 1, 0);
    const next = applyOp(score, op({ type: "note.insert", beatId: beat.id, note }));
    expect(firstBeat(next).notes).toHaveLength(1);
    expect(firstBeat(next).notes[0]?.pitch).toBe(64);
  });

  it("replaces the note on the same string instead of stacking", () => {
    const score = createScore("t");
    const beat = firstBeat(score);
    const withFirst = applyOp(
      score,
      op({ type: "note.insert", beatId: beat.id, note: createNote(64, 1, 0) }),
    );
    const withSecond = applyOp(
      withFirst,
      op({ type: "note.insert", beatId: beat.id, note: createNote(67, 1, 3) }),
    );
    expect(firstBeat(withSecond).notes).toHaveLength(1);
    expect(firstBeat(withSecond).notes[0]?.fret).toBe(3);
  });

  it("builds chords from notes on different strings", () => {
    const score = createScore("t");
    const beat = firstBeat(score);
    let next = score;
    for (const [string, fret] of [[1, 0], [2, 1], [3, 0]] as const) {
      next = applyOp(
        next,
        op({ type: "note.insert", beatId: beat.id, note: createNote(60, string, fret) }),
      );
    }
    expect(firstBeat(next).notes).toHaveLength(3);
  });

  it("is a no-op for a missing id and returns the same reference", () => {
    const score = createScore("t");
    const next = applyOp(score, op({ type: "note.remove", noteId: "nope" }));
    expect(next).toBe(score);
  });

  it("shares structure along untouched branches", () => {
    const score = createScore("t");
    const secondBarBefore = score.tracks[0]?.bars[1];
    const beat = firstBeat(score);
    const next = applyOp(
      score,
      op({ type: "note.insert", beatId: beat.id, note: createNote(64, 1, 0) }),
    );
    expect(next).not.toBe(score);
    expect(next.tracks[0]?.bars[1]).toBe(secondBarBefore);
  });

  it("sets duration and dots on a beat", () => {
    const score = createScore("t");
    const beat = firstBeat(score);
    let next = applyOp(score, op({ type: "beat.setDuration", beatId: beat.id, duration: duration(8) }));
    next = applyOp(next, op({ type: "beat.setDots", beatId: beat.id, dots: 1 }));
    expect(firstBeat(next).duration.denominator).toBe(8);
    expect(firstBeat(next).dots).toBe(1);
  });

  it("adds an articulation once", () => {
    const score = createScore("t");
    const beat = firstBeat(score);
    const note = createNote(64, 1, 0);
    let next = applyOp(score, op({ type: "note.insert", beatId: beat.id, note }));
    next = applyOp(next, op({ type: "note.addArticulation", noteId: note.id, articulation: "palmMute" }));
    next = applyOp(next, op({ type: "note.addArticulation", noteId: note.id, articulation: "palmMute" }));
    expect(firstBeat(next).notes[0]?.articulations).toEqual(["palmMute"]);
  });
});

describe("applyBatch", () => {
  it("advances the revision once per effective batch", () => {
    const score = createScore("t");
    const beat = firstBeat(score);
    const next = applyBatch(score, {
      id: "b1",
      ops: [
        op({ type: "note.insert", beatId: beat.id, note: createNote(64, 1, 0) }),
        op({ type: "score.setTitle", title: "Renamed" }),
      ],
    });
    expect(next.revision).toBe(score.revision + 1);
    expect(next.title).toBe("Renamed");
  });

  it("returns the same reference for an entirely ineffective batch", () => {
    const score = createScore("t");
    const next = applyBatch(score, {
      id: "b1",
      ops: [op({ type: "note.remove", noteId: "missing" })],
    });
    expect(next).toBe(score);
  });
});

describe("pitchAt", () => {
  it("computes open string and fretted pitches", () => {
    const instrument = createScore("t").tracks[0]!.instrument;
    expect(pitchAt(instrument, 1, 0)).toBe(64);
    expect(pitchAt(instrument, 6, 0)).toBe(40);
    expect(pitchAt(instrument, 6, 5)).toBe(45);
  });

  it("applies the capo", () => {
    const instrument = { kind: "fretted" as const, tuning: [64, 59, 55, 50, 45, 40], frets: 24, capo: 2 };
    expect(pitchAt(instrument, 1, 0)).toBe(66);
  });
});
