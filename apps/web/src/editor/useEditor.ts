import { useCallback, useMemo, useRef, useState } from "react";
import {
  applyBatch,
  beatTicks,
  createBar,
  createNote,
  createRest,
  createScore,
  createTrack,
  duration,
  frettedGuitar,
  nextId,
  pitchAt,
  STANDARD_BASS,
  tickAt,
  toAlphaTex,
  type Articulation,
  type Beat,
  type Op,
  type OpBatch,
  type OpKind,
  type Score,
} from "@cubscore/core";

export interface Cursor {
  track: number;
  bar: number;
  /** Index within the bar's first voice. */
  beat: number;
  /** 1-based, string 1 is the highest. */
  string: number;
}

const AUTHOR = "local";
/** Window for typing a two-digit fret, matching Guitar Pro's behaviour. */
const DIGIT_WINDOW_MS = 900;

function op(kind: OpKind): Op {
  return { id: nextId("o"), author: AUTHOR, at: 0, ...kind };
}

/** Score plus undo stacks, updated atomically so they can never disagree. */
interface EditorState {
  score: Score;
  past: Score[];
  future: Score[];
}

export function useEditor() {
  const [state, setState] = useState<EditorState>(() => ({
    score: createScore("New Score"),
    past: [],
    future: [],
  }));
  const { score, past, future } = state;
  const [cursor, setCursor] = useState<Cursor>({ track: 0, bar: 0, beat: 0, string: 1 });
  /** The op log. Undo uses snapshots today; the log is what sync will replay. */
  const logRef = useRef<OpBatch[]>([]);
  const digitRef = useRef<{ value: number; at: number } | null>(null);
  /** Collab tap: every locally committed batch is handed to this listener. */
  const commitListenerRef = useRef<((batch: OpBatch) => void) | null>(null);

  const track = score.tracks[cursor.track];
  const bar = track?.bars[cursor.bar];
  const voice = bar?.voices[0];
  const beat: Beat | undefined = voice?.beats[cursor.beat];

  const commit = useCallback((ops: Op[], label: string) => {
    if (ops.length === 0) return;
    const batch: OpBatch = { id: nextId("k"), ops, label };
    // Handlers run once per user action (unlike updaters), so this cannot
    // double-send under StrictMode. An ineffective batch no-ops remotely too.
    commitListenerRef.current?.(batch);
    setState((prev) => {
      const nextScore = applyBatch(prev.score, batch);
      if (nextScore === prev.score) return prev;
      // React StrictMode invokes updaters twice in development; the id check
      // keeps the log from recording the batch twice.
      if (logRef.current.at(-1)?.id !== batch.id) logRef.current.push(batch);
      return { score: nextScore, past: [...prev.past, prev.score], future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    setState((prev) => {
      const previous = prev.past[prev.past.length - 1];
      if (!previous) return prev;
      return {
        score: previous,
        past: prev.past.slice(0, -1),
        future: [prev.score, ...prev.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((prev) => {
      const next = prev.future[0];
      if (!next) return prev;
      return {
        score: next,
        past: [...prev.past, prev.score],
        future: prev.future.slice(1),
      };
    });
  }, []);

  /**
   * Applies a batch from a collaborator, and drops local history when it lands.
   *
   * A snapshot taken before someone else's edit no longer describes any
   * document the group shares, so restoring it would erase their work. History
   * gated only on "is the socket live" was worse than useless: the moment a
   * session ended or the connection dropped, one Ctrl+Z reinstated a pre-collab
   * snapshot and autosaved it over everything the session produced. Undo
   * resumes from edits made after the remote batch.
   */
  const applyRemote = useCallback((batch: OpBatch) => {
    setState((prev) => {
      const nextScore = applyBatch(prev.score, batch);
      if (nextScore === prev.score) return prev;
      return { score: nextScore, past: [], future: [] };
    });
  }, []);

  const setCommitListener = useCallback((listener: ((batch: OpBatch) => void) | null) => {
    commitListenerRef.current = listener;
  }, []);

  /** Enters a fret on the cursor's string, combining consecutive digits into 10-24. */
  const typeDigit = useCallback(
    (digit: number) => {
      if (!beat || !track) return;
      const now = performance.now();
      const pending = digitRef.current;
      let fret = digit;
      if (pending && now - pending.at < DIGIT_WINDOW_MS) {
        const combined = pending.value * 10 + digit;
        const maxFret = track.instrument.kind === "fretted" ? track.instrument.frets : 24;
        if (combined <= maxFret) fret = combined;
      }
      digitRef.current = { value: fret, at: now };

      const note = createNote(pitchAt(track.instrument, cursor.string, fret), cursor.string, fret);
      commit([op({ type: "note.insert", beatId: beat.id, note })], `Fret ${fret}`);
    },
    [beat, track, cursor.string, commit],
  );

  const deleteNote = useCallback(() => {
    if (!beat) return;
    const note = beat.notes.find((n) => n.string === cursor.string);
    if (!note) return;
    digitRef.current = null;
    commit([op({ type: "note.remove", noteId: note.id })], "Delete note");
  }, [beat, cursor.string, commit]);

  const setDuration = useCallback(
    (denominator: number) => {
      if (!beat) return;
      digitRef.current = null;
      commit([op({ type: "beat.setDuration", beatId: beat.id, duration: duration(denominator) })], "Duration");
    },
    [beat, commit],
  );

  const toggleDot = useCallback(() => {
    if (!beat) return;
    commit([op({ type: "beat.setDots", beatId: beat.id, dots: beat.dots === 1 ? 0 : 1 })], "Dot");
  }, [beat, commit]);

  const toggleArticulation = useCallback(
    (articulation: Articulation) => {
      if (!beat) return;
      const note = beat.notes.find((n) => n.string === cursor.string);
      if (!note) return;
      const has = note.articulations.includes(articulation);
      commit(
        [
          op(
            has
              ? { type: "note.removeArticulation", noteId: note.id, articulation }
              : { type: "note.addArticulation", noteId: note.id, articulation },
          ),
        ],
        articulation,
      );
    },
    [beat, cursor.string, commit],
  );

  const insertBeat = useCallback(() => {
    if (!voice || !beat) return;
    digitRef.current = null;
    commit(
      [op({ type: "beat.insert", voiceId: voice.id, index: cursor.beat + 1, beat: createRest(beat.duration) })],
      "Insert beat",
    );
    setCursor((c) => ({ ...c, beat: c.beat + 1 }));
  }, [voice, beat, cursor.beat, commit]);

  const removeBeat = useCallback(() => {
    if (!voice || !beat || voice.beats.length <= 1) return;
    digitRef.current = null;
    commit([op({ type: "beat.remove", voiceId: voice.id, beatId: beat.id })], "Remove beat");
    setCursor((c) => ({ ...c, beat: Math.max(0, c.beat - 1) }));
  }, [voice, beat, commit]);

  const addBar = useCallback(() => {
    if (!track) return;
    digitRef.current = null;
    commit([op({ type: "bar.insert", trackId: track.id, index: track.bars.length, bar: createBar() })], "Add bar");
  }, [track, commit]);

  const setTitle = useCallback(
    (title: string) => commit([op({ type: "score.setTitle", title })], "Title"),
    [commit],
  );

  const setArtist = useCallback(
    (artist: string) => commit([op({ type: "score.setArtist", artist })], "Artist"),
    [commit],
  );

  /** Tempo lives on the first bar of the first track; alphaTab applies it globally. */
  const setTempo = useCallback(
    (tempoBpm: number) => {
      const firstBar = score.tracks[0]?.bars[0];
      if (!firstBar || !Number.isFinite(tempoBpm)) return;
      const clamped = Math.max(20, Math.min(400, Math.round(tempoBpm)));
      commit([op({ type: "bar.setTempo", barId: firstBar.id, tempoBpm: clamped })], "Tempo");
    },
    [score, commit],
  );

  /**
   * Sets the meter from the cursor's bar onward (notation-level; existing
   * beats keep their durations, matching how tab editors treat meter edits).
   * Applied to the same bar index on every track so the masterbar agrees.
   */
  const setTimeSignature = useCallback(
    (beats: number, beatValue: number) => {
      if (beats < 1 || beats > 32 || ![1, 2, 4, 8, 16].includes(beatValue)) return;
      const ops: Op[] = [];
      for (const t of score.tracks) {
        const targetBar = t.bars[cursor.bar];
        if (targetBar) {
          ops.push(
            op({ type: "bar.setTimeSignature", barId: targetBar.id, timeSignature: { beats, beatValue } }),
          );
        }
      }
      commit(ops, "Time signature");
    },
    [score, cursor.bar, commit],
  );

  const selectTrack = useCallback((index: number) => {
    digitRef.current = null;
    setCursor((c) => ({ ...c, track: index, bar: 0, beat: 0, string: 1 }));
  }, []);

  const addTrack = useCallback(
    (kind: "guitar" | "bass") => {
      const barCount = Math.max(1, score.tracks[0]?.bars.length ?? 4);
      const newTrack =
        kind === "guitar"
          ? createTrack("Guitar", frettedGuitar(), barCount)
          : createTrack("Bass", { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, barCount);
      commit([op({ type: "track.insert", index: score.tracks.length, track: newTrack })], "Add track");
      setCursor({ track: score.tracks.length, bar: 0, beat: 0, string: 1 });
    },
    [score, commit],
  );

  const removeTrack = useCallback(() => {
    if (score.tracks.length <= 1) return;
    const target = score.tracks[cursor.track];
    if (!target) return;
    commit([op({ type: "track.remove", trackId: target.id })], "Remove track");
    setCursor({ track: 0, bar: 0, beat: 0, string: 1 });
  }, [score, cursor.track, commit]);

  const renameTrack = useCallback(
    (name: string) => {
      const target = score.tracks[cursor.track];
      if (!target) return;
      commit([op({ type: "track.rename", trackId: target.id, name })], "Rename track");
    },
    [score, cursor.track, commit],
  );

  const moveBeat = useCallback(
    (delta: number) => {
      digitRef.current = null;
      setCursor((c) => {
        const t = score.tracks[c.track];
        if (!t) return c;
        let barIndex = c.bar;
        let beatIndex = c.beat + delta;
        while (beatIndex < 0 && barIndex > 0) {
          barIndex -= 1;
          beatIndex += t.bars[barIndex]?.voices[0]?.beats.length ?? 1;
        }
        let count = t.bars[barIndex]?.voices[0]?.beats.length ?? 1;
        while (beatIndex >= count && barIndex < t.bars.length - 1) {
          beatIndex -= count;
          barIndex += 1;
          count = t.bars[barIndex]?.voices[0]?.beats.length ?? 1;
        }
        return { ...c, bar: barIndex, beat: Math.max(0, Math.min(beatIndex, count - 1)) };
      });
    },
    [score],
  );

  const moveString = useCallback(
    (delta: number) => {
      digitRef.current = null;
      setCursor((c) => {
        const t = score.tracks[c.track];
        const strings = t?.instrument.kind === "fretted" ? t.instrument.tuning.length : 6;
        return { ...c, string: Math.max(1, Math.min(strings, c.string + delta)) };
      });
    },
    [score],
  );

  const newScore = useCallback((title = "New Score") => {
    digitRef.current = null;
    logRef.current = [];
    setState({ score: createScore(title), past: [], future: [] });
    setCursor({ track: 0, bar: 0, beat: 0, string: 1 });
  }, []);

  const loadScore = useCallback((next: Score) => {
    digitRef.current = null;
    logRef.current = [];
    setState({ score: next, past: [], future: [] });
    setCursor({ track: 0, bar: 0, beat: 0, string: 1 });
  }, []);

  const tex = useMemo(() => toAlphaTex(score), [score]);
  const cursorTick = useMemo(
    () => (track ? tickAt(track, cursor.bar, cursor.beat) : 0),
    [track, cursor.bar, cursor.beat],
  );
  const beatDurationTicks = beat ? beatTicks(beat) : 0;

  return {
    score,
    tex,
    cursor,
    setCursor,
    cursorTick,
    beatDurationTicks,
    currentBeat: beat,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    opCount: logRef.current.length,
    typeDigit,
    deleteNote,
    setDuration,
    toggleDot,
    toggleArticulation,
    insertBeat,
    removeBeat,
    addBar,
    setTitle,
    setArtist,
    setTempo,
    setTimeSignature,
    selectTrack,
    addTrack,
    removeTrack,
    renameTrack,
    moveBeat,
    moveString,
    undo,
    redo,
    applyRemote,
    setCommitListener,
    newScore,
    loadScore,
  };
}

export type EditorController = ReturnType<typeof useEditor>;
