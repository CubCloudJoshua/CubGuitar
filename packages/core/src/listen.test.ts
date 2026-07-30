/**
 * Did I play that right?
 *
 * The tests that matter here are the ones about what the report refuses to claim. It
 * is easy to write a practice grader that is right about a perfect take; the ones
 * that get uninstalled are the ones that tell you that you missed notes you played,
 * and every such case has a test below: a chord a monophonic detector cannot verify,
 * a tie that is a held note rather than a second attack, one dropped note that must
 * not shift the whole bar out of alignment.
 *
 * The last block is the one that proves the pieces fit: synthesized audio for a real
 * timeline, fed through the same Listener the browser feeds, graded back against the
 * score it came from.
 */
import { describe, expect, it } from "vitest";
import { compareToTimeline, Listener, type HeardNote } from "./listen.js";
import { midiToFrequency } from "./pitch.js";
import { createScore, createTrack, frettedGuitar, nextId, duration } from "./build.js";
import { timeline } from "./timeline.js";
import type { Bar, Beat, Score, Voice } from "./score.js";

const BPM = 120;
/** One quarter note at 120bpm. */
const BEAT = 0.5;

/**
 * A score of quarter notes, four to the bar, at 120bpm.
 *
 * Each entry is the pitches attacking on that beat: several for a chord, an empty
 * array for a rest.
 */
function part(beats: number[][], tracks = 1, bpm = BPM): Score {
  const make = (name: string): ReturnType<typeof createTrack> => {
    const bars: Bar[] = [];
    for (let i = 0; i < beats.length; i += 4) {
      const voice: Voice = {
        id: nextId("v"),
        beats: beats.slice(i, i + 4).map(
          (pitches): Beat => ({
            id: nextId("b"),
            duration: duration(4),
            dots: 0,
            notes: pitches.map((pitch) => ({ id: nextId("n"), pitch, articulations: [] })),
          }),
        ),
      };
      const bar: Bar = { id: nextId("m"), voices: [voice] };
      if (i === 0) bar.tempoBpm = bpm;
      bars.push(bar);
    }
    return { id: nextId("t"), name, instrument: frettedGuitar(), bars };
  };
  const names = ["Guitar", "Second guitar"].slice(0, tracks);
  return { ...createScore("Take"), tracks: names.map(make) };
}

/** A heard note, defaulting to a confident one. */
function heard(atSeconds: number, midi: number, clarity = 0.9): HeardNote {
  return { atSeconds, midi, clarity, rms: 0.2 };
}

/** Notes heard exactly as written: the perfect take. */
function perfectly(beats: number[][], offset = 0): HeardNote[] {
  return beats.flatMap((pitches, i) =>
    // One heard note per attack, which is all a monophonic detector can produce, so
    // a chord contributes its lowest note.
    pitches.length === 0 ? [] : [heard(i * BEAT + offset, Math.min(...pitches))],
  );
}

const SCALE = [[64], [66], [67], [69]];

describe("a take played right", () => {
  it("calls every note clean", () => {
    const report = compareToTimeline(timeline(part(SCALE)), perfectly(SCALE));
    expect(report.notes.map((r) => r.judgement)).toEqual(["clean", "clean", "clean", "clean"]);
    expect(report.accuracy).toBe(1);
    expect(report.judged).toBe(4);
    expect(report.unverified).toBe(0);
  });

  it("reports no timing error at all", () => {
    const report = compareToTimeline(timeline(part(SCALE)), perfectly(SCALE));
    expect(report.timingSeconds).toBeCloseTo(0, 6);
  });

  it("finds nothing extra", () => {
    expect(compareToTimeline(timeline(part(SCALE)), perfectly(SCALE)).extra).toEqual([]);
  });

  it("counts a note inside the tolerance as clean, not as early", () => {
    // Fifty milliseconds ahead. Nobody hears that as rushing, including the player,
    // and a report that flags it teaches the user to distrust the report.
    const report = compareToTimeline(timeline(part(SCALE)), perfectly(SCALE, -0.05));
    expect(report.notes.every((r) => r.judgement === "clean")).toBe(true);
  });
});

