/**
 * A recording locked to the score.
 *
 * The thing a guitarist actually does with a tab is play it against the record, and
 * every product that supports that well is built around it: Soundslice's whole premise
 * is notation synchronised to a video, and Guitar Pro 8 added an audio track for the
 * same reason. Notation alone tells you the notes; the recording tells you the feel,
 * and a score that scrolls with the record is how somebody learns a part in an evening
 * rather than a week.
 *
 * What makes it possible is a map between two clocks: the recording's, and the score's.
 * They do not run at the same rate — the record is at whatever tempo the band played,
 * the score is at whatever tempo somebody typed — and they do not start together.
 *
 * The map is a list of points a human marks by tapping along, with straight lines
 * between them. Straight lines rather than a curve on purpose: a curve fitted through
 * tap points invents accelerations nobody played, and between two marks a band's tempo
 * really is close to constant. Where a performance moves, the answer is more points and
 * not a cleverer interpolation, and that is a thing a user can do something about.
 *
 * Pure, and with no notion of an audio element or a playhead, so the mapping can be
 * tested exactly rather than watched.
 */

export interface SyncPoint {
  /** A moment in the recording, in seconds from its start. */
  recordingSeconds: number;
  /** The moment in the score it lines up with, in seconds from the score's start. */
  scoreSeconds: number;
}

export interface Alignment {
  /** Increasing in both clocks. Build one with `alignmentOf`, which guarantees that. */
  points: readonly SyncPoint[];
}

/** No marks at all: the recording and the score share a clock. */
export const IDENTITY: Alignment = { points: [] };

/**
 * An alignment from marks in any order, with the contradictions removed.
 *
 * Both clocks must increase together. A pair of marks that goes backwards in either one
 * describes a recording that plays the score in reverse, and the visible result is a
 * playhead that jumps back mid-bar and a user who concludes the feature is broken. So
 * a mark that does not advance on both clocks is dropped rather than kept: it came from
 * a mis-tap, and the marks around it are still good.
 *
 * Later marks win a tie on the recording clock, because tapping the same instant twice
 * is a correction.
 */
export function alignmentOf(points: readonly SyncPoint[]): Alignment {
  const clean = points
    .filter((p) => Number.isFinite(p.recordingSeconds) && Number.isFinite(p.scoreSeconds))
    .filter((p) => p.recordingSeconds >= 0 && p.scoreSeconds >= 0)
    // Stable by recording time, and a later entry replaces an equal one below.
    .slice()
    .sort((a, b) => a.recordingSeconds - b.recordingSeconds);

  const out: SyncPoint[] = [];
  for (const point of clean) {
    const last = out.at(-1);
    if (last && point.recordingSeconds === last.recordingSeconds) {
      out[out.length - 1] = point;
      continue;
    }
    // Must advance on the score clock too. A mark that does not is a mis-tap.
    if (last && point.scoreSeconds <= last.scoreSeconds) continue;
    out.push(point);
  }
  return { points: out };
}

/** Adds or replaces a mark, keeping the alignment consistent. */
export function withPoint(alignment: Alignment, point: SyncPoint): Alignment {
  return alignmentOf([...alignment.points, point]);
}

/** Removes the mark nearest a moment in the recording, for undoing a mis-tap. */
export function withoutPointNear(alignment: Alignment, recordingSeconds: number): Alignment {
  if (alignment.points.length === 0) return alignment;
  let nearest = 0;
  for (const [i, p] of alignment.points.entries()) {
    const best = alignment.points[nearest]!;
    if (Math.abs(p.recordingSeconds - recordingSeconds) < Math.abs(best.recordingSeconds - recordingSeconds)) {
      nearest = i;
    }
  }
  return { points: alignment.points.filter((_, i) => i !== nearest) };
}

/** The straight line through two marks, as a rate and an intercept. */
function segment(a: SyncPoint, b: SyncPoint): { rate: number; at: (recording: number) => number } {
  const span = b.recordingSeconds - a.recordingSeconds;
  // Guarded, though `alignmentOf` makes it impossible: a zero span would be a
  // division by zero and an infinite tempo.
  const rate = span > 0 ? (b.scoreSeconds - a.scoreSeconds) / span : 1;
  return { rate, at: (recording) => a.scoreSeconds + (recording - a.recordingSeconds) * rate };
}

