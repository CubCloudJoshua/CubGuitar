/**
 * Did I play that right?
 *
 * `timeline()` says which note should sound at which second. `pitch.ts` says which
 * note did. This is the comparison, and it is the whole point of having both: a
 * practice report that names the bars you actually miss, rather than a metronome and
 * your own memory of how it went.
 *
 * Two decisions shape everything here, and both are refusals.
 *
 * The first is that a note the pass could not judge is reported as *unverified*, not
 * as missed. A single-pitch detector hears a strummed chord as one note, because that
 * is what monophonic detection means. Scoring the other five as missed would tell a
 * guitarist they failed to play notes they played, which is worse than saying nothing
 * — a report you have to argue with is a report you stop reading. So a note in a
 * chord whose neighbours were heard is unverified, it stays out of the accuracy
 * denominator, and the count is surfaced so the UI can say what it did not check.
 *
 * The second is that "wrong note" and "no note" are different findings. A player who
 * fretted the wrong string needs to see that; a player who dropped the note needs to
 * see something else. Collapsing both into "error" throws away the only part of the
 * report that tells you what to fix.
 */
import { mergeTies, type Timeline, type TimedNote } from "./timeline.js";
import {
  centsBetween,
  detectPitch,
  OnsetDetector,
  rmsOf,
  type PitchOptions,
  type PitchReading,
} from "./pitch.js";

/** One note the microphone heard: when it started and what pitch it settled on. */
export interface HeardNote {
  atSeconds: number;
  /** Fractional MIDI, so twenty cents flat is twenty cents flat. */
  midi: number;
  /** How periodic the frame was; low means two notes were sounding, or none. */
  clarity: number;
  rms: number;
}

export type Judgement =
  /** The written note, at the written time. */
  | "clean"
  /** The written note, ahead of the beat by more than the tolerance. */
  | "early"
  /** The written note, behind the beat. */
  | "late"
  /** Something was played here, and it was not this note. */
  | "wrongPitch"
  /** Nothing was played here. */
  | "missed"
  /** This pass could not tell. Kept out of the score rather than guessed at. */
  | "unverified";

export interface NoteResult {
  note: TimedNote;
  judgement: Judgement;
  /** Seconds the attack was off by. Negative is ahead of the beat. */
  offsetSeconds?: number;
  /** Cents off the written pitch. Negative is flat. */
  cents?: number;
  /** What was heard instead, for a wrong note: the UI can name it. */
  heardMidi?: number;
}

export interface BarResult {
  bar: number;
  startSeconds: number;
  endSeconds: number;
  clean: number;
  early: number;
  late: number;
  wrongPitch: number;
  missed: number;
  unverified: number;
  /**
   * Share of the bar's judgeable notes that were played, 0 to 1, or null when the
   * bar had nothing to judge.
   *
   * Null rather than 1, because an empty bar and a perfect bar are not the same
   * thing and a heatmap that paints them the same is lying about one of them.
   */
  accuracy: number | null;
  /** Mean signed timing over the bar. Negative means rushing. */
  timingSeconds: number | null;
}

export interface ListenReport {
  notes: NoteResult[];
  bars: BarResult[];
  /** Heard notes that answer to nothing written: fumbles, string noise, extra notes. */
  extra: HeardNote[];
  /** Over every judgeable note in the pass. Null when none were judgeable. */
  accuracy: number | null;
  /**
   * Mean signed timing error over the notes that were played, in seconds.
   *
   * The single most useful number in the report, and the one a metronome cannot
   * give: it says whether you rush or drag, which is a different problem from
   * playing wrong notes and has a different fix.
   */
  timingSeconds: number | null;
  /** Notes that entered the score, and notes that could not be checked. */
  judged: number;
  unverified: number;
}

export interface CompareOptions {
  /** Judge one staff. Omitted means every note in the timeline, which for a
   * monophonic detector is only sensible on a single-track score. */
  trackIndex?: number;
  /** How far from the written moment a heard note can be and still be that note. */
  toleranceSeconds?: number;
  /** Inside this, the note is on time rather than early or late. */
  onTimeSeconds?: number;
  /** Beyond this many cents, it is a different note rather than an out-of-tune one. */
  centsTolerance?: number;
  /** Judge only part of the piece, for a loop the user is drilling. */
  fromSeconds?: number;
  toSeconds?: number;
}

