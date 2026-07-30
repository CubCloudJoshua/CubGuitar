/**
 * The fretboard reader: an isometric view of the neck with the music coming at
 * you.
 *
 * Notation is the right way to *write* music and a poor way to learn a part by
 * ear. A tab staff tells you which fret; it does not tell you where your hand
 * goes. This draws the neck itself, in parallel projection, with each note as a
 * marker on the string and fret it is actually played on, sliding toward a strike
 * line as playback advances.
 *
 * It is also the first thing in this app that alphaTab does not draw. Every
 * position here is computed from @cubscore/core's timeline and the track's own
 * tuning — no bounds lookup, no engraved canvas, nothing measured off someone
 * else's render. That is the point as much as the view is: it demonstrates the
 * semantic model is complete enough to render from, which is the precondition for
 * everything in STANDALONE.md.
 *
 * Isometric, not perspective: parallel lines stay parallel and a fret is the same
 * width at the far end of the neck as at the near end. Perspective would look
 * more like a photograph and read worse, because the notes you have the least
 * time to prepare for would be the smallest.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { color, font, typeScale } from "@cubscore/design";
import {
  fingerSequence,
  mergeTies,
  type FretPosition,
  type Instrument,
  type TimedNote,
  type Timeline,
} from "@cubscore/core";

/**
 * The projection. Two vectors, one per axis of the neck, applied to (fret, string).
 *
 * `ALONG` runs up the neck toward the nut and doubles as the time axis, because
 * a note's distance from the strike line *is* how long you have before you play
 * it. `ACROSS` runs over the strings. Their angles are chosen so the neck reads
 * as a solid object rather than a flat grid: shallow enough that a 24-fret span
 * fits a wide screen, steep enough that the strings do not collapse onto one
 * another.
 */
const ALONG = { x: 0.42, y: -1 };
const ACROSS = { x: 1, y: 0.30 };

/**
 * How wide a string spacing may get, and how narrow before the view gives up on
 * spreading and just scrolls the neck off the side. Six strings 60px apart is
 * already a neck wider than a real one looks from playing position.
 */
const MAX_STRING_GAP = 58;
const MIN_STRING_GAP = 16;
/** Breathing room around the neck, for the bar numbers and the fret markers. */
const MARGIN = 46;
/**
 * How far ahead the reader shows, and how far behind it keeps notes visible.
 *
 * Asymmetric on purpose. Ahead is preparation time — about two bars at a moderate
 * tempo, which is as much as anyone reads ahead. Behind is only long enough to see
 * what you just played, because a note you have already missed is not information.
 */
const LOOKAHEAD_SECONDS = 4;
const LOOKBEHIND_SECONDS = 0.9;

interface Point {
  x: number;
  y: number;
}

/**
 * The neck, sized to the panel it is drawn in.
 *
 * The two spans are solved rather than picked. Projecting a span `A` along the
 * neck and `C` across it gives a bounding box
 *
 *   width  = |ALONG.x| * A + |ACROSS.x| * C
 *   height = |ALONG.y| * A + |ACROSS.y| * C
 *
 * so asking for a box that fills the panel is two equations in two unknowns.
 * Two earlier versions picked constants instead and both were wrong for the
 * space they got: 150px per second put four seconds of neck 600px up a 333px
 * panel, so everything past the second bar was projected outside the viewBox and
 * silently not drawn; a fixed 26px string gap then left the neck a 350px sliver
 * down the middle of a 1278px panel with the strings bunched together.
 */
function geometry(width: number, height: number, strings: number) {
  const usableW = Math.max(160, width - MARGIN * 2);
  const usableH = Math.max(160, height - MARGIN * 2);
  const spanSeconds = LOOKAHEAD_SECONDS + LOOKBEHIND_SECONDS;

  // Solve for the across-span first; the along-span follows from the height.
  const denom = ACROSS.x - (ALONG.x * ACROSS.y) / Math.abs(ALONG.y);
  let across = (usableW - (ALONG.x * usableH) / Math.abs(ALONG.y)) / denom;
  // A tall narrow panel can want a negative or tiny across-span: there is no
  // solution that both fills the box and keeps the strings apart, and legible
  // strings matter more than filling the box.
  across = Math.min(
    Math.max(across, MIN_STRING_GAP * (strings - 1)),
    MAX_STRING_GAP * (strings - 1),
  );
  const along = Math.max(120, (usableH - ACROSS.y * across) / Math.abs(ALONG.y));

  const depthScale = along / spanSeconds;
  const gap = strings > 1 ? across / (strings - 1) : 0;
  // Centred rather than pinned left, because the across-span is clamped: six
  // strings 58px apart is as wide as a neck should look, so on a wide panel the
  // solved box is narrower than the space and hugging the left edge left the
  // right half of the reader empty.
  const drawnW = ALONG.x * along + ACROSS.x * across;
  const origin: Point = {
    x: Math.max(MARGIN, (width - drawnW) / 2) + ALONG.x * LOOKBEHIND_SECONDS * depthScale,
    y: height - MARGIN - LOOKBEHIND_SECONDS * depthScale - ACROSS.y * across,
  };
  return { depthScale, gap, origin };
}

