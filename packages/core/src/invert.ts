/**
 * The inverse of an edit.
 *
 * Undo used to be snapshots: keep the whole document from before each gesture,
 * and restore one to go back. That works for one person and cannot be made to
 * work for two. A snapshot describes a document nobody shares any more the
 * instant a collaborator types, so restoring one erases their work — which is
 * why undo was simply switched off during a live session, and why one Ctrl+Z
 * after a session ended could reinstate a pre-collab document and autosave it
 * over everything the session had produced.
 *
 * An inverse is the other way round: instead of "put the document back", it
 * says "remove that note, restore that fret". Those are ops like any other, so
 * they go through the same path as a keystroke — into the log, to the server,
 * ordered with everyone else's edits, applied by every client. Undo in a
 * session then means what a user means by it: take back *my* last change and
 * leave everyone else's alone. It cannot reach further than the change it
 * inverts, so the failure mode above is not merely fixed but unavailable.
 *
 * The inverse must be computed against the document as it was *before* the op,
 * because that is the only place the old value exists. Callers therefore invert
 * at commit time and keep the result; see useEditor's history stack.
 *
 * Ops that reference an id nobody has any more are no-ops (apply.ts), so an
 * inverse stays safe when a collaborator has deleted what it addresses.
 *
 * What undo means here, stated precisely: it restores what the edit overwrote
 * *as its author saw it*. In a session the client computes the inverse against
 * its own view — confirmed state plus its unacknowledged batches — and the
 * server may still order someone else's batch ahead of that edit. So if two
 * people overwrite one note and then one of them undoes, the value that comes
 * back is the one that person had on screen, not necessarily the one their edit
 * displaced in the server's final order. Every collaborative undo makes an
 * approximation of this shape; this one is at least the approximation a user can
 * predict, because it matches what they were looking at when they typed.
 */
import { applyOp } from "./apply.js";
import type { Beat, Note, Score } from "./score.js";
import type { Op, OpBatch, OpKind } from "./ops.js";

function findTrack(score: Score, trackId: string) {
  const index = score.tracks.findIndex((t) => t.id === trackId);
  const track = score.tracks[index];
  return track ? { index, track } : null;
}

function findBar(score: Score, trackId: string, barId: string) {
  const found = findTrack(score, trackId);
  if (!found) return null;
  const index = found.track.bars.findIndex((b) => b.id === barId);
  const bar = found.track.bars[index];
  return bar ? { index, bar } : null;
}

function findBeat(score: Score, voiceId: string, beatId: string) {
  for (const track of score.tracks) {
    for (const bar of track.bars) {
      for (const voice of bar.voices) {
        if (voice.id !== voiceId) continue;
        const index = voice.beats.findIndex((b) => b.id === beatId);
        const beat = voice.beats[index];
        return beat ? { index, beat } : null;
      }
    }
  }
  return null;
}

function beatById(score: Score, beatId: string): Beat | null {
  for (const track of score.tracks) {
    for (const bar of track.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) if (beat.id === beatId) return beat;
      }
    }
  }
  return null;
}

/** A note plus where it lives, since `note.remove` only carries the note id. */
function findNote(score: Score, noteId: string) {
  for (const track of score.tracks) {
    for (const bar of track.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          const index = beat.notes.findIndex((n) => n.id === noteId);
          const note = beat.notes[index];
          if (note) return { beatId: beat.id, index, note };
        }
      }
    }
  }
  return null;
}

/**
 * Ops that undo one op, applied against the document it was applied to.
 *
 * Returns a list rather than a single op because one edit can need two to
 * reverse: entering a fret where a note already sat replaces it, so undoing
 * that means removing the new note *and* putting the old one back.
 *
 * Empty means nothing to undo. That covers an op which references a missing id
 * and an op that asked for the value already there — both leave the document
 * untouched, and inverting them anyway would have undo make a change that was
 * never made. The check is `applyOp` returning the same reference, the identity
 * invariant apply.ts maintains for exactly this kind of question.
 */
