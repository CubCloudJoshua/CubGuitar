/**
 * Standard MIDI File parsing, down to note events.
 *
 * Two jobs, and it is worth being clear that they are different. This is what
 * verifies the writer: what we wrote, we must be able to read back to the same
 * notes at the same ticks, and that check needs no alphaTab and no browser, which
 * is the whole point of owning both halves. It is also the first half of MIDI
 * *import* — but only the first. Turning these events into a `Score` needs
 * quantisation and a fingering decision for every pitch, which are musical
 * problems, not parsing problems, and they live elsewhere (INTEROP.md §1.2).
 *
 * Written defensively: a MIDI file is arbitrary bytes from wherever the user got
 * it. Unknown meta events and system-exclusive blocks are skipped by their stated
 * length, running status is honoured, and a chunk that claims more data than the
 * file holds raises rather than reading past the end.
 */
import {
  ByteReader,
  channelDataLength,
  CONTROL_CHANGE,
  DRUM_CHANNEL,
  META,
  META_END_OF_TRACK,
  META_KEY_SIGNATURE,
  META_TEMPO,
  META_TIME_SIGNATURE,
  META_TRACK_NAME,
  NOTE_OFF,
  NOTE_ON,
  PITCH_BEND,
  SYSEX,
  SYSEX_ESCAPE,
} from "./midi-bytes.js";

export interface MidiNote {
  /** Track index within the file, so parts stay separable. */
  track: number;
  channel: number;
  /** MIDI key number. */
  key: number;
  velocity: number;
  startTicks: number;
  durationTicks: number;
}

export interface MidiParse {
  format: number;
  ticksPerQuarter: number;
  trackNames: string[];
  notes: MidiNote[];
  tempoChanges: Array<{ tick: number; bpm: number }>;
  meterChanges: Array<{ tick: number; beats: number; beatValue: number }>;
  programs: Array<{ track: number; channel: number; program: number }>;
  pitchBends: Array<{ track: number; channel: number; tick: number; semitones: number }>;
  /** True when any note arrived on the percussion channel. */
  hasPercussion: boolean;
  durationTicks: number;
}

const PITCH_BEND_CENTRE = 8192;
/** Assumed receiving range, matching what the writer assumes. */
const PITCH_BEND_RANGE_SEMITONES = 2;

/** A note waiting for its note-off, keyed by channel and key. */
type Pending = Map<number, Array<{ startTicks: number; velocity: number }>>;

function closeNote(
  pending: Pending,
  notes: MidiNote[],
  track: number,
  channel: number,
  key: number,
  tick: number,
): void {
  const slot = pending.get((channel << 8) | key);
  const open = slot?.shift();
  if (!open) return;
  notes.push({
    track,
    channel,
    key,
    velocity: open.velocity,
    startTicks: open.startTicks,
    // A zero-length note is legal in the bytes and meaningless as music; one tick
    // keeps it visible to whatever reads this rather than silently vanishing.
    durationTicks: Math.max(1, tick - open.startTicks),
  });
}

export function parseMidi(bytes: Uint8Array): MidiParse {
  const reader = new ByteReader(bytes);
  if (reader.remaining < 14) throw new Error("midi: file is too short to hold a header");
  if (reader.ascii(4) !== "MThd") throw new Error("midi: missing MThd header");
  const headerLength = reader.u32();
  if (headerLength < 6) throw new Error("midi: header chunk is too short");
  const format = reader.u16();
  const declaredTracks = reader.u16();
  const division = reader.u16();
  // Anything past the six bytes we understand is a later revision's business.
  reader.skip(headerLength - 6);

  if ((division & 0x8000) !== 0) {
    // SMPTE time division: negative frames-per-second in the high byte. Real, and
    // vanishingly rare outside film work; refusing beats silently treating the
    // value as ticks per quarter and misplacing every note.
    throw new Error("midi: SMPTE time division is not supported");
  }
  const ticksPerQuarter = division === 0 ? 480 : division;

  const parse: MidiParse = {
    format,
    ticksPerQuarter,
    trackNames: [],
    notes: [],
    tempoChanges: [],
    meterChanges: [],
    programs: [],
    pitchBends: [],
    hasPercussion: false,
    durationTicks: 0,
  };

  let trackIndex = 0;
  while (reader.remaining >= 8) {
    const id = reader.ascii(4);
    const length = reader.u32();
    if (id !== "MTrk") {
      // Unknown chunk types are to be skipped by their length, per the spec.
      reader.skip(Math.min(length, reader.remaining));
      continue;
    }
    const body = new ByteReader(reader.slice(length));
    parse.trackNames.push("");
    readTrack(body, trackIndex, parse);
    trackIndex += 1;
  }

  if (trackIndex === 0) throw new Error("midi: file contains no tracks");
  if (declaredTracks !== trackIndex) {
    // Not fatal: files written by hardware sometimes disagree with themselves, and
    // the chunks are the truth. Worth not pretending we did not notice, though.
    parse.trackNames = parse.trackNames.slice(0, trackIndex);
  }

  parse.notes.sort((a, b) => a.startTicks - b.startTicks || a.key - b.key);
  parse.tempoChanges.sort((a, b) => a.tick - b.tick);
  parse.meterChanges.sort((a, b) => a.tick - b.tick);
  parse.durationTicks = parse.notes.reduce((max, n) => Math.max(max, n.startTicks + n.durationTicks), 0);
  return parse;
}

