/**
 * Staff rows: the caret's handle on a staff with no strings.
 *
 * The arithmetic is small and every part of it is a way to put a note in the wrong place,
 * so each claim here is one a musician would notice: that degree 1 is the key's tonic in
 * every key, that a row walks the scale rather than the chromatic, that minor is minor,
 * and that a pitch with no row says so instead of rounding to a neighbour.
 */
import { describe, expect, it } from "vitest";
import { pitchRow, rowDegree, rowForDegree, rowLabel, rowPitch, STAFF_ROWS } from "./staff.js";
import type { KeySignature } from "./score.js";

const C_MAJOR: KeySignature = { fifths: 0, mode: "major" };
const D_MAJOR: KeySignature = { fifths: 2, mode: "major" };
const A_MINOR: KeySignature = { fifths: 0, mode: "minor" };
const EB_MAJOR: KeySignature = { fifths: -3, mode: "major" };

describe("rowPitch", () => {
  it("starts on the tonic of the key, not on C", () => {
    // C2 is MIDI 36. The point of the key argument: in D major row 1 is a D, so the
    // number row means the same thing to a player in any key.
    expect(rowPitch(1, C_MAJOR)).toBe(36);
    expect(rowPitch(1, D_MAJOR)).toBe(38);
    expect(rowPitch(1, A_MINOR)).toBe(45);
    expect(rowPitch(1, EB_MAJOR)).toBe(39);
  });

  it("walks the major scale, not the chromatic", () => {
    const first = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => rowPitch(r, C_MAJOR) - 36);
    expect(first).toEqual([0, 2, 4, 5, 7, 9, 11, 12]);
  });

  it("walks the natural minor in a minor key", () => {
    const first = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => rowPitch(r, A_MINOR) - rowPitch(1, A_MINOR));
    expect(first).toEqual([0, 2, 3, 5, 7, 8, 10, 12]);
  });

  it("is an octave higher every seven rows", () => {
    for (const key of [C_MAJOR, D_MAJOR, A_MINOR]) {
      expect(rowPitch(8, key) - rowPitch(1, key)).toBe(12);
      expect(rowPitch(15, key) - rowPitch(8, key)).toBe(12);
      expect(rowPitch(22, key) - rowPitch(15, key)).toBe(12);
    }
  });

  it("is strictly increasing across the whole staff", () => {
    // A gap or a repeat would make one row unreachable or two rows the same note, and the
    // arrow keys would appear to stick.
    for (const key of [C_MAJOR, D_MAJOR, A_MINOR, EB_MAJOR]) {
      for (let row = 2; row <= STAFF_ROWS; row += 1) {
        expect(rowPitch(row, key)).toBeGreaterThan(rowPitch(row - 1, key));
      }
    }
  });

  it("clamps rather than running off either end", () => {
    expect(rowPitch(0, C_MAJOR)).toBe(rowPitch(1, C_MAJOR));
    expect(rowPitch(-5, C_MAJOR)).toBe(rowPitch(1, C_MAJOR));
    expect(rowPitch(STAFF_ROWS + 9, C_MAJOR)).toBe(rowPitch(STAFF_ROWS, C_MAJOR));
  });

  it("spans four octaves, which is what a hand-typed part needs", () => {
    expect(rowPitch(STAFF_ROWS, C_MAJOR) - rowPitch(1, C_MAJOR)).toBe(48);
  });
});

describe("pitchRow", () => {
  it("is the inverse of rowPitch for every row", () => {
    for (const key of [C_MAJOR, D_MAJOR, A_MINOR, EB_MAJOR]) {
      for (let row = 1; row <= STAFF_ROWS; row += 1) {
        expect(pitchRow(rowPitch(row, key), key)).toBe(row);
      }
    }
  });

  it("answers null for a pitch no row sounds, rather than the nearest", () => {
    // F# is not in C major, so the caret cannot be "on" it. Rounding to F or G would let
    // Delete remove a note the caret was never pointing at.
    expect(pitchRow(42, C_MAJOR)).toBeNull();
    expect(pitchRow(0, C_MAJOR)).toBeNull();
    expect(pitchRow(127, C_MAJOR)).toBeNull();
  });

  it("finds a pitch that is chromatic in one key and diatonic in another", () => {
    const fSharp3 = 54;
    expect(pitchRow(fSharp3, C_MAJOR)).toBeNull();
    expect(pitchRow(fSharp3, D_MAJOR)).not.toBeNull();
  });
});

describe("rowForDegree", () => {
  it("stays in the octave the caret is already in", () => {
    // Pressing 5 goes to the dominant near where the writer is, not to a fixed octave.
    expect(rowForDegree(1, 5)).toBe(5);
    expect(rowForDegree(9, 5)).toBe(12);
    expect(rowForDegree(15, 1)).toBe(15);
    expect(rowForDegree(21, 1)).toBe(15);
  });

  it("clamps a degree outside 1..7", () => {
    expect(rowForDegree(1, 0)).toBe(rowForDegree(1, 1));
    expect(rowForDegree(1, 99)).toBe(rowForDegree(1, 7));
  });

  it("round-trips with rowDegree", () => {
    for (let row = 1; row <= STAFF_ROWS; row += 1) {
      expect(rowForDegree(row, rowDegree(row))).toBe(row);
    }
  });
});

describe("rowLabel", () => {
  it("names the pitch the row sounds", () => {
    expect(rowLabel(1, C_MAJOR)).toBe("C2");
    expect(rowLabel(8, C_MAJOR)).toBe("C3");
    expect(rowLabel(1, D_MAJOR)).toBe("D2");
  });

  it("spells with flats in a flat key", () => {
    // A player reading Eb major wants Eb, not D#, and the key signature is what says so.
    expect(rowLabel(1, EB_MAJOR)).toBe("Eb2");
    expect(rowLabel(3, EB_MAJOR)).toBe("G2");
    expect(rowLabel(2, D_MAJOR)).toBe("E2");
  });
});
