/**
 * Hearing a note: pitch and onset from raw audio.
 *
 * The half of "did I play that right" that CubScore did not have. The expected side
 * has been there since `timeline()` — which note should sound at which second — and
 * this is what turns a microphone into the other side of that comparison.
 *
 * Deliberately here rather than in the web app, and deliberately taking a plain
 * Float32Array rather than a Web Audio node. A pitch detector is a numerical
 * algorithm, and a numerical algorithm tested through a browser is tested badly: the
 * tests that matter feed it a synthesized waveform at a known frequency and check
 * the answer, and those need no DOM, no microphone and no permission prompt.
 *
 * The method is YIN's cumulative mean normalized difference function. Plain
 * autocorrelation is the obvious choice and it is wrong for guitar: the second
 * harmonic of a plucked string is often stronger than the fundamental, so
 * autocorrelation reports the octave above about as often as the note. The
 * normalization is precisely what suppresses that, and the octave-error test below
 * is the one that fails without it.
 */

/** What a guitar can produce, generously: below a dropped low E, above fret 24. */
const MIN_HZ = 65;
const MAX_HZ = 1400;

/**
 * How close to a perfect period match counts as finding the pitch.
 *
 * YIN's threshold. Lower is stricter and rejects more; 0.15 is the value the paper
 * suggests and it holds up on plucked strings, where the waveform is periodic but
 * decaying and so never matches itself exactly.
 */
const DEFAULT_THRESHOLD = 0.15;

/** Below this the frame is silence or noise, and a pitch read from it is invented. */
const DEFAULT_MIN_RMS = 0.01;

export interface PitchReading {
  frequency: number;
  /** Fractional MIDI note, so "seven cents flat" survives. */
  midi: number;
  /**
   * How periodic the frame was, 0 to 1, where 1 is a perfect match.
   *
   * Worth surfacing rather than hiding: a clarity of 0.5 on a guitar usually means
   * two notes are sounding, and a caller deciding whether to trust a reading needs
   * to know the difference between a clear note and a guess.
   */
  clarity: number;
  rms: number;
}

export interface PitchOptions {
  minHz?: number;
  maxHz?: number;
  threshold?: number;
  minRms?: number;
}

/** MIDI note number for a frequency, fractional. A440 is 69. */
export function frequencyToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** Frequency of a MIDI note number, fractional accepted. */
export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** How far apart two pitches are, in cents. Signed: positive means `a` is higher. */
export function centsBetween(a: number, b: number): number {
  return (a - b) * 100;
}