describe("timing", () => {
  it("says late when the notes are behind the beat", () => {
    const report = compareToTimeline(timeline(part(SCALE)), perfectly(SCALE, 0.15));
    expect(report.notes.map((r) => r.judgement)).toEqual(["late", "late", "late", "late"]);
    expect(report.timingSeconds).toBeCloseTo(0.15, 6);
  });

  it("says early when they are ahead, and signs the number so", () => {
    // The single most useful thing in the report: rushing and dragging are different
    // problems with different fixes, and an unsigned average hides which one you have.
    const report = compareToTimeline(timeline(part(SCALE)), perfectly(SCALE, -0.15));
    expect(report.notes.map((r) => r.judgement)).toEqual(["early", "early", "early", "early"]);
    expect(report.timingSeconds).toBeCloseTo(-0.15, 6);
    expect(report.accuracy).toBe(1);
  });

  it("still counts an early note as played", () => {
    // Accuracy is about notes, not about time. A player who rushes played the notes.
    expect(compareToTimeline(timeline(part(SCALE)), perfectly(SCALE, 0.15)).accuracy).toBe(1);
  });

  it("reports each note's own offset, not just the average", () => {
    const line = timeline(part(SCALE));
    const report = compareToTimeline(line, [
      heard(0, 64),
      heard(BEAT + 0.12, 66),
      heard(2 * BEAT - 0.11, 67),
      heard(3 * BEAT, 69),
    ]);
    expect(report.notes[1]?.offsetSeconds).toBeCloseTo(0.12, 6);
    expect(report.notes[2]?.offsetSeconds).toBeCloseTo(-0.11, 6);
  });
});

describe("intonation", () => {
  it("accepts a note slightly out of tune and says how far", () => {
    const line = timeline(part([[64]]));
    const report = compareToTimeline(line, [heard(0, 64 - 0.3)]);
    expect(report.notes[0]?.judgement).toBe("clean");
    expect(report.notes[0]?.cents).toBeCloseTo(-30, 4);
  });

  it("calls a semitone off a wrong note, not a flat one", () => {
    const line = timeline(part([[64]]));
    const report = compareToTimeline(line, [heard(0, 63)]);
    expect(report.notes[0]?.judgement).toBe("wrongPitch");
    expect(report.notes[0]?.heardMidi).toBe(63);
    expect(report.accuracy).toBe(0);
  });

  it("takes a wider tolerance when told to, for a player working on bends", () => {
    const line = timeline(part([[64]]));
    const report = compareToTimeline(line, [heard(0, 64.6)], { centsTolerance: 80 });
    expect(report.notes[0]?.judgement).toBe("clean");
  });
});

