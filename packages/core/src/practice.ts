/**
 * Practice as a stored object.
 *
 * A take graded once and thrown away is a novelty. The same take stored and compared
 * against the last twenty is the thing no notation product offers: a record of which
 * bars you actually fail, how fast you can actually play them, and which ones are
 * overdue for another attempt.
 *
 * The shape of it falls out of what is already here. `listen.ts` produces a per-bar
 * verdict for one pass; this accumulates passes. Nothing about it is specific to a
 * microphone — a take could come from a MIDI keyboard, or from a teacher tapping
 * "got it" — so the input is a plain record and not a `ListenReport`.
 *
 * Two judgements are worth defending.
 *
 * **Tempo is stored with the take, and it is the effective tempo.** A bar played
 * cleanly at half speed and a bar played cleanly at full speed are different
 * achievements, and a history that records only accuracy says they are the same. The
 * single number a guitarist cares about is the tempo they can play a passage at, and
 * it is the one number no practice tool records.
 *
 * **A bar's due date grows with consecutive clean passes.** Getting a bar right once
 * does not mean it is learned; getting it right on four separate days does. So the
 * interval doubles, which is the spaced-repetition idea that exists for vocabulary and
 * inexplicably not for bars of music.
 */

/** One bar's outcome in one take. Mirrors `listen.ts`'s BarResult, minus the geometry. */
export interface TakeBar {
  bar: number;
  clean: number;
  early: number;
  late: number;
  wrongPitch: number;
  missed: number;
  unverified: number;
  /** Signed mean timing over the notes that were played. Negative is ahead. */
  timingSeconds: number | null;
}

export interface Take {
  /** When the take happened, in milliseconds since the epoch. */
  at: number;
  /**
   * The tempo it was actually played at: the score's tempo times the playback speed.
   *
   * Effective rather than written, because the speed trainer exists and a take at 60%
   * is a take at 60%. Zero or absent means the tempo was not recorded, and such a take
   * still counts towards accuracy but never sets a tempo record.
   */
  bpm: number;
  bars: TakeBar[];
}

export interface BarHistory {
  bar: number;
  /** Takes that judged this bar at all. */
  attempts: number;
  /** Judgeable notes seen across those attempts. */
  notes: number;
  /** Accuracy in the most recent attempt, 0 to 1. */
  latest: number;
  best: number;
  /**
   * Change from the earlier half of the attempts to the later half.
   *
   * Halves rather than first-against-last, because a single fluffed take would
   * otherwise read as getting worse. Null until there are enough attempts to have two
   * halves worth comparing.
   */
  trend: number | null;
  /** Fastest tempo at which this bar came out clean. Null if it never has. */
  cleanBpm: number | null;
  /** When it was last played clean. Null if it never has. */
  lastCleanAt: number | null;
  /**
   * When it was last attempted at all.
   *
   * Distinct from `lastCleanAt` and needed for it: a bar you have never played cleanly
   * has no clean date, so the only measure of how long you have been avoiding it is
   * when you last tried.
   */
  lastAttemptAt: number;
  /** Consecutive clean attempts, counting back from the most recent. */
  streak: number;
  /** Mean signed timing across attempts, over notes that were played. */
  timingSeconds: number | null;
}

export interface PracticeSummary {
  takes: number;
  bars: BarHistory[];
  /**
   * Bars to work on, worst and most overdue first.
   *
   * The output a practice tool exists to produce and the one every competitor leaves
   * to the user's memory.
   */
  drill: number[];
}

/** Everything played in a bar that counts towards its score. */
function judgedIn(bar: TakeBar): number {
  return bar.clean + bar.early + bar.late + bar.wrongPitch + bar.missed;
}

/** The share of a bar's judgeable notes that were played, or null if none were. */
export function accuracyOf(bar: TakeBar): number | null {
  const judged = judgedIn(bar);
  return judged === 0 ? null : (bar.clean + bar.early + bar.late) / judged;
}

/**
 * What counts as having played a bar cleanly.
 *
 * Every note played, at the right pitch, and nothing off the beat. Deliberately
 * strict: the point of a record of clean passes is that reaching one means something,
 * and a threshold of "most of it" produces a history that says you know a piece you
 * cannot play.
 */
export function isClean(bar: TakeBar): boolean {
  return judgedIn(bar) > 0 && bar.clean === judgedIn(bar);
}

/**
 * How long a clean bar stays learned, in days, after `streak` consecutive clean passes.
 *
 * Doubling from one day, capped at a fortnight. The cap is not a mathematical
 * necessity; it is a statement that a piece you have not touched in two weeks is worth
 * checking however well you once played it.
 */
export function intervalDays(streak: number): number {
  if (streak <= 0) return 0;
  return Math.min(14, 2 ** (streak - 1));
}

const DAY_MS = 86_400_000;

/**
 * A bar's history from every take that judged it.
 *
 * Takes are sorted by time here rather than trusted to arrive in order, because they
 * come from a database and a database returns what its index feels like.
 */
