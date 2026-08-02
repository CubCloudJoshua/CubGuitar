/**
 * Which bar an edit touched.
 *
 * Two kinds of test here and both matter.
 *
 * The first kind checks the answer: an edit to bar 40 reports bar 40, and anything that
 * could move the whole layout reports the top of the score. A wrong answer that is too
 * *high* draws stale music, which is the failure worth being paranoid about, so the
 * cases that could tempt an optimisation — a removed bar, a second track, a retuning —
 * each have one.
 *
 * The second kind checks the property this rests on: `applyOp` returns the same object
 * for anything it did not change. If that ever stops holding, this file starts
 * answering 0 for every edit, every render becomes a full one, and the only symptom is
 * that the editor is slow again. Nothing else in the suite would notice.
 */
import { describe, expect, it } from "vitest";
import { applyBatch } from "./apply.js";
import { createBar, createScore, createTrack, frettedGuitar, nextId, STANDARD_BASS } from "./build.js";
import { firstChangedBar } from "./diff.js";
import type { Instrument, Op, OpBatch, OpKind, Score } from "./index.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `d-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `d-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

/** A guitar score of `bars` empty bars. */
function score(bars = 8, tracks = 1): Score {
  const names = ["Guitar", "Bass"].slice(0, tracks);
  return {
    ...createScore("Long piece"),
    tracks: names.map((name, i) =>
      createTrack(name, i === 0 ? frettedGuitar() : { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, bars),
    ),
  };
}

/** The id of the first beat of a bar, for aiming an op at it. */
function beatIn(s: Score, bar: number, track = 0): string {
  return s.tracks[track]!.bars[bar]!.voices[0]!.beats[0]!.id;
}

function noteIn(bar: number) {
  return { id: nextId("n"), pitch: 64, string: 1, fret: 5, articulations: [] as [] };
}

describe("where an edit landed", () => {
  it("reports nothing when the score did not change", () => {
    const s = score();
    expect(firstChangedBar(s, s)).toBeNull();
  });

  it("reports nothing when an op changed nothing", () => {
    // The identity invariant at work: a no-op returns the same score object, so there
    // is no render to do at all.
    const s = score();
    const after = applyBatch(s, batch({ type: "note.remove", noteId: "not-here" }));
    expect(firstChangedBar(s, after)).toBeNull();
  });

  it("reports the bar a note was typed into", () => {
    const s = score(12);
    const after = applyBatch(s, batch({ type: "note.insert", beatId: beatIn(s, 7), note: noteIn(7) }));
    expect(firstChangedBar(s, after)).toBe(7);
  });

  it("reports the earliest of several changed bars", () => {
    const s = score(12);
    const after = applyBatch(
      s,
      batch(
        { type: "note.insert", beatId: beatIn(s, 9), note: noteIn(9) },
        { type: "note.insert", beatId: beatIn(s, 3), note: noteIn(3) },
      ),
    );
    expect(firstChangedBar(s, after)).toBe(3);
  });

  it("reports the earliest across tracks, because bars are laid out together", () => {
    // A change to the bass part's bar 2 moves bar 2 on the guitar staff as well.
    const s = score(12, 2);
    const after = applyBatch(
      s,
      batch(
        { type: "note.insert", beatId: beatIn(s, 8, 0), note: noteIn(8) },
        { type: "note.insert", beatId: beatIn(s, 2, 1), note: noteIn(2) },
      ),
    );
    expect(firstChangedBar(s, after)).toBe(2);
  });

  it("reports bar 0 when a bar is added at the top, since everything after it shifts", () => {
    // A fresh bar, not an existing one: re-inserting a bar the track already has is a
    // redelivery, and `apply` correctly treats it as a no-op.
    const s = score(4);
    const after = applyBatch(s, batch({ type: "bar.insert", trackId: s.tracks[0]!.id, index: 0, bar: createBar() }));
    expect(firstChangedBar(s, after)).toBe(0);
  });

  it("reports the insertion point when a bar is added in the middle", () => {
    const s = score(8);
    const after = applyBatch(s, batch({ type: "bar.insert", trackId: s.tracks[0]!.id, index: 5, bar: createBar() }));
    expect(firstChangedBar(s, after)).toBe(5);
  });

  it("reports the bar where a removal starts", () => {
    const s = score(8);
    const after = applyBatch(s, batch({ type: "bar.remove", trackId: s.tracks[0]!.id, barId: s.tracks[0]!.bars[5]!.id }));
    expect(firstChangedBar(s, after)).toBe(5);
  });
});

describe("changes that move everything", () => {
  it("reports the top when a track is added", () => {
    const s = score(8);
    const track = createTrack("Second", frettedGuitar(), 8);
    const after = applyBatch(s, batch({ type: "track.insert", index: 1, track }));
    expect(firstChangedBar(s, after)).toBe(0);
  });

  it("reports the top when a track is removed", () => {
    const s = score(8, 2);
    const after = applyBatch(s, batch({ type: "track.remove", trackId: s.tracks[1]!.id }));
    expect(firstChangedBar(s, after)).toBe(0);
  });

  it("reports the top when a track is retuned", () => {
    // Every fret on the staff means a different pitch, and the tuning is printed in
    // the header. Nothing about the layout survives it.
    const s = score(8);
    const bass: Instrument = { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 };
    const after = applyBatch(s, batch({ type: "track.setInstrument", trackId: s.tracks[0]!.id, instrument: bass }));
    expect(firstChangedBar(s, after)).toBe(0);
  });

  it("reports the top when only the title changed", () => {
    // No bar moved, but the title is drawn above the first system.
    const s = score(8);
    const after = applyBatch(s, batch({ type: "score.setTitle", title: "Something else" }));
    expect(firstChangedBar(s, after)).toBe(0);
  });
});

describe("the invariant this depends on", () => {
  it("leaves every untouched bar reference-identical", () => {
    // The property that makes this cheap, asserted directly. If `apply.ts` ever starts
    // rebuilding bars it did not change, `firstChangedBar` answers 0 for every edit,
    // every render becomes a full one, and nothing else in the suite notices.
    const s = score(40);
    const after = applyBatch(s, batch({ type: "note.insert", beatId: beatIn(s, 25), note: noteIn(25) }));
    const before = s.tracks[0]!.bars;
    const now = after.tracks[0]!.bars;
    for (let i = 0; i < before.length; i += 1) {
      if (i === 25) {
        expect(now[i], "the edited bar is a new object").not.toBe(before[i]);
      } else {
        expect(now[i] === before[i], `bar ${i} was rebuilt without being changed`).toBe(true);
      }
    }
  });

  it("leaves an untouched track reference-identical", () => {
    const s = score(8, 2);
    const after = applyBatch(s, batch({ type: "note.insert", beatId: beatIn(s, 1, 0), note: noteIn(1) }));
    expect(after.tracks[1]).toBe(s.tracks[1]);
  });

  it("costs a pointer walk, not a comparison of music", () => {
    // A hundred bars of a real arrangement, diffed a thousand times. If this ever
    // starts comparing note by note it will show up here as seconds rather than
    // milliseconds, on the machine of whoever made it do that.
    const s = score(100);
    const after = applyBatch(s, batch({ type: "note.insert", beatId: beatIn(s, 99), note: noteIn(99) }));
    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) firstChangedBar(s, after);
    const each = (performance.now() - started) / 1000;
    expect(each, `${each.toFixed(3)}ms per diff`).toBeLessThan(1);
  });
});
