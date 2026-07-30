/**
 * Inverse ops carry the whole of undo, so the bar is high: for every op kind,
 * apply then undo must give back the document that was there, field for field.
 *
 * That is deliberately a deep-equality check rather than a spot check on the
 * thing the op touched. An inverse that restores the fret but loses the
 * articulations, or puts a chord's notes back in a different order, passes any
 * assertion narrow enough to be written by hand and still silently damages the
 * user's score one Ctrl+Z at a time.
 */
import { describe, expect, it } from "vitest";
import { applyBatch, applyOp } from "./apply.js";
import { invertBatch, invertOp } from "./invert.js";
import { createBar, createNote, createRest, createScore, createTrack, duration, frettedGuitar } from "./build.js";
import type { Op, OpBatch, OpKind } from "./ops.js";
import type { Score } from "./score.js";

let counter = 0;
function op(kind: OpKind): Op {
  counter += 1;
  return { id: `inv-op-${counter}`, author: "test", at: 0, ...kind };
}

function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return { id: `inv-batch-${counter}`, ops: kinds.map(op) };
}

/** Revision is expected to advance; nothing else may differ. */
function expectSameDocument(actual: Score, expected: Score) {
  expect({ ...actual, revision: 0 }).toEqual({ ...expected, revision: 0 });
}

/** Applies a batch, undoes it through the op log, and returns both documents. */
function roundTrip(score: Score, b: OpBatch) {
  const edited = applyBatch(score, b);
  const undone = applyBatch(edited, batch(...invertBatch(score, b)));
  return { edited, undone };
}

function firstIds(score: Score) {
  const track = score.tracks[0]!;
  const bar = track.bars[0]!;
  const voice = bar.voices[0]!;
  return { track, bar, voice, beat: voice.beats[0]! };
}

/**
 * A document with something in it, so inverses have real values to restore: a
 * three-note chord on the first beat, one of those notes carrying an
 * articulation, and a tempo on the first bar.
 */
function populated(): Score {
  const base = createScore("Song", "Someone");
  const { beat, bar } = firstIds(base);
  // Notes are built out here rather than inline so their ids are in hand. An
  // earlier version read `beat.notes[0]` off the *empty* beat and articulated a
  // note id that did not exist, which left the fixture without the articulation
  // the tests below claim to restore.
  const top = createNote(64, 1, 0);
  return applyBatch(
    base,
    batch(
      { type: "note.insert", beatId: beat.id, note: top },
      { type: "note.insert", beatId: beat.id, note: createNote(59, 2, 3) },
      { type: "note.insert", beatId: beat.id, note: createNote(55, 3, 5) },
      { type: "note.addArticulation", noteId: top.id, articulation: "vibrato" },
      { type: "bar.setTempo", barId: bar.id, tempoBpm: 132 },
    ),
  );
}

