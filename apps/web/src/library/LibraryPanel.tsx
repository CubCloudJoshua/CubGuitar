import { useState } from "react";
import { Button, color, font, Label, Panel, TextField, typeScale } from "@cubscore/design";
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
    <Panel as="aside" style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Label>LIBRARY ({entries.length})</Label>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="outline" onClick={onImportClick}>
          IMPORT
        </Button>
      </div>

      <TextField
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search"
        aria-label="Search library"
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", maxHeight: "60vh" }}>
        {visible.length === 0 && (
          <Label style={{ padding: "8px 0" }}>
            {entries.length === 0 ? "No scores yet. Import a file." : "No matches."}
          </Label>
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
                background: active ? color.raisedHigh : "transparent",
                borderLeft: `2px solid ${active ? color.accent : "transparent"}`,
                borderRadius: 4,
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
                  fontFamily: font.mono,
                  color: active ? color.accentLive : color.text,
                }}
              >
                <span
                  style={{
                    display: "block",
                    fontSize: typeScale.base,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.title}
                </span>
                <span style={{ display: "block", fontSize: typeScale.xs, color: color.textDim }}>
                  {entry.artist || "—"} · {entry.tracks} trk · {entry.bars} bars ·{" "}
                  {entry.format === "gp" ? "Guitar Pro" : "alphaTex"}
                </span>
              </button>
              <Button
                size="sm"
                onClick={() => onDelete(entry.id)}
                aria-label={`Delete ${entry.title}`}
                title="Remove from library"
                style={{ padding: "2px 7px", color: color.textDim }}
              >
                ×
              </Button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
