/**
 * Detected notes to a written score: `timeline()` in reverse.
 *
 * This is the third stage of the audio-to-tab pipeline (DIFFERENTIATION.md §2) and
 * the only stage of it that is a musical judgement rather than a model download. It
 * is also the missing half of MIDI file import (INTEROP.md §6), which is why it
 * lives in core rather than in the transcription plumbing: both callers hand it the
 * same thing, a list of pitches with onsets in seconds, and want a `Score` back.
 *
 * ## What makes this hard
 *
 * The forward direction is arithmetic: a beat has a written duration, a tempo turns
 * it into seconds, done. Backwards, every step is a guess with a wrong answer that
 * looks plausible:
 *
 * - **Tempo.** 120 BPM and 240 BPM explain the same onsets equally well, because
 *   every sixteenth at 120 is an eighth at 240. So does 60. The residuals cannot
 *   break that tie and neither can any amount of arithmetic; only a preference can.
 * - **Grid.** Snapping to a finer grid always fits better and always notates worse.
 *   A 32nd-note grid can absorb a sloppy performance into unreadable rhythm.
 * - **Duration.** A performer's note length is expression, not notation. The written
 *   duration is usually the distance to the *next* onset, except when it isn't,
 *   because then the rest is the point.
 *
 * ## The discipline
 *
 * Every guess is reported with the evidence for it. `QuantiseReport` carries how far
 * onsets had to move to reach the grid and what fraction landed clean, because those
 * two numbers are how a caller (or a user) knows the tempo was wrong: a correct
 * tempo puts almost everything within a fraction of the grid, and a wrong one
 * smears. That is worth more than a confidence score we made up, and it is what
 * `pnpm transcribe` grades.
 *
 * ## What this deliberately does not do
 *
 * Tuplets. The model holds them (`Beat.tuplet`) and a straight grid cannot express a
 * triplet, so a swung or triplet passage is snapped straight and **counted** in
 * `report.tripletsWanted`. Guessing tuplet groups requires deciding where a group
 * starts and how many notes it spans, which changes the bar's arithmetic; getting
 * that wrong produces bars that do not add up, which is worse than a straight rhythm
 * a user can see is straight.
 *
 * ### The attempt, and what it measured
 *
 * That count reached 64 onsets on one real score at zero jitter, which is a large enough
 * omission to be worth trying, so it was tried: decide straight-or-thirds one beat at a
 * time, keep every group inside a single beat so the bar still sums to its meter, mark the
 * beats with `Beat.tuplet`. Everything downstream already carries tuplets — `beatTicks`,
 * alphaTex's `tu`, MusicXML's `<time-modification>`, the ASCII writer, both readers — so
 * the work was contained to this file.
 *
 * It failed, and `pnpm transcribe` is what said so. Unit tests passed on clean triplet and
 * shuffle material, and the real corpus regressed hard: a score at 100% note recovery and
 * 332 of 332 bars fell to 37% and 150 bars. Three separate causes were found and fixed —
 * a clamp that dragged onsets backwards onto positions already taken, a trigger that fired
 * on noise once timing error exceeded about 20ms, and a cursor that advanced by what it
 * meant to write rather than by what it wrote — and the regression survived all three.
 *
 * The remaining suspect, for whoever picks this up: **the beat is the wrong unit in
 * compound meters.** `beatValue` makes an eighth the beat in 6/8, so thirds-of-a-beat
 * looks for 32nd-note triplets, when what 6/8 actually subdivides is the dotted quarter.
 * The score that regressed worst is largely in 6/8 with a triplet feel, which fits. A next
 * attempt should group compound meters into dotted beats before deciding anything, and
 * should watch the corpus from the first commit rather than the unit tests — clean
 * three-note-per-beat input is the case that works, and it is not the case that matters.
 */
import { createBar, createNote, duration, nextId, pitchAt } from "./build.js";
import { fingerSequence } from "./fingering.js";
import { DEFAULT_TEMPO_BPM, QUARTER_TICKS } from "./timeline.js";
import type { Bar, Beat, Duration, Instrument, Note, Score, TimeSignature, Track } from "./score.js";

/** A pitch the detector heard, in seconds. The pipeline's currency. */
export interface DetectedNote {
  /** MIDI note number. Fractional input is rounded: a detector reports cents. */
  pitch: number;
  startSeconds: number;
  durationSeconds: number;
  /** 0..1 from the detector, carried so low-confidence bars can be flagged later. */
  confidence?: number;
}

