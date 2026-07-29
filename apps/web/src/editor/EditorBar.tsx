/**
 * The edit strip (UI-DESIGN.md, Write mode).
 *
 * Only what applies to the current selection stays visible: durations, the
 * dot, and the three articulations a guitarist reaches for constantly. Score
 * settings and track management sit behind popovers, and the full vocabulary
 * lives in the command palette. The ribbon this replaced showed thirty
 * controls at once regardless of what was selected.
 */
import { useEffect, useRef, useState } from "react";
import {
  Button,
  color,
  font,
  Label,
  Popover,
  TextField,
  typeScale,
  VDivider,
} from "@cubscore/design";
import type { Articulation } from "@cubscore/core";
import type { EditorController } from "./useEditor";

const DURATIONS: Array<[string, number]> = [
  ["1", 1],
  ["1/2", 2],
  ["1/4", 4],
  ["1/8", 8],
  ["1/16", 16],
  ["1/32", 32],
];

/** The three reached for constantly; the rest live in the palette. */
const PRIMARY_ARTICULATIONS: Array<[string, Articulation]> = [
  ["P.M.", "palmMute"],
  ["L.R.", "letRing"],
  ["Vib", "vibrato"],
];

const MORE_ARTICULATIONS: Array<[string, Articulation]> = [
  ["Bend", "bend"],
  ["Slide", "slide"],
  ["H/P", "hammerOn"],
  ["N.H.", "naturalHarmonic"],
  ["Dead", "deadNote"],
  ["Staccato", "staccato"],
  ["Accent", "accent"],
  ["Ghost", "ghost"],
];

/** Global key handling, so the editor behaves like a desktop app. */
function useEditorKeys(e: EditorController, enabled: boolean, allowHistory: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        // Undo is snapshot-based and local, so during a live session it would
        // silently fork the document from the other members. Disabled until
        // collaborative undo lands as broadcast inverse ops.
        if (!allowHistory) return;
        if (ev.shiftKey) e.redo();
        else e.undo();
        return;
      }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      if (/^[0-9]$/.test(ev.key)) {
        ev.preventDefault();
        e.typeDigit(Number(ev.key));
        return;
      }

      switch (ev.key) {
        case "ArrowLeft": ev.preventDefault(); e.moveBeat(-1); break;
        case "ArrowRight": ev.preventDefault(); e.moveBeat(1); break;
        case "ArrowUp": ev.preventDefault(); e.moveString(-1); break;
        case "ArrowDown": ev.preventDefault(); e.moveString(1); break;
        case "Delete":
        case "Backspace": ev.preventDefault(); e.deleteNote(); break;
        case "+": ev.preventDefault(); e.insertBeat(); break;
        case "-": ev.preventDefault(); e.removeBeat(); break;
        case ".": ev.preventDefault(); e.toggleDot(); break;
        case "Enter": ev.preventDefault(); e.addBar(); break;
        default: break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [e, enabled, allowHistory]);
}

/** Commits on blur or Enter, so typing does not flood the op log. */
function MetaField({
  label,
  value,
  onCommit,
  width = 150,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  width?: number;
}) {
  const [draft, setDraft] = useState(value);
  // Enter commits and then blurs, and the blur fires before React re-renders
  // the new value prop. Comparing against a ref instead of the prop keeps
  // that sequence from committing the same edit twice (two ops, two undos).
  const committed = useRef(value);

  useEffect(() => {
    setDraft(value);
    committed.current = value;
  }, [value]);

  const commit = () => {
    if (draft === committed.current) return;
    committed.current = draft;
    onCommit(draft);
  };

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
      <Label>{label}</Label>
      <TextField
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            commit();
            (ev.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`Score ${label.toLowerCase()}`}
        style={{ width, padding: "5px 8px" }}
      />
    </label>
  );
}

export function EditorBar({
  e,
  enabled,
  allowHistory = true,
}: {
  e: EditorController;
  enabled: boolean;
  allowHistory?: boolean;
}) {
  useEditorKeys(e, enabled, allowHistory);

  const note = e.currentBeat?.notes.find((n) => n.string === e.cursor.string);
  const canUndo = allowHistory && e.canUndo;
  const canRedo = allowHistory && e.canRedo;

  return (
    <div
      style={{
        background: color.raised,
        border: `1px solid ${color.accent}`,
        borderRadius: 8,
        padding: 10,
        marginBottom: 10,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
      }}
    >
      <Label style={{ color: color.accent }}>EDIT</Label>
      <Label>
        bar {e.cursor.bar + 1} · beat {e.cursor.beat + 1} · string {e.cursor.string}
        {note ? ` · fret ${note.fret}` : " · empty"}
      </Label>

      <VDivider />
      {DURATIONS.map(([text, d]) => (
        <Button
          key={d}
          size="sm"
          onClick={() => e.setDuration(d)}
          active={e.currentBeat?.duration.denominator === d}
        >
          {text}
        </Button>
      ))}
      <Button size="sm" onClick={e.toggleDot} active={e.currentBeat?.dots === 1}>
        DOT
      </Button>

      <VDivider />
      {PRIMARY_ARTICULATIONS.map(([text, a]) => (
        <Button
          key={a}
          size="sm"
          onClick={() => e.toggleArticulation(a)}
          disabled={!note}
          active={note?.articulations.includes(a) ?? false}
        >
          {text}
        </Button>
      ))}
      <Popover
        label="MORE ▾"
        width={188}
        buttonProps={{ size: "sm", disabled: !note, "aria-label": "More articulations" }}
      >
        {(close) => (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {MORE_ARTICULATIONS.map(([text, a]) => (
              <Button
                key={a}
                size="sm"
                active={note?.articulations.includes(a) ?? false}
                onClick={() => {
                  e.toggleArticulation(a);
                  close();
                }}
              >
                {text}
              </Button>
            ))}
          </div>
        )}
      </Popover>

      <VDivider />
      {/* Tempo and meter are on the score now, as chips over the caret's bar
          (UI-DESIGN.md). What is left here is the metadata that belongs to the
          document rather than to any bar. */}
      <Popover label="SCORE ▾" width={244} buttonProps={{ size: "sm" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <MetaField label="TITLE" value={e.score.title} onCommit={e.setTitle} />
          <MetaField label="ARTIST" value={e.score.artist} onCommit={e.setArtist} />
          <Label style={{ fontSize: typeScale.xs }}>
            Tempo and meter are on the score: click ♩= or the time signature above the current bar.
          </Label>
        </div>
      </Popover>

      {/* Track switching, adding and removing all live on the instrument rail
          beside the score now (UI-DESIGN.md, Write mode), so the popover that
          used to hold them is gone rather than merely lightened. */}

      <VDivider />
      <Button
        size="sm"
        onClick={e.undo}
        disabled={!canUndo}
        title={allowHistory ? "Undo (Cmd+Z)" : "Undo is unavailable during a live session"}
      >
        UNDO
      </Button>
      <Button
        size="sm"
        onClick={e.redo}
        disabled={!canRedo}
        title={allowHistory ? "Redo (Cmd+Shift+Z)" : "Undo is unavailable during a live session"}
      >
        REDO
      </Button>

      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}>
        0-9 frets · arrows move · +/− beats · Enter bar · Cmd+K commands
      </span>
    </div>
  );
}
