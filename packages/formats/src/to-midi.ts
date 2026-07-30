/**
 * Standard MIDI File export.
 *
 * The first format CubScore writes without alphaTab, and the cheapest capability
 * on INTEROP.md's list: `timeline()` already answers what sounds when, in integer
 * ticks, with repeats expanded and tempo and meter followed. This turns that into
 * bytes.
 *
 * SMF Type 1, division equal to the timeline's own ticks per quarter, so nothing
 * is rescaled and nothing rounds. Track 0 is the conductor: tempo and time
 * signature, in played order. Tracks 1..n are the score's parts, one channel
 * each.
 *
 * What it deliberately does not do, all reported rather than silently dropped:
 * percussion (not in the model yet), chord symbols, lyrics, and bend *curves* —
 * the model carries "there is a bend here" and not its shape, so a bend becomes a
 * single rise and fall rather than the contour someone drew in Guitar Pro.
 */
import {
  mergeTies,
  timeline as buildTimeline,
  type Articulation,
  type Score,
  type Timeline,
  type Track,
} from "@cubscore/core";
import {
  ByteWriter,
  DRUM_CHANNEL,
  META,
  META_END_OF_TRACK,
  META_TEMPO,
  META_TIME_SIGNATURE,
  META_TRACK_NAME,
  NOTE_OFF,
  NOTE_ON,
  PITCHED_CHANNELS,
  PITCH_BEND,
  PROGRAM_CHANGE,
} from "./midi-bytes.js";

export interface MidiExportReport {
  /** Anything the format could not carry, in the same spirit as the importer's. */
  unsupported: string[];
  trackCount: number;
  noteCount: number;
  ticksPerQuarter: number;
  durationTicks: number;
}

export interface MidiExportResult {
  bytes: Uint8Array;
  report: MidiExportReport;
}

/** A plain note-on velocity, before articulations adjust it. */
const BASE_VELOCITY = 95;
/**
 * How long a drum note is gated. A sixteenth: long enough for every sampler to
 * trigger, short enough that consecutive hits on one voice never overlap.
 */
const DRUM_GATE_TICKS = 240;
/**
 * How far a bend rises, in semitones, and the bend range a receiving synth is
 * assumed to be set to. Two semitones is the General MIDI default and the most
 * common guitar bend, so a whole-tone bend needs no RPN setup to sound right.
 */
const BEND_SEMITONES = 2;
const PITCH_BEND_RANGE_SEMITONES = 2;
const PITCH_BEND_CENTRE = 8192;

/**
 * A guitar program for a fretted track, guessed from its tuning.
 *
 * A guess, because the model records how an instrument is *strung* and not what
 * it is. Four or fewer strings reaching below the guitar's low E is a bass; the
 * rest are steel-string guitar, which is the least wrong default for tablature.
 * A `pitched` track states its own program and is believed.
 */
function programFor(track: Track): number {
  if (track.instrument.kind === "pitched") return Math.max(0, Math.min(127, track.instrument.midiProgram));
  if (track.instrument.kind === "fretted") {
    const lowest = Math.min(...track.instrument.tuning);
    if (track.instrument.tuning.length <= 4 && lowest <= 43) return 33; // Electric Bass (finger)
    return 25; // Acoustic Guitar (steel)
  }
  return 0;
}

function velocityFor(articulations: readonly Articulation[]): number {
  let velocity = BASE_VELOCITY;
  if (articulations.includes("accent")) velocity += 20;
  if (articulations.includes("ghost")) velocity -= 35;
  if (articulations.includes("palmMute")) velocity -= 12;
  if (articulations.includes("deadNote")) velocity -= 20;
  return Math.max(1, Math.min(127, velocity));
}

/**
 * How long a note is held, as a fraction of the beat it occupies.
 *
 * Not the full beat, and not for expression: a note that ends exactly when the
 * next begins gives a synth a note-off and a note-on at the same tick on the same
 * key, and which it applies first is not defined. Some retrigger, some cut the new
 * note dead. Ending a hair early removes the ambiguity.
 */
function heldTicks(durationTicks: number, articulations: readonly Articulation[]): number {
  let fraction = 0.98;
  if (articulations.includes("staccato")) fraction = 0.5;
  if (articulations.includes("palmMute")) fraction = 0.55;
  if (articulations.includes("deadNote")) fraction = 0.25;
  if (articulations.includes("letRing")) fraction = 1.6;
  return Math.max(1, Math.round(durationTicks * fraction));
}

