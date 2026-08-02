/**
 * A chord chart, played.
 *
 * The claims worth pinning: the output is ONE op, so it is one undo step; the notes
 * are real fingerings whose pitch, string and fret agree, because a comp track is
 * ordinary music and not decoration; the bars line up with the score's meter,
 * including where it changes; and everything the generator could not do is a rest
 * plus a sentence, never silence plus a guess.
 */
import { describe, expect, it } from "vitest";
import { applyBatch } from "./apply.js";
import { composeAccompaniment } from "./compose.js";
import { createScore, createTrack, frettedGuitar, pitchAt } from "./build.js";
import { chordPitchClasses, parseChord } from "./harmony.js";
import { invertBatch } from "./invert.js";
import { timeline } from "./timeline.js";
import type { Op, OpBatch, OpKind, Score } from "./index.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `cp-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `cp-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

/** A four-bar score charted C - Am - F - G, the way a writer would set it up. */
function charted(chords: Array<string | null> = ["C", "Am", "F", "G"], bars = 4): Score {
  const base: Score = { ...createScore("Song"), tracks: [createTrack("Guitar", frettedGuitar(), bars)] };
  const ops: OpKind[] = [];
  for (const [i, chord] of chords.entries()) {
    if (chord === null) continue;
    ops.push({ type: "beat.setChord", beatId: base.tracks[0]!.bars[i]!.voices[0]!.beats[0]!.id, chord });
  }
  return applyBatch(base, batch(...ops));
}

/** Every note of the accompaniment track, bar by bar. */
function compBars(score: Score) {
  const track = score.tracks.at(-1)!;
  return track.bars.map((bar) => bar.voices.flatMap((v) => v.beats));
}

describe("one edit", () => {
  it("is a single op, so a whole accompaniment is one undo step", () => {
    const song = charted();
    const { ops } = composeAccompaniment(song);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.type).toBe("track.insert");

    const one = batch(...ops);
    const withComp = applyBatch(song, one);
    expect(withComp.tracks).toHaveLength(2);
    const undone = applyBatch(withComp, batch(...invertBatch(song, one)));
    expect({ ...undone, revision: 0 }).toEqual({ ...song, revision: 0 });
  });

  it("adds a named, fretted track that the rest of the system treats as music", () => {
    const withComp = applyBatch(charted(), batch(...composeAccompaniment(charted()).ops));
    const track = withComp.tracks.at(-1)!;
    expect(track.name).toBe("Accompaniment");
    expect(track.instrument.kind).toBe("fretted");
    // The proof it is ordinary music: the timeline can place every note of it.
    const line = timeline(withComp);
    expect(line.notes.some((n) => n.trackIndex === withComp.tracks.length - 1)).toBe(true);
  });
});

