import { useCallback, useMemo, useRef, useState } from "react";
import {
  applyBatch,
  beginSession,
  beatTicks,
  createBar,
  createNote,
  createRest,
  createScore,
  createTrack,
  duration,
  frettedGuitar,
  invertBatch,
  localCommit,
  nextId,
  pitchAt,
  serverBatch,
  sessionView,
  STANDARD_BASS,
  tickAt,
  toAlphaTex,
  type Articulation,
  type Beat,
  type Op,
  type OpBatch,
  type OpKind,
  type Score,
  type Session,
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
/**
 * How far back undo reaches. Inverse ops are a few hundred bytes each, unlike
 * the whole-document snapshots this replaced — an unbounded stack of those on an
 * imported 274-bar score was megabytes per keystroke.
 */
const HISTORY_LIMIT = 200;

function op(kind: OpKind): Op {
  return { id: nextId("o"), author: AUTHOR, at: 0, ...kind };
}

/**
 * One undo step: what the gesture did, and what takes it back.
 *
 * Both directions are ops, so undo and redo travel the same road as a keystroke
 * — through the log, through the server in a live session, applied by every
 * client. See @cubscore/core/invert for why undo cannot be snapshots.
 */
interface HistoryEntry {
  ops: Op[];
  inverse: Op[];
  label: string;
}

interface EditorState {
  score: Score;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /**
   * Non-null while a live session owns ordering, in which case `score` is a
   * projection of it rather than the document itself. The rule and its
   * reasoning live in @cubscore/core/session, where they are tested against a
   * model of the sync server.
   */
  live: Session | null;
}

/**
 * Folds a batch into the document, live or local, leaving history alone.
 *
 * Returns the same state when nothing moved, so callers can tell an edit from a
 * gesture that asked for what was already there.
 */
function fold(prev: EditorState, batch: OpBatch): EditorState {
  if (prev.live) {
    const live = localCommit(prev.live, batch);
    return { ...prev, score: sessionView(live), live };
  }
  const score = applyBatch(prev.score, batch);
  return score === prev.score ? prev : { ...prev, score };
}

export function useEditor() {
  const [state, setState] = useState<EditorState>(() => ({
    score: createScore("New Score"),
    past: [],
    future: [],
    live: null,
  }));
  const { score, past, future } = state;
  /**
   * The state as of the last call, not the last render.
   *
   * Every mutator below reads this, computes the whole next state, and
   * publishes it, rather than passing an updater to setState. Two reasons.
   *
   * Undo has to know which entry it is undoing at the moment the key is
   * pressed, because it sends that entry's inverse to the sync server — which
   * happens outside React's updater. Deciding inside one instead would make two
   * Ctrl+Z presses in a single tick both read the same top-of-stack and undo
   * the same edit twice, sending one edit's inverse to the room twice.
   *
   * And a remote batch arriving from the socket in the same tick as a keystroke
   * has to see that keystroke. Updaters would order correctly among themselves,
   * but the ops sent to the server are built outside them, from values that
   * would already be a tick stale.
   */
  const stateRef = useRef(state);
  const publish = useCallback((next: EditorState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const [cursor, setCursor] = useState<Cursor>({ track: 0, bar: 0, beat: 0, string: 1 });
  /** The op log, undo and redo batches included. What sync replays. */
  const logRef = useRef<OpBatch[]>([]);
  const digitRef = useRef<{ value: number; at: number } | null>(null);
  /** Collab tap: every locally committed batch is handed to this listener. */
  const commitListenerRef = useRef<((batch: OpBatch) => void) | null>(null);

  const track = score.tracks[cursor.track];
  const bar = track?.bars[cursor.bar];
  const voice = bar?.voices[0];
  const beat: Beat | undefined = voice?.beats[cursor.beat];

  const commit = useCallback(
    (ops: Op[], label: string) => {
      if (ops.length === 0) return;
      const prev = stateRef.current;
      const batch: OpBatch = { id: nextId("k"), ops, label };
      // The inverse is computed here and kept, because the old values it has to
      // restore exist only in the document about to be replaced.
      const inverse = invertBatch(prev.score, batch).map(op);
      // Sent even when it changes nothing locally: in a live session the server
      // matches the acknowledgement by batch id, so a batch this client
      // recorded as pending has to be one the server will echo. It no-ops on
      // the far side just as it did here.
      commitListenerRef.current?.(batch);
      const folded = fold(prev, batch);
      if (folded === prev) return;
      logRef.current.push(batch);
      // A gesture with no inverse changed nothing worth going back to, so it
      // leaves the stacks alone rather than adding a step that does nothing.
      publish(
        inverse.length === 0
          ? folded
          : {
              ...folded,
              past: [...prev.past, { ops, inverse, label }].slice(-HISTORY_LIMIT),
              future: [],
            },
      );
    },
    [publish],
  );

  /**
   * Takes back this client's last edit, wherever it now sits in the log.
   *
   * The inverse goes out as an ordinary batch, so in a live session everyone
   * applies it in the server's order and the room stays converged. It undoes
   * only the edit it was built from: a collaborator's work that arrived in
   * between survives, which is the whole reason this is inverse ops rather than
   * the document snapshots it replaced.
   *
   * If a collaborator has since deleted what the inverse addresses, its ops find
   * no target and it changes nothing — the step is still consumed, because there
   * is nothing left to take back.
   */
  const undo = useCallback(() => {
    const prev = stateRef.current;
    const entry = prev.past[prev.past.length - 1];
    if (!entry) return;
    const batch: OpBatch = { id: nextId("k"), ops: entry.inverse, label: `Undo ${entry.label}` };
    commitListenerRef.current?.(batch);
    logRef.current.push(batch);
    publish({
      ...fold(prev, batch),
      past: prev.past.slice(0, -1),
      future: [entry, ...prev.future],
    });
  }, [publish]);

  const redo = useCallback(() => {
    const prev = stateRef.current;
    const entry = prev.future[0];
    if (!entry) return;
    // The original ops again under a fresh batch id. The ids *inside* them are
    // reused deliberately: a redone note keeps its identity, so an op that
    // addressed it before the undo still addresses it after the redo.
    const batch: OpBatch = { id: nextId("k"), ops: entry.ops, label: `Redo ${entry.label}` };
    commitListenerRef.current?.(batch);
    logRef.current.push(batch);
    publish({
      ...fold(prev, batch),
      past: [...prev.past, entry],
      future: prev.future.slice(1),
    });
  }, [publish]);

  /**
   * Applies a batch the server has ordered, from anyone including this client.
   *
   * History survives, which snapshot undo could not allow: a snapshot taken
   * before someone else's edit describes no document the group shares, so
   * restoring it erased their work — and once a session ended, one Ctrl+Z
   * reinstated a pre-collab document and autosaved it over everything the
   * session had produced. An inverse op names the entities it restores instead,
   * so it stays valid across a collaborator's edit and inert once they have
   * deleted what it points at.
   */
  const applyRemote = useCallback(
    (batch: OpBatch) => {
      const prev = stateRef.current;
      if (!prev.live) {
        const nextScore = applyBatch(prev.score, batch);
        if (nextScore === prev.score) return;
        publish({ ...prev, score: nextScore });
        return;
      }
      // Advance server truth, retire our copy of this batch if it was ours,
      // and rebuild the view. Everything still pending replays on top.
      const live = serverBatch(prev.live, batch);
      if (live === prev.live) return;
      publish({ ...prev, score: sessionView(live), live });
    },
    [publish],
  );

  /**
   * Hands ordering to the server, or takes it back when the session ends.
   * Called from the socket's open and close handlers rather than an effect, so
   * a message that arrives in the same tick as the connection cannot be
   * applied under the wrong ordering rule.
   */
  const setLiveOrdering = useCallback(
    (on: boolean) => {
      const prev = stateRef.current;
      if (on === (prev.live !== null)) return;
      // Whatever is on screen when a session starts is the base everyone
      // builds on; when it ends, the projection is simply the document.
      publish({ ...prev, live: on ? beginSession(prev.score) : null });
    },
    [publish],
  );

  const setCommitListener = useCallback((listener: ((batch: OpBatch) => void) | null) => {
    commitListenerRef.current = listener;
  }, []);

  /** Enters a fret on the cursor's string, combining consecutive digits into 10-24. */
  const typeDigit = useCallback(
    (digit: number) => {
      if (!beat || !track) return;
      // Fret entry needs strings. On a staff that has none — an imported piano
      // or vocal part, which the importer carries pitch-exact — pitchAt has no
      // tuning to work from and answers middle C for every digit, and the note
      // carries a string number the existing notes do not, so nothing is
      // replaced. Every keystroke therefore appended a stray middle C to the
      // user's imported part, and autosave wrote it down. Such a staff is
      // read-only in this editor until it grows note entry of its own: Delete
      // already cannot find notes there either, because it matches on string.
      if (track.instrument.kind !== "fretted") return;
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

  /**
   * Replaces the document. In a live session this also resets server truth:
   * the snapshot a joiner is handed *is* the confirmed state, and anything
   * pending against the old document has no meaning against the new one.
   */
  const replaceDocument = useCallback(
    (next: Score) => {
      digitRef.current = null;
      logRef.current = [];
      const prev = stateRef.current;
      // History goes with the old document. An inverse op addresses entities by
      // id, so against a different score it would either find nothing or, worse,
      // find the one thing whose id happened to carry over.
      publish({
        score: next,
        past: [],
        future: [],
        live: prev.live ? beginSession(next) : null,
      });
      setCursor({ track: 0, bar: 0, beat: 0, string: 1 });
    },
    [publish],
  );

  const newScore = useCallback(
    (title = "New Score") => replaceDocument(createScore(title)),
    [replaceDocument],
  );

  const loadScore = replaceDocument;

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
    /** False on a staff with no strings, where fret entry does not apply. */
    canEnterFrets: track?.instrument.kind === "fretted",
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
    setLiveOrdering,
    setCommitListener,
    newScore,
    loadScore,
  };
}

export type EditorController = ReturnType<typeof useEditor>;