describe("what was not played", () => {
  it("calls a note nobody played missed", () => {
    const line = timeline(part(SCALE));
    const report = compareToTimeline(line, [heard(0, 64), heard(2 * BEAT, 67), heard(3 * BEAT, 69)]);
    expect(report.notes.map((r) => r.judgement)).toEqual(["clean", "missed", "clean", "clean"]);
    expect(report.accuracy).toBeCloseTo(0.75, 6);
  });

  it("does not let one dropped note push every later note out of line", () => {
    // The failure that makes a grader useless, and the reason matching is by
    // closeness across the whole passage rather than note by note in written order.
    //
    // Four repeated notes a quarter second apart, and the first one dropped. Every
    // heard note is within tolerance of two written ones, so an implementation that
    // walks the written notes in order and gives each the nearest sound available
    // pairs every note with its predecessor: it reports the passage as played late
    // throughout and blames the wrong note for the gap. Taking the closest pairs
    // first instead names the note that is actually missing and leaves the rest in
    // time.
    const fast = part([[64], [64], [64], [64]], 1, 240);
    const report = compareToTimeline(timeline(fast), [heard(0.24, 64), heard(0.5, 64)]);
    expect(report.notes.map((r) => r.judgement)).toEqual(["missed", "clean", "clean", "missed"]);
    for (const result of report.notes) {
      if (result.offsetSeconds !== undefined) expect(Math.abs(result.offsetSeconds)).toBeLessThan(0.02);
    }
  });

  it("never spends one heard note on two written ones", () => {
    // Two notes a beat apart and one attack. The other note is missed, not matched
    // to the same sound at a stretch.
    const line = timeline(part([[64], [64]]));
    const report = compareToTimeline(line, [heard(0.05, 64)]);
    expect(report.notes.map((r) => r.judgement)).toEqual(["clean", "missed"]);
  });

  it("reports a note played where nothing was written", () => {
    const line = timeline(part(SCALE));
    const stray = heard(0.9 * BEAT + 0.3, 71);
    const report = compareToTimeline(line, [...perfectly(SCALE), stray]);
    expect(report.extra).toHaveLength(1);
    expect(report.extra[0]?.midi).toBe(71);
    // And it does not damage the notes that were right.
    expect(report.accuracy).toBe(1);
  });

  it("does not turn a rest into a missed note", () => {
    const withRest = [[64], [], [67], [69]];
    const report = compareToTimeline(timeline(part(withRest)), perfectly(withRest));
    expect(report.notes).toHaveLength(3);
    expect(report.accuracy).toBe(1);
  });
});

describe("a chord", () => {
  const chord = [[52, 59, 64]];

  it("verifies the note it heard and refuses to judge the rest", () => {
    // The refusal that keeps the report trustworthy. One detected pitch cannot speak
    // for the two notes beside it, and calling them missed would tell a guitarist
    // who played a clean E chord that they played one note out of three.
    const report = compareToTimeline(timeline(part(chord)), [heard(0, 52)]);
    const judgements = report.notes.map((r) => r.judgement);
    expect(judgements.filter((j) => j === "clean")).toHaveLength(1);
    expect(judgements.filter((j) => j === "unverified")).toHaveLength(2);
    expect(judgements).not.toContain("missed");
  });

  it("keeps the notes it could not check out of the score", () => {
    const report = compareToTimeline(timeline(part(chord)), [heard(0, 52)]);
    expect(report.accuracy).toBe(1);
    expect(report.judged).toBe(1);
    expect(report.unverified).toBe(2);
  });

  it("calls the whole chord missed when nothing was heard", () => {
    // Unverified is for what the method cannot see, not a general excuse. Silence is
    // silence, and a chord nobody strummed is three missed notes.
    const report = compareToTimeline(timeline(part(chord)), []);
    expect(report.notes.every((r) => r.judgement === "missed")).toBe(true);
    expect(report.accuracy).toBe(0);
  });

  it("credits every note of a chord the detector did separate", () => {
    // An arpeggiated chord, or a polyphonic detector later: three attacks, three
    // notes, and nothing unverified.
    const report = compareToTimeline(timeline(part(chord)), [
      heard(0, 52),
      heard(0.02, 59),
      heard(0.04, 64),
    ]);
    expect(report.notes.every((r) => r.judgement === "clean")).toBe(true);
    expect(report.unverified).toBe(0);
  });
});

/** The same score with the note on `beat` tied into the one after it. */
function tie(score: Score, beatIndex: number): Score {
  let seen = -1;
  return {
    ...score,
    tracks: score.tracks.map((track) => ({
      ...track,
      bars: track.bars.map((bar) => ({
        ...bar,
        voices: bar.voices.map((voice) => ({
          ...voice,
          beats: voice.beats.map((beat) => {
            if (beat.notes.length === 0) return beat;
            seen += 1;
            if (seen !== beatIndex) return beat;
            return { ...beat, notes: beat.notes.map((n) => ({ ...n, tiedToNext: true })) };
          }),
        })),
      })),
    })),
  };
}

