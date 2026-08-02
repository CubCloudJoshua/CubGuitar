/**
 * MusicXML export.
 *
 * The one interchange format the whole notation world reads: MuseScore, Sibelius,
 * Dorico, Finale, Flat, Soundslice and Guitar Pro itself. Guitar Pro's own format is
 * how guitarists trade files with each other; MusicXML is how a guitarist hands a
 * part to an arranger, a teacher hands an exercise to a student on different software,
 * and a school gets our work into whatever it already owns. Not having it was the
 * cheapest hard objection anyone could raise, and it is the reason this exists.
 *
 * Written from the semantic model rather than from a renderer, like every other
 * exporter here, so the file says what the document says.
 *
 * Three decisions worth naming.
 *
 * **Tablature is written as tablature.** MusicXML has had `<staff-details>` with
 * `<staff-tuning>`, a `TAB` clef, and `<string>`/`<fret>` on a note since 1.0, and
 * most exporters that claim MusicXML support for guitar write pitches and throw the
 * fingering away. A fretted part exported from here carries its tuning and the string
 * and fret of every note, so it arrives in MuseScore as a tab staff and not as a
 * treble staff full of notes nobody can place.
 *
 * **Repeats are written as notation, not expanded.** Like the ASCII export and unlike
 * the MIDI one: MusicXML is a document format, and a reader on the other end wants the
 * repeat sign rather than three copies of the chorus.
 *
 * **Divisions are our own tick clock.** `QUARTER_TICKS` is 960 and `<divisions>` is
 * declared as 960, so no duration is ever converted and no tuplet is ever rounded on
 * the way out. Every rounding error a format conversion can introduce is one that has
 * to be introduced somewhere, and refusing to introduce it here costs nothing.
 */
import {
  beatTicks,
  QUARTER_TICKS,
  type Articulation,
  type Bar,
  type Beat,
  type Instrument,
  type Note,
  type Score,
  type Track,
} from "@cubscore/core";
import { parseChord } from "@cubscore/core";
import { escapeXml } from "./xml.js";

export interface MusicXmlExportReport {
  /** What the format, or our model, could not carry. Shown to the user. */
  unsupported: string[];
  trackCount: number;
  barCount: number;
  noteCount: number;
}

export interface MusicXmlExportResult {
  text: string;
  report: MusicXmlExportReport;
}

export interface MusicXmlOptions {
  /**
   * Encoding date, as `YYYY-MM-DD`.
   *
   * Passed in rather than read from the clock so the same document exports to the
   * same bytes. A file format whose output changes every second cannot be diffed, and
   * cannot be compared against a fixture in a test.
   */
  encodedOn?: string;
}

/** MusicXML note type names by duration denominator. */
const TYPE_NAMES: Record<number, string> = {
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "16th",
  32: "32nd",
  64: "64th",
  128: "128th",
};

/** Sharp spelling: step and alteration for each pitch class. */
const SHARP_SPELLING: Array<[string, number]> = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
  ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];
/** Flat spelling, used in flat keys so a reader sees Bb rather than A#. */
const FLAT_SPELLING: Array<[string, number]> = [
  ["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0],
  ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0],
];

/**
 * A MIDI pitch as a written note.
 *
 * Spelled with flats in a flat key and sharps otherwise. This is not cosmetic: a
 * reader handed A# in the key of F reads an accidental that does not belong to the
 * key and has to work out what was meant. Choosing by key signature gets the common
 * cases right without a full spelling algorithm, and the model has no enharmonic
 * information to do better with.
 */
function spell(pitch: number, fifths: number): { step: string; alter: number; octave: number } {
  const table = fifths < 0 ? FLAT_SPELLING : SHARP_SPELLING;
  const entry = table[((pitch % 12) + 12) % 12] ?? ["C", 0];
  const octave = Math.floor(pitch / 12) - 1;
  return { step: entry[0], alter: entry[1], octave };
}

/** Note name and octave for a tuning entry, for `<staff-tuning>`. */
function tuningOf(pitch: number): { step: string; alter: number; octave: number } {
  return spell(pitch, 0);
}

