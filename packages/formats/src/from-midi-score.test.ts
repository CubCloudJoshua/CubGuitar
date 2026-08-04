/**
 * MIDI import, graded by a round trip through our own writer.
 *
 * The shape of the check is the same one that gates every other format here: what we
 * write, we must be able to read back to the same music. It is stronger than it sounds
 * for this particular importer, because the two halves were built for different reasons
 * and neither was written with the other in mind — `to-midi.ts` exists to export, and
 * the quantiser exists for audio transcription. A disagreement between them is a real
 * disagreement rather than one implementation confirming itself.
 *
 * What a round trip cannot catch is a convention we get wrong in both directions at
 * once, which is why `pnpm midi` grades our bytes against alphaTab's independently.
 */
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  createBar,
  createNote,
  createScore,
  createTrack,
  frettedGuitar,
  timeline,
  QUARTER_TICKS,
  STANDARD_BASS,
  type Op,
  type OpBatch,
  type OpKind,
  type Score,
  type TimeSignature,
} from "@cubscore/core";
import { toMidi } from "./to-midi.js";
import { fromMidiScore } from "./from-midi-score.js";
import { ByteWriter } from "./midi-bytes.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `fms-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `fms-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

/** A score out through our MIDI writer and back in through the importer. */
function roundTrip(score: Score, options?: Parameters<typeof fromMidiScore>[1]) {
  const { bytes } = toMidi(score, timeline(score));
  return fromMidiScore(bytes, options);
}

/** Sounding notes as (millisecond, pitch) pairs, which is what has to survive. */
function sounded(score: Score, trackIndex = 0): string[] {
  return timeline(score)
    .notes.filter((n) => n.trackIndex === trackIndex)
    .map((n) => `${Math.round(n.startSeconds * 1000)}:${n.pitch}`)
    .sort();
}

/** A guitar score with a note on each listed beat of bar 0. */
function guitar(frets: number[], bars = 2): Score {
  const base: Score = {
    ...createScore("MIDI round trip"),
    tracks: [createTrack("Guitar", frettedGuitar(), bars)],
  };
  const kinds: OpKind[] = [];
  for (const [i, fret] of frets.entries()) {
    const bar = Math.floor(i / 4);
    const beat = base.tracks[0]!.bars[bar]?.voices[0]?.beats[i % 4];
    if (!beat) continue;
    kinds.push({ type: "note.insert", beatId: beat.id, note: createNote(64 + fret, 1, fret) });
  }
  return applyBatch(base, batch(...kinds));
}

describe("a score through MIDI and back", () => {
  it("keeps every note at the moment it sounded", () => {
    const original = guitar([0, 2, 3, 5, 7, 8, 10, 12]);
    const { score } = roundTrip(original);
    expect(sounded(score)).toEqual(sounded(original));
  });

  it("reports what it read", () => {
    const { report } = roundTrip(guitar([0, 2, 3, 5]));
    expect(report.trackCount).toBe(1);
    expect(report.noteCount).toBe(4);
    expect(report.barCount).toBeGreaterThan(0);
  });

  it("fingers a guitar part rather than leaving it as pitches", () => {
    const { score } = roundTrip(guitar([0, 2, 3, 5]));
    const track = score.tracks[0]!;
    expect(track.instrument.kind).toBe("fretted");
    const notes = track.bars.flatMap((b) => b.voices[0]!.beats).flatMap((b) => b.notes);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expect(note.string).toBeDefined();
  });

  it("says that a fretted tuning was guessed, because General MIDI cannot state one", () => {
    const { report } = roundTrip(guitar([0, 2, 3, 5]));
    expect(report.unsupported.join(" ")).toMatch(/tuning was guessed/);
  });
});

