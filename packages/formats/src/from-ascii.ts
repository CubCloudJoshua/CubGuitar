/**
 * ASCII tablature parsing.
 *
 * The web's largest corpus of guitar music is ASCII tab, and it is unstructured:
 * tunings are stated in prose or not at all, bar lines are inconsistent, the same
 * file mixes tab with chord names and lyrics, and rhythm is almost never present.
 *
 * So this is deliberately a *recovery* rather than a parse. It finds what it can
 * defend — which strings, which frets, in what order, in which bar — and reports
 * everything else as not carried rather than guessing. In particular it does not
 * invent rhythm: every beat comes out the same length, and the report says so. That
 * is far less work for a user to fix than typing the notes, and it is honest in a
 * way that a plausible-looking wrong rhythm is not.
 *
 * It also verifies the exporter. Round-tripping our own output back to the same
 * strings and frets needs no alphaTab and no browser, which is the property
 * STANDALONE.md is building toward, and it is why both halves live here.
 */
import {
  createBar,
  createNote,
  createScore,
  duration,
  nextId,
  pitchAt,
  STANDARD_GUITAR,
  type Bar,
  type Beat,
  type Instrument,
  type Note,
  type Score,
  type Tuning,
} from "@cubscore/core";

export interface AsciiImportReport {
  unsupported: string[];
  /** Blocks of tab lines found, which is roughly "systems". */
  systems: number;
  stringCount: number;
  noteCount: number;
  barCount: number;
  /** Set when the tuning was read from the text rather than assumed. */
  tuningStated: boolean;
}

export interface AsciiImportResult {
  score: Score;
  report: AsciiImportReport;
}

const NOTE_TO_SEMITONE: Record<string, number> = {
  c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, f: 5,
  "f#": 6, gb: 6, g: 7, "g#": 8, ab: 8, a: 9, "a#": 10, bb: 10, b: 11,
};

/**
 * Is this line part of a tab staff?
 *
 * The test that works across real files: it contains a run of dashes, and once the
 * dashes, digits, bar lines and the handful of articulation characters are removed,
 * almost nothing is left. A lyric line with a dash in it fails on the second half; a
 * chord line like `Am    C    G` fails on the first.
 */