function project(secondsAhead: number, stringIndex: number, g: ReturnType<typeof geometry>): Point {
  const along = secondsAhead * g.depthScale;
  const across = stringIndex * g.gap;
  return {
    x: g.origin.x + ALONG.x * along + ACROSS.x * across,
    y: g.origin.y + ALONG.y * along + ACROSS.y * across,
  };
}

/**
 * A note's marker size: scaled to the string spacing, so markers on neighbouring
 * strings never overlap, but the same at the far end of the neck as at the near
 * end. The projection is isometric — the only thing distance changes is opacity,
 * which is what makes the strike line read as where the music *is* rather than
 * merely as the nearest point.
 */
function markerRadius(gap: number): number {
  return Math.max(9, Math.min(20, gap * 0.4));
}

function opacityFor(secondsAhead: number): number {
  if (secondsAhead < 0) {
    // Behind the line: fading out, so what you just played is visible but not
    // competing with what is coming.
    return Math.max(0, 0.35 + (secondsAhead / LOOKBEHIND_SECONDS) * 0.35);
  }
  // Ahead: full at the line, thinning into the distance, never to nothing —
  // a note you cannot see is a note you cannot prepare for.
  return 1 - Math.min(0.62, (secondsAhead / LOOKAHEAD_SECONDS) * 0.62);
}

export interface IsoViewProps {
  timeline: Timeline;
  /** Playback position in seconds. The one number this view follows. */
  seconds: number;
  /**
   * The neck to draw, and to finger against.
   *
   * Not necessarily the selected track's own instrument. Reading a piano part on a
   * fretboard is a real thing to want — it is how a guitarist learns a keyboard
   * line — and it means the strings come from a *guitar* while the notes come from
   * the piano. Fingering the piano part against the piano's own instrument yields
   * nothing at all, because a piano has no strings to put a fret on, which is
   * exactly the bug this parameter exists to have fixed.
   */
  neck: Instrument;
  trackIndex: number;
  width: number;
  height: number;
}

/**
 * Fingering for notes that arrived without any — an imported pitched staff, a MIDI
 * file, anything that records pitch and not where a hand goes.
 *
 * Solved for the whole part at once by @cubscore/core's `fingerSequence`, not note
 * by note. This file used to guess the lowest playable position for each note
 * independently, which is the rule that sends a hand from fret 12 to fret 2 and
 * back between consecutive notes: every note individually reasonable and the
 * phrase unplayable. Moving the decision into core is what let the reader, MIDI
 * import and MusicXML import share one answer.
 *
 * Keyed by note id, so a caret drawn from this is the same one the exporter would
 * write.
 */
