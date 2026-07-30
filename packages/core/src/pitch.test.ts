/**
 * Hearing a note.
 *
 * A pitch detector is the rare piece of a notation app that can be tested exactly:
 * a synthesized waveform has a frequency we chose, so "did it hear the note" has a
 * right answer to a fraction of a cent. That is why the algorithm lives in core and
 * takes a Float32Array — none of what follows needs a browser, a microphone or a
 * permission prompt, and all of it would be guesswork through one.
 *
 * Two tests here are load-bearing rather than illustrative. The octave-error one is
 * why the implementation is YIN and not plain autocorrelation. The silence and noise
 * ones are why it returns null: a detector that always answers turns the gaps
 * between notes into notes the user never played.
 */
import { describe, expect, it } from "vitest";
import {
  centsBetween,
  detectPitch,
  frequencyToMidi,
  midiToFrequency,
  OnsetDetector,
  rmsOf,
} from "./pitch.js";

const RATE = 44100;
/** Long enough that the lowest pitch we claim to hear fits twice. */
const FRAME = 2048;

/**
 * A tone at `hz` built from harmonics, each given a relative amplitude.
 *
 * Harmonics rather than a bare sine because a bare sine is the one signal every
 * pitch detector gets right. A plucked string is a stack of partials, and its
 * second is often louder than its first, which is the case that separates a method
 * that works on guitar from one that does not.
 */
function tone(hz: number, amplitudes: number[] = [1], length = FRAME, gain = 0.5): Float32Array {
  const frame = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sample = 0;
    for (const [h, amplitude] of amplitudes.entries()) {
      sample += amplitude * Math.sin((2 * Math.PI * hz * (h + 1) * i) / RATE);
    }
    // Normalised by the partial count so a rich tone is not louder, only richer.
    const total = amplitudes.reduce((a, b) => a + Math.abs(b), 0) || 1;
    frame[i] = (gain * sample) / total;
  }
  return frame;
}

/** Deterministic pseudo-noise, so a failure is reproducible. */
function noise(length = FRAME, gain = 0.3): Float32Array {
  const frame = new Float32Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    frame[i] = ((seed / 0x7fffffff) * 2 - 1) * gain;
  }
  return frame;
}

/** How far a reading is from the truth, in cents. */
function errorCents(reading: number, expected: number): number {
  return Math.abs(centsBetween(frequencyToMidi(reading), frequencyToMidi(expected)));
}

describe("pitch and MIDI", () => {
  it("puts A440 at 69", () => {
    expect(frequencyToMidi(440)).toBeCloseTo(69, 10);
    expect(midiToFrequency(69)).toBeCloseTo(440, 10);
  });

  it("round-trips every note a guitar can play", () => {
    for (let midi = 40; midi <= 88; midi += 1) {
      expect(frequencyToMidi(midiToFrequency(midi))).toBeCloseTo(midi, 8);
    }
  });

  it("measures a semitone as a hundred cents", () => {
    expect(centsBetween(frequencyToMidi(midiToFrequency(61)), 60)).toBeCloseTo(100, 6);
  });

  it("signs cents so sharp is positive", () => {
    expect(centsBetween(60.25, 60)).toBeCloseTo(25, 6);
    expect(centsBetween(60, 60.25)).toBeCloseTo(-25, 6);
  });
});

describe("loudness", () => {
  it("is zero for silence and for an empty frame", () => {
    expect(rmsOf(new Float32Array(512))).toBe(0);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });

  it("is the amplitude over root two for a sine", () => {
    expect(rmsOf(tone(220, [1], FRAME, 1))).toBeCloseTo(1 / Math.SQRT2, 2);
  });
});

