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

/**
 * MIDI note number for each open string, indexed by string number: `tuning[0]` is
 * string 1, the highest. STANDARD_GUITAR is [64, 59, 55, 50, 45, 40] — E4 first.
 * (This comment said "low to high" for a long time while every constant and consumer
 * did the opposite; a helper was nearly shipped against the comment.)
 */
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
  /**
   * Chord symbol taking effect at this beat, as written: "Am7", "F#m7b5", "C/G".
   *
   * Stored as the text and parsed on demand (harmony.ts), because the text is what
   * the writer typed and what every format carries; a chord kept only as intervals
   * would come back respelled. A chord stays in force until the next one, which is
   * how a chart reads and why there is no "chord region" — the region is implied.
   */
  chord?: string;
  /**
   * The lyric sung at this beat — one syllable or word, the way lyrics attach in
   * every notation format. A song's lyric line is the beats read in order.
   */
  lyric?: string;
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
  /**
   * Section name starting at this bar: "Verse", "Chorus", "Bridge".
   *
   * Song structure is the first thing a songwriter writes down and the last thing
   * notation software carries. Like tempo and meter it belongs to the master bar, so
   * readers take the first track that states one.
   */
  section?: string;
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