function readTrack(body: ByteReader, trackIndex: number, parse: MidiParse): void {
  const pending: Pending = new Map();
  let tick = 0;
  /** The last channel status byte, for messages that omit their own. */
  let runningStatus = 0;

  while (body.remaining > 0) {
    tick += body.vlq();

    // Running status: a byte with the high bit clear is not a status byte but the
    // first data byte of another message of the same kind as the last one. Files
    // use it constantly — it is how MIDI stays compact — and a parser that does
    // not honour it reads garbage from the second event onward. So the byte is
    // inspected before it is consumed.
    let status: number;
    if (body.peek() >= 0x80) {
      status = body.u8();
      // System messages clear running status; channel messages set it.
      runningStatus = status < 0xf0 ? status : 0;
    } else {
      if (runningStatus === 0) throw new Error("midi: data byte before any status byte");
      status = runningStatus;
    }

    if (status === META) {
      const type = body.u8();
      const length = body.vlq();
      readMeta(type, length, body, trackIndex, tick, parse);
      if (type === META_END_OF_TRACK) break;
      continue;
    }

    if (status === SYSEX || status === SYSEX_ESCAPE) {
      body.skip(body.vlq());
      continue;
    }

    const data: number[] = [];
    for (let i = 0; i < channelDataLength(status); i += 1) data.push(body.u8());
    applyChannelMessage(status, data, trackIndex, tick, parse, pending);
  }

  // Anything still sounding at the end of the track is closed there rather than
  // dropped: a file that forgets a note-off should not cost us the note.
  for (const [composite, slots] of [...pending]) {
    const channel = composite >> 8;
    const key = composite & 0xff;
    while (slots.length > 0) closeNote(pending, parse.notes, trackIndex, channel, key, tick);
  }
}

function applyChannelMessage(
  status: number,
  data: number[],
  trackIndex: number,
  tick: number,
  parse: MidiParse,
  pending: Pending,
): void {
  const kind = status & 0xf0;
  const channel = status & 0x0f;

  if (kind === NOTE_ON) {
    const key = data[0] ?? 0;
    const velocity = data[1] ?? 0;
    if (velocity === 0) {
      // A note-on with zero velocity is a note-off. Treating it as a note start
      // leaves every note in half the files ever written hanging forever.
      closeNote(pending, parse.notes, trackIndex, channel, key, tick);
      return;
    }
    const composite = (channel << 8) | key;
    const slot = pending.get(composite) ?? [];
    slot.push({ startTicks: tick, velocity });
    pending.set(composite, slot);
    if (channel === DRUM_CHANNEL) parse.hasPercussion = true;
    return;
  }

  if (kind === NOTE_OFF) {
    closeNote(pending, parse.notes, trackIndex, channel, data[0] ?? 0, tick);
    return;
  }

  if (kind === 0xc0) {
    parse.programs.push({ track: trackIndex, channel, program: data[0] ?? 0 });
    return;
  }

  if (kind === PITCH_BEND) {
    const raw = ((data[1] ?? 0) << 7) | (data[0] ?? 0);
    parse.pitchBends.push({
      track: trackIndex,
      channel,
      tick,
      semitones: ((raw - PITCH_BEND_CENTRE) / PITCH_BEND_CENTRE) * PITCH_BEND_RANGE_SEMITONES,
    });
    return;
  }

  // Control changes, aftertouch and the rest are consumed and ignored: nothing in
  // the model carries them yet, and skipping them by the right length is the only
  // thing the parser owes them.
  void CONTROL_CHANGE;
}

function readMeta(
  type: number,
  length: number,
  body: ByteReader,
  trackIndex: number,
  tick: number,
  parse: MidiParse,
): void {
  if (type === META_TRACK_NAME) {
    parse.trackNames[trackIndex] = body.ascii(length);
    return;
  }
  if (type === META_TEMPO && length === 3) {
    const micros = (body.u8() << 16) | (body.u8() << 8) | body.u8();
    if (micros > 0) parse.tempoChanges.push({ tick, bpm: 60_000_000 / micros });
    return;
  }
  if (type === META_TIME_SIGNATURE && length >= 2) {
    const beats = body.u8();
    const dd = body.u8();
    body.skip(length - 2);
    parse.meterChanges.push({ tick, beats, beatValue: 2 ** dd });
    return;
  }
  if (type === META_KEY_SIGNATURE) {
    body.skip(length);
    return;
  }
  body.skip(length);
}
