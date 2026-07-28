/** Constructors for the semantic score model. */
import type { Bar, Beat, Duration, Id, Instrument, Note, Score, TimeSignature, Track, Tuning, Voice } from "./score.js";

/** MIDI pitches of the open strings, string 1 (highest) first. */
export const STANDARD_GUITAR: Tuning = [64, 59, 55, 50, 45, 40];
export const STANDARD_BASS: Tuning = [43, 38, 33, 28];

export const DEFAULT_TIME_SIGNATURE: TimeSignature = { beats: 4, beatValue: 4 };

let counter = 0;

/** Ids only need to be unique within a document; the sync layer will prefix by client. */
export function nextId(prefix: string): Id {
  counter += 1;
  return `${prefix}${counter.toString(36)}`;
}

export function duration(denominator: number): Duration {
  return { numerator: 1, denominator };
}

export function createNote(pitch: number, string: number, fret: number): Note {
  return { id: nextId("n"), pitch, string, fret, articulations: [] };
}

export function createRest(d: Duration): Beat {
  return { id: nextId("b"), duration: d, notes: [], dots: 0 };
}

/**
 * A new bar is pre-filled with rests, one per beat of the time signature, so
 * typing a fret replaces a rest in place the way Guitar Pro behaves.
 */
export function createBar(ts: TimeSignature = DEFAULT_TIME_SIGNATURE, includeSignature = false): Bar {
  const beats: Beat[] = [];
  for (let i = 0; i < ts.beats; i++) beats.push(createRest(duration(ts.beatValue)));
  const voice: Voice = { id: nextId("v"), beats };
  const bar: Bar = { id: nextId("m"), voices: [voice] };
  if (includeSignature) bar.timeSignature = ts;
  return bar;
}

export function createTrack(
  name: string,
  instrument: Instrument,
  barCount = 4,
  ts: TimeSignature = DEFAULT_TIME_SIGNATURE,
): Track {
  const bars: Bar[] = [];
  for (let i = 0; i < barCount; i++) bars.push(createBar(ts, i === 0));
  return { id: nextId("t"), name, instrument, bars };
}

export function frettedGuitar(tuning: Tuning = STANDARD_GUITAR): Instrument {
  return { kind: "fretted", tuning, frets: 24, capo: 0 };
}

/** A new document: one standard-tuned guitar track of empty bars. */
export function createScore(title = "Untitled", artist = "", barCount = 4): Score {
  return {
    id: nextId("s"),
    title,
    artist,
    tracks: [createTrack("Guitar", frettedGuitar(), barCount)],
    revision: 0,
  };
}

/** Pitch produced by stopping `string` (1-based) at `fret`. */
export function pitchAt(instrument: Instrument, string: number, fret: number): number {
  if (instrument.kind !== "fretted") return 60;
  const open = instrument.tuning[string - 1];
  return open === undefined ? 60 : open + fret + instrument.capo;
}
