/**
 * MIDI, both directions.
 *
 * The writer and the reader are tested against each other on purpose. A format
 * pair that agrees is a format pair whose bugs have to be symmetric to hide, and
 * this needs no alphaTab, no browser and no fixture files — which is exactly the
 * property STANDALONE.md is trying to build up to. `tools/midi-check.mjs` then
 * grades the writer against alphaTab's own MIDI, so a symmetric mistake here would
 * still be caught there.
 *
 * The byte primitives are tested on their boundaries separately, because a
 * variable-length quantity is the classic thing that works on small files and
 * fails on the first delta over 127 ticks.
 */
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  createNote,
  createScore,
  duration,
  frettedGuitar,
  createTrack,
  timeline,
  QUARTER_TICKS,
  STANDARD_BASS,
  type Op,
  type OpBatch,
  type OpKind,
  type Score,
} from "@cubscore/core";
import { toMidi } from "./to-midi.js";
import { parseMidi } from "./from-midi.js";
import { ByteReader, ByteWriter } from "./midi-bytes.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `midi-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `midi-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

function withNote(score: Score, bar: number, beat: number, fret: number, string = 1): Score {
  const target = score.tracks[0]!.bars[bar]!.voices[0]!.beats[beat]!;
  const open = [64, 59, 55, 50, 45, 40][string - 1] ?? 64;
  return applyBatch(
    score,
    batch({ type: "note.insert", beatId: target.id, note: createNote(open + fret, string, fret) }),
  );
}

/** Write, read back, and hand over both sides for comparison. */
function roundTrip(score: Score) {
  const line = timeline(score);
  const { bytes, report } = toMidi(score, line);
  return { line, bytes, report, parsed: parseMidi(bytes) };
}

describe("byte primitives", () => {
  it("round-trips a variable-length quantity across every boundary", () => {
    // The boundaries are where a VLQ grows a byte. A writer that never emitted a
    // continuation bit would pass on all the small ones.
    for (const value of [0, 1, 63, 127, 128, 255, 8191, 8192, 16383, 16384, 2097151, 2097152, 0x0fffffff]) {
      const w = new ByteWriter().vlq(value);
      expect(new ByteReader(w.toUint8Array()).vlq(), `value ${value}`).toBe(value);
    }
  });

  it("uses the documented encoding, not merely a self-consistent one", () => {
    // 128 is the canonical example from the specification: 0x81 0x00.
    expect([...new ByteWriter().vlq(128).toUint8Array()]).toEqual([0x81, 0x00]);
    expect([...new ByteWriter().vlq(0x0fffffff).toUint8Array()]).toEqual([0xff, 0xff, 0xff, 0x7f]);
    expect([...new ByteWriter().vlq(0).toUint8Array()]).toEqual([0x00]);
  });

  it("round-trips a 32-bit length above the sign bit", () => {
    // Chunk lengths are unsigned. Reading them with shifts turns anything past
    // 0x7FFFFFFF negative, which would make skip() reject a legal file.
    const w = new ByteWriter().u32(0xfffffff0);
    expect(new ByteReader(w.toUint8Array()).u32()).toBe(0xfffffff0);
  });

  it("refuses to read past the end rather than inventing bytes", () => {
    expect(() => new ByteReader(new Uint8Array([1, 2])).u32()).toThrow(/unexpected end/);
    expect(() => new ByteReader(new Uint8Array([1, 2])).skip(5)).toThrow(/more data than the file holds/);
  });

  it("rejects a variable-length quantity longer than the format allows", () => {
    expect(() => new ByteReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x00])).vlq()).toThrow(/four bytes/);
  });
});

