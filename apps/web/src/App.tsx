import { useEffect, useRef, useState } from "react";
import { theme } from "./theme";
import { useAlphaTab } from "./useAlphaTab";
import { useNarrow } from "./useNarrow";
import { useEditor } from "./editor/useEditor";
import { useLibrary } from "./library/useLibrary";
import { useSharedView } from "./share/useSharedView";
import { useShareLink } from "./share/useShareLink";
import { useAuth } from "./auth/useAuth";
import { collabIdFromLocation, useCollab } from "./collab/useCollab";
import { EditorBar } from "./editor/EditorBar";
import { Toolbar } from "./components/Toolbar";
import { TrackMixer } from "./components/TrackMixer";
import { ExportMenu } from "./components/ExportMenu";
import { LibraryPanel } from "./library/LibraryPanel";
import { AccountPanel } from "./auth/AccountPanel";
import { ErrorBanner, ImportNoticeBanner, ShareLinkBar } from "./components/Banners";
import { headerButton } from "./components/styles";

export function App() {
  const c = useAlphaTab();
  const editor = useEditor();
  const narrow = useNarrow();
  const shared = useSharedView(c);
  // A collab guest gets the host's document from the room; seeding the demo
  // or reopening their own library on boot would race alphaTab with three
  // overlapping loads (observed as a crash in its worker message handling).
  const [joinedCollab] = useState(() => collabIdFromLocation() !== null);
  const lib = useLibrary(c, editor, narrow, shared.active || joinedCollab);
  const shareLink = useShareLink();
  const auth = useAuth();
  const collab = useCollab(editor, auth.user?.email.split("@")[0] ?? "guest");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  // Opened via a collab link: join the room and land in the editor. Guests
  // do not autosave (no library entry); the host's autosave owns the doc.
  const { join } = collab;
  const { setMode } = lib;
  useEffect(() => {
    const roomId = collabIdFromLocation();
    if (!roomId) return;
    join(roomId);
    setMode("edit");
  }, [join, setMode]);

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

  const showLibrary = !shared.active && (!narrow || lib.libraryOpen);
  const editing = !shared.active && lib.mode === "edit";
  const currentEntry = lib.entries.find((e) => e.id === lib.currentId);
  const canEditCurrent = !shared.active && currentEntry?.core != null;
  const canShare = !shared.active && currentEntry !== undefined;
  const error = shared.loadError ?? shareLink.error;

  return (
    <div
      style={{ maxWidth: 1280, margin: "0 auto", padding: narrow ? 10 : 16 }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) void lib.importFile(file);
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
        {shared.active && (
          <span
            style={{
              fontFamily: theme.mono, fontSize: 11, color: theme.bg, background: theme.accent,
              padding: "3px 8px", letterSpacing: 0.5,
            }}
          >
            SHARED SCORE
          </span>
        )}
        {shared.active && !shared.loadError && (
          shared.saved ? (
            <a
              href={location.pathname}
              style={{ ...headerButton, textDecoration: "none", display: "inline-block" }}
            >
              SAVED — OPEN MY LIBRARY
            </a>
          ) : (
            <button onClick={() => void shared.saveToLibrary()} style={headerButton} disabled={!c.score}>
              SAVE TO MY LIBRARY
            </button>
          )
        )}
        <span style={{ flex: 1 }} />
        {!shared.active && narrow && (
          <button onClick={() => lib.setLibraryOpen((v) => !v)} style={headerButton}>LIBRARY</button>
        )}
        {!shared.active && <button onClick={lib.startNewScore} style={headerButton}>NEW</button>}
        {!editing && canEditCurrent && (
          <button onClick={lib.editImported} style={headerButton}>EDIT</button>
        )}
        {editing && (
          <button onClick={() => lib.setMode("play")} style={headerButton}>PLAYER</button>
        )}
        {editing && collab.status === "off" && (
          <button onClick={collab.start} style={headerButton}>COLLAB</button>
        )}
        {collab.status === "live" && (
          <button
            onClick={collab.stop}
            style={{ ...headerButton, background: theme.accent, color: theme.bg }}
            title="End the live session for this device"
          >
            LIVE · {collab.peers.length} — STOP
          </button>
        )}
        {canShare && (
          <button
            onClick={() => void shareLink.share(currentEntry)}
            style={headerButton}
            disabled={shareLink.busy}
          >
            {shareLink.busy ? "SHARING…" : "SHARE"}
          </button>
        )}
        {!shared.active && (
          <button onClick={() => fileInputRef.current?.click()} style={headerButton}>OPEN</button>
        )}
        <ExportMenu c={c} />
        {!shared.active && (
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
            if (file) void lib.importFile(file);
            e.target.value = "";
          }}
        />
      </header>

      {accountOpen && !shared.active && (
        <AccountPanel
          auth={auth}
          onLibraryChanged={() => void lib.refresh()}
          onClose={() => setAccountOpen(false)}
        />
      )}

      {shareLink.url && <ShareLinkBar url={shareLink.url} onDismiss={shareLink.dismiss} />}
      {collab.status === "live" && collab.url && (
        <div
          style={{
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
            background: theme.panel, border: `1px solid ${theme.accent}`,
            padding: 10, marginBottom: 10, fontFamily: theme.mono, fontSize: 11,
          }}
        >
          <span style={{ color: theme.accent, fontWeight: 700 }}>LIVE SESSION</span>
          <input
            readOnly
            value={collab.url}
            aria-label="Collab link"
            onFocus={(e) => e.target.select()}
            style={{
              flex: 1, minWidth: 160, fontFamily: theme.mono, fontSize: 12,
              padding: "6px 8px", background: theme.bg,
              border: `1px solid ${theme.border}`, color: theme.text,
            }}
          />
          <button
            onClick={() => void navigator.clipboard.writeText(collab.url ?? "").catch(() => undefined)}
            style={headerButton}
          >
            COPY
          </button>
          <span style={{ color: theme.textDim }}>
            {collab.peers.length} in session
            {[...collab.cursors.values()]
              .map((p) => ` · ${p.name} at bar ${p.bar + 1}, beat ${p.beat + 1}`)
              .join("")}
          </span>
        </div>
      )}
      {collab.error && <ErrorBanner message={collab.error} />}
      {error && <ErrorBanner message={error} />}

      {editing && <EditorBar e={editor} enabled={editing} allowHistory={collab.status !== "live"} />}
      {editing && lib.importNotice && lib.importNotice.unsupported.length > 0 && (
        <ImportNoticeBanner notice={lib.importNotice} onDismiss={() => lib.setImportNotice(null)} />
      )}

      <Toolbar c={c} />
      {c.error && <ErrorBanner message={c.error} />}

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
            entries={lib.entries}
            currentId={lib.currentId}
            onOpen={(e) => void lib.openEntry(e)}
            onDelete={(id) => void lib.removeEntry(id)}
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
        {shared.active
          ? "Shared score. Click a note to seek, drag to select a loop region, use the speed trainer to practice. Nothing to install."
          : editing
            ? "Editing. Type 0-9 to enter frets on the highlighted string, arrows to move, +/− to add or remove beats, Enter for a new bar, Ctrl+Z to undo. Work autosaves to the library."
            : "Drop a .gp3/.gp4/.gp5/.gpx/.gp file anywhere to import it. Click a note to seek. Drag across the score to select a loop region, then press LOOP. NEW starts an editable score."}
      </p>
    </div>
  );
}
