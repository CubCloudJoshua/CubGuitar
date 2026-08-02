/**
 * Tempo and meter, editable on the score (UI-DESIGN.md, Write mode: "Tempo and
 * meter live in the score itself ... which is how notation apps should always
 * have worked").
 *
 * These were the last two controls stranded in the SCORE popover: three clicks
 * and a mental map from a panel back to the bar you meant. The chip is measured
 * from the same render as the engraving, so it cannot drift from the bar it
 * labels, and it follows the caret rather than covering every bar at once —
 * which would put chrome on top of the music the rest of the time.
 */
import { useEffect, useRef, useState } from "react";
import { color, font, motion, typeScale } from "@cubscore/design";
import type { BarBox } from "../useAlphaTab";
import type { EditorController } from "./useEditor";

const BEAT_VALUES = [2, 4, 8, 16];
const BEATS_PER_BAR = [2, 3, 4, 5, 6, 7, 9, 12];

/** The signature in force at a bar: the nearest one at or before it. */
function meterAt(e: EditorController, barIndex: number): { beats: number; beatValue: number } {
  const bars = e.score.tracks[e.cursor.track]?.bars ?? [];
  for (let i = Math.min(barIndex, bars.length - 1); i >= 0; i--) {
    const ts = bars[i]?.timeSignature;
    if (ts) return { beats: ts.beats, beatValue: ts.beatValue };
  }
  return { beats: 4, beatValue: 4 };
}

const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 22,
  padding: "0 7px",
  background: color.raisedHigh,
  border: `1px solid ${color.hairline}`,
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: font.mono,
  fontSize: typeScale.xs,
  color: color.text,
  transition: `border-color ${motion.base}, color ${motion.base}`,
};

/**
 * The section name starting at the caret's bar: "Verse", "Chorus".
 *
 * Song structure belongs on the bar it starts at, same as tempo and meter — it is
 * the third thing that was ever going to live in this chip row, which is why the row
 * exists. Shown dim when the bar has no section, so naming one is one click and an
 * unnamed score carries no chrome shouting about it.
 */
function SectionChip({ section, onCommit }: { section: string | undefined; onCommit: (next: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section ?? "");

  useEffect(() => setDraft(section ?? ""), [section]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== (section ?? "")) onCommit(next === "" ? null : next);
  };

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        aria-label={section ? `Section ${section}, click to rename` : "Name a section starting at this bar"}
        title="Section — Verse, Chorus… Starts at this bar. Empty removes it."
        data-section-chip=""
        style={{ ...chip, ...(section ? {} : { color: color.textDim }) }}
        onMouseEnter={(ev) => (ev.currentTarget.style.borderColor = color.accent)}
        onMouseLeave={(ev) => (ev.currentTarget.style.borderColor = color.hairline)}
      >
        {section ?? "SEC"}
      </button>
    );
  }

  return (
    <input
      ref={(el) => el?.focus()}
      value={draft}
      aria-label="Section name"
      placeholder="Verse"
      onChange={(ev) => setDraft(ev.target.value.slice(0, 24))}
      onBlur={commit}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") commit();
        if (ev.key === "Escape") {
          setDraft(section ?? "");
          setEditing(false);
        }
        ev.stopPropagation();
      }}
      style={{ ...chip, width: 92, borderColor: color.accent, background: color.raised, outline: "none" }}
    />
  );
}

/** A chip that swaps itself for an input on click and commits on blur or Enter. */
function TempoChip({ bpm, onCommit }: { bpm: number; onCommit: (next: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(bpm));

  useEffect(() => setDraft(String(bpm)), [bpm]);

  const commit = () => {
    setEditing(false);
    const next = Number(draft);
    if (Number.isFinite(next) && next !== bpm) onCommit(next);
    else setDraft(String(bpm));
  };

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        aria-label={`Tempo ${bpm} beats per minute, click to edit`}
        title="Tempo — click to edit"
        style={chip}
        onMouseEnter={(ev) => (ev.currentTarget.style.borderColor = color.accent)}
        onMouseLeave={(ev) => (ev.currentTarget.style.borderColor = color.hairline)}
      >
        <span style={{ color: color.textDim }}>♩=</span>
        {bpm}
      </button>
    );
  }

  return (
    <input
      // Autofocus by callback ref: focusing in an effect loses the first
      // keystroke, which for a two-digit tempo is most of the input.
      ref={(el) => el?.focus()}
      value={draft}
      inputMode="numeric"
      aria-label="Tempo in beats per minute"
      onChange={(ev) => setDraft(ev.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
      onBlur={commit}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") commit();
        if (ev.key === "Escape") {
          setDraft(String(bpm));
          setEditing(false);
        }
        ev.stopPropagation();
      }}
      style={{
        ...chip,
        width: 54,
        borderColor: color.accent,
        background: color.raised,
        outline: "none",
        textAlign: "center",
      }}
    />
  );
}