function inferFingering(notes: readonly TimedNote[], neck: Instrument): Map<string, FretPosition> {
  const needing = notes.filter((n) => n.string === undefined || n.fret === undefined);
  if (needing.length === 0) return new Map();
  // Grouped by onset, so notes that sound together are fingered as a chord rather
  // than as a sequence that happens to be simultaneous.
  const byTick = new Map<number, TimedNote[]>();
  for (const note of needing) {
    const group = byTick.get(note.startTicks) ?? [];
    group.push(note);
    byTick.set(note.startTicks, group);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  const groups = ticks.map((tick) => byTick.get(tick) ?? []);
  const { chords } = fingerSequence(
    neck,
    groups.map((group) => group.map((n) => n.pitch)),
  );

  const out = new Map<string, FretPosition>();
  for (const [index, group] of groups.entries()) {
    const placed = chords[index] ?? [];
    for (const [j, note] of group.entries()) {
      const position = placed[j];
      if (position) out.set(note.id, position);
    }
  }
  return out;
}

export function IsoView({ timeline: line, seconds, neck, trackIndex, width, height }: IsoViewProps) {
  const strings = neck.kind === "fretted" ? neck.tuning.length : 6;

  // The neck is anchored so the strike line sits in the lower left and the neck
  // runs up and to the right. Notes arrive from the top right.
  const g = useMemo(() => geometry(width, height, strings), [width, height, strings]);
  const markerR = markerRadius(g.gap);

  // Ties joined before anything is placed. A tie means hold the note, not play it
  // again, so the second half of a tied pair must not send a second marker at you
  // for a string that is already ringing.
  const sounding = useMemo(() => mergeTies(line.notes.filter((n) => n.trackIndex === trackIndex)), [
    line,
    trackIndex,
  ]);

  // Solved once per document rather than per frame: the fingering of a phrase does
  // not change as the playhead moves through it.
  const inferred = useMemo(() => inferFingering(sounding, neck), [sounding, neck]);

  const visible = useMemo(() => {
    const from = seconds - LOOKBEHIND_SECONDS;
    const to = seconds + LOOKAHEAD_SECONDS;
    return sounding.filter((n) => n.startSeconds >= from && n.startSeconds <= to);
  }, [sounding, seconds]);

  // Fret lines every second of lookahead, and a heavier one on each bar line, so
  // the neck has a rhythm to it rather than being a bare grid.
  const barLines = useMemo(
    () =>
      line.bars
        .map((b) => ({ bar: b.bar, ahead: b.startSeconds - seconds }))
        .filter((b) => b.ahead >= -LOOKBEHIND_SECONDS && b.ahead <= LOOKAHEAD_SECONDS),
    [line, seconds],
  );

  const stringEnd = (i: number, ahead: number) => project(ahead, i, g);

  return (
    <svg
      className="iso-surface"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Fretboard reader, ${strings} strings`}
      style={{ display: "block", background: color.bg }}
    >
      {/* The neck: one quad from the strike line to the far end of the lookahead. */}
      <polygon
        points={[
          stringEnd(0, -LOOKBEHIND_SECONDS),
          stringEnd(strings - 1, -LOOKBEHIND_SECONDS),
          stringEnd(strings - 1, LOOKAHEAD_SECONDS),
          stringEnd(0, LOOKAHEAD_SECONDS),
        ]
          .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
          .join(" ")}
        fill={color.raised}
        stroke={color.hairline}
        strokeWidth={1}
      />

      {/* Bar lines across the neck, labelled with the bar number as written. */}
      {barLines.map((b, i) => {
        const a = stringEnd(0, b.ahead);
        const z = stringEnd(strings - 1, b.ahead);
        return (
          <g key={`${b.bar}-${i}`} opacity={opacityFor(b.ahead)}>
            <line
              x1={a.x}
              y1={a.y}
              x2={z.x}
              y2={z.y}
              stroke={color.border}
              strokeWidth={1.5}
              data-iso-bar={b.bar}
            />
            <text
              x={a.x - 10}
              y={a.y + 4}
              textAnchor="end"
              fill={color.textFaint}
              fontFamily={font.mono}
              fontSize={typeScale.xs}
            >
              {b.bar + 1}
            </text>
          </g>
        );
      })}

      {/* The strings, running up the neck. */}
      {Array.from({ length: strings }, (_, i) => {
        const a = stringEnd(i, -LOOKBEHIND_SECONDS);
        const z = stringEnd(i, LOOKAHEAD_SECONDS);
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={z.x}
            y2={z.y}
            stroke="#555555"
            // String 1 is the thinnest, as on the instrument.
            strokeWidth={0.8 + i * 0.3}
            data-iso-string={i + 1}
          />
        );
      })}

      {/* The strike line: now. The one accent-coloured thing here, matching the
          playhead everywhere else in the app. */}
      <line
        x1={stringEnd(0, 0).x}
        y1={stringEnd(0, 0).y}
        x2={stringEnd(strings - 1, 0).x}
        y2={stringEnd(strings - 1, 0).y}
        stroke={color.accent}
        strokeWidth={2.5}
        data-iso-strike="1"
      />

      {/* The notes. Drawn furthest-first so a near note overlaps a far one. */}
      {[...visible]
        .sort((a, b) => b.startSeconds - a.startSeconds)
        .map((note) => {
          const placed =
            note.string !== undefined && note.fret !== undefined
              ? { string: note.string, fret: note.fret }
              : inferred.get(note.id);
          if (!placed) return null;
          const ahead = note.startSeconds - seconds;
          const at = project(ahead, placed.string - 1, g);
          const lit = ahead <= 0 && ahead + note.durationSeconds > 0;
          return (
            <g key={`${note.id}-${note.startSeconds.toFixed(3)}`} opacity={opacityFor(ahead)}>
              <circle
                cx={at.x}
                cy={at.y}
                r={markerR}
                fill={lit ? color.accent : color.raisedHigh}
                stroke={lit ? color.accentLive : color.border}
                strokeWidth={lit ? 2 : 1}
                data-iso-note={placed.fret}
                data-iso-note-string={placed.string}
                data-iso-lit={lit ? "1" : "0"}
              />
              <text
                x={at.x}
                y={at.y + 4}
                textAnchor="middle"
                fill={lit ? color.bg : color.text}
                fontFamily={font.mono}
                fontSize={typeScale.sm}
                fontWeight={700}
              >
                {placed.fret}
              </text>
            </g>
          );
        })}
    </svg>
  );
}

/**
 * Fills its container and keeps the reader sized to it.
 *
 * Measured rather than given a fixed viewBox because the projection is in pixels:
 * a neck scaled by an SVG viewBox would put the strings closer together on a
 * phone, which is the one thing that must not happen to a view whose job is
 * telling strings apart.
 */
export function IsoPanel({
  timeline: line,
  seconds,
  neck,
  trackIndex,
}: Omit<IsoViewProps, "width" | "height">) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setSize({ width: box.clientWidth, height: box.clientHeight });
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={boxRef}
      // Opaque and over the top: alphaTab's host stays mounted underneath,
      // because its api binds to one DOM node for its whole life and unmounting
      // it to show this would cost a full reload every time the view is toggled.
      style={{ position: "absolute", inset: 0, background: color.bg, zIndex: 5, overflow: "hidden" }}
    >
      {size.width > 0 && size.height > 0 && (
        <IsoView
          timeline={line}
          seconds={seconds}
          neck={neck}
          trackIndex={trackIndex}
          width={size.width}
          height={size.height}
        />
      )}
    </div>
  );
}
