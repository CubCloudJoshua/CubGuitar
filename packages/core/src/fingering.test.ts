/**
 * Fingering.
 *
 * The tests that matter are about playability rather than about specific frets:
 * there is usually more than one good answer, and pinning the exact one would
 * freeze a cost function that is meant to be tuned. So the assertions are the
 * properties a guitarist would check — the hand does not leap between consecutive
 * notes, a chord uses distinct strings, nothing exceeds a hand's span, an open
 * string is preferred when it is free — plus the one thing that must be exact,
 * which is that the same input always fingers the same way.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, fingerOne, fingerSequence, positionsFor } from "./fingering.js";
import { frettedGuitar, STANDARD_BASS, STANDARD_GUITAR } from "./build.js";
import type { Instrument } from "./score.js";

const guitar = frettedGuitar();
const bass: Instrument = { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 };

/** The hand position each chord implies: the lowest fretted fret. */
function anchors(chords: ReturnType<typeof fingerSequence>["chords"]): Array<number | null> {
  return chords.map((positions) => {
    const fretted = positions.filter((p) => p.fret > 0).map((p) => p.fret);
    return fretted.length > 0 ? Math.min(...fretted) : null;
  });
}

/** The largest jump between consecutive fretted positions. */
function largestLeap(chords: ReturnType<typeof fingerSequence>["chords"]): number {
  const seen = anchors(chords).filter((a): a is number => a !== null);
  let worst = 0;
  for (let i = 1; i < seen.length; i += 1) worst = Math.max(worst, Math.abs(seen[i]! - seen[i - 1]!));
  return worst;
}

describe("positionsFor", () => {
  it("finds every string that can reach a pitch", () => {
    // E4 (64) is the open top string, and also fret 5 of the B string, fret 9 of G,
    // fret 14 of D, fret 19 of A, fret 24 of the low E.
    expect(positionsFor(guitar, 64)).toEqual([
      { string: 1, fret: 0 },
      { string: 2, fret: 5 },
      { string: 3, fret: 9 },
      { string: 4, fret: 14 },
      { string: 5, fret: 19 },
      { string: 6, fret: 24 },
    ]);
  });

  it("finds nothing below the lowest string or above the last fret", () => {
    expect(positionsFor(guitar, 39)).toEqual([]);
    expect(positionsFor(guitar, 200)).toEqual([]);
  });

  it("shifts everything when there is a capo, and loses what is below it", () => {
    const capo3: Instrument = { kind: "fretted", tuning: [...STANDARD_GUITAR], frets: 24, capo: 3 };
    // The open top string now sounds G4 (67), so E4 is no longer reachable there.
    expect(positionsFor(capo3, 67)).toContainEqual({ string: 1, fret: 0 });
    expect(positionsFor(capo3, 64).some((p) => p.string === 1)).toBe(false);
  });

  it("has nothing to say about an instrument with no strings", () => {
    expect(positionsFor({ kind: "pitched", midiProgram: 0 }, 60)).toEqual([]);
    expect(positionsFor({ kind: "drums" }, 38)).toEqual([]);
  });
});