function MeterChip({
  beats,
  beatValue,
  onCommit,
}: {
  beats: number;
  beatValue: number;
  onCommit: (beats: number, beatValue: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Choosing is the end of the interaction: the change applies immediately and
  // the chip goes back to reading the signature, so there is nothing left open
  // to dismiss. Adjusting the other half is one more click.
  const commit = (nextBeats: number, nextBeatValue: number) => {
    setEditing(false);
    onCommit(nextBeats, nextBeatValue);
  };

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        aria-label={`Time signature ${beats}/${beatValue}, click to edit`}
        title="Time signature — click to edit. Applies from this bar onward."
        style={chip}
        onMouseEnter={(ev) => (ev.currentTarget.style.borderColor = color.accent)}
        onMouseLeave={(ev) => (ev.currentTarget.style.borderColor = color.hairline)}
      >
        {beats}/{beatValue}
      </button>
    );
  }

  const select: React.CSSProperties = {
    ...chip,
    padding: "0 2px",
    borderColor: color.accent,
    background: color.raised,
    appearance: "none",
    outline: "none",
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }} onBlur={(ev) => {
      // Leaving the pair entirely closes it; moving between the two selects
      // must not, so the check is on where focus went.
      if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setEditing(false);
    }}>
      <select
        ref={(el) => el?.focus()}
        value={beats}
        aria-label="Beats per bar"
        onChange={(ev) => commit(Number(ev.target.value), beatValue)}
        onKeyDown={(ev) => ev.stopPropagation()}
        style={select}
      >
        {BEATS_PER_BAR.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <span style={{ fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}>/</span>
      <select
        value={beatValue}
        aria-label="Beat value"
        onChange={(ev) => commit(beats, Number(ev.target.value))}
        onKeyDown={(ev) => ev.stopPropagation()}
        style={select}
      >
        {BEAT_VALUES.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </span>
  );
}

export function BarMarkings({ e, barBoxes }: { e: EditorController; barBoxes: BarBox[] }) {
  const box = barBoxes.find((b) => b.index === e.cursor.bar);
  // Remember the last known geometry: alphaTab clears bounds while it re-renders
  // after every edit, and letting the chip vanish and reappear on each
  // keystroke would be worse than letting it sit still for a frame.
  const lastBox = useRef<BarBox | null>(null);
  if (box) lastBox.current = box;
  const anchor = box ?? lastBox.current;
  if (!anchor) return null;

  const meter = meterAt(e, e.cursor.bar);
  // Tempo lives on the first bar of the first track in the model, and alphaTab
  // applies it globally, so it is only offered where it actually belongs.
  const showTempo = e.cursor.bar === 0;
  const bpm = e.score.tracks[0]?.bars[0]?.tempoBpm ?? 120;

  return (
    <>
      {/* The caret's bar, framed. Until now nothing in the score said which bar
          the caret was in — the strip said "bar 3" and you counted. It also
          tells you which bar the chips belong to, which right-aligning them
          inside the bar otherwise leaves ambiguous. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: anchor.x - 2,
          top: anchor.y,
          width: anchor.width + 4,
          height: anchor.height,
          border: `1px solid ${color.accent}`,
          opacity: 0.4,
          borderRadius: 4,
          pointerEvents: "none",
          transition: `left ${motion.base}, top ${motion.base}, width ${motion.base}`,
          zIndex: 2,
        }}
      />
      <div
      style={{
        position: "absolute",
        // Inside the bar's own top band, flushed right. Staff systems stack with
        // no vertical gap, so there is no empty strip above or below a bar to
        // put this in; the top-right of a bar, however, is reliably clear —
        // clef, key, time signature, tempo and bar number all engrave left.
        left: anchor.x,
        top: anchor.y + 2,
        width: anchor.width,
        display: "flex",
        justifyContent: "flex-end",
        gap: 4,
        // The overlay is a container of controls, not a shield over the score:
        // clicks pass through everywhere except the chips themselves.
        pointerEvents: "none",
        zIndex: 3,
      }}
    >
        <span style={{ display: "flex", gap: 4, pointerEvents: "auto" }}>
          {showTempo && <TempoChip bpm={bpm} onCommit={e.setTempo} />}
          <MeterChip beats={meter.beats} beatValue={meter.beatValue} onCommit={e.setTimeSignature} />
          <SectionChip
            section={e.score.tracks[e.cursor.track]?.bars[e.cursor.bar]?.section}
            onCommit={e.setSection}
          />
        </span>
      </div>
    </>
  );
}
