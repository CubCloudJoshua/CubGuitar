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
 * push an undo snapshot, log the batch, or re-render, so an op that rebuilt an
 * unchanged branch would inflate revisions (diverging between collaborators
 * who receive a duplicate broadcast), add empty undo steps, and cause
 * pointless re-renders. Every case below therefore compares before rebuilding.
 * See convergence.test.ts.
 */
import type { Bar, Beat, Note, Score, Track, Voice } from "./score.js";
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

    case "bar.insert":
      return mapTracks(score, (t) => {
        if (t.id !== op.trackId) return t;
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
        const same =
          b.timeSignature?.beats === op.timeSignature.beats &&
          b.timeSignature?.beatValue === op.timeSignature.beatValue;
        return same ? b : { ...b, timeSignature: op.timeSignature };
      });

    case "beat.insert":
      return mapVoices(score, (v) => {
        if (v.id !== op.voiceId) return v;
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
        const notes = b.notes.filter((n) => n.string !== op.note.string);
        return { ...b, notes: [...notes, op.note] };
      });

    case "note.remove":
      return mapBeats(score, (b) => {
        const notes = b.notes.filter((n) => n.id !== op.noteId);
        return notes.length === b.notes.length ? b : { ...b, notes };
      });

    case "note.setPitch":
      return withNote(score, op.noteId, (n) => (n.pitch === op.pitch ? n : { ...n, pitch: op.pitch }));

    case "note.setFingering":
      return withNote(score, op.noteId, (n) =>
        n.string === op.string && n.fret === op.fret ? n : { ...n, string: op.string, fret: op.fret },
      );

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

/** Applies a batch as one unit and advances the revision once. */
export function applyBatch(score: Score, batch: OpBatch): Score {
  let next = score;
  for (const op of batch.ops) {
    const applied = applyOp(next, op);
    // Belt and braces alongside applyOp's default case: a malformed batch can
    // never replace a document with a partial object.
    next = applied ?? next;
  }
  return next === score ? score : { ...next, revision: score.revision + 1 };
}