export function summarise(takes: readonly Take[]): PracticeSummary {
  const ordered = [...takes].sort((a, b) => a.at - b.at);
  /** Every attempt at each bar, oldest first. */
  const attempts = new Map<number, Array<{ take: Take; bar: TakeBar; accuracy: number }>>();

  for (const take of ordered) {
    for (const bar of take.bars) {
      const accuracy = accuracyOf(bar);
      // A bar of rests, or one the pass could not judge, is not an attempt at it.
      // Counting it would dilute every average with bars nobody played.
      if (accuracy === null) continue;
      const list = attempts.get(bar.bar) ?? [];
      list.push({ take, bar, accuracy });
      attempts.set(bar.bar, list);
    }
  }

  const bars: BarHistory[] = [];
  for (const [bar, list] of attempts) {
    const accuracies = list.map((a) => a.accuracy);
    const cleanAttempts = list.filter((a) => isClean(a.bar));
    const timings = list.flatMap((a) => (a.bar.timingSeconds === null ? [] : [a.bar.timingSeconds]));

    // Counting back from the most recent: a streak broken three takes ago is not a
    // streak, however long it once was.
    let streak = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!isClean(list[i]!.bar)) break;
      streak += 1;
    }

    bars.push({
      bar,
      attempts: list.length,
      notes: list.reduce((n, a) => n + judgedIn(a.bar), 0),
      latest: accuracies.at(-1)!,
      best: Math.max(...accuracies),
      trend: trendOf(accuracies),
      cleanBpm:
        cleanAttempts.length === 0
          ? null
          : Math.max(...cleanAttempts.map((a) => a.take.bpm)) || null,
      lastCleanAt: cleanAttempts.length === 0 ? null : cleanAttempts.at(-1)!.take.at,
      lastAttemptAt: list.at(-1)!.take.at,
      streak,
      timingSeconds: timings.length === 0 ? null : timings.reduce((a, b) => a + b, 0) / timings.length,
    });
  }

  bars.sort((a, b) => a.bar - b.bar);
  return { takes: ordered.length, bars, drill: drillOrder(bars, ordered.at(-1)?.at ?? 0) };
}

/**
 * Improvement across a bar's attempts: the later half's mean minus the earlier half's.
 *
 * Null below four attempts. Two halves of one attempt each is the difference between
 * two takes, which is noise, and reporting it as a trend would have a user chasing it.
 */
function trendOf(accuracies: readonly number[]): number | null {
  if (accuracies.length < 4) return null;
  const split = Math.floor(accuracies.length / 2);
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return mean(accuracies.slice(split)) - mean(accuracies.slice(0, split));
}

/**
 * The bars worth practising, in the order worth practising them.
 *
 * A bar never played clean comes before one that has been, because there is no point
 * revising something you have not learned. Within that, the weakest first. A bar that
 * has been played clean comes back only once it is due, and the most overdue leads.
 *
 * `now` is passed in rather than read from the clock so the same history always
 * produces the same plan, which is what makes this testable and what stops a report
 * from changing while a user reads it.
 */
export function drillOrder(bars: readonly BarHistory[], now: number): number[] {
  const unlearned = bars.filter((b) => b.streak === 0);
  const learned = bars.filter((b) => b.streak > 0);

  const overdueBy = (b: BarHistory): number => {
    const due = (b.lastCleanAt ?? 0) + intervalDays(b.streak) * DAY_MS;
    return now - due;
  };

  return [
    // Weakest first, and an older attempt breaks a tie: a bar you failed today and a
    // bar you failed a month ago are equally unlearned, and the stale one is the one
    // you have been avoiding.
    ...unlearned
      .slice()
      .sort((a, b) => a.latest - b.latest || a.lastAttemptAt - b.lastAttemptAt || a.bar - b.bar)
      .map((b) => b.bar),
    ...learned
      .filter((b) => overdueBy(b) >= 0)
      .sort((a, b) => overdueBy(b) - overdueBy(a) || a.bar - b.bar)
      .map((b) => b.bar),
  ];
}

/**
 * The fastest tempo every bar of a passage has been played clean at.
 *
 * The number a guitarist means by "I can play it": not the fastest any bar went, but
 * the fastest the *whole passage* went, which is the slowest of its bars. Null when any
 * bar in the range has never been clean, because a passage with a bar you cannot play
 * has no tempo you can play it at.
 *
 * "Every bar" includes the ones with no history at all. A bar nobody has attempted is
 * absent from `bars` entirely, so filtering to the range and checking what is left
 * silently ignores it — and the strip then announced "clean at 92bpm" for a
 * two-hundred-bar piece on the strength of the eight bars somebody had practised. A
 * range is only answerable when every bar in it has been played, so the count is
 * checked and not just the contents.
 */
export function passageTempo(
  bars: readonly BarHistory[],
  from: number,
  to: number,
): number | null {
  if (to < from) return null;
  const inRange = bars.filter((b) => b.bar >= from && b.bar <= to);
  // Every bar of the passage has to be accounted for. Distinct bars, because a
  // caller could hand us a list with duplicates and a length check alone would pass.
  if (new Set(inRange.map((b) => b.bar)).size < to - from + 1) return null;
  const tempos = inRange.map((b) => b.cleanBpm);
  if (tempos.some((t) => t === null || t <= 0)) return null;
  return Math.min(...(tempos as number[]));
}