describe("a run of single notes", () => {
  it("stays in one position instead of leaping about", () => {
    // A chromatic run up the top string's range. Choosing each note independently
    // by "lowest fret that reaches it" sends the hand from fret 12 to fret 2 and
    // back; this is the failure the module exists to fix.
    const run = [64, 65, 66, 67, 68, 69, 70, 71, 72];
    const { chords } = fingerSequence(guitar, run.map((p) => [p]));
    expect(chords).toHaveLength(run.length);
    expect(largestLeap(chords)).toBeLessThanOrEqual(4);
  });

  it("plays a low melody on low strings and a high one high up", () => {
    const low = fingerSequence(guitar, [[40], [43], [45]]);
    // Around the guitar's bottom: strings 5 and 6, not fret 20 of the top string.
    expect(low.chords.every((c) => (c[0]?.string ?? 0) >= 5)).toBe(true);

    const high = fingerSequence(guitar, [[81], [83], [84]]);
    // Nothing below the twelfth fret can reach these at all.
    expect(high.chords.every((c) => (c[0]?.fret ?? 0) >= 12)).toBe(true);
  });

  it("takes an open string when it is free", () => {
    // E4 as the open top string rather than fret 5 of the B string, with nothing
    // else pulling the hand elsewhere.
    const { chords } = fingerSequence(guitar, [[64]]);
    expect(chords[0]?.[0]).toEqual({ string: 1, fret: 0 });
  });

  it("takes a free open string mid-phrase without disturbing the hand", () => {
    // A phrase at the twelfth fret with one note that happens to be playable open.
    // The open string is genuinely free — it needs no left hand — so taking it is
    // right, and what must not happen is the notes *around* it moving.
    const { chords } = fingerSequence(guitar, [[76], [64], [77]]);
    expect(chords[1]?.[0]).toEqual({ string: 1, fret: 0 });
    // E5 to F5 is a semitone, so one fret of movement is the music rather than a
    // leap. What would be wrong is the hand travelling to fret 0 and back.
    expect(largestLeap(chords)).toBeLessThanOrEqual(1);
  });

  it("does not travel for a note it could reach where the hand already is", () => {
    // F4 has no open position, so movement is what decides: fret 10 of the G string
    // beats fret 1 of the top string when the hand is at the twelfth.
    const { chords } = fingerSequence(guitar, [[76], [65], [77]]);
    expect(chords[1]?.[0]?.fret).toBeGreaterThan(6);
    expect(largestLeap(chords)).toBeLessThanOrEqual(4);
  });

  it("keeps a note that no string can reach out of the result, and reports it", () => {
    const { chords, unreachable } = fingerSequence(guitar, [[64], [20], [67]]);
    expect(unreachable).toEqual([20]);
    expect(chords[1]).toEqual([]);
    // And the notes around it are still fingered, and still near each other.
    expect(chords[0]?.[0]).toBeDefined();
    expect(chords[2]?.[0]).toBeDefined();
  });

  it("reports the right fingering for the note before an unplayable one", () => {
    // E6 is playable only at fret 24 of the top string, so the hand starts high, and
    // F4 is then cheapest high up (fret 20 of the A string) rather than at fret 1 —
    // a candidate that is *last* in the enumeration. That is what makes this case
    // able to tell a correct predecessor index from a wrong one, and it caught the
    // path reconstruction storing a node's own predecessor instead of its index:
    // the answer came out as frets 24, 1, -, 22, a twenty-three fret leap and back.
    const { chords } = fingerSequence(guitar, [[88], [65], [20], [67]]);
    expect(chords[1]?.[0]?.fret).toBeGreaterThan(12);
    expect(largestLeap(chords)).toBeLessThanOrEqual(6);
  });

  it("does not let an unreachable note reset the hand position", () => {
    // The hand is at the twelfth fret; then a note nothing can play; then F4, which
    // is reachable both at fret 1 of the top string and fret 10 of the G string.
    // Only a hand position that survived the gap chooses the near one — and this is
    // written with a note that has a genuine low alternative on purpose, because an
    // earlier version used notes whose lowest option was high anyway, so it passed
    // whether the position was carried or thrown away.
    const { chords } = fingerSequence(guitar, [[76], [20], [65]]);
    expect(chords[2]?.[0]?.fret).toBeGreaterThan(6);
  });
});

describe("chords", () => {
  it("puts every note of a chord on a different string", () => {
    // E major: E, B, E, G#, B, E.
    const { chords } = fingerSequence(guitar, [[40, 47, 52, 56, 59, 64]]);
    const strings = chords[0]?.map((p) => p.string) ?? [];
    expect(strings).toHaveLength(6);
    expect(new Set(strings).size).toBe(6);
  });

  it("finds a shape a hand can actually hold", () => {
    // An A major triad. Whatever it chooses, the fretted notes must be within a
    // hand's span — the assertion that separates a chord from a list of notes.
    const { chords } = fingerSequence(guitar, [[45, 49, 52, 57]]);
    const fretted = (chords[0] ?? []).filter((p) => p.fret > 0).map((p) => p.fret);
    const span = fretted.length > 1 ? Math.max(...fretted) - Math.min(...fretted) : 0;
    expect(span).toBeLessThanOrEqual(DEFAULT_WEIGHTS.maxStretch);
  });

  it("never exceeds a hand's span, on any chord in a progression", () => {
    const progression = [
      [40, 47, 52, 56, 59, 64], // E
      [45, 52, 57, 61, 64], // A
      [38, 50, 57, 62, 66], // D
      [43, 47, 55, 59, 62, 67], // G
    ];
    const { chords } = fingerSequence(guitar, progression);
    for (const positions of chords) {
      const fretted = positions.filter((p) => p.fret > 0).map((p) => p.fret);
      if (fretted.length < 2) continue;
      expect(Math.max(...fretted) - Math.min(...fretted)).toBeLessThanOrEqual(DEFAULT_WEIGHTS.maxStretch);
    }
  });

  it("refuses a shape no hand could hold, and places what it can instead", () => {
    // F2 is only playable at fret 1 of the low E, and E6 only at fret 24 of the top
    // string: twenty-three frets apart, on one hand. There is no assignment of both
    // within reach, so one of them has to go — and it is the stretch limit that
    // says so, not the cost function, which is why this is asserted separately.
    const { chords } = fingerSequence(guitar, [[41, 88]]);
    expect(chords[0]).toHaveLength(1);
  });

  it("places as much of a chord as it can when a note is unreachable", () => {
    // One note below the instrument, three above it. Dropping the whole chord
    // would lose music that is playable.
    const { chords, unreachable } = fingerSequence(guitar, [[20, 52, 56, 59]]);
    expect(unreachable).toEqual([20]);
    expect(chords[0]).toHaveLength(3);
  });

  it("places what it can when a chord has more notes than the instrument has strings", () => {
    const { chords } = fingerSequence(bass, [[40, 45, 50, 55, 59, 64]]);
    // Four strings, so at most four notes, each on its own.
    expect(chords[0]?.length).toBeLessThanOrEqual(4);
    expect(new Set(chords[0]?.map((p) => p.string)).size).toBe(chords[0]?.length);
  });
});

