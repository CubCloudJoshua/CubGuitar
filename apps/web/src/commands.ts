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
import { exportGp, exportMidi, exportTex, printPdf } from "./export";

interface CommandDeps {
  c: AlphaTabController;
  editor: EditorController;
  lib: LibraryController;
  collab: CollabController;
  sharedView: boolean;
  editing: boolean;
  canShare: boolean;
  shareCurrent: () => void;
  openFilePicker: () => void;
  toggleAccount: () => void;
}

export function useCommands(deps: CommandDeps): Command[] {
  const { c, editor, lib, collab, sharedView, editing, canShare } = deps;

  return useMemo(() => {
    const commands: Command[] = [];
    const add = (command: Command) => commands.push(command);

    // Playback works in every mode, shared views included.
    add({ id: "play", title: c.playing ? "Pause playback" : "Play", section: "Playback", hint: "Space", run: c.playPause });
    add({ id: "stop", title: "Stop playback", section: "Playback", run: c.stop });
    add({ id: "loop", title: c.loop ? "Turn loop off" : "Turn loop on", section: "Playback", run: c.toggleLoop });
    add({ id: "metronome", title: c.metronome ? "Turn metronome off" : "Turn metronome on", section: "Playback", run: c.toggleMetronome });
    add({ id: "countin", title: c.countIn ? "Turn count-in off" : "Turn count-in on", section: "Playback", run: c.toggleCountIn });
    for (const speed of [0.5, 0.75, 1]) {
      add({ id: `speed-${speed}`, title: `Set speed to ${speed * 100}%`, section: "Playback", run: () => c.setSpeed(speed) });
    }

    if (!sharedView) {
      add({ id: "new", title: "New score", section: "Score", run: lib.startNewScore });
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
    }

    if (c.score) {
      add({ id: "export-gp", title: "Export Guitar Pro (.gp)", section: "Export", run: () => { const s = c.getScore(); if (s) exportGp(s); } });
      add({ id: "export-midi", title: "Export MIDI", section: "Export", run: () => { const api = c.getApi(); if (api) exportMidi(api); } });
      add({ id: "export-tex", title: "Export alphaTex", section: "Export", run: () => { const s = c.getScore(); if (s) exportTex(s); } });
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
      const allowHistory = collab.status !== "live";
      if (allowHistory) {
        add({ id: "undo", title: "Undo", section: "Edit", hint: "Cmd+Z", run: editor.undo });
        add({ id: "redo", title: "Redo", section: "Edit", hint: "Cmd+Shift+Z", run: editor.redo });
      }
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
