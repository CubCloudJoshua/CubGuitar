/**
 * Practice as a stored object.
 *
 * The claims here are the ones a teacher would check. That a bar you have never played
 * cleanly comes before one you have. That getting something right once does not mark it
 * learned. That the tempo you can play a passage at is the tempo of its worst bar, not
 * its best. And that a single bad take does not read as getting worse.
 *
 * All of it is pure and takes the clock as an argument, so the same history always
 * produces the same plan. A practice report that changes while you read it is not a
 * report.
 */
import { describe, expect, it } from "vitest";
import {
  accuracyOf,
  drillOrder,
  intervalDays,
  isClean,
  passageTempo,
  summarise,
  type Take,
  type TakeBar,
} from "./practice.js";

const DAY = 86_400_000;
/** A fixed epoch, because a test that reads the clock tests the clock. */
const T0 = 1_700_000_000_000;

/** A bar's outcome: notes played cleanly out of a total, with the rest missed. */
function bar(index: number, clean: number, total: number, extra: Partial<TakeBar> = {}): TakeBar {
  return {
    bar: index,
    clean,
    early: 0,
    late: 0,
    wrongPitch: 0,
    missed: total - clean,
    unverified: 0,
    timingSeconds: null,
    ...extra,
  };
}

function take(at: number, bpm: number, bars: TakeBar[]): Take {
  return { at, bpm, bars };
}

describe("one bar's outcome", () => {
  it("is the share of judgeable notes that were played", () => {
    expect(accuracyOf(bar(0, 3, 4))).toBeCloseTo(0.75, 6);
  });

  it("counts an early or late note as played", () => {
    // Accuracy is about notes. Timing is a separate number with a separate fix.
    expect(accuracyOf({ ...bar(0, 2, 4), early: 1, late: 1, missed: 0 })).toBe(1);
  });

  it("is null for a bar with nothing to judge", () => {
    expect(accuracyOf(bar(0, 0, 0))).toBeNull();
    expect(accuracyOf({ ...bar(0, 0, 0), unverified: 3 })).toBeNull();
  });

  it("is clean only when every note was played in time", () => {
    // Strict on purpose: a threshold of "most of it" produces a history saying you
    // know a piece you cannot play.
    expect(isClean(bar(0, 4, 4))).toBe(true);
    expect(isClean(bar(0, 3, 4))).toBe(false);
    expect(isClean({ ...bar(0, 3, 4), late: 1, missed: 0 })).toBe(false);
    expect(isClean(bar(0, 0, 0))).toBe(false);
  });
});

describe("a bar's history", () => {
  it("counts only the takes that judged it", () => {
    // A bar of rests is not an attempt at that bar, and counting it would dilute
    // every average with bars nobody played.
    const summary = summarise([
      take(T0, 120, [bar(0, 4, 4), bar(1, 0, 0)]),
      take(T0 + DAY, 120, [bar(0, 2, 4), bar(1, 0, 0)]),
    ]);
    expect(summary.bars.map((b) => b.bar)).toEqual([0]);
    expect(summary.bars[0]?.attempts).toBe(2);
  });

  it("reports the latest attempt and the best one separately", () => {
    // The two answer different questions: what can I do today, and what have I ever
    // done. A report with only one of them is missing the interesting half.
    const summary = summarise([
      take(T0, 120, [bar(0, 4, 4)]),
      take(T0 + DAY, 120, [bar(0, 1, 4)]),
    ]);
    expect(summary.bars[0]?.best).toBe(1);
    expect(summary.bars[0]?.latest).toBe(0.25);
  });

  it("takes takes in time order however they arrive", () => {
    // They come from a database, and a database returns what its index feels like.
    const summary = summarise([
      take(T0 + DAY, 120, [bar(0, 1, 4)]),
      take(T0, 120, [bar(0, 4, 4)]),
    ]);
    expect(summary.bars[0]?.latest).toBe(0.25);
  });

  it("counts a streak back from the most recent attempt", () => {
    // A streak broken three takes ago is not a streak, however long it once was.
    const summary = summarise([
      take(T0, 120, [bar(0, 4, 4)]),
      take(T0 + DAY, 120, [bar(0, 4, 4)]),
      take(T0 + 2 * DAY, 120, [bar(0, 2, 4)]),
      take(T0 + 3 * DAY, 120, [bar(0, 4, 4)]),
    ]);
    expect(summary.bars[0]?.streak).toBe(1);
  });

  it("averages timing across attempts, so rushing shows up as a habit", () => {
    const summary = summarise([
      take(T0, 120, [bar(0, 4, 4, { timingSeconds: -0.08 })]),
      take(T0 + DAY, 120, [bar(0, 4, 4, { timingSeconds: -0.12 })]),
    ]);
    expect(summary.bars[0]?.timingSeconds).toBeCloseTo(-0.1, 6);
  });
});

