/**
 * A recording locked to the score.
 *
 * Two clocks that neither start together nor run at the same rate, and a map between
 * them built from marks a human tapped. The tests that matter are about the cases where
 * a naive map does something visibly wrong: before the first mark and after the last,
 * where a flat extension freezes the playhead over the count-in and the final chord; and
 * a mis-tap, where a map that goes backwards makes the playhead jump back mid-bar and
 * the user concludes the feature is broken.
 *
 * The inverse gets equal weight, because seeking runs the other way: a user clicks a bar
 * and the recording has to find it.
 */
import { describe, expect, it } from "vitest";
import {
  alignmentOf,
  IDENTITY,
  recordingTimeAt,
  scoreTimeAt,
  speedAt,
  suspectPoints,
  withoutPointNear,
  withPoint,
  type SyncPoint,
} from "./sync.js";

const at = (recordingSeconds: number, scoreSeconds: number): SyncPoint => ({ recordingSeconds, scoreSeconds });

describe("no marks at all", () => {
  it("treats the two clocks as one", () => {
    expect(scoreTimeAt(IDENTITY, 12.5)).toBe(12.5);
    expect(recordingTimeAt(IDENTITY, 12.5)).toBe(12.5);
  });

  it("never reports a negative moment", () => {
    expect(scoreTimeAt(IDENTITY, -3)).toBe(0);
    expect(recordingTimeAt(IDENTITY, -3)).toBe(0);
  });
});

describe("one mark", () => {
  const offset = alignmentOf([at(4, 0)]);

  it("is an offset, not a stretch", () => {
    // One mark says where the music starts and nothing about tempo, so assuming the
    // rates match is the only honest reading of it.
    expect(scoreTimeAt(offset, 4)).toBe(0);
    expect(scoreTimeAt(offset, 6)).toBe(2);
    expect(scoreTimeAt(offset, 3)).toBe(0);
  });

  it("inverts", () => {
    expect(recordingTimeAt(offset, 0)).toBe(4);
    expect(recordingTimeAt(offset, 2)).toBe(6);
  });
});

describe("two marks", () => {
  // A band that played it faster than it was typed: eight seconds of score in four.
  const faster = alignmentOf([at(2, 0), at(6, 8)]);

  it("stretches the score onto the recording", () => {
    expect(scoreTimeAt(faster, 2)).toBe(0);
    expect(scoreTimeAt(faster, 4)).toBe(4);
    expect(scoreTimeAt(faster, 6)).toBe(8);
  });

  it("reports the rate, so wrong marks are visible", () => {
    // The number that tells a user their marks are wrong: a real performance does not
    // change tempo by a factor of three between two bars.
    expect(speedAt(faster, 4)).toBe(2);
  });

  it("keeps going before the first mark rather than freezing", () => {
    // A flat extension would pin the playhead to bar one through the whole count-in,
    // which is exactly where somebody is looking when they press play.
    expect(scoreTimeAt(faster, 1)).toBe(0);
    expect(scoreTimeAt(alignmentOf([at(4, 4), at(8, 8)]), 2)).toBe(2);
  });

  it("keeps going after the last mark too", () => {
    expect(scoreTimeAt(faster, 8)).toBe(12);
  });

  it("inverts exactly, so a click on a bar finds the right moment", () => {
    for (const score of [0, 1, 4, 7.5, 8]) {
      expect(recordingTimeAt(faster, score)).toBeCloseTo(2 + score / 2, 10);
      expect(scoreTimeAt(faster, recordingTimeAt(faster, score))).toBeCloseTo(score, 10);
    }
  });
});

