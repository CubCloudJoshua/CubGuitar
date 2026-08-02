/**
 * A chord chart, played.
 *
 * The songwriting loop this exists for: write a progression, press one button, and
 * hear it under the melody while you work on the next line. Every tool in the
 * category makes the writer build that backing track by hand, note by note, which is
 * exactly the busywork that interrupts writing.
 *
 * The same structural argument as arranging applies. The output is one `track.insert`
 * op carrying a fully-formed track, so the whole accompaniment is a single edit: one
 * undo step, one thing for collaborators to receive, and regenerating after the chart
 * changes is undo-plus-again rather than surgery. The track is ordinary notes with
 * strings and frets from the voicing engine — it plays through the synth, exports to
 * MIDI and MusicXML, and can be edited like anything typed by hand, because there is
 * nothing special about it.
 *
 * What it refuses to be is an arranger. Three honest patterns — sustain, strum,
 * arpeggio — with the top-ranked voicing per chord. A rhythm-section model would be
 * a feature worth having and a different one; this is scaffolding a writer edits.
 */
import { duration, frettedGuitar, nextId } from "./build.js";
import { parseChord, voicings, type Voicing } from "./harmony.js";
import type { OpKind } from "./ops.js";
import type { Bar, Beat, Instrument, Note, Score, TimeSignature, Track } from "./score.js";

export type AccompanimentPattern = "sustain" | "strum" | "arpeggio";

export interface ComposeReport {
  /** Bars that received music. */
  barsWritten: number;
  /** Bars left as rests: before the first chord, or carrying a symbol nobody could read. */
  barsSkipped: number;
  /** Distinct chords voiced. */
  chordsUsed: number;
  /** Human-readable notes on what was skipped or substituted, for the UI to show. */
  notes: string[];
}

export interface ComposeResult {
  ops: OpKind[];
  report: ComposeReport;
}

export interface ComposeOptions {
  pattern?: AccompanimentPattern;
  instrument?: Instrument;
  name?: string;
}

/** The chord stated at or before each beat position across a whole track, per bar. */
function chartOf(score: Score): { chords: Array<string | null>; reference: Track | null } {
  // The chart lives on whichever track carries chords; the first one that does wins.
  // A score where two tracks disagree about the harmony is a score with two songs.
  const carrier = score.tracks.find((t) =>
    t.bars.some((bar) => bar.voices.some((v) => v.beats.some((b) => b.chord !== undefined))),
  );
  const reference = carrier ?? score.tracks[0] ?? null;
  if (!reference) return { chords: [], reference: null };

  const chords: Array<string | null> = [];
  let current: string | null = null;
  for (const bar of reference.bars) {
    const stated = bar.voices[0]?.beats.find((b) => b.chord !== undefined)?.chord;
    if (stated !== undefined) current = stated;
    chords.push(current);
  }
  return { chords, reference };
}

/** A voicing's notes, ready to sit on a beat. Let-ring where the pattern sustains. */
function notesOf(voicing: Voicing, instrument: Instrument, ring: boolean): Note[] {
  if (instrument.kind !== "fretted") return [];
  const out: Note[] = [];
  for (const [i, fret] of voicing.frets.entries()) {
    if (fret < 0) continue;
    const string = i + 1; // frets is string 1 first, matching the model
    out.push({
      id: nextId("n"),
      pitch: instrument.tuning[string - 1]! + instrument.capo + fret,
      string,
      fret,
      articulations: ring ? ["letRing"] : [],
    });
  }
  return out;
}

/** A rest filling one bar of `meter`, as the beats a fresh bar would carry. */
function restBeats(meter: TimeSignature): Beat[] {
  const out: Beat[] = [];
  for (let i = 0; i < meter.beats; i += 1) {
    out.push({ id: nextId("b"), duration: duration(meter.beatValue), dots: 0, notes: [] });
  }
  return out;
}

/**
 * One sustained chord filling one bar, when the meter has a single written value
 * for it. Null when it does not (5/4, 7/8), which the caller falls back from.
 */
function sustainedBeat(meter: TimeSignature, notes: Note[]): Beat | null {
  const fraction = meter.beats / meter.beatValue;
  if (fraction === 1) return { id: nextId("b"), duration: duration(1), dots: 0, notes };
  if (fraction === 0.5) return { id: nextId("b"), duration: duration(2), dots: 0, notes };
  if (fraction === 0.75) return { id: nextId("b"), duration: duration(2), dots: 1, notes };
  if (fraction === 0.25) return { id: nextId("b"), duration: duration(4), dots: 0, notes };
  return null;
}

/**
 * Builds the accompaniment for a score's chord chart.
 *
 * Returns ops rather than a score for the same reason `arrange.ts` does: the caller
 * commits them through the editor, which is what makes the whole thing one undo step
 * and one batch for a live session.
 */
