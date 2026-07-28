/**
 * CubScore semantic score model, v0 sketch.
 *
 * Design rules (see PLAN.md, Architecture):
 * - Purely semantic: no layout, spacing, or presentation data lives here.
 *   Rendering is a projection owned by packages/notation.
 * - Every entity has a stable id so operations (ops.ts) can address it
 *   across edits, sync, forks, and version history.
 * - Durations are rational (numerator/denominator of a whole note) rather
 *   than floats, so tuplets stay exact.
 *
 * This file is the Phase 0 discussion draft. The op-log design doc must
 * sign off before the editor is built on top of it.
 */

export type Id = string;

/** Duration as a fraction of a whole note. A quarter note is 1/4. */
export interface Duration {
  numerator: number;
  denominator: number;
}

export interface TimeSignature {
  beats: number;
  beatValue: number;
}

export interface KeySignature {
  /** Fifths from C major: negative = flats, positive = sharps. */
  fifths: number;
  mode: "major" | "minor";
}

/** MIDI note number for each open string, low to high. */
export type Tuning = number[];

export type Articulation =
  | "bend"
  | "slide"
  | "hammerOn"
  | "pullOff"
  | "vibrato"
  | "tremolo"
  | "palmMute"
  | "letRing"
  | "deadNote"
  | "naturalHarmonic"
  | "artificialHarmonic"
  | "tap"
  | "staccato"
  | "accent"
  | "ghost";

export interface Note {
  id: Id;
  /** MIDI pitch. Fret/string is a projection except where the user pinned it. */
  pitch: number;
  /** 1-based string number, present when fingering is explicit. */
  string?: number;
  fret?: number;
  tiedToNext?: boolean;
  articulations: Articulation[];
}

/** One rhythmic event in a voice: notes sounding together, or a rest. */
export interface Beat {
  id: Id;
  duration: Duration;
  /** Empty array = rest. */
  notes: Note[];
  /** Tuplet grouping, e.g. 3:2 for a triplet. */
  tuplet?: { actual: number; normal: number };
  dots: 0 | 1 | 2;
}

export interface Voice {
  id: Id;
  beats: Beat[];
}

export interface Bar {
  id: Id;
  voices: Voice[];
  /** Set only when it changes at this bar. */
  timeSignature?: TimeSignature;
  keySignature?: KeySignature;
  tempoBpm?: number;
  repeat?: { start?: boolean; endCount?: number };
}

export type Instrument =
  | { kind: "fretted"; tuning: Tuning; frets: number; capo: number }
  | { kind: "drums" }
  | { kind: "pitched"; midiProgram: number };

export interface Track {
  id: Id;
  name: string;
  instrument: Instrument;
  bars: Bar[];
}

export interface Score {
  id: Id;
  title: string;
  artist: string;
  tracks: Track[];
  /** Monotonic revision, advanced by each applied op batch. */
  revision: number;
}

export function emptyScore(id: Id, title: string): Score {
  return { id, title, artist: "", tracks: [], revision: 0 };
}
