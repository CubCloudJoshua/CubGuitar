import { useCallback, useEffect, useRef, useState } from "react";
import type { Score as CoreScore } from "@cubscore/core";
import { fromAlphaTab, type ImportReport } from "@cubscore/formats";
import { theme } from "./theme";
import { useAlphaTab } from "./useAlphaTab";
import { useNarrow } from "./useNarrow";
import { useEditor } from "./editor/useEditor";
import { EditorBar } from "./editor/EditorBar";
import { Toolbar } from "./components/Toolbar";
import { TrackMixer } from "./components/TrackMixer";
import { ExportMenu } from "./components/ExportMenu";
import { LibraryPanel } from "./library/LibraryPanel";
import { deleteEntry, listEntries, newId, putEntry, type LibraryEntry } from "./library/db";
import { base64ToBytes, fetchShared, shareEntry, sharedIdFromLocation } from "./share";
import { useAuth } from "./auth/useAuth";
import { AccountPanel } from "./auth/AccountPanel";
import { DEMO_SCORE } from "./demo";

type Mode = "play" | "edit";

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
  const editor = useEditor();
  const { loadTex, loadBytes } = c;
  const narrow = useNarrow();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<PendingImport | null>(null);
  /** Library row the editor autosaves into. */
  const editorEntryRef = useRef<{ id: string; addedAt: number } | null>(null);

  const [mode, setMode] = useState<Mode>("play");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importNotice, setImportNotice] = useState<ImportReport | null>(null);
  /** Opened via a share link: read-only, no library. */
  const [sharedView] = useState(() => sharedIdFromLocation() !== null);
  /** Payload of the currently open shared score, so it can be saved locally. */
  const sharedPayloadRef = useRef<{ title: string; artist: string; format: "gp" | "altex"; tex: string | null; bytesB64: string | null } | null>(null);
  const [sharedSaved, setSharedSaved] = useState(false);
  const auth = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setEntries(await listEntries());
  }, []);

  // Space toggles playback everywhere except form fields and focused buttons,
  // in the player, the editor, and shared views alike.
  const { playPause } = c;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code !== "Space" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return;
      ev.preventDefault();
      playPause();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [playPause]);

  useEffect(() => {
    // A share link bypasses the library entirely: load the shared score,
    // read-only, and nothing else.
    const sharedId = sharedIdFromLocation();
    if (sharedId) {
      void (async () => {
        try {
          const payload = await fetchShared(sharedId);
          sharedPayloadRef.current = payload;
          if (payload.tex !== null) loadTex(payload.tex);
          else if (payload.bytesB64) loadBytes(base64ToBytes(payload.bytesB64));
        } catch (err) {
          setShareError(err instanceof Error ? err.message : String(err));
        }
      })();
      return;
    }
    void (async () => {
      const existing = await listEntries();
      if (existing.length === 0) {
        pendingRef.current = {
          id: newId(), format: "altex", bytes: null, tex: DEMO_SCORE, fileName: null, addedAt: Date.now(),
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

  // Imported scores only report their metadata after alphaTab parses them.
  // The same pass converts to the semantic model so the file becomes editable.
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !c.score) return;
    pendingRef.current = null;
    void (async () => {
      let core: string | null = null;
      let report: string | null = null;
      const parsed = c.getScore();
      if (parsed) {
        try {
          const converted = fromAlphaTab(parsed);
          core = JSON.stringify(converted.score);
          report = JSON.stringify(converted.report);
        } catch (err) {
          // A failed conversion must not lose the import: the file still
          // plays, it just stays read-only.
          console.warn("core conversion failed", err);
        }
      }
      await putEntry({
        id: pending.id,
        title: c.score?.title ?? "Untitled",
        artist: c.score?.artist ?? "",
        format: pending.format,
        bytes: pending.bytes,
        tex: pending.tex,
        core,
        report,
        authored: false,
        fileName: pending.fileName,
        addedAt: pending.addedAt,
        openedAt: Date.now(),
        tracks: c.tracks.length,
        bars: c.score?.barCount ?? 0,
      });
      setCurrentId(pending.id);
      await refresh();
    })();
  }, [c.score, c.tracks, c.getScore, refresh]);

  // The editor owns the document in edit mode; alphaTab just renders it.
  const editorTex = editor.tex;
  useEffect(() => {
    if (mode !== "edit") return;
    loadTex(editorTex);
  }, [mode, editorTex, loadTex]);

  // Park alphaTab's beat cursor on the edit caret for visual feedback.
  const { cursorTick } = editor;
  useEffect(() => {
    if (mode !== "edit" || !c.ready) return;
    const api = c.getApi();
    if (api) api.tickPosition = cursorTick;
  }, [mode, cursorTick, c.ready, c.getApi, editorTex]);

  // Autosave, so editor work survives a reload like everything else.
  const editorScore = editor.score;
  useEffect(() => {
    if (mode !== "edit") return;
    const target = editorEntryRef.current;
    if (!target) return;
    const timer = setTimeout(() => {
      void (async () => {
        await putEntry({
          id: target.id,
          title: editorScore.title,
          artist: editorScore.artist,
          format: "altex",
          bytes: null,
          tex: editorTex,
          core: JSON.stringify(editorScore),
          report: null,
          authored: true,
          fileName: null,
          addedAt: target.addedAt,
          openedAt: Date.now(),
          tracks: editorScore.tracks.length,
          bars: editorScore.tracks[0]?.bars.length ?? 0,
        });
        await refresh();
      })();
    }, 1000);
    return () => clearTimeout(timer);
  }, [mode, editorScore, editorTex, refresh]);

  /** A share recipient keeps a copy: store it locally, then open the full app. */
  const saveSharedToLibrary = useCallback(async () => {
    const payload = sharedPayloadRef.current;
    if (!payload || !c.score) return;
    await putEntry({
      id: newId(),
      title: c.score.title,
      artist: c.score.artist,
      format: payload.format,
      tex: payload.tex,
      bytes: payload.bytesB64 ? base64ToBytes(payload.bytesB64) : null,
      core: null,
      report: null,
      authored: false,
      fileName: null,
      addedAt: Date.now(),
      openedAt: Date.now(),
      tracks: c.tracks.length,
      bars: c.score.barCount,
    });
    setSharedSaved(true);
  }, [c.score, c.tracks]);

  const shareCurrent = useCallback(async () => {
    const entry = entries.find((e) => e.id === currentId);
    if (!entry) return;
    setShareBusy(true);
    setShareError(null);
    try {
      const url = await shareEntry(entry);
      setShareUrl(url);
      // Best effort; headless browsers and strict permissions may refuse.
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        /* the visible link covers this */
      }
    } catch (err) {
      setShareError(err instanceof Error ? err.message : String(err));
    } finally {
      setShareBusy(false);
    }
  }, [entries, currentId]);

  /** Converts the open imported score into an editable document. */
  const editImported = useCallback(() => {
    const entry = entries.find((e) => e.id === currentId);
    if (!entry?.core) return;
    editor.loadScore(JSON.parse(entry.core) as CoreScore);
    editorEntryRef.current = { id: entry.id, addedAt: entry.addedAt };
    setImportNotice(entry.report ? (JSON.parse(entry.report) as ImportReport) : null);
    setMode("edit");
    void putEntry({ ...entry, authored: true, openedAt: Date.now() }).then(refresh);
  }, [entries, currentId, editor, refresh]);

  const startNewScore = useCallback(() => {
    editor.newScore();
    setImportNotice(null);
    const target = { id: newId(), addedAt: Date.now() };
    editorEntryRef.current = target;
    setCurrentId(target.id);
    setMode("edit");
    if (narrow) setLibraryOpen(false);
  }, [editor, narrow]);

  const importFile = useCallback(
    async (file: File) => {
      setMode("play");
      const isTex = /\.(altex|tex)$/i.test(file.name);
      if (isTex) {
        const tex = await file.text();
        pendingRef.current = { id: newId(), format: "altex", bytes: null, tex, fileName: file.name, addedAt: Date.now() };
        loadTex(tex);
      } else {
        const bytes = await file.arrayBuffer();
        pendingRef.current = { id: newId(), format: "gp", bytes, tex: null, fileName: file.name, addedAt: Date.now() };
        loadBytes(bytes);
      }
      if (narrow) setLibraryOpen(false);
    },
    [loadTex, loadBytes, narrow],
  );

  const openEntry = useCallback(
    async (entry: LibraryEntry) => {
      setCurrentId(entry.id);
      setImportNotice(null);
      if (entry.authored && entry.core) {
        // Authored here, so it reopens in the editor.
        editor.loadScore(JSON.parse(entry.core) as CoreScore);
        editorEntryRef.current = { id: entry.id, addedAt: entry.addedAt };
        setMode("edit");
      } else {
        // Imported files open in the player, where alphaTab renders the
        // original faithfully. Editing is an explicit step.
        setMode("play");
        if (entry.tex !== null) loadTex(entry.tex);
        else if (entry.bytes) loadBytes(entry.bytes);
      }
      await putEntry({ ...entry, openedAt: Date.now() });
      await refresh();
      if (narrow) setLibraryOpen(false);
    },
    [editor, loadTex, loadBytes, refresh, narrow],
  );

  const removeEntry = useCallback(
    async (id: string) => {
      await deleteEntry(id);
      if (id === currentId) setCurrentId(null);
      if (editorEntryRef.current?.id === id) {
        editorEntryRef.current = null;
        setMode("play");
      }
      await refresh();
    },
    [currentId, refresh],
  );

  const showLibrary = !sharedView && (!narrow || libraryOpen);
  const editing = !sharedView && mode === "edit";
  const canEditCurrent = !sharedView && entries.some((e) => e.id === currentId && e.core !== null);
  const canShare = !sharedView && entries.some((e) => e.id === currentId);

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
            {editing ? editor.score.title : c.score.title}
            {!editing && c.score.artist && <span style={{ color: theme.textDim }}> — {c.score.artist}</span>}
            <span style={{ color: theme.textDim }}> · {c.score.barCount} bars</span>
          </span>
        )}
        {sharedView && (
          <span
            style={{
              fontFamily: theme.mono, fontSize: 11, color: theme.bg, background: theme.accent,
              padding: "3px 8px", letterSpacing: 0.5,
            }}
          >
            SHARED SCORE
          </span>
        )}
        {sharedView && !shareError && (
          sharedSaved ? (
            <a
              href={location.pathname}
              style={{ ...headerButton, textDecoration: "none", display: "inline-block" }}
            >
              SAVED — OPEN MY LIBRARY
            </a>
          ) : (
            <button onClick={() => void saveSharedToLibrary()} style={headerButton} disabled={!c.score}>
              SAVE TO MY LIBRARY
            </button>
          )
        )}
        <span style={{ flex: 1 }} />
        {!sharedView && narrow && (
          <button onClick={() => setLibraryOpen((v) => !v)} style={headerButton}>LIBRARY</button>
        )}
        {!sharedView && <button onClick={startNewScore} style={headerButton}>NEW</button>}
        {!editing && canEditCurrent && (
          <button onClick={editImported} style={headerButton}>EDIT</button>
        )}
        {editing && (
          <button onClick={() => setMode("play")} style={headerButton}>PLAYER</button>
        )}
        {canShare && (
          <button onClick={() => void shareCurrent()} style={headerButton} disabled={shareBusy}>
            {shareBusy ? "SHARING…" : "SHARE"}
          </button>
        )}
        {!sharedView && (
          <button onClick={() => fileInputRef.current?.click()} style={headerButton}>OPEN</button>
        )}
        <ExportMenu c={c} />
        {!sharedView && (
          <button
            onClick={() => setAccountOpen((v) => !v)}
            style={{
              ...headerButton,
              ...(auth.user ? { background: theme.accent, color: theme.bg } : {}),
            }}
          >
            {auth.user ? auth.user.email.split("@")[0]?.toUpperCase() ?? "ACCOUNT" : "SIGN IN"}
          </button>
        )}
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

      {accountOpen && !sharedView && (
        <AccountPanel
          auth={auth}
          onLibraryChanged={() => void refresh()}
          onClose={() => setAccountOpen(false)}
        />
      )}

      {shareUrl && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 8,
            background: theme.panel, border: `1px solid ${theme.accent}`,
            padding: 10, marginBottom: 10,
          }}
        >
          <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.accent }}>LINK</span>
          <input
            readOnly
            value={shareUrl}
            aria-label="Share link"
            onFocus={(e) => e.target.select()}
            style={{
              flex: 1, minWidth: 0, fontFamily: theme.mono, fontSize: 12,
              padding: "6px 8px", background: theme.bg,
              border: `1px solid ${theme.border}`, color: theme.text,
            }}
          />
          <button
            onClick={() => void navigator.clipboard.writeText(shareUrl).catch(() => undefined)}
            style={headerButton}
          >
            COPY
          </button>
          <button
            onClick={() => setShareUrl(null)}
            style={{ ...headerButton, borderColor: theme.border, color: theme.textDim }}
          >
            ×
          </button>
        </div>
      )}

      {shareError && (
        <div
          style={{
            background: "#2a1010", border: "1px solid #7a2020", color: "#ffb0b0",
            fontFamily: theme.mono, fontSize: 12, padding: 10, marginBottom: 10,
          }}
        >
          {shareError}
        </div>
      )}

      {editing && <EditorBar e={editor} enabled={editing} />}

      {editing && importNotice && importNotice.unsupported.length > 0 && (
        <div
          style={{
            background: "#241a06",
            border: `1px solid ${theme.accent}`,
            color: theme.text,
            fontFamily: theme.mono,
            fontSize: 11,
            padding: 10,
            marginBottom: 10,
            lineHeight: 1.7,
          }}
        >
          <strong style={{ color: theme.accentBright }}>
            Converted for editing. {importNotice.noteCount} notes across{" "}
            {importNotice.trackCount} tracks.
          </strong>
          <br />
          The semantic model does not carry these yet, so they are absent from the editable
          version (the original import is untouched in the library):
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {importNotice.unsupported.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <button
            onClick={() => setImportNotice(null)}
            style={{
              marginTop: 8, fontFamily: theme.mono, fontSize: 11, padding: "4px 10px",
              background: "transparent", border: `1px solid ${theme.border}`,
              color: theme.textDim, cursor: "pointer",
            }}
          >
            DISMISS
          </button>
        </div>
      )}

      <Toolbar c={c} />

      {c.error && (
        <div
          style={{
            background: "#2a1010", border: "1px solid #7a2020", color: "#ffb0b0",
            fontFamily: theme.mono, fontSize: 12, padding: 10, marginBottom: 10, whiteSpace: "pre-wrap",
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
          {!editing && <TrackMixer c={c} />}
          <div
            style={{
              background: theme.panel,
              border: `1px solid ${editing ? theme.accent : theme.border}`,
              padding: 8, position: "relative", minHeight: 200, overflowX: "auto",
            }}
          >
            {c.rendering && (
              <span
                style={{
                  position: "absolute", top: 8, right: 12,
                  fontFamily: theme.mono, fontSize: 11, color: theme.textDim,
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
        {sharedView
          ? "Shared score. Click a note to seek, drag to select a loop region, use the speed trainer to practice. Nothing to install."
          : editing
            ? "Editing. Type 0-9 to enter frets on the highlighted string, arrows to move, +/− to add or remove beats, Enter for a new bar, Ctrl+Z to undo. Work autosaves to the library."
            : "Drop a .gp3/.gp4/.gp5/.gpx/.gp file anywhere to import it. Click a note to seek. Drag across the score to select a loop region, then press LOOP. NEW starts an editable score."}
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
