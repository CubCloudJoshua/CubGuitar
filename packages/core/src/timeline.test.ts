/**
 * The timeline is the seam that lets views be built on our model instead of
 * alphaTab's, so it has to be right about time rather than roughly right: a
 * fretboard reader places notes by these numbers, and a note a beat late reads as
 * the wrong note.
 */
import { describe, expect, it } from "vitest";
import { applyBatch } from "./apply.js";
import { createNote, createScore, duration } from "./build.js";
import { barAtSeconds, notesInWindow, playOrder, timeline } from "./timeline.js";
import type { Bar, Score } from "./score.js";
import type { Op, OpBatch, OpKind } from "./ops.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `tl-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `tl-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

function ids(score: Score) {
  const track = score.tracks[0]!;
  return { track, bars: track.bars, voice: track.bars[0]!.voices[0]! };
}

/** A four-bar score at 120bpm: four quarter rests per bar, so one bar is 2s. */
function base(): Score {
  return createScore("Timing");
}

function withNote(score: Score, bar: number, beat: number, fret: number): Score {
  const target = score.tracks[0]!.bars[bar]!.voices[0]!.beats[beat]!;
  return applyBatch(score, batch({ type: "note.insert", beatId: target.id, note: createNote(64, 1, fret) }));
}

function repeatMarks(score: Score, start: number, end: number, count: number): Score {
  // Repeat marks are not ops yet, so they are set on the model directly. The
  // timeline reads the document, not the op log, so this is a fair fixture.
  const next: Score = structuredClone(score);
  const bars = next.tracks[0]!.bars;
  (bars[start] as Bar).repeat = { start: true };
  (bars[end] as Bar).repeat = { endCount: count };
  return next;
}

describe("playOrder", () => {
  const plain = (n: number): Bar[] => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, voices: [] }));

  it("plays bars once when nothing repeats", () => {
    expect(playOrder(plain(4))).toEqual([0, 1, 2, 3]);
  });

  it("plays a repeated section the stated number of passes", () => {
    const bars = plain(4);
    bars[1]!.repeat = { start: true };
    bars[2]!.repeat = { endCount: 2 };
    // endCount is passes, not extra passes: bars 1-2 twice, then on to 3.
    expect(playOrder(bars)).toEqual([0, 1, 2, 1, 2, 3]);
  });

  it("honours a pass count above two", () => {
    const bars = plain(3);
    bars[1]!.repeat = { start: true, endCount: 3 };
    expect(playOrder(bars)).toEqual([0, 1, 1, 1, 2]);
  });

  it("repeats from the top when there is no opening mark", () => {
    const bars = plain(3);
    bars[1]!.repeat = { endCount: 2 };
    expect(playOrder(bars)).toEqual([0, 1, 0, 1, 2]);
  });

  it("plays two sections independently", () => {
    const bars = plain(5);
    bars[0]!.repeat = { start: true };
    bars[1]!.repeat = { endCount: 2 };
    bars[2]!.repeat = { start: true };
    bars[3]!.repeat = { endCount: 2 };
    expect(playOrder(bars)).toEqual([0, 1, 0, 1, 2, 3, 2, 3, 4]);
  });

  it("treats a single pass as no repeat at all", () => {
    const bars = plain(2);
    bars[1]!.repeat = { endCount: 1 };
    expect(playOrder(bars)).toEqual([0, 1]);
  });

  it("terminates on a closing mark placed before its opening one", () => {
    // Malformed, but reachable from an import. A loop here would hang the tab,
    // so the only requirement is that it stops and stays finite.
    const bars = plain(3);
    bars[2]!.repeat = { start: true };
    bars[0]!.repeat = { endCount: 4 };
    const order = playOrder(bars);
    expect(order.length).toBeLessThan(bars.length * 64 + 1024 + 1);
    expect(order.length).toBeGreaterThan(0);
  });
});