describe("what the parts are", () => {
  it("keeps two tracks apart", () => {
    const base: Score = {
      ...createScore("Two parts"),
      tracks: [createTrack("Guitar", frettedGuitar(), 2)],
    };
    const withBass = applyBatch(
      base,
      batch({
        type: "track.insert",
        index: 1,
        track: createTrack("Bass", { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, 2),
      }),
    );
    const filled = applyBatch(
      withBass,
      batch(
        { type: "note.insert", beatId: withBass.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(64, 1, 0) },
        { type: "note.insert", beatId: withBass.tracks[1]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(28, 4, 0) },
      ),
    );
    const { score, report } = roundTrip(filled);
    expect(report.trackCount).toBe(2);
    expect(score.tracks).toHaveLength(2);
  });

  it("does not drag a late part back to the downbeat", () => {
    // The reason every part shares one origin. The bass enters on beat 3; quantised on
    // its own it would anchor there and be written as if it started with the guitar.
    const base: Score = {
      ...createScore("Late entry"),
      tracks: [createTrack("Guitar", frettedGuitar(), 2)],
    };
    const withBass = applyBatch(
      base,
      batch({
        type: "track.insert",
        index: 1,
        track: createTrack("Bass", { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, 2),
      }),
    );
    const filled = applyBatch(
      withBass,
      batch(
        { type: "note.insert", beatId: withBass.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(64, 1, 0) },
        { type: "note.insert", beatId: withBass.tracks[1]!.bars[0]!.voices[0]!.beats[2]!.id, note: createNote(28, 4, 0) },
      ),
    );
    const { score } = roundTrip(filled);
    // The guitar's note is at 0ms and the bass's a full second later at 120bpm.
    expect(sounded(score, 0)).toEqual(["0:64"]);
    expect(sounded(score, 1)).toEqual(["1000:28"]);
  });

  it("gives every track the same number of bars", () => {
    // Bar lines are shared. A short track does not merely look untidy: the timeline
    // takes the longest track as its spine, so a shorter one stops contributing and
    // reads as the part ending rather than resting.
    const base: Score = {
      ...createScore("Uneven"),
      tracks: [createTrack("Guitar", frettedGuitar(), 4)],
    };
    const withBass = applyBatch(
      base,
      batch({
        type: "track.insert",
        index: 1,
        track: createTrack("Bass", { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, 4),
      }),
    );
    const filled = applyBatch(
      withBass,
      batch(
        // Guitar plays through bar 3; bass plays only bar 0.
        { type: "note.insert", beatId: withBass.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(64, 1, 0) },
        { type: "note.insert", beatId: withBass.tracks[0]!.bars[3]!.voices[0]!.beats[0]!.id, note: createNote(67, 1, 3) },
        { type: "note.insert", beatId: withBass.tracks[1]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(28, 4, 0) },
      ),
    );
    const { score } = roundTrip(filled);
    const counts = score.tracks.map((t) => t.bars.length);
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThanOrEqual(4);
  });

  it("carries a drum kit as drums and says notation is still the gap", () => {
    const base: Score = {
      ...createScore("Kit"),
      tracks: [createTrack("Kit", { kind: "drums" }, 2)],
    };
    const filled = applyBatch(
      base,
      batch({
        type: "note.insert",
        beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id,
        note: { id: "d1", pitch: 36, articulations: [] },
      }),
    );
    const { score, report } = roundTrip(filled);
    expect(score.tracks[0]?.instrument.kind).toBe("drums");
    expect(report.unsupported.join(" ")).toMatch(/drum notation/);
  });

  it("leaves a piano part pitched rather than guessing a fingering for it", () => {
    // A piano program is not a guitar. Arranging one for guitar is a thing the user can
    // ask for; doing it unasked is harder to undo than offering it.
    const base: Score = {
      ...createScore("Piano"),
      tracks: [createTrack("Piano", { kind: "pitched", midiProgram: 0 }, 2)],
    };
    const filled = applyBatch(
      base,
      batch({
        type: "note.insert",
        beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id,
        note: { id: "p1", pitch: 60, articulations: [] },
      }),
    );
    const { score } = roundTrip(filled);
    const instrument = score.tracks[0]?.instrument;
    expect(instrument?.kind).toBe("pitched");
    const note = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0];
    expect(note?.pitch).toBe(60);
    expect(note?.string).toBeUndefined();
  });

  it("uses the track name the file states", () => {
    const base: Score = {
      ...createScore("Named"),
      tracks: [createTrack("Rhythm Gtr", frettedGuitar(), 2)],
    };
    const filled = applyBatch(
      base,
      batch({ type: "note.insert", beatId: base.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.id, note: createNote(64, 1, 0) }),
    );
    expect(roundTrip(filled).score.tracks[0]?.name).toBe("Rhythm Gtr");
  });
});

describe("structure the file states", () => {
  it("keeps a meter change", () => {
    const meters: TimeSignature[] = [
      { beats: 4, beatValue: 4 },
      { beats: 3, beatValue: 4 },
      { beats: 4, beatValue: 4 },
    ];
    const base: Score = {
      ...createScore("Mixed meter"),
      tracks: [
        {
          id: "mm",
          name: "Guitar",
          instrument: frettedGuitar(),
          bars: meters.map((m, i) => createBar(m, i === 0 || m.beats !== meters[i - 1]!.beats)),
        },
      ],
    };
    const kinds: OpKind[] = [];
    for (const bar of base.tracks[0]!.bars) {
      for (const beat of bar.voices[0]!.beats) {
        kinds.push({ type: "note.insert", beatId: beat.id, note: createNote(64, 1, 0) });
      }
    }
    const original = applyBatch(base, batch(...kinds));
    const { score } = roundTrip(original);
    // The 3/4 bar is three quarters long on the way back, not four.
    const lengths = score.tracks[0]!.bars.slice(0, 3).map((bar) =>
      bar.voices[0]!.beats.reduce((sum, beat) => {
        const beatBase = (QUARTER_TICKS * 4 * beat.duration.numerator) / beat.duration.denominator;
        return sum + (beat.dots === 0 ? beatBase : beat.dots === 1 ? beatBase * 1.5 : beatBase * 1.75);
      }, 0),
    );
    expect(lengths).toEqual([QUARTER_TICKS * 4, QUARTER_TICKS * 3, QUARTER_TICKS * 4]);
    expect(sounded(score)).toEqual(sounded(original));
  });

  it("keeps a tempo change, so the notes stay where they sounded", () => {
    const base: Score = {
      ...createScore("Tempo change"),
      tracks: [createTrack("Guitar", frettedGuitar(), 3)],
    };
    const marked = applyBatch(
      base,
      batch({ type: "bar.setTempo", barId: base.tracks[0]!.bars[1]!.id, tempoBpm: 60 }),
    );
    const kinds: OpKind[] = [];
    for (const bar of marked.tracks[0]!.bars.slice(0, 2)) {
      for (const beat of bar.voices[0]!.beats) {
        kinds.push({ type: "note.insert", beatId: beat.id, note: createNote(64, 1, 0) });
      }
    }
    const original = applyBatch(marked, batch(...kinds));
    const { score } = roundTrip(original);
    expect(sounded(score)).toEqual(sounded(original));
    expect(score.tracks[0]!.bars[1]?.tempoBpm).toBe(60);
  });
});

/**
 * Files our own writer cannot produce.
 *
 * A round trip only ever exercises the conventions we ourselves use, and the two things
 * below are exactly the ones we do not: we write one track per part at 960 ticks to the
 * quarter. Both of these are ordinary in files from elsewhere, and both survived
 * mutation testing until they were written by hand — removing the channel from the
 * split key, and removing the tick rescaling entirely, changed nothing a round trip
 * could see.
 */
describe("files we did not write", () => {
  /** A format-0 file: one track, several channels, an arbitrary division. */
  function formatZero(division: number): Uint8Array {
    const track = new ByteWriter();
    // Channel 0 is a guitar program, channel 1 a piano. One track, as format 0 requires.
    track.vlq(0).u8(0xc0).u8(25);
    track.vlq(0).u8(0xc1).u8(0);
    track.vlq(0).u8(0x90).u8(64).u8(100); // guitar, on channel 0
    track.vlq(0).u8(0x91).u8(60).u8(100); // piano, on channel 1
    track.vlq(division).u8(0x80).u8(64).u8(0);
    track.vlq(0).u8(0x81).u8(60).u8(0);
    // A second guitar note a quarter later, so the part has a rhythm to recover.
    track.vlq(0).u8(0x90).u8(67).u8(100);
    track.vlq(division).u8(0x80).u8(67).u8(0);
    track.vlq(0).u8(0xff).u8(0x2f).vlq(0);

    const file = new ByteWriter();
    file.ascii("MThd").u32(6).u16(0).u16(1).u16(division);
    file.ascii("MTrk").u32(track.length).raw(track);
    return file.toUint8Array();
  }

  it("separates two channels sharing one track", () => {
    // Format 0 puts everything on track 0, so the channel is the only thing telling a
    // guitar part from a piano part. Splitting on the track alone yields one track
    // holding both, and every note of one instrument written onto the other.
    const { score, report } = fromMidiScore(formatZero(480));
    expect(report.trackCount).toBe(2);
    const kinds = score.tracks.map((t) => t.instrument.kind).sort();
    expect(kinds).toEqual(["fretted", "pitched"]);
    // And the notes went to the right parts rather than being pooled.
    const guitarPitches = score.tracks
      .find((t) => t.instrument.kind === "fretted")!
      .bars.flatMap((b) => b.voices[0]!.beats)
      .flatMap((b) => b.notes)
      .map((n) => n.pitch);
    expect(guitarPitches).toContain(64);
    expect(guitarPitches).not.toContain(60);
  });

  it("rescales a file's own division to ours", () => {
    // 480 ticks to the quarter, not our 960. Without rescaling every position is halved:
    // two quarter notes become two eighths and the piece is written at double speed.
    const { score } = fromMidiScore(formatZero(480));
    const guitar = score.tracks.find((t) => t.instrument.kind === "fretted")!;
    const line = timeline({ ...score, tracks: [guitar] });
    // At the default 120bpm a quarter is 500ms, so the second guitar note is at 500ms.
    expect(line.notes.map((n) => Math.round(n.startSeconds * 1000))).toEqual([0, 500]);
  });

  it("rescales an unusual division too", () => {
    // 96 is what a lot of older sequencers wrote. The same two quarter notes.
    const { score } = fromMidiScore(formatZero(96));
    const guitar = score.tracks.find((t) => t.instrument.kind === "fretted")!;
    const line = timeline({ ...score, tracks: [guitar] });
    expect(line.notes.map((n) => Math.round(n.startSeconds * 1000))).toEqual([0, 500]);
  });
});

describe("files that are not music", () => {
  it("answers with an empty score rather than throwing", () => {
    const empty: Score = { ...createScore("Nothing"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const { score, report } = roundTrip(empty);
    expect(score.tracks).toHaveLength(0);
    expect(report.noteCount).toBe(0);
    expect(report.unsupported.join(" ")).toMatch(/no notes/);
  });

  it("refuses bytes that are not a MIDI file at all", () => {
    expect(() => fromMidiScore(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
  });

  it("takes the title it is given", () => {
    const { score } = roundTrip(guitar([0, 2]), { title: "My Song" });
    expect(score.title).toBe("My Song");
  });
});