function open(name: string, attrs: Record<string, string | number> = {}): string {
  const rendered = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join("");
  return `<${name}${rendered}>`;
}

function leaf(name: string, value: string | number, attrs: Record<string, string | number> = {}): string {
  return `${open(name, attrs)}${escapeXml(String(value))}</${name}>`;
}

function empty(name: string, attrs: Record<string, string | number> = {}): string {
  const rendered = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join("");
  return `<${name}${rendered}/>`;
}

/** A writer that keeps its own indentation, so the output is readable by a human. */
class Xml {
  private readonly lines: string[] = [];
  private depth = 0;

  line(text: string): void {
    this.lines.push("  ".repeat(this.depth) + text);
  }

  /** Opens an element, writes whatever the body adds, and closes it. */
  block(name: string, attrs: Record<string, string | number>, body: () => void): void {
    this.line(open(name, attrs));
    this.depth += 1;
    body();
    this.depth -= 1;
    this.line(`</${name}>`);
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

/** The MIDI program a part should announce. */
function midiProgram(instrument: Instrument): number {
  if (instrument.kind === "pitched") return instrument.midiProgram;
  // 25 is the General MIDI acoustic guitar (nylon), 0-based, which is what a fretted
  // staff with no program of its own should sound like rather than a piano.
  return instrument.kind === "fretted" ? 25 : 0;
}

/**
 * Notes of a beat in the order MusicXML wants them.
 *
 * Lowest sounding first, because that is the convention every notation program's
 * chord reader assumes, and because the first note of a chord is the one that carries
 * the duration while the rest carry `<chord/>`. Ordering by string where there is one
 * keeps a guitar chord in the order a guitarist strums it.
 */
function chordOrder(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.string !== undefined && b.string !== undefined) return b.string - a.string;
    return a.pitch - b.pitch;
  });
}

export function toMusicXml(score: Score, options: MusicXmlOptions = {}): MusicXmlExportResult {
  const unsupported = new Set<string>();
  const xml = new Xml();
  let noteCount = 0;

  const renderable = score.tracks;
  const barCount = Math.max(0, ...renderable.map((t) => t.bars.length));

  xml.line('<?xml version="1.0" encoding="UTF-8"?>');
  xml.line(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" ' +
      '"http://www.musicxml.org/dtds/partwise.dtd">',
  );
  xml.block("score-partwise", { version: "4.0" }, () => {
    xml.block("work", {}, () => xml.line(leaf("work-title", score.title || "Untitled")));
    xml.block("identification", {}, () => {
      if (score.artist) xml.line(leaf("creator", score.artist, { type: "composer" }));
      xml.block("encoding", {}, () => {
        if (options.encodedOn) xml.line(leaf("encoding-date", options.encodedOn));
        xml.line(leaf("software", "CubScore"));
        // Declared explicitly because a reader that does not see this support
        // statement is entitled to ignore our string and fret elements.
        xml.line(empty("supports", { element: "print", type: "no" }));
      });
    });

    xml.block("part-list", {}, () => {
      for (const [index, track] of renderable.entries()) {
        const id = `P${index + 1}`;
        xml.block("score-part", { id }, () => {
          xml.line(leaf("part-name", track.name || `Part ${index + 1}`));
          xml.block("score-instrument", { id: `${id}-I1` }, () => {
            xml.line(leaf("instrument-name", track.name || `Part ${index + 1}`));
          });
          xml.block("midi-instrument", { id: `${id}-I1` }, () => {
            // Never channel 10, even for a drum part. Channel 10 tells a reader the
            // part is percussion and to map written positions to drum voices, and the
            // notes we write are pitched — the model's drum voices go out as the
            // pitches they sound at, which the report says plainly. Declaring
            // percussion over pitched content makes a file that contradicts itself,
            // and alphaTab read it a semitone out, which is how this was found.
            xml.line(leaf("midi-channel", (index % 15) + 1));
            xml.line(leaf("midi-program", midiProgram(track.instrument) + 1));
          });
        });
      }
    });

    for (const [index, track] of renderable.entries()) {
      writePart(xml, track, `P${index + 1}`, barCount, unsupported, (n) => (noteCount += n));
    }
  });

  if (score.tracks.some((t) => t.instrument.kind === "drums")) {
    unsupported.add("drum notation (percussion parts export as pitched notes)");
  }

  return {
    text: `${xml.toString()}\n`,
    report: { unsupported: [...unsupported].sort(), trackCount: renderable.length, barCount, noteCount },
  };
}