/**
 * A quarter of a second either side, which sounds generous and is not.
 *
 * At 120bpm an eighth note is 250ms, so a wider window would let a heard note match
 * the note *after* the one it belongs to and report a clean pass over a scale played
 * in the wrong order. Narrower and an ordinary human 80ms behind the beat starts
 * reading as a missed note.
 */
const DEFAULT_TOLERANCE = 0.25;
/** Inside 70ms nobody hears you as early or late, including you. */
const DEFAULT_ON_TIME = 0.07;
/** Half a semitone: past this it is the neighbouring note, not this one bent. */
const DEFAULT_CENTS = 50;

/**
 * Compares what was heard against what was written.
 *
 * Matching is greedy by closeness rather than in order, and each heard note is
 * consumed by at most one written note. Doing it in order looks simpler and breaks on
 * the case that matters: one missed note early in a bar would shift every later match
 * by one and report the whole bar as wrong.
 */
export function compareToTimeline(
  line: Timeline,
  heard: readonly HeardNote[],
  options: CompareOptions = {},
): ListenReport {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE;
  const onTime = options.onTimeSeconds ?? DEFAULT_ON_TIME;
  const centsTolerance = options.centsTolerance ?? DEFAULT_CENTS;
  const from = options.fromSeconds ?? -Infinity;
  const to = options.toSeconds ?? Infinity;

  // Ties merged first: a tie is a held note, not a second attack, so expecting an
  // onset at its continuation would report a missed note on every tie in the piece.
  const expected = mergeTies(line.notes)
    .filter((n) => options.trackIndex === undefined || n.trackIndex === options.trackIndex)
    .filter((n) => n.startSeconds >= from && n.startSeconds <= to)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);

  const candidates = heard
    .filter((h) => h.atSeconds >= from - tolerance && h.atSeconds <= to + tolerance)
    .sort((a, b) => a.atSeconds - b.atSeconds);

  /** Which heard note each written note took, by index into `expected`. */
  const matched = new Map<number, HeardNote>();
  const taken = new Set<HeardNote>();

  /**
   * Every (written, heard) pair that could be the same note, cheapest first.
   *
   * Cost is time distance, with pitch distance as a tie-break, so when two written
   * notes are equally close the heard note goes to the one it is actually in tune
   * with. Pairs are considered globally rather than per note: a locally greedy walk
   * gives an early note a match that a later note needed more.
   */
  interface Pair {
    at: number;
    heard: HeardNote;
    distance: number;
    cents: number;
  }
  const pairs: Pair[] = [];
  for (const [at, note] of expected.entries()) {
    for (const h of candidates) {
      const distance = Math.abs(h.atSeconds - note.startSeconds);
      if (distance > tolerance) continue;
      const cents = centsBetween(h.midi, note.pitch);
      if (Math.abs(cents) > centsTolerance) continue;
      pairs.push({ at, heard: h, distance, cents });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance || Math.abs(a.cents) - Math.abs(b.cents));
  for (const pair of pairs) {
    if (matched.has(pair.at) || taken.has(pair.heard)) continue;
    matched.set(pair.at, pair.heard);
    taken.add(pair.heard);
  }

  // A second pass for wrong notes: a heard note near an unmatched written note, at
  // any pitch. Only after every right note has found its home, so a correct note is
  // never spent proving a neighbour wrong.
  const wrong = new Map<number, HeardNote>();
  const wrongPairs: Pair[] = [];
  for (const [at, note] of expected.entries()) {
    if (matched.has(at)) continue;
    for (const h of candidates) {
      if (taken.has(h)) continue;
      const distance = Math.abs(h.atSeconds - note.startSeconds);
      if (distance > tolerance) continue;
      wrongPairs.push({ at, heard: h, distance, cents: centsBetween(h.midi, note.pitch) });
    }
  }
  wrongPairs.sort((a, b) => a.distance - b.distance);
  for (const pair of wrongPairs) {
    if (matched.has(pair.at) || wrong.has(pair.at) || taken.has(pair.heard)) continue;
    wrong.set(pair.at, pair.heard);
    taken.add(pair.heard);
  }

  /**
   * Notes sounding at the same tick, which a monophonic detector cannot separate.
   *
   * Keyed by tick and track, since two voices attacking together are as
   * indistinguishable as two notes of a chord.
   */
  const groupSize = new Map<string, number>();
  const groupHeard = new Map<string, number>();
  const keyOf = (n: TimedNote) => `${n.trackIndex}:${n.startTicks}`;
  for (const note of expected) {
    const key = keyOf(note);
    groupSize.set(key, (groupSize.get(key) ?? 0) + 1);
  }
  for (const [at] of matched) {
    const note = expected[at];
    if (!note) continue;
    const key = keyOf(note);
    groupHeard.set(key, (groupHeard.get(key) ?? 0) + 1);
  }

  const notes: NoteResult[] = expected.map((note, at) => {
    const hit = matched.get(at);
    if (hit) {
      const offsetSeconds = hit.atSeconds - note.startSeconds;
      const judgement: Judgement =
        Math.abs(offsetSeconds) <= onTime ? "clean" : offsetSeconds < 0 ? "early" : "late";
      return {
        note,
        judgement,
        offsetSeconds,
        cents: centsBetween(hit.midi, note.pitch),
        heardMidi: hit.midi,
      };
    }
    const key = keyOf(note);
    // The refusal: part of a chord, and the chord was heard. One detected pitch
    // cannot speak for the notes beside it.
    if ((groupSize.get(key) ?? 0) > 1 && (groupHeard.get(key) ?? 0) > 0) {
      return { note, judgement: "unverified" };
    }
    const other = wrong.get(at);
    if (other) {
      return {
        note,
        judgement: "wrongPitch",
        offsetSeconds: other.atSeconds - note.startSeconds,
        cents: centsBetween(other.midi, note.pitch),
        heardMidi: other.midi,
      };
    }
    return { note, judgement: "missed" };
  });

  const played = (j: Judgement) => j === "clean" || j === "early" || j === "late";
  const bars: BarResult[] = line.bars
    .filter((span) => span.endSeconds > from && span.startSeconds <= to)
    .map((span) => {
      const inBar = notes.filter(
        (r) => r.note.startSeconds >= span.startSeconds && r.note.startSeconds < span.endSeconds,
      );
      const count = (j: Judgement) => inBar.filter((r) => r.judgement === j).length;
      const judgeable = inBar.filter((r) => r.judgement !== "unverified");
      const offsets = inBar.flatMap((r) => (played(r.judgement) ? [r.offsetSeconds ?? 0] : []));
      return {
        bar: span.bar,
        startSeconds: span.startSeconds,
        endSeconds: span.endSeconds,
        clean: count("clean"),
        early: count("early"),
        late: count("late"),
        wrongPitch: count("wrongPitch"),
        missed: count("missed"),
        unverified: count("unverified"),
        accuracy:
          judgeable.length === 0
            ? null
            : judgeable.filter((r) => played(r.judgement)).length / judgeable.length,
        timingSeconds:
          offsets.length === 0 ? null : offsets.reduce((a, b) => a + b, 0) / offsets.length,
      };
    });

  const judgeable = notes.filter((r) => r.judgement !== "unverified");
  const offsets = notes.flatMap((r) => (played(r.judgement) ? [r.offsetSeconds ?? 0] : []));
  return {
    notes,
    bars,
    extra: candidates.filter((h) => !taken.has(h)),
    accuracy:
      judgeable.length === 0
        ? null
        : judgeable.filter((r) => played(r.judgement)).length / judgeable.length,
    timingSeconds: offsets.length === 0 ? null : offsets.reduce((a, b) => a + b, 0) / offsets.length,
    judged: judgeable.length,
    unverified: notes.length - judgeable.length,
  };
}

