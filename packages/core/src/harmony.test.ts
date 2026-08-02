/**
 * Harmony: the claims a musician would check.
 *
 * The parser is tested against the chart vocabulary symbol by symbol, because a
 * chord parser's failure mode is not crashing — it is returning the wrong notes with
 * complete confidence, and a wrong voicing sounds wrong in front of other people.
 *
 * The voicing search is tested against shapes every guitarist knows by name. If the
 * open C shape is not among the tool's C voicings, the tool is wrong, whatever its
 * scoring function thinks — those shapes are the ground truth the search exists to
 * rediscover, and finding them from constraints alone is what lets it also be right
 * in DADGAD, where there is no dictionary to copy.
 */
import { describe, expect, it } from "vitest";
import {
  analyseChord,
  chordByBar,
  chordPitchClasses,
  chordPitches,
  diatonicChords,
  harmonise,
  parseChord,
  spellPitchClass,
  suggestNext,
  tonicOf,
  transposeChord,
  voicings,
} from "./harmony.js";
import { createScore, createTrack, frettedGuitar } from "./build.js";
import { applyBatch } from "./apply.js";
import type { Instrument, KeySignature, Op, OpBatch, OpKind } from "./index.js";

const C_MAJOR: KeySignature = { fifths: 0, mode: "major" };
const A_MINOR: KeySignature = { fifths: 0, mode: "minor" };
const F_MAJOR: KeySignature = { fifths: -1, mode: "major" };
const D_MAJOR: KeySignature = { fifths: 2, mode: "major" };

/** Pitch classes of a symbol, as a sorted array, for compact assertions. */
function pcs(symbol: string): number[] {
  const parsed = parseChord(symbol);
  if (!parsed) throw new Error(`did not parse: ${symbol}`);
  return [...chordPitchClasses(parsed)].sort((a, b) => a - b);
}

describe("reading chord symbols", () => {
  it("reads the triads", () => {
    expect(pcs("C")).toEqual([0, 4, 7]);
    expect(pcs("Cm")).toEqual([0, 3, 7]);
    expect(pcs("Cdim")).toEqual([0, 3, 6]);
    expect(pcs("Caug")).toEqual([0, 4, 8]);
    expect(pcs("C+")).toEqual([0, 4, 8]);
    expect(pcs("Csus4")).toEqual([0, 5, 7]);
    expect(pcs("Csus2")).toEqual([0, 2, 7]);
    expect(pcs("C5")).toEqual([0, 7]);
  });

  it("reads sevenths the way charts mean them", () => {
    expect(pcs("C7")).toEqual([0, 4, 7, 10]);
    expect(pcs("Cmaj7")).toEqual([0, 4, 7, 11]);
    expect(pcs("CM7")).toEqual([0, 4, 7, 11]);
    expect(pcs("Cm7")).toEqual([0, 3, 7, 10]);
    expect(pcs("Cdim7")).toEqual([0, 3, 6, 9]);
    expect(pcs("Cm7b5")).toEqual([0, 3, 6, 10]);
    // "Cmaj" written alone is the triad, not a maj7 — nobody writes it, but a
    // parser that quietly added a seventh would be inventing a note.
    expect(pcs("Cmaj")).toEqual([0, 4, 7]);
  });

  it("stacks extensions and leaves the eleventh out of a 13", () => {
    expect(pcs("C9")).toEqual([0, 2, 4, 7, 10]);
    expect(pcs("Cmaj9")).toEqual([0, 2, 4, 7, 11]);
    expect(pcs("Cm9")).toEqual([0, 2, 3, 7, 10]);
    expect(pcs("C13")).toEqual([0, 2, 4, 7, 9, 10]);
    expect(pcs("C6")).toEqual([0, 4, 7, 9]);
    expect(pcs("C69")).toEqual([0, 2, 4, 7, 9]);
    expect(pcs("C6/9")).toEqual([0, 2, 4, 7, 9]);
    expect(pcs("Cadd9")).toEqual([0, 2, 4, 7]);
  });

  it("reads alterations, bracketed or not", () => {
    expect(pcs("C7b9")).toEqual([0, 1, 4, 7, 10]);
    expect(pcs("C7#9")).toEqual([0, 3, 4, 7, 10]);
    expect(pcs("C7(#11)")).toEqual([0, 4, 6, 7, 10]);
    expect(pcs("C7b5")).toEqual([0, 4, 6, 10]);
    expect(pcs("C7#5")).toEqual([0, 4, 8, 10]);
  });

  it("reads a slash bass, and keeps the slash in 6/9 for the extension", () => {
    const cOverG = parseChord("C/G")!;
    expect(cOverG.bass).toBe(7);
    expect(cOverG.bassName).toBe("G");
    const amOverF = parseChord("Am/F#")!;
    expect(amOverF.bass).toBe(6);
    expect(parseChord("C6/9")!.bass).toBeUndefined();
  });

  it("keeps the writer's spelling", () => {
    expect(parseChord("Bb")!.rootName).toBe("Bb");
    expect(parseChord("A#")!.rootName).toBe("A#");
    expect(parseChord("F#m7")!.root).toBe(6);
    expect(parseChord("Gbm7")!.root).toBe(6);
  });

  it("refuses what it cannot read, whole symbol at a time", () => {
    expect(parseChord("H7")).toBeNull();
    expect(parseChord("")).toBeNull();
    expect(parseChord("Cxyz")).toBeNull();
    expect(parseChord("C/H")).toBeNull();
    // Half-parsing "Cmaj7withfeeling" as Cmaj7 would be a different chord.
    expect(parseChord("Cmaj7nope")).toBeNull();
  });

  it("puts a slash bass below the chord in the preview pitches", () => {
    const pitches = chordPitches(parseChord("C/G")!);
    expect(pitches[0]! % 12).toBe(7);
    expect(pitches[0]!).toBeLessThan(pitches[1]!);
  });
});

