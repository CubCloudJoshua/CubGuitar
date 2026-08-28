/**
 * Where the caret sits on a staff that has no strings, and what pitch that is.
 *
 * An imported piano, vocal or wind part comes in pitch-exact and was then read-only,
 * because every entry path in the editor was written for a fretboard: a note is found by
 * its string, a keystroke means a fret, and a staff with neither has nothing for either to
 * act on. The missing idea is a *row* — one diatonic step of the staff — which is what a
 * caret on a pitched staff is actually pointing at, and which gives note entry, deletion
 * and the arrow keys the same unambiguous handle a string gives them.
 *
 * Rows are diatonic rather than chromatic on purpose. Staff notation is diatonic: a
 * caret that moved in semitones would visit a line, then the same line with an accidental,
 * then the next line, so the arrow keys would climb the staff at half speed and stop twice
 * on every line. Degrees also make the number row mean something a musician already
 * thinks in — 1 is the tonic of the bar's key, 5 is the dominant — instead of an
 * arbitrary index.
 */
import { tonicOf } from "./harmony.js";
import type { KeySignature } from "./score.js";

/** Semitones above the tonic for each degree, major and natural minor. */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11] as const;
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10] as const;

/**
 * The lowest row's octave, and how many rows there are.
 *
 * Four octaves from C2, which spans a bass part's bottom to a soprano's top and comfortably
 * covers every piano part anyone will type by hand here. Not the full MIDI range: the rows
 * are what the arrow keys walk, and 88 of them would make crossing an octave a chore.
 */
const BASE_OCTAVE = 2;
export const STAFF_ROWS = 4 * 7 + 1;

const DEFAULT_KEY: KeySignature = { fifths: 0, mode: "major" };

const NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

/** Rows are 1-based, like string numbers, so the two can share a cursor field. */
function clampRow(row: number): number {
  return Math.max(1, Math.min(STAFF_ROWS, Math.round(row)));
}

/**
 * The MIDI pitch a row sounds, in a key.
 *
 * Row 1 is the tonic in the lowest octave, so the degrees of the key line up with the
 * number row for every key rather than only for C major.
 */
export function rowPitch(row: number, key: KeySignature = DEFAULT_KEY): number {
  const index = clampRow(row) - 1;
  const steps = key.mode === "minor" ? MINOR_STEPS : MAJOR_STEPS;
  const withinOctave = steps[index % 7] ?? 0;
  // The tonic's own octave placement: pitch class 0..11 above C of BASE_OCTAVE.
  const tonic = tonicOf(key);
  return (BASE_OCTAVE + 1) * 12 + tonic + Math.floor(index / 7) * 12 + withinOctave;
}

/**
 * The row that sounds a pitch exactly, or null.
 *
 * Null rather than nearest, because this decides which note the caret is *on*: answering
 * with a neighbouring row would let Delete remove a note the caret was never pointing at.
 * A chromatic note in the key — an F# in C major — has no row, which is a real limit of
 * diatonic rows and the reason this returns null instead of pretending.
 */
export function pitchRow(pitch: number, key: KeySignature = DEFAULT_KEY): number | null {
  for (let row = 1; row <= STAFF_ROWS; row += 1) if (rowPitch(row, key) === Math.round(pitch)) return row;
  return null;
}

/** Which degree of the key a row is, 1 to 7. */
export function rowDegree(row: number): number {
  return ((clampRow(row) - 1) % 7) + 1;
}

/**
 * The row for a degree in the caret's current octave.
 *
 * "Current octave" is the caret's own, so pressing 5 moves to the dominant nearest where
 * the writer already is rather than jumping to a fixed octave. Reaching another octave is
 * what the arrow keys are for.
 */
export function rowForDegree(currentRow: number, degree: number): number {
  const octave = Math.floor((clampRow(currentRow) - 1) / 7);
  return clampRow(octave * 7 + Math.max(1, Math.min(7, Math.round(degree))));
}

/** A row's pitch as a name, for a readout: "C4", "Eb5". */
export function rowLabel(row: number, key: KeySignature = DEFAULT_KEY): string {
  const pitch = rowPitch(row, key);
  const names = key.fifths < 0 ? NAMES_FLAT : NAMES_SHARP;
  return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}
