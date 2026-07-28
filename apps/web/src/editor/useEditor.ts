import { useCallback, useMemo, useRef, useState } from "react";
import {
  applyBatch,
  beatTicks,
  createBar,
  createNote,
  createRest,
  createScore,
  duration,
  nextId,
  pitchAt,
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

export function useEditor() {
  const [score, setScore] = useState<Score>(() => createScore("New Score"));
  const [cursor, setCursor] = useState<Cursor>({ track: 0, bar: 0, beat: 0, string: 1 });
  const [past, setPast] = useState<Score[]>([]);
  const [future, setFuture] = useState<Score[]>([]);
  /** The op log. Undo uses snapshots today; the log is what sync will replay. */
  const logRef = useRef<OpBatch[]>([]);
  const digitRef = useRef<{ value: number; at: number } | null>(null);

  const track = score.tracks[cursor.track];
  const bar = track?.bars[cursor.bar];
  const voice = bar?.voices[0];
  const beat: Beat | undefined = voice?.beats[cursor.beat];

  const commit = useCallback(
    (ops: Op[], label: string) => {
      if (ops.length === 0) return;
      const batch: OpBatch = { id: nextId("k"), ops, label };
      setScore((prev) => {
        const next = applyBatch(prev, batch);
        if (next === prev) return prev;
        setPast((p) => [...p, prev]);
        setFuture([]);
        logRef.current.push(batch);
        return next;
      });
    },
    [],
  );

  const undo = useCallback(() => {
    setPast((p) => {
      const previous = p[p.length - 1];
      if (!previous) return p;
      setScore((current) => {
        setFuture((f) => [current, ...f]);
        return previous;
      });
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      const next = f[0];
      if (!next) return f;
      setScore((current) => {
        setPast((p) => [...p, current]);
        return next;
      });
      return f.slice(1);
    });
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
    setPast([]);
    setFuture([]);
    setScore(createScore(title));
    setCursor({ track: 0, bar: 0, beat: 0, string: 1 });
  }, []);

  const loadScore = useCallback((next: Score) => {
    digitRef.current = null;
    logRef.current = [];
    setPast([]);
    setFuture([]);
    setScore(next);
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
    moveBeat,
    moveString,
    undo,
    redo,
    newScore,
    loadScore,
  };
}

export type EditorController = ReturnType<typeof useEditor>;
