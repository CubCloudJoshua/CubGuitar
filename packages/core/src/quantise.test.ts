/**
 * The quantiser, graded against the forward direction it inverts.
 *
 * The central test here is a round trip, and it is worth saying why that is the
 * right shape rather than a convenient one. A quantiser has no ground truth of its
 * own — "did it hear the rhythm correctly" is a judgement about a performance nobody
 * in the test has heard. But `timeline()` is the exact inverse operation and we own
 * it, so a score can generate its own detected notes: play it forward, hand the
 * result back, and demand the same music. Any rhythm the pair cannot preserve shows
 * up as a difference rather than as an opinion.
 *
 * That is also the whole design of `pnpm transcribe`, at unit scale and with no
 * browser: this file is the oracle's argument, checked on cases small enough to read.
 */
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  createScore,
  createTrack,
  duration,
  frettedGuitar,
  pitchAt,
  timeline,
  type Op,
  type OpBatch,
  type OpKind,
  type Score,
} from "./index.js";
import { chooseGrid, decomposeTicks, estimateTempo, quantise, type DetectedNote } from "./quantise.js";
import { QUARTER_TICKS } from "./timeline.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `q-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `q-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

/** Detected notes as a perfect detector would report them: the timeline itself. */
function detect(score: Score): DetectedNote[] {
  return timeline(score)
    .notes.map((n) => ({
      pitch: n.pitch,
      startSeconds: n.startSeconds,
      durationSeconds: n.durationSeconds,
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);
}

/** The rhythm as written: one entry per beat, in ticks, rests marked. */
function rhythm(score: Score): string[] {
  const out: string[] = [];
  for (const bar of score.tracks[0]!.bars) {
    for (const beat of bar.voices[0]!.beats) {
      const base = (QUARTER_TICKS * 4 * beat.duration.numerator) / beat.duration.denominator;
      const ticks = beat.dots === 0 ? base : beat.dots === 1 ? base * 1.5 : base * 1.75;
      out.push(beat.notes.length === 0 ? `rest:${ticks}` : `${ticks}:${beat.notes.map((n) => n.pitch).sort((a, b) => a - b).join(".")}`);
    }
  }
  return out;
}

/** Every bar's beats must sum to the meter, or every consumer downstream is wrong. */
function barSums(score: Score): number[] {
  return score.tracks[0]!.bars.map((bar) =>
    bar.voices[0]!.beats.reduce((total, beat) => {
      const base = (QUARTER_TICKS * 4 * beat.duration.numerator) / beat.duration.denominator;
      return total + (beat.dots === 0 ? base : beat.dots === 1 ? base * 1.5 : base * 1.75);
    }, 0),
  );
}

/** A one-track score of quarter notes at 120, four to the bar. */
function quarters(pitches: number[][], bars = 2): Score {
  const base: Score = {
    ...createScore("Quarters"),
    tracks: [createTrack("Guitar", frettedGuitar(), bars)],
  };
  const kinds: OpKind[] = [];
  for (const [i, chord] of pitches.entries()) {
    const bar = Math.floor(i / 4);
    const beatIndex = i % 4;
    const beat = base.tracks[0]!.bars[bar]?.voices[0]?.beats[beatIndex];
    if (!beat) continue;
    // A distinct string each, because `note.insert` replaces the note on a string:
    // a chord written entirely on string 1 collapses to its last note, which made an
    // earlier version of these tests assert against one-note "chords".
    for (const [s, pitch] of chord.entries()) {
      kinds.push({
        type: "note.insert",
        beatId: beat.id,
        note: { id: `qn-${i}-${pitch}`, pitch, string: s + 1, fret: 0, articulations: [] },
      });
    }
  }
  return applyBatch(base, batch(...kinds));
}

describe("decomposing a span into notatable durations", () => {
  it("writes an exact value as one beat", () => {
    expect(decomposeTicks(QUARTER_TICKS)).toEqual([{ duration: duration(4), dots: 0 }]);
  });

  it("writes five sixteenths as a quarter tied to a sixteenth", () => {
    const pieces = decomposeTicks(QUARTER_TICKS * 1.25);
    expect(pieces).toEqual([
      { duration: duration(4), dots: 0 },
      { duration: duration(16), dots: 0 },
    ]);
  });

  it("prefers a dotted note to two tied ones", () => {
    // Three eighths is a dotted quarter, which is how it is read, not quarter + 8th.
    expect(decomposeTicks(QUARTER_TICKS * 1.5)).toEqual([{ duration: duration(4), dots: 1 }]);
  });

  it("refuses a span shorter than it can notate rather than inventing one", () => {
    expect(decomposeTicks(1)).toEqual([]);
    expect(decomposeTicks(0)).toEqual([]);
  });

  const sumOf = (span: number) =>
    decomposeTicks(span).reduce((sum, piece) => {
      const base = (QUARTER_TICKS * 4 * piece.duration.numerator) / piece.duration.denominator;
      return sum + (piece.dots === 0 ? base : piece.dots === 1 ? base * 1.5 : base * 1.75);
    }, 0);

  it("always sums back to the span it was given", () => {
    // Every multiple of a 32nd note (120 ticks), which is every span the snapper can
    // hand it: positions come off a grid no finer than a 32nd.
    for (const span of [120, 240, 480, 600, 720, 960, 1200, 1680, 3840, 4920, 7680]) {
      expect(sumOf(span)).toBe(span);
    }
  });

  it("never overshoots a span it cannot express exactly", () => {
    // 5000 ticks is not a multiple of a 32nd. Writing more than was asked for would
    // push every following bar out of alignment, so the remainder is dropped.
    for (const span of [5000, 1001, 359]) {
      expect(sumOf(span)).toBeLessThanOrEqual(span);
      expect(span - sumOf(span)).toBeLessThan(120);
    }
  });
});

describe("estimating tempo from onsets", () => {
  it("recovers a stated tempo from clean quarter notes", () => {
    // Quarters at 120 BPM are half a second apart.
    const onsets = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
    expect(estimateTempo(onsets).bpm).toBe(120);
  });

  it("recovers a tempo that is not a round number", () => {
    const bpm = 138;
    const onsets = Array.from({ length: 12 }, (_, i) => (i * 60) / bpm);
    expect(estimateTempo(onsets).bpm).toBeCloseTo(bpm, 0);
  });

  it("settles the octave tie at the tempo a listener would hear", () => {
    // 60, 120 and 240 BPM all explain half-second onsets perfectly and no residual
    // separates them: at 60 these are eighths, at 120 quarters, at 240 halves. The
    // tie is broken toward 120, and the other two readings are offered by name.
    const onsets = [0, 0.5, 1, 1.5, 2, 2.5];
    const { bpm, alternatives } = estimateTempo(onsets);
    expect(bpm).toBe(120);
    expect(alternatives).toEqual([60, 240]);
  });

  it("does not drag a genuinely fast tempo back toward the middle", () => {
    // 200 BPM with sixteenth-note content: a sixteenth is 0.075s. Halving to 100
    // cannot explain it, because at 100 BPM a sixteenth is 0.15s and the odd
    // positions fall between two grid lines. So the preference for 120 has to yield
    // to the evidence here, which is the case that keeps it from being a bias.
    const sixteenth = 0.075;
    // Long enough to tell 200 from 199: over one bar the two are indistinguishable,
    // which is a real limit of the evidence rather than a fault in the estimator.
    const pattern = [0, 1, 2, 4, 5, 6, 8, 10, 11, 12];
    const onsets = Array.from({ length: 5 }, (_, bar) =>
      pattern.map((k) => (bar * 16 + k) * sixteenth),
    ).flat();
    expect(estimateTempo(onsets).bpm).toBeCloseTo(200, 0);
  });

  it("does not read fine subdivisions as a slower tempo", () => {
    // The mirror of the case above. Sixteenths at 120 are 0.125s apart; at 60 BPM
    // the odd ones do not land on the grid, so 60 is not available however much the
    // old slowest-that-fits rule would have liked it.
    const onsets = [0, 1, 2, 4, 5, 8].map((k) => k * 0.125);
    expect(estimateTempo(onsets).bpm).toBe(120);
  });

  it("answers the default rather than guessing from one onset", () => {
    expect(estimateTempo([]).bpm).toBe(120);
    expect(estimateTempo([1.7]).bpm).toBe(120);
  });

  it("is not thrown by silence before the first note", () => {
    const late = [4, 4.5, 5, 5.5, 6, 6.5];
    expect(estimateTempo(late).bpm).toBe(120);
  });
});

describe("choosing the grid from the material", () => {
  it("stays coarse for music that is coarse", () => {
    // Quarter notes at 120. A finer grid would buy nothing and cost readability.
    const onsets = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    expect(chooseGrid(onsets, 120, 0.05)).toBe(8);
  });

  it("goes fine enough to separate fast notes", () => {
    // The case `pnpm transcribe` found: a 146 BPM track whose fastest figures are
    // about 51ms apart. A 1/16 grid steps 103ms there, so every one of those pairs
    // landed on one position and two notes became a chord.
    const onsets = Array.from({ length: 16 }, (_, i) => i * 0.0514);
    expect(chooseGrid(onsets, 146, 0.05)).toBe(32);
  });

  it("is not driven finer by a chord", () => {
    // Four strings of one strum, 12ms apart, then quarter notes. The strum is a
    // simultaneity, not a rhythm, so it must not force a 32nd grid on the piece.
    const onsets = [0, 0.012, 0.024, 0.036, 0.5, 1, 1.5, 2];
    expect(chooseGrid(onsets, 120, 0.05)).toBe(8);
  });

  it("recovers a fast passage a fixed 1/16 grid would flatten", () => {
    // The regression the oracle caught, at unit scale. 32nd notes at 146 BPM.
    const step = 60 / 146 / 8;
    const run = Array.from({ length: 12 }, (_, i) => ({
      pitch: 64 + (i % 5),
      startSeconds: i * step,
      durationSeconds: step,
    }));
    const coarse = quantise(run, { bpm: 146, grid: 16, instrument: frettedGuitar() });
    const auto = quantise(run, { bpm: 146, instrument: frettedGuitar() });
    // The coarse grid cannot tell these apart and says so; auto keeps them separate.
    expect(coarse.report.mergedByGrid).toBeGreaterThan(0);
    expect(auto.report.mergedByGrid).toBe(0);
    expect(auto.report.grid).toBe(32);
    // Which is the difference between twelve notes in twelve places and twelve notes
    // stacked into six chords.
    const beatsWithNotes = auto.score.tracks[0]!.bars
      .flatMap((b) => b.voices[0]!.beats)
      .filter((b) => b.notes.length > 0);
    expect(beatsWithNotes).toHaveLength(12);
  });

  it("lets a caller who knows the music override it", () => {
    const onsets = Array.from({ length: 8 }, (_, i) => ({
      pitch: 64,
      startSeconds: i * 0.0514,
      durationSeconds: 0.05,
    }));
    expect(quantise(onsets, { bpm: 146, grid: 8 }).report.grid).toBe(8);
  });
});

describe("a score through the timeline and back", () => {
  it("recovers the rhythm and the pitches exactly", () => {
    const original = quarters([[64], [66], [67], [69], [71], [72], [74], [76]]);
    const { score, report } = quantise(detect(original), {
      bpm: 120,
      instrument: frettedGuitar(),
    });
    expect(rhythm(score)).toEqual(rhythm(original));
    expect(report.notesPlaced).toBe(8);
    expect(report.notesDropped).toBe(0);
  });

  it("puts the onsets back where they came from", () => {
    const original = quarters([[64], [67], [71], [64], [66], [69], [72], [66]]);
    const before = timeline(original).notes.map((n) => n.startSeconds);
    const { score } = quantise(detect(original), { bpm: 120, instrument: frettedGuitar() });
    const after = timeline(score).notes.map((n) => n.startSeconds);
    expect(after).toEqual(before);
  });

  it("reports a perfect fit when the input is perfect", () => {
    const { report } = quantise(detect(quarters([[64], [66], [67], [69]])), { bpm: 120 });
    expect(report.gridFit).toBe(1);
    expect(report.onsetShift.max).toBeCloseTo(0, 9);
    expect(report.bpmStated).toBe(true);
  });

  it("finds the tempo on its own when none is stated", () => {
    const original = quarters([[64], [66], [67], [69], [71], [72], [74], [76]]);
    const { report } = quantise(detect(original), { instrument: frettedGuitar() });
    expect(report.bpm).toBe(120);
    expect(report.bpmStated).toBe(false);
    // And it says so, because a guessed tempo is the number to distrust.
    expect(report.notes.join(" ")).toMatch(/estimated/);
  });
});

describe("what a real detector hands over", () => {
  /** Deterministic jitter: no clock, no randomness, same answer every run. */
  const jitter = (notes: DetectedNote[], seconds: number): DetectedNote[] =>
    notes.map((n, i) => ({
      ...n,
      // A fixed alternating pattern, so half the notes are early and half late.
      startSeconds: Math.max(0, n.startSeconds + (i % 2 === 0 ? seconds : -seconds)),
    }));

  it("recovers the same rhythm through human-sized timing error", () => {
    const original = quarters([[64], [66], [67], [69], [71], [72], [74], [76]]);
    // 25ms either way. A tight player is around this; a sloppy one is worse.
    const { score, report } = quantise(jitter(detect(original), 0.025), {
      bpm: 120,
      instrument: frettedGuitar(),
    });
    expect(rhythm(score)).toEqual(rhythm(original));
    expect(report.notesPlaced).toBe(8);
  });

  it("absorbs a constant lag, because the grid is measured from the first onset", () => {
    // A detector with a fixed latency, or a player sitting behind the beat the whole
    // way: every onset is 30ms late and the rhythm is perfect. Measuring from the
    // first onset removes a shift shared by every note, with no phase search needed.
    const original = quarters([[64], [66], [67], [69], [71], [72], [74], [76]]);
    const late = detect(original).map((n) => ({ ...n, startSeconds: n.startSeconds + 0.03 }));
    const { score, report } = quantise(late, { bpm: 120, instrument: frettedGuitar() });
    expect(report.onsetShift.max).toBeLessThan(0.005);
    expect(report.gridFit).toBe(1);
    expect(rhythm(score)).toEqual(rhythm(original));
  });

  it("does not charge every note for the first one being late", () => {
    // The case the phase search exists for, and the one measuring from the first
    // onset gets wrong on its own: a hesitant or early first attack becomes the
    // origin of the grid, so all seven notes behind it are reported as displaced
    // when it is the pickup that moved. Nineteen of twenty transcriptions start with
    // a note whose timing is the least reliable in the file.
    const original = quarters([[64], [66], [67], [69], [71], [72], [74], [76]]);
    const heard = detect(original);
    const nudged = heard.map((n, i) => (i === 0 ? { ...n, startSeconds: n.startSeconds + 0.04 } : n));
    const { score, report } = quantise(nudged, { bpm: 120, instrument: frettedGuitar() });
    // Most notes land clean. Without the phase search this is 1/8, because the seven
    // accurate notes are measured against the one inaccurate one.
    expect(report.gridFit).toBeGreaterThanOrEqual(0.7);
    expect(report.onsetShift.mean).toBeLessThan(0.01);
    expect(rhythm(score)).toEqual(rhythm(original));
  });

  it("says how far it had to move the notes", () => {
    const original = quarters([[64], [66], [67], [69]]);
    // 20ms alternating, so each gap is 40ms out against a 125ms grid step. Larger
    // than this is not a measurement of the report but of where snapping breaks
    // down, which the wrong-tempo test below covers on purpose.
    const { report } = quantise(jitter(detect(original), 0.02), { bpm: 120 });
    expect(report.onsetShift.max).toBeGreaterThan(0.01);
    expect(report.onsetShift.max).toBeLessThan(0.05);
  });

  it("reports a poor fit when the tempo it was given is wrong", () => {
    // The same performance read at a tempo that does not divide it. This is the
    // signal that tells a user to try half or double, and the one the oracle grades.
    const original = quarters([[64], [66], [67], [69], [71], [72], [74], [76]]);
    const right = quantise(detect(original), { bpm: 120 }).report;
    const wrong = quantise(detect(original), { bpm: 97 }).report;
    expect(wrong.gridFit).toBeLessThan(right.gridFit);
    expect(wrong.onsetShift.p95).toBeGreaterThan(right.onsetShift.p95);
  });

  it("gives the same answer whatever order the detector reports in", () => {
    // A detector emits notes as it finds them, which is not necessarily in time
    // order — a polyphonic pass may finish a low voice before starting a high one.
    const heard = detect(quarters([[64], [66], [67], [69]]));
    const forward = quantise(heard, { bpm: 120, instrument: frettedGuitar() });
    const backward = quantise([...heard].reverse(), { bpm: 120, instrument: frettedGuitar() });
    expect(rhythm(backward.score)).toEqual(rhythm(forward.score));
    expect(backward.report.notesPlaced).toBe(4);
    expect(forward.report.notesPlaced).toBe(4);
  });

  it("ignores a note with no usable onset instead of writing a bar at infinity", () => {
    const notes: DetectedNote[] = [
      { pitch: 64, startSeconds: 0, durationSeconds: 0.5 },
      { pitch: 66, startSeconds: Number.NaN, durationSeconds: 0.5 },
      { pitch: 67, startSeconds: -1, durationSeconds: 0.5 },
      { pitch: 69, startSeconds: 0.5, durationSeconds: 0.5 },
    ];
    const { report, score } = quantise(notes, { bpm: 120 });
    expect(report.notesPlaced).toBe(2);
    expect(report.notes.join(" ")).toMatch(/no usable pitch or onset/);
    expect(barSums(score).every((sum) => sum === QUARTER_TICKS * 4)).toBe(true);
  });

  it("rounds a detector's fractional pitch to a real note", () => {
    // A detector reports cents; 64.3 is an E played a little sharp, not a new pitch.
    const { score } = quantise([{ pitch: 64.3, startSeconds: 0, durationSeconds: 2 }], { bpm: 120 });
    expect(score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]?.pitch).toBe(64);
  });
});

describe("chords, rests and bar lines", () => {
  it("writes notes that sound together as one beat", () => {
    const original = quarters([[52, 55, 59, 64], [57], [59], [60]]);
    const { score, report } = quantise(detect(original), { bpm: 120, instrument: frettedGuitar() });
    expect(report.chordsFormed).toBe(1);
    expect(score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes).toHaveLength(4);
  });

  it("keeps a strum as one chord rather than four sixteenths", () => {
    // A strummed chord's strings do not start together; 12ms apart is a fast strum.
    const strum: DetectedNote[] = [52, 55, 59, 64].map((pitch, i) => ({
      pitch,
      startSeconds: i * 0.012,
      durationSeconds: 1,
    }));
    const { score, report } = quantise(strum, { bpm: 120, instrument: frettedGuitar() });
    expect(report.chordsFormed).toBe(1);
    expect(score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes).toHaveLength(4);
  });

  it("merges onsets the grid cannot separate instead of losing one", () => {
    // 60ms apart at 120 BPM: too far apart to be a strum (the chord window is 50ms),
    // too close to be separated by a 1/16 grid whose step is 125ms. Both therefore
    // snap to tick 0, and the two have to become one beat.
    //
    // Leaving them as two beats at the same tick is the failure worth naming: the
    // second one's span to "the next onset" is zero, so it is dropped, and a note the
    // detector heard vanishes with nothing said about it.
    const notes: DetectedNote[] = [
      { pitch: 64, startSeconds: 0, durationSeconds: 0.5 },
      { pitch: 67, startSeconds: 0.06, durationSeconds: 0.5 },
      { pitch: 69, startSeconds: 1.0, durationSeconds: 0.5 },
    ];
    // The grid is pinned, because this is the collapse path and `"auto"` exists to
    // avoid it: given these onsets it would choose a 32nd grid and separate them.
    const { score, report } = quantise(notes, { bpm: 120, grid: 16, instrument: frettedGuitar() });
    expect(report.notesPlaced).toBe(3);
    expect(report.notesDropped).toBe(0);
    expect(report.mergedByGrid).toBe(1);
    const first = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!;
    expect(first.notes.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([64, 67]);
    // And it says so, rather than quietly rewriting a melody into a chord.
    expect(report.notes.join(" ")).toMatch(/shared a 1\/16 grid position/);
    expect(barSums(score)).toEqual(score.tracks[0]!.bars.map(() => QUARTER_TICKS * 4));
  });

  it("writes a rest where the detector heard silence", () => {
    // A note on beat 1, then nothing until beat 3.
    const notes: DetectedNote[] = [
      { pitch: 64, startSeconds: 0, durationSeconds: 0.5 },
      { pitch: 67, startSeconds: 1.5, durationSeconds: 0.5 },
    ];
    const { score, report } = quantise(notes, { bpm: 120, instrument: frettedGuitar() });
    expect(report.restsWritten).toBeGreaterThan(0);
    expect(rhythm(score).some((r) => r.startsWith("rest"))).toBe(true);
  });

  it("does not turn a performer's short note into a rest", () => {
    // Every note released just early. That is articulation, not written silence.
    const notes: DetectedNote[] = [0, 0.5, 1, 1.5].map((startSeconds, i) => ({
      pitch: 64 + i,
      startSeconds,
      durationSeconds: 0.46,
    }));
    const { score } = quantise(notes, { bpm: 120, instrument: frettedGuitar() });
    expect(rhythm(score).filter((r) => r.startsWith("rest"))).toHaveLength(0);
  });

  /**
   * A note on beat 1, then a note on beat 4 held for two beats so it crosses into
   * bar 2. Two notes rather than one, because the grid is measured from the first
   * onset: a lone note at 1.5s becomes tick 0 and crosses nothing.
   */
  const acrossTheBarLine: DetectedNote[] = [
    { pitch: 64, startSeconds: 0, durationSeconds: 0.5 },
    { pitch: 67, startSeconds: 1.5, durationSeconds: 1 },
  ];

  it("ties a note that crosses a bar line instead of restarting it", () => {
    const { score } = quantise(acrossTheBarLine, { bpm: 120, instrument: frettedGuitar() });
    const held = score.tracks[0]!.bars
      .flatMap((b) => b.voices[0]!.beats)
      .filter((b) => b.notes.some((n) => n.pitch === 67));
    // Written as two beats, the first tied into the second.
    expect(held.length).toBe(2);
    expect(held[0]!.notes[0]?.tiedToNext).toBe(true);
    expect(held[1]!.notes[0]?.tiedToNext).toBeUndefined();
  });

  it("counts a note split across a bar line once, not twice", () => {
    const { report } = quantise(acrossTheBarLine, { bpm: 120 });
    expect(report.notesPlaced).toBe(2);
    expect(report.notesDropped).toBe(0);
  });

  it("fills every bar to its meter, always", () => {
    const cases: DetectedNote[][] = [
      [{ pitch: 64, startSeconds: 0, durationSeconds: 0.3 }],
      [{ pitch: 64, startSeconds: 0.37, durationSeconds: 2.9 }],
      [64, 66, 67, 69, 71].map((pitch, i) => ({ pitch, startSeconds: i * 0.31, durationSeconds: 0.2 })),
      detect(quarters([[64], [66], [67], [69], [71], [72], [74], [76]])),
    ];
    for (const notes of cases) {
      const { score } = quantise(notes, { bpm: 120, instrument: frettedGuitar() });
      expect(barSums(score)).toEqual(score.tracks[0]!.bars.map(() => QUARTER_TICKS * 4));
    }
  });

  it("fills every bar to a meter that is not four four", () => {
    const notes: DetectedNote[] = [0, 0.5, 1, 1.5, 2].map((startSeconds, i) => ({
      pitch: 64 + i,
      startSeconds,
      durationSeconds: 0.5,
    }));
    const { score } = quantise(notes, { bpm: 120, meter: { beats: 3, beatValue: 4 } });
    expect(barSums(score)).toEqual(score.tracks[0]!.bars.map(() => QUARTER_TICKS * 3));
  });

  it("survives an empty detection without producing a broken score", () => {
    const { score, report } = quantise([], { bpm: 120 });
    expect(report.notesPlaced).toBe(0);
    expect(score.tracks[0]!.bars.length).toBeGreaterThan(0);
    expect(barSums(score)).toEqual(score.tracks[0]!.bars.map(() => QUARTER_TICKS * 4));
  });
});

describe("the fretboard", () => {
  it("fingers what it wrote", () => {
    const original = quarters([[64], [66], [67], [69]]);
    const { score } = quantise(detect(original), { bpm: 120, instrument: frettedGuitar() });
    const notes = score.tracks[0]!.bars.flatMap((b) => b.voices[0]!.beats).flatMap((b) => b.notes);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.string).toBeGreaterThanOrEqual(1);
      expect(note.string).toBeLessThanOrEqual(6);
      expect(note.fret).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves a pitched staff unfingered rather than inventing strings", () => {
    const { score } = quantise([{ pitch: 64, startSeconds: 0, durationSeconds: 2 }], { bpm: 120 });
    const note = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0];
    expect(note?.pitch).toBe(64);
    expect(note?.string).toBeUndefined();
    expect(note?.fret).toBeUndefined();
  });

  it("never writes a fret that sounds a different note than the one written", () => {
    // The invariant that matters most, and the one that broke. `fingerSequence`
    // returns a compacted answer — a pitch it cannot place leaves no entry — so
    // indexing it by pitch position hands every note after an unplaceable one the
    // fingering meant for a different pitch. The result is a tab that is confidently
    // wrong, which is worse than one that admits a gap.
    //
    // 30 is two octaves under a guitar's low E, so it cannot be placed; 64 and 67 can.
    const guitar = frettedGuitar();
    const chord: DetectedNote[] = [30, 64, 67].map((pitch) => ({
      pitch,
      startSeconds: 0,
      durationSeconds: 1,
    }));
    const { score } = quantise(chord, { bpm: 120, instrument: guitar });
    const written = score.tracks[0]!.bars.flatMap((b) => b.voices[0]!.beats).flatMap((b) => b.notes);
    expect(written.length).toBeGreaterThan(0);
    for (const note of written) {
      if (note.string === undefined || note.fret === undefined) continue;
      expect(pitchAt(guitar, note.string, note.fret)).toBe(note.pitch);
    }
    // And the reachable notes did get fingered rather than all being dropped.
    expect(written.filter((n) => n.string !== undefined).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a unison across two strings as two fingerings, not one reused", () => {
    // E4 twice: string 1 open and string 2 fret 5. A pitch-keyed lookup that held one
    // entry per pitch would hand both notes the same string.
    const guitar = frettedGuitar();
    const unison: DetectedNote[] = [64, 64].map((pitch) => ({
      pitch,
      startSeconds: 0,
      durationSeconds: 1,
    }));
    const { score } = quantise(unison, { bpm: 120, instrument: guitar });
    const fingered = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes.filter(
      (n) => n.string !== undefined,
    );
    const strings = new Set(fingered.map((n) => n.string));
    expect(strings.size).toBe(fingered.length);
    for (const note of fingered) {
      expect(pitchAt(guitar, note.string!, note.fret!)).toBe(64);
    }
  });

  it("reports a pitch the instrument cannot reach instead of losing it quietly", () => {
    // Two octaves below a guitar's low E.
    const { report } = quantise([{ pitch: 16, startSeconds: 0, durationSeconds: 2 }], {
      bpm: 120,
      instrument: frettedGuitar(),
    });
    expect(report.unreachable).toContain(16);
    expect(report.notes.join(" ")).toMatch(/outside the instrument's range/);
  });

  it("keeps the hand still across a phrase rather than fingering note by note", () => {
    // Every pitch here is reachable in several places, so a solver working one note
    // at a time can scatter a six-note scale across the neck. What this asserts is
    // the property that makes a tab playable: consecutive notes stay near each other.
    // fingerSequence solves the phrase as a unit; this checks the quantiser hands it
    // the whole phrase rather than calling it per note.
    const run = [64, 65, 67, 69, 71, 72].map((pitch, i) => ({
      pitch,
      startSeconds: i * 0.5,
      durationSeconds: 0.5,
    }));
    const { score } = quantise(run, { bpm: 120, instrument: frettedGuitar() });
    const frets = score.tracks[0]!.bars
      .flatMap((b) => b.voices[0]!.beats)
      .flatMap((b) => b.notes)
      .map((n) => n.fret ?? -1);
    expect(frets).toHaveLength(6);
    expect(frets.every((f) => f >= 0)).toBe(true);
    const jumps = frets.slice(1).map((f, i) => Math.abs(f - frets[i]!));
    expect(Math.max(...jumps)).toBeLessThanOrEqual(5);
  });
});

describe("the tempo it carries", () => {
  it("writes the tempo onto the score so playback agrees with the transcription", () => {
    const { score } = quantise(detect(quarters([[64], [66]])), { bpm: 96 });
    expect(score.tracks[0]!.bars[0]!.tempoBpm).toBe(96);
    // And the timeline made from it reads back at that tempo: a quarter is 0.625s.
    const line = timeline(score);
    expect(line.tempoChanges[0]?.bpm).toBe(96);
  });

  it("counts the onsets a triplet would have fitted better", () => {
    // Eighth-note triplets at 120: three to the half note, so 1/3 second apart.
    const triplets = Array.from({ length: 6 }, (_, i) => ({
      pitch: 64,
      startSeconds: i / 3,
      durationSeconds: 1 / 3,
    }));
    const { report } = quantise(triplets, { bpm: 120, grid: 16 });
    expect(report.tripletsWanted).toBeGreaterThan(0);
    expect(report.notes.join(" ")).toMatch(/triplet/);
  });

  it("does not cry triplet over a straight rhythm", () => {
    const { report } = quantise(detect(quarters([[64], [66], [67], [69]])), { bpm: 120 });
    expect(report.tripletsWanted).toBe(0);
  });
});
