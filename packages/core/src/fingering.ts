/**
 * Where to put your hand.
 *
 * Every pitch is playable in several places on a fretted instrument, and choosing
 * among them is not a lookup — it is the difference between a part a person can
 * play and a part that is technically correct and physically absurd. "The lowest
 * fret that reaches it" is the obvious rule and it is wrong: it sends the hand
 * from fret 12 to fret 2 and back between consecutive notes, because it decides
 * each note without reference to the one before.
 *
 * So this is a shortest path rather than a mapping. Each chord is scored against
 * the hand position it would leave you in, and the sequence with the least total
 * cost wins. Movement, stretch, and open strings are the terms that matter; the
 * weights are stated below and are meant to be argued with.
 *
 * Four things need it, which is why it is here and not in any of them:
 *
 * - The fretboard reader, for notes imported from a pitched staff that carry no
 *   fingering. It had a naive version inline, and it produced exactly the jumping
 *   this replaces.
 * - MIDI import (INTEROP.md §1.2), where nothing arrives with a string number.
 * - MusicXML import, for parts that are pitches rather than tablature.
 * - Arranging a piano or vocal line for guitar, which is the same operation with
 *   a different name and the reason it is worth doing well.
 *
 * What it does not model: which finger, barre chords, thumb-over, or the fact that
 * a guitarist will happily play something "unplayable" if the alternative sounds
 * worse. It is a good default, not a teacher.
 */
import type { Instrument } from "./score.js";

export interface FretPosition {
  /** 1-based, string 1 is the highest. */
  string: number;
  fret: number;
}

export interface FingeringWeights {
  /** Cost per fret the hand moves between chords. The dominant term. */
  movement: number;
  /** Cost per fret of span beyond `comfortableStretch`, within one chord. */
  stretch: number;
  /** Cost per fret of height, so a low position wins when nothing else decides. */
  height: number;
  /**
   * Subtracted per open string.
   *
   * And an open string costs no *movement* either, wherever the hand is: it needs
   * no left hand at all, so a guitarist playing at the twelfth fret will happily
   * take a free open E as a pedal note without moving. That is deliberate and it
   * surprised the author of this file, whose first test asserted the opposite.
   */
  openBonus: number;
  /** Frets a hand spans without complaint. */
  comfortableStretch: number;
  /** Frets a hand cannot span at all; assignments beyond this are not considered. */
  maxStretch: number;
}

export const DEFAULT_WEIGHTS: FingeringWeights = {
  // Movement dominates because it is what makes a part unplayable at tempo: a
  // four-fret stretch is awkward, a ten-fret jump between eighth notes is not
  // possible.
  movement: 3,
  stretch: 2.5,
  height: 0.35,
  openBonus: 1.2,
  comfortableStretch: 4,
  maxStretch: 6,
};

/** Every place a pitch can be played, highest string first. */
export function positionsFor(instrument: Instrument, pitch: number): FretPosition[] {
  if (instrument.kind !== "fretted") return [];
  const { tuning, frets, capo } = instrument;
  const out: FretPosition[] = [];
  for (const [index, open] of tuning.entries()) {
    const fret = pitch - open - capo;
    // A capo makes everything below it unreachable, which is what `fret >= 0`
    // means once the capo has been subtracted.
    if (fret >= 0 && fret <= frets) out.push({ string: index + 1, fret });
  }
  return out;
}

/** The hand position an assignment implies: the lowest fretted fret, or null. */
function anchorOf(positions: readonly FretPosition[]): number | null {
  const fretted = positions.filter((p) => p.fret > 0).map((p) => p.fret);
  return fretted.length > 0 ? Math.min(...fretted) : null;
}

function spanOf(positions: readonly FretPosition[]): number {
  const fretted = positions.filter((p) => p.fret > 0).map((p) => p.fret);
  if (fretted.length < 2) return 0;
  return Math.max(...fretted) - Math.min(...fretted);
}

/**
 * Every way to play a set of simultaneous pitches, one string each.
 *
 * Enumerated rather than solved because the space is tiny — at most six notes with
 * at most six positions apiece — and pruned as it goes: an assignment already over
 * the maximum stretch cannot be rescued by the notes still to be placed.
 *
 * A chord some of whose notes cannot be reached at all yields the assignments of
 * the notes that can. Dropping the chord entirely because one note is out of range
 * loses music that is playable.
 */
function chordAssignments(
  instrument: Instrument,
  pitches: readonly number[],
  weights: FingeringWeights,
): FretPosition[][] {
  const options = pitches.map((pitch) => positionsFor(instrument, pitch));
  const results: FretPosition[][] = [];

  const walk = (index: number, chosen: FretPosition[], usedStrings: Set<number>) => {
    if (index === options.length) {
      if (chosen.length > 0) results.push([...chosen]);
      return;
    }
    const here = options[index] ?? [];
    // A pitch nothing can reach is skipped rather than failing the whole chord.
    if (here.length === 0) {
      walk(index + 1, chosen, usedStrings);
      return;
    }
    let placedAny = false;
    for (const position of here) {
      if (usedStrings.has(position.string)) continue;
      const next = [...chosen, position];
      if (spanOf(next) > weights.maxStretch) continue;
      placedAny = true;
      usedStrings.add(position.string);
      walk(index + 1, next, usedStrings);
      usedStrings.delete(position.string);
    }
    // Every string this pitch could use is taken, or every option overstretched.
    // Continuing without it beats returning nothing.
    if (!placedAny) walk(index + 1, chosen, usedStrings);
  };

  walk(0, [], new Set());
  // Assignments that place more of the chord are strictly better than ones that
  // place less, so drop the short ones rather than letting cost decide — a
  // one-note assignment always has less stretch than the three-note chord.
  const most = Math.max(0, ...results.map((r) => r.length));
  return results.filter((r) => r.length === most);
}