function writePart(
  xml: Xml,
  track: Track,
  id: string,
  barCount: number,
  unsupported: Set<string>,
  countNotes: (n: number) => void,
): void {
  xml.block("part", { id }, () => {
    let meter = { beats: 4, beatValue: 4 };
    let fifths = 0;
    for (let index = 0; index < barCount; index += 1) {
      const bar = track.bars[index];
      const stated = bar?.timeSignature;
      if (stated) meter = { beats: stated.beats, beatValue: stated.beatValue };
      if (bar?.keySignature) fifths = bar.keySignature.fifths;
      writeMeasure(xml, track, bar, index, meter, fifths, unsupported, countNotes);
    }
  });
}

function writeMeasure(
  xml: Xml,
  track: Track,
  bar: Bar | undefined,
  index: number,
  meter: { beats: number; beatValue: number },
  fifths: number,
  unsupported: Set<string>,
  countNotes: (n: number) => void,
): void {
  xml.block("measure", { number: index + 1 }, () => {
    const first = index === 0;
    const newMeter = first || bar?.timeSignature !== undefined;
    const newKey = first || bar?.keySignature !== undefined;
    if (newMeter || newKey) {
      xml.block("attributes", {}, () => {
        // Divisions belongs to the first measure only; restating it is legal and
        // confuses some readers into resetting their own clock.
        if (first) xml.line(leaf("divisions", QUARTER_TICKS));
        if (newKey) {
          xml.block("key", {}, () => {
            xml.line(leaf("fifths", fifths));
            xml.line(leaf("mode", bar?.keySignature?.mode ?? "major"));
          });
        }
        if (newMeter) {
          xml.block("time", {}, () => {
            xml.line(leaf("beats", meter.beats));
            xml.line(leaf("beat-type", meter.beatValue));
          });
        }
        if (first) writeStaffKind(xml, track.instrument);
      });
    }

    if (bar?.repeat?.start) {
      xml.block("barline", { location: "left" }, () => {
        xml.line(leaf("bar-style", "heavy-light"));
        xml.line(empty("repeat", { direction: "forward" }));
      });
    }

    if (bar?.section !== undefined) {
      // Sections travel as rehearsal marks, which is what every notation program
      // shows at a bar and what MusicXML has instead of named song structure.
      xml.block("direction", { placement: "above" }, () => {
        xml.block("direction-type", {}, () => {
          xml.line(leaf("rehearsal", bar.section!));
        });
      });
    }

    if (bar?.tempoBpm !== undefined && bar.tempoBpm > 0) {
      xml.block("direction", { placement: "above" }, () => {
        xml.block("direction-type", {}, () => {
          xml.block("metronome", {}, () => {
            xml.line(leaf("beat-unit", "quarter"));
            xml.line(leaf("per-minute", bar.tempoBpm!));
          });
        });
        xml.line(empty("sound", { tempo: bar.tempoBpm! }));
      });
    }

    const voices = bar?.voices ?? [];
    for (const [voiceIndex, voice] of voices.entries()) {
      // Voices after the first start where the previous one did, which in MusicXML
      // means winding the clock back by everything just written.
      if (voiceIndex > 0) {
        const written = voices[voiceIndex - 1]!.beats.reduce((n, b) => n + beatTicks(b), 0);
        if (written > 0) {
          xml.block("backup", {}, () => xml.line(leaf("duration", written)));
        }
      }
      /** Pitches tied into the current beat by the previous one. */
      let tiedIn = new Set<number>();
      for (const beat of voice.beats) {
        const nextTied = new Set<number>();
        // A harmony element precedes the notes it applies to. Only from the first
        // voice: chords belong to the bar, and two voices restating one would show
        // a reader two copies of the same chart.
        if (voiceIndex === 0 && beat.chord !== undefined) writeHarmony(xml, beat.chord);
        writeBeat(xml, beat, voiceIndex + 1, fifths, tiedIn, nextTied, track.instrument, unsupported);
        countNotes(beat.notes.length);
        tiedIn = nextTied;
      }
    }

    const endCount = bar?.repeat?.endCount ?? 0;
    if (endCount > 1) {
      xml.block("barline", { location: "right" }, () => {
        xml.line(leaf("bar-style", "light-heavy"));
        xml.line(empty("repeat", { direction: "backward", times: endCount }));
      });
    }
  });
}

