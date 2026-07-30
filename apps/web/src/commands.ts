/**
 * The command registry behind Cmd+K. Commands are assembled per render from
 * live context, so the palette only ever offers actions that apply right now.
 */
import { useMemo } from "react";
import type { Command } from "@cubscore/design";
import type { AlphaTabController } from "./useAlphaTab";
import type { EditorController } from "./editor/useEditor";
import type { LibraryController } from "./library/useLibrary";
import type { CollabController } from "./collab/useCollab";
import { exportAscii, exportGp, exportMidi, exportMusicXml, exportTex, printPdf } from "./export";

interface CommandDeps {
  c: AlphaTabController;
  editor: EditorController;
  lib: LibraryController;
  collab: CollabController;
  /** The session-aware transport; see collab/useSharedTransport. */
  transport: { playPause: () => void; stop: () => void };
  sharedView: boolean;
  editing: boolean;
  canShare: boolean;
  shareCurrent: () => void;
  openFilePicker: () => void;
  toggleAccount: () => void;
  startPerforming: () => void;
  /** Arranges the caret's staff for a fretted instrument; see core/arrange. */
  onArrange: (kind: "guitar" | "bass") => void;
  /** The microphone, graded against the score; see listen/useListening. */
  listening: { on: boolean; toggle: () => void };
  /** Runs an action that changes which document is open. See App.tsx. */
  switchDocument: (open: () => void) => void;
}

