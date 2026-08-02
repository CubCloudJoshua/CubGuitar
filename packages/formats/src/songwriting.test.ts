/**
 * Chords, lyrics and sections through the alphaTex round trip.
 *
 * The note counts round-trip exactly and always have; what these check is the layer
 * the corpus comparison cannot see. A chord symbol that silently vanishes between
 * the editor and the engraver still leaves every pitch in place — the only failed
 * party is the songwriter, whose chart is gone.
 *
 * The trip under test is the real one: our model → toAlphaTex → alphaTab's parser →
 * fromAlphaTab → our model. Both directions of both converters, judged by an
 * independent parser in the middle.
 */
import { describe, expect, it } from "vitest";
import * as alphaTab from "@coderline/alphatab";
import { fromAlphaTab } from "./from-alphatab.js";
import {
  applyBatch,
  createScore,
  createTrack,
  frettedGuitar,
  toAlphaTex,
  type Op,
  type OpBatch,
  type OpKind,
  type Score,
} from "@cubscore/core";

function parse(tex: string): alphaTab.model.Score {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  return importer.readScore();
}

/** Our model, out through tex, in through alphaTab, back to our model. */
function roundTrip(score: Score): Score {
  return fromAlphaTab(parse(toAlphaTex(score))).score;
}

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `swf-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `swf-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

/** A charted, sectioned, sung four-bar song built through ops like real edits. */
function song(): Score {
  const base: Score = { ...createScore("Round trip"), tracks: [createTrack("Guitar", frettedGuitar(), 4)] };
  const beat = (bar: number, i = 0) => base.tracks[0]!.bars[bar]!.voices[0]!.beats[i]!.id;
  const bar = (i: number) => base.tracks[0]!.bars[i]!.id;
  return applyBatch(
    base,
    batch(
      { type: "bar.setSection", barId: bar(0), section: "Verse" },
      { type: "bar.setSection", barId: bar(2), section: "Chorus" },
      { type: "beat.setChord", beatId: beat(0), chord: "Am7" },
      { type: "beat.setChord", beatId: beat(1), chord: "F" },
      { type: "beat.setChord", beatId: beat(2), chord: "C/G" },
      { type: "beat.setLyric", beatId: beat(0), lyric: "down" },
      { type: "beat.setLyric", beatId: beat(0, 1), lyric: "by" },
      { type: "beat.setLyric", beatId: beat(1), lyric: "the" },
    ),
  );
}

const beatsOf = (s: Score, bar: number) => s.tracks[0]!.bars[bar]!.voices[0]!.beats;

describe("through alphaTab and back", () => {
  it("keeps every chord symbol on its beat", () => {
    const back = roundTrip(song());
    expect(beatsOf(back, 0)[0]?.chord).toBe("Am7");
    expect(beatsOf(back, 1)[0]?.chord).toBe("F");
    expect(beatsOf(back, 2)[0]?.chord).toBe("C/G");
    // Beats that carried no chord still carry none: a chart is sparse on purpose.
    expect(beatsOf(back, 0)[1]?.chord).toBeUndefined();
    expect(beatsOf(back, 3)[0]?.chord).toBeUndefined();
  });

  it("keeps every syllable where it was sung", () => {
    const back = roundTrip(song());
    expect(beatsOf(back, 0)[0]?.lyric).toBe("down");
    expect(beatsOf(back, 0)[1]?.lyric).toBe("by");
    expect(beatsOf(back, 1)[0]?.lyric).toBe("the");
    expect(beatsOf(back, 1)[1]?.lyric).toBeUndefined();
  });

  it("keeps the song structure", () => {
    const back = roundTrip(song());
    expect(back.tracks[0]!.bars[0]!.section).toBe("Verse");
    expect(back.tracks[0]!.bars[2]!.section).toBe("Chorus");
    expect(back.tracks[0]!.bars[1]!.section).toBeUndefined();
    expect(back.tracks[0]!.bars[3]!.section).toBeUndefined();
  });

  it("survives a second lap unchanged, so the trip has a fixed point", () => {
    const once = roundTrip(song());
    const twice = roundTrip(once);
    const flatten = (s: Score) =>
      s.tracks[0]!.bars.map((bar) => ({
        section: bar.section ?? null,
        beats: bar.voices[0]!.beats.map((b) => ({ chord: b.chord ?? null, lyric: b.lyric ?? null })),
      }));
    expect(flatten(twice)).toEqual(flatten(once));
  });

  it("does not lose the notes while carrying the words", () => {
    const base: Score = { ...createScore("Both"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const withNote = applyBatch(
      base,
      batch(
        { type: "note.insert", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, note: { id: "n1", pitch: 64, string: 1, fret: 0, articulations: [] } },
        { type: "beat.setChord", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, chord: "Em" },
      ),
    );
    const back = roundTrip(withNote);
    const beat = beatsOf(back, 0)[0]!;
    expect(beat.chord).toBe("Em");
    expect(beat.notes).toHaveLength(1);
    expect(beat.notes[0]?.pitch).toBe(64);
  });

  it("keeps a quote in a lyric from breaking the file", () => {
    const base: Score = { ...createScore("Quote"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const awkward = applyBatch(
      base,
      batch({ type: "beat.setLyric", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, lyric: 'sing "loud"' }),
    );
    // The tex writer trades double quotes for singles rather than corrupting the
    // stream; the syllable comes back readable if not byte-identical.
    const back = roundTrip(awkward);
    expect(beatsOf(back, 0)[0]?.lyric).toBe("sing 'loud'");
  });
});
