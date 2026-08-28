/**
 * The key's degrees, as a legend for the number row on a staff with no frets.
 *
 * Same argument as the kit strip: on a guitar staff the digits are self-evident because
 * they *are* the frets, and on a piano staff nothing says that 5 is the dominant of the
 * bar's key. It also shows which pitch each degree lands on in the caret's octave, which
 * is the part a writer actually needs — "5" is abstract, "G4" is where the note goes.
 */
import { color, font, typeScale } from "@cubscore/design";
import { rowForDegree, rowLabel, rowPitch } from "@cubscore/core";
import type { EditorController } from "./useEditor";

const DEGREES = [1, 2, 3, 4, 5, 6, 7];

export function DegreeStrip({ e }: { e: EditorController }) {
  if (!e.canEnterPitches) return null;
  const key = e.keyAtCursor;
  const sounding = new Set((e.currentBeat?.notes ?? []).map((n) => Math.round(n.pitch)));

  return (
    <div
      data-degree-strip=""
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        alignItems: "center",
        marginTop: 8,
        fontFamily: font.mono,
        fontSize: typeScale.xs,
      }}
    >
      <span style={{ color: color.textDim, marginRight: 4 }}>
        DEGREES · {key.fifths === 0 && key.mode === "major" ? "C major" : `${key.mode}, ${key.fifths} fifths`}
      </span>
      {DEGREES.map((degree) => {
        const row = rowForDegree(e.cursor.string, degree);
        const label = rowLabel(row, key);
        const atCaret = e.caretDegree === degree;
        // The pitch this degree would write, in the caret's own octave, so the strip
        // moves with the caret instead of describing a fixed octave.
        const on = sounding.has(rowPitch(row, key));
        return (
          <span
            key={degree}
            data-degree={degree}
            data-degree-pitch={label}
            data-degree-on={on ? "true" : "false"}
            data-degree-caret={atCaret ? "true" : "false"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 6px",
              borderRadius: 6,
              border: `1px solid ${atCaret ? color.accent : color.hairline}`,
              background: on ? color.raised : "transparent",
              color: on ? color.text : color.textDim,
            }}
          >
            <strong style={{ color: atCaret ? color.accent : color.textDim }}>{degree}</strong>
            {label}
            {on && <span aria-hidden style={{ color: color.accent }}>●</span>}
          </span>
        );
      })}
      <span style={{ color: color.textDim, marginLeft: 6 }}>arrows change octave</span>
    </div>
  );
}
