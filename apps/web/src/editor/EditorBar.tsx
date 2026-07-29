import { useEffect, useRef, useState } from "react";
import { theme } from "../theme";
import { toggleStyle } from "../components/Toolbar";
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

const ARTICULATIONS: Array<[string, Articulation]> = [
  ["P.M.", "palmMute"],
  ["L.R.", "letRing"],
  ["Vib", "vibrato"],
  ["Bend", "bend"],
  ["Slide", "slide"],
  ["H/P", "hammerOn"],
  ["N.H.", "naturalHarmonic"],
  ["Dead", "deadNote"],
];

const btn = {
  fontFamily: theme.mono,
  fontSize: 11,
  padding: "5px 9px",
  border: `1px solid ${theme.border}`,
  background: theme.panelAlt,
  color: theme.text,
  cursor: "pointer",
} as const;

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
  }, [e, enabled]);
}

/** Commits on blur or Enter, so typing does not flood the op log. */
function MetaField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Enter commits and then blurs, and the blur fires before React re-renders
  // the new value prop. Comparing against a ref instead of the prop keeps
  // that sequence from committing the same edit twice (two ops, two undos).
  const committed = useRef(value);

  // Re-sync when a different score loads underneath us.
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
    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={labelStyle}>{label}</span>
      <input
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
        style={{
          fontFamily: theme.mono,
          fontSize: 12,
          padding: "5px 8px",
          width: label === "TITLE" ? 160 : 120,
          background: theme.bg,
          border: `1px solid ${theme.border}`,
          color: theme.text,
        }}
      />
    </label>
  );
}

const labelStyle = {
  fontFamily: theme.mono,
  fontSize: 11,
  color: theme.textDim,
  letterSpacing: 0.5,
} as const;

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
        background: theme.panel,
        border: `1px solid ${theme.accent}`,
        padding: 10,
        marginBottom: 10,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
      }}
    >
      <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.accent, letterSpacing: 0.5 }}>
        EDIT
      </span>
      <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.textDim }}>
        bar {e.cursor.bar + 1} · beat {e.cursor.beat + 1} · string {e.cursor.string}
        {note ? ` · fret ${note.fret}` : " · empty"}
      </span>

      <Divider />
      <MetaField label="TITLE" value={e.score.title} onCommit={e.setTitle} />
      <MetaField label="ARTIST" value={e.score.artist} onCommit={e.setArtist} />

      <Divider />
      <span style={label}>NOTE</span>
      {DURATIONS.map(([text, d]) => (
        <button
          key={d}
          onClick={() => e.setDuration(d)}
          style={toggleStyle(e.currentBeat?.duration.denominator === d)}
        >
          {text}
        </button>
      ))}
      <button onClick={e.toggleDot} style={toggleStyle(e.currentBeat?.dots === 1)}>
        DOT
      </button>

      <Divider />
      {ARTICULATIONS.map(([text, a]) => (
        <button
          key={a}
          onClick={() => e.toggleArticulation(a)}
          disabled={!note}
          style={{
            ...toggleStyle(note?.articulations.includes(a) ?? false),
            opacity: note ? 1 : 0.4,
            cursor: note ? "pointer" : "default",
          }}
        >
          {text}
        </button>
      ))}

      <Divider />
      <button onClick={e.insertBeat} style={btn}>+BEAT</button>
      <button onClick={e.removeBeat} style={btn}>−BEAT</button>
      <button onClick={e.addBar} style={btn}>+BAR</button>
      <button onClick={e.deleteNote} style={btn} disabled={!note}>DEL</button>

      <Divider />
      <button
        onClick={e.undo}
        style={{ ...btn, opacity: canUndo ? 1 : 0.4 }}
        disabled={!canUndo}
        title={allowHistory ? undefined : "Undo is unavailable during a live session"}
      >
        UNDO
      </button>
      <button
        onClick={e.redo}
        style={{ ...btn, opacity: canRedo ? 1 : 0.4 }}
        disabled={!canRedo}
        title={allowHistory ? undefined : "Undo is unavailable during a live session"}
      >
        REDO
      </button>

      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: theme.mono, fontSize: 10, color: theme.textDim }}>
        type 0-9 for frets · arrows move · +/− beats · Enter adds a bar
      </span>
    </div>
  );
}

const label = {
  fontFamily: theme.mono,
  fontSize: 11,
  color: theme.textDim,
  letterSpacing: 0.5,
} as const;

function Divider() {
  return <span style={{ width: 1, height: 18, background: theme.border }} />;
}