describe("invertOp round trips", () => {
  it("undoes a title change", () => {
    const score = populated();
    const { edited, undone } = roundTrip(score, batch({ type: "score.setTitle", title: "Other" }));
    expect(edited.title).toBe("Other");
    expectSameDocument(undone, score);
  });

  it("undoes an artist change", () => {
    const score = populated();
    const { undone } = roundTrip(score, batch({ type: "score.setArtist", artist: "Nobody" }));
    expectSameDocument(undone, score);
  });

  it("undoes a track insert", () => {
    const score = populated();
    const added = createTrack("Bass", frettedGuitar(), 2);
    const { edited, undone } = roundTrip(score, batch({ type: "track.insert", index: 1, track: added }));
    expect(edited.tracks).toHaveLength(2);
    expectSameDocument(undone, score);
  });

  it("undoes a track removal, restoring its position and contents", () => {
    const score = applyBatch(
      populated(),
      batch({ type: "track.insert", index: 1, track: createTrack("Bass", frettedGuitar(), 2) }),
    );
    const middle = createTrack("Keys", frettedGuitar(), 3);
    const three = applyBatch(score, batch({ type: "track.insert", index: 1, track: middle }));
    const { edited, undone } = roundTrip(three, batch({ type: "track.remove", trackId: middle.id }));
    expect(edited.tracks.map((t) => t.name)).toEqual(["Guitar", "Bass"]);
    // Back in the middle, not appended to the end.
    expect(undone.tracks.map((t) => t.name)).toEqual(["Guitar", "Keys", "Bass"]);
    expectSameDocument(undone, three);
  });

  it("undoes a rename", () => {
    const score = populated();
    const { track } = firstIds(score);
    const { undone } = roundTrip(score, batch({ type: "track.rename", trackId: track.id, name: "Lead" }));
    expectSameDocument(undone, score);
  });

  it("undoes a bar insert", () => {
    const score = populated();
    const { track } = firstIds(score);
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "bar.insert", trackId: track.id, index: 1, bar: createBar() }),
    );
    expect(edited.tracks[0]?.bars).toHaveLength(5);
    expectSameDocument(undone, score);
  });

  it("undoes a bar removal, restoring its index and its notes", () => {
    const score = populated();
    const { track, bar } = firstIds(score);
    const second = track.bars[1]!;
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "bar.remove", trackId: track.id, barId: second.id }),
    );
    expect(edited.tracks[0]?.bars).toHaveLength(3);
    expect(undone.tracks[0]?.bars[0]?.id).toBe(bar.id);
    expect(undone.tracks[0]?.bars[1]?.id).toBe(second.id);
    expectSameDocument(undone, score);
  });

  it("undoes a tempo change back to the previous tempo", () => {
    const score = populated();
    const { bar } = firstIds(score);
    const { edited, undone } = roundTrip(score, batch({ type: "bar.setTempo", barId: bar.id, tempoBpm: 90 }));
    expect(edited.tracks[0]?.bars[0]?.tempoBpm).toBe(90);
    expect(undone.tracks[0]?.bars[0]?.tempoBpm).toBe(132);
    expectSameDocument(undone, score);
  });

  it("undoes a first-ever tempo by clearing it, not by writing a default", () => {
    const score = populated();
    const untimed = score.tracks[0]!.bars[1]!;
    expect(untimed.tempoBpm).toBeUndefined();
    const { undone } = roundTrip(score, batch({ type: "bar.setTempo", barId: untimed.id, tempoBpm: 200 }));
    expect("tempoBpm" in (undone.tracks[0]?.bars[1] ?? {})).toBe(false);
    expectSameDocument(undone, score);
  });

  it("undoes a meter change on a bar that had one", () => {
    const score = populated();
    const { bar } = firstIds(score);
    expect(bar.timeSignature).toEqual({ beats: 4, beatValue: 4 });
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "bar.setTimeSignature", barId: bar.id, timeSignature: { beats: 7, beatValue: 8 } }),
    );
    expect(edited.tracks[0]?.bars[0]?.timeSignature).toEqual({ beats: 7, beatValue: 8 });
    expectSameDocument(undone, score);
  });

  it("undoes a mid-score meter change by clearing it, so no signature is left engraved", () => {
    const score = populated();
    const third = score.tracks[0]!.bars[2]!;
    expect(third.timeSignature).toBeUndefined();
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "bar.setTimeSignature", barId: third.id, timeSignature: { beats: 3, beatValue: 4 } }),
    );
    expect(edited.tracks[0]?.bars[2]?.timeSignature).toEqual({ beats: 3, beatValue: 4 });
    // The field is gone, not set to 4/4 — a bar that never carried a signature
    // must not start carrying one because someone undid a change.
    expect("timeSignature" in (undone.tracks[0]?.bars[2] ?? {})).toBe(false);
    expectSameDocument(undone, score);
  });

  it("undoes a beat insert", () => {
    const score = populated();
    const { voice } = firstIds(score);
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "beat.insert", voiceId: voice.id, index: 2, beat: createRest(duration(8)) }),
    );
    expect(edited.tracks[0]?.bars[0]?.voices[0]?.beats).toHaveLength(5);
    expectSameDocument(undone, score);
  });

  it("undoes a beat removal, restoring its index and its notes", () => {
    const score = populated();
    const { voice, beat } = firstIds(score);
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "beat.remove", voiceId: voice.id, beatId: beat.id }),
    );
    expect(edited.tracks[0]?.bars[0]?.voices[0]?.beats).toHaveLength(3);
    const restored = undone.tracks[0]?.bars[0]?.voices[0]?.beats[0];
    expect(restored?.id).toBe(beat.id);
    expect(restored?.notes).toHaveLength(3);
    expectSameDocument(undone, score);
  });

  it("undoes a duration change", () => {
    const score = populated();
    const { beat } = firstIds(score);
    const { undone } = roundTrip(
      score,
      batch({ type: "beat.setDuration", beatId: beat.id, duration: duration(16) }),
    );
    expectSameDocument(undone, score);
  });

  it("undoes a dot", () => {
    const score = populated();
    const { beat } = firstIds(score);
    const dotted = applyBatch(score, batch({ type: "beat.setDots", beatId: beat.id, dots: 1 }));
    const { undone } = roundTrip(dotted, batch({ type: "beat.setDots", beatId: beat.id, dots: 2 }));
    expect(undone.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.dots).toBe(1);
    expectSameDocument(undone, dotted);
  });

  it("undoes a note insert on an empty string by removing it", () => {
    const score = populated();
    const { beat } = firstIds(score);
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "note.insert", beatId: beat.id, note: createNote(50, 4, 0) }),
    );
    expect(edited.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes).toHaveLength(4);
    expectSameDocument(undone, score);
  });

  it("undoes a note insert that replaced one, restoring the old note in its old place", () => {
    const score = populated();
    const { beat } = firstIds(score);
    const target = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!;
    // The middle note of the chord, so a naive restore would append it last.
    expect(target.notes[1]?.string).toBe(2);
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "note.insert", beatId: beat.id, note: createNote(62, 2, 6) }),
    );
    expect(edited.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes.find((n) => n.string === 2)?.fret).toBe(6);
    expect(undone.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes.map((n) => n.string)).toEqual([1, 2, 3]);
    expectSameDocument(undone, score);
  });

  it("undoes a note removal, keeping the chord's order and the note's articulations", () => {
    const score = populated();
    const target = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    expect(target.articulations).toEqual(["vibrato"]);
    const { edited, undone } = roundTrip(score, batch({ type: "note.remove", noteId: target.id }));
    expect(edited.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes).toHaveLength(2);
    const notes = undone.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes ?? [];
    expect(notes.map((n) => n.string)).toEqual([1, 2, 3]);
    expect(notes[0]?.articulations).toEqual(["vibrato"]);
    expectSameDocument(undone, score);
  });

  it("undoes a pitch change", () => {
    const score = populated();
    const target = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    const { undone } = roundTrip(score, batch({ type: "note.setPitch", noteId: target.id, pitch: 70 }));
    expectSameDocument(undone, score);
  });

  it("undoes a fingering change", () => {
    const score = populated();
    const target = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[2]!;
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "note.setFingering", noteId: target.id, string: 3, fret: 9 }),
    );
    expect(edited.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes[2]?.fret).toBe(9);
    expectSameDocument(undone, score);
  });

  it("undoes adding an articulation", () => {
    const score = populated();
    const target = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[1]!;
    const { undone } = roundTrip(
      score,
      batch({ type: "note.addArticulation", noteId: target.id, articulation: "palmMute" }),
    );
    expectSameDocument(undone, score);
  });

  it("undoes removing an articulation", () => {
    const score = populated();
    const target = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    const { edited, undone } = roundTrip(
      score,
      batch({ type: "note.removeArticulation", noteId: target.id, articulation: "vibrato" }),
    );
    expect(edited.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes[0]?.articulations).toEqual([]);
    expectSameDocument(undone, score);
  });
});