export function invertOp(score: Score, op: Op): OpKind[] {
  if (applyOp(score, op) === score) return [];

  switch (op.type) {
    case "score.setTitle":
      return [{ type: "score.setTitle", title: score.title }];

    case "score.setArtist":
      return [{ type: "score.setArtist", artist: score.artist }];

    case "track.insert":
      return [{ type: "track.remove", trackId: op.track.id }];

    case "track.remove": {
      const found = findTrack(score, op.trackId);
      return found ? [{ type: "track.insert", index: found.index, track: found.track }] : [];
    }

    case "track.rename": {
      const found = findTrack(score, op.trackId);
      return found ? [{ type: "track.rename", trackId: op.trackId, name: found.track.name }] : [];
    }

    case "track.setInstrument": {
      const found = findTrack(score, op.trackId);
      return found
        ? [{ type: "track.setInstrument", trackId: op.trackId, instrument: found.track.instrument }]
        : [];
    }

    case "bar.insert":
      return [{ type: "bar.remove", trackId: op.trackId, barId: op.bar.id }];

    case "bar.remove": {
      const found = findBar(score, op.trackId, op.barId);
      return found
        ? [{ type: "bar.insert", trackId: op.trackId, index: found.index, bar: found.bar }]
        : [];
    }

    case "bar.setTempo": {
      for (const track of score.tracks) {
        for (const bar of track.bars) {
          if (bar.id !== op.barId) continue;
          return [{ type: "bar.setTempo", barId: op.barId, tempoBpm: bar.tempoBpm ?? null }];
        }
      }
      return [];
    }

    case "bar.setTimeSignature": {
      for (const track of score.tracks) {
        for (const bar of track.bars) {
          if (bar.id !== op.barId) continue;
          // A bar with no signature of its own inherits the previous one, and
          // restoring that state means clearing the field rather than writing
          // 4/4 into a bar that never carried it — otherwise undoing a meter
          // change leaves a spurious signature engraved mid-score.
          return [
            { type: "bar.setTimeSignature", barId: op.barId, timeSignature: bar.timeSignature ?? null },
          ];
        }
      }
      return [];
    }

    case "beat.insert":
      return [{ type: "beat.remove", voiceId: op.voiceId, beatId: op.beat.id }];

    case "beat.remove": {
      const found = findBeat(score, op.voiceId, op.beatId);
      return found
        ? [{ type: "beat.insert", voiceId: op.voiceId, index: found.index, beat: found.beat }]
        : [];
    }

    case "beat.setDuration": {
      const beat = beatById(score, op.beatId);
      return beat ? [{ type: "beat.setDuration", beatId: op.beatId, duration: beat.duration }] : [];
    }

    case "beat.setDots": {
      const beat = beatById(score, op.beatId);
      return beat ? [{ type: "beat.setDots", beatId: op.beatId, dots: beat.dots }] : [];
    }

    case "note.insert": {
      const beat = beatById(score, op.beatId);
      const undo: OpKind[] = [{ type: "note.remove", noteId: op.note.id }];
      // One note per string: if this insert displaced one, put it back where it
      // was. The index is exact because removing the new note leaves the beat
      // holding precisely the notes the insert kept.
      const replaced = beat?.notes.findIndex((n) => n.string === op.note.string) ?? -1;
      const previous: Note | undefined = replaced >= 0 ? beat?.notes[replaced] : undefined;
      if (previous && previous.id !== op.note.id) {
        undo.push({ type: "note.insert", beatId: op.beatId, note: previous, index: replaced });
      }
      return undo;
    }

    case "note.remove": {
      const found = findNote(score, op.noteId);
      return found
        ? [{ type: "note.insert", beatId: found.beatId, note: found.note, index: found.index }]
        : [];
    }

    case "note.setPitch": {
      const found = findNote(score, op.noteId);
      return found ? [{ type: "note.setPitch", noteId: op.noteId, pitch: found.note.pitch }] : [];
    }

    case "note.setFingering": {
      const found = findNote(score, op.noteId);
      if (!found) return [];
      const { string, fret } = found.note;
      // A note that had no fingering goes back to having none. The op used to be
      // unable to say that, so this reported no inverse at all — and undoing an
      // arrangement then restored the pitches and the instrument while leaving
      // every note carrying a string and fret it never had.
      if (string === undefined || fret === undefined) {
        return [{ type: "note.setFingering", noteId: op.noteId, string: null, fret: null }];
      }
      return [{ type: "note.setFingering", noteId: op.noteId, string, fret }];
    }

    case "note.addArticulation":
      return [{ type: "note.removeArticulation", noteId: op.noteId, articulation: op.articulation }];

    case "note.removeArticulation":
      return [{ type: "note.addArticulation", noteId: op.noteId, articulation: op.articulation }];

    default: {
      // An op type this build does not know cannot be inverted. Reporting no
      // inverse is the safe answer: undo skips it rather than guessing.
      const unknown: never = op;
      void unknown;
      return [];
    }
  }
}

/**
 * Ops that undo a whole batch, in the order they must be applied.
 *
 * Later ops are undone first, and each is inverted against the document as it
 * stood when it ran — walking forward to build those states is the only way to
 * know what an op overwrote when an earlier op in the same batch set it.
 */
export function invertBatch(before: Score, batch: OpBatch): OpKind[] {
  const steps: OpKind[][] = [];
  let state = before;
  for (const op of batch.ops) {
    steps.push(invertOp(state, op));
    state = applyOp(state, op);
  }
  return steps.reverse().flat();
}
