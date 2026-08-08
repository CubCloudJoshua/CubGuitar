/**
 * The chart's chords as fingering diagrams, drawn by CubScore.
 *
 * Every diagram is computed, not looked up: `voicings()` solves shapes from the track's
 * actual tuning and capo, so the pictures are right in DADGAD, drop D, or capo 3 — the
 * exact place a dictionary of standard-tuning shapes goes quietly wrong. This is also
 * the second piece of engraving the platform draws for itself (the fretboard reader was
 * the first): a grid, dots, and open/mute marks, in SVG we own end to end.
 *
 * Shown while editing, only when the chart has symbols, and only the distinct ones in
 * order of first appearance: the strip is a legend for this song, not a chord book.
 */
import { useMemo } from "react";
import { color, font, typeScale } from "@cubscore/design";
import { parseChord, voicings, type Instrument, type Voicing } from "@cubscore/core";
import type { EditorController } from "./useEditor";

/** Diagram geometry, in SVG units. Five fret rows reaches every open shape. */
const STRING_GAP = 9;
const FRET_GAP = 11;
const FRETS_SHOWN = 4;
const TOP = 14;

function Diagram({ name, voicing, strings }: { name: string; voicing: Voicing; strings: number }) {
  const width = (strings - 1) * STRING_GAP;
  // The window starts at the shape's position so a barre at 7 is drawn at 7, labelled,
  // rather than off the bottom of an open-position grid.
  const base = voicing.position <= 1 ? 1 : voicing.position;
  const height = TOP + FRETS_SHOWN * FRET_GAP;

  return (
    <figure data-chord-diagram={name} style={{ margin: 0, textAlign: "center" }}>
      <svg width={width + 18} height={height + 4} role="img" aria-label={`${name} chord diagram`}>
        <g transform="translate(12, 0)">
          {/* The nut is a thick line only when the window starts there; anywhere else
              the fret number says where you are. */}
          {base === 1 ? (
            <rect x={-0.5} y={TOP - 2} width={width + 1} height={2.5} fill={color.text} />
          ) : (
            <text x={-4} y={TOP + FRET_GAP * 0.75} textAnchor="end" fontSize={7} fill={color.textDim} fontFamily={font.mono}>
              {base}
            </text>
          )}
          {Array.from({ length: FRETS_SHOWN + 1 }, (_, f) => (
            <line key={`f${f}`} x1={0} y1={TOP + f * FRET_GAP} x2={width} y2={TOP + f * FRET_GAP} stroke={color.hairline} />
          ))}
          {Array.from({ length: strings }, (_, i) => (
            <line key={`s${i}`} x1={i * STRING_GAP} y1={TOP} x2={i * STRING_GAP} y2={TOP + FRETS_SHOWN * FRET_GAP} stroke={color.hairline} />
          ))}
          {voicing.frets.map((fret, stringIndex) => {
            // frets[] is string 1 (highest) first; drawn leftmost-lowest like every
            // chord book, so string 1 is the rightmost line.
            const x = (strings - 1 - stringIndex) * STRING_GAP;
            if (fret < 0) {
              return (
                <text key={stringIndex} x={x} y={TOP - 4} textAnchor="middle" fontSize={7} fill={color.textDim} fontFamily={font.mono}>
                  ×
                </text>
              );
            }
            if (fret === 0) {
              return <circle key={stringIndex} cx={x} cy={TOP - 6.5} r={2.4} fill="none" stroke={color.text} strokeWidth={1} />;
            }
            const row = fret - base;
            if (row < 0 || row >= FRETS_SHOWN) return null;
            return <circle key={stringIndex} cx={x} cy={TOP + row * FRET_GAP + FRET_GAP / 2} r={3.1} fill={color.accent} />;
          })}
        </g>
      </svg>
      <figcaption style={{ fontFamily: font.mono, fontSize: typeScale.xs, color: color.text }}>{name}</figcaption>
    </figure>
  );
}

/** Distinct chart symbols in order of first appearance, solved on this instrument. */
function chartDiagrams(e: EditorController): Array<{ name: string; voicing: Voicing | null }> {
  const track = e.score.tracks[e.cursor.track];
  if (!track || track.instrument.kind !== "fretted") return [];
  const instrument: Instrument = track.instrument;
  const seen = new Set<string>();
  const out: Array<{ name: string; voicing: Voicing | null }> = [];
  for (const bar of track.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.chord === undefined || seen.has(beat.chord)) continue;
        seen.add(beat.chord);
        const parsed = parseChord(beat.chord);
        out.push({ name: beat.chord, voicing: parsed ? (voicings(parsed, instrument, 1)[0] ?? null) : null });
      }
    }
  }
  return out;
}

export function ChordDiagrams({ e }: { e: EditorController }) {
  // Recomputed only when the document changes; a caret move costs nothing here.
  const diagrams = useMemo(() => chartDiagrams(e), [e.score, e.cursor.track]);
  if (diagrams.length === 0) return null;
  const strings =
    e.score.tracks[e.cursor.track]?.instrument.kind === "fretted"
      ? (e.score.tracks[e.cursor.track]!.instrument as { tuning: number[] }).tuning.length
      : 6;

  return (
    <div
      data-chord-diagrams=""
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-end",
        padding: "4px 12px 2px",
        overflowX: "auto",
        borderBottom: `1px solid ${color.hairline}`,
      }}
    >
      {diagrams.map(({ name, voicing }) =>
        voicing ? (
          <Diagram key={name} name={name} voicing={voicing} strings={strings} />
        ) : (
          // A symbol the grammar cannot read still belongs to the song; shown by name
          // with no picture, because inventing a shape for it would be a wrong picture.
          <figure key={name} data-chord-diagram={name} style={{ margin: 0 }}>
            <figcaption style={{ fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}>{name}</figcaption>
          </figure>
        ),
      )}
    </div>
  );
}
