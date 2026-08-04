/**
 * A Standard MIDI File as an editable Score.
 *
 * INTEROP.md §6 called this "weeks" and named what was missing: the fingering half was
 * done, quantisation was not. Both exist now (`core/quantise.ts`), so this file is the
 * join — parsing is `parseMidi`, notation is the quantiser, and what belongs here is
 * only the part neither of them can do: deciding *what the parts are*.
 *
 * ## Why splitting is the interesting problem
 *
 * A MIDI file does not contain parts. It contains events on sixteen channels spread
 * over some number of tracks, and the conventions vary by what wrote it. A notation
 * program writes one track per staff. A DAW writes one track per instrument but may put
 * several channels on it. Format 0 writes *everything* on one track and the channel is
 * the only separator. So parts are grouped by track *and* channel, which is right under
 * all three conventions and wrong only for a file that deliberately reuses one channel
 * for two instruments — which cannot be told apart from a program change mid-piece
 * anyway.
 *
 * ## What the instrument is
 *
 * A program number is a sound, not an instrument, and the two disagree in the direction
 * that matters: General MIDI has no way to say "six strings tuned like this". So a
 * guitar program becomes a fretted track in standard tuning and a bass program a
 * four-string bass, which is a guess stated in the report rather than a fact. Channel
 * 10 is percussion by the specification, not by its program, and becomes a drum track.
 *
 * Everything else stays `pitched`, keeping its program number. That is deliberately not
 * a failure: a piano part is pitch-exact and editable as notation, and "Arrange this
 * staff for guitar" already turns one into tablature when the user wants that. Guessing
 * a fingering for a piano part nobody asked to be a guitar part would be worse.
 *
 * ## What one origin buys
 *
 * Every part is quantised against the same tick 0 and the same tempo and meter maps.
 * Without a shared origin each part would anchor on its own first note, so a bass
 * entering a bar after the guitar would be dragged back to the downbeat and the two
 * would play together that were never together.
 */
import {
  createBar,
  quantise,
  QUARTER_TICKS,
  type Instrument,
  type MeterPoint,
  type Score,
  type TempoPoint,
  type TimeSignature,
  type Track,
} from "@cubscore/core";
import { parseMidi, type MidiNote, type MidiParse } from "./from-midi.js";
import type { ImportReport } from "./from-alphatab.js";

/** General MIDI's percussion channel, zero-based. Fixed by the specification. */
const DRUM_CHANNEL = 9;

const STANDARD_GUITAR = [40, 45, 50, 55, 59, 64];
const STANDARD_BASS = [28, 33, 38, 43];

export interface MidiImportOptions {
  /** Passed through to the quantiser; `"auto"` picks it from the material. */
  grid?: number | "auto";
  title?: string;
}

export interface MidiImportResult {
  score: Score;
  report: ImportReport;
}

/**
 * The instrument a program number implies, and the name to show for it.
 *
 * Ranges are General MIDI's own families. Only the two that map onto strings become
 * fretted; the rest keep their program and stay pitched, because a fingering nobody
 * asked for is harder to undo than one they can ask for.
 */
function instrumentFor(program: number, channel: number): { instrument: Instrument; name: string } {
  if (channel === DRUM_CHANNEL) return { instrument: { kind: "drums" }, name: "Drums" };
  if (program >= 24 && program <= 31) {
    return {
      instrument: { kind: "fretted", tuning: [...STANDARD_GUITAR], frets: 24, capo: 0 },
      name: "Guitar",
    };
  }
  if (program >= 32 && program <= 39) {
    return {
      instrument: { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 },
      name: "Bass",
    };
  }
  return { instrument: { kind: "pitched", midiProgram: program }, name: `Program ${program}` };
}

/** One part: every note sharing a track and a channel. */
interface Part {
  track: number;
  channel: number;
  notes: MidiNote[];
}

