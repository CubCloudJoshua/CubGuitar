import { useState } from "react";
import { theme } from "../theme";
import type { LibraryEntry } from "./db";

interface Props {
  entries: LibraryEntry[];
  currentId: string | null;
  onOpen: (entry: LibraryEntry) => void;
  onDelete: (id: string) => void;
  onImportClick: () => void;
}

export function LibraryPanel({ entries, currentId, onOpen, onDelete, onImportClick }: Props) {
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? entries.filter(
        (e) => e.title.toLowerCase().includes(needle) || e.artist.toLowerCase().includes(needle),
      )
    : entries;

  return (
    <aside
      style={{
        background: theme.panel,
        border: `1px solid ${theme.border}`,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.textDim, letterSpacing: 0.5 }}>
          LIBRARY ({entries.length})
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onImportClick}
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            padding: "4px 10px",
            border: `1px solid ${theme.accent}`,
            background: "transparent",
            color: theme.accent,
            cursor: "pointer",
          }}
        >
          IMPORT
        </button>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search"
        aria-label="Search library"
        style={{
          fontFamily: theme.mono,
          fontSize: 12,
          padding: "6px 8px",
          background: theme.bg,
          border: `1px solid ${theme.border}`,
          color: theme.text,
          minWidth: 0,
        }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", maxHeight: "60vh" }}>
        {visible.length === 0 && (
          <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.textDim, padding: "8px 0" }}>
            {entries.length === 0 ? "No scores yet. Import a file." : "No matches."}
          </span>
        )}
        {visible.map((entry) => {
          const active = entry.id === currentId;
          return (
            <div
              key={entry.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: active ? theme.panelAlt : "transparent",
                borderLeft: `2px solid ${active ? theme.accent : "transparent"}`,
                padding: "6px 8px",
              }}
            >
              <button
                onClick={() => onOpen(entry)}
                title={`${entry.title}${entry.artist ? ` — ${entry.artist}` : ""}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontFamily: theme.mono,
                  color: active ? theme.accentBright : theme.text,
                }}
              >
                <span
                  style={{
                    display: "block",
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.title}
                </span>
                <span style={{ display: "block", fontSize: 10, color: theme.textDim }}>
                  {entry.artist || "—"} · {entry.tracks} trk · {entry.bars} bars ·{" "}
                  {entry.format === "gp" ? "Guitar Pro" : "alphaTex"}
                </span>
              </button>
              <button
                onClick={() => onDelete(entry.id)}
                aria-label={`Delete ${entry.title}`}
                title="Remove from library"
                style={{
                  background: "transparent",
                  border: `1px solid ${theme.border}`,
                  color: theme.textDim,
                  fontFamily: theme.mono,
                  fontSize: 11,
                  padding: "2px 7px",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