export interface ListenerOptions extends PitchOptions {
  /** Passed to the onset detector; see pitch.ts. */
  onset?: ConstructorParameters<typeof OnsetDetector>[0];
  /**
   * Frames after an attack to spend deciding what pitch it was.
   *
   * The attack frame itself is the worst one to read: a pluck starts as a broadband
   * click and only settles into a pitch a few milliseconds later. Reading the onset
   * frame gives a confident answer to the wrong question, so the note keeps its
   * onset *time* and takes its pitch from the clearest frame in this window.
   */
  settleFrames?: number;
}

const DEFAULT_SETTLE = 4;

/**
 * A microphone's worth of frames, turned into notes.
 *
 * Stateful, because onsets are. Takes frames and a timestamp rather than an audio
 * node, for the same reason `detectPitch` takes a Float32Array: this is the piece
 * that has to be right, and it is testable to the frame without a browser. The web
 * app's job is to hand it `AnalyserNode` output and nothing more.
 */
export class Listener {
  private readonly onset: OnsetDetector;
  private readonly settled: HeardNote[] = [];
  /** The note being decided: its onset time, and the best reading seen so far. */
  private pending: { atSeconds: number; best: PitchReading | null; frames: number } | null = null;
  private last: PitchReading | null = null;

  constructor(
    private readonly sampleRate: number,
    private readonly options: ListenerOptions = {},
  ) {
    this.onset = new OnsetDetector(options.onset ?? {});
  }