export function composeAccompaniment(score: Score, options: ComposeOptions = {}): ComposeResult {
  const pattern = options.pattern ?? "strum";
  const instrument = options.instrument ?? frettedGuitar();
  const { chords, reference } = chartOf(score);
  const empty: ComposeResult = {
    ops: [],
    report: { barsWritten: 0, barsSkipped: 0, chordsUsed: 0, notes: ["nothing to accompany"] },
  };
  if (!reference || chords.every((c) => c === null)) return empty;

  // The best voicing per symbol, found once. Consistency is the musical point as much
  // as the speed: a comp that re-voices the same chord differently every bar sounds
  // like a student, and the writer asked for scaffolding.
  const voicingBySymbol = new Map<string, Voicing | null>();
  const voicingFor = (symbol: string): Voicing | null => {
    if (!voicingBySymbol.has(symbol)) {
      const parsed = parseChord(symbol);
      voicingBySymbol.set(symbol, parsed ? voicings(parsed, instrument, 1)[0] ?? null : null);
    }
    return voicingBySymbol.get(symbol) ?? null;
  };

  const notes: string[] = [];
  const unreadable = new Set<string>();
  let barsWritten = 0;
  let barsSkipped = 0;
  let fellBack = false;

  let meter: TimeSignature = { beats: 4, beatValue: 4 };
  const bars: Bar[] = [];

  for (const [index, referenceBar] of reference.bars.entries()) {
    if (referenceBar.timeSignature) meter = referenceBar.timeSignature;
    const symbol = chords[index] ?? null;
    const voicing = symbol === null ? null : voicingFor(symbol);
    if (symbol !== null && voicing === null) unreadable.add(symbol);

    const bar: Bar = { id: nextId("m"), voices: [] };
    // The new track states the meter wherever the score does, so its bars always
    // agree with the bars beside them.
    if (referenceBar.timeSignature) bar.timeSignature = referenceBar.timeSignature;

    if (voicing === null) {
      bar.voices = [{ id: nextId("v"), beats: restBeats(meter) }];
      barsSkipped += 1;
      bars.push(bar);
      continue;
    }

    let beats: Beat[] | null = null;
    if (pattern === "sustain") {
      const sustained = sustainedBeat(meter, notesOf(voicing, instrument, true));
      if (sustained) beats = [sustained];
      else fellBack = true;
      // A meter with no single written value falls through to a strum, which fits
      // any meter by construction. Said in the report rather than done silently.
    }
    if (pattern === "arpeggio" && beats === null) {
      // Eighth notes cycling up the voicing from its bass. The bar has to divide
      // into eighths evenly or the arpeggio drifts against the beat; where it does
      // not, the strum fallback below keeps time instead.
      const eighths = (meter.beats * 8) / meter.beatValue;
      if (Number.isInteger(eighths)) {
        const ordered = [...voicing.pitches].map((pitch) => {
          const stringIndex = voicing.frets.findIndex(
            (fret, i) =>
              fret >= 0 &&
              instrument.kind === "fretted" &&
              instrument.tuning[i]! + instrument.capo + fret === pitch,
          );
          return { pitch, string: stringIndex + 1, fret: voicing.frets[stringIndex]! };
        });
        beats = [];
        for (let i = 0; i < eighths; i += 1) {
          const tone = ordered[i % ordered.length]!;
          beats.push({
            id: nextId("b"),
            duration: duration(8),
            dots: 0,
            notes: [
              {
                id: nextId("n"),
                pitch: tone.pitch,
                string: tone.string,
                fret: tone.fret,
                articulations: ["letRing"],
              },
            ],
          });
        }
      } else {
        fellBack = true;
      }
    }
    if (beats === null) {
      // The strum: the chord restated on every written beat. Fits any meter, which
      // is why it is both the default and the fallback.
      beats = [];
      for (let i = 0; i < meter.beats; i += 1) {
        beats.push({
          id: nextId("b"),
          duration: duration(meter.beatValue),
          dots: 0,
          notes: notesOf(voicing, instrument, false),
        });
      }
    }

    bar.voices = [{ id: nextId("v"), beats }];
    barsWritten += 1;
    bars.push(bar);
  }

  if (barsWritten === 0) return empty;

  const track: Track = {
    id: nextId("t"),
    name: options.name ?? "Accompaniment",
    instrument,
    bars,
  };

  if (unreadable.size > 0) {
    notes.push(`Could not read ${[...unreadable].join(", ")} — those bars were left as rests.`);
  }
  if (fellBack) notes.push(`The ${pattern} pattern does not fit this meter everywhere; those bars are strummed.`);
  if (chords[0] === null) notes.push("Bars before the first chord were left as rests.");
  if (notes.length === 0) notes.push("Every bar accompanied.");

  return {
    ops: [{ type: "track.insert", index: score.tracks.length, track }],
    report: { barsWritten, barsSkipped, chordsUsed: voicingBySymbol.size - unreadable.size, notes },
  };
}