/**
 * Where in the score a moment of the recording lands.
 *
 * Outside the marked range the outermost line continues rather than flattening. A
 * flat extension would freeze the playhead before the first mark and after the last,
 * which is exactly where a user is most likely to be looking — the count-in and the
 * final chord. Continuing the line is a guess, but it is the same guess the marks
 * either side of it already committed to.
 */
export function scoreTimeAt(alignment: Alignment, recordingSeconds: number): number {
  const points = alignment.points;
  if (points.length === 0) return Math.max(0, recordingSeconds);
  if (points.length === 1) {
    const only = points[0]!;
    return Math.max(0, only.scoreSeconds + (recordingSeconds - only.recordingSeconds));
  }
  if (recordingSeconds <= points[0]!.recordingSeconds) {
    return Math.max(0, segment(points[0]!, points[1]!).at(recordingSeconds));
  }
  for (let i = 1; i < points.length; i += 1) {
    if (recordingSeconds <= points[i]!.recordingSeconds) {
      return Math.max(0, segment(points[i - 1]!, points[i]!).at(recordingSeconds));
    }
  }
  const last = points.length - 1;
  return Math.max(0, segment(points[last - 1]!, points[last]!).at(recordingSeconds));
}

/**
 * Where in the recording a moment of the score lands: the inverse.
 *
 * Needed as much as the forward direction, because seeking works the other way round.
 * A user clicks a bar in the notation and the recording has to jump to it.
 */
export function recordingTimeAt(alignment: Alignment, scoreSeconds: number): number {
  const points = alignment.points;
  if (points.length === 0) return Math.max(0, scoreSeconds);
  if (points.length === 1) {
    const only = points[0]!;
    return Math.max(0, only.recordingSeconds + (scoreSeconds - only.scoreSeconds));
  }
  const inverse = (a: SyncPoint, b: SyncPoint): number => {
    const span = b.scoreSeconds - a.scoreSeconds;
    const rate = span > 0 ? (b.recordingSeconds - a.recordingSeconds) / span : 1;
    return a.recordingSeconds + (scoreSeconds - a.scoreSeconds) * rate;
  };
  if (scoreSeconds <= points[0]!.scoreSeconds) return Math.max(0, inverse(points[0]!, points[1]!));
  for (let i = 1; i < points.length; i += 1) {
    if (scoreSeconds <= points[i]!.scoreSeconds) return Math.max(0, inverse(points[i - 1]!, points[i]!));
  }
  const last = points.length - 1;
  return Math.max(0, inverse(points[last - 1]!, points[last]!));
}

/**
 * How fast the score is running against the recording at a moment.
 *
 * One means they agree. Two means the recording covers the score twice as fast, so the
 * band played it at double the written tempo. Worth surfacing: it is the number that
 * tells a user their marks are wrong, because a real performance does not change tempo
 * by a factor of three between two bars.
 */
export function speedAt(alignment: Alignment, recordingSeconds: number): number {
  const points = alignment.points;
  if (points.length < 2) return 1;
  if (recordingSeconds <= points[0]!.recordingSeconds) return segment(points[0]!, points[1]!).rate;
  for (let i = 1; i < points.length; i += 1) {
    if (recordingSeconds <= points[i]!.recordingSeconds) return segment(points[i - 1]!, points[i]!).rate;
  }
  const last = points.length - 1;
  return segment(points[last - 1]!, points[last]!).rate;
}

/**
 * Marks whose local speed is wildly out of step with the rest.
 *
 * A mis-tap does not announce itself: the alignment stays monotonic and the score simply
 * lurches over one bar. Comparing each segment against the median of the others finds
 * the lurch, which is the difference between a user who can fix their marks and one who
 * gives up. Returns indices into `points`, naming the mark that *ends* each suspect
 * segment, because that is the one that was tapped in the wrong place.
 */
export function suspectPoints(alignment: Alignment, tolerance = 2.5): number[] {
  const points = alignment.points;
  if (points.length < 4) return [];
  const rates = points.slice(1).map((p, i) => segment(points[i]!, p).rate);
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median <= 0) return [];
  return rates.flatMap((rate, i) =>
    rate > median * tolerance || rate < median / tolerance ? [i + 1] : [],
  );
}