describe("hearing a single note", () => {
  // Every open string of a guitar in standard tuning, which is the set a user is
  // most likely to play at this thing first.
  const strings: Array<[string, number]> = [
    ["low E", 82.41],
    ["A", 110.0],
    ["D", 146.83],
    ["G", 196.0],
    ["B", 246.94],
    ["high E", 329.63],
  ];

  for (const [name, hz] of strings) {
    it(`hears the open ${name} string within five cents`, () => {
      const reading = detectPitch(tone(hz, [1, 0.5, 0.25]), RATE);
      expect(reading).not.toBeNull();
      expect(errorCents(reading!.frequency, hz)).toBeLessThan(5);
    });
  }

  it("hears a note high on the neck", () => {
    // Fret 15 of the high E string, where one sample of period is most of a
    // semitone and the parabolic interpolation is doing all the work.
    const hz = midiToFrequency(79);
    const reading = detectPitch(tone(hz, [1, 0.4]), RATE);
    expect(reading).not.toBeNull();
    expect(errorCents(reading!.frequency, hz)).toBeLessThan(10);
  });

  it("reports a fractional MIDI note, so being out of tune survives", () => {
    // A quarter tone flat of A2: the reading has to keep the 25 cents, because
    // rounding to the nearest note is exactly what a tuner must not do.
    const flat = midiToFrequency(45 - 0.25);
    const reading = detectPitch(tone(flat, [1, 0.5]), RATE);
    expect(reading).not.toBeNull();
    expect(reading!.midi).toBeGreaterThan(44.6);
    expect(reading!.midi).toBeLessThan(44.9);
  });

  it("is confident about a clean note", () => {
    const reading = detectPitch(tone(196, [1, 0.5, 0.3]), RATE);
    expect(reading!.clarity).toBeGreaterThan(0.8);
  });

  it("reports how loud the note was", () => {
    const quiet = detectPitch(tone(196, [1], FRAME, 0.1), RATE);
    const loud = detectPitch(tone(196, [1], FRAME, 0.8), RATE);
    expect(quiet!.rms).toBeLessThan(loud!.rms);
    expect(loud!.rms).toBeCloseTo(0.8 / Math.SQRT2, 2);
  });
});

describe("the octave error", () => {
  it("hears the fundamental when the second harmonic is louder", () => {
    // The case the whole method exists for. A plucked string's second partial is
    // frequently stronger than its first, and plain autocorrelation answers with
    // the octave above about as often as with the note. Replacing the cumulative
    // mean normalization in detectPitch with a plain minimum search makes this
    // test report 220Hz for a 110Hz string.
    const reading = detectPitch(tone(110, [0.4, 1, 0.6]), RATE);
    expect(reading).not.toBeNull();
    expect(errorCents(reading!.frequency, 110)).toBeLessThan(10);
  });

  it("hears the fundamental when the third harmonic dominates too", () => {
    const reading = detectPitch(tone(146.83, [0.3, 0.8, 1, 0.5]), RATE);
    expect(reading).not.toBeNull();
    expect(errorCents(reading!.frequency, 146.83)).toBeLessThan(10);
  });

  it("does not answer with the octave below either", () => {
    // The mirror failure: a detector biased towards long periods finds a
    // sub-harmonic that is not there.
    const reading = detectPitch(tone(220, [1, 0.5, 0.25]), RATE);
    expect(errorCents(reading!.frequency, 220)).toBeLessThan(5);
  });
});