describe("improvement", () => {
  it("compares halves rather than first against last", () => {
    // First-against-last means one fluffed take reads as getting worse. Halves are
    // what make the number worth showing.
    const rising = summarise([
      take(T0, 120, [bar(0, 1, 4)]),
      take(T0 + DAY, 120, [bar(0, 2, 4)]),
      take(T0 + 2 * DAY, 120, [bar(0, 3, 4)]),
      take(T0 + 3 * DAY, 120, [bar(0, 4, 4)]),
    ]);
    expect(rising.bars[0]?.trend).toBeCloseTo(0.5, 6);
  });

  it("does not report a trend from one bad take at the end", () => {
    const blip = summarise([
      take(T0, 120, [bar(0, 4, 4)]),
      take(T0 + DAY, 120, [bar(0, 4, 4)]),
      take(T0 + 2 * DAY, 120, [bar(0, 4, 4)]),
      take(T0 + 3 * DAY, 120, [bar(0, 3, 4)]),
    ]);
    // Slightly down rather than catastrophically so: three good takes are still in
    // the average.
    expect(blip.bars[0]!.trend!).toBeGreaterThan(-0.2);
  });

  it("says nothing until there is enough to say it with", () => {
    const few = summarise([take(T0, 120, [bar(0, 1, 4)]), take(T0 + DAY, 120, [bar(0, 4, 4)])]);
    expect(few.bars[0]?.trend).toBeNull();
  });
});

describe("the tempo you can actually play it at", () => {
  it("records the fastest tempo a bar came out clean at", () => {
    // The number every guitarist cares about and nobody records. A clean pass at 60
    // and a scrappy one at 120 do not mean you can play it at 120.
    const summary = summarise([
      take(T0, 60, [bar(0, 4, 4)]),
      take(T0 + DAY, 100, [bar(0, 4, 4)]),
      take(T0 + 2 * DAY, 140, [bar(0, 2, 4)]),
    ]);
    expect(summary.bars[0]?.cleanBpm).toBe(100);
  });

  it("has no tempo for a bar never played clean", () => {
    const summary = summarise([take(T0, 120, [bar(0, 3, 4)])]);
    expect(summary.bars[0]?.cleanBpm).toBeNull();
  });

  it("takes a passage's tempo from its worst bar", () => {
    // "I can play it at 120" means all of it. A passage's tempo is the slowest of its
    // bars, not the fastest, and taking the fastest is how a practice tool flatters.
    const summary = summarise([
      take(T0, 140, [bar(0, 4, 4)]),
      take(T0 + DAY, 90, [bar(1, 4, 4)]),
      take(T0 + 2 * DAY, 120, [bar(2, 4, 4)]),
    ]);
    expect(passageTempo(summary.bars, 0, 2)).toBe(90);
  });

  it("has no tempo for a passage containing a bar you cannot play", () => {
    const summary = summarise([
      take(T0, 140, [bar(0, 4, 4)]),
      take(T0 + DAY, 140, [bar(1, 2, 4)]),
    ]);
    expect(passageTempo(summary.bars, 0, 1)).toBeNull();
  });

  it("has no tempo for a passage where some bars have never been attempted", () => {
    // The bug this replaced: a bar nobody has played is absent from the history
    // entirely, so filtering to the range and checking what is left ignored it — and
    // the strip announced a tempo for a whole piece on the strength of the few bars
    // somebody had practised.
    const summary = summarise([take(T0, 120, [bar(0, 4, 4), bar(1, 4, 4)])]);
    expect(passageTempo(summary.bars, 0, 1)).toBe(120);
    expect(passageTempo(summary.bars, 0, 7)).toBeNull();
  });

  it("has no tempo for a backwards range", () => {
    expect(passageTempo(summarise([take(T0, 120, [bar(0, 4, 4)])]).bars, 3, 1)).toBeNull();
  });

  it("has no tempo for a range nobody has played", () => {
    expect(passageTempo(summarise([take(T0, 120, [bar(0, 4, 4)])]).bars, 5, 9)).toBeNull();
  });
});

