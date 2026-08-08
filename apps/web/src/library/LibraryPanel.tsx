import { useState } from "react";
import { Button, color, font, Label, Panel, TextField, typeScale } from "@cubscore/design";
import type { LibraryEntry, StoredVersion } from "./db";

interface Props {
  entries: LibraryEntry[];
  currentId: string | null;
  onOpen: (entry: LibraryEntry) => void;
  onDelete: (id: string) => void;
  onImportClick: () => void;
  /** History for one score, newest first; the editor snapshots once a minute. */
  onListVersions: (scoreId: string) => Promise<StoredVersion[]>;
  onRestoreVersion: (version: StoredVersion) => void;
}

/** A version's moment, said the way a person scanning a list reads time. */
function versionLabel(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleString();
}

export function LibraryPanel({
  entries,
  currentId,
  onOpen,
  onDelete,
  onImportClick,
  onListVersions,
  onRestoreVersion,
}: Props) {
  const [query, setQuery] = useState("");
  /** Which score's history is open, and what it holds. One at a time: it is a peek. */
  const [history, setHistory] = useState<{ scoreId: string; versions: StoredVersion[] } | null>(null);

  const toggleHistory = (scoreId: string) => {
    if (history?.scoreId === scoreId) {
      setHistory(null);
      return;
    }
    void onListVersions(scoreId).then((versions) => setHistory({ scoreId, versions }));
  };

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
                onClick={() => toggleHistory(entry.id)}
                aria-label={`History of ${entry.title}`}
                title="Earlier versions of this score, snapshotted while editing"
                data-history-toggle={entry.id}
                style={{ padding: "2px 7px", color: history?.scoreId === entry.id ? color.accent : color.textDim }}
              >
                ⌚
              </Button>
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

      {history && (
        <div data-version-list="" style={{ borderTop: `1px solid ${color.hairline}`, paddingTop: 6 }}>
          <Label>HISTORY</Label>
          {history.versions.length === 0 ? (
            <Label style={{ padding: "6px 0" }}>
              No versions yet. One is kept about every minute while you edit.
            </Label>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", maxHeight: "24vh" }}>
              {history.versions.map((version) => (
                <div
                  key={version.id}
                  data-version-row={version.at}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 4px" }}
                >
                  <span style={{ fontFamily: font.mono, fontSize: typeScale.xs, color: color.text }}>
                    {versionLabel(version.at)}
                  </span>
                  <span style={{ fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}>
                    {version.bars} bars · {version.notes} notes
                  </span>
                  <span style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    onClick={() => onRestoreVersion(version)}
                    data-version-restore={version.at}
                    title="Make this the current document. Later versions are kept, so a restore can itself be undone from here."
                    style={{ padding: "2px 8px" }}
                  >
                    RESTORE
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