export function useCommands(deps: CommandDeps): Command[] {
  const { c, editor, lib, collab, sharedView, editing, canShare } = deps;

  return useMemo(() => {
    const commands: Command[] = [];
    const add = (command: Command) => commands.push(command);

    // Playback works in every mode, shared views included. Routed through the
    // session's transport so the palette moves the room's playhead like every other
    // play control — a command that quietly did something different from the button
    // beside it would be the worst kind of inconsistency.
    add({ id: "play", title: c.playing ? "Pause playback" : "Play", section: "Playback", hint: "Space", run: deps.transport.playPause });
    add({ id: "stop", title: "Stop playback", section: "Playback", run: deps.transport.stop });
    add({ id: "loop", title: c.loop ? "Turn loop off" : "Turn loop on", section: "Playback", run: c.toggleLoop });
    add({ id: "metronome", title: c.metronome ? "Turn metronome off" : "Turn metronome on", section: "Playback", run: c.toggleMetronome });
    add({ id: "countin", title: c.countIn ? "Turn count-in off" : "Turn count-in on", section: "Playback", run: c.toggleCountIn });
    for (const speed of [0.5, 0.75, 1]) {
      add({ id: `speed-${speed}`, title: `Set speed to ${speed * 100}%`, section: "Playback", run: () => c.setSpeed(speed) });
    }

    if (!sharedView) {
      // Both change which document is open, so both go through the shell's
      // switch, which ends a live session first rather than forking it.
      add({ id: "new", title: "New score", section: "Score", run: () => deps.switchDocument(lib.startNewScore) });
      add({ id: "open", title: "Open file…", section: "Score", run: deps.openFilePicker });
      add({ id: "library", title: "Toggle library", section: "Score", hint: "Cmd+L", run: () => lib.setLibraryOpen((v) => !v) });
      if (canShare) add({ id: "share", title: "Share current score", section: "Score", run: deps.shareCurrent });
      // Only for an import that has been taken into the editor: its original
      // file is still stored, and this is the way back to it.
      const current = lib.entries.find((e) => e.id === lib.currentId);
      if (current?.bytes && current.authored) {
        add({
          id: "show-original",
          title: "Show imported original",
          section: "Score",
          run: () => void lib.showImportedOriginal(),
        });
      }
      add({ id: "account", title: "Account and sync", section: "Score", run: deps.toggleAccount });
      if (c.score) {
        add({
          id: "perform",
          title: "Perform mode (stage view)",
          section: "Score",
          hint: "Esc leaves",
          run: deps.startPerforming,
        });
      }
    }

    if (c.score) {
      add({ id: "export-gp", title: "Export Guitar Pro (.gp)", section: "Export", run: () => { const s = c.getScore(); if (s) exportGp(s); } });
      // Ours from the semantic model while the editor owns the document;
      // alphaTab's reading of the original bytes otherwise.
      add({ id: "export-midi", title: "Export MIDI", section: "Export", run: () => { if (editing) exportMidi(editor.score); else c.getApi()?.downloadMidi(); } });
      add({ id: "export-tex", title: "Export alphaTex", section: "Export", run: () => { const s = c.getScore(); if (s) exportTex(s); } });
      if (editing) {
        // The format every other notation program reads, which makes it the way a part
        // leaves here for an arranger, a teacher or a school's existing software.
        add({ id: "export-musicxml", title: "Export MusicXML", section: "Export", run: () => exportMusicXml(editor.score) });
        add({ id: "export-ascii", title: "Copy as ASCII tab", section: "Export", run: () => void exportAscii(editor.score) });
      }
      add({ id: "export-pdf", title: "Print / PDF", section: "Export", run: () => { const api = c.getApi(); if (api) printPdf(api); } });
    }

    if (editing) {
      add({ id: "player-mode", title: "Back to player", section: "Edit", run: lib.leaveEditor });
      add({ id: "add-guitar", title: "Add guitar track", section: "Edit", run: () => editor.addTrack("guitar") });
      add({ id: "add-bass", title: "Add bass track", section: "Edit", run: () => editor.addTrack("bass") });
      // The instrument rail is the visible way to switch; these are how a
      // keyboard-only user gets there, and they name the track so the palette
      // teaches the arrangement rather than just listing indexes.
      editor.score.tracks.forEach((t, i) => {
        if (i === editor.cursor.track) return;
        add({ id: `track-${t.id}`, title: `Go to track: ${t.name}`, section: "Edit", run: () => editor.selectTrack(i) });
      });
      if (editor.score.tracks.length > 1) {
        add({ id: "remove-track", title: "Remove active track", section: "Edit", run: editor.removeTrack });
      }
      add({ id: "add-bar", title: "Add bar", section: "Edit", hint: "Enter", run: editor.addBar });
      // Arranging a part for a fretted instrument. Offered only for a staff that is
      // not already one — the interesting case is a piano or vocal line, which is
      // read-only in this editor precisely because it has no strings to type frets
      // on. This is the way to give it some.
      if (editor.score.tracks[editor.cursor.track]?.instrument.kind === "pitched") {
        add({
          id: "arrange-guitar",
          title: "Arrange this staff for guitar",
          section: "Edit",
          run: () => deps.onArrange("guitar"),
        });
        add({
          id: "arrange-bass",
          title: "Arrange this staff for bass",
          section: "Edit",
          run: () => deps.onArrange("bass"),
        });
      }
      // Offered during a live session too: undo sends the inverse of this
      // client's own edit through the server, so it converges like any batch.
      // Practice, not playback: this changes what the app is doing with your
      // playing, not with its own. Grouped on its own so it does not read as
      // another transport control.
      add({
        id: "listen",
        title: deps.listening.on ? "Stop listening" : "Listen and grade my playing",
        section: "Practice",
        run: deps.listening.toggle,
      });
      add({ id: "undo", title: "Undo", section: "Edit", hint: "Cmd+Z", run: editor.undo });
      add({ id: "redo", title: "Redo", section: "Edit", hint: "Cmd+Shift+Z", run: editor.redo });
      for (const [label, d] of [["whole", 1], ["half", 2], ["quarter", 4], ["eighth", 8], ["sixteenth", 16]] as const) {
        add({ id: `dur-${d}`, title: `Set duration to ${label}`, section: "Edit", run: () => editor.setDuration(d) });
      }
      for (const [label, articulation] of [
        ["palm mute", "palmMute"],
        ["let ring", "letRing"],
        ["vibrato", "vibrato"],
        ["bend", "bend"],
        ["slide", "slide"],
        ["hammer-on / pull-off", "hammerOn"],
        ["natural harmonic", "naturalHarmonic"],
        ["dead note", "deadNote"],
        ["staccato", "staccato"],
        ["accent", "accent"],
        ["ghost note", "ghost"],
      ] as const) {
        add({ id: `art-${articulation}`, title: `Toggle ${label}`, section: "Edit", run: () => editor.toggleArticulation(articulation) });
      }
      if (collab.status === "off") {
        add({ id: "collab", title: "Start live session", section: "Session", run: collab.start });
      }
    }
    if (collab.status === "live") {
      add({ id: "collab-stop", title: "Leave live session", section: "Session", run: collab.stop });
    }

    return commands;
  }, [c, editor, lib, collab, sharedView, editing, canShare, deps]);
}