describe("what to practise next", () => {
  it("puts a bar you have never played clean before one you have", () => {
    // There is no point revising something you have not learned.
    const summary = summarise([
      take(T0, 120, [bar(0, 4, 4), bar(1, 2, 4)]),
    ]);
    expect(drillOrder(summary.bars, T0)).toEqual([1]);
  });

  it("orders the unlearned ones weakest first", () => {
    const summary = summarise([
      take(T0, 120, [bar(0, 3, 4), bar(1, 1, 4), bar(2, 2, 4)]),
    ]);
    expect(drillOrder(summary.bars, T0)).toEqual([1, 2, 0]);
  });

  it("holds a clean bar back until it is due", () => {
    // Getting something right once does not mean it is learned, and asking for it
    // again an hour later teaches nothing.
    const summary = summarise([take(T0, 120, [bar(0, 4, 4)])]);
    expect(drillOrder(summary.bars, T0 + 3600_000)).toEqual([]);
    expect(drillOrder(summary.bars, T0 + 2 * DAY)).toEqual([0]);
  });

  it("waits longer after each consecutive clean pass", () => {
    const one = summarise([take(T0, 120, [bar(0, 4, 4)])]);
    const three = summarise([
      take(T0, 120, [bar(0, 4, 4)]),
      take(T0 + 2 * DAY, 120, [bar(0, 4, 4)]),
      take(T0 + 6 * DAY, 120, [bar(0, 4, 4)]),
    ]);
    expect(intervalDays(one.bars[0]!.streak)).toBe(1);
    expect(intervalDays(three.bars[0]!.streak)).toBe(4);
    // And a bar three passes deep is not due the next day.
    expect(drillOrder(three.bars, T0 + 7 * DAY)).toEqual([]);
  });

  it("never lets a bar sit longer than a fortnight", () => {
    // However well you once played it, a piece you have not touched in two weeks is
    // worth checking.
    expect(intervalDays(20)).toBe(14);
  });

  it("leads with the most overdue", () => {
    const summary = summarise([
      take(T0, 120, [bar(0, 4, 4)]),
      take(T0 + 5 * DAY, 120, [bar(1, 4, 4)]),
    ]);
    expect(drillOrder(summary.bars, T0 + 10 * DAY)).toEqual([0, 1]);
  });

  it("breaks a tie among unlearned bars with the stale one first", () => {
    // Two bars you fail equally: the one you have been avoiding is the one to do.
    const summary = summarise([
      take(T0, 120, [bar(3, 2, 4)]),
      take(T0 + 5 * DAY, 120, [bar(1, 2, 4)]),
    ]);
    expect(drillOrder(summary.bars, T0 + 6 * DAY)).toEqual([3, 1]);
  });

  it("comes back empty when everything is learned and nothing is due", () => {
    const summary = summarise([take(T0, 120, [bar(0, 4, 4), bar(1, 4, 4)])]);
    expect(drillOrder(summary.bars, T0)).toEqual([]);
  });
});

describe("nothing recorded yet", () => {
  it("summarises an empty history without inventing anything", () => {
    const summary = summarise([]);
    expect(summary).toEqual({ takes: 0, bars: [], drill: [] });
  });

  it("counts a take that judged nothing as a take, and nothing else", () => {
    const summary = summarise([take(T0, 120, [bar(0, 0, 0)])]);
    expect(summary.takes).toBe(1);
    expect(summary.bars).toEqual([]);
  });

  it("does not credit a tempo to a take that did not record one", () => {
    // A take with no tempo still counts towards accuracy; it must not set a record.
    const summary = summarise([take(T0, 0, [bar(0, 4, 4)])]);
    expect(summary.bars[0]?.latest).toBe(1);
    expect(passageTempo(summary.bars, 0, 0)).toBeNull();
  });
});
