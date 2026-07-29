/**
 * The convergence contract behind realtime collaboration.
 *
 * services/sync assigns a total order to op batches and broadcasts them, and
 * the client applies remote batches with applyBatch. That design is only sound
 * if the properties below hold, so they are pinned here rather than trusted:
 *
 *  1. Ops touching disjoint entities commute (concurrent edits in different
 *     places converge no matter which arrives first).
 *  2. Ops addressing a missing id are no-ops (an edit racing a delete loses
 *     cleanly instead of resurrecting or corrupting content).
 *  3. Re-applying an already-applied batch changes nothing (a replayed or
 *     duplicated broadcast is harmless).
 *  4. Where ops genuinely conflict (same note position), the outcome is
 *     decided purely by order — which is exactly what the server supplies,
 *     and why client-side ordering must never be trusted.
 */
import { describe, expect, it } from "vitest";
import { applyBatch } from "./apply.js";
import { createNote, createScore, duration, nextId } from "./build.js";
import { toAlphaTex } from "./alphatex.js";
import type { Op, OpBatch, OpKind, Score } from "./index.js";

function op(kind: OpKind): Op {
  return { id: nextId("o"), author: "test", at: 0, ...kind };
}

function batch(label: string, ...kinds: OpKind[]): OpBatch {
  return { id: nextId("k"), ops: kinds.map(op), label };
}

/** Applies batches in the given order to a fresh copy of the document. */
function applyAll(score: Score, batches: OpBatch[]): Score {
  return batches.reduce((doc, b) => applyBatch(doc, b), score);
}

/**
 * Documents are compared by their serialization, not by identity: ids differ
 * harmlessly between runs, but the music must match exactly.
 */
function musicOf(score: Score): string {
  return toAlphaTex(score);
}

function firstTrack(score: Score) {
  const track = score.tracks[0];
  if (!track) throw new Error("no track");
  return track;
}

function beatAt(score: Score, bar: number, index: number) {
  const beat = firstTrack(score).bars[bar]?.voices[0]?.beats[index];
  if (!beat) throw new Error(`no beat at ${bar}:${index}`);
  return beat;
}

describe("disjoint ops commute", () => {
  it("two notes in different bars converge in either order", () => {
    const base = createScore("Convergence");
    const track = firstTrack(base);
    const alice = batch("alice", {
      type: "note.insert",
      beatId: beatAt(base, 0, 0).id,
      note: createNote(64, 1, 0),
    });
    const bob = batch("bob", {
      type: "note.insert",
      beatId: beatAt(base, 1, 2).id,
      note: createNote(59, 2, 3),
    });

    expect(musicOf(applyAll(base, [alice, bob]))).toBe(musicOf(applyAll(base, [bob, alice])));
    // And both edits actually landed, so this is not vacuously equal.
    const merged = applyAll(base, [alice, bob]);
    expect(beatAt(merged, 0, 0).notes).toHaveLength(1);
    expect(beatAt(merged, 1, 2).notes).toHaveLength(1);
    expect(track.bars[0]?.voices[0]?.beats[0]?.notes).toHaveLength(0);
  });

  it("notes on different strings of the same beat converge into one chord", () => {
    const base = createScore("Chord race");
    const target = beatAt(base, 0, 0).id;
    const alice = batch("alice", { type: "note.insert", beatId: target, note: createNote(64, 1, 0) });
    const bob = batch("bob", { type: "note.insert", beatId: target, note: createNote(50, 4, 0) });

    const ab = applyAll(base, [alice, bob]);
    const ba = applyAll(base, [bob, alice]);
    // Both notes survive either way; only their written order inside the
    // chord differs, which is why the comparison is on the pitch set.
    const pitches = (s: Score) =>
      beatAt(s, 0, 0)
        .notes.map((n) => n.pitch)
        .sort((x, y) => x - y);
    expect(pitches(ab)).toEqual([50, 64]);
    expect(pitches(ba)).toEqual([50, 64]);
  });

  it("a duration change and a note entry on different beats commute", () => {
    const base = createScore("Mixed");
    const a = batch("dur", { type: "beat.setDuration", beatId: beatAt(base, 0, 1).id, duration: duration(8) });
    const b = batch("note", {
      type: "note.insert",
      beatId: beatAt(base, 0, 3).id,
      note: createNote(55, 3, 0),
    });
    expect(musicOf(applyAll(base, [a, b]))).toBe(musicOf(applyAll(base, [b, a])));
  });

  it("edits to different tracks commute", () => {
    const base = createScore("Two tracks");
    const bassTrack = {
      id: nextId("t"),
      name: "Bass",
      instrument: { kind: "fretted" as const, tuning: [43, 38, 33, 28], frets: 24, capo: 0 },
      bars: firstTrack(base).bars.map((bar) => ({
        id: nextId("m"),
        voices: [{ id: nextId("v"), beats: bar.voices[0]!.beats.map((b) => ({ ...b, id: nextId("b") })) }],
        ...(bar.timeSignature ? { timeSignature: bar.timeSignature } : {}),
      })),
    };
    const withBass = applyBatch(base, batch("add bass", { type: "track.insert", index: 1, track: bassTrack }));

    const guitarEdit = batch("guitar", {
      type: "note.insert",
      beatId: beatAt(withBass, 0, 0).id,
      note: createNote(64, 1, 0),
    });
    const bassBeat = withBass.tracks[1]?.bars[0]?.voices[0]?.beats[0];
    const bassEdit = batch("bass", {
      type: "note.insert",
      beatId: bassBeat!.id,
      note: createNote(43, 1, 0),
    });

    expect(musicOf(applyAll(withBass, [guitarEdit, bassEdit]))).toBe(
      musicOf(applyAll(withBass, [bassEdit, guitarEdit])),
    );
  });
});