describe("ties", () => {
  it("does not expect a second attack where a note is held", () => {
    // A tie means hold, not play again. Expecting an onset at the continuation
    // reports a missed note on every tie in the piece, and a passage full of tied
    // notes would read as half wrong however well it was played.
    const tied = tie(part([[64], [64], [67], [69]]), 0);
    const report = compareToTimeline(timeline(tied), [
      heard(0, 64),
      heard(2 * BEAT, 67),
      heard(3 * BEAT, 69),
    ]);
    expect(report.notes).toHaveLength(3);
    expect(report.notes.every((r) => r.judgement === "clean")).toBe(true);
    expect(report.accuracy).toBe(1);
  });

  it("takes the tie's whole length as one note", () => {
    const tied = tie(part([[64], [64], [], []]), 0);
    const report = compareToTimeline(timeline(tied), [heard(0, 64)]);
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]?.note.durationSeconds).toBeCloseTo(2 * BEAT, 6);
  });
});

describe("per bar", () => {
  const twoBars = [[64], [66], [67], [69], [71], [72], [74], [76]];

  it("scores each bar on its own notes", () => {
    const line = timeline(part(twoBars));
    // Second bar played, first bar not.
    const report = compareToTimeline(line, perfectly(twoBars).slice(4));
    expect(report.bars).toHaveLength(2);
    expect(report.bars[0]?.accuracy).toBe(0);
    expect(report.bars[0]?.missed).toBe(4);
    expect(report.bars[1]?.accuracy).toBe(1);
    expect(report.bars[1]?.clean).toBe(4);
  });

  it("leaves an empty bar unscored rather than perfect", () => {
    // A heatmap that paints a bar of rests the same green as a bar played cleanly is
    // lying about one of them.
    const empty = [[64], [66], [67], [69], [], [], [], []];
    const report = compareToTimeline(timeline(part(empty)), perfectly(empty));
    expect(report.bars[0]?.accuracy).toBe(1);
    expect(report.bars[1]?.accuracy).toBeNull();
    expect(report.bars[1]?.timingSeconds).toBeNull();
  });

  it("carries each bar's own timing, so one rushed bar is visible", () => {
    const line = timeline(part(twoBars));
    const takes = [...perfectly(twoBars).slice(0, 4), ...perfectly(twoBars, -0.14).slice(4)];
    const report = compareToTimeline(line, takes);
    expect(report.bars[0]?.timingSeconds).toBeCloseTo(0, 6);
    expect(report.bars[1]?.timingSeconds).toBeCloseTo(-0.14, 6);
  });

  it("names the bar by its index in the written score", () => {
    const report = compareToTimeline(timeline(part(twoBars)), perfectly(twoBars));
    expect(report.bars.map((b) => b.bar)).toEqual([0, 1]);
  });
});

describe("narrowing what is judged", () => {
  it("judges one staff when asked", () => {
    // Two guitars playing different notes. A monophonic detector hears one player,
    // so grading it against both staves would call half of every take wrong.
    const line = timeline(part(SCALE, 2));
    const report = compareToTimeline(line, perfectly(SCALE), { trackIndex: 0 });
    expect(report.notes).toHaveLength(4);
    expect(report.accuracy).toBe(1);
  });

  it("judges only the window a player is drilling", () => {
    const twoBars = [[64], [66], [67], [69], [71], [72], [74], [76]];
    const line = timeline(part(twoBars));
    const report = compareToTimeline(line, perfectly(twoBars).slice(4), {
      fromSeconds: 4 * BEAT,
    });
    expect(report.notes).toHaveLength(4);
    expect(report.accuracy).toBe(1);
    expect(report.bars.map((b) => b.bar)).toEqual([1]);
  });

  it("does not call notes outside the window missed", () => {
    const twoBars = [[64], [66], [67], [69], [71], [72], [74], [76]];
    const report = compareToTimeline(timeline(part(twoBars)), perfectly(twoBars).slice(0, 4), {
      toSeconds: 3 * BEAT + 0.01,
    });
    expect(report.notes).toHaveLength(4);
    expect(report.accuracy).toBe(1);
  });
});

