/**
 * Op application.
 *
 * Pure: every function returns a new Score, sharing structure with the old
 * one along untouched branches. Applying the same op log to the same starting
 * document always yields the same result, which is what makes the log usable
 * for undo, version history, and sync.
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
      return { ...score, title: op.title };

    case "score.setArtist":
      return { ...score, artist: op.artist };

    case "track.insert": {
      const tracks = [...score.tracks];
      tracks.splice(Math.max(0, Math.min(op.index, tracks.length)), 0, op.track);
      return { ...score, tracks };
    }

    case "track.remove":
      return { ...score, tracks: score.tracks.filter((t) => t.id !== op.trackId) };

    case "track.rename":
      return mapTracks(score, (t) => (t.id === op.trackId ? { ...t, name: op.name } : t));

    case "bar.insert":
      return mapTracks(score, (t) => {
        if (t.id !== op.trackId) return t;
        const bars = [...t.bars];
        bars.splice(Math.max(0, Math.min(op.index, bars.length)), 0, op.bar);
        return { ...t, bars };
      });

    case "bar.remove":
      return mapTracks(score, (t) =>
        t.id === op.trackId ? { ...t, bars: t.bars.filter((b) => b.id !== op.barId) } : t,
      );

    case "beat.insert":
      return mapVoices(score, (v) => {
        if (v.id !== op.voiceId) return v;
        const beats = [...v.beats];
        beats.splice(Math.max(0, Math.min(op.index, beats.length)), 0, op.beat);
        return { ...v, beats };
      });

    case "beat.remove":
      return mapVoices(score, (v) =>
        v.id === op.voiceId ? { ...v, beats: v.beats.filter((b) => b.id !== op.beatId) } : v,
      );

    case "beat.setDuration":
      return withBeat(score, op.beatId, (b) => ({ ...b, duration: op.duration }));

    case "beat.setDots":
      return withBeat(score, op.beatId, (b) => ({ ...b, dots: op.dots }));

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
      return withNote(score, op.noteId, (n) => ({ ...n, pitch: op.pitch }));

    case "note.setFingering":
      return withNote(score, op.noteId, (n) => ({ ...n, string: op.string, fret: op.fret }));

    case "note.addArticulation":
      return withNote(score, op.noteId, (n) =>
        n.articulations.includes(op.articulation)
          ? n
          : { ...n, articulations: [...n.articulations, op.articulation] },
      );

    case "note.removeArticulation":
      return withNote(score, op.noteId, (n) => ({
        ...n,
        articulations: n.articulations.filter((a) => a !== op.articulation),
      }));
  }
}

/** Applies a batch as one unit and advances the revision once. */
export function applyBatch(score: Score, batch: OpBatch): Score {
  let next = score;
  for (const op of batch.ops) next = applyOp(next, op);
  return next === score ? score : { ...next, revision: score.revision + 1 };
}