export interface QuantiseOptions {
  /**
   * Stated tempo. Estimated from the onsets when absent.
   *
   * Worth passing whenever it is known — a user transcribing a song they play
   * usually knows it, and stating it removes the pipeline's least certain step.
   */
  bpm?: number;
  meter?: TimeSignature;
  /**
   * Tempo and meter as they change through the piece, in ticks from the first note.
   *
   * Optional because the two callers know different things. A MIDI file states both
   * maps exactly, so import passes them and gets the file's own bar structure back. A
   * detector listening to audio knows neither, so transcription passes at most a
   * single stated tempo — inferring where a piece changes meter from onsets alone is a
   * separate problem, and guessing would put bar lines in places the music does not
   * have them.
   *
   * `bpm` and `meter` remain the single-value form, and are what the first entry of
   * each map defaults to when a map starts later than tick 0.
   */
  tempos?: readonly TempoPoint[];
  meters?: readonly MeterPoint[];
  /**
   * Finest straight subdivision to snap to, as a note denominator: 16 means
   * sixteenth notes. Coarser is more readable and less faithful.
   *
   * `"auto"`, the default, picks it from the material — see `chooseGrid`. A fixed
   * number is right when the caller knows the music; a fixed *default* is not, and
   * `pnpm transcribe` is how we found that out.
   */
  grid?: number | "auto";
  /** Notes starting within this of each other are one chord, not a sequence. */
  chordWindowSeconds?: number;
  /**
   * The moment tick 0 corresponds to. Defaults to the first note's onset.
   *
   * Needed whenever more than one part is quantised into the same score. Each call
   * anchors on its own first note by default, so a bass entering a bar after the guitar
   * would be pulled back to tick 0 and the two parts would play together that were
   * never together. Passing a shared origin keeps them aligned.
   */
  originSeconds?: number;
  instrument?: Instrument;
  title?: string;
  trackName?: string;
}

export interface QuantiseReport {
  bpm: number;
  /** False when we guessed it, so a caller knows which number to distrust. */
  bpmStated: boolean;
  /**
   * Tempos that explain the onsets about as well, typically half and double.
   * Stated rather than hidden: this ambiguity is real and a user can resolve it
   * instantly by looking at the result.
   */
  bpmAlternatives: number[];
  notesIn: number;
  notesPlaced: number;
  notesDropped: number;
  /**
   * How far onsets moved to reach the grid, in seconds. The honesty signal: a
   * correct tempo keeps `p95` well under half a grid step, a wrong one does not.
   */
  onsetShift: { mean: number; max: number; p95: number };
  /** Fraction of onsets that landed within a tenth of a grid step. Higher is righter. */
  gridFit: number;
  /** Onsets a triplet grid would have fitted markedly better. See the header. */
  tripletsWanted: number;
  /** The subdivision snapped to, chosen from the material unless the caller fixed it. */
  grid: number;
  /** Distinct onsets the grid could not separate, so they became chords. */
  mergedByGrid: number;
  barsWritten: number;
  beatsWritten: number;
  /** Rest beats written, for silence the detector heard and for bar padding. */
  restsWritten: number;
  chordsFormed: number;
  /** Pitches no string could reach, so they are reported rather than lost. */
  unreachable: number[];
  /** Human-readable lines for the same banner imports and arrangements use. */
  notes: string[];
}

export interface QuantiseResult {
  score: Score;
  report: QuantiseReport;
}

const DEFAULT_METER: TimeSignature = { beats: 4, beatValue: 4 };
const WHOLE_TICKS = QUARTER_TICKS * 4;

/**
 * Notatable durations, longest first, as tick counts.
 *
 * Every power-of-two division from a whole note to a 32nd, each with no dots, one
 * dot, or two. Longest-first is what lets the decomposer below be a simple greedy
 * walk: taking the largest piece that fits is the standard notation of a span, and
 * it is what a reader expects to see.
 */
const NOTATABLE: Array<{ ticks: number; denominator: number; dots: 0 | 1 | 2 }> = (() => {
  const out: Array<{ ticks: number; denominator: number; dots: 0 | 1 | 2 }> = [];
  for (const denominator of [1, 2, 4, 8, 16, 32]) {
    const base = WHOLE_TICKS / denominator;
    for (const dots of [0, 1, 2] as const) {
      // A dot adds half the remaining value: one dot is 1.5x, two is 1.75x.
      const ticks = dots === 0 ? base : dots === 1 ? base * 1.5 : base * 1.75;
      if (Number.isInteger(ticks)) out.push({ ticks, denominator, dots });
    }
  }
  return out.sort((a, b) => b.ticks - a.ticks);
})();

/** Percentile of a copy, so the caller's array keeps its order. */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index] ?? 0;
}

/** A tempo listeners hear as neutral, used to settle the octave tie. See below. */
const PREFERRED_BPM = 120;

/**
 * How well onsets fit the grid at a given tempo, as a mean absolute residual in
 * units of grid steps. Zero is perfect, 0.25 is noise.
 *
 * Two normalisations, and both are load-bearing:
 *
 * **By grid step**, so tempos are comparable at all: an absolute residual in seconds
 * always favours the fastest tempo, because its grid is finest.
 *
 * **By phase**, via the circular mean of the fractional positions rather than an
 * assumed downbeat at the first onset. A recording that starts a hair before or
 * after the beat is otherwise measured against a grid offset by that error, which
 * charges every onset in the file for the first one's timing. Treating each position
 * as an angle and measuring deviation from the mean angle removes the offset without
 * needing to know where the downbeat is, which we do not.
 */