/**
 * The clef and, for a fretted part, the staff's tuning.
 *
 * This is the half of guitar MusicXML that most exporters skip. Without it a reader
 * has six numbers per chord and no idea what string 1 is, so it falls back to pitches
 * and the tab is gone.
 */
function writeStaffKind(xml: Xml, instrument: Instrument): void {
  if (instrument.kind !== "fretted") {
    xml.block("clef", {}, () => {
      xml.line(leaf("sign", "G"));
      xml.line(leaf("line", 2));
    });
    return;
  }
  xml.block("staff-details", {}, () => {
    xml.line(leaf("staff-lines", instrument.tuning.length));
    // Line 1 is the bottom line of the staff, which is the lowest string, so the
    // tuning array (highest string first) is read backwards.
    for (const [i, pitch] of [...instrument.tuning].reverse().entries()) {
      const t = tuningOf(pitch);
      xml.block("staff-tuning", { line: i + 1 }, () => {
        xml.line(leaf("tuning-step", t.step));
        if (t.alter !== 0) xml.line(leaf("tuning-alter", t.alter));
        xml.line(leaf("tuning-octave", t.octave));
      });
    }
    if (instrument.capo > 0) xml.line(leaf("capo", instrument.capo));
  });
  xml.block("clef", {}, () => {
    xml.line(leaf("sign", "TAB"));
    xml.line(leaf("line", instrument.tuning.length));
  });
}

function writeBeat(
  xml: Xml,
  beat: Beat,
  voice: number,
  fifths: number,
  tiedIn: Set<number>,
  nextTied: Set<number>,
  instrument: Instrument,
  unsupported: Set<string>,
): void {
  const duration = beatTicks(beat);
  const type = TYPE_NAMES[beat.duration.denominator];
  if (!type) unsupported.add(`unusual note value 1/${beat.duration.denominator} (written by duration only)`);

  if (beat.notes.length === 0) {
    xml.block("note", {}, () => {
      xml.line(empty("rest"));
      xml.line(leaf("duration", duration));
      xml.line(leaf("voice", voice));
      if (type) xml.line(leaf("type", type));
      for (let d = 0; d < beat.dots; d += 1) xml.line(empty("dot"));
      writeTimeModification(xml, beat);
    });
    return;
  }

  for (const [i, note] of chordOrder(beat.notes).entries()) {
    if (note.tiedToNext) nextTied.add(note.pitch);
    writeNote(xml, note, {
      lyric: i === 0 ? beat.lyric : undefined,
      chord: i > 0,
      duration,
      type,
      dots: beat.dots,
      beat,
      voice,
      fifths,
      tiedFrom: tiedIn.has(note.pitch),
      instrument,
      unsupported,
    });
  }
}

function writeTimeModification(xml: Xml, beat: Beat): void {
  if (!beat.tuplet) return;
  xml.block("time-modification", {}, () => {
    xml.line(leaf("actual-notes", beat.tuplet!.actual));
    xml.line(leaf("normal-notes", beat.tuplet!.normal));
  });
}