describe("file structure", () => {
  it("writes a Type 1 header with one track per part plus the conductor", () => {
    const score = createScore("Structure");
    const two = applyBatch(
      score,
      batch({ type: "track.insert", index: 1, track: createTrack("Bass", frettedGuitar(), 4) }),
    );
    const { parsed, report } = roundTrip(two);
    expect(parsed.format).toBe(1);
    // Conductor plus two parts.
    expect(report.trackCount).toBe(3);
    expect(parsed.trackNames).toHaveLength(3);
  });

  it("states the timeline's own division, so nothing is rescaled", () => {
    const { parsed } = roundTrip(createScore("Division"));
    expect(parsed.ticksPerQuarter).toBe(QUARTER_TICKS);
  });

  it("names the conductor track after the score and the parts after themselves", () => {
    const score = applyBatch(
      createScore("Song Title"),
      batch({ type: "track.rename", trackId: createScore("x").tracks[0]!.id, name: "ignored" }),
    );
    const renamed = applyBatch(
      score,
      batch({ type: "track.rename", trackId: score.tracks[0]!.id, name: "Lead" }),
    );
    const { parsed } = roundTrip(renamed);
    expect(parsed.trackNames[0]).toBe("Song Title");
    expect(parsed.trackNames[1]).toBe("Lead");
  });

  it("ends every track properly, so a reader stops where it should", () => {
    // An end-of-track meta event is what tells readTrack to break. Without it the
    // parser would run to the end of the chunk and any trailing byte would throw.
    const { bytes } = roundTrip(withNote(createScore("End"), 0, 0, 5));
    expect(() => parseMidi(bytes)).not.toThrow();
  });
});

describe("notes", () => {
  it("writes every note, at the tick the timeline put it", () => {
    let score = createScore("Notes");
    score = withNote(score, 0, 0, 3);
    score = withNote(score, 0, 1, 5);
    score = withNote(score, 1, 0, 7);
    const { line, parsed } = roundTrip(score);

    expect(parsed.notes).toHaveLength(3);
    const written = line.notes.map((n) => n.startTicks).sort((a, b) => a - b);
    const read = parsed.notes.map((n) => n.startTicks).sort((a, b) => a - b);
    expect(read).toEqual(written);
  });

  it("writes the pitch, not the fret", () => {
    // Fret 5 on the top string is 69, not 5. A writer that sent the fret would
    // produce a file that plays five semitones above the lowest note on a piano.
    const { parsed } = roundTrip(withNote(createScore("Pitch"), 0, 0, 5));
    expect(parsed.notes[0]?.key).toBe(69);
  });

  it("sounds a chord's notes together on one channel", () => {
    let score = createScore("Chord");
    score = withNote(score, 0, 0, 0, 1);
    score = withNote(score, 0, 0, 2, 2);
    score = withNote(score, 0, 0, 2, 3);
    const { parsed } = roundTrip(score);
    expect(parsed.notes).toHaveLength(3);
    expect(new Set(parsed.notes.map((n) => n.startTicks)).size).toBe(1);
    expect(new Set(parsed.notes.map((n) => n.channel)).size).toBe(1);
  });

  it("ends a note just before the next begins, not exactly on it", () => {
    // A note-off and a note-on at the same tick on the same key is undefined
    // behaviour in a synth: some retrigger, some cut the new note dead.
    let score = createScore("Overlap");
    score = withNote(score, 0, 0, 5);
    score = withNote(score, 0, 1, 5);
    const { parsed } = roundTrip(score);
    const [first, second] = [...parsed.notes].sort((a, b) => a.startTicks - b.startTicks);
    expect(first!.startTicks + first!.durationTicks).toBeLessThan(second!.startTicks);
    // But still nearly the whole beat: this is a safety margin, not articulation.
    expect(first!.durationTicks).toBeGreaterThan(QUARTER_TICKS * 0.9);
  });

  it("gives each part its own channel and keeps off the percussion channel", () => {
    let score = createScore("Channels");
    score = applyBatch(
      score,
      batch({ type: "track.insert", index: 1, track: createTrack("Bass", frettedGuitar(), 4) }),
    );
    // A note in each part.
    const barA = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!;
    const barB = score.tracks[1]!.bars[0]!.voices[0]!.beats[0]!;
    score = applyBatch(
      score,
      batch(
        { type: "note.insert", beatId: barA.id, note: createNote(64, 1, 0) },
        { type: "note.insert", beatId: barB.id, note: createNote(45, 5, 0) },
      ),
    );
    const { parsed } = roundTrip(score);
    const channels = new Set(parsed.notes.map((n) => n.channel));
    expect(channels.size).toBe(2);
    expect(channels.has(9)).toBe(false);
    expect(parsed.hasPercussion).toBe(false);
  });

  it("puts a bass tuning on a bass program and a guitar tuning on a guitar one", () => {
    const guitar = roundTrip(withNote(createScore("Guitar"), 0, 0, 0));
    expect(guitar.parsed.programs.some((p) => p.program === 25)).toBe(true);

    const bassTrack = createTrack(
      "Bass",
      { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 },
      4,
    );
    const bassScore: Score = { ...createScore("Bass"), tracks: [bassTrack] };
    const bass = roundTrip(bassScore);
    expect(bass.parsed.programs.some((p) => p.program === 33)).toBe(true);
  });
});