function gridResidual(onsets: readonly number[], bpm: number, grid: number): number {
  if (onsets.length === 0) return 0;
  const stepSeconds = (60 / bpm) * (4 / grid);
  const angles = onsets.map((onset) => 2 * Math.PI * (((onset / stepSeconds) % 1) + 1) % (2 * Math.PI));
  let sx = 0;
  let sy = 0;
  for (const angle of angles) {
    sx += Math.cos(angle);
    sy += Math.sin(angle);
  }
  const mean = Math.atan2(sy, sx);
  let total = 0;
  for (const angle of angles) {
    let deviation = angle - mean;
    while (deviation > Math.PI) deviation -= 2 * Math.PI;
    while (deviation < -Math.PI) deviation += 2 * Math.PI;
    total += Math.abs(deviation) / (2 * Math.PI);
  }
  return total / angles.length;
}

/**
 * The tempo that best explains these onsets.
 *
 * A sweep rather than an interval histogram, because what we need is not "what is
 * the beat period" but "which tempo puts these onsets on a notatable grid", and that
 * is what a sweep measures directly.
 *
 * The octave problem is settled by preference, because evidence cannot settle it:
 * 60, 120 and 240 BPM all explain half-second onsets perfectly, and no residual
 * distinguishes them. Among the tempos that fit within a tolerance, this takes the
 * one nearest 120 BPM on a log scale — the rate listeners hear as neutral, and the
 * standard resolution for this ambiguity in beat tracking.
 *
 * "Slowest that fits" was the first attempt and it is wrong in the other direction:
 * it reads quarter notes at 120 as eighth notes at 60, because 60 fits just as well
 * and is slower. Nearest-to-120 gets both that case and its mirror right, and the
 * half and double readings are returned in `alternatives` so a user who wants one
 * can take it.
 */
export function estimateTempo(
  onsets: readonly number[],
  grid = 16,
): { bpm: number; residual: number; alternatives: number[] } {
  const usable = onsets.filter((o) => Number.isFinite(o));
  if (usable.length < 2) return { bpm: DEFAULT_TEMPO_BPM, residual: 0, alternatives: [] };

  // Anchored on the first onset so a recording with silence at the front is not
  // measured against a grid that started before the music did.
  const first = Math.min(...usable);
  const relative = usable.map((o) => o - first);

  const scored: Array<{ bpm: number; residual: number }> = [];
  // A quarter-BPM sweep across the range real music lives in. Finer buys nothing: a
  // 0.25 BPM error over a four-minute song is under a sixteenth of drift, and the
  // report's onsetShift would show it if it mattered.
  for (let bpm = 40; bpm <= 240.0001; bpm += 0.25) {
    scored.push({ bpm: Math.round(bpm * 100) / 100, residual: gridResidual(relative, bpm, grid) });
  }
  const best = scored.reduce((a, b) => (b.residual < a.residual ? b : a));
  // Within a small margin of the best is "explains it just as well". Both an
  // absolute and a relative term, because the best residual can be exactly zero on
  // synthetic input and a purely relative tolerance would then admit nothing.
  const tolerance = Math.max(best.residual * 1.15, best.residual + 0.02);
  const distance = (bpm: number) => Math.abs(Math.log2(bpm / PREFERRED_BPM));
  const chosen = scored
    .filter((s) => s.residual <= tolerance)
    .reduce((a, b) => (distance(b.bpm) < distance(a.bpm) ? b : a), best);

  // Half and double are the answers a user is most likely to actually want instead,
  // so they are offered by name rather than left to be rediscovered.
  const alternatives = [chosen.bpm / 2, chosen.bpm * 2]
    .filter((bpm) => bpm >= 40 && bpm <= 240)
    .map((bpm) => Math.round(bpm * 100) / 100);

  return { bpm: chosen.bpm, residual: chosen.residual, alternatives };
}

/**
 * A span of ticks as notatable durations, longest first.
 *
 * Greedy: take the largest notatable value that fits, repeat. Five sixteenths
 * becomes a quarter plus a sixteenth, which is how it is written. A span shorter
 * than a 32nd cannot be notated at all and comes back empty, which the caller treats
 * as a dropped note rather than as a zero-length beat.
 */
export function decomposeTicks(span: number): Array<{ duration: Duration; dots: 0 | 1 | 2 }> {
  const out: Array<{ duration: Duration; dots: 0 | 1 | 2 }> = [];
  let left = Math.round(span);
  // A bound rather than a trust: the greedy step only reduces while something fits,
  // and a span that stopped reducing would spin here forever.
  while (left > 0 && out.length < 64) {
    const piece = NOTATABLE.find((n) => n.ticks <= left);
    if (!piece) break;
    out.push({ duration: duration(piece.denominator), dots: piece.dots });
    left -= piece.ticks;
  }
  return out;
}

/** A tempo taking effect at a tick, measured from the transcription's first note. */
export interface TempoPoint {
  atTicks: number;
  bpm: number;
}

/** A meter taking effect at a tick. Only bar starts are meaningful positions. */
export interface MeterPoint {
  atTicks: number;
  beats: number;
  beatValue: number;
}