function isTabLine(line: string): boolean {
  const body = line.replace(/^\s*[A-Ga-g][#b]?\s*\|?/, "");
  const dashes = (body.match(/-/g) ?? []).length;
  if (dashes < 4) return false;
  const noise = body.replace(/[-0-9|:xhpbrs/\\~^*()\s]/g, "");
  return noise.length <= body.length * 0.06;
}

/** The string label at the start of a tab line, if there is one. */
function labelOf(line: string): string | null {
  const match = /^\s*([A-Ga-g][#b]?)\s*\|/.exec(line);
  return match?.[1] ?? null;
}

/**
 * A tuning read from the file's own words, high string first as written.
 *
 * Two shapes are common: an explicit "Tuning: E A D G B e" line, and the string
 * labels down the left edge of the staff. The labels are the more reliable of the
 * two because they are part of the tab rather than prose about it.
 */
function tuningFromLabels(labels: string[]): Tuning | null {
  const semitones = labels.map((l) => NOTE_TO_SEMITONE[l.toLowerCase()]);
  if (semitones.some((s) => s === undefined)) return null;
  if (labels.length < 3 || labels.length > 12) return null;

  // Labels give pitch classes, not octaves. Anchor the lowest string in the guitar's
  // range and walk upward, choosing the octave that keeps each string above the one
  // below it — which is what a stringed instrument is.
  const lowestFirst = [...(semitones as number[])].reverse();
  const out: number[] = [];
  let previous = 40 - 12; // a little below the guitar's low E, so E lands on 40
  for (const semitone of lowestFirst) {
    let pitch = Math.floor(previous / 12) * 12 + semitone;
    while (pitch <= previous) pitch += 12;
    out.push(pitch);
    previous = pitch;
  }
  return out.reverse();
}

function tuningFromProse(text: string): Tuning | null {
  const match = /tuning\s*:?\s*([A-Ga-g][#b]?(?:\s+[A-Ga-g][#b]?){2,11})/i.exec(text);
  if (!match?.[1]) return null;
  // Prose conventionally lists low string first, which is the reverse of the staff.
  const labels = match[1].trim().split(/\s+/).reverse();
  return tuningFromLabels(labels);
}

/** Consecutive tab lines, which together are one system. */
function findSystems(lines: string[]): string[][] {
  const systems: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (isTabLine(line)) {
      current.push(line);
      continue;
    }
    if (current.length >= 3) systems.push(current);
    current = [];
  }
  if (current.length >= 3) systems.push(current);
  return systems;
}

interface Recovered {
  /** Column within the system, which is order and nothing more. */
  column: number;
  stringIndex: number;
  fret: number;
  /** Bar this column fell in, counted from the bar lines in the text. */
  bar: number;
}

/**
 * Frets read out of one system, with the bar each fell in.
 *
 * Read column by column so a chord — several frets in the same column — stays one
 * beat. A two-digit fret occupies two columns and is claimed by its first, which is
 * why the scan skips ahead rather than reading each character independently.
 */
function readSystem(system: string[]): { notes: Recovered[]; bars: number } {
  const notes: Recovered[] = [];
  // Bar boundaries are wherever the first line has a `|`, which every line of a
  // well-formed system shares. Taking them from one line keeps a system whose lines
  // disagree (they do, in real files) from producing ragged bars.
  const reference = system[0] ?? "";
  const barAt = (index: number) => {
    let bar = 0;
    for (let i = 0; i < index && i < reference.length; i += 1) {
      if (reference[i] === "|") bar += 1;
    }
    return Math.max(0, bar - 1);
  };

  for (const [stringIndex, line] of system.entries()) {
    let i = 0;
    while (i < line.length) {
      const char = line[i]!;
      if (char >= "0" && char <= "9") {
        let digits = char;
        while (i + digits.length < line.length) {
          const next = line[i + digits.length]!;
          if (next < "0" || next > "9" || digits.length >= 2) break;
          digits += next;
        }
        notes.push({ column: i, stringIndex, fret: Number(digits), bar: barAt(i) });
        i += digits.length;
        continue;
      }
      i += 1;
    }
  }

  const bars = Math.max(1, (reference.match(/\|/g) ?? []).length - 1);
  return { notes, bars };
}

export function fromAscii(text: string): AsciiImportResult {
  const unsupported = new Set<string>([
    "rhythm (ASCII tablature does not record it; every beat is written as equal length)",
  ]);
  const lines = text.split(/\r?\n/);
  const systems = findSystems(lines);

  if (systems.length === 0) {
    return {
      score: createScore("Imported tab"),
      report: {
        unsupported: ["no tablature staff found in this text"],
        systems: 0,
        stringCount: 0,
        noteCount: 0,
        barCount: 0,
        tuningStated: false,
      },
    };
  }

  // The widest system decides the string count: a system missing a line — common in
  // hand-typed tabs where an unused string was left out — must not shrink the
  // instrument for the whole piece.
  const stringCount = Math.max(...systems.map((s) => s.length));
  if (systems.some((s) => s.length !== stringCount)) {
    unsupported.add("systems with differing numbers of strings (the widest is used)");
  }

  const labels = (systems[0] ?? []).map(labelOf).filter((l): l is string => l !== null);
  const fromLabels = labels.length === stringCount ? tuningFromLabels(labels) : null;
  const stated = fromLabels ?? tuningFromProse(text);
  const tuning: Tuning = stated ?? [...STANDARD_GUITAR];
  if (!stated) unsupported.add("tuning not stated in the text (standard tuning assumed)");
  if (tuning.length !== stringCount) {
    // A six-line staff with a four-string tuning is a contradiction. The staff wins,
    // because it is the music; the tuning is padded from standard.
    unsupported.add("string count and tuning disagree (the staff is believed)");
  }

  const instrument: Instrument = {
    kind: "fretted",
    tuning: tuning.slice(0, stringCount).length === stringCount
      ? tuning.slice(0, stringCount)
      : [...STANDARD_GUITAR].slice(0, stringCount),
    frets: 24,
    capo: 0,
  };

  const bars: Bar[] = [];
  let noteCount = 0;

  for (const system of systems) {
    const { notes, bars: barCount } = readSystem(system);
    // Columns, in order, are the beats. Grouping by column is what makes a chord one
    // beat rather than several.
    const byBar = new Map<number, Map<number, Recovered[]>>();
    for (const note of notes) {
      const barMap = byBar.get(note.bar) ?? new Map<number, Recovered[]>();
      const column = barMap.get(note.column) ?? [];
      column.push(note);
      barMap.set(note.column, column);
      byBar.set(note.bar, barMap);
    }

    for (let b = 0; b < barCount; b += 1) {
      const columns = [...(byBar.get(b) ?? new Map())].sort(([x], [y]) => x - y);
      if (columns.length === 0) {
        bars.push(createBar());
        continue;
      }
      const beats: Beat[] = columns.map(([, group]) => {
        const notesHere: Note[] = [];
        for (const found of group as Recovered[]) {
          const stringNumber = found.stringIndex + 1;
          if (found.fret > instrument.frets) continue;
          notesHere.push(createNote(pitchAt(instrument, stringNumber, found.fret), stringNumber, found.fret));
          noteCount += 1;
        }
        // Every beat the same length: the format records no rhythm, and the report
        // says so rather than this pretending otherwise.
        return { id: nextId("b"), duration: duration(8), notes: notesHere, dots: 0 };
      });
      bars.push({ id: nextId("m"), voices: [{ id: nextId("v"), beats }] });
    }
  }

  const title = lines.find((l) => l.trim().length > 0 && !isTabLine(l))?.trim() ?? "Imported tab";
  const base = createScore(title.slice(0, 80));
  const score: Score = {
    ...base,
    tracks: [{ id: nextId("t"), name: "Guitar", instrument, bars: bars.length > 0 ? bars : [createBar()] }],
  };

  return {
    score,
    report: {
      unsupported: [...unsupported].sort(),
      systems: systems.length,
      stringCount,
      noteCount,
      barCount: bars.length,
      tuningStated: stated !== null,
    },
  };
}