describe("nothing to grade", () => {
  it("reports null accuracy rather than zero for an empty score", () => {
    const report = compareToTimeline(timeline(part([[], [], [], []])), []);
    expect(report.accuracy).toBeNull();
    expect(report.timingSeconds).toBeNull();
    expect(report.judged).toBe(0);
  });

  it("reports every note missed when the microphone heard nothing", () => {
    const report = compareToTimeline(timeline(part(SCALE)), []);
    expect(report.accuracy).toBe(0);
    expect(report.timingSeconds).toBeNull();
  });
});

const RATE = 44100;
const FRAME = 1024;

/**
 * A plucked note: harmonics, and a decay, both of which the detector depends on.
 *
 * The decay is not decoration. Onset detection is a rise in energy above the recent
 * past, so notes that did not decay would run into each other and the second attack
 * of a phrase would be invisible — which is exactly how a real instrument differs
 * from a test tone held forever.
 */
function pluck(samples: Float32Array, at: number, hz: number, lengthSeconds: number): void {
  const start = Math.round(at * RATE);
  const length = Math.round(lengthSeconds * RATE);
  const partials = [1, 0.6, 0.35, 0.2];
  for (let i = 0; i < length; i += 1) {
    const index = start + i;
    if (index >= samples.length) break;
    const envelope = 0.6 * Math.exp(-3.2 * (i / RATE));
    let value = 0;
    for (const [h, amplitude] of partials.entries()) {
      value += amplitude * Math.sin((2 * Math.PI * hz * (h + 1) * index) / RATE);
    }
    samples[index] = (samples[index] ?? 0) + (envelope * value) / 2.15;
  }
}

/** Feeds a buffer through a Listener in frames, as an AnalyserNode would. */
function listenTo(samples: Float32Array, options?: ConstructorParameters<typeof Listener>[1]) {
  const listener = new Listener(RATE, options);
  for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
    // The frame's midpoint, as Listener.push recommends: an attack can be anywhere
    // inside the frame, and the midpoint is the estimate with the least bias.
    listener.push(samples.subarray(start, start + FRAME), (start + FRAME / 2) / RATE);
  }
  listener.flush();
  return listener;
}

describe("turning frames into notes", () => {
  it("hears one pluck as one note, at the right pitch and the right moment", () => {
    const samples = new Float32Array(RATE);
    pluck(samples, 0.25, midiToFrequency(64), 0.7);
    const notes = listenTo(samples).notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.midi).toBeCloseTo(64, 1);
    // Frame resolution is 23ms, so the onset lands in the frame the attack began in.
    expect(Math.abs(notes[0]!.atSeconds - 0.25)).toBeLessThan(FRAME / RATE + 0.005);
  });

  it("hears four plucks as four notes", () => {
    const samples = new Float32Array(3 * RATE);
    const pitches = [64, 66, 67, 69];
    for (const [i, midi] of pitches.entries()) {
      pluck(samples, 0.2 + i * 0.6, midiToFrequency(midi), 0.55);
    }
    const notes = listenTo(samples).notes();
    expect(notes).toHaveLength(4);
    expect(notes.map((n) => Math.round(n.midi))).toEqual(pitches);
  });

  it("hears nothing in silence", () => {
    expect(listenTo(new Float32Array(RATE)).notes()).toEqual([]);
  });

  it("drops a percussive noise with no pitch in it", () => {
    // A palm slap, a chair, a string caught on a fret. It has an onset and no note
    // in it, and inventing a pitch for it would put a note in the report that was
    // never played on any string.
    const samples = new Float32Array(RATE);
    let seed = 999;
    for (let i = 0; i < RATE * 0.08; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      samples[Math.round(0.3 * RATE) + i] = ((seed / 0x7fffffff) * 2 - 1) * 0.5;
    }
    expect(listenTo(samples).notes()).toEqual([]);
  });

  it("takes the pitch from a settled frame, not from the attack transient", () => {
    // The attack of a pluck is a broadband click, and reading the onset frame gives a
    // confident answer to the wrong question. Here the first 20ms are noise and the
    // note follows, which is what a real pluck looks like.
    const samples = new Float32Array(RATE);
    const start = Math.round(0.2 * RATE);
    let seed = 4242;
    for (let i = 0; i < RATE * 0.022; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      samples[start + i] = ((seed / 0x7fffffff) * 2 - 1) * 0.55;
    }
    pluck(samples, 0.2, midiToFrequency(67), 0.6);
    const notes = listenTo(samples).notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.midi).toBeCloseTo(67, 1);
  });

  it("offers the current frame's pitch for a live display", () => {
    // The most recent frame, not the take: this is what a tuner reads, and it has to
    // still be the note while the string is ringing.
    const samples = new Float32Array(RATE);
    pluck(samples, 0.1, midiToFrequency(59), 1);
    expect(listenTo(samples).current?.midi).toBeCloseTo(59, 1);
  });

  it("reports no current pitch once the string has stopped", () => {
    const samples = new Float32Array(RATE);
    pluck(samples, 0.1, midiToFrequency(59), 0.3);
    expect(listenTo(samples).current).toBeNull();
  });

  it("forgets the take on reset", () => {
    const samples = new Float32Array(RATE);
    pluck(samples, 0.2, midiToFrequency(64), 0.6);
    const listener = listenTo(samples);
    expect(listener.notes()).toHaveLength(1);
    listener.reset();
    expect(listener.notes()).toEqual([]);
    expect(listener.current).toBeNull();
  });
});