describe("edits racing deletes lose cleanly", () => {
  it("a note edit arriving after its beat was removed is a no-op", () => {
    const base = createScore("Race");
    const voice = firstTrack(base).bars[0]?.voices[0];
    const doomed = beatAt(base, 0, 2);

    const remove = batch("remove beat", { type: "beat.remove", voiceId: voice!.id, beatId: doomed.id });
    const edit = batch("edit doomed beat", {
      type: "note.insert",
      beatId: doomed.id,
      note: createNote(64, 1, 0),
    });

    const removeFirst = applyAll(base, [remove, edit]);
    const editFirst = applyAll(base, [edit, remove]);

    // Either order ends with the beat gone and no orphaned note anywhere.
    expect(firstTrack(removeFirst).bars[0]?.voices[0]?.beats).toHaveLength(3);
    expect(firstTrack(editFirst).bars[0]?.voices[0]?.beats).toHaveLength(3);
    expect(musicOf(removeFirst)).toBe(musicOf(editFirst));
  });

  it("an articulation on a removed note is a no-op", () => {
    const base = createScore("Race 2");
    const note = createNote(64, 1, 5);
    const withNote = applyBatch(
      base,
      batch("add", { type: "note.insert", beatId: beatAt(base, 0, 0).id, note }),
    );

    const remove = batch("remove note", { type: "note.remove", noteId: note.id });
    const decorate = batch("decorate", {
      type: "note.addArticulation",
      noteId: note.id,
      articulation: "palmMute",
    });

    expect(musicOf(applyAll(withNote, [remove, decorate]))).toBe(
      musicOf(applyAll(withNote, [decorate, remove])),
    );
    expect(beatAt(applyAll(withNote, [decorate, remove]), 0, 0).notes).toHaveLength(0);
  });

  it("edits to a removed track are no-ops", () => {
    const base = createScore("Race 3");
    const track = firstTrack(base);
    const remove = batch("remove track", { type: "track.remove", trackId: track.id });
    const rename = batch("rename", { type: "track.rename", trackId: track.id, name: "Renamed" });

    const removeFirst = applyAll(base, [remove, rename]);
    const renameFirst = applyAll(base, [rename, remove]);
    expect(removeFirst.tracks).toHaveLength(0);
    expect(renameFirst.tracks).toHaveLength(0);
  });
});

describe("duplicate delivery is harmless", () => {
  it("re-applying a note insert leaves one note", () => {
    const base = createScore("Dup");
    const note = createNote(64, 1, 7);
    const b = batch("insert", { type: "note.insert", beatId: beatAt(base, 0, 0).id, note });

    const once = applyBatch(base, b);
    const twice = applyBatch(once, b);
    expect(beatAt(twice, 0, 0).notes).toHaveLength(1);
    expect(musicOf(twice)).toBe(musicOf(once));
  });

  it("re-applying a removal is a no-op that does not remove a neighbour", () => {
    const base = createScore("Dup 2");
    const voice = firstTrack(base).bars[0]?.voices[0];
    const target = beatAt(base, 0, 1);
    const b = batch("remove", { type: "beat.remove", voiceId: voice!.id, beatId: target.id });

    const once = applyBatch(base, b);
    const twice = applyBatch(once, b);
    expect(firstTrack(twice).bars[0]?.voices[0]?.beats).toHaveLength(3);
    expect(twice).toBe(once);
  });

  it("re-applying setters is idempotent", () => {
    const base = createScore("Dup 3");
    const beatId = beatAt(base, 0, 0).id;
    const b = batch(
      "set",
      { type: "beat.setDuration", beatId, duration: duration(16) },
      { type: "beat.setDots", beatId, dots: 1 },
    );
    const once = applyBatch(base, b);
    expect(musicOf(applyBatch(once, b))).toBe(musicOf(once));
  });
});

