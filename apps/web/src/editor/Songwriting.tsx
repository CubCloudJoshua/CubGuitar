/**
 * Chord and lyric entry, on the music.
 *
 * Press C on a beat and type "Am7"; press L and type the syllable. The input opens
 * where the caret is — anchored to the same engraved geometry every other overlay
 * uses — because a songwriter's attention is on the bar they are writing, and a
 * panel somewhere else on the screen is a trip away from it per chord.
 *
 * Two decisions carry the "easy" half of the brief.
 *
 * **Tab is the workflow.** Tab commits and moves to the next beat with the input
 * still open, so a chart or a lyric line goes in as one pass along the bar rather
 * than as open-type-close repeated twenty times. This is how the fast path in every
 * serious entry tool works, and it is the difference between charting a song and
 * operating a dialog.
 *
 * **Suggestions teach while they autofill.** The chips under the chord input come
 * from the harmony engine ranked by what usually follows, each carrying its roman
 * numeral and, on hover, why it is offered. A writer who knows exactly what they
 * want ignores them at no cost; one who does not learns the vocabulary by using it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { color, font, heat, typeScale } from "@cubscore/design";
import { parseChord, suggestNext, type ChordSuggestion } from "@cubscore/core";
import type { BarBox } from "../useAlphaTab";
import type { EditorController } from "./useEditor";

type Mode = "chord" | "lyric";

const field: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: typeScale.base,
  background: color.raised,
  border: `1px solid ${color.accent}`,
  borderRadius: 6,
  color: color.text,
  padding: "3px 6px",
  width: 88,
  outline: "none",
};

export function SongwritingOverlay({ e, barBoxes }: { e: EditorController; barBoxes: BarBox[] }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [draft, setDraft] = useState("");
  /** Set after an Enter on a symbol the parser refused, so the next Enter keeps it. */
  const [warned, setWarned] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const open = useCallback(
    (next: Mode) => {
      const beat = e.score.tracks[e.cursor.track]?.bars[e.cursor.bar]?.voices[0]?.beats[e.cursor.beat];
      setDraft((next === "chord" ? beat?.chord : beat?.lyric) ?? "");
      setWarned(false);
      setMode(next);
    },
    [e.score, e.cursor],
  );

  // C and L open entry, with the same target guards as every other editor key so
  // typing in a real input never triggers them.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (mode !== null) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|OPTION)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      const key = ev.key.toLowerCase();
      if (key !== "c" && key !== "l") return;
      ev.preventDefault();
      open(key === "c" ? "chord" : "lyric");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, open]);

  const close = useCallback(() => {
    setMode(null);
    setDraft("");
    setWarned(false);
    // Focus back to the document so the arrow keys move the caret again.
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  /** Commits the draft to the caret's beat. Empty clears. */
  const commit = useCallback(
    (value: string): boolean => {
      const trimmed = value.trim();
      if (mode === "chord") {
        // A symbol the parser cannot read still *can* be kept — the model stores
        // text, and the writer may mean something the grammar does not know — but
        // not silently: the first Enter warns, the second keeps it.
        if (trimmed !== "" && !parseChord(trimmed) && !warned) {
          setWarned(true);
          return false;
        }
        e.setChord(trimmed === "" ? null : trimmed);
      } else if (mode === "lyric") {
        e.setLyric(trimmed === "" ? null : trimmed);
      }
      return true;
    },
    [mode, warned, e],
  );

  if (mode === null) return null;

  const box = barBoxes.find((b) => b.index === e.cursor.bar);
  if (!box) return null;
  const x = box.beats[e.cursor.beat] ?? box.x;

  const suggestions: ChordSuggestion[] =
    mode === "chord" ? suggestNext(e.chordBeforeCursor, e.keyAtCursor).slice(0, 4) : [];

  const take = (value: string) => {
    if (!commit(value)) return;
    close();
  };

  /** Tab: commit, step to the next beat, stay open. The one-pass chart workflow. */
  const takeAndAdvance = (value: string) => {
    if (!commit(value)) return;
    e.moveBeat(1);
    setDraft("");
    setWarned(false);
    inputRef.current?.focus();
  };

  return (
    <div
      data-songwriting-entry={mode}
      style={{
        position: "absolute",
        left: Math.max(0, x - 8),
        // Chords live above the staff and lyrics below it, matching where the
        // engraver puts them, so the input opens where its result will appear.
        top: mode === "chord" ? box.y - 34 : box.y + box.height + 4,
        zIndex: 4,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <input
        ref={(el) => {
          inputRef.current = el;
          el?.focus();
        }}
        value={draft}
        aria-label={mode === "chord" ? "Chord symbol" : "Lyric syllable"}
        placeholder={mode === "chord" ? "Am7, C/G…" : "syllable"}
        onChange={(ev) => {
          setDraft(ev.target.value);
          setWarned(false);
        }}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") take(draft);
          if (ev.key === "Tab") {
            ev.preventDefault();
            takeAndAdvance(draft);
          }
          if (ev.key === "Escape") close();
        }}
        onBlur={(ev) => {
          // Clicking a suggestion chip must not close the input before the click
          // lands; anything else outside is a dismissal.
          if (!(ev.relatedTarget as HTMLElement | null)?.dataset["songwritingChip"]) close();
        }}
        style={{
          ...field,
          ...(warned ? { borderColor: heat.wrong } : {}),
        }}
        title={
          mode === "chord"
            ? "Enter commits · Tab commits and moves to the next beat · empty clears"
            : "Enter commits · Tab commits and moves to the next beat · empty clears"
        }
      />
      {warned && (
        <span style={{ fontFamily: font.mono, fontSize: typeScale.xs, color: heat.wrong }}>
          Unknown chord — Enter again to keep it
        </span>
      )}
      {suggestions.length > 0 && (
        <div style={{ display: "flex", gap: 4 }}>
          {suggestions.map((s) => (
            <button
              key={s.name}
              data-songwriting-chip={s.name}
              title={`${s.roman} — ${s.why}`}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => take(s.name)}
              style={{
                fontFamily: font.mono,
                fontSize: typeScale.xs,
                background: color.raisedHigh,
                border: `1px solid ${color.hairline}`,
                borderRadius: 6,
                color: color.text,
                padding: "2px 7px",
                cursor: "pointer",
              }}
            >
              {s.name} <span style={{ color: color.textDim }}>{s.roman}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
