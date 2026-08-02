/**
 * Chords, lyrics and sections as ops.
 *
 * The property that matters is the one the whole editor rests on: these behave like
 * every other op. They apply, they no-op against a missing id, they keep the identity
 * invariant when they change nothing, and they invert exactly — including back to
 * *absent*, because a beat that never carried a chord must not come back from an undo
 * carrying an empty one.
 */
import { describe, expect, it } from "vitest";
import { applyBatch, applyOp } from "./apply.js";
import { createScore, createTrack, frettedGuitar } from "./build.js";
import { invertBatch } from "./invert.js";
import type { Op, OpBatch, OpKind, Score } from "./index.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `sw-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `sw-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

function fresh(): Score {
  return { ...createScore("Song"), tracks: [createTrack("Guitar", frettedGuitar(), 4)] };
}

const beatIn = (s: Score, bar: number, beat = 0) => s.tracks[0]!.bars[bar]!.voices[0]!.beats[beat]!;
const barIn = (s: Score, bar: number) => s.tracks[0]!.bars[bar]!;

describe("chords on beats", () => {
  it("sets and clears a chord", () => {
    const s = fresh();
    const withChord = applyBatch(s, batch({ type: "beat.setChord", beatId: beatIn(s, 0).id, chord: "Am7" }));
    expect(beatIn(withChord, 0).chord).toBe("Am7");
    const cleared = applyBatch(withChord, batch({ type: "beat.setChord", beatId: beatIn(s, 0).id, chord: null }));
    // Absent, not empty: a cleared chord leaves no trace on the beat.
    expect("chord" in beatIn(cleared, 0)).toBe(false);
  });

  it("keeps the identity invariant when nothing changes", () => {
    const s = fresh();
    const op: Op = { id: "x", author: "t", at: 0, type: "beat.setChord", beatId: beatIn(s, 0).id, chord: null };
    expect(applyOp(s, op)).toBe(s);
    const withChord = applyBatch(s, batch({ type: "beat.setChord", beatId: beatIn(s, 0).id, chord: "C" }));
    const again: Op = { id: "y", author: "t", at: 0, type: "beat.setChord", beatId: beatIn(s, 0).id, chord: "C" };
    expect(applyOp(withChord, again)).toBe(withChord);
  });

  it("no-ops against a beat nobody has", () => {
    const s = fresh();
    expect(applyOp(s, { id: "x", author: "t", at: 0, type: "beat.setChord", beatId: "gone", chord: "C" })).toBe(s);
  });

  it("undoes a chord change back to the previous chord", () => {
    const base = fresh();
    const one = applyBatch(base, batch({ type: "beat.setChord", beatId: beatIn(base, 0).id, chord: "Am" }));
    const second = batch({ type: "beat.setChord", beatId: beatIn(base, 0).id, chord: "F" });
    const two = applyBatch(one, second);
    const undone = applyBatch(two, batch(...invertBatch(one, second)));
    expect(beatIn(undone, 0).chord).toBe("Am");
  });

  it("undoes the first chord back to no chord at all", () => {
    const base = fresh();
    const set = batch({ type: "beat.setChord", beatId: beatIn(base, 0).id, chord: "Am" });
    const applied = applyBatch(base, set);
    const undone = applyBatch(applied, batch(...invertBatch(base, set)));
    expect("chord" in beatIn(undone, 0)).toBe(false);
    expect({ ...undone, revision: 0 }).toEqual({ ...base, revision: 0 });
  });
});

describe("lyrics on beats", () => {
  it("sets, replaces and clears a syllable", () => {
    const base = fresh();
    const id = beatIn(base, 1).id;
    const sung = applyBatch(base, batch({ type: "beat.setLyric", beatId: id, lyric: "hel-" }));
    expect(beatIn(sung, 1).lyric).toBe("hel-");
    const cleared = applyBatch(sung, batch({ type: "beat.setLyric", beatId: id, lyric: null }));
    expect("lyric" in beatIn(cleared, 1)).toBe(false);
  });

  it("round-trips through undo", () => {
    const base = fresh();
    const set = batch({ type: "beat.setLyric", beatId: beatIn(base, 0).id, lyric: "world" });
    const applied = applyBatch(base, set);
    const undone = applyBatch(applied, batch(...invertBatch(base, set)));
    expect({ ...undone, revision: 0 }).toEqual({ ...base, revision: 0 });
  });
});

describe("sections on bars", () => {
  it("names a section and takes the name away", () => {
    const base = fresh();
    const id = barIn(base, 2).id;
    const marked = applyBatch(base, batch({ type: "bar.setSection", barId: id, section: "Chorus" }));
    expect(barIn(marked, 2).section).toBe("Chorus");
    const cleared = applyBatch(marked, batch({ type: "bar.setSection", barId: id, section: null }));
    expect("section" in barIn(cleared, 2)).toBe(false);
  });

  it("undoes a rename back to the previous name, and a naming back to none", () => {
    const base = fresh();
    const id = barIn(base, 0).id;
    const verse = batch({ type: "bar.setSection", barId: id, section: "Verse" });
    const named = applyBatch(base, verse);
    const chorus = batch({ type: "bar.setSection", barId: id, section: "Chorus" });
    const renamed = applyBatch(named, chorus);

    const backToVerse = applyBatch(renamed, batch(...invertBatch(named, chorus)));
    expect(barIn(backToVerse, 0).section).toBe("Verse");
    const backToNothing = applyBatch(named, batch(...invertBatch(base, verse)));
    expect({ ...backToNothing, revision: 0 }).toEqual({ ...base, revision: 0 });
  });

  it("keeps the identity invariant, so diff still sees an unchanged score", () => {
    const base = fresh();
    const op: Op = { id: "x", author: "t", at: 0, type: "bar.setSection", barId: barIn(base, 0).id, section: null };
    expect(applyOp(base, op)).toBe(base);
  });
});