describe("invertOp declines to invert what it cannot", () => {
  it("reports no inverse for an op that changed nothing", () => {
    const score = populated();
    const { bar } = firstIds(score);
    // Already 132: applying this is a no-op, so undoing it must be too.
    expect(invertOp(score, op({ type: "bar.setTempo", barId: bar.id, tempoBpm: 132 }))).toEqual([]);
  });

  it("reports no inverse for an op addressing an id that is not there", () => {
    const score = populated();
    expect(invertOp(score, op({ type: "note.remove", noteId: "ghost" }))).toEqual([]);
    expect(invertOp(score, op({ type: "track.remove", trackId: "ghost" }))).toEqual([]);
    expect(
      invertOp(score, op({ type: "beat.setDots", beatId: "ghost", dots: 1 })),
    ).toEqual([]);
  });

  it("does not invert adding an articulation a note already has", () => {
    const score = populated();
    const target = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    // Inverting this to removeArticulation would strip a vibrato the user put
    // there earlier, undoing an edit that never happened.
    expect(
      invertOp(score, op({ type: "note.addArticulation", noteId: target.id, articulation: "vibrato" })),
    ).toEqual([]);
  });

  it("does not invert removing an articulation a note does not have", () => {
    const score = populated();
    const target = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    expect(
      invertOp(score, op({ type: "note.removeArticulation", noteId: target.id, articulation: "tap" })),
    ).toEqual([]);
  });
});