/**
 * Seconds and ticks, convertible in both directions across a changing tempo.
 *
 * With one tempo this is a multiplication and would not need a type. With a tempo map
 * it is piecewise linear, and every conversion has to know which segment it is in —
 * so the cumulative seconds at each tempo change are computed once and both
 * directions read off the same table. Getting the two directions from one table is
 * the point: derived separately they drift, and a note's position would depend on
 * which way it was last converted.
 *
 * A caller with no map gets a single-segment ruler, which is the old arithmetic
 * exactly.
 */
interface Ruler {
  ticksAt(seconds: number): number;
  secondsAt(ticks: number): number;
  /** Seconds per tick local to a position, for turning a tick error into a duration. */
  rateAt(ticks: number): number;
  bpmAt(ticks: number): number;
}

function tempoRuler(tempos: readonly TempoPoint[], fallbackBpm: number): Ruler {
  const points = [...tempos]
    .filter((t) => Number.isFinite(t.atTicks) && Number.isFinite(t.bpm) && t.bpm > 0)
    .sort((a, b) => a.atTicks - b.atTicks);
  // The map must cover tick 0 or the first note has no tempo. A map that starts later
  // is padded with the stated (or default) tempo rather than rejected.
  if (points.length === 0 || (points[0]?.atTicks ?? 0) > 0) {
    points.unshift({ atTicks: 0, bpm: fallbackBpm });
  }
  const rate = points.map((p) => 60 / p.bpm / QUARTER_TICKS);
  const secondsAtPoint: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const span = (points[i]?.atTicks ?? 0) - (points[i - 1]?.atTicks ?? 0);
    secondsAtPoint[i] = (secondsAtPoint[i - 1] ?? 0) + span * (rate[i - 1] ?? 0);
  }

  /** Index of the segment containing a tick. */
  const segmentAtTicks = (ticks: number): number => {
    let lo = 0;
    for (let i = 1; i < points.length; i += 1) {
      if ((points[i]?.atTicks ?? 0) <= ticks) lo = i;
      else break;
    }
    return lo;
  };
  const segmentAtSeconds = (seconds: number): number => {
    let lo = 0;
    for (let i = 1; i < points.length; i += 1) {
      if ((secondsAtPoint[i] ?? 0) <= seconds) lo = i;
      else break;
    }
    return lo;
  };

  return {
    ticksAt(seconds) {
      const i = segmentAtSeconds(seconds);
      const step = rate[i] ?? 0;
      if (step === 0) return points[i]?.atTicks ?? 0;
      return (points[i]?.atTicks ?? 0) + (seconds - (secondsAtPoint[i] ?? 0)) / step;
    },
    secondsAt(ticks) {
      const i = segmentAtTicks(ticks);
      return (secondsAtPoint[i] ?? 0) + (ticks - (points[i]?.atTicks ?? 0)) * (rate[i] ?? 0);
    },
    rateAt(ticks) {
      return rate[segmentAtTicks(ticks)] ?? 0;
    },
    bpmAt(ticks) {
      return points[segmentAtTicks(ticks)]?.bpm ?? fallbackBpm;
    },
  };
}

/**
 * Where every bar starts and how long it is, across a changing meter.
 *
 * Bars are grown on demand rather than precomputed, because how many there are is not
 * known until the music has been written into them. A meter change is honoured only at
 * a bar line, which is what a meter change means: a 3/4 marked mid-bar is a file that
 * disagrees with itself, and the next bar is where a reader would apply it.
 */
function meterRuler(meters: readonly MeterPoint[], fallback: TimeSignature) {
  const points = [...meters]
    .filter((m) => Number.isFinite(m.atTicks) && m.beats > 0 && m.beatValue > 0)
    .sort((a, b) => a.atTicks - b.atTicks);
  if (points.length === 0 || (points[0]?.atTicks ?? 0) > 0) {
    points.unshift({ atTicks: 0, beats: fallback.beats, beatValue: fallback.beatValue });
  }
  const meterAt = (tick: number): TimeSignature => {
    let found = points[0]!;
    for (const point of points) {
      if (point.atTicks <= tick) found = point;
      else break;
    }
    return { beats: found.beats, beatValue: found.beatValue };
  };
  const lengthOf = (meter: TimeSignature) =>
    Math.max(1, Math.round((WHOLE_TICKS * meter.beats) / meter.beatValue));

  /** Bar starts, extended as far as asked. `starts[i]` is bar i's first tick. */
  const starts: number[] = [0];
  const metersByBar: TimeSignature[] = [meterAt(0)];
  const growTo = (barIndex: number) => {
    while (starts.length <= barIndex) {
      const previous = starts.length - 1;
      const start = (starts[previous] ?? 0) + lengthOf(metersByBar[previous]!);
      starts.push(start);
      metersByBar.push(meterAt(start));
    }
  };
  return {
    /** The bar containing a tick, and how far into it the tick is. */
    at(tick: number): { index: number; offset: number; meter: TimeSignature; length: number } {
      let index = 0;
      for (;;) {
        growTo(index + 1);
        const next = starts[index + 1] ?? 0;
        if (tick < next || index > 1_000_000) break;
        index += 1;
      }
      const start = starts[index] ?? 0;
      const meter = metersByBar[index]!;
      return { index, offset: tick - start, meter, length: lengthOf(meter) };
    },
    meterOfBar(index: number): TimeSignature {
      growTo(index);
      return metersByBar[index] ?? fallback;
    },
    lengthOfBar(index: number): number {
      growTo(index);
      return lengthOf(metersByBar[index] ?? fallback);
    },
    startOfBar(index: number): number {
      growTo(index);
      return starts[index] ?? 0;
    },
  };
}