  /**
   * Feeds one frame of audio.
   *
   * `atSeconds` is the moment the caller wants an attack in this frame reported at,
   * and the timing half of the report is only as precise as that choice. An attack
   * can fall anywhere inside a frame, so passing the frame's start biases every note
   * early by up to a frame and passing its midpoint halves the error in both
   * directions. The midpoint is what a caller should pass unless it has something
   * better.
   */
  push(frame: Float32Array, atSeconds: number): void {
    const settle = this.options.settleFrames ?? DEFAULT_SETTLE;
    const started = this.onset.push(rmsOf(frame));
    const reading = detectPitch(frame, this.sampleRate, this.options);
    this.last = reading;

    if (started) {
      // A new attack closes the previous note's window, however short it was: two
      // plucks in quick succession are two notes, and holding the first one open
      // would let the second one's pitch overwrite it.
      this.close();
      this.pending = { atSeconds, best: reading, frames: 1 };
      return;
    }
    if (!this.pending) return;
    this.pending.frames += 1;
    // The clearest frame wins. Clarity is exactly the right criterion: it measures
    // how periodic the frame was, and the transient at the start of a pluck is the
    // least periodic part of the note.
    if (reading && (!this.pending.best || reading.clarity > this.pending.best.clarity)) {
      this.pending.best = reading;
    }
    if (this.pending.frames >= settle) this.close();
  }

  /** The pitch in the most recent frame, for a live tuner display. Null on silence. */
  get current(): PitchReading | null {
    return this.last;
  }

  /**
   * Every note heard so far, including one still settling.
   *
   * Including the unsettled one so a live report is current rather than a note
   * behind. Its pitch may still improve, which for a report drawn every frame is the
   * right trade: a bar that lights up late is worse than one that lights up and then
   * corrects itself.
   */
  notes(): HeardNote[] {
    const pending = this.pending && this.pending.best ? [asHeard(this.pending)] : [];
    return [...this.settled, ...pending];
  }

  /** Closes the note being settled. Call when the take ends. */
  flush(): void {
    this.close();
  }

  reset(): void {
    this.onset.reset();
    this.settled.length = 0;
    this.pending = null;
    this.last = null;
  }

  private close(): void {
    // An onset with no pitch on any of its frames is a percussive noise: a palm
    // slap, a string caught on a fret, a chair. Dropping it rather than inventing a
    // pitch keeps it out of the report entirely, which is what it deserves.
    if (this.pending?.best) this.settled.push(asHeard(this.pending));
    this.pending = null;
  }
}

function asHeard(pending: { atSeconds: number; best: PitchReading | null }): HeardNote {
  const best = pending.best!;
  return { atSeconds: pending.atSeconds, midi: best.midi, clarity: best.clarity, rms: best.rms };
}
