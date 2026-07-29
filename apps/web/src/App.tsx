import { useCallback, useEffect, useRef, useState } from "react";
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
import { TrackRail } from "./editor/TrackRail";
import { BarMarkings } from "./editor/BarMarkings";
import { PerformBar, Setlist, TapZone, turnPage, usePerformShell } from "./perform/PerformMode";
import { TransportPill } from "./components/TransportPill";
import { ExportMenu } from "./components/ExportMenu";
import { LibraryPanel } from "./library/LibraryPanel";
import { AccountPanel } from "./auth/AccountPanel";
import { ErrorBanner, ImportNoticeBanner } from "./components/Banners";
import { ShareCard } from "./share/ShareCard";
import { useCommands } from "./commands";
import { Button, buttonStyle, color, CommandPalette, Drawer, font, motion, stage, TextField, typeScale } from "@cubscore/design";

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
  // Perform mode restyles this shell rather than replacing it: see
  // perform/PerformMode.tsx for why the score element must not move.
  const [performing, setPerforming] = useState(false);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);

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

  /**
   * Leaves a live session before changing which document is open.
   *
   * A live session is one shared document. Opening a different one kept the
   * session "live" while silently forking it: from that moment the host's ops
   * addressed ids the guest's document did not contain, so every batch became a
   * no-op on the far side, both banners still read LIVE, and neither person saw
   * the other's edits again. Ending the session is what the user is asking for
   * anyway — they have moved on to another piece of music.
   */
  const { stop: stopCollab, status: collabStatus } = collab;
  const switchDocument = useCallback(
    (open: () => void) => {
      if (collabStatus !== "off") stopCollab();
      open();
    },
    [collabStatus, stopCollab],
  );

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
    startPerforming: () => {
      if (editing) lib.leaveEditor();
      setPerforming(true);
    },
    switchDocument,
  });
  // Playback dims the chrome so the score carries the screen; editing keeps
  // its tools at full strength since play-along editing is a real workflow.
  const chromeOpacity = c.playing && !editing ? 0.35 : 1;

  usePerformShell({
    active: performing,
    scroller,
    onExit: () => setPerforming(false),
    seekSeconds: c.seekSeconds,
    setStageEngraving: c.setStageEngraving,
    setScrollElement: c.setScrollElement,
    zoom: c.zoom,
    setZoom: c.setZoom,
  });

  return (
    <div
      style={
        performing
          ? {
              position: "fixed",
              inset: 0,
              background: stage.bg,
              display: "flex",
              flexDirection: "column",
              padding: 0,
              zIndex: 50,
            }
          : { maxWidth: 1280, margin: "0 auto", padding: narrow ? 10 : 16, paddingBottom: 110 }
      }
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (performing) return;
        const file = e.dataTransfer.files[0];
        if (file) switchDocument(() => void lib.importFile(file));
      }}
    >
      <header
        style={{
          display: performing ? "none" : "flex",
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
        {!shared.active && <Button variant="outline" onClick={() => switchDocument(lib.startNewScore)}>NEW</Button>}
        {!editing && canEditCurrent && (
          <Button variant="outline" onClick={() => switchDocument(() => void lib.editImported())}>EDIT</Button>
        )}
        {editing && (
          <Button variant="outline" onClick={lib.leaveEditor}>PLAYER</Button>
        )}
        {editing && collab.status === "off" && (
          <Button variant="outline" onClick={collab.start}>COLLAB</Button>
        )}
        {/* Perform is a reading mode, so it leaves the editor on the way in:
            stage-dark with an edit caret in it would invite typing you cannot
            see the tools for. */}
        {!shared.active && c.score && (
          <Button
            variant="outline"
            onClick={() => {
              if (editing) lib.leaveEditor();
              setPerforming(true);
            }}
            title="Stage view: big readout, tap to turn pages, Escape to leave"
          >
            PERFORM
          </Button>
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
            if (file) switchDocument(() => void lib.importFile(file));
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

      {shareLink.url && !performing && <ShareCard url={shareLink.url} onDismiss={shareLink.dismiss} />}
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

      {editing && !performing && (
        <EditorBar e={editor} enabled={editing && !performing} allowHistory={collab.status !== "live"} />
      )}
      {editing && !performing && lib.importNotice && lib.importNotice.unsupported.length > 0 && (
        <ImportNoticeBanner notice={lib.importNotice} onDismiss={() => lib.setImportNotice(null)} />
      )}

      {c.error && !performing && <ErrorBanner message={c.error} />}

      <main
        style={
          performing
            ? { minWidth: 0, flex: 1, minHeight: 0, position: "relative", display: "flex" }
            : { minWidth: 0 }
        }
      >
        <div
          style={{
            background: performing ? stage.bg : color.raised,
            border: performing ? "none" : `1px solid ${editing ? color.accent : color.hairline}`,
            borderRadius: performing ? 0 : 8,
            padding: 8,
            position: "relative",
            minHeight: performing ? 0 : 200,
            display: "flex",
            gap: 8,
            // flex-start keeps the track rail from stretching to the score's
            // height. In Perform the score's own box has to be the thing with a
            // bounded height, or its overflow never becomes a scroller and the
            // page grows instead of turning.
            alignItems: performing ? "stretch" : "flex-start",
            ...(performing ? { flex: 1, minWidth: 0 } : {}),
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
          {/* The rail sits beside the score, not above it, so switching tracks
              never moves the music. On a phone it costs an eighth of the width,
              so it only appears once there is something to switch between; the
              palette still adds tracks. */}
          {editing && !performing && (!narrow || editor.score.tracks.length > 1) && (
            <TrackRail
              tracks={editor.score.tracks}
              activeIndex={editor.cursor.track}
              onSelect={editor.selectTrack}
              onAdd={editor.addTrack}
              onRemove={editor.removeTrack}
            />
          )}
          {/* The scroller is the score's own box: the rail must stay put when a
              wide arrangement scrolls sideways. The markings overlay is inside
              it and positioned relative to it, so it scrolls with the music it
              labels instead of floating over a bar it does not belong to.
              In Perform mode this same element becomes the vertical scroller
              alphaTab follows, and the tap zones sit over it. */}
          <div
            ref={setScroller}
            style={
              performing
                ? {
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    position: "relative",
                    overflowY: "auto",
                    overflowX: "hidden",
                    // Wide margins and deep bottom padding: the last system has
                    // to be able to reach the middle of the screen.
                    padding: "0 8% 40vh",
                  }
                : { flex: 1, minWidth: 0, overflowX: "auto", position: "relative" }
            }
          >
            <div ref={c.hostRef} />
            {editing && !performing && <BarMarkings e={editor} barBoxes={c.barBoxes} />}
          </div>
          {performing && (
            <>
              <TapZone side="left" label="Previous page" onTap={() => turnPage(scroller, -1)} />
              <TapZone side="right" label="Next page" onTap={() => turnPage(scroller, 1)} />
            </>
          )}
        </div>
      </main>

      {performing && (
        <>
          <PerformBar
            playing={c.playing}
            currentSeconds={c.position.currentTime / 1000}
            remainingSeconds={Math.max(0, (c.position.endTime - c.position.currentTime) / 1000)}
            onPlayPause={c.playPause}
            onStop={c.stop}
            onExit={() => setPerforming(false)}
          />
          {!c.playing && lib.entries.length > 0 && (
            <Setlist
              entries={lib.entries}
              currentId={lib.currentId}
              onOpen={(entry) => switchDocument(() => void lib.openEntry(entry, { playerOnly: true }))}
            />
          )}
        </>
      )}

      <p
        style={{
          display: performing ? "none" : "block",
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

      {!shared.active && !performing && (
        <Drawer open={lib.libraryOpen} onClose={() => lib.setLibraryOpen(false)} label="Library">
          <LibraryPanel
            entries={lib.entries}
            currentId={lib.currentId}
            onOpen={(e) => switchDocument(() => void lib.openEntry(e))}
            onDelete={(id) => void lib.removeEntry(id)}
            onImportClick={() => fileInputRef.current?.click()}
          />
        </Drawer>
      )}

      {/* The stage has its own, much larger transport. */}
      {!performing && <TransportPill c={c} />}
      {/* Mounted fresh on each open: guarantees an empty query and focused
          input regardless of how the previous invocation ended. */}
      {paletteOpen && (
        <CommandPalette open onClose={() => setPaletteOpen(false)} commands={commands} />
      )}
    </div>
  );
}