interface Event {
  tick: number;
  /** Ordering within a tick: note-offs before note-ons, setup before either. */
  rank: number;
  bytes: number[];
}

function noteOff(tick: number, channel: number, key: number): Event {
  return { tick, rank: 0, bytes: [NOTE_OFF | channel, key, 64] };
}

function noteOn(tick: number, channel: number, key: number, velocity: number): Event {
  return { tick, rank: 2, bytes: [NOTE_ON | channel, key, velocity] };
}

function pitchBend(tick: number, channel: number, semitones: number): Event {
  const raw = Math.max(
    0,
    Math.min(16383, Math.round(PITCH_BEND_CENTRE + (semitones / PITCH_BEND_RANGE_SEMITONES) * PITCH_BEND_CENTRE)),
  );
  // Bend must be set before the note it applies to, and returned to centre before
  // the next note on that channel, so it ranks with setup rather than with notes.
  return { tick, rank: 1, bytes: [PITCH_BEND | channel, raw & 0x7f, (raw >> 7) & 0x7f] };
}

/** Writes one MTrk chunk from events that are already in order. */
function writeTrackChunk(events: Event[], name: string): ByteWriter {
  const body = new ByteWriter();
  if (name.length > 0) {
    body.vlq(0).u8(META).u8(META_TRACK_NAME).vlq(Math.min(name.length, 127)).ascii(name.slice(0, 127));
  }

  const ordered = [...events].sort((a, b) => a.tick - b.tick || a.rank - b.rank);
  let previous = 0;
  for (const event of ordered) {
    body.vlq(Math.max(0, event.tick - previous));
    for (const byte of event.bytes) body.u8(byte);
    previous = Math.max(previous, event.tick);
  }
  body.vlq(0).u8(META).u8(META_END_OF_TRACK).vlq(0);

  const chunk = new ByteWriter();
  chunk.ascii("MTrk").u32(body.length).raw(body);
  return chunk;
}

/**
 * The conductor track: tempo and meter for the whole performance.
 *
 * In *played* order, so a repeated section states its tempo again on the second
 * pass. A reader walking the track forward has no other way to learn that the
 * music went back to a bar with a different tempo mark.
 */
function conductorEvents(line: Timeline, title: string): { events: Event[]; name: string } {
  const events: Event[] = [];
  for (const { tick, bpm } of line.tempoChanges) {
    const microsPerQuarter = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / bpm)));
    events.push({
      tick,
      rank: 0,
      bytes: [
        META,
        META_TEMPO,
        3,
        (microsPerQuarter >> 16) & 0xff,
        (microsPerQuarter >> 8) & 0xff,
        microsPerQuarter & 0xff,
      ],
    });
  }
  for (const { tick, beats, beatValue } of line.meterChanges) {
    // dd is the negative power of two: 4 -> 2, 8 -> 3. A beat value that is not a
    // power of two cannot be expressed and falls back to a quarter.
    const power = Math.log2(beatValue);
    const dd = Number.isInteger(power) ? power : 2;
    events.push({
      tick,
      rank: 1,
      bytes: [META, META_TIME_SIGNATURE, 4, Math.max(1, Math.min(255, beats)), dd, 24, 8],
    });
  }
  return { events, name: title };
}