/** Subdivisions the auto grid will consider, coarsest first. */
const GRID_CHOICES = [8, 16, 32] as const;

/**
 * The finest subdivision this performance actually needs.
 *
 * A fixed 1/16 default is wrong for fast music and `pnpm transcribe` proved it: on a
 * 146 BPM rock track a sixteenth is 103ms, so every pair of notes played closer than
 * about 50ms — its 32nd-note and triplet figures — snapped to one grid position and
 * merged into a chord. The note count came back exactly right and four fifths of the
 * notes were in the wrong place, which is the most misleading way to be wrong.
 *
 * So the grid is chosen from the smallest gap between two onsets that are meant to be
 * *sequential*. Gaps inside the chord window are excluded: a strum is notes at one
 * position by definition, and letting it drive the grid finer would chase a
 * simultaneity that is not a rhythm. A low percentile rather than the outright
 * minimum, so one glitched onset cannot force a 32nd grid onto a whole piece.
 *
 * Coarser is better where it fits — it quantises a sloppy performance into a readable
 * rhythm — so this returns the coarsest choice that still separates what was played.
 */
export function chooseGrid(onsets: readonly number[], bpm: number, chordWindowSeconds: number): number {
  const sorted = [...onsets].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    if (gap > chordWindowSeconds) gaps.push(gap);
  }
  if (gaps.length === 0) return 16;
  const smallest = percentile(gaps, 0.02);
  for (const grid of GRID_CHOICES) {
    // The step at this subdivision, in seconds. Good enough if two notes that far
    // apart land on different positions.
    if ((60 / bpm) * (4 / grid) <= smallest) return grid;
  }
  // Nothing coarse enough separated them, so take the finest we offer and let
  // `mergedByGrid` report whatever it still could not tell apart.
  return 32;
}

/** Groups detected notes into chords: same onset within the window, one beat. */
function groupChords(
  notes: readonly DetectedNote[],
  windowSeconds: number,
): Array<{ startSeconds: number; durationSeconds: number; pitches: number[] }> {
  const sorted = [...notes].sort((a, b) => a.startSeconds - b.startSeconds);
  const groups: Array<{ startSeconds: number; durationSeconds: number; pitches: number[] }> = [];
  for (const note of sorted) {
    const open = groups.at(-1);
    // Compared against the group's *start*, not its most recent member, so a fast
    // run cannot chain note by note into one enormous chord.
    if (open && note.startSeconds - open.startSeconds <= windowSeconds) {
      open.pitches.push(Math.round(note.pitch));
      // A strummed chord's notes ring for different lengths; the longest is what the
      // chord sounds like and what the written duration should follow.
      open.durationSeconds = Math.max(open.durationSeconds, note.durationSeconds);
      continue;
    }
    groups.push({
      startSeconds: note.startSeconds,
      durationSeconds: note.durationSeconds,
      pitches: [Math.round(note.pitch)],
    });
  }
  return groups;
}

/**
 * Fingerings lined back up with the pitches they belong to.
 *
 * `fingerSequence` returns a *compacted* answer: a pitch it could not place leaves no
 * entry at all, so `positions[i]` stops corresponding to `pitches[i]` from the first
 * unplaceable note onward. Indexing it positionally therefore hands each remaining
 * note the fingering meant for a different pitch, and a fret that sounds a note other
 * than the one written is the worst output this module can produce — a tab that is
 * confidently wrong.
 *
 * `pnpm transcribe` found this by measuring, not by reading: forcing a coarse grid
 * merged notes into chords too wide to place, and the share of written frets that
 * actually sound their own pitch fell off 100%.
 *
 * The mapping is rebuilt by asking each position what it sounds, which is the one
 * reading that cannot drift out of alignment. A queue per pitch rather than a plain
 * map, so a chord holding the same pitch twice — a unison across two strings — gets
 * two positions instead of one used twice.
 */
function alignFingering(
  pitches: readonly number[],
  positions: ReadonlyArray<{ string: number; fret: number }> | null,
  instrument: Instrument | undefined,
): Array<{ string: number; fret: number } | undefined> {
  if (!positions || positions.length === 0 || instrument === undefined || instrument.kind !== "fretted") {
    return pitches.map(() => undefined);
  }
  const queues = new Map<number, Array<{ string: number; fret: number }>>();
  for (const position of positions) {
    const sounds = pitchAt(instrument, position.string, position.fret);
    const queue = queues.get(sounds);
    if (queue) queue.push(position);
    else queues.set(sounds, [position]);
  }
  return pitches.map((pitch) => queues.get(pitch)?.shift());
}

