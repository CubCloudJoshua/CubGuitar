/**
 * Command palette (UI-DESIGN.md 1.4): every action reachable from the
 * keyboard, with shortcut hints that teach. Visible chrome stays a
 * beginner's shortlist because this is where the full inventory lives.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { color, font, motion, radius, typeScale } from "./tokens";

export interface Command {
  id: string;
  title: string;
  /** Section header the command sorts under. */
  section: string;
  /** Keyboard hint shown right-aligned, e.g. "Space" or "Cmd+L". */
  hint?: string;
  run: () => void;
}

/** startsWith beats word-boundary beats substring beats subsequence. */
function match(query: string, title: string): number {
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  if (q.length === 0) return 1;
  if (t.startsWith(q)) return 100 - t.length * 0.01;
  const word = t.split(/\s+/).findIndex((w) => w.startsWith(q));
  if (word >= 0) return 80 - word;
  const sub = t.indexOf(q);
  if (sub >= 0) return 60 - sub * 0.1;
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return -1;
    ti += 1;
  }
  return 20;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const scored = commands
      .map((command) => ({ command, score: match(query, command.title) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
    return scored.slice(0, 12).map((r) => r.command);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const runSelected = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 60,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "16vh",
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "calc(100vw - 32px)",
          background: color.raisedHigh,
          border: `1px solid ${color.hairline}`,
          borderRadius: radius.md,
          boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
          overflow: "hidden",
          animation: `cubPaletteIn ${motion.fast}`,
        }}
      >
        <style>{`@keyframes cubPaletteIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }`}</style>
        <input
          // Callback ref focuses synchronously on mount: keystrokes in the
          // same tick as the opening shortcut must land in the query, not on
          // the document, where they would fall through to editor shortcuts.
          ref={(el) => {
            inputRef.current = el;
            el?.focus();
          }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runSelected(results[index]);
            }
          }}
          placeholder="Type a command…"
          aria-label="Command search"
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: font.mono,
            fontSize: 14,
            padding: "14px 16px",
            background: "transparent",
            border: "none",
            borderBottom: `1px solid ${color.hairline}`,
            color: color.text,
            outline: "none",
          }}
        />
        <div role="listbox" aria-label="Commands" style={{ maxHeight: 380, overflowY: "auto" }}>
          {results.length === 0 && (
            <div style={{ padding: 16, fontFamily: font.mono, fontSize: typeScale.base, color: color.textDim }}>
              Nothing matches.
            </div>
          )}
          {results.map((command, i) => {
            const selected = i === index;
            const firstOfSection = i === 0 || results[i - 1]?.section !== command.section;
            return (
              <div key={command.id}>
                {firstOfSection && (
                  <div
                    style={{
                      padding: "8px 16px 2px",
                      fontFamily: font.mono,
                      fontSize: typeScale.xs,
                      color: color.textFaint,
                      letterSpacing: 0.5,
                    }}
                  >
                    {command.section.toUpperCase()}
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => runSelected(command)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 16px",
                    cursor: "pointer",
                    background: selected ? color.raised : "transparent",
                    borderLeft: `2px solid ${selected ? color.accent : "transparent"}`,
                  }}
                >
                  <span style={{ fontFamily: font.mono, fontSize: typeScale.base, color: color.text, flex: 1 }}>
                    {command.title}
                  </span>
                  {command.hint && (
                    <span style={{ fontFamily: font.mono, fontSize: typeScale.xs, color: color.textFaint }}>
                      {command.hint}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