describe("other instruments", () => {
  it("fingers a bass line on a bass", () => {
    const { chords, unreachable } = fingerSequence(bass, [[33], [38], [40], [45]]);
    expect(unreachable).toEqual([]);
    expect(chords.every((c) => c.length === 1)).toBe(true);
    expect(largestLeap(chords)).toBeLessThanOrEqual(5);
  });

  it("fingers nothing on an instrument with no strings, and says everything is unreachable", () => {
    const { chords, unreachable } = fingerSequence({ kind: "pitched", midiProgram: 0 }, [[60], [62]]);
    expect(chords).toEqual([[], []]);
    expect(unreachable).toEqual([60, 62]);
  });

  it("respects a smaller fret count", () => {
    const short: Instrument = { kind: "fretted", tuning: [...STANDARD_GUITAR], frets: 12, capo: 0 };
    const { chords } = fingerSequence(short, [[88]]);
    // 88 needs fret 24 of the top string, which this instrument does not have.
    expect(chords[0]).toEqual([]);
  });
});

describe("determinism", () => {
  it("fingers the same part the same way every time", () => {
    // Not a nicety: a re-import that fingered differently would silently rewrite
    // someone's tab.
    const part = [[64], [67], [71], [40, 47, 52], [69], [72]];
    const first = fingerSequence(guitar, part);
    for (let i = 0; i < 5; i += 1) {
      expect(fingerSequence(guitar, part)).toEqual(first);
    }
  });

  it("returns one entry per input chord, always", () => {
    const part = [[64], [20], [], [40, 47], [200]];
    expect(fingerSequence(guitar, part).chords).toHaveLength(part.length);
  });

  it("handles an empty part", () => {
    expect(fingerSequence(guitar, [])).toEqual({ chords: [], unreachable: [], cost: 0 });
  });
});

describe("fingerOne", () => {
  it("takes the open string when the hand is nowhere in particular", () => {
    expect(fingerOne(guitar, 64)).toEqual({ string: 1, fret: 0 });
  });

  it("stays near the hand when told where it is", () => {
    // F4 has no open position: fret 1 of the top string or fret 10 of the G string.
    // With the hand at the tenth, reaching is cheaper than travelling nine frets.
    expect(fingerOne(guitar, 65, 10)).toEqual({ string: 3, fret: 10 });
    // And with the hand low, the other answer wins.
    expect(fingerOne(guitar, 65, 1)).toEqual({ string: 1, fret: 1 });
  });

  it("still takes an open string wherever the hand is, because it is free", () => {
    expect(fingerOne(guitar, 64, 12)).toEqual({ string: 1, fret: 0 });
  });

  it("answers nothing for a pitch the instrument cannot play", () => {
    expect(fingerOne(guitar, 20)).toBeNull();
    expect(fingerOne({ kind: "drums" }, 38)).toBeNull();
  });
});

describe("weights", () => {
  it("can be told to care less about movement, and then it does", () => {
    // Not a knob for its own sake: the weights are the argument, and a test that
    // changing them changes the answer is what keeps them honest rather than
    // decorative.
    // F4 rather than E4, so an open string is not available and movement is the
    // only term that can decide.
    const phrase = [[76], [65], [77]];
    const normal = fingerSequence(guitar, phrase);
    const roaming = fingerSequence(guitar, phrase, { ...DEFAULT_WEIGHTS, movement: 0 });
    expect(normal.chords[1]?.[0]?.fret).toBeGreaterThan(6);
    // With movement free, the lowest position wins on height alone.
    expect(roaming.chords[1]?.[0]).toEqual({ string: 1, fret: 1 });
  });

  it("can be told a hand spans less, and then it refuses wider shapes", () => {
    const wide = [[40, 51, 56]];
    const tight = fingerSequence(guitar, wide, { ...DEFAULT_WEIGHTS, maxStretch: 2, comfortableStretch: 2 });
    const fretted = (tight.chords[0] ?? []).filter((p) => p.fret > 0).map((p) => p.fret);
    if (fretted.length > 1) {
      expect(Math.max(...fretted) - Math.min(...fretted)).toBeLessThanOrEqual(2);
    }
  });
});