/** What an assignment costs on its own, before movement is considered. */
function staticCost(positions: readonly FretPosition[], weights: FingeringWeights): number {
  const span = spanOf(positions);
  const overStretch = Math.max(0, span - weights.comfortableStretch);
  const anchor = anchorOf(positions);
  const open = positions.filter((p) => p.fret === 0).length;
  return (
    overStretch * weights.stretch +
    (anchor ?? 0) * weights.height -
    open * weights.openBonus
  );
}

export interface FingeringResult {
  /**
   * One entry per input chord: the positions chosen, in the order the pitches were
   * given. A pitch nothing could reach has no entry, so a chord's array can be
   * shorter than its pitch list.
   */
  chords: FretPosition[][];
  /** Pitches no string could reach, so a caller can report rather than lose them. */
  unreachable: number[];
  /** Total cost, for comparing weightings rather than for display. */
  cost: number;
}

/**
 * Fingering for a sequence of chords, chosen together.
 *
 * A dynamic program over hand position: for each chord, the best way to arrive at
 * each of its candidate assignments is the cheapest predecessor plus the movement
 * between them. Linear in the number of chords and quadratic in the candidates per
 * chord, which is a handful.
 *
 * Deterministic: ties are broken by the order `positionsFor` returns, which is
 * highest string first. That matters more than which tie-break is chosen — the same
 * part must finger the same way every time, or a re-import silently rewrites
 * someone's tab.
 */
export function fingerSequence(
  instrument: Instrument,
  chords: readonly (readonly number[])[],
  weights: FingeringWeights = DEFAULT_WEIGHTS,
): FingeringResult {
  const unreachable: number[] = [];
  if (instrument.kind !== "fretted") {
    return { chords: chords.map(() => []), unreachable: chords.flatMap((c) => [...c]), cost: 0 };
  }

  for (const chord of chords) {
    for (const pitch of chord) {
      if (positionsFor(instrument, pitch).length === 0) unreachable.push(pitch);
    }
  }

  /** Best path ending in a given candidate, per chord. */
  interface Node {
    positions: FretPosition[];
    cost: number;
    anchor: number | null;
    from: number;
  }

  let previous: Node[] = [];
  const layers: Node[][] = [];

  for (const chord of chords) {
    const candidates = chordAssignments(instrument, chord, weights);
    const layer: Node[] = [];

    if (candidates.length === 0) {
      // Nothing in this chord is playable. The hand does not move, so the previous
      // layer carries straight through — otherwise a single unreachable note would
      // reset the position and make everything after it jump.
      const best = cheapest(previous);
      layer.push({ positions: [], cost: best?.cost ?? 0, anchor: best?.anchor ?? null, from: best?.from ?? -1 });
      layers.push(layer);
      previous = layer;
      continue;
    }

    for (const positions of candidates) {
      const anchor = anchorOf(positions);
      const own = staticCost(positions, weights);
      if (previous.length === 0) {
        layer.push({ positions, cost: own, anchor, from: -1 });
        continue;
      }
      let bestCost = Infinity;
      let bestFrom = -1;
      for (const [index, node] of previous.entries()) {
        // Open-string-only chords leave the hand where it was, so a null anchor on
        // either side costs no movement rather than counting as a move to fret 0.
        const move =
          anchor === null || node.anchor === null ? 0 : Math.abs(anchor - node.anchor) * weights.movement;
        const total = node.cost + own + move;
        if (total < bestCost) {
          bestCost = total;
          bestFrom = index;
        }
      }
      layer.push({ positions, cost: bestCost, anchor: anchor ?? cheapestAnchor(previous, bestFrom), from: bestFrom });
    }

    layers.push(layer);
    previous = layer;
  }

  // Walk back from the cheapest final node.
  const out: FretPosition[][] = [];
  let index = layers.length - 1;
  let node = cheapest(previous);
  while (index >= 0 && node) {
    out.unshift(node.positions);
    const from = node.from;
    index -= 1;
    node = index >= 0 ? layers[index]?.[from] ?? cheapest(layers[index] ?? []) : undefined;
  }
  // A chord whose layer was empty still needs a slot, so the result lines up with
  // the input one-to-one.
  while (out.length < chords.length) out.unshift([]);

  return { chords: out, unreachable, cost: cheapest(previous)?.cost ?? 0 };
}

function cheapest<T extends { cost: number }>(nodes: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const node of nodes) if (!best || node.cost < best.cost) best = node;
  return best;
}

/** The hand's position carried forward when a chord is all open strings. */
function cheapestAnchor(previous: readonly { anchor: number | null }[], from: number): number | null {
  return previous[from]?.anchor ?? null;
}

/**
 * Fingering for one pitch, given where the hand already is.
 *
 * The cheap case, for a caller placing notes one at a time rather than solving a
 * phrase — a reader drawing what is on screen, or note entry from an instrument
 * that reports pitch but not string. `near` is the fret the hand is at; without it
 * this is "the lowest playable position", which is the rule this module exists to
 * improve on, so pass it when you have it.
 */
export function fingerOne(
  instrument: Instrument,
  pitch: number,
  near: number | null = null,
  weights: FingeringWeights = DEFAULT_WEIGHTS,
): FretPosition | null {
  const options = positionsFor(instrument, pitch);
  if (options.length === 0) return null;
  let best: FretPosition | null = null;
  let bestCost = Infinity;
  for (const option of options) {
    const move = near === null || option.fret === 0 ? 0 : Math.abs(option.fret - near) * weights.movement;
    const cost = move + option.fret * weights.height - (option.fret === 0 ? weights.openBonus : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = option;
    }
  }
  return best;
}