describe("timing", () => {
  it("writes one tempo event for a score with one tempo", () => {
    const score = createScore("Tempo");
    const marked = applyBatch(
      score,
      batch({ type: "bar.setTempo", barId: score.tracks[0]!.bars[0]!.id, tempoBpm: 132 }),
    );
    const { parsed } = roundTrip(marked);
    expect(parsed.tempoChanges).toHaveLength(1);
    expect(parsed.tempoChanges[0]?.bpm).toBeCloseTo(132, 1);
  });

  it("writes a tempo change at the tick it takes effect", () => {
    const score = createScore("Tempo change");
    const bars = score.tracks[0]!.bars;
    const marked = applyBatch(
      score,
      batch(
        { type: "bar.setTempo", barId: bars[0]!.id, tempoBpm: 120 },
        { type: "bar.setTempo", barId: bars[2]!.id, tempoBpm: 60 },
      ),
    );
    const { parsed } = roundTrip(marked);
    expect(parsed.tempoChanges).toHaveLength(2);
    expect(parsed.tempoChanges[1]?.tick).toBe(QUARTER_TICKS * 8);
    expect(parsed.tempoChanges[1]?.bpm).toBeCloseTo(60, 1);
  });

  it("writes the meter, and a meter change where it happens", () => {
    const score = createScore("Meter");
    const bars = score.tracks[0]!.bars;
    const marked = applyBatch(
      score,
      batch({ type: "bar.setTimeSignature", barId: bars[1]!.id, timeSignature: { beats: 7, beatValue: 8 } }),
    );
    const { parsed } = roundTrip(marked);
    expect(parsed.meterChanges[0]).toEqual({ tick: 0, beats: 4, beatValue: 4 });
    expect(parsed.meterChanges[1]).toEqual({ tick: QUARTER_TICKS * 4, beats: 7, beatValue: 8 });
  });

  it("restates the tempo on the second pass through a repeat", () => {
    // A reader walking the track forward has no way to learn that the music went
    // back to a bar with a different tempo mark, so the map must say so again.
    const score = createScore("Repeat tempo");
    const clone: Score = structuredClone(score);
    const bars = clone.tracks[0]!.bars;
    bars[0]!.tempoBpm = 100;
    bars[0]!.repeat = { start: true };
    bars[1]!.tempoBpm = 200;
    bars[1]!.repeat = { endCount: 2 };
    const { parsed } = roundTrip(clone);
    expect(parsed.tempoChanges.map((t) => Math.round(t.bpm))).toEqual([100, 200, 100, 200]);
  });

  it("writes a repeated section's notes once per pass", () => {
    const score = withNote(createScore("Repeat notes"), 0, 0, 9);
    const clone: Score = structuredClone(score);
    clone.tracks[0]!.bars[0]!.repeat = { start: true };
    clone.tracks[0]!.bars[1]!.repeat = { endCount: 2 };
    const { parsed } = roundTrip(clone);
    expect(parsed.notes.filter((n) => n.key === 73)).toHaveLength(2);
  });

  it("survives a delta longer than a single VLQ byte", () => {
    // Two notes four bars apart is a delta of thousands of ticks. This is the case
    // a broken VLQ writer fails on, and it is why the primitive is tested above.
    let score = createScore("Long delta", "", 8);
    score = withNote(score, 0, 0, 3);
    score = withNote(score, 7, 3, 5);
    const { line, parsed } = roundTrip(score);
    expect(parsed.notes).toHaveLength(2);
    expect(parsed.notes[1]?.startTicks).toBe(line.notes[1]?.startTicks);
    expect(parsed.notes[1]?.startTicks).toBeGreaterThan(127);
  });
});

