/**
 * Harmony: what a chord symbol means, and what usually comes next.
 *
 * A songwriter works in chord names — "Am7", "C/G", "F#m7b5" — and everything a
 * songwriting tool does for them is derived from those five characters: which notes
 * sound, where a hand plays them, what the roman numeral is, what tends to follow.
 * This file is that derivation, kept pure and in core for the same reason the pitch
 * detector is: every claim in it can be tested exactly, with no browser in the loop.
 *
 * Two boundaries drawn on purpose.
 *
 * **The symbol is the source of truth.** The model stores the text the writer typed
 * and this file parses it on demand. Storing parsed intervals instead would mean
 * respelling on every export — a writer who typed "Bb" getting "A#" back is how a
 * tool tells a musician it does not speak their language.
 *
 * **Suggestion is not generation.** `suggestNext` ranks the chords that commonly
 * follow, drawn from functional harmony as first-year theory teaches it, and says
 * why in the label. It deliberately has no model of taste: the writer is composing,
 * and the tool's job is to keep the palette within reach, not to pick from it.
 */
import type { Instrument, KeySignature } from "./score.js";

export interface ParsedChord {
  /** Pitch class of the root, 0..11 with C at 0. */
  root: number;
  /** The root as spelled: "F#", "Bb". Kept so rendering never respells. */
  rootName: string;
  /**
   * Semitones above the root, 0 always included. Absolute rather than mod-12 —
   * a ninth is 14 — so a voicing generator can tell an add9 from an add2 if it
   * ever wants to, though pitch-class users take `mod 12`.
   */
  intervals: number[];
  /** Slash bass, when written: the pitch class and its spelling. */
  bass?: number;
  bassName?: string;
  /** Coarse family, for grouping and display: maj, min, dim, aug, sus, power. */
  quality: "maj" | "min" | "dim" | "aug" | "sus" | "power";
}

const NOTE_OF: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** A pitch class as a note name, spelled for the key it appears in. */
export function spellPitchClass(pc: number, preferFlats: boolean): string {
  const table = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  return table[((pc % 12) + 12) % 12]!;
}

/** Whether a key spells its accidentals as flats. Fifths below zero means flats. */
export function keyPrefersFlats(key: KeySignature): boolean {
  return key.fifths < 0;
}

/** Parses a note name with accidentals: "C", "F#", "Bb", "C##". Null if it is not one. */
function parseNoteName(text: string): { pc: number; length: number } | null {
  const letter = text[0]?.toUpperCase();
  if (letter === undefined || !(letter in NOTE_OF)) return null;
  let pc = NOTE_OF[letter]!;
  let i = 1;
  while (text[i] === "#" || text[i] === "b") {
    pc += text[i] === "#" ? 1 : -1;
    i += 1;
  }
  return { pc: ((pc % 12) + 12) % 12, length: i };
}

/** Base triads by family. Semitones above the root. */
const TRIADS: Record<ParsedChord["quality"], number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus: [0, 5, 7],
  power: [0, 7],
};

/**
 * Reads a chord symbol the way a guitarist writes one.
 *
 * The grammar is the practical chart vocabulary: triads, sixths, sevenths through
 * thirteenths, sus2/sus4, add chords, half- and fully-diminished, augmented, power
 * chords, the common alterations (b5 #5 b9 #9 #11 b13) with or without parentheses,
 * and a slash bass. Null for anything else, because a symbol this parser cannot read
 * is better refused than guessed: a wrong voicing sounds wrong, and the writer is
 * the only one who knows what they meant.
 */