describe("timeline", () => {
  it("places a quarter note at 120bpm half a second per beat", () => {
    const score = withNote(withNote(base(), 0, 0, 3), 0, 1, 5);
    const line = timeline(score);
    expect(line.notes).toHaveLength(2);
    expect(line.notes[0]?.startSeconds).toBeCloseTo(0, 6);
    expect(line.notes[1]?.startSeconds).toBeCloseTo(0.5, 6);
    expect(line.notes[0]?.durationSeconds).toBeCloseTo(0.5, 6);
  });

  it("gives four 4/4 bars at 120bpm eight seconds", () => {
    expect(timeline(base()).durationSeconds).toBeCloseTo(8, 6);
  });

  it("follows a tempo change from the bar it is written on", () => {
    const score = base();
    const bars = ids(score).bars;
    const fast = applyBatch(score, batch({ type: "bar.setTempo", barId: bars[2]!.id, tempoBpm: 240 }));
    const line = timeline(fast);
    // Bars 1-2 at 120 (4s), bars 3-4 at 240 (2s).
    expect(line.durationSeconds).toBeCloseTo(6, 6);
    expect(line.bars[2]?.startSeconds).toBeCloseTo(4, 6);
    expect(line.bars[2]?.endSeconds).toBeCloseTo(5, 6);
  });

  it("takes the tempo from whichever track states it", () => {
    // alphaTab applies tempo globally, so a score whose piano part carries the
    // mark must not play the guitar at the default.
    const score = base();
    const withPiano = applyBatch(
      score,
      batch({
        type: "track.insert",
        index: 1,
        track: { id: "t-piano", name: "Piano", instrument: { kind: "pitched", midiProgram: 0 }, bars: [] },
      }),
    );
    const marked = applyBatch(
      withPiano,
      batch({ type: "bar.setTempo", barId: ids(withPiano).bars[0]!.id, tempoBpm: 60 }),
    );
    expect(timeline(marked).durationSeconds).toBeCloseTo(16, 6);
  });

  it("halves a note's length when the beat is an eighth", () => {
    const score = withNote(base(), 0, 0, 7);
    const beat = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!;
    const eighth = applyBatch(
      score,
      batch({ type: "beat.setDuration", beatId: beat.id, duration: duration(8) }),
    );
    expect(timeline(eighth).notes[0]?.durationSeconds).toBeCloseTo(0.25, 6);
  });

  it("lengthens a dotted beat by half again", () => {
    const score = withNote(base(), 0, 0, 7);
    const beat = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!;
    const dotted = applyBatch(score, batch({ type: "beat.setDots", beatId: beat.id, dots: 1 }));
    const line = timeline(dotted);
    expect(line.notes[0]?.durationSeconds).toBeCloseTo(0.75, 6);
    // And the beat after it starts later, because the bar is longer.
    expect(line.bars[0]?.endSeconds).toBeCloseTo(2.25, 6);
  });

  it("sounds a chord's notes at the same moment", () => {
    const score = base();
    const beat = ids(score).voice.beats[0]!;
    const chord = applyBatch(
      score,
      batch(
        { type: "note.insert", beatId: beat.id, note: createNote(64, 1, 0) },
        { type: "note.insert", beatId: beat.id, note: createNote(59, 2, 0) },
        { type: "note.insert", beatId: beat.id, note: createNote(55, 3, 1) },
      ),
    );
    const line = timeline(chord);
    expect(line.notes).toHaveLength(3);
    expect(new Set(line.notes.map((n) => n.startSeconds)).size).toBe(1);
  });

  it("emits a note once per pass through a repeat", () => {
    const score = repeatMarks(withNote(base(), 1, 0, 9), 1, 2, 2);
    const line = timeline(score);
    const played = line.notes.filter((n) => n.fret === 9);
    expect(played).toHaveLength(2);
    // Second pass is two bars later: bar 1 at 2s, then 1-2 again from 6s.
    expect(played[0]?.startSeconds).toBeCloseTo(2, 6);
    expect(played[1]?.startSeconds).toBeCloseTo(6, 6);
    expect(line.durationSeconds).toBeCloseTo(12, 6);
  });

  it("keeps the written bar number on a repeated pass", () => {
    const score = repeatMarks(withNote(base(), 1, 0, 9), 1, 2, 2);
    const line = timeline(score);
    // Both passes are bar 1 as written, which is what a reader must display —
    // "bar 5 of 4" would be nonsense.
    expect(line.notes.filter((n) => n.fret === 9).map((n) => n.bar)).toEqual([1, 1]);
  });

  it("carries string and fret through, and omits them where there are none", () => {
    const score = withNote(base(), 0, 2, 12);
    const note = timeline(score).notes[0];
    expect(note?.string).toBe(1);
    expect(note?.fret).toBe(12);

    const beat = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!;
    const pitched = applyBatch(
      score,
      batch({
        type: "note.insert",
        beatId: beat.id,
        note: { id: "n-pitched", pitch: 60, articulations: [] },
      }),
    );
    const bare = timeline(pitched).notes.find((n) => n.id === "n-pitched");
    expect(bare).toBeDefined();
    expect("string" in (bare ?? {})).toBe(false);
  });

  it("reports the tail of a note that outlasts its bar line", () => {
    const score = withNote(base(), 3, 3, 5);
    const last = score.tracks[0]!.bars[3]!.voices[0]!.beats[3]!;
    const long = applyBatch(
      score,
      batch({ type: "beat.setDuration", beatId: last.id, duration: duration(1) }),
    );
    const line = timeline(long);
    // The bar's written beats now run past four quarters, so the score is longer
    // than four bars of 4/4 — the point is that the note is not cut off.
    const note = line.notes[0]!;
    expect(note.startSeconds + note.durationSeconds).toBeCloseTo(line.durationSeconds, 6);
  });

  it("handles an empty score without inventing time", () => {
    const empty: Score = { id: "s", title: "", artist: "", tracks: [], revision: 0 };
    const line = timeline(empty);
    expect(line.notes).toEqual([]);
    expect(line.bars).toEqual([]);
    expect(line.durationSeconds).toBe(0);
  });
});