describe("ops that change nothing preserve document identity", () => {
  // Callers key off identity to decide whether to bump the revision, push an
  // undo step, or re-render, so this is a contract and not an optimisation.
  const base = createScore("Identity");
  const track = firstTrack(base);
  const beat = beatAt(base, 0, 0);
  const note = createNote(64, 1, 5);
  const withNote = applyBatch(base, batch("seed", { type: "note.insert", beatId: beat.id, note }));

  const cases: Array<[string, Score, OpKind]> = [
    ["title set to the same value", base, { type: "score.setTitle", title: "Identity" }],
    ["artist set to the same value", base, { type: "score.setArtist", artist: "" }],
    ["track renamed to the same name", base, { type: "track.rename", trackId: track.id, name: track.name }],
    ["removing an absent track", base, { type: "track.remove", trackId: "ghost" }],
    ["removing an absent bar", base, { type: "bar.remove", trackId: track.id, barId: "ghost" }],
    [
      "removing an absent beat",
      base,
      { type: "beat.remove", voiceId: track.bars[0]!.voices[0]!.id, beatId: "ghost" },
    ],
    ["duration set to the current value", base, { type: "beat.setDuration", beatId: beat.id, duration: duration(4) }],
    ["dots set to the current value", base, { type: "beat.setDots", beatId: beat.id, dots: 0 }],
    [
      "time signature set to the current value",
      base,
      { type: "bar.setTimeSignature", barId: track.bars[0]!.id, timeSignature: { beats: 4, beatValue: 4 } },
    ],
    ["clearing an absent tempo", base, { type: "bar.setTempo", barId: track.bars[1]!.id, tempoBpm: null }],
    ["pitch set to the current value", withNote, { type: "note.setPitch", noteId: note.id, pitch: 64 }],
    [
      "fingering set to the current value",
      withNote,
      { type: "note.setFingering", noteId: note.id, string: 1, fret: 5 },
    ],
    [
      "removing an absent articulation",
      withNote,
      { type: "note.removeArticulation", noteId: note.id, articulation: "palmMute" },
    ],
    ["removing an absent note", withNote, { type: "note.remove", noteId: "ghost" }],
  ];

  for (const [label, doc, kind] of cases) {
    it(label, () => {
      const after = applyBatch(doc, batch(label, kind));
      expect(after).toBe(doc);
      expect(after.revision).toBe(doc.revision);
    });
  }
});

describe("genuine conflicts are decided by order alone", () => {
  it("two notes on the same string and beat resolve last-writer-wins", () => {
    const base = createScore("Conflict");
    const target = beatAt(base, 0, 0).id;
    const alice = batch("alice", { type: "note.insert", beatId: target, note: createNote(67, 1, 3) });
    const bob = batch("bob", { type: "note.insert", beatId: target, note: createNote(69, 1, 5) });

    // This is the one case where order changes the outcome, which is precisely
    // why the sync service imposes a total order instead of letting clients
    // apply their own. Both results are single notes: never a duplicate.
    const aliceThenBob = applyAll(base, [alice, bob]);
    const bobThenAlice = applyAll(base, [bob, alice]);
    expect(beatAt(aliceThenBob, 0, 0).notes.map((n) => n.fret)).toEqual([5]);
    expect(beatAt(bobThenAlice, 0, 0).notes.map((n) => n.fret)).toEqual([3]);
  });

  it("a long op log replays to the same document regardless of batching", () => {
    const base = createScore("Replay");
    const kinds: OpKind[] = [];
    for (let bar = 0; bar < 4; bar++) {
      for (let i = 0; i < 4; i++) {
        kinds.push({
          type: "note.insert",
          beatId: beatAt(base, bar, i).id,
          note: createNote(64 - i, ((i % 6) + 1) as number, i + bar),
        });
      }
    }
    // Same ops, delivered as one batch versus sixteen: identical music.
    const single = applyBatch(base, batch("all", ...kinds));
    const many = applyAll(
      base,
      kinds.map((k, i) => batch(`op${i}`, k)),
    );
    expect(musicOf(many)).toBe(musicOf(single));
  });
});
