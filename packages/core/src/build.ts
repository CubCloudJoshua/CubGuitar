/** Constructors for the semantic score model. */
import type { Bar, Beat, Duration, Id, Instrument, Note, Score, TimeSignature, Track, Tuning, Voice } from "./score.js";

/** MIDI pitches of the open strings, string 1 (highest) first. */
export const STANDARD_GUITAR: Tuning = [64, 59, 55, 50, 45, 40];
export const STANDARD_BASS: Tuning = [43, 38, 33, 28];

export const DEFAULT_TIME_SIGNATURE: TimeSignature = { beats: 4, beatValue: 4 };

let counter = 0;

/**
 * A per-session tag, so ids never collide with ones minted elsewhere.
 *
 * Two things depend on it. A document saved with n1..n50 and reopened later
 * must not see a fresh counter hand out n1 again, and two people in a live
 * session must not mint the same id for different notes — ops address entities
 * by id, so a duplicate makes one op hit two things and the document is
 * corrupt from then on.
 *
 * Ten base-36 characters is about 52 bits, drawn from the crypto RNG rather
 * than Math.random. The previous four characters was 20 bits, which is a
 * coin-flip collision at around a thousand concurrent sessions and a real one
 * long before that; the width costs nothing. The CRDT sync layer will replace
 * this with proper client ids.
 */
const SESSION_TAG = Array.from(crypto.getRandomValues(new Uint8Array(7)))
  .map((byte) => byte.toString(36).padStart(2, "0"))
  .join("")
  .slice(0, 10);

export function nextId(prefix: string): Id {
  counter += 1;
  return `${prefix}${SESSION_TAG}${counter.toString(36)}`;
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