export function rmsOf(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

/**
 * The pitch of one frame, or null when there is not one to find.
 *
 * Null rather than a guess is the important part. A detector that always answers
 * turns silence between notes into a stream of spurious pitches, and a practice
 * report built on those tells the user they played notes they did not.
 */
export function detectPitch(
  frame: Float32Array,
  sampleRate: number,
  options: PitchOptions = {},
): PitchReading | null {
  const minHz = options.minHz ?? MIN_HZ;
  const maxHz = options.maxHz ?? MAX_HZ;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minRms = options.minRms ?? DEFAULT_MIN_RMS;

  const rms = rmsOf(frame);
  if (rms < minRms) return null;

  // The search runs from the shortest period upwards, *not* from the period of
  // maxHz, and the range is applied to the answer instead. Starting the search at
  // maxHz's period looks like a free optimisation and it is a bug: a 4kHz squeal
  // then matches itself at three periods, which lands inside the guitar's range, and
  // a cymbal becomes a note at fret 21. Finding the true fundamental first and
  // rejecting it for being out of range is the difference between "I did not hear a
  // note" and a note the user never played.
  const shortest = 2;
  const maxTau = Math.min(Math.floor(frame.length / 2), Math.ceil(sampleRate / minHz));
  if (maxTau <= shortest) return null;

  // Squared difference between the frame and itself shifted by tau. A period shows
  // up as a minimum.
  const diff = new Float32Array(maxTau + 1);
  for (let tau = shortest; tau <= maxTau; tau += 1) {
    let sum = 0;
    const limit = frame.length - tau;
    for (let i = 0; i < limit; i += 1) {
      const delta = frame[i]! - frame[i + tau]!;
      sum += delta * delta;
    }
    // Normalised by the number of terms, so a long tau is not penalised for
    // having fewer of them.
    diff[tau] = limit > 0 ? sum / limit : Number.POSITIVE_INFINITY;
  }

  // The cumulative mean normalization. This is what makes the difference between
  // finding the note and finding its octave: a shift of two periods also matches
  // well, and dividing by the running mean makes the *first* good match win.
  const normalized = new Float32Array(maxTau + 1);
  let runningSum = 0;
  for (let tau = shortest; tau <= maxTau; tau += 1) {
    runningSum += diff[tau]!;
    normalized[tau] = runningSum > 0 ? (diff[tau]! * (tau - shortest + 1)) / runningSum : 1;
  }

  // The first dip below the threshold, taken to its local minimum. Falling back to
  // the global minimum rather than giving up: a decaying string never matches
  // itself perfectly, and refusing every frame of a dying note would report the
  // note as absent halfway through.
  let best = -1;
  for (let tau = shortest; tau <= maxTau; tau += 1) {
    if (normalized[tau]! < threshold) {
      let at = tau;
      while (at + 1 <= maxTau && normalized[at + 1]! < normalized[at]!) at += 1;
      best = at;
      break;
    }
  }
  if (best < 0) {
    let lowest = Number.POSITIVE_INFINITY;
    for (let tau = shortest; tau <= maxTau; tau += 1) {
      if (normalized[tau]! < lowest) {
        lowest = normalized[tau]!;
        best = tau;
      }
    }
    // Nothing remotely periodic: noise, a chord's beating, a palm-muted thud.
    if (best < 0 || lowest > 0.6) return null;
  }

  // Parabolic interpolation around the minimum, which is what gets this from
  // "roughly the right semitone" to a few cents. Without it the answer is quantised
  // to whole samples, and at 1000Hz one sample is most of a semitone.
  const left = diff[best - 1] ?? diff[best]!;
  const here = diff[best]!;
  const right = diff[best + 1] ?? here;
  const denominator = 2 * (2 * here - left - right);
  const shift = denominator !== 0 ? (right - left) / denominator : 0;
  const period = best + (Number.isFinite(shift) ? Math.max(-1, Math.min(1, shift)) : 0);

  const frequency = sampleRate / period;
  if (frequency < minHz || frequency > maxHz) return null;

  return {
    frequency,
    midi: frequencyToMidi(frequency),
    clarity: Math.max(0, Math.min(1, 1 - (normalized[best] ?? 1))),
    rms,
  };
}

/**
 * When a note starts.
 *
 * Pitch alone does not say that: a held note reads the same on every frame, and a
 * practice report needs to know whether the user played one note or eight. An onset
 * is a rise in energy above what the recent past would predict, which is the
 * standard formulation and the one that survives a guitar's decay — a plucked
 * string is loudest at the start and quieter thereafter, so "louder than before" is
 * exactly the right signal.
 *
 * Stateful and therefore a class, but a plain one taking numbers, so it is tested
 * by pushing a sequence rather than by playing audio.
 */
export class OnsetDetector {
  private history: number[] = [];
  private sinceOnset = Number.POSITIVE_INFINITY;

  constructor(
    private readonly options: {
      /** How many frames of history the average is taken over. */
      window?: number;
      /** How much louder than the recent average counts as an attack. */
      rise?: number;
      /** Below this, no onset however large the ratio: silence to quiet is not a note. */
      floor?: number;
      /**
       * Frames that must pass before another onset is allowed.
       *
       * A pluck's attack spans several frames, and without this each one is reported
       * as its own note — one strum becomes five.
       */
      holdoff?: number;
    } = {},
  ) {}

  /** Feeds one frame's loudness. Returns true when a note started. */
  push(rms: number): boolean {
    const window = this.options.window ?? 8;
    const rise = this.options.rise ?? 2.2;
    const floor = this.options.floor ?? 0.015;
    const holdoff = this.options.holdoff ?? 4;

    this.sinceOnset += 1;
    const average =
      this.history.length > 0 ? this.history.reduce((a, b) => a + b, 0) / this.history.length : 0;

    this.history.push(rms);
    if (this.history.length > window) this.history.shift();

    if (rms < floor) return false;
    if (this.sinceOnset < holdoff) return false;
    // A first sound with no history to compare against is an onset: the alternative
    // is missing the first note of every take.
    const started = average === 0 ? true : rms > average * rise;
    if (started) this.sinceOnset = 0;
    return started;
  }

  reset(): void {
    this.history = [];
    this.sinceOnset = Number.POSITIVE_INFINITY;
  }
}
