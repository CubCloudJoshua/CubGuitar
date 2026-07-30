/**
 * Op application.
 *
 * Pure: every function returns a new Score, sharing structure with the old
 * one along untouched branches. Applying the same op log to the same starting
 * document always yields the same result, which is what makes the log usable
 * for undo, version history, and sync.
 *
 * Load-bearing invariant: an op that changes nothing returns the *same
 * reference*. Callers use identity to decide whether to bump the revision,
 * record an undo step, log the batch, or re-render, so an op that rebuilt an
 * unchanged branch would inflate revisions (diverging between collaborators
 * who receive a duplicate broadcast), add empty undo steps, and cause
 * pointless re-renders. Every case below therefore compares before rebuilding.
 * See convergence.test.ts.
 */
import type { Bar, Beat, Instrument, Note, Score, Track, Voice } from "./score.js";
import type { Op, OpBatch } from "./ops.js";

type Mapper<T> = (value: T) => T;

/** Returns the original array when no element changed, so identity checks work upward. */
function mapArray<T>(items: readonly T[], fn: Mapper<T>): T[] | null {
  let changed = false;
  const out = items.map((item) => {
    const next = fn(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : null;
}

function mapTracks(score: Score, fn: Mapper<Track>): Score {
  const tracks = mapArray(score.tracks, fn);
  return tracks ? { ...score, tracks } : score;
}

function mapBars(score: Score, fn: Mapper<Bar>): Score {
  return mapTracks(score, (track) => {
    const bars = mapArray(track.bars, fn);
    return bars ? { ...track, bars } : track;
  });
}

function mapVoices(score: Score, fn: Mapper<Voice>): Score {
  return mapBars(score, (bar) => {
    const voices = mapArray(bar.voices, fn);
    return voices ? { ...bar, voices } : bar;
  });
}

function mapBeats(score: Score, fn: Mapper<Beat>): Score {
  return mapVoices(score, (voice) => {
    const beats = mapArray(voice.beats, fn);
    return beats ? { ...voice, beats } : voice;
  });
}

function mapNotes(score: Score, fn: Mapper<Note>): Score {
  return mapBeats(score, (beat) => {
    const notes = mapArray(beat.notes, fn);
    return notes ? { ...beat, notes } : beat;
  });
}

/**
 * Whether two note lists are the same music in the same order.
 *
 * `note.insert` is the one op that cannot answer this by rebuilding and
 * comparing references, because the note it carries arrives as fresh JSON over
 * the socket — a redelivered insert would produce an identical beat that is not
 * the same object, breaking the identity invariant this file rests on.
 */
function sameNote(a: Note, b: Note): boolean {
  return (
    a.id === b.id &&
    a.pitch === b.pitch &&
    a.string === b.string &&
    a.fret === b.fret &&
    a.tiedToNext === b.tiedToNext &&
    a.articulations.length === b.articulations.length &&
    a.articulations.every((art, i) => art === b.articulations[i])
  );
}

function sameNotes(a: readonly Note[], b: readonly Note[]): boolean {
  return a.length === b.length && a.every((note, i) => note === b[i] || sameNote(note, b[i]!));
}

/**
 * Whether two instruments are the same, so setting one that is already there
 * returns the same reference like every other op.
 *
 * Structural rather than by reference, because an instrument arriving over the
 * socket is fresh JSON — the same reason `sameNote` exists.
 */
function sameInstrument(a: Instrument, b: Instrument): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "fretted" && b.kind === "fretted") {
    return (
      a.frets === b.frets &&
      a.capo === b.capo &&
      a.tuning.length === b.tuning.length &&
      a.tuning.every((pitch, i) => pitch === b.tuning[i])
    );
  }
  if (a.kind === "pitched" && b.kind === "pitched") return a.midiProgram === b.midiProgram;
  return true;
}

function withBeat(score: Score, beatId: string, fn: Mapper<Beat>): Score {
  return mapBeats(score, (beat) => (beat.id === beatId ? fn(beat) : beat));
}

function withNote(score: Score, noteId: string, fn: Mapper<Note>): Score {
  return mapNotes(score, (note) => (note.id === noteId ? fn(note) : note));
}

/** Applies one operation. Ops that reference a missing id are no-ops. */
export function applyOp(score: Score, op: Op): Score {
  switch (op.type) {
    case "score.setTitle":
      return score.title === op.title ? score : { ...score, title: op.title };

    case "score.setArtist":
      return score.artist === op.artist ? score : { ...score, artist: op.artist };

    case "track.insert": {
      // Already present: this is a redelivery, not a second track. Inserts are
      // the ops that are not naturally idempotent — note.insert replaces by
      // string, but a splice happily adds a second element with the same id,
      // and two elements sharing an id make every later op ambiguous.
      if (score.tracks.some((t) => t.id === op.track.id)) return score;
      const tracks = [...score.tracks];
      tracks.splice(Math.max(0, Math.min(op.index, tracks.length)), 0, op.track);
      return { ...score, tracks };
    }

    case "track.remove": {
      const tracks = score.tracks.filter((t) => t.id !== op.trackId);
      return tracks.length === score.tracks.length ? score : { ...score, tracks };
    }

    case "track.rename":
      return mapTracks(score, (t) =>
        t.id === op.trackId && t.name !== op.name ? { ...t, name: op.name } : t,
      );

    case "track.setInstrument":
      return mapTracks(score, (t) =>
        t.id === op.trackId && !sameInstrument(t.instrument, op.instrument)
          ? { ...t, instrument: op.instrument }
          : t,
      );

    case "bar.insert":
      return mapTracks(score, (t) => {
        if (t.id !== op.trackId) return t;
        if (t.bars.some((b) => b.id === op.bar.id)) return t;
        const bars = [...t.bars];
        bars.splice(Math.max(0, Math.min(op.index, bars.length)), 0, op.bar);
        return { ...t, bars };
      });

    case "bar.remove":
      return mapTracks(score, (t) => {
        if (t.id !== op.trackId) return t;
        const bars = t.bars.filter((b) => b.id !== op.barId);
        return bars.length === t.bars.length ? t : { ...t, bars };
      });

    case "bar.setTempo":
      return mapBars(score, (b) => {
        if (b.id !== op.barId) return b;
        if (op.tempoBpm === null) {
          if (b.tempoBpm === undefined) return b;
          const { tempoBpm, ...rest } = b;
          return rest;
        }
        return b.tempoBpm === op.tempoBpm ? b : { ...b, tempoBpm: op.tempoBpm };
      });

    case "bar.setTimeSignature":
      return mapBars(score, (b) => {
        if (b.id !== op.barId) return b;
        // null clears it, so the bar inherits the previous signature again.
        if (op.timeSignature === null) {
          if (b.timeSignature === undefined) return b;
          const { timeSignature, ...rest } = b;
          return rest;
        }
        const same =
          b.timeSignature?.beats === op.timeSignature.beats &&
          b.timeSignature?.beatValue === op.timeSignature.beatValue;
        return same ? b : { ...b, timeSignature: op.timeSignature };
      });

    case "beat.insert":
      return mapVoices(score, (v) => {
        if (v.id !== op.voiceId) return v;
        if (v.beats.some((b) => b.id === op.beat.id)) return v;
        const beats = [...v.beats];
        beats.splice(Math.max(0, Math.min(op.index, beats.length)), 0, op.beat);
        return { ...v, beats };
      });

    case "beat.remove":
      return mapVoices(score, (v) => {
        if (v.id !== op.voiceId) return v;
        const beats = v.beats.filter((b) => b.id !== op.beatId);
        return beats.length === v.beats.length ? v : { ...v, beats };
      });

    case "beat.setDuration":
      return withBeat(score, op.beatId, (b) =>
        b.duration.numerator === op.duration.numerator &&
        b.duration.denominator === op.duration.denominator
          ? b
          : { ...b, duration: op.duration },
      );

    case "beat.setDots":
      return withBeat(score, op.beatId, (b) => (b.dots === op.dots ? b : { ...b, dots: op.dots }));

    case "note.insert":
      return withBeat(score, op.beatId, (b) => {
        // One note per string: entering a fret replaces what was there.
        //
        // Only when the note *has* a string. A note without one is a pitch on a
        // staff that has no strings — a piano or vocal part — and two of those are
        // a chord, not a collision. Filtering on `undefined !== undefined` made
        // every insert into such a beat replace the last one, so a pitched staff
        // could hold exactly one note however many were inserted. Nothing hit it
        // yet because the importer builds those beats directly rather than through
        // ops; MIDI and MusicXML import will go through ops, and would have lost
        // every chord in a piano part.
        const kept =
          op.note.string === undefined ? b.notes : b.notes.filter((n) => n.string !== op.note.string);
        // Note entry appends; undo supplies an index to put a displaced note
        // back where it was, so a chord keeps the order it had.
        const at = op.index === undefined ? kept.length : Math.max(0, Math.min(op.index, kept.length));
        const notes = [...kept.slice(0, at), op.note, ...kept.slice(at)];
        return sameNotes(b.notes, notes) ? b : { ...b, notes };
      });

    case "note.remove":
      return mapBeats(score, (b) => {
        const notes = b.notes.filter((n) => n.id !== op.noteId);
        return notes.length === b.notes.length ? b : { ...b, notes };
      });

    case "note.setPitch":
      return withNote(score, op.noteId, (n) => (n.pitch === op.pitch ? n : { ...n, pitch: op.pitch }));

    case "note.setFingering":
      return withNote(score, op.noteId, (n) => {
        // null clears it: the note becomes a pitch with no place on a fretboard.
        if (op.string === null || op.fret === null) {
          if (n.string === undefined && n.fret === undefined) return n;
          const { string, fret, ...rest } = n;
          return rest;
        }
        return n.string === op.string && n.fret === op.fret
          ? n
          : { ...n, string: op.string, fret: op.fret };
      });

    case "note.addArticulation":
      return withNote(score, op.noteId, (n) =>
        n.articulations.includes(op.articulation)
          ? n
          : { ...n, articulations: [...n.articulations, op.articulation] },
      );

    case "note.removeArticulation":
      return withNote(score, op.noteId, (n) =>
        n.articulations.includes(op.articulation)
          ? { ...n, articulations: n.articulations.filter((a) => a !== op.articulation) }
          : n,
      );

    default: {
      // Ops arrive over the network from other clients, so an op type this
      // build does not know (a newer collaborator, or a malformed message)
      // must be ignored rather than falling through to undefined — which
      // applyBatch would spread into a document containing nothing but a
      // revision number. The never assignment keeps the switch exhaustive at
      // compile time so a genuinely new op type still fails the build.
      const unknown: never = op;
      void unknown;
      return score;
    }
  }
}

/**
 * Applies a batch as one unit and advances the revision once.
 *
 * Batches arrive over a WebSocket from anyone holding a session link, so this
 * takes an `OpBatch` by type and untrusted JSON in practice. It must not throw:
 * a batch with no `ops` array used to throw out of the React state updater that
 * called it, which — with no error boundary above it — blanked the tab of every
 * member of the session. The server stores what it broadcasts, so the same
 * batch then crashed everyone who joined afterwards and the room stayed dead
 * until the process restarted. A malformed batch is now a batch that does
 * nothing.
 */
export function applyBatch(score: Score, batch: OpBatch): Score {
  const ops: readonly Op[] = Array.isArray(batch?.ops) ? batch.ops : [];
  let next = score;
  for (const op of ops) {
    // Belt and braces alongside applyOp's default case: a malformed op can
    // never replace a document with a partial object.
    if (!op || typeof op !== "object") continue;
    const applied = applyOp(next, op);
    next = applied ?? next;
  }
  return next === score ? score : { ...next, revision: score.revision + 1 };
}