function splitParts(parse: MidiParse): Part[] {
  const parts = new Map<string, Part>();
  for (const note of parse.notes) {
    const key = `${note.track}:${note.channel}`;
    const open = parts.get(key);
    if (open) open.notes.push(note);
    else parts.set(key, { track: note.track, channel: note.channel, notes: [note] });
  }
  // Sorted so the output order is the file's order rather than a hash's.
  return [...parts.values()].sort((a, b) => a.track - b.track || a.channel - b.channel);
}

/** The program in force for a part, taking the last change at or before its first note. */
function programOf(parse: MidiParse, part: Part): number {
  const firstTick = part.notes.reduce((min, n) => Math.min(min, n.startTicks), Number.POSITIVE_INFINITY);
  let program = 0;
  for (const change of parse.programs) {
    if (change.track !== part.track || change.channel !== part.channel) continue;
    // `programs` carries no tick in the parse, so the first stated program for the
    // channel is taken. A file that switches instrument mid-channel is a case this
    // reports rather than models: our tracks have one instrument each.
    program = change.program;
    break;
  }
  void firstTick;
  return program;
}

/**
 * The meter in force at a bar index, walked forward through the map.
 *
 * Needed to pad the shorter parts to a common length: bar lines are shared across a
 * score, so a track that stops early has to be filled with bars of the *right* size,
 * not with 4/4 bars that push its remaining bar lines out of step with everyone else's.
 */
function meterWalker(meters: readonly MeterPoint[], fallback: TimeSignature) {
  const points = [...meters].sort((a, b) => a.atTicks - b.atTicks);
  const lengthOf = (m: TimeSignature) => Math.max(1, Math.round((QUARTER_TICKS * 4 * m.beats) / m.beatValue));
  const meterAt = (tick: number): TimeSignature => {
    let found = fallback;
    for (const point of points) {
      if (point.atTicks <= tick) found = { beats: point.beats, beatValue: point.beatValue };
      else break;
    }
    return found;
  };
  const starts: number[] = [0];
  return (index: number): TimeSignature => {
    while (starts.length <= index) {
      const at = starts[starts.length - 1] ?? 0;
      starts.push(at + lengthOf(meterAt(at)));
    }
    return meterAt(starts[index] ?? 0);
  };
}