describe("several marks", () => {
  // A performance that slows down: the second half takes longer per bar.
  const rubato = alignmentOf([at(0, 0), at(4, 4), at(12, 8)]);

  it("uses the line either side of the moment, not one line for the whole thing", () => {
    expect(scoreTimeAt(rubato, 2)).toBe(2);
    expect(scoreTimeAt(rubato, 4)).toBe(4);
    expect(scoreTimeAt(rubato, 8)).toBe(6);
  });

  it("reports a different rate in each stretch", () => {
    expect(speedAt(rubato, 2)).toBe(1);
    expect(speedAt(rubato, 8)).toBe(0.5);
  });

  it("inverts through the right stretch", () => {
    expect(recordingTimeAt(rubato, 2)).toBe(2);
    expect(recordingTimeAt(rubato, 6)).toBe(8);
  });

  it("round-trips every moment of the score", () => {
    for (const score of [0, 1, 3.9, 4, 4.1, 6, 8, 9]) {
      expect(scoreTimeAt(rubato, recordingTimeAt(rubato, score))).toBeCloseTo(score, 8);
    }
  });
});

describe("marks a human tapped", () => {
  it("sorts them, so tapping out of order is not an error", () => {
    const built = alignmentOf([at(12, 8), at(0, 0), at(4, 4)]);
    expect(built.points.map((p) => p.recordingSeconds)).toEqual([0, 4, 12]);
  });

  it("drops a mark that goes backwards on the score clock", () => {
    // A mis-tap. Keeping it makes the playhead jump back mid-bar, and a user who sees
    // that concludes the feature is broken rather than that they mis-tapped.
    const built = alignmentOf([at(0, 0), at(4, 8), at(8, 4), at(12, 12)]);
    expect(built.points.map((p) => p.scoreSeconds)).toEqual([0, 8, 12]);
  });

  it("guarantees both clocks increase, whatever it is given", () => {
    const built = alignmentOf([at(5, 5), at(5, 9), at(1, 20), at(3, 1)]);
    for (let i = 1; i < built.points.length; i += 1) {
      expect(built.points[i]!.recordingSeconds).toBeGreaterThan(built.points[i - 1]!.recordingSeconds);
      expect(built.points[i]!.scoreSeconds).toBeGreaterThan(built.points[i - 1]!.scoreSeconds);
    }
  });

  it("lets a second tap at the same moment correct the first", () => {
    const built = alignmentOf([at(4, 4), at(4, 6)]);
    expect(built.points).toEqual([at(4, 6)]);
  });

  it("ignores nonsense rather than propagating it", () => {
    const built = alignmentOf([at(Number.NaN, 1), at(2, Number.POSITIVE_INFINITY), at(-1, -1), at(3, 3)]);
    expect(built.points).toEqual([at(3, 3)]);
  });

  it("adds a mark to an existing alignment", () => {
    const built = withPoint(alignmentOf([at(0, 0), at(8, 8)]), at(4, 5));
    expect(built.points.map((p) => p.scoreSeconds)).toEqual([0, 5, 8]);
  });

  it("removes the mark nearest a moment, for undoing the last tap", () => {
    const built = withoutPointNear(alignmentOf([at(0, 0), at(4, 4), at(8, 8)]), 4.4);
    expect(built.points.map((p) => p.recordingSeconds)).toEqual([0, 8]);
  });

  it("removing from an empty alignment is not an error", () => {
    expect(withoutPointNear(IDENTITY, 3).points).toEqual([]);
  });
});

describe("finding a mis-tap", () => {
  it("names the mark that ends a stretch wildly out of step", () => {
    // A mis-tap keeps the alignment monotonic, so nothing complains: the score simply
    // lurches over one bar. This is the difference between a user who can fix their
    // marks and one who gives up.
    const lurching = alignmentOf([at(0, 0), at(4, 4), at(8, 8), at(9, 20), at(13, 24)]);
    expect(suspectPoints(lurching)).toEqual([3]);
  });

  it("says nothing about an alignment that is merely expressive", () => {
    const rubato = alignmentOf([at(0, 0), at(4, 4), at(9, 8), at(13, 11), at(17, 15)]);
    expect(suspectPoints(rubato)).toEqual([]);
  });

  it("says nothing when there is too little to compare against", () => {
    // Three marks give two stretches, and one of two cannot be the odd one out.
    expect(suspectPoints(alignmentOf([at(0, 0), at(1, 8), at(9, 9)]))).toEqual([]);
  });
});