describe("the notes are real fingerings", () => {
  it("gives every note a string, a fret, and a pitch that agree", () => {
    const song = charted();
    const withComp = applyBatch(song, batch(...composeAccompaniment(song).ops));
    const track = withComp.tracks.at(-1)!;
    let seen = 0;
    for (const bars of compBars(withComp)) {
      for (const beat of bars) {
        for (const note of beat.notes) {
          seen += 1;
          expect(note.string).toBeGreaterThanOrEqual(1);
          expect(note.fret).toBeGreaterThanOrEqual(0);
          expect(pitchAt(track.instrument, note.string!, note.fret!)).toBe(note.pitch);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("plays only the tones of the bar's chord", () => {
    const song = charted(["C", "Am", "F", "G"]);
    const withComp = applyBatch(song, batch(...composeAccompaniment(song).ops));
    const perBar = compBars(withComp);
    for (const [i, symbol] of ["C", "Am", "F", "G"].entries()) {
      const tones = chordPitchClasses(parseChord(symbol)!);
      for (const beat of perBar[i]!) {
        for (const note of beat.notes) expect(tones.has(note.pitch % 12), `${symbol} bar ${i}`).toBe(true);
      }
    }
  });

  it("voices the same symbol the same way every time it appears", () => {
    const song = charted(["C", "G", "C", "G"]);
    const withComp = applyBatch(song, batch(...composeAccompaniment(song).ops));
    const perBar = compBars(withComp);
    const signature = (bar: typeof perBar[number]) =>
      bar[0]!.notes.map((n) => `${n.string}:${n.fret}`).join(",");
    expect(signature(perBar[0]!)).toBe(signature(perBar[2]!));
    expect(signature(perBar[1]!)).toBe(signature(perBar[3]!));
  });
});

describe("patterns", () => {
  it("strums the chord on every written beat by default", () => {
    const song = charted();
    const withComp = applyBatch(song, batch(...composeAccompaniment(song).ops));
    for (const bar of compBars(withComp)) {
      expect(bar).toHaveLength(4);
      for (const beat of bar) expect(beat.notes.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("sustains one chord per bar as a single written value", () => {
    const song = charted();
    const withComp = applyBatch(song, batch(...composeAccompaniment(song, { pattern: "sustain" }).ops));
    for (const bar of compBars(withComp)) {
      expect(bar).toHaveLength(1);
      expect(bar[0]!.duration.denominator).toBe(1);
      // Held, so it rings the way a pad part should.
      for (const note of bar[0]!.notes) expect(note.articulations).toContain("letRing");
    }
  });

  it("writes a 3/4 sustain as a dotted half, not an overfull whole", () => {
    const base: Score = {
      ...createScore("Waltz"),
      tracks: [createTrack("Guitar", frettedGuitar(), 2, { beats: 3, beatValue: 4 })],
    };
    const song = applyBatch(
      base,
      batch({ type: "beat.setChord", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, chord: "C" }),
    );
    const withComp = applyBatch(song, batch(...composeAccompaniment(song, { pattern: "sustain" }).ops));
    const first = compBars(withComp)[0]!;
    expect(first).toHaveLength(1);
    expect(first[0]!.duration.denominator).toBe(2);
    expect(first[0]!.dots).toBe(1);
    // And the new track occupies exactly the score's bars: no drift against the meter.
    const line = timeline(withComp);
    expect(line.bars).toHaveLength(2);
  });

  it("arpeggiates in eighths, one chord tone at a time, all of them chord tones", () => {
    const song = charted(["Am", "Am", "Am", "Am"]);
    const withComp = applyBatch(song, batch(...composeAccompaniment(song, { pattern: "arpeggio" }).ops));
    const tones = chordPitchClasses(parseChord("Am")!);
    for (const bar of compBars(withComp)) {
      expect(bar).toHaveLength(8);
      for (const beat of bar) {
        expect(beat.notes).toHaveLength(1);
        expect(beat.duration.denominator).toBe(8);
        expect(tones.has(beat.notes[0]!.pitch % 12)).toBe(true);
      }
    }
  });

  it("starts each arpeggiated bar from the chord's bass", () => {
    const song = charted(["C/G", "C/G", "C/G", "C/G"]);
    const withComp = applyBatch(song, batch(...composeAccompaniment(song, { pattern: "arpeggio" }).ops));
    for (const bar of compBars(withComp)) {
      expect(bar[0]!.notes[0]!.pitch % 12).toBe(7);
    }
  });
});

describe("what it cannot do becomes a rest and a sentence", () => {
  it("leaves bars before the first chord as rests", () => {
    const song = charted([null, "Am", "F", "G"]);
    const { ops, report } = composeAccompaniment(song);
    const withComp = applyBatch(song, batch(...ops));
    const perBar = compBars(withComp);
    expect(perBar[0]!.every((beat) => beat.notes.length === 0)).toBe(true);
    expect(perBar[1]!.some((beat) => beat.notes.length > 0)).toBe(true);
    expect(report.barsSkipped).toBe(1);
    expect(report.notes.join(" ")).toMatch(/before the first chord/);
  });

  it("carries a chord across bars that do not restate it", () => {
    const song = charted(["C", null, null, "G"]);
    const withComp = applyBatch(song, batch(...composeAccompaniment(song).ops));
    const perBar = compBars(withComp);
    // Bars 2 and 3 are still C: a chart means the chord holds until the next one.
    const cTones = chordPitchClasses(parseChord("C")!);
    for (const beat of perBar[1]!) {
      for (const note of beat.notes) expect(cTones.has(note.pitch % 12)).toBe(true);
    }
    expect(composeAccompaniment(song).report.barsWritten).toBe(4);
  });

  it("skips a symbol nobody can read, and names it", () => {
    const song = charted(["C", "Hxyz", "F", "G"]);
    const { ops, report } = composeAccompaniment(song);
    const withComp = applyBatch(song, batch(...ops));
    const perBar = compBars(withComp);
    expect(perBar[1]!.every((beat) => beat.notes.length === 0)).toBe(true);
    expect(report.notes.join(" ")).toContain("Hxyz");
  });

  it("does nothing at all for a score with no chart", () => {
    const song = charted([null, null, null, null]);
    const { ops, report } = composeAccompaniment(song);
    expect(ops).toEqual([]);
    expect(report.notes).toEqual(["nothing to accompany"]);
  });

  it("falls back to a strum where a sustain cannot be written, and says so", () => {
    const base: Score = {
      ...createScore("Five"),
      tracks: [createTrack("Guitar", frettedGuitar(), 2, { beats: 5, beatValue: 4 })],
    };
    const song = applyBatch(
      base,
      batch({ type: "beat.setChord", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, chord: "C" }),
    );
    const { ops, report } = composeAccompaniment(song, { pattern: "sustain" });
    const withComp = applyBatch(song, batch(...ops));
    expect(compBars(withComp)[0]!.length).toBe(5);
    expect(report.notes.join(" ")).toMatch(/strummed/);
  });
});