describe("transposition", () => {
  it("moves the root and keeps the structure", () => {
    expect(transposeChord("Am7", 3, false)).toBe("Cm7");
    expect(transposeChord("C", 2, false)).toBe("D");
    expect(transposeChord("Cmaj7(#11)", 7, false)).toBe("Gmaj7(#11)");
  });

  it("spells for the destination key", () => {
    expect(transposeChord("A", 1, true)).toBe("Bb");
    expect(transposeChord("A", 1, false)).toBe("A#");
  });

  it("moves a slash bass with the chord", () => {
    expect(transposeChord("C/G", 2, false)).toBe("D/A");
    expect(transposeChord("Am/F#", 1, true)).toBe("Bbm/G");
  });

  it("refuses what the parser refuses", () => {
    expect(transposeChord("H7", 1, false)).toBeNull();
  });
});

describe("keys", () => {
  it("finds the tonic from the signature", () => {
    expect(tonicOf(C_MAJOR)).toBe(0);
    expect(tonicOf({ fifths: 1, mode: "major" })).toBe(7);
    expect(tonicOf(F_MAJOR)).toBe(5);
    expect(tonicOf(D_MAJOR)).toBe(2);
    expect(tonicOf(A_MINOR)).toBe(9);
    expect(tonicOf({ fifths: 1, mode: "minor" })).toBe(4);
  });

  it("offers the seven chords of a major key", () => {
    expect(diatonicChords(C_MAJOR).map((c) => c.name)).toEqual(["C", "Dm", "Em", "F", "G", "Am", "Bdim"]);
    expect(diatonicChords(C_MAJOR).map((c) => c.roman)).toEqual(["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
  });

  it("gives a minor key its practical major V", () => {
    const chords = diatonicChords(A_MINOR).map((c) => c.name);
    expect(chords[0]).toBe("Am");
    // E major, not E minor: the dominant songs actually use.
    expect(chords[4]).toBe("E");
  });

  it("spells flat keys flat", () => {
    expect(diatonicChords(F_MAJOR).map((c) => c.name)).toContain("Bb");
    expect(diatonicChords(F_MAJOR).map((c) => c.name)).not.toContain("A#");
    expect(spellPitchClass(10, true)).toBe("Bb");
  });

  it("places a chord on its degree, and refuses the wrong family", () => {
    expect(analyseChord("Dm7", C_MAJOR)?.roman).toBe("ii");
    expect(analyseChord("G7", C_MAJOR)?.roman).toBe("V");
    expect(analyseChord("Bdim", C_MAJOR)?.roman).toBe("vii°");
    // D major in C is a borrowed chord; calling it ii would be false.
    expect(analyseChord("D", C_MAJOR)).toBeNull();
    expect(analyseChord("C#m", C_MAJOR)).toBeNull();
  });
});

describe("what comes next", () => {
  it("offers home first on an empty chart", () => {
    const openers = suggestNext(null, C_MAJOR);
    expect(openers[0]?.name).toBe("C");
    expect(openers.map((s) => s.name)).toContain("G");
  });

  it("resolves the dominant home", () => {
    const after = suggestNext("G", C_MAJOR);
    expect(after[0]?.name).toBe("C");
    expect(after[0]?.why).toMatch(/home/);
  });

  it("continues a ii with the V", () => {
    expect(suggestNext("Dm7", C_MAJOR)[0]?.name).toBe("G");
  });

  it("knows the pop cycle out of vi", () => {
    expect(suggestNext("Am", C_MAJOR).map((s) => s.name)).toContain("F");
  });

  it("works in minor keys with their real dominant", () => {
    const after = suggestNext("E", A_MINOR);
    expect(after[0]?.name).toBe("Am");
  });

  it("gives a stranger the openers rather than a guess", () => {
    // F#7 is nowhere in C major; the useful answer is somewhere to stand.
    expect(suggestNext("F#7", C_MAJOR)[0]?.name).toBe("C");
  });

  it("names its reasoning on every suggestion", () => {
    for (const suggestion of suggestNext("C", C_MAJOR)) {
      expect(suggestion.why.length).toBeGreaterThan(3);
      expect(suggestion.roman.length).toBeGreaterThan(0);
    }
  });
});

describe("harmonising a melody", () => {
  it("hears an arpeggio as its own chord", () => {
    expect(harmonise([60, 64, 67], C_MAJOR)[0]?.name).toBe("C");
    expect(harmonise([69, 72, 76], C_MAJOR)[0]?.name).toBe("Am");
  });

  it("weighs the downbeat double", () => {
    // E G could be C or Em; leading with E's chord tones tips it — but leading
    // with G's should tip toward chords carrying G.
    const gFirst = harmonise([67, 64], C_MAJOR);
    expect(["C", "G", "Em"]).toContain(gFirst[0]?.name);
  });

  it("says nothing for an empty bar", () => {
    expect(harmonise([], C_MAJOR)).toEqual([]);
  });

  it("stays inside the key on purpose", () => {
    const suggestions = harmonise([60, 62, 64, 65, 67, 69, 71], C_MAJOR);
    const diatonic = new Set(diatonicChords(C_MAJOR).map((c) => c.name));
    for (const s of suggestions) expect(diatonic.has(s.name)).toBe(true);
  });
});

describe("voicings", () => {
  const guitar = frettedGuitar();

  /** Finds a voicing by its fret signature, string 1 first, -1 for unplayed. */
  const shape = (list: ReturnType<typeof voicings>, frets: number[]) =>
    list.find((v) => v.frets.join(",") === frets.join(","));

  it("rediscovers the open C shape", () => {
    const found = voicings(parseChord("C")!, guitar, 24);
    expect(shape(found, [0, 1, 0, 2, 3, -1]), "x32010 missing").toBeDefined();
  });

  it("rediscovers the open G and open D shapes", () => {
    expect(shape(voicings(parseChord("G")!, guitar, 24), [3, 0, 0, 0, 2, 3]), "320003").toBeDefined();
    expect(shape(voicings(parseChord("D")!, guitar, 24), [2, 3, 2, 0, -1, -1]), "xx0232").toBeDefined();
  });

  it("only ever plays chord tones, with the bass on the root", () => {
    for (const symbol of ["Am7", "F#m", "Bbmaj7", "E7", "Dsus4"]) {
      const parsed = parseChord(symbol)!;
      const tones = chordPitchClasses(parsed);
      const found = voicings(parsed, guitar);
      expect(found.length, `${symbol} found nothing`).toBeGreaterThan(0);
      for (const voicing of found) {
        for (const pitch of voicing.pitches) expect(tones.has(pitch % 12), `${symbol} stray note`).toBe(true);
        expect(voicing.pitches[0]! % 12, `${symbol} bass is not the root`).toBe(parsed.root);
      }
    }
  });

  it("keeps the essential tones even when it drops the fifth", () => {
    // Every Cmaj7 voicing must contain B; a Cmaj7 without its seventh is a C. Checked
    // deep into the ranking, not just the top few — the first version of this test
    // sampled five voicings, all of which happened to be rich, and a mutation that
    // deleted the essentials check entirely still passed it.
    const deep = voicings(parseChord("Cmaj7")!, guitar, 60);
    expect(deep.length).toBeGreaterThan(10);
    for (const voicing of deep) {
      expect(voicing.pitches.some((p) => p % 12 === 11), voicing.frets.join(",")).toBe(true);
      expect(voicing.pitches.some((p) => p % 12 === 4), voicing.frets.join(",")).toBe(true);
    }
  });

  it("puts the written bass under a slash chord", () => {
    for (const voicing of voicings(parseChord("C/G")!, guitar)) {
      expect(voicing.pitches[0]! % 12).toBe(7);
    }
  });

  it("never asks for more than a hand", () => {
    for (const symbol of ["F", "Bm", "C#m7", "Ab"]) {
      for (const voicing of voicings(parseChord(symbol)!, guitar)) {
        const fretted = voicing.frets.filter((f) => f > 0);
        const span = Math.max(...fretted) - Math.min(...fretted);
        expect(span).toBeLessThanOrEqual(3);
        const lowest = Math.min(...fretted);
        const barre = fretted.filter((f) => f === lowest).length;
        expect(fretted.length - Math.max(0, barre - 1)).toBeLessThanOrEqual(4);
      }
    }
  });

  it("never traps a muted string inside the strum", () => {
    for (const voicing of voicings(parseChord("C")!, guitar, 24)) {
      const sounding = voicing.frets.map((f) => f >= 0);
      const first = sounding.indexOf(true);
      const last = sounding.lastIndexOf(true);
      for (let i = first; i <= last; i += 1) expect(sounding[i]).toBe(true);
    }
  });

  it("voices correctly in a tuning no dictionary covers", () => {
    // DADGAD. The point of searching instead of looking shapes up.
    const dadgad: Instrument = { kind: "fretted", tuning: [62, 57, 55, 50, 45, 38], frets: 24, capo: 0 };
    const found = voicings(parseChord("D")!, dadgad);
    expect(found.length).toBeGreaterThan(0);
    for (const voicing of found) {
      expect(voicing.pitches[0]! % 12).toBe(2);
      for (const pitch of voicing.pitches) expect([2, 6, 9]).toContain(pitch % 12);
    }
  });

  it("respects a capo", () => {
    const capoed: Instrument = { ...frettedGuitar(), capo: 2 } as Instrument;
    for (const voicing of voicings(parseChord("D")!, capoed)) {
      // Everything sounding must still be a D-chord tone with the capo's offset applied.
      for (const pitch of voicing.pitches) expect([2, 6, 9]).toContain(pitch % 12);
    }
  });

  it("returns nothing rather than shapes for an unfretted instrument", () => {
    expect(voicings(parseChord("C")!, { kind: "pitched", midiProgram: 0 })).toEqual([]);
  });

  it("answers fast enough to sit behind a keystroke", () => {
    const start = performance.now();
    voicings(parseChord("F#m7b5")!, guitar);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe("the chord in force", () => {
  it("carries a chord forward until the next one, like a chart", () => {
    let counter = 0;
    const batch = (...kinds: OpKind[]): OpBatch => ({
      id: `h-${++counter}`,
      ops: kinds.map((kind): Op => ({ id: `h-op-${++counter}`, author: "t", at: 0, ...kind })),
    });
    const base = { ...createScore("Chart"), tracks: [createTrack("Guitar", frettedGuitar(), 4)] };
    const beatIn = (bar: number) => base.tracks[0]!.bars[bar]!.voices[0]!.beats[0]!.id;
    const charted = applyBatch(
      base,
      batch(
        { type: "beat.setChord", beatId: beatIn(1), chord: "Am" },
        { type: "beat.setChord", beatId: beatIn(3), chord: "F" },
      ),
    );
    expect(chordByBar(charted.tracks[0]!)).toEqual([null, "Am", "Am", "F"]);
  });
});