export function fromMidiScore(bytes: Uint8Array, options: MidiImportOptions = {}): MidiImportResult {
  const parse = parseMidi(bytes);
  const unsupported = new Set<string>();

  // The file's own divisions rescaled to ours, so a note lands where it was written
  // regardless of what resolution the writer chose.
  const scale = QUARTER_TICKS / (parse.ticksPerQuarter || QUARTER_TICKS);
  const tempos: TempoPoint[] = parse.tempoChanges.map((t) => ({ atTicks: t.tick * scale, bpm: t.bpm }));
  const meters: MeterPoint[] = parse.meterChanges.map((m) => ({
    atTicks: m.tick * scale,
    beats: m.beats,
    beatValue: m.beatValue,
  }));
  const firstBpm = tempos.find((t) => t.atTicks <= 0)?.bpm ?? tempos[0]?.bpm ?? 120;
  const firstMeter: TimeSignature = meters[0]
    ? { beats: meters[0].beats, beatValue: meters[0].beatValue }
    : { beats: 4, beatValue: 4 };

  /** Seconds for a tick, walking the tempo map. The quantiser wants seconds. */
  const secondsAt = (() => {
    const points = tempos.length > 0 && (tempos[0]?.atTicks ?? 0) <= 0 ? [...tempos] : [{ atTicks: 0, bpm: firstBpm }, ...tempos];
    points.sort((a, b) => a.atTicks - b.atTicks);
    const rate = points.map((p) => 60 / Math.max(1, p.bpm) / QUARTER_TICKS);
    const cum: number[] = [0];
    for (let i = 1; i < points.length; i += 1) {
      cum[i] = (cum[i - 1] ?? 0) + ((points[i]?.atTicks ?? 0) - (points[i - 1]?.atTicks ?? 0)) * (rate[i - 1] ?? 0);
    }
    return (ticks: number): number => {
      let i = 0;
      for (let k = 1; k < points.length; k += 1) {
        if ((points[k]?.atTicks ?? 0) <= ticks) i = k;
        else break;
      }
      return (cum[i] ?? 0) + (ticks - (points[i]?.atTicks ?? 0)) * (rate[i] ?? 0);
    };
  })();

  const parts = splitParts(parse);
  if (parts.length === 0) {
    return {
      score: { id: "midi-empty", title: options.title ?? "MIDI import", artist: "", tracks: [], revision: 0 },
      report: { unsupported: ["the file contains no notes"], trackCount: 0, barCount: 0, noteCount: 0 },
    };
  }

  // One origin for every part, so parts that enter at different moments stay apart.
  const origin = Math.min(...parse.notes.map((n) => secondsAt(n.startTicks * scale)));

  const tracks: Track[] = [];
  let noteCount = 0;
  for (const part of parts) {
    const program = programOf(parse, part);
    const { instrument, name } = instrumentFor(program, part.channel);
    const detected = part.notes.map((n) => ({
      pitch: n.key,
      startSeconds: secondsAt(n.startTicks * scale),
      durationSeconds: Math.max(
        0.01,
        secondsAt((n.startTicks + n.durationTicks) * scale) - secondsAt(n.startTicks * scale),
      ),
    }));
    const { score: one, report } = quantise(detected, {
      bpm: firstBpm,
      meter: firstMeter,
      tempos,
      meters,
      instrument,
      originSeconds: origin,
      ...(options.grid === undefined ? {} : { grid: options.grid }),
    });
    const written = one.tracks[0];
    if (!written) continue;
    const label = parse.trackNames[part.track];
    tracks.push({
      ...written,
      name: label && label.trim() !== "" ? label.trim() : name,
    });
    noteCount += report.notesPlaced;
    for (const note of report.notes) unsupported.add(note);
    if (report.unreachable.length > 0) {
      unsupported.add(
        `${name}: ${report.unreachable.length} pitches outside the instrument's range were left unfingered`,
      );
    }
  }

  // Bar lines are shared across a score, so every track is padded to the longest with
  // bars of the right meter. A track left short is not merely untidy: the timeline takes
  // the longest track as the spine, and a shorter one simply stops contributing, which
  // reads as the part ending rather than resting.
  const meterOfBar = meterWalker(meters, firstMeter);
  const barCount = tracks.reduce((max, t) => Math.max(max, t.bars.length), 0);
  for (const track of tracks) {
    while (track.bars.length < barCount) track.bars.push(createBar(meterOfBar(track.bars.length), false));
  }

  if (parse.hasPercussion) {
    // The model carries drum voices and writes them back to channel 10, but drum
    // *notation* is still the gap named in README and INTEROP, so say so on import
    // rather than letting a user discover it in the editor.
    unsupported.add("drum notation (the kit is carried and plays, but is not editable as notation)");
  }
  if (parse.pitchBends.length > 0) {
    unsupported.add(`${parse.pitchBends.length} pitch bends (bends are not reconstructed from MIDI yet)`);
  }
  if (parse.programs.some((p) => parse.programs.filter((q) => q.track === p.track && q.channel === p.channel).length > 1)) {
    unsupported.add("a channel that changes instrument mid-piece (the first program is used)");
  }
  const guessed = tracks.filter((t) => t.instrument.kind === "fretted").length;
  if (guessed > 0) {
    unsupported.add(
      `${guessed} fretted ${guessed === 1 ? "track's" : "tracks'"} tuning was guessed from its program: General MIDI cannot state one`,
    );
  }

  return {
    score: {
      id: "midi-import",
      title: options.title ?? "MIDI import",
      artist: "",
      tracks,
      revision: 0,
    },
    report: { unsupported: [...unsupported], trackCount: tracks.length, barCount, noteCount },
  };
}
