/**
 * ASCII tablature export.
 *
 * The format the largest number of guitarists actually exchange, and the one every
 * notation program treats as beneath it. It is what people paste into a forum, a
 * text message, or a band's group chat, and being good at it is worth more to a
 * working musician than another binary format nobody can open without buying
 * something.
 *
 * Written from the semantic model, so it carries what the document says. Two
 * decisions worth naming:
 *
 * **Spacing is proportional to duration.** A bar of four quarters and a bar of
 * sixteen sixteenths are not the same width. ASCII tab has no rhythm notation, so
 * spacing is the only rhythm information the format can carry at all — and a tab
 * where a held note looks the same as a fast one is the difference between a tab
 * you can play from and a tab you have to already know.
 *
 * **Repeats are marked, not expanded.** Unlike the MIDI export, which writes a
 * performance, this writes *notation*: `|` with a repeat marker, because a reader
 * is a person who can follow one and would rather not scroll through the chorus
 * three times.
 */
import { beatTicks, QUARTER_TICKS, type Articulation, type Bar, type Score, type Track } from "@cubscore/core";

export interface AsciiExportReport {
  unsupported: string[];
  trackCount: number;
  /** Lines emitted, so a caller can tell a tab from an empty document. */
  lineCount: number;
}

export interface AsciiExportResult {
  text: string;
  report: AsciiExportReport;
}

export interface AsciiOptions {
  /** Wrap point. 76 fits an email, a terminal, and a phone in landscape. */
  width?: number;
  /** Include the title, artist and tuning header. */
  header?: boolean;
}

/** One character per sixteenth note: the classic look, and it reads at a glance. */
const CHARS_PER_SIXTEENTH = 1;
const SIXTEENTH_TICKS = QUARTER_TICKS / 4;

/** Note names for the tuning header, so a reader knows what to tune to. */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteName(pitch: number): string {
  return NOTE_NAMES[((pitch % 12) + 12) % 12] ?? "?";
}

/**
 * String labels, high string first.
 *
 * The top string is lower case and the rest upper: `e B G D A E`. That is not
 * decoration — a guitar's top and bottom strings are both E, and the case is how
 * every hand-written tab tells them apart. It is also what makes a six-line block
 * recognisable as a guitar before you have read a single fret.
 */
function stringLabels(track: Track): string[] {
  if (track.instrument.kind !== "fretted") return [];
  const { tuning } = track.instrument;
  return tuning.map((pitch, i) => (i === 0 ? noteName(pitch).toLowerCase() : noteName(pitch)).padEnd(2, " "));
}

/** The ASCII marker for an articulation, or null when the format has none. */
function marker(articulations: readonly Articulation[]): string | null {
  if (articulations.includes("deadNote")) return "x";
  if (articulations.includes("hammerOn")) return "h";
  if (articulations.includes("pullOff")) return "p";
  if (articulations.includes("slide")) return "/";
  if (articulations.includes("bend")) return "b";
  if (articulations.includes("vibrato")) return "~";
  if (articulations.includes("naturalHarmonic")) return "*";
  return null;
}

/** One bar rendered as a column block: `strings` rows of equal width. */
interface BarBlock {
  rows: string[];
  /**
   * Chord symbols above the staff and lyrics below it, both exactly as wide as the
   * string rows so a name sits over the beat it belongs to. Alignment is the whole
   * value of a chord line — a chart whose changes drift off their beats is worse
   * than no chart.
   */
  chords: string;
  lyrics: string;
  /** Section starting at this bar, which forces a new system with a heading. */
  section?: string;
  /** Rendered above the staff, for the bar number. */
  label: string;
  /** Prefix on the bar line, for a repeat opening. */
  openRepeat: boolean;
  closeRepeat: number;
}

function renderBar(bar: Bar | undefined, stringCount: number, unsupported: Set<string>): BarBlock {
  const rows = Array.from({ length: stringCount }, () => "");
  let chords = "";
  let lyrics = "";
  const voice = bar?.voices[0];
  if (bar && bar.voices.length > 1) {
    unsupported.add("multiple voices per bar (only the first is written)");
  }

  for (const beat of voice?.beats ?? []) {
    // Width from the beat's own duration, so rhythm survives as spacing — the only
    // rhythm information ASCII tab can carry.
    const ticks = beatTicks(beat);
    const wanted = Math.max(2, Math.round((ticks / SIXTEENTH_TICKS) * CHARS_PER_SIXTEENTH) + 1);

    // What each string shows for this beat.
    const cells = Array.from({ length: stringCount }, () => "");
    for (const note of beat.notes) {
      const stringIndex = (note.string ?? 1) - 1;
      if (stringIndex < 0 || stringIndex >= stringCount) continue;
      const fret = note.fret;
      if (fret === undefined) {
        unsupported.add("notes without a fret (a pitched staff cannot be written as tablature)");
        continue;
      }
      const tag = marker(note.articulations);
      cells[stringIndex] = `${fret}${tag ?? ""}`;
      if (note.articulations.length > 0 && tag === null) {
        unsupported.add("some articulations have no ASCII marker and are dropped");
      }
      if (note.tiedToNext) unsupported.add("ties (no ASCII notation, written as separate frets)");
    }

    // The beat's slot is widened for a long chord name or syllable rather than
    // letting either overflow into the next beat's column: overflow is exactly the
    // misalignment the chord line exists to avoid.
    const width = Math.max(
      wanted,
      ...cells.map((c) => c.length + 1),
      (beat.chord?.length ?? 0) + 1,
      (beat.lyric?.length ?? 0) + 1,
    );
    for (let i = 0; i < stringCount; i += 1) {
      const cell = cells[i] ?? "";
      // Frets are left-aligned in their slot and the rest is dashes, which is how a
      // hand-written tab reads: the number sits on the beat.
      rows[i] += cell.padEnd(width, "-");
    }
    chords += (beat.chord ?? "").padEnd(width, " ");
    lyrics += (beat.lyric ?? "").padEnd(width, " ");
    if (beat.tuplet) unsupported.add("tuplets (written as their spacing only)");
    if (beat.dots > 0) unsupported.add("dotted rhythms (written as their spacing only)");
  }

  // An empty bar still needs width, or the bar lines collapse together.
  if ((voice?.beats.length ?? 0) === 0) {
    for (let i = 0; i < stringCount; i += 1) rows[i] = "-".repeat(4);
    chords = " ".repeat(4);
    lyrics = " ".repeat(4);
  }

  return {
    rows,
    chords,
    lyrics,
    ...(bar?.section !== undefined ? { section: bar.section } : {}),
    label: "",
    openRepeat: bar?.repeat?.start === true,
    closeRepeat: bar?.repeat?.endCount ?? 0,
  };
}