describe("articulations", () => {
  const articulated = (articulation: Parameters<typeof withArticulation>[1]) =>
    roundTrip(withArticulation(withNote(createScore("Art"), 0, 0, 5), articulation));

  function withArticulation(score: Score, articulation: "accent" | "ghost" | "staccato" | "palmMute" | "bend" | "letRing") {
    const note = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    return applyBatch(score, batch({ type: "note.addArticulation", noteId: note.id, articulation }));
  }

  it("plays an accent louder and a ghost note quieter", () => {
    const plain = roundTrip(withNote(createScore("Plain"), 0, 0, 5));
    const base = plain.parsed.notes[0]!.velocity;
    expect(articulated("accent").parsed.notes[0]!.velocity).toBeGreaterThan(base);
    expect(articulated("ghost").parsed.notes[0]!.velocity).toBeLessThan(base);
  });

  it("shortens a staccato note and a palm mute", () => {
    const plain = roundTrip(withNote(createScore("Plain"), 0, 0, 5));
    const base = plain.parsed.notes[0]!.durationTicks;
    expect(articulated("staccato").parsed.notes[0]!.durationTicks).toBeLessThan(base * 0.7);
    expect(articulated("palmMute").parsed.notes[0]!.durationTicks).toBeLessThan(base * 0.8);
  });

  it("lets a let-ring note sustain past its beat", () => {
    const plain = roundTrip(withNote(createScore("Plain"), 0, 0, 5));
    expect(articulated("letRing").parsed.notes[0]!.durationTicks).toBeGreaterThan(
      plain.parsed.notes[0]!.durationTicks,
    );
  });

  it("writes a bend as pitch bend, returning to centre", () => {
    const { parsed, report } = articulated("bend");
    expect(parsed.pitchBends.length).toBeGreaterThanOrEqual(3);
    expect(parsed.pitchBends[0]?.semitones).toBeCloseTo(0, 2);
    expect(Math.max(...parsed.pitchBends.map((b) => b.semitones))).toBeCloseTo(2, 1);
    expect(parsed.pitchBends.at(-1)?.semitones).toBeCloseTo(0, 2);
    // And it says the contour was not carried, because the model has none.
    expect(report.unsupported.some((u) => u.includes("bend"))).toBe(true);
  });

  it("reports what the format cannot carry rather than dropping it silently", () => {
    const score = withNote(createScore("Reports"), 0, 0, 5);
    const note = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    const marked = applyBatch(
      score,
      batch(
        { type: "note.addArticulation", noteId: note.id, articulation: "vibrato" },
        { type: "note.addArticulation", noteId: note.id, articulation: "slide" },
        { type: "note.addArticulation", noteId: note.id, articulation: "naturalHarmonic" },
      ),
    );
    const { report } = toMidi(marked);
    expect(report.unsupported).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vibrato"),
        expect.stringContaining("slide"),
        expect.stringContaining("harmonic"),
      ]),
    );
  });

  it("reports a drum track as not carried, and writes no channel-10 notes", () => {
    const drums = createTrack("Kit", { kind: "drums" }, 4);
    const score: Score = { ...createScore("Drums"), tracks: [drums] };
    const { report, parsed } = roundTrip(score);
    expect(report.unsupported.some((u) => u.includes("percussion"))).toBe(true);
    expect(parsed.hasPercussion).toBe(false);
  });
});

