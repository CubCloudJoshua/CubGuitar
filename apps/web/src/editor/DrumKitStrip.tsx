/**
 * The kit, as a legend for the number row.
 *
 * A drum staff has no strings and no frets, so nothing about it tells a writer that 2 is
 * the snare — on a guitar staff the digits are self-evident because they *are* the frets.
 * Without this the feature would be real and undiscoverable, which is the same as absent.
 *
 * Shown only while editing a percussion track. The caret's slot is highlighted, so the
 * arrows have somewhere visible to move and Delete has an obvious target; the voices
 * already in the caret's beat are marked, which makes the strip a readout of the beat as
 * well as a legend for the keyboard.
 */
import { color, font, typeScale } from "@cubscore/design";
import { DRUM_KIT } from "@cubscore/core";
import type { EditorController } from "./useEditor";

export function DrumKitStrip({ e }: { e: EditorController }) {
  if (!e.canEnterDrums) return null;
  const beat = e.currentBeat;
  const sounding = new Set((beat?.notes ?? []).map((n) => Math.round(n.pitch)));

  return (
    <div
      data-drum-kit=""
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
      <span style={{ color: color.textDim, marginRight: 4 }}>KIT</span>
      {DRUM_KIT.map((slot, index) => {
        const atCaret = e.cursor.string === index + 1;
        const on = sounding.has(slot.midiNumber);
        return (
          <span
            key={slot.midiNumber}
            data-drum-slot={slot.label}
            data-drum-on={on ? "true" : "false"}
            data-drum-caret={atCaret ? "true" : "false"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 6px",
              borderRadius: 6,
              // Three states worth distinguishing: where the caret is, what is sounding
              // in this beat, and everything else. Colour alone would not carry the
              // first two, so the caret gets a border and a sounding voice gets a dot.
              border: `1px solid ${atCaret ? color.accent : color.hairline}`,
              background: on ? color.raised : "transparent",
              color: on ? color.text : color.textDim,
            }}
          >
            <strong style={{ color: atCaret ? color.accent : color.textDim }}>{slot.key}</strong>
            {slot.label}
            {on && <span aria-hidden style={{ color: color.accent }}>●</span>}
          </span>
        );
      })}
      <span style={{ color: color.textDim, marginLeft: 6 }}>
        press again to remove · arrows move the caret
      </span>
    </div>
  );
}