export function toAscii(score: Score, options: AsciiOptions = {}): AsciiExportResult {
  const width = Math.max(32, options.width ?? 76);
  const unsupported = new Set<string>();
  const out: string[] = [];

  if (options.header !== false) {
    if (score.title) out.push(score.title);
    if (score.artist) out.push(score.artist);
    if (score.title || score.artist) out.push("");
  }

  const writable = score.tracks.filter((t) => t.instrument.kind === "fretted");
  for (const track of score.tracks) {
    if (track.instrument.kind === "drums") unsupported.add(`drum track "${track.name}" (no ASCII drum notation)`);
    if (track.instrument.kind === "pitched") {
      unsupported.add(`pitched staff "${track.name}" (has no strings to write frets on)`);
    }
  }

  for (const [index, track] of writable.entries()) {
    if (track.instrument.kind !== "fretted") continue;
    const labels = stringLabels(track);
    const strings = labels.length;
    if (writable.length > 1) out.push(`[${track.name || `Track ${index + 1}`}]`);
    if (options.header !== false) {
      out.push(`Tuning: ${[...track.instrument.tuning].reverse().map(noteName).join(" ")}`);
      if (track.instrument.capo > 0) out.push(`Capo: fret ${track.instrument.capo}`);
      out.push("");
    }

    const blocks = track.bars.map((bar) => renderBar(bar, strings, unsupported));

    // Wrap into systems that fit the line width, never splitting a bar.
    const labelWidth = (labels[0]?.length ?? 1) + 1;
    let system: BarBlock[] = [];
    let used = labelWidth;
    const flush = () => {
      if (system.length === 0) return;
      // The chord line rides above the staff, spaced to match the bar lines below
      // it — a space where the staff has `|` or `:` — and appears only when a bar
      // in the system actually has a chart, so an unlabelled tab stays six lines.
      const spacer = (block: BarBlock, row: string) =>
        `${block.openRepeat ? " " : ""}${row}${block.closeRepeat > 1 ? "  " : " "}`;
      if (system.some((block) => block.chords.trim() !== "")) {
        out.push(`${" ".repeat(labelWidth)}${system.map((b) => spacer(b, b.chords)).join("")}`.trimEnd());
      }
      for (let s = 0; s < strings; s += 1) {
        let line = `${labels[s] ?? ""}|`;
        for (const block of system) {
          if (block.openRepeat) line += ":";
          line += block.rows[s] ?? "";
          line += block.closeRepeat > 1 ? ":|" : "|";
        }
        out.push(line);
      }
      if (system.some((block) => block.lyrics.trim() !== "")) {
        out.push(`${" ".repeat(labelWidth)}${system.map((b) => spacer(b, b.lyrics)).join("")}`.trimEnd());
      }
      out.push("");
      system = [];
      used = labelWidth;
    };

    for (const block of blocks) {
      const cost = (block.rows[0]?.length ?? 0) + 1 + (block.openRepeat ? 1 : 0) + (block.closeRepeat > 1 ? 1 : 0);
      // A named section starts its own system under its own heading, the way every
      // hand-typed tab lays out a song.
      if (block.section !== undefined) {
        flush();
        out.push(`[${block.section}]`);
      }
      if (system.length > 0 && used + cost > width) flush();
      system.push(block);
      used += cost;
    }
    flush();
  }

  if (writable.length === 0) {
    unsupported.add("nothing in this score can be written as tablature");
  }

  // One trailing blank line rather than several: the last flush always adds one.
  while (out.length > 0 && out.at(-1) === "") out.pop();
  const text = out.length > 0 ? `${out.join("\n")}\n` : "";

  return {
    text,
    report: {
      unsupported: [...unsupported].sort(),
      trackCount: writable.length,
      lineCount: out.length,
    },
  };
}