describe("refusing to guess", () => {
  it("returns null for silence", () => {
    expect(detectPitch(new Float32Array(FRAME), RATE)).toBeNull();
  });

  it("returns null for a note too quiet to be a note", () => {
    // Room tone at the level of a fan. A pitch read off this is invented, and a
    // practice report built on invented pitches tells the user they played notes
    // they did not.
    expect(detectPitch(tone(196, [1], FRAME, 0.005), RATE)).toBeNull();
  });

  it("returns null for noise", () => {
    expect(detectPitch(noise(), RATE)).toBeNull();
  });

  it("returns null for a frame too short to hold the period it is asked for", () => {
    expect(detectPitch(tone(82.41, [1], 128), RATE)).toBeNull();
  });

  it("returns null for a pitch above the range it claims", () => {
    // A cymbal, a squeal, a bad cable. Answering 4kHz as if it were a fretted note
    // would place a note on a string that cannot produce it.
    expect(detectPitch(tone(4000, [1]), RATE)).toBeNull();
  });

  it("honours a narrowed range", () => {
    // A caller who knows the part is on a bass can say so, and a stray high note
    // is then not a note.
    expect(detectPitch(tone(400, [1]), RATE, { maxHz: 250 })).toBeNull();
    expect(detectPitch(tone(100, [1]), RATE, { maxHz: 250 })).not.toBeNull();
  });

  it("still hears a note that has decayed but not died", () => {
    // A string a second after the pluck is quiet and no longer perfectly periodic.
    // Refusing it would report the note as absent halfway through, which is worse
    // than a slightly less confident reading.
    const decayed = tone(110, [1, 0.6, 0.3], FRAME, 0.06);
    const reading = detectPitch(decayed, RATE);
    expect(reading).not.toBeNull();
    expect(errorCents(reading!.frequency, 110)).toBeLessThan(15);
  });
});

describe("when a note starts", () => {
  /** Feeds a sequence of loudnesses and reports the frames that were onsets. */
  function onsetsIn(levels: number[], options?: ConstructorParameters<typeof OnsetDetector>[0]) {
    const detector = new OnsetDetector(options);
    return levels.flatMap((level, i) => (detector.push(level) ? [i] : []));
  }

  it("hears the first note of a take", () => {
    // No history to compare against, so a strict "louder than before" rule would
    // miss it. Missing the first note of every recording is not a subtle bug.
    expect(onsetsIn([0.4, 0.3, 0.25])[0]).toBe(0);
  });

  it("does not hear a held note as a stream of new ones", () => {
    const levels = [0.5, ...Array.from({ length: 20 }, (_, i) => 0.5 * 0.94 ** i)];
    expect(onsetsIn(levels)).toEqual([0]);
  });

  it("hears a second pluck after the first has decayed", () => {
    const decay = (from: number, n: number) => Array.from({ length: n }, (_, i) => from * 0.8 ** i);
    const onsets = onsetsIn([...decay(0.5, 10), ...decay(0.5, 10)]);
    expect(onsets).toEqual([0, 10]);
  });

  it("counts one strum as one note, not five", () => {
    // A pluck's attack spans a frame or two as the energy builds, then decays. Each
    // of those rising frames is louder than the average of what came before, so each
    // is an onset by the ratio rule alone, and a single strum arrives as a flurry.
    const attack = [0.02, 0.2, 0.6, 0.5, 0.4, 0.3, 0.22, 0.16, 0.12];
    expect(onsetsIn(attack)).toHaveLength(1);
    // And the holdoff is what does that, rather than the fixture happening to be
    // gentle: with no holdoff the same attack fragments.
    expect(onsetsIn(attack, { holdoff: 0 }).length).toBeGreaterThan(1);
  });

  it("does not hear silence becoming quiet as a note", () => {
    // A ratio test alone fires here: room tone is infinitely louder than nothing.
    expect(onsetsIn([0, 0, 0, 0.004, 0.005, 0.004])).toEqual([]);
  });

  it("takes a stricter rise when told to", () => {
    const levels = [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.12];
    expect(onsetsIn(levels, { rise: 1.5 })).toContain(8);
    expect(onsetsIn(levels, { rise: 4 })).not.toContain(8);
  });

  it("forgets everything on reset, so the next take starts clean", () => {
    const detector = new OnsetDetector();
    for (const level of [0.5, 0.4, 0.35, 0.3]) detector.push(level);
    detector.reset();
    // Same loudness as the note already ringing, and now an onset again, because
    // as far as the detector is concerned this is the first sound it has heard.
    expect(detector.push(0.3)).toBe(true);
  });
});