describe("invertBatch", () => {
  it("undoes a multi-op gesture as one unit", () => {
    const score = populated();
    const { track, voice, beat } = firstIds(score);
    const gesture = batch(
      { type: "beat.insert", voiceId: voice.id, index: 1, beat: createRest(duration(4)) },
      { type: "note.insert", beatId: beat.id, note: createNote(48, 5, 3) },
      { type: "track.rename", trackId: track.id, name: "Rhythm" },
      { type: "bar.setTempo", barId: track.bars[0]!.id, tempoBpm: 60 },
    );
    const { undone } = roundTrip(score, gesture);
    expectSameDocument(undone, score);
  });

  it("undoes ops in reverse, so two writes to one field restore the original", () => {
    const score = populated();
    const { bar } = firstIds(score);
    // Undoing forwards would restore 150 — the value the *second* op saw.
    const gesture = batch(
      { type: "bar.setTempo", barId: bar.id, tempoBpm: 150 },
      { type: "bar.setTempo", barId: bar.id, tempoBpm: 180 },
    );
    const { edited, undone } = roundTrip(score, gesture);
    expect(edited.tracks[0]?.bars[0]?.tempoBpm).toBe(180);
    expect(undone.tracks[0]?.bars[0]?.tempoBpm).toBe(132);
  });

  it("undoes an insert whose contents a later op in the same batch filled in", () => {
    const score = populated();
    const { track } = firstIds(score);
    const fresh = createBar();
    const gesture = batch(
      { type: "bar.insert", trackId: track.id, index: 4, bar: fresh },
      { type: "note.insert", beatId: fresh.voices[0]!.beats[0]!.id, note: createNote(64, 1, 7) },
    );
    const { edited, undone } = roundTrip(score, gesture);
    expect(edited.tracks[0]?.bars).toHaveLength(5);
    expectSameDocument(undone, score);
  });

  it("skips ops that did nothing while inverting the ones that did", () => {
    const score = populated();
    const { bar } = firstIds(score);
    const gesture = batch(
      { type: "note.remove", noteId: "ghost" },
      { type: "bar.setTempo", barId: bar.id, tempoBpm: 100 },
      { type: "track.rename", trackId: "ghost", name: "nope" },
    );
    const inverse = invertBatch(score, gesture);
    expect(inverse).toHaveLength(1);
    const { undone } = roundTrip(score, gesture);
    expectSameDocument(undone, score);
  });
});