/** One sounding event, snapped to the grid, with the silence that follows it. */
interface Span {
  startTicks: number;
  pitches: number[];
  soundTicks: number;
  restTicks: number;
}

/**
 * Written notes from what a detector heard.
 *
 * The stages are separable and each is measurable on its own, which is the point:
 * `pnpm transcribe` can hold the tempo fixed and grade the grid, or jitter the
 * onsets and watch which stage gives way first.
 */
export function quantise(detected: readonly DetectedNote[], options: QuantiseOptions = {}): QuantiseResult {
  const meter = options.meter ?? DEFAULT_METER;
  const chordWindow = options.chordWindowSeconds ?? 0.05;
  const notes: string[] = [];

  const usable = detected.filter(
    (n) => Number.isFinite(n.pitch) && Number.isFinite(n.startSeconds) && n.startSeconds >= 0,
  );
  const unusable = detected.length - usable.length;
  if (unusable > 0) notes.push(`${unusable} detected notes had no usable pitch or onset`);

  // --- Stage 1: tempo -------------------------------------------------------
  const statedBpm = options.bpm;
  const stated = statedBpm !== undefined && Number.isFinite(statedBpm) && statedBpm > 0;
  const onsets = usable.map((n) => n.startSeconds);
  // Estimated against a middling grid, because the grid is chosen from the tempo
  // below and the two cannot both go first. 1/16 is the safe assumption for the
  // estimate specifically: it is fine enough to see the beat in fast music and coarse
  // enough not to lock onto noise in slow music.
  const estimate = stated ? null : estimateTempo(onsets, 16);
  const bpm = stated ? statedBpm : (estimate?.bpm ?? DEFAULT_TEMPO_BPM);
  const grid = options.grid === undefined || options.grid === "auto"
    ? chooseGrid(onsets, bpm, chordWindow)
    : options.grid;
  if (!stated) {
    const others = estimate?.alternatives ?? [];
    notes.push(
      `tempo estimated at ${bpm} BPM (not stated)` +
        (others.length > 0 ? `; ${others.join(" or ")} BPM would fit about as well` : ""),
    );
  }

  const ruler = tempoRuler(options.tempos ?? [], bpm);
  const bars$ = meterRuler(options.meters ?? [], meter);
  // The mean rate across the piece, for the one place a single number is wanted: the
  // grid-fit threshold, which is a summary statistic and not a position.
  const meanRate = 60 / bpm / QUARTER_TICKS;
  const gridTicks = Math.max(1, Math.round(WHOLE_TICKS / grid));
  // A triplet of the grid's own value, for the "would a tuplet have fitted?" count.
  const tripletTicks = Math.max(1, Math.round(gridTicks * (2 / 3)));

  // --- Stage 2: chords ------------------------------------------------------
  const groups = groupChords(usable, chordWindow);
  const chordsFormed = groups.filter((g) => g.pitches.length > 1).length;

  // --- Stage 3: the grid ----------------------------------------------------
  // Measured from the first onset, so leading silence is not part of the answer, and
  // then phase-aligned across the whole part.
  //
  // The phase matters more than it looks. Anchoring the grid on the first onset makes
  // that note's timing error the origin of the coordinate system, so a first note
  // 30ms early moves all the others 30ms late and the report blames them for it. The
  // offset that minimises total residual is the grid a reader would infer, and it
  // costs one pass over a few dozen candidate offsets.
  const origin = options.originSeconds ?? groups[0]?.startSeconds ?? 0;
  const measured = groups.map((group) => ruler.ticksAt(group.startSeconds - origin));
  const PHASE_STEPS = 32;
  let phase = 0;
  let phaseCost = Number.POSITIVE_INFINITY;
  for (let k = 0; k < PHASE_STEPS; k += 1) {
    // Centred on zero, so the search covers early and late equally. Every candidate
    // is within half a grid step, which keeps every snapped position non-negative.
    const candidate = (k / PHASE_STEPS - 0.5) * gridTicks;
    let cost = 0;
    for (const tick of measured) {
      const shifted = tick - candidate;
      cost += Math.abs(shifted - Math.round(shifted / gridTicks) * gridTicks);
    }
    if (cost < phaseCost) {
      phaseCost = cost;
      phase = candidate;
    }
  }

  const shifts: number[] = [];
  let tripletsWanted = 0;

  const snapped = groups.map((group, index) => {
    const rawTicks = (measured[index] ?? 0) - phase;
    const startTicks = Math.round(rawTicks / gridTicks) * gridTicks;
    shifts.push(Math.abs(rawTicks - startTicks) * ruler.rateAt(startTicks));
    // Would a triplet grid have caught this note markedly better? Measured, not
    // acted on: see the header on why tuplets are counted rather than guessed.
    const straightMiss = Math.abs(rawTicks - startTicks);
    const tripletMiss = Math.abs(rawTicks - Math.round(rawTicks / tripletTicks) * tripletTicks);
    if (tripletMiss * 2 < straightMiss && straightMiss > gridTicks * 0.2) tripletsWanted += 1;
    return {
      startTicks,
      soundingTicks: Math.max(
        0,
        ruler.ticksAt(group.startSeconds - origin + group.durationSeconds) -
          ruler.ticksAt(group.startSeconds - origin),
      ),
      pitches: group.pitches,
    };
  });

  // Two groups can land on the same grid tick once snapped — a chord the window was
  // too tight to catch, or a grid too coarse to separate a fast run. Merging them is
  // the only correct answer: two beats at one tick would make the bar's arithmetic
  // count the same moment twice, and every bar after it would be wrong.
  const byTick = new Map<number, { startTicks: number; soundingTicks: number; pitches: number[] }>();
  for (const group of snapped) {
    const open = byTick.get(group.startTicks);
    if (open) {
      open.pitches.push(...group.pitches);
      open.soundingTicks = Math.max(open.soundingTicks, group.soundingTicks);
      continue;
    }
    byTick.set(group.startTicks, { ...group, pitches: [...group.pitches] });
  }
  const collapsed = [...byTick.values()].sort((a, b) => a.startTicks - b.startTicks);
  const mergedByGrid = snapped.length - collapsed.length;
  if (mergedByGrid > 0) {
    notes.push(`${mergedByGrid} onsets shared a 1/${grid} grid position and were merged into chords`);
  }

  // --- Stage 4: spans -------------------------------------------------------
  // A note's written length is the distance to the next onset, unless it stopped
  // sounding well before that, in which case the silence is the point and the
  // remainder becomes a rest. "Well before" is one grid step: less than that is a
  // performer's articulation, not a written rest.
  const spans: Span[] = [];
  for (const [i, group] of collapsed.entries()) {
    const next = collapsed[i + 1];
    const untilNext = next ? next.startTicks - group.startTicks : null;
    const sounding = Math.max(gridTicks, Math.round(group.soundingTicks / gridTicks) * gridTicks);
    let soundTicks: number;
    let restTicks = 0;
    if (untilNext === null) {
      soundTicks = sounding;
    } else if (sounding <= untilNext - gridTicks) {
      soundTicks = sounding;
      restTicks = untilNext - sounding;
    } else {
      soundTicks = untilNext;
    }
    if (soundTicks <= 0) continue;
    spans.push({ startTicks: group.startTicks, pitches: group.pitches, soundTicks, restTicks });
  }

  // --- Stage 5: fingering ---------------------------------------------------
  // Solved across the whole part at once so the hand stays put, which is what
  // fingerSequence is for. Done before bar packing because a bar line is a notation
  // boundary, not a musical one: a hand does not reset at one.
  const instrument = options.instrument;
  const fingering =
    instrument !== undefined && instrument.kind === "fretted"
      ? fingerSequence(instrument, spans.map((s) => s.pitches))
      : null;
  const unreachable = [...new Set(fingering?.unreachable ?? [])];
  if (unreachable.length > 0) {
    notes.push(
      `${unreachable.length} pitches are outside the instrument's range and were left unfingered: ` +
        unreachable.slice(0, 8).join(", "),
    );
  }

  // --- Stage 6: bars --------------------------------------------------------
  const bars: Bar[] = [];
  const started = new Set<Bar>();
  let restsWritten = 0;
  let beatsWritten = 0;
  let notesPlaced = 0;

  /**
   * The bar covering a tick, creating any bars before it that nothing reached.
   *
   * Bar lengths come from the meter ruler, so a piece that changes meter gets bars of
   * the right size rather than the first meter's size repeated. Each bar states its own
   * signature only where it differs from the one before, which is what the notation
   * means and what every reader of ours expects.
   */
  const barAt = (tick: number): { bar: Bar; offset: number; length: number } => {
    const found = bars$.at(tick);
    while (bars.length <= found.index) {
      const index = bars.length;
      const barMeter = bars$.meterOfBar(index);
      const previous = index === 0 ? null : bars$.meterOfBar(index - 1);
      const changed =
        previous === null ||
        previous.beats !== barMeter.beats ||
        previous.beatValue !== barMeter.beatValue;
      bars.push(createBar(barMeter, changed));
    }
    return { bar: bars[found.index]!, offset: found.offset, length: found.length };
  };

  /**
   * Appends a beat, clearing the bar's seeded full-bar rest on first use.
   *
   * `createBar` pre-fills rests so the editor can replace them in place. A bar this
   * writer touches is being written from nothing, so those seeded rests have to go
   * or the bar holds a meter's worth of silence plus everything we wrote.
   */
  const push = (bar: Bar, beat: Beat) => {
    const voice = bar.voices[0];
    if (!voice) return;
    if (!started.has(bar)) {
      voice.beats = [];
      started.add(bar);
    }
    voice.beats.push(beat);
    beatsWritten += 1;
    if (beat.notes.length === 0) restsWritten += 1;
  };

  /**
   * Writes a run of ticks from `tick`, splitting at every bar line, and returns the
   * tick it finished at. `chord` null writes rests.
   *
   * One function for notes and for rests because the splitting is identical, and
   * writing it twice is how the two drift apart.
   */
  const write = (
    tick: number,
    total: number,
    pitches: readonly number[] | null,
    /** Aligned with `pitches` by `alignFingering`; undefined where nothing could reach. */
    chord: ReadonlyArray<{ string: number; fret: number } | undefined> | null,
  ): number => {
    let at = tick;
    let left = total;
    let counted = false;
    while (left > 0) {
      const { bar, offset, length } = barAt(at);
      const room = length - offset;
      const take = Math.min(room, left);
      const pieces = decomposeTicks(take);
      // A span too short to notate at all. Stopping is right: advancing without
      // writing would desynchronise `cursor` from what the bars actually hold.
      if (pieces.length === 0) break;
      for (const [i, piece] of pieces.entries()) {
        const isLast = i === pieces.length - 1 && take === left;
        const beat: Beat = { id: nextId("b"), duration: piece.duration, dots: piece.dots, notes: [] };
        if (pitches !== null) {
          for (const [p, pitch] of pitches.entries()) {
            const position = chord?.[p];
            const note: Note =
              position === undefined
                ? { id: nextId("n"), pitch, articulations: [] }
                : createNote(pitch, position.string, position.fret);
            // A note split by a bar line or by an unnotatable span is one note held,
            // so every piece but the last ties into the next. Without this, playback
            // re-articulates and a reader sees a repeated note where the performance
            // had one — the same bug `mergeTies` exists to undo downstream.
            beat.notes.push(isLast ? note : { ...note, tiedToNext: true });
          }
          // Counted once per span, not once per piece: a note split across a bar
          // line is one note the transcription placed, and counting the pieces
          // would report more notes out than came in.
          if (!counted) {
            notesPlaced += beat.notes.length;
            counted = true;
          }
        }
        push(bar, beat);
      }
      at += take;
      left -= take;
    }
    return at;
  };

  let cursor = 0;
  for (const [i, span] of spans.entries()) {
    // A gap before this note that nothing filled is a rest: the detector heard
    // silence at the start, or between phrases.
    if (span.startTicks > cursor) cursor = write(cursor, span.startTicks - cursor, null, null);
    cursor = write(
      cursor,
      span.soundTicks,
      span.pitches,
      alignFingering(span.pitches, fingering?.chords[i] ?? null, instrument),
    );
    if (span.restTicks > 0) cursor = write(cursor, span.restTicks, null, null);
  }

  // Pad the last bar so it is a whole bar. A part that stops mid-bar is not wrong
  // musically, but a bar whose beats do not sum to its meter breaks every consumer
  // that trusts the meter, starting with our own timeline.
  const closing = bars$.at(cursor);
  if (closing.offset > 0) write(cursor, closing.length - closing.offset, null, null);
  if (bars.length === 0) bars.push(createBar(meter, true));

  // --- Result ---------------------------------------------------------------
  const track: Track = {
    id: nextId("t"),
    name: options.trackName ?? "Transcription",
    instrument: instrument ?? { kind: "pitched", midiProgram: 25 },
    bars,
  };
  // The tempo belongs on the score, or playing it back reports 120 and every
  // measurement taken against it is wrong by the ratio. A map is written onto the bar
  // each change lands in — the nearest bar line at or before it, since a tempo marked
  // mid-bar is not something our model holds — and only where it actually changes.
  const firstBar = bars[0];
  if (firstBar) firstBar.tempoBpm = ruler.bpmAt(0);
  let lastWritten = ruler.bpmAt(0);
  for (const [index, bar] of bars.entries()) {
    if (index === 0) continue;
    const bpmHere = ruler.bpmAt(bars$.startOfBar(index));
    if (bpmHere !== lastWritten) {
      bar.tempoBpm = bpmHere;
      lastWritten = bpmHere;
    }
  }

  const report: QuantiseReport = {
    bpm,
    bpmStated: stated,
    bpmAlternatives: estimate?.alternatives ?? [],
    notesIn: detected.length,
    notesPlaced,
    notesDropped: Math.max(0, detected.length - notesPlaced),
    onsetShift: {
      mean: shifts.length === 0 ? 0 : shifts.reduce((a, b) => a + b, 0) / shifts.length,
      max: shifts.length === 0 ? 0 : Math.max(...shifts),
      p95: percentile(shifts, 0.95),
    },
    gridFit:
      shifts.length === 0
        ? 1
        : shifts.filter((s) => s <= gridTicks * meanRate * 0.1).length / shifts.length,
    tripletsWanted,
    grid,
    mergedByGrid,
    barsWritten: bars.length,
    beatsWritten,
    restsWritten,
    chordsFormed,
    unreachable,
    notes,
  };
  if (tripletsWanted > 0) {
    report.notes.push(
      `${tripletsWanted} onsets fit a triplet better than the 1/${grid} grid and were snapped straight ` +
        "(tuplets are not written yet)",
    );
  }
  return { score: { id: nextId("s"), title: options.title ?? "Transcription", artist: "", tracks: [track], revision: 0 }, report };
}

