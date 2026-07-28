import { useCallback, useEffect, useRef, useState } from "react";
import { theme } from "./theme";
import { useAlphaTab } from "./useAlphaTab";
import { useNarrow } from "./useNarrow";
import { Toolbar } from "./components/Toolbar";
import { TrackMixer } from "./components/TrackMixer";
import { ExportMenu } from "./components/ExportMenu";
import { LibraryPanel } from "./library/LibraryPanel";
import { deleteEntry, listEntries, newId, putEntry, type LibraryEntry } from "./library/db";
import { DEMO_SCORE } from "./demo";

/** A load in flight, saved to the library once alphaTab reports the score. */
interface PendingImport {
  id: string;
  format: "gp" | "altex";
  bytes: ArrayBuffer | null;
  tex: string | null;
  fileName: string | null;
  addedAt: number;
}

export function App() {
  const c = useAlphaTab();
  const { loadTex, loadBytes } = c;
  const narrow = useNarrow();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<PendingImport | null>(null);

  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const refresh = useCallback(async () => {
    setEntries(await listEntries());
  }, []);

  // First run seeds the demo so the library is never empty on arrival.
  useEffect(() => {
    void (async () => {
      const existing = await listEntries();
      if (existing.length === 0) {
        pendingRef.current = {
          id: newId(),
          format: "altex",
          bytes: null,
          tex: DEMO_SCORE,
          fileName: null,
          addedAt: Date.now(),
        };
        loadTex(DEMO_SCORE);
      } else {
        setEntries(existing);
        const first = existing[0];
        if (first) {
          setCurrentId(first.id);
          if (first.tex !== null) loadTex(first.tex);
          else if (first.bytes) loadBytes(first.bytes);
        }
      }
    })();
  }, [loadTex, loadBytes]);

  // alphaTab only reports title/artist/tracks/bars after parsing, so the
  // library row is written once the score comes back.
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !c.score) return;
    pendingRef.current = null;
    void (async () => {
      const entry: LibraryEntry = {
        id: pending.id,
        title: c.score?.title ?? "Untitled",
        artist: c.score?.artist ?? "",
        format: pending.format,
        bytes: pending.bytes,
        tex: pending.tex,
        fileName: pending.fileName,
        addedAt: pending.addedAt,
        openedAt: Date.now(),
        tracks: c.tracks.length,
        bars: c.score?.barCount ?? 0,
      };
      await putEntry(entry);
      setCurrentId(entry.id);
      await refresh();
    })();
  }, [c.score, c.tracks, refresh]);

  const importFile = useCallback(
    async (file: File) => {
      const isTex = /\.(altex|tex)$/i.test(file.name);
      if (isTex) {
        const tex = await file.text();
        pendingRef.current = {
          id: newId(), format: "altex", bytes: null, tex, fileName: file.name, addedAt: Date.now(),
        };
        loadTex(tex);
      } else {
        const bytes = await file.arrayBuffer();
        pendingRef.current = {
          id: newId(), format: "gp", bytes, tex: null, fileName: file.name, addedAt: Date.now(),
        };
        loadBytes(bytes);
      }
      if (narrow) setLibraryOpen(false);
    },
    [loadTex, loadBytes, narrow],
  );

  const openEntry = useCallback(
    async (entry: LibraryEntry) => {
      setCurrentId(entry.id);
      if (entry.tex !== null) loadTex(entry.tex);
      else if (entry.bytes) loadBytes(entry.bytes);
      await putEntry({ ...entry, openedAt: Date.now() });
      await refresh();
      if (narrow) setLibraryOpen(false);
    },
    [loadTex, loadBytes, refresh, narrow],
  );

  const removeEntry = useCallback(
    async (id: string) => {
      await deleteEntry(id);
      if (id === currentId) setCurrentId(null);
      await refresh();
    },
    [currentId, refresh],
  );

  const showLibrary = !narrow || libraryOpen;

  return (
    <div
      style={{ maxWidth: 1280, margin: "0 auto", padding: narrow ? 10 : 16 }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) void importFile(file);
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <h1 style={{ color: theme.accent, fontSize: narrow ? 18 : 24, margin: 0, letterSpacing: 1 }}>
          CubScore
        </h1>
        {c.score && !narrow && (
          <span style={{ fontSize: 13, color: theme.text }}>
            {c.score.title}
            {c.score.artist && <span style={{ color: theme.textDim }}> — {c.score.artist}</span>}
            <span style={{ color: theme.textDim }}> · {c.score.barCount} bars</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        {narrow && (
          <button onClick={() => setLibraryOpen((v) => !v)} style={headerButton}>
            LIBRARY
          </button>
        )}
        <button onClick={() => fileInputRef.current?.click()} style={headerButton}>
          OPEN
        </button>
        <ExportMenu c={c} />
        <input
          ref={fileInputRef}
          type="file"
          accept=".gp,.gp3,.gp4,.gp5,.gpx,.xml,.musicxml,.cap,.altex,.tex"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = "";
          }}
        />
      </header>

      <Toolbar c={c} />

      {c.error && (
        <div
          style={{
            background: "#2a1010",
            border: "1px solid #7a2020",
            color: "#ffb0b0",
            fontFamily: theme.mono,
            fontSize: 12,
            padding: 10,
            marginBottom: 10,
            whiteSpace: "pre-wrap",
          }}
        >
          {c.error}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: showLibrary && !narrow ? "260px minmax(0, 1fr)" : "minmax(0, 1fr)",
          gap: 10,
          alignItems: "start",
        }}
      >
        {showLibrary && (
          <LibraryPanel
            entries={entries}
            currentId={currentId}
            onOpen={(e) => void openEntry(e)}
            onDelete={(id) => void removeEntry(id)}
            onImportClick={() => fileInputRef.current?.click()}
          />
        )}

        <main style={{ minWidth: 0 }}>
          <TrackMixer c={c} />
          <div
            style={{
              background: theme.panel,
              border: `1px solid ${theme.border}`,
              padding: 8,
              position: "relative",
              minHeight: 200,
              overflowX: "auto",
            }}
          >
            {c.rendering && (
              <span
                style={{
                  position: "absolute",
                  top: 8,
                  right: 12,
                  fontFamily: theme.mono,
                  fontSize: 11,
                  color: theme.textDim,
                }}
              >
                rendering…
              </span>
            )}
            <div ref={c.hostRef} />
          </div>
        </main>
      </div>

      <p style={{ fontFamily: theme.mono, fontSize: 11, color: theme.textDim, lineHeight: 1.7 }}>
        Drop a .gp3/.gp4/.gp5/.gpx/.gp file anywhere to import it. Click a note to seek. Drag across
        the score to select a loop region, then press LOOP. RAMP raises playback speed 5% after each
        loop pass until it reaches 100%.
      </p>
    </div>
  );
}

const headerButton = {
  fontFamily: theme.mono,
  fontSize: 12,
  padding: "6px 12px",
  border: `1px solid ${theme.accent}`,
  background: "transparent",
  color: theme.accent,
  cursor: "pointer",
} as const;