describe("redo", () => {
  it("re-applies the original ops after an undo, reaching the edited document", () => {
    const score = populated();
    const { beat, voice } = firstIds(score);
    const gesture = batch(
      { type: "note.insert", beatId: beat.id, note: createNote(62, 2, 6) },
      { type: "beat.insert", voiceId: voice.id, index: 1, beat: createRest(duration(8)) },
    );
    const { edited, undone } = roundTrip(score, gesture);
    // Redo is the original ops again, with a fresh batch id. Ids inside the ops
    // are reused on purpose, so later edits still address the same entities.
    const redone = applyBatch(undone, { id: "redo-1", ops: gesture.ops });
    expectSameDocument(redone, edited);
  });

  it("survives three rounds of undo and redo without drift", () => {
    const score = populated();
    const { beat } = firstIds(score);
    const gesture = batch({ type: "note.insert", beatId: beat.id, note: createNote(62, 2, 6) });
    const inverse = invertBatch(score, gesture);
    let current = score;
    for (let i = 0; i < 3; i += 1) {
      const forward = applyBatch(current, { id: `f${i}`, ops: gesture.ops });
      current = applyBatch(forward, batch(...inverse));
      expectSameDocument(current, score);
    }
  });
});

describe("undo in a live session", () => {
  /**
   * The point of inverse ops: a collaborator's edit sits between the edit and
   * its undo, and must survive it. A snapshot undo could not do this — it would
   * put back a document that predates their work.
   */
  it("leaves a collaborator's concurrent edit in place", () => {
    const score = populated();
    const { beat, track } = firstIds(score);
    const mine = batch({ type: "note.insert", beatId: beat.id, note: createNote(50, 4, 0) });
    const inverse = invertBatch(score, mine);

    const afterMine = applyBatch(score, mine);
    const theirs = batch({ type: "track.rename", trackId: track.id, name: "Their name" });
    const afterTheirs = applyBatch(afterMine, theirs);

    const afterUndo = applyBatch(afterTheirs, batch(...inverse));
    expect(afterUndo.tracks[0]?.name).toBe("Their name");
    expect(afterUndo.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes).toHaveLength(3);
    expectSameDocument({ ...afterUndo, tracks: afterUndo.tracks }, applyBatch(score, theirs));
  });

  it("is a no-op when a collaborator already deleted what it would undo", () => {
    const score = populated();
    const { beat, voice } = firstIds(score);
    const mine = batch({ type: "note.insert", beatId: beat.id, note: createNote(50, 4, 0) });
    const inverse = invertBatch(score, mine);

    const afterMine = applyBatch(score, mine);
    // They remove the whole beat my note lived in.
    const afterTheirs = applyBatch(afterMine, batch({ type: "beat.remove", voiceId: voice.id, beatId: beat.id }));
    const afterUndo = applyBatch(afterTheirs, batch(...inverse));
    expect(afterUndo).toBe(afterTheirs);
  });

  it("undoes only the author's own edit when both edited the same field", () => {
    const score = populated();
    const { track } = firstIds(score);
    const mine = batch({ type: "track.rename", trackId: track.id, name: "Mine" });
    const inverse = invertBatch(score, mine);
    const theirs = batch({ type: "track.rename", trackId: track.id, name: "Theirs" });

    // Server order: mine, theirs. Undoing mine restores what mine overwrote,
    // which is the honest answer even though theirs is what is on screen — the
    // alternative is undo silently doing nothing, or clobbering their rename
    // with a name neither of them typed.
    const ordered = applyBatch(applyBatch(score, mine), theirs);
    expect(ordered.tracks[0]?.name).toBe("Theirs");
    const afterUndo = applyBatch(ordered, batch(...inverse));
    expect(afterUndo.tracks[0]?.name).toBe("Guitar");
  });
});