describe("reading files we did not write", () => {
  it("honours running status", () => {
    // Three note-ons sharing one status byte, which is how most files are written
    // and the thing a naive parser gets wrong from the second event onward.
    const track = new ByteWriter();
    track.vlq(0).u8(0x90).u8(60).u8(100); // note on, with status
    track.vlq(0).u8(64).u8(100); // running status: another note on
    track.vlq(0).u8(67).u8(100);
    track.vlq(480).u8(0x80).u8(60).u8(0);
    track.vlq(0).u8(64).u8(0);
    track.vlq(0).u8(67).u8(0);
    track.vlq(0).u8(0xff).u8(0x2f).vlq(0);

    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(0).u16(1).u16(480);
    file.ascii("MTrk").u32(track.length).raw(track);

    const parsed = parseMidi(file.toUint8Array());
    expect(parsed.notes.map((n) => n.key)).toEqual([60, 64, 67]);
    expect(parsed.notes.every((n) => n.durationTicks === 480)).toBe(true);
  });

  it("treats a note-on with zero velocity as a note-off", () => {
    // Half the files ever written end notes this way. A parser that does not would
    // leave every note hanging.
    const track = new ByteWriter();
    track.vlq(0).u8(0x90).u8(60).u8(100);
    track.vlq(240).u8(0x90).u8(60).u8(0);
    track.vlq(0).u8(0xff).u8(0x2f).vlq(0);
    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(0).u16(1).u16(480);
    file.ascii("MTrk").u32(track.length).raw(track);

    const parsed = parseMidi(file.toUint8Array());
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]?.durationTicks).toBe(240);
  });

  it("skips a system-exclusive block by its length", () => {
    const track = new ByteWriter();
    track.vlq(0).u8(0xf0).vlq(3).u8(1).u8(2).u8(3);
    track.vlq(0).u8(0x90).u8(60).u8(100);
    track.vlq(96).u8(0x80).u8(60).u8(0);
    track.vlq(0).u8(0xff).u8(0x2f).vlq(0);
    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(0).u16(1).u16(480);
    file.ascii("MTrk").u32(track.length).raw(track);

    const parsed = parseMidi(file.toUint8Array());
    expect(parsed.notes).toHaveLength(1);
  });

  it("skips a chunk type it does not know", () => {
    const track = new ByteWriter();
    track.vlq(0).u8(0x90).u8(60).u8(100);
    track.vlq(96).u8(0x80).u8(60).u8(0);
    track.vlq(0).u8(0xff).u8(0x2f).vlq(0);
    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(1).u16(1).u16(480);
    file.ascii("XFIR").u32(4).u8(9).u8(9).u8(9).u8(9);
    file.ascii("MTrk").u32(track.length).raw(track);

    expect(parseMidi(file.toUint8Array()).notes).toHaveLength(1);
  });

  it("closes a note the file forgot to end rather than losing it", () => {
    const track = new ByteWriter();
    track.vlq(0).u8(0x90).u8(60).u8(100);
    track.vlq(480).u8(0xff).u8(0x2f).vlq(0);
    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(0).u16(1).u16(480);
    file.ascii("MTrk").u32(track.length).raw(track);

    const parsed = parseMidi(file.toUint8Array());
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]?.durationTicks).toBe(480);
  });

  it("notices percussion on channel 10", () => {
    const track = new ByteWriter();
    track.vlq(0).u8(0x99).u8(38).u8(100);
    track.vlq(96).u8(0x89).u8(38).u8(0);
    track.vlq(0).u8(0xff).u8(0x2f).vlq(0);
    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(0).u16(1).u16(480);
    file.ascii("MTrk").u32(track.length).raw(track);

    const parsed = parseMidi(file.toUint8Array());
    expect(parsed.hasPercussion).toBe(true);
    expect(parsed.notes[0]?.channel).toBe(9);
  });

  it("rejects bytes that are not a MIDI file, instead of guessing", () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
    expect(() => parseMidi(new Uint8Array(20))).toThrow(/MThd/);
  });

  it("refuses SMPTE division rather than misplacing every note", () => {
    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(0).u16(1).u16(0xe278);
    file.ascii("MTrk").u32(4).u8(0).u8(0xff).u8(0x2f).u8(0);
    expect(() => parseMidi(file.toUint8Array())).toThrow(/SMPTE/);
  });

  it("rejects a track chunk claiming more data than the file holds", () => {
    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(0).u16(1).u16(480);
    file.ascii("MTrk").u32(9999).u8(0);
    expect(() => parseMidi(file.toUint8Array())).toThrow(/more data than the file holds/);
  });
});

describe("an empty score", () => {
  it("writes a valid file with no notes in it", () => {
    const empty: Score = { id: "s", title: "Nothing", artist: "", tracks: [], revision: 0 };
    const { parsed, report } = roundTrip(empty);
    expect(report.noteCount).toBe(0);
    expect(parsed.notes).toEqual([]);
    // The conductor track is still there, and the file still parses.
    expect(parsed.trackNames[0]).toBe("Nothing");
  });
});