export function toMidi(score: Score, line: Timeline = buildTimeline(score)): MidiExportResult {
  const unsupported = new Set<string>();
  const tracks: ByteWriter[] = [];

  const conductor = conductorEvents(line, score.title || "Untitled");
  tracks.push(writeTrackChunk(conductor.events, conductor.name));

  let noteCount = 0;
  /** Pitched parts take channels in order; the drum channel is not one of them. */
  let pitchedSoFar = 0;
  for (const [index, track] of score.tracks.entries()) {
    const drums = track.instrument.kind === "drums";

    // Percussion goes on channel 10, which the specification reserves for it: the
    // key is the drum voice rather than a pitch, and every synth knows the kit
    // without being told a program. Every drum track shares the channel, because
    // there is only one and they are all the same instrument.
    let channel: number;
    if (drums) {
      channel = DRUM_CHANNEL;
    } else {
      channel = PITCHED_CHANNELS[pitchedSoFar % PITCHED_CHANNELS.length] ?? 0;
      if (pitchedSoFar >= PITCHED_CHANNELS.length) {
        unsupported.add("more than 15 pitched tracks (MIDI channels are reused)");
      }
      pitchedSoFar += 1;
    }

    // No program change on the drum channel: the kit is implied by the channel, and
    // sending one there makes some synths substitute a melodic instrument.
    const events: Event[] = drums
      ? []
      : [{ tick: 0, rank: 0, bytes: [PROGRAM_CHANGE | channel, programFor(track)] }];
    // Ties joined first: a tie means hold the last note, not play it again, so a
    // second note-on would be audibly wrong. Measured against alphaTab's own MIDI
    // as 1,616 extra note events in one nine-minute file before this.
    const notes = mergeTies(line.notes.filter((n) => n.trackIndex === index));

    // When the same key sounds again on this channel, so a held note can be cut
    // short rather than overrunning it. Let-ring deliberately extends a note past
    // its beat, and a note-off arriving after the *next* note-on of the same key
    // makes a synth cut the new note dead — one note lost per let-ring, which is
    // the opposite of what let-ring means.
    const nextOnset = new Map<number, number>();
    {
      const lastSeen = new Map<number, number>();
      for (const note of [...notes].sort((a, b) => b.startTicks - a.startTicks)) {
        const key = Math.max(0, Math.min(127, Math.round(note.pitch)));
        const later = lastSeen.get(key);
        if (later !== undefined) nextOnset.set(note.startTicks * 128 + key, later);
        lastSeen.set(key, note.startTicks);
      }
    }

    for (const note of notes) {
      const key = Math.max(0, Math.min(127, Math.round(note.pitch)));
      const ceiling = nextOnset.get(note.startTicks * 128 + key);
      // A drum voice is a hit: its length is the decay of the sample, not something
      // the score decides, so a short fixed gate is more faithful than a note held
      // for its written duration. Cymbals ring on regardless; a kick does not get
      // longer because it was written as a whole note.
      const held = drums
        ? Math.min(DRUM_GATE_TICKS, Math.max(1, note.durationTicks))
        : Math.min(
        heldTicks(note.durationTicks, note.articulations),
        // One tick clear of the next onset, for the same reason a plain note ends a
        // hair before the next begins: simultaneous note-off and note-on on one key
        // is undefined behaviour.
        ceiling === undefined ? Number.POSITIVE_INFINITY : Math.max(1, ceiling - note.startTicks - 1),
      );
      const velocity = velocityFor(note.articulations);
      const bends = note.articulations.includes("bend");

      if (bends) {
        // A rise across the note and a return to centre at its end. The model
        // holds no curve, so this is a shape rather than the shape.
        events.push(pitchBend(note.startTicks, channel, 0));
        events.push(pitchBend(note.startTicks + Math.round(held * 0.5), channel, BEND_SEMITONES));
        events.push(pitchBend(note.startTicks + held, channel, 0));
        unsupported.add("bend curves (written as a single rise, the model holds no contour)");
      }
      if (note.articulations.includes("vibrato") || note.articulations.includes("tremolo")) {
        unsupported.add("vibrato and tremolo depth (no modulation written)");
      }
      if (note.articulations.includes("slide")) {
        unsupported.add("slides (written as separate notes, not as portamento)");
      }
      if (
        note.articulations.includes("naturalHarmonic") ||
        note.articulations.includes("artificialHarmonic")
      ) {
        unsupported.add("harmonics (written at the notated pitch)");
      }

      events.push(noteOn(note.startTicks, channel, key, velocity));
      events.push(noteOff(note.startTicks + held, channel, key));
      noteCount += 1;
    }

    tracks.push(writeTrackChunk(events, track.name || `Track ${index + 1}`));
  }

  const file = new ByteWriter();
  file.ascii("MThd").u32(6).u16(1).u16(tracks.length).u16(line.ticksPerQuarter);
  for (const chunk of tracks) file.raw(chunk);

  return {
    bytes: file.toUint8Array(),
    report: {
      unsupported: [...unsupported].sort(),
      trackCount: tracks.length,
      noteCount,
      ticksPerQuarter: line.ticksPerQuarter,
      durationTicks: line.durationTicks,
    },
  };
}