/** MusicXML's kind vocabulary, from what the parser understood of the symbol. */
function harmonyKind(symbol: string): { enumName: string; text: string } {
  const parsed = parseChord(symbol);
  const body = symbol.trim();
  const slash = body.lastIndexOf("/");
  // The exact suffix as typed rides in the text attribute, which is what round-trips.
  const text = parsed
    ? (slash >= 0 && parsed.bass !== undefined ? body.slice(0, slash) : body).slice(parsed.rootName.length)
    : "";
  if (!parsed) return { enumName: "other", text };
  const has = (semitones: number) => parsed.intervals.includes(semitones);
  let enumName = "major";
  if (parsed.quality === "power") enumName = "power";
  else if (parsed.quality === "aug") enumName = "augmented";
  else if (parsed.quality === "sus") enumName = has(2) ? "suspended-second" : "suspended-fourth";
  else if (parsed.quality === "dim") enumName = has(10) ? "half-diminished" : has(9) ? "diminished-seventh" : "diminished";
  else if (parsed.quality === "min") {
    enumName = has(14) && has(10) ? "minor-ninth" : has(10) ? "minor-seventh" : has(9) ? "minor-sixth" : "minor";
  } else if (has(11)) {
    enumName = has(21) ? "major-13th" : has(14) ? "major-ninth" : "major-seventh";
  } else if (has(10)) {
    enumName = has(21) ? "dominant-13th" : has(17) ? "dominant-11th" : has(14) ? "dominant-ninth" : "dominant";
  } else if (has(9)) {
    enumName = "major-sixth";
  }
  return { enumName, text };
}

/** A root or bass note name split into MusicXML's step and alter. */
function stepAlter(name: string): { step: string; alter: number } {
  const step = name[0]!.toUpperCase();
  let alter = 0;
  for (const c of name.slice(1)) alter += c === "#" ? 1 : c === "b" ? -1 : 0;
  return { step, alter };
}

function writeHarmony(xml: Xml, symbol: string): void {
  const parsed = parseChord(symbol);
  // A symbol the parser cannot read still travels: MusicXML's kind element takes a
  // text attribute, and the writer's exact text mattering more than our reading of
  // it is the rule everywhere else in this model too.
  const rootName = parsed?.rootName ?? symbol.trim().slice(0, 1);
  const root = stepAlter(rootName);
  const kind = harmonyKind(symbol);
  xml.block("harmony", {}, () => {
    xml.block("root", {}, () => {
      xml.line(leaf("root-step", root.step));
      if (root.alter !== 0) xml.line(leaf("root-alter", root.alter));
    });
    xml.line(leaf("kind", kind.enumName, kind.text.length > 0 ? { text: kind.text } : {}));
    if (parsed?.bassName) {
      const bass = stepAlter(parsed.bassName);
      xml.block("bass", {}, () => {
        xml.line(leaf("bass-step", bass.step));
        if (bass.alter !== 0) xml.line(leaf("bass-alter", bass.alter));
      });
    }
  });
}

interface NoteContext {
  /** The beat's syllable, carried by its first note the way every format does. */
  lyric?: string | undefined;
  chord: boolean;
  duration: number;
  type: string | undefined;
  dots: 0 | 1 | 2;
  beat: Beat;
  voice: number;
  fifths: number;
  tiedFrom: boolean;
  instrument: Instrument;
  unsupported: Set<string>;
}

