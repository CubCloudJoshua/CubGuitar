import { useEffect } from "react";
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
function useEditorKeys(e: EditorController, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
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

export function EditorBar({ e, enabled }: { e: EditorController; enabled: boolean }) {
  useEditorKeys(e, enabled);

  const note = e.currentBeat?.notes.find((n) => n.string === e.cursor.string);

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
      <button onClick={e.undo} style={{ ...btn, opacity: e.canUndo ? 1 : 0.4 }} disabled={!e.canUndo}>
        UNDO
      </button>
      <button onClick={e.redo} style={{ ...btn, opacity: e.canRedo ? 1 : 0.4 }} disabled={!e.canRedo}>
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
