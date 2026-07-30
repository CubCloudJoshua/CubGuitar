import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAlphaTab } from "./useAlphaTab";
import { useNarrow } from "./useNarrow";
import { useEditor } from "./editor/useEditor";
import { useLibrary } from "./library/useLibrary";
import { adoptUnowned, setLibraryOwner } from "./library/db";
import { useSharedView } from "./share/useSharedView";
import { useShareLink } from "./share/useShareLink";
import { useAuth } from "./auth/useAuth";
import { collabIdFromLocation, useCollab } from "./collab/useCollab";
import { PeerCarets, PeerRoster } from "./collab/PeerCarets";
import { caretEntry, caretsVisible, JoinReveal, useJoinReveal } from "./collab/JoinReveal";
import { useSharedTransport } from "./collab/useSharedTransport";
import { IsoPanel } from "./iso/IsoView";
import { useListening } from "./listen/useListening";
import { BarHeat, ListenReadout, PracticeStrip } from "./listen/ListenPanel";
import { usePracticeHistory } from "./listen/usePracticeHistory";
import { frettedGuitar, STANDARD_BASS, timeline as buildTimeline } from "@cubscore/core";
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
  // The join sequence: the score materializes system by system, then the peer
  // carets fade in (UI-DESIGN.md, signature moment 3).
  const revealPhase = useJoinReveal(collab.joinCount, c.systemBoxes.length);

  /**
   * One playhead for the room (collab/useSharedTransport). Wraps the transport so a
   * local play, pause, stop or seek tells the session, and applies the room's.
   */
  const transport = useSharedTransport({
    target: {
      playing: c.playing,
      playPause: c.playPause,
      stop: c.stop,
      seekTo: c.seekTo,
      positionSeconds: c.positionSeconds,
    },
    live: collab.status === "live",
    send: collab.sendTransport,
  });
  useEffect(() => {
    collab.setTransportListener(transport.apply);
    return () => collab.setTransportListener(null);
  }, [collab, transport.apply]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Perform mode restyles this shell rather than replacing it: see
  // perform/PerformMode.tsx for why the score element must not move.
  const [performing, setPerforming] = useState(false);
  /**
   * The fretboard reader (apps/web/src/iso). Off by default: it is a way of
   * reading a part, not a replacement for notation, and the score is what most
   * people came for.
   */
  const [fretboard, setFretboard] = useState(false);
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

  // Space toggles playback; Cmd/Ctrl+L the library; Cmd/Ctrl+K the palette. The
  // space bar goes through the session's transport like every other play control:
  // it is the one most people actually use, so routing only the buttons would make
  // the room follow a click and ignore a keystroke.
  const playPause = transport.playPause;
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
  /**
   * The fretboard reader needs our semantic model, which is authoritative only
   * while the editor owns the document. An imported file opened in the player is
   * shown from its original bytes, and those are alphaTab's to interpret.
   */
  const showFretboard = fretboard && editing && !performing;
  const scoreTimeline = useMemo(() => buildTimeline(editor.score), [editor.score]);
  /**
   * The neck the fretboard reader draws.
   *
   * The selected track's own instrument when it has strings. When it does not — a
   * piano or vocal staff — the score's first fretted instrument, so a keyboard line
   * can be read on a guitar, which is a real thing a guitarist wants. Standard
   * tuning is the last resort, for a score with no fretted part at all.
   */
  const neck = useMemo(() => {
    const selected = editor.score.tracks[editor.cursor.track]?.instrument;
    if (selected?.kind === "fretted") return selected;
    const fretted = editor.score.tracks.find((t) => t.instrument.kind === "fretted")?.instrument;
    return fretted ?? frettedGuitar();
  }, [editor.score, editor.cursor.track]);
  /**
   * The microphone, graded against the timeline (listen/useListening).
   *
   * Reads the same `scoreTimeline` the fretboard reader draws, which is the whole
   * argument for having built that seam: one derivation of "which note when" now feeds
   * a view, an exporter and a practice report.
   */
  const listening = useListening({
    enabled: editing && !performing,
    timeline: scoreTimeline,
    trackIndex: editor.cursor.track,
    positionSeconds: c.positionSeconds,
    playing: c.playing,
  });
  const showListening = listening.on && editing && !performing;

  /**
   * Practice history for the open score (listen/usePracticeHistory).
   *
   * Keyed on the library entry rather than the document, because the point is a record
   * that survives closing the piece and coming back to it tomorrow.
   */
  const practice = usePracticeHistory(editing ? lib.currentId ?? null : null);
  /**
   * Stores a take when playback stops.
   *
   * A take ends when the playhead does. Recording on every report instead would write a
   * row six times a second, and recording only when the user turns LISTEN off would
   * lose the take of anyone who plays the piece twice.
   *
   * The tempo stored is the first tempo the score states, times the playback speed. For
   * a piece that changes tempo part way through that is an approximation, and the
   * honest one: a take spans the whole piece, so no single number is exactly right, and
   * the written tempo at the top is what a player means by "at what tempo".
   */
  const wasPlaying = useRef(false);
  useEffect(() => {
    const stopped = wasPlaying.current && !c.playing;
    wasPlaying.current = c.playing;
    if (!stopped || !listening.on || !listening.report) return;
    practice.record(listening.report, {
      trackIndex: editor.cursor.track,
      trackName: editor.score.tracks[editor.cursor.track]?.name ?? "Track",
      bpm: (editor.score.tracks[0]?.bars[0]?.tempoBpm ?? 120) * c.speed,
    });
  }, [c.playing, c.speed, listening.on, listening.report, practice, editor.cursor.track, editor.score]);

  const currentEntry = lib.entries.find((e) => e.id === lib.currentId);
  const canEditCurrent = !shared.active && currentEntry?.core != null;
  const canShare = !shared.active && currentEntry !== undefined;
  const error = shared.loadError ?? shareLink.error;

  const commands = useCommands({
    c,
    editor,
    lib,
    collab,
    transport,
    sharedView: shared.active,
    editing,
    canShare,
    shareCurrent: () => void shareLink.share(currentEntry),
    openFilePicker: () => fileInputRef.current?.click(),
    toggleAccount: () => setAccountOpen((v) => !v),
    startPerforming: () => {
      if (collabStatus !== "off") stopCollab();
      if (editing) lib.leaveEditor();
      setPerforming(true);
    },
    listening,
    onArrange: (kind) => {
      const instrument =
        kind === "bass"
          ? { kind: "fretted" as const, tuning: [...STANDARD_BASS], frets: 24, capo: 0 }
          : frettedGuitar();
      const report = editor.arrangeTrack(instrument);
      // An arrangement that transposed a part or could not place a note has to say
      // so, in the same banner an import uses — a user whose piano line moved an
      // octave should not have to work out why.
      lib.setImportNotice({
        unsupported: report.notes,
        trackCount: 1,
        barCount: editor.score.tracks[editor.cursor.track]?.bars.length ?? 0,
        noteCount: report.placed,
      });
    },
    switchDocument,
  });
  // Playback dims the chrome so the score carries the screen; editing keeps
  // its tools at full strength since play-along editing is a real workflow.
  const chromeOpacity = c.playing && !editing ? 0.35 : 1;

  usePerformShell({
    active: performing,
    playing: c.playing,
    scroller,
    onExit: () => setPerforming(false),
    seekSeconds: c.seekSeconds,
    setStageEngraving: c.setStageEngraving,
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
        {editing && !performing && (
          <Button
            variant="outline"
            active={fretboard}
            onClick={() => setFretboard((on) => !on)}
            title="Fretboard reader: the neck in isometric view, notes arriving at a strike line"
          >
            FRETBOARD
          </Button>
        )}
        {editing && !performing && (
          <Button
            variant="outline"
            active={listening.on}
            onClick={listening.toggle}
            title="Listen: play along and see which bars you actually played, from the microphone"
          >
            LISTEN
          </Button>
        )}
        {/* Perform is a reading mode, so it leaves the editor on the way in:
            stage-dark with an edit caret in it would invite typing you cannot
            see the tools for. It also ends a live session, because leaving the
            editor stops the effect that feeds the document into the renderer —
            so collaborators would have gone on editing while the person on stage
            read a score frozen at the moment they walked on. */}
        {!shared.active && c.score && (
          <Button
            variant="outline"
            onClick={() => {
              if (collab.status !== "off") collab.stop();
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
        {/* The semantic document is handed over only while the editor owns it:
            MIDI is written from our model, and for an imported file opened in the
            player there is no model, only the original bytes. */}
        <ExportMenu c={c} {...(editing ? { score: editor.score } : {})} />
        {!shared.active && (
          <Button variant="outline" active={auth.user !== null} onClick={() => setAccountOpen((v) => !v)}>
            {auth.user ? auth.user.email.split("@")[0]?.toUpperCase() ?? "ACCOUNT" : "SIGN IN"}
          </Button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".gp,.gp3,.gp4,.gp5,.gpx,.xml,.musicxml,.cap,.altex,.tex,.txt,.tab"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) switchDocument(() => void lib.importFile(file));
            e.target.value = "";
          }}
        />
      </header>

      {accountOpen && !shared.active && !performing && (
        <AccountPanel
          auth={auth}
          onLibraryChanged={() => void lib.refresh()}
          onClose={() => setAccountOpen(false)}
        />
      )}

      {shareLink.url && !performing && <ShareCard url={shareLink.url} onDismiss={shareLink.dismiss} />}
      {collab.status === "live" && collab.url && !performing && (
        <div
          // A session going live, and people joining or leaving it, is state a
          // sighted user reads off this banner and nobody else was told about.
          role="status"
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
          {/* Where everyone is now shows in the score as coloured carets. What
              is left here is the count, and the same information in words for
              anyone who cannot see a caret in a staff. */}
          <span style={{ color: color.textDim }}>{collab.peers.length} in session</span>
          <PeerRoster cursors={collab.cursors} />
          {/* One playhead for the room. On by default, because reading the same
              chart together is the point of being in a session; off is for someone
              working on their own part in the middle of a rehearsal. */}
          <Button
            variant="outline"
            active={transport.following}
            onClick={() => transport.setFollowing(!transport.following)}
            title={
              transport.following
                ? "Following the session's playhead. Turn off to scrub on your own."
                : "Scrubbing on your own. Turn on to follow the session's playhead."
            }
          >
            {transport.following ? "FOLLOWING" : "FOLLOW"}
          </Button>
          {transport.driver !== null && transport.following && (
            <span style={{ color: color.textDim }}>· {transport.driver} is driving</span>
          )}
        </div>
      )}
      {collab.error && !performing && <ErrorBanner message={collab.error} />}
      {error && !performing && <ErrorBanner message={error} />}

      {editing && !performing && (
        <EditorBar e={editor} enabled={editing && !performing} />
      )}
      {/* Also shown in the player, for an import that converted to nothing
          editable: that user never presses EDIT, so gating this on the editor
          meant they were never told why their file is play-only. */}
      {!performing && lib.importNotice && lib.importNotice.unsupported.length > 0 && (
        <ImportNoticeBanner notice={lib.importNotice} onDismiss={() => lib.setImportNotice(null)} />
      )}

      {listening.error && !performing && <ErrorBanner message={listening.error} />}
      {/* Shown whether or not the microphone is on: a record you have to go and look
          at is a record you stop looking at. */}
      {editing && !performing && practice.summary && (
        <PracticeStrip
          summary={practice.summary}
          barCount={editor.score.tracks[editor.cursor.track]?.bars.length ?? 0}
          onClear={practice.clear}
        />
      )}
      {showListening && (
        <ListenReadout
          report={listening.report}
          current={listening.current}
          heard={listening.heard}
          track={editor.score.tracks[editor.cursor.track]?.name ?? "Track"}
          onClear={listening.clear}
        />
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
            minHeight: performing ? 0 : showFretboard ? 520 : 200,
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
            {showListening && listening.report && (
              <BarHeat report={listening.report} barBoxes={c.barBoxes} />
            )}
            {collab.status === "live" && !performing && caretsVisible(revealPhase) && (
              <PeerCarets cursors={collab.cursors} barBoxes={c.barBoxes} entry={caretEntry(revealPhase)} />
            )}
            {!performing && <JoinReveal phase={revealPhase} systemBoxes={c.systemBoxes} />}
          </div>
          {/* Over the whole score area rather than inside the score's scroller:
              that element is as tall as the engraved music, which is a fraction
              of what a reader needs to show four seconds of neck. Drawn from our
              own timeline and the track's tuning, not from anything alphaTab
              measured — see iso/IsoView. */}
          {showFretboard && (
            <IsoPanel
              timeline={scoreTimeline}
              seconds={c.position.currentTime / 1000}
              neck={neck}
              trackIndex={editor.cursor.track}
            />
          )}
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
            onPlayPause={transport.playPause}
            onStop={transport.stop}
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
      {/* Transport routed through the session when one is live, so pressing play
          here moves the whole room's playhead. */}
      {!performing && (
        <TransportPill
          c={c}
          transport={{ playPause: transport.playPause, stop: transport.stop, seekTo: transport.seekTo }}
        />
      )}
      {/* Mounted fresh on each open: guarantees an empty query and focused
          input regardless of how the previous invocation ended. */}
      {paletteOpen && (
        <CommandPalette open onClose={() => setPaletteOpen(false)} commands={commands} />
      )}
    </div>
  );
}