function writeNote(xml: Xml, note: Note, ctx: NoteContext): void {
  const spelled = spell(note.pitch, ctx.fifths);
  const has = (a: Articulation) => note.articulations.includes(a);

  xml.block("note", {}, () => {
    // Order matters in MusicXML: chord, then the pitch, then duration, then ties,
    // then voice and type, then notations. A reader is entitled to reject any other
    // order and several do.
    if (ctx.chord) xml.line(empty("chord"));
    xml.block("pitch", {}, () => {
      xml.line(leaf("step", spelled.step));
      if (spelled.alter !== 0) xml.line(leaf("alter", spelled.alter));
      xml.line(leaf("octave", spelled.octave));
    });
    xml.line(leaf("duration", ctx.duration));
    if (ctx.tiedFrom) xml.line(empty("tie", { type: "stop" }));
    if (note.tiedToNext) xml.line(empty("tie", { type: "start" }));
    xml.line(leaf("voice", ctx.voice));
    if (ctx.type) xml.line(leaf("type", ctx.type));
    for (let d = 0; d < ctx.dots; d += 1) xml.line(empty("dot"));
    writeTimeModification(xml, ctx.beat);
    if (has("deadNote")) xml.line(leaf("notehead", "x"));
    else if (has("ghost")) xml.line(leaf("notehead", "normal", { parentheses: "yes" }));

    const articulations = (["staccato", "accent"] as const).filter(has);
    const ornaments: string[] = [];
    if (has("vibrato")) ornaments.push(empty("wavy-line", { type: "start" }));
    if (has("tremolo")) ornaments.push(leaf("tremolo", 3, { type: "single" }));

    const technical: string[] = [];
    if (note.string !== undefined) technical.push(leaf("string", note.string));
    if (note.fret !== undefined) technical.push(leaf("fret", note.fret));
    if (has("hammerOn")) technical.push(leaf("hammer-on", "H", { type: "start" }));
    if (has("pullOff")) technical.push(leaf("pull-off", "P", { type: "start" }));
    if (has("tap")) technical.push(leaf("tap", "T"));
    if (has("naturalHarmonic")) technical.push("<harmonic><natural/></harmonic>");
    if (has("artificialHarmonic")) technical.push("<harmonic><artificial/></harmonic>");
    if (has("bend")) {
      // A whole tone, and said so in the report. The model records that a bend
      // happens and not how far it goes, MusicXML requires an amount, and a whole
      // step is the bend a guitarist means when they do not say. Consistent with the
      // MIDI writer, which makes the same assumption for the same reason.
      technical.push("<bend><bend-alter>2</bend-alter></bend>");
      ctx.unsupported.add("bend depth (written as a whole step, the model holds no amount)");
    }
    if (has("palmMute")) technical.push(leaf("other-technical", "palm mute"));
    if (has("letRing")) technical.push(leaf("other-technical", "let ring"));
    if (has("deadNote")) technical.push(leaf("other-technical", "dead note"));
    const slide = has("slide");
    if (slide) {
      // Slides are a pair in MusicXML and the model marks only the departure, so a
      // reader sees where a slide begins and has to infer where it lands.
      ctx.unsupported.add("slide targets (the model marks the note a slide leaves, not where it arrives)");
    }

    // Lyric is the last element the schema allows on a note, so it is written by
    // this helper after everything else — including when there are no notations at
    // all, which is the common case for a sung melody line.
    const finishWithLyric = () => {
      if (ctx.lyric !== undefined) {
        xml.block("lyric", {}, () => {
          xml.line(leaf("syllabic", "single"));
          xml.line(leaf("text", ctx.lyric!));
        });
      }
    };

    const tied = ctx.tiedFrom || note.tiedToNext;
    if (!tied && !slide && articulations.length === 0 && ornaments.length === 0 && technical.length === 0) {
      finishWithLyric();
      return;
    }

    xml.block("notations", {}, () => {
      if (ctx.tiedFrom) xml.line(empty("tied", { type: "stop" }));
      if (note.tiedToNext) xml.line(empty("tied", { type: "start" }));
      if (slide) xml.line(empty("slide", { type: "start" }));
      if (articulations.length > 0) {
        xml.block("articulations", {}, () => {
          for (const a of articulations) xml.line(empty(a));
        });
      }
      if (ornaments.length > 0) {
        xml.block("ornaments", {}, () => {
          for (const o of ornaments) xml.line(o);
        });
      }
      if (technical.length > 0) {
        xml.block("technical", {}, () => {
          for (const t of technical) xml.line(t);
        });
      }
    });
    finishWithLyric();
  });
}