describe("reading a timeline", () => {
  it("names the bar a moment falls in", () => {
    const line = timeline(base());
    expect(barAtSeconds(line, 0)).toBe(0);
    expect(barAtSeconds(line, 1.9)).toBe(0);
    expect(barAtSeconds(line, 2)).toBe(1);
    expect(barAtSeconds(line, 7.9)).toBe(3);
    expect(barAtSeconds(line, 8)).toBeNull();
  });

  it("returns notes overlapping a window, not only those starting in it", () => {
    const score = withNote(withNote(base(), 0, 0, 3), 0, 3, 8);
    const line = timeline(score);
    // 0.25s falls inside the first note, which started before the window.
    expect(notesInWindow(line, 0.25, 0.4).map((n) => n.fret)).toEqual([3]);
    expect(notesInWindow(line, 1.4, 2).map((n) => n.fret)).toEqual([8]);
    expect(notesInWindow(line, 3, 4)).toEqual([]);
  });
});

describe("bar length", () => {
  /**
   * `pnpm timing` found this against real playback: a bar in 4/4 holding one
   * quarter note still lasts a whole bar, and taking the written beats instead
   * ran a fixture 2.8 seconds ahead of what alphaTab plays.
   */
  it("lasts a full bar even when the written beats do not fill it", () => {
    const score = base();
    const voice = ids(score).voice;
    // Strip the first bar down to a single quarter, leaving it three short.
    const stripped = applyBatch(
      score,
      batch(
        { type: "beat.remove", voiceId: voice.id, beatId: voice.beats[3]!.id },
        { type: "beat.remove", voiceId: voice.id, beatId: voice.beats[2]!.id },
        { type: "beat.remove", voiceId: voice.id, beatId: voice.beats[1]!.id },
      ),
    );
    expect(stripped.tracks[0]!.bars[0]!.voices[0]!.beats).toHaveLength(1);
    const line = timeline(stripped);
    expect(line.bars[0]?.endSeconds).toBeCloseTo(2, 6);
    expect(line.bars[1]?.startSeconds).toBeCloseTo(2, 6);
    expect(line.durationSeconds).toBeCloseTo(8, 6);
  });

  it("takes the meter from wherever it is stated, and carries it forward", () => {
    const score = base();
    const bars = ids(score).bars;
    const in78 = applyBatch(
      score,
      batch({ type: "bar.setTimeSignature", barId: bars[1]!.id, timeSignature: { beats: 7, beatValue: 8 } }),
    );
    const line = timeline(in78);
    // Bar 1 onwards is 7/8: 3.5 quarters, 1.75s at 120bpm. Its written beats are
    // still four quarters, so the bar keeps the longer of the two.
    expect(line.bars[0]?.endSeconds).toBeCloseTo(2, 6);
    expect(line.bars[1]?.endSeconds).toBeCloseTo(4, 6);

    // A meter longer than the written beats does extend the bar.
    const in128 = applyBatch(
      score,
      batch({ type: "bar.setTimeSignature", barId: bars[1]!.id, timeSignature: { beats: 12, beatValue: 8 } }),
    );
    const wide = timeline(in128);
    expect(wide.bars[1]!.endSeconds - wide.bars[1]!.startSeconds).toBeCloseTo(3, 6);
    // And it carries to the bars after it, not just the one it is written on.
    expect(wide.bars[2]!.endSeconds - wide.bars[2]!.startSeconds).toBeCloseTo(3, 6);
  });

  it("keeps an overfull bar's extra length instead of clipping it", () => {
    const score = base();
    const voice = ids(score).voice;
    const stuffed = applyBatch(
      score,
      batch({ type: "beat.insert", voiceId: voice.id, index: 4, beat: { id: "extra", duration: duration(4), notes: [], dots: 0 } }),
    );
    // Five quarters written in a 4/4 bar: the fifth is not silently dropped.
    expect(timeline(stuffed).bars[0]?.endSeconds).toBeCloseTo(2.5, 6);
  });
});
