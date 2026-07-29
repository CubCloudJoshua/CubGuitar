import { useEffect, useRef, useState } from "react";
import { useAlphaTab } from "./useAlphaTab";
import { useNarrow } from "./useNarrow";
import { useEditor } from "./editor/useEditor";
import { useLibrary } from "./library/useLibrary";
import { adoptUnowned, setLibraryOwner } from "./library/db";
import { useSharedView } from "./share/useSharedView";
import { useShareLink } from "./share/useShareLink";
import { useAuth } from "./auth/useAuth";
import { collabIdFromLocation, useCollab } from "./collab/useCollab";
import { EditorBar } from "./editor/EditorBar";
import { TransportPill } from "./components/TransportPill";
import { ExportMenu } from "./components/ExportMenu";
import { LibraryPanel } from "./library/LibraryPanel";
import { AccountPanel } from "./auth/AccountPanel";
import { ErrorBanner, ImportNoticeBanner, ShareLinkBar } from "./components/Banners";
import { useCommands } from "./commands";
import { Button, buttonStyle, color, CommandPalette, Drawer, font, motion, TextField, typeScale } from "@cubscore/design";

const headerButton = buttonStyle("outline");

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
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Tell the library whose it is. Every read of the library waits for this, so
  // that a signed-in user is never briefly shown an empty library — which
  // would seed a second demo score into it. Signing in for the first time
  // adopts whatever was made while signed out.
  const { refresh, releaseEditor } = lib;
  const knownOwner = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!auth.checked) return;
    const ownerId = auth.user?.id ?? null;
    if (knownOwner.current === ownerId) return;
    // undefined means this is the first resolution on boot, not a switch.
    const switched = knownOwner.current !== undefined;
    knownOwner.current = ownerId;
    void (async () => {
      if (switched) await releaseEditor();
      if (ownerId) await adoptUnowned(ownerId);
      setLibraryOwner(ownerId);
      await refresh();
    })();
  }, [auth.checked, auth.user, refresh, releaseEditor]);

  // Opened via a collab link: join the room and land in the editor. Guests
  // do not autosave (no library entry); the host's autosave owns the doc.
  const { join } = collab;
  const { setMode, setLibraryOpen } = lib;
  useEffect(() => {
    const roomId = collabIdFromLocation();
    if (!roomId) return;
    join(roomId);
    setMode("edit");
  }, [join, setMode]);

  // Space toggles playback; Cmd/Ctrl+L the library; Cmd/Ctrl+K the palette.
  const { playPause } = c;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "l") {
        ev.preventDefault();
        setLibraryOpen((v) => !v);
        return;
      }
      if (ev.code !== "Space" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return;
      ev.preventDefault();
      playPause();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [playPause, setLibraryOpen]);

  const editing = !shared.active && lib.mode === "edit";
  const currentEntry = lib.entries.find((e) => e.id === lib.currentId);
  const canEditCurrent = !shared.active && currentEntry?.core != null;
  const canShare = !shared.active && currentEntry !== undefined;
  const error = shared.loadError ?? shareLink.error;

  const commands = useCommands({
    c,
    editor,
    lib,
    collab,
    sharedView: shared.active,
    editing,
    canShare,
    shareCurrent: () => void shareLink.share(currentEntry),
    openFilePicker: () => fileInputRef.current?.click(),
    toggleAccount: () => setAccountOpen((v) => !v),
  });
  // Playback dims the chrome so the score carries the screen; editing keeps
  // its tools at full strength since play-along editing is a real workflow.
  const chromeOpacity = c.playing && !editing ? 0.35 : 1;

  return (
    <div
      style={{ maxWidth: 1280, margin: "0 auto", padding: narrow ? 10 : 16, paddingBottom: 110 }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) void lib.importFile(file);
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
          flexWrap: "wrap",
          opacity: chromeOpacity,
          transition: `opacity ${motion.base}`,
        }}
      >
        <h1
          style={{
            color: color.accent,
            fontFamily: font.display,
            fontSize: narrow ? 20 : 26,
            margin: 0,
            letterSpacing: 1.5,
            fontWeight: 400,
          }}
        >
          CubScore
        </h1>
        {c.score && !narrow && (
          <span style={{ fontSize: 13, color: color.text }}>
            {editing ? editor.score.title : c.score.title}
            {!editing && c.score.artist && <span style={{ color: color.textDim }}> — {c.score.artist}</span>}
            <span style={{ color: color.textDim }}> · {c.score.barCount} bars</span>
          </span>
        )}
        {shared.active && (
          <span
            style={{
              fontFamily: font.mono, fontSize: typeScale.sm, color: color.bg, background: color.accent,
              padding: "3px 8px", letterSpacing: 0.5, borderRadius: 4,
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
            <Button variant="outline" onClick={() => void shared.saveToLibrary()} disabled={!c.score}>
              SAVE TO MY LIBRARY
            </Button>
          )
        )}
        <span style={{ flex: 1 }} />
        {!shared.active && (
          <Button variant="outline" onClick={() => lib.setLibraryOpen((v) => !v)} title="Library (Cmd+L)">
            LIBRARY
          </Button>
        )}
        {!shared.active && <Button variant="outline" onClick={lib.startNewScore}>NEW</Button>}
        {!editing && canEditCurrent && (
          <Button variant="outline" onClick={lib.editImported}>EDIT</Button>
        )}
        {editing && (
          <Button variant="outline" onClick={lib.leaveEditor}>PLAYER</Button>
        )}
        {editing && collab.status === "off" && (
          <Button variant="outline" onClick={collab.start}>COLLAB</Button>
        )}
        {collab.status === "live" && (
          <Button
            variant="outline"
            active
            onClick={collab.stop}
            title="End the live session for this device"
          >
            LIVE · {collab.peers.length} — STOP
          </Button>
        )}
        {canShare && (
          <Button
            variant="outline"
            onClick={() => void shareLink.share(currentEntry)}
            disabled={shareLink.busy}
          >
            {shareLink.busy ? "SHARING…" : "SHARE"}
          </Button>
        )}
        {/* A collab guest has no entry of their own: the host's copy owns the
            document. Without this their contributions die with the tab. */}
        {editing && !lib.ownsEditorEntry && (
          <Button variant="outline" onClick={lib.adoptEditorScore} title="Keep a copy in this device's library">
            KEEP A COPY
          </Button>
        )}
        {!shared.active && (
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>OPEN</Button>
        )}
        <ExportMenu c={c} />
        {!shared.active && (
          <Button variant="outline" active={auth.user !== null} onClick={() => setAccountOpen((v) => !v)}>
            {auth.user ? auth.user.email.split("@")[0]?.toUpperCase() ?? "ACCOUNT" : "SIGN IN"}
          </Button>
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
            background: color.raised, border: `1px solid ${color.accent}`, borderRadius: 8,
            padding: 10, marginBottom: 10, fontFamily: font.mono, fontSize: typeScale.sm,
          }}
        >
          <span style={{ color: color.accent, fontWeight: 700 }}>LIVE SESSION</span>
          <TextField
            readOnly
            value={collab.url}
            aria-label="Collab link"
            onFocus={(e) => e.target.select()}
            style={{ flex: 1, minWidth: 160 }}
          />
          <Button
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(collab.url ?? "").catch(() => undefined)}
          >
            COPY
          </Button>
          <span style={{ color: color.textDim }}>
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

      {c.error && <ErrorBanner message={c.error} />}

      <main style={{ minWidth: 0 }}>
        <div
          style={{
            background: color.raised,
            border: `1px solid ${editing ? color.accent : color.hairline}`,
            borderRadius: 8,
            padding: 8,
            position: "relative",
            minHeight: 200,
            overflowX: "auto",
          }}
        >
          {c.rendering && (
            <span
              style={{
                position: "absolute", top: 8, right: 12,
                fontFamily: font.mono, fontSize: typeScale.sm, color: color.textDim,
              }}
            >
              rendering…
            </span>
          )}
          <div ref={c.hostRef} />
        </div>
      </main>

      <p
        style={{
          fontFamily: font.mono,
          fontSize: typeScale.sm,
          color: color.textDim,
          lineHeight: 1.7,
          opacity: chromeOpacity,
          transition: `opacity ${motion.base}`,
        }}
      >
        {shared.active
          ? "Shared score. Click a note to seek, drag to select a loop region, use the speed trainer to practice. Nothing to install. Cmd+K for every command."
          : editing
            ? "Editing. Type 0-9 to enter frets on the highlighted string, arrows to move, +/− to add or remove beats, Enter for a new bar, Ctrl+Z to undo. Cmd+K for every command. Work autosaves to the library."
            : "Drop a .gp3/.gp4/.gp5/.gpx/.gp file anywhere to import it. Click a note to seek. Drag to select a loop region, then press LOOP. NEW starts an editable score. Cmd+K for every command."}
      </p>

      {!shared.active && (
        <Drawer open={lib.libraryOpen} onClose={() => lib.setLibraryOpen(false)} label="Library">
          <LibraryPanel
            entries={lib.entries}
            currentId={lib.currentId}
            onOpen={(e) => void lib.openEntry(e)}
            onDelete={(id) => void lib.removeEntry(id)}
            onImportClick={() => fileInputRef.current?.click()}
          />
        </Drawer>
      )}

      <TransportPill c={c} />
      {/* Mounted fresh on each open: guarantees an empty query and focused
          input regardless of how the previous invocation ended. */}
      {paletteOpen && (
        <CommandPalette open onClose={() => setPaletteOpen(false)} commands={commands} />
      )}
    </div>
  );
}