export function parseChord(symbol: string): ParsedChord | null {
  const text = symbol.trim();
  if (text.length === 0) return null;

  const root = parseNoteName(text);
  if (!root) return null;
  const rootName = text.slice(0, root.length);
  let rest = text.slice(root.length);

  // The slash bass comes off the end first, so "C/G" parses however odd the middle
  // is. Only when what follows the slash is a note name, though: the slash in
  // "C6/9" belongs to the extension, not to a bass, and a parser that ate it would
  // refuse a symbol every jazz chart contains.
  let bass: { pc: number; name: string } | undefined;
  const slash = rest.lastIndexOf("/");
  if (slash >= 0) {
    const bassText = rest.slice(slash + 1);
    const parsed = parseNoteName(bassText);
    if (parsed && parsed.length === bassText.length) {
      bass = { pc: parsed.pc, name: bassText };
      rest = rest.slice(0, slash);
    }
  }

  // Family. Order matters: "maj" before "m", "dim" before "d"-nothing, "sus" as one.
  let quality: ParsedChord["quality"] = "maj";
  let seventh: number | null = null; // semitones of the seventh, when one is implied
  if (/^maj/i.test(rest) || rest.startsWith("M7") || rest.startsWith("M9") || rest.startsWith("M13")) {
    quality = "maj";
    seventh = 11;
    rest = rest.replace(/^maj/i, "").replace(/^M(?=7|9|13)/, "");
  } else if (/^(dim|°|o(?![a-z]))/.test(rest)) {
    quality = "dim";
    rest = rest.replace(/^(dim|°|o)/, "");
    // dim7 is the fully diminished seventh; a bare dim triad has none.
    if (rest.startsWith("7")) {
      seventh = 9;
      rest = rest.slice(1);
    }
  } else if (/^(aug|\+)/.test(rest)) {
    quality = "aug";
    rest = rest.replace(/^(aug|\+)/, "");
  } else if (/^(m7b5|ø7?|min7b5)/.test(rest)) {
    quality = "dim";
    seventh = 10;
    rest = rest.replace(/^(m7b5|ø7?|min7b5)/, "");
  } else if (/^(m|min|-)(?!aj)/.test(rest)) {
    quality = "min";
    rest = rest.replace(/^(min|m|-)/, "");
  } else if (/^sus/.test(rest)) {
    quality = "sus";
    rest = rest.replace(/^sus/, "");
  } else if (rest === "5") {
    quality = "power";
    rest = "";
  }

  const intervals = new Set<number>(TRIADS[quality]);

  // sus2 swaps the fourth for the second; bare "sus" means sus4.
  if (quality === "sus") {
    if (rest.startsWith("2")) {
      intervals.delete(5);
      intervals.add(2);
      rest = rest.slice(1);
    } else if (rest.startsWith("4")) {
      rest = rest.slice(1);
    }
  }

  // Extensions. A plain number after the family is the chart shorthand: 7 is a
  // seventh, 9 is a seventh plus a ninth, 13 is a seventh, ninth and thirteenth —
  // the eleventh left out of 13 chords the way every guitarist leaves it out.
  const extension = /^(6\/9|69|6|7|9|11|13)/.exec(rest);
  if (extension) {
    const token = extension[1]!;
    rest = rest.slice(token.length);
    switch (token) {
      case "6":
        intervals.add(9);
        break;
      case "69":
      case "6/9":
        intervals.add(9);
        intervals.add(14);
        break;
      case "7":
        intervals.add(seventh ?? 10);
        break;
      case "9":
        intervals.add(seventh ?? 10);
        intervals.add(14);
        break;
      case "11":
        intervals.add(seventh ?? 10);
        intervals.add(14);
        intervals.add(17);
        break;
      case "13":
        intervals.add(seventh ?? 10);
        intervals.add(14);
        intervals.add(21);
        break;
    }
  } else if (seventh !== null && quality === "dim") {
    // "Bdim7" and "Bm7b5" consumed their seventh during family parsing; "Cmaj"
    // written alone did not, and means the plain triad, so only dim keeps it here.
    intervals.add(seventh);
  }

  // Additions and alterations, in any order, parentheses optional.
  let guard = 0;
  while (rest.length > 0 && guard < 12) {
    guard += 1;
    const trimmed = rest.replace(/^[(),\s]+/, "");
    const add = /^add(2|4|9|11|13)/.exec(trimmed);
    if (add) {
      const tone = { "2": 2, "4": 5, "9": 14, "11": 17, "13": 21 }[add[1]!]!;
      intervals.add(tone);
      rest = trimmed.slice(add[0].length);
      continue;
    }
    const alter = /^(b5|#5|\+5|b9|#9|b13|#11)/.exec(trimmed);
    if (alter) {
      switch (alter[1]) {
        case "b5":
          intervals.delete(7);
          intervals.add(6);
          break;
        case "#5":
        case "+5":
          intervals.delete(7);
          intervals.add(8);
          break;
        case "b9":
          intervals.add(13);
          break;
        case "#9":
          intervals.add(15);
          break;
        case "#11":
          intervals.add(18);
          break;
        case "b13":
          intervals.add(20);
          break;
      }
      rest = trimmed.slice(alter[1]!.length);
      continue;
    }
    if (trimmed.length === 0) {
      rest = "";
      break;
    }
    // Something the grammar does not know. Refuse the whole symbol rather than
    // keep the part that parsed: half a chord is a different chord.
    return null;
  }
  if (rest.replace(/^[(),\s]+/, "").length > 0) return null;

  return {
    root: root.pc,
    rootName,
    intervals: [...intervals].sort((a, b) => a - b),
    ...(bass ? { bass: bass.pc, bassName: bass.name } : {}),
    quality,
  };
}

/** The pitch classes a chord contains. */
export function chordPitchClasses(chord: ParsedChord): Set<number> {
  const out = new Set<number>();
  for (const interval of chord.intervals) out.add((chord.root + interval) % 12);
  if (chord.bass !== undefined) out.add(chord.bass);
  return out;
}

/**
 * The chord as sounding pitches, for a preview. Root positioned near C3, stacked
 * upward; the slash bass placed below the rest, which is what the slash means.
 */
export function chordPitches(chord: ParsedChord): number[] {
  const base = 48 + chord.root; // C3 upward
  const out = chord.intervals.map((interval) => base + interval);
  if (chord.bass !== undefined) {
    let bass = 40 + ((chord.bass - 4 + 12) % 12); // E2 upward
    while (bass >= out[0]!) bass -= 12;
    out.unshift(bass);
  }
  return out;
}

/**
 * Moves a chord symbol by semitones, keeping its structure and respelling its root
 * for the destination key. This is why the parser exists even though the model
 * stores text: transposition is the one edit that has to understand the symbol.
 */
export function transposeChord(symbol: string, semitones: number, preferFlats: boolean): string | null {
  const parsed = parseChord(symbol);
  if (!parsed) return null;
  const rootName = spellPitchClass(parsed.root + semitones, preferFlats);
  const body = symbol.trim().slice(parsed.rootName.length);
  const slash = body.lastIndexOf("/");
  if (slash >= 0 && parsed.bass !== undefined) {
    const bassName = spellPitchClass(parsed.bass + semitones, preferFlats);
    return rootName + body.slice(0, slash + 1) + bassName;
  }
  return rootName + body;
}

export interface DiatonicChord {
  /** Roman numeral as taught: uppercase major, lowercase minor, ° diminished. */
  roman: string;
  /** The concrete symbol in this key: "Dm", "G7", "Bdim". */
  name: string;
  /** Scale degree, 1-based. */
  degree: number;
  root: number;
  quality: "maj" | "min" | "dim";
}

/** Major-scale intervals; natural minor comes from rotating the same circle. */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MAJOR_QUALITIES: Array<DiatonicChord["quality"]> = ["maj", "min", "min", "maj", "maj", "min", "dim"];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
const MINOR_QUALITIES: Array<DiatonicChord["quality"]> = ["min", "dim", "maj", "min", "min", "maj", "maj"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

/** The tonic pitch class of a key signature. */
export function tonicOf(key: KeySignature): number {
  // Each sharp moves the major tonic up a fifth from C; minor sits a minor third below.
  const majorTonic = (key.fifths * 7 + 120) % 12;
  return key.mode === "major" ? majorTonic : (majorTonic + 9) % 12;
}

/**
 * The seven chords a key offers, with their numerals.
 *
 * Minor keys get one deliberate adjustment: the V is given as major, the way songs
 * actually use it, with the natural minor's v available through `parseChord` if a
 * writer wants it. A suggestion engine that offers Em7 as the five of A minor is
 * technically defensible and musically useless.
 */
export function diatonicChords(key: KeySignature): DiatonicChord[] {
  const tonic = tonicOf(key);
  const flats = keyPrefersFlats(key);
  const steps = key.mode === "major" ? MAJOR_STEPS : MINOR_STEPS;
  const qualities = key.mode === "major" ? [...MAJOR_QUALITIES] : [...MINOR_QUALITIES];
  if (key.mode === "minor") qualities[4] = "maj";

  return steps.map((step, i) => {
    const root = (tonic + step) % 12;
    const quality = qualities[i]!;
    const numeral = ROMAN[i]!;
    const roman = quality === "maj" ? numeral : quality === "min" ? numeral.toLowerCase() : `${numeral.toLowerCase()}°`;
    const name =
      spellPitchClass(root, flats) + (quality === "min" ? "m" : quality === "dim" ? "dim" : "");
    return { roman, name, degree: i + 1, root, quality };
  });
}

/** Which scale degree a chord symbol sits on in a key, or null when it is not diatonic. */
export function analyseChord(symbol: string, key: KeySignature): DiatonicChord | null {
  const parsed = parseChord(symbol);
  if (!parsed) return null;
  const chords = diatonicChords(key);
  const match = chords.find((c) => c.root === parsed.root);
  if (!match) return null;
  // The degree has to agree in family too: an E major chord in C is not "iii", it is
  // a borrowed chord, and calling it iii would teach the writer something false.
  const family = parsed.quality === "min" ? "min" : parsed.quality === "dim" ? "dim" : "maj";
  if (parsed.quality !== "sus" && parsed.quality !== "power" && family !== match.quality) return null;
  return match;
}

/**
 * What tends to come next, ranked.
 *
 * The table is functional harmony's common moves — the ones chord charts are made
 * of — not a statistical model. Each entry names its reason, because a suggestion a
 * writer can see the logic of teaches the progression vocabulary while it autofills;
 * an unexplained ranking is just someone else's taste.
 */
const NEXT_BY_DEGREE: Record<number, Array<{ degree: number; why: string }>> = {
  1: [
    { degree: 4, why: "the classic move away from home" },
    { degree: 5, why: "sets up a return" },
    { degree: 6, why: "the deceptive turn" },
    { degree: 2, why: "starts a ii–V" },
  ],
  2: [
    { degree: 5, why: "ii resolves to V" },
    { degree: 4, why: "sidesteps into the subdominant" },
    { degree: 7, why: "leading-tone tension" },
  ],
  3: [
    { degree: 6, why: "iii falls to vi" },
    { degree: 4, why: "steps up to IV" },
    { degree: 2, why: "into the ii–V" },
  ],
  4: [
    { degree: 5, why: "the cadence" },
    { degree: 1, why: "plagal resolution" },
    { degree: 2, why: "swaps function within the subdominant" },
    { degree: 6, why: "softens back toward home" },
  ],
  5: [
    { degree: 1, why: "resolves home" },
    { degree: 6, why: "the deceptive cadence" },
    { degree: 4, why: "backs off the tension" },
  ],
  6: [
    { degree: 4, why: "the pop cycle continues" },
    { degree: 2, why: "into the ii–V" },
    { degree: 5, why: "straight to the cadence" },
    { degree: 1, why: "returns home" },
  ],
  7: [
    { degree: 1, why: "leading tone resolves" },
    { degree: 3, why: "defers the resolution" },
  ],
};

export interface ChordSuggestion {
  name: string;
  roman: string;
  why: string;
}

/**
 * Chords that commonly follow `previous` in this key, best first.
 *
 * With no previous chord — an empty chart — the openers: home, then the chords
 * nearly every progression is built from. With a previous chord the parser cannot
 * place in the key, the same openers, because "I do not know where you are, here is
 * somewhere to stand" beats guessing.
 */
export function suggestNext(previous: string | null, key: KeySignature): ChordSuggestion[] {
  const chords = diatonicChords(key);
  const byDegree = (degree: number) => chords[degree - 1]!;

  const placed = previous === null ? null : analyseChord(previous, key);
  if (!placed) {
    return [
      { ...byDegree(1), why: "home" },
      { ...byDegree(5), why: "the tension chord" },
      { ...byDegree(4), why: "the other pillar" },
      { ...byDegree(6), why: "the minor mirror of home" },
    ].map(({ name, roman, why }) => ({ name, roman, why }));
  }

  return (NEXT_BY_DEGREE[placed.degree] ?? []).map(({ degree, why }) => {
    const chord = byDegree(degree);
    return { name: chord.name, roman: chord.roman, why };
  });
}

/**
 * Chords that fit a bar's melody, best first.
 *
 * Scored by how much of the melody each diatonic chord contains, with the first
 * note counted double because the downbeat is what a listener hears the harmony
 * against. Deliberately diatonic-only: harmonising with borrowed chords is an
 * arranging decision, and this is a starting point a writer edits, not an arranger.
 */
export function harmonise(pitches: readonly number[], key: KeySignature): ChordSuggestion[] {
  if (pitches.length === 0) return [];
  const chords = diatonicChords(key);
  const weights = new Map<number, number>();
  for (const [i, pitch] of pitches.entries()) {
    const pc = ((pitch % 12) + 12) % 12;
    weights.set(pc, (weights.get(pc) ?? 0) + (i === 0 ? 2 : 1));
  }

  const scored = chords.map((chord) => {
    const tones = new Set(
      TRIADS[chord.quality === "dim" ? "dim" : chord.quality === "min" ? "min" : "maj"].map(
        (interval) => (chord.root + interval) % 12,
      ),
    );
    let score = 0;
    for (const [pc, weight] of weights) if (tones.has(pc)) score += weight;
    return { chord, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.chord.degree - b.chord.degree)
    .map(({ chord, score }) => ({
      name: chord.name,
      roman: chord.roman,
      why: `carries ${score >= 3 ? "most" : "some"} of the melody`,
    }));
}

export interface Voicing {
  /**
   * Fret per string, string 1 (highest) first to match the model; -1 is unplayed.
   */
  frets: number[];
  /** What sounds, low to high. */
  pitches: number[];
  /** Lowest fretted fret, for placing a diagram. 0 for open shapes. */
  position: number;
}

/**
 * Playable shapes for a chord on a given neck, best first.
 *
 * A voicing search rather than a shape dictionary, because a dictionary only knows
 * standard tuning and the six open keys. Searching means drop-D, DADGAD, a baritone
 * or a bass get correct voicings from the same code, which is the kind of thing this
 * product exists to get right.
 *
 * The constraints are a strumming hand's, not a theorist's: at most a three-fret
 * span, no muted string trapped between sounding ones, the bass note on the lowest
 * sounding string being the root (or the written slash bass), and every essential
 * tone present — root, the third or its sus replacement, and the seventh when the
 * symbol asks for one. Fifths and extensions are droppable, which is exactly how
 * guitarists actually voice.
 */
export function voicings(chord: ParsedChord, instrument: Instrument, limit = 5): Voicing[] {
  if (instrument.kind !== "fretted") return [];
  const tuning = instrument.tuning; // highest string first
  const strings = tuning.length;
  const pcs = chordPitchClasses(chord);
  const third = chord.intervals.find((i) => i === 3 || i === 4 || i === 2 || i === 5);
  const seventh = chord.intervals.find((i) => i === 9 || i === 10 || i === 11);
  const essentials = new Set<number>([chord.root % 12]);
  if (third !== undefined && chord.quality !== "power") essentials.add((chord.root + third) % 12);
  if (seventh !== undefined) essentials.add((chord.root + seventh) % 12);
  const bassPc = chord.bass ?? chord.root;

  const found = new Map<string, Voicing & { score: number }>();

  for (let position = 0; position <= 12; position += 1) {
    // Candidates per string, low string first so the DFS settles the bass first.
    const candidates: number[][] = [];
    for (let s = strings - 1; s >= 0; s -= 1) {
      const open = tuning[s]! + instrument.capo;
      const options: number[] = [-1];
      if (pcs.has(open % 12)) options.push(0);
      for (let fret = Math.max(1, position); fret <= position + 3 && fret <= instrument.frets; fret += 1) {
        if (pcs.has((open + fret) % 12)) options.push(fret);
      }
      candidates.push(options);
    }

    const frets: number[] = [];
    const walk = (stringIndex: number) => {
      if (stringIndex === candidates.length) {
        finish();
        return;
      }
      for (const fret of candidates[stringIndex]!) {
        frets.push(fret);
        walk(stringIndex + 1);
        frets.pop();
      }
    };

    const finish = () => {
      // frets is low string → high string here.
      const sounding = frets.filter((f) => f >= 0).length;
      if (sounding < Math.min(3, strings)) return;
      // No muted string inside the strummed span.
      const first = frets.findIndex((f) => f >= 0);
      let last = -1;
      for (let i = frets.length - 1; i >= 0; i -= 1) {
        if (frets[i]! >= 0) {
          last = i;
          break;
        }
      }
      for (let i = first; i <= last; i += 1) if (frets[i]! < 0) return;

      const fretted = frets.filter((f) => f > 0);
      if (fretted.length > 0) {
        const span = Math.max(...fretted) - Math.min(...fretted);
        if (span > 3) return;
        // A hand has four fingers, and a barre only rescues same-fret notes.
        const distinct = new Set(fretted);
        const lowest = Math.min(...fretted);
        const barred = fretted.filter((f) => f === lowest).length;
        const fingersNeeded = fretted.length - (barred > 1 ? barred - 1 : 0);
        if (fingersNeeded > 4 && distinct.size > 1) return;
      }

      const pitches: number[] = [];
      const covered = new Set<number>();
      for (let i = 0; i < frets.length; i += 1) {
        const fret = frets[i]!;
        if (fret < 0) continue;
        const stringNumber = strings - i; // back to model numbering
        const pitch = tuning[stringNumber - 1]! + instrument.capo + fret;
        pitches.push(pitch);
        covered.add(pitch % 12);
      }
      for (const essential of essentials) if (!covered.has(essential)) return;
      if (pitches[0]! % 12 !== bassPc) return;

      // Highest string first, to match how the model numbers strings.
      const modelOrder = [...frets].reverse();
      const key = modelOrder.join(",");
      const opens = frets.filter((f) => f === 0).length;
      const lowestFretted = fretted.length > 0 ? Math.min(...fretted) : 0;
      const score =
        sounding * 3 +
        opens * 1.5 -
        lowestFretted * 0.8 -
        (fretted.length > 0 ? Math.max(...fretted) - lowestFretted : 0) +
        // Extensions actually sounding are worth having once essentials are safe.
        [...covered].filter((pc) => pcs.has(pc)).length;
      const existing = found.get(key);
      if (!existing || existing.score < score) {
        found.set(key, { frets: modelOrder, pitches, position: lowestFretted, score });
      }
    };

    walk(0);
  }

  return [...found.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ frets, pitches, position }) => ({ frets, pitches, position }));
}

/**
 * The chord in force at each bar of a track: stated chords carried forward, the way
 * a chart is read. Bars before the first chord are null rather than guessed.
 */
export function chordByBar(track: { bars: Array<{ voices: Array<{ beats: Array<{ chord?: string }> }> }> }): Array<string | null> {
  const out: Array<string | null> = [];
  let current: string | null = null;
  for (const bar of track.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.chord !== undefined) {
          current = beat.chord;
          break;
        }
      }
      break; // chords live on the first voice; a second voice restating them is noise
    }
    out.push(current);
  }
  return out;
}