describe("a take, end to end", () => {
  it("grades synthesized audio against the score it was synthesized from", () => {
    // The test that proves the pieces fit: a score, audio for it, and the report. No
    // hand-written heard notes anywhere — the pitches and moments come out of the
    // same timeline the grader reads, through the detector, and back.
    const beats = [[64], [66], [67], [69], [71], [72], [74], [76]];
    const score = part(beats);
    const line = timeline(score);
    const samples = new Float32Array(Math.ceil((line.durationSeconds + 0.5) * RATE));
    for (const note of line.notes) {
      pluck(samples, note.startSeconds, midiToFrequency(note.pitch), note.durationSeconds * 0.95);
    }

    const report = compareToTimeline(line, listenTo(samples).notes(), { onTimeSeconds: 0.05 });
    expect(report.judged).toBe(8);
    expect(report.accuracy).toBe(1);
    expect(report.extra).toEqual([]);
    // Timing resolution is the frame length: an attack is placed at the timestamp of
    // the frame it was found in, so a perfectly played take reads as up to one frame
    // either side of the beat and no further. That bound is what makes the number
    // worth showing — 23ms of quantisation against a 70ms window leaves room to tell
    // rushing from playing in time.
    expect(Math.abs(report.timingSeconds!)).toBeLessThan(FRAME / RATE);
    expect(report.bars.every((b) => b.accuracy === 1)).toBe(true);
  });

  it("finds the one bar the player got wrong", () => {
    // A wrong note in bar two, everything else right. This is the report's actual
    // job: not a score out of ten, but which bar to go back to.
    const beats = [[64], [66], [67], [69], [71], [72], [74], [76]];
    const line = timeline(part(beats));
    const samples = new Float32Array(Math.ceil((line.durationSeconds + 0.5) * RATE));
    for (const note of line.notes) {
      const played = note.startSeconds >= 4 * BEAT && note.pitch === 74 ? 73 : note.pitch;
      pluck(samples, note.startSeconds, midiToFrequency(played), note.durationSeconds * 0.95);
    }

    const report = compareToTimeline(line, listenTo(samples).notes());
    expect(report.bars[0]?.accuracy).toBe(1);
    expect(report.bars[1]?.wrongPitch).toBe(1);
    expect(report.bars[1]?.accuracy).toBeCloseTo(0.75, 6);
    const wrong = report.notes.find((r) => r.judgement === "wrongPitch");
    expect(Math.round(wrong!.heardMidi!)).toBe(73);
  });
});
