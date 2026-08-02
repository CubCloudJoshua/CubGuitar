/**
 * Which bar an edit touched.
 *
 * A renderer that is told "something changed" has to re-lay-out the whole score. Told
 * "nothing before bar 150 changed", it can keep what it already drew. That is the
 * difference between a keystroke costing two seconds on a real song and costing
 * nothing, so the question is worth answering precisely.
 *
 * Answering it is almost free, and the reason is a property the op log has had since
 * the beginning: `applyOp` returns the *same object* for anything it did not change.
 * Unchanged bars are reference-identical across an edit, so finding the first changed
 * one is a walk of pointer comparisons rather than a comparison of music. On a
 * 274-bar score that is a few hundred `===` checks, which is nothing next to the
 * render it saves.
 *
 * The invariant is load-bearing here in a way it was not before, so the tests beside
 * this file check it directly: if `apply.ts` ever starts rebuilding untouched bars,
 * this returns 0 for every edit, every render becomes a full one, and the only symptom
 * is that the editor gets slow again. That is exactly the kind of regression that goes
 * unnoticed, which is why it is asserted rather than assumed.
 */
import type { Score, Track } from "./score.js";

/**
 * The lowest bar index that differs between two versions of a score, or null if none
 * does.
 *
 * Across all tracks, because a renderer lays out master bars and a change to any
 * track's bar 12 moves bar 12 for every staff.
 *
 * A change to something that is not a bar — the title, a track's instrument, a track
 * added or removed — returns 0, because the layout of the whole score can depend on it.
 * Correct and pessimistic, which is the right way round: a wrong answer here does not
 * draw the wrong notes, it draws the right ones too slowly, and only if it is too high.
 */
export function firstChangedBar(before: Score, after: Score): number | null {
  if (before === after) return null;
  // A different set of tracks changes the page from the top.
  if (before.tracks.length !== after.tracks.length) return 0;

  let earliest: number | null = null;
  for (const [i, track] of after.tracks.entries()) {
    const previous = before.tracks[i];
    if (previous === track) continue;
    if (!previous) return 0;
    // Same track, different object: something inside it moved. Anything other than
    // its bars — a rename, a retuning — can change the whole layout.
    if (previous.id !== track.id || previous.name !== track.name || previous.instrument !== track.instrument) {
      return 0;
    }
    const bar = firstChangedBarIn(previous, track);
    if (bar === null) continue;
    if (bar === 0) return 0;
    earliest = earliest === null ? bar : Math.min(earliest, bar);
  }
  // Every track is identical, so whatever changed was not in a bar: the title, the
  // revision counter, the artist. None of those move a note, but the header is drawn
  // from some of them, so the safe answer is the top of the score.
  return earliest ?? 0;
}

/** The first bar of a track that is not the same object it was. */
function firstChangedBarIn(before: Track, after: Track): number | null {
  const count = Math.max(before.bars.length, after.bars.length);
  for (let i = 0; i < count; i += 1) {
    if (before.bars[i] !== after.bars[i]) return i;
  }
  return null;
}
