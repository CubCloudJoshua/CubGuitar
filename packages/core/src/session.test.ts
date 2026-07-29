/**
 * Session ordering: the part convergence.test.ts leaves open.
 *
 * That file proves conflicting edits resolve by order alone. This one proves
 * every client ends up using the same order, by running the protocol against a
 * model of the sync server: clients send batches, the server assigns arrival
 * order, and every client — including the sender — applies what comes back.
 *
 * The first test is the regression. Two clients edit the same note at the same
 * moment, and with each of them applying its own edit first the two documents
 * disagreed permanently, with a third answer waiting for the next joiner.
 */
import { describe, expect, it } from "vitest";
import { applyBatch } from "./apply.js";
import {
  createBar,
  createNote,
  createRest,
  createScore,
  createTrack,
  duration,
  frettedGuitar,
  nextId,
} from "./build.js";
import { beginSession, localCommit, serverBatch, sessionView } from "./session.js";
import { toAlphaTex } from "./alphatex.js";
import type { Op, OpBatch, OpKind, Score } from "./index.js";

function op(kind: OpKind): Op {
  return { id: nextId("o"), author: "test", at: 0, ...kind };
}

function batch(label: string, ...kinds: OpKind[]): OpBatch {
  return { id: nextId("k"), ops: kinds.map(op), label };
}

function beatAt(score: Score, bar: number, index: number) {
  const beat = score.tracks[0]?.bars[bar]?.voices[0]?.beats[index];
  if (!beat) throw new Error(`no beat at ${bar}:${index}`);
  return beat;
}

/**
 * The sync server's whole contribution: an order, and an echo to everyone.
 * Nothing about a client's own edits is special here, which is the point.
 */
class Room {
  readonly log: OpBatch[] = [];
  private readonly clients: Client[] = [];

  join(client: Client): void {
    this.clients.push(client);
  }

  receive(batch: OpBatch): void {
    this.log.push(batch);
    for (const client of this.clients) client.deliver(batch);
  }
}

/** A client that keeps its own edits provisional until the server orders them. */
class Client {
  private session;

  constructor(
    base: Score,
    private readonly room: Room,
  ) {
    this.session = beginSession(base);
    room.join(this);
  }

  /** Edit locally and send. The edit is visible before the server answers. */
  send(batch: OpBatch): void {
    this.session = localCommit(this.session, batch);
    this.room.receive(batch);
  }

  /** Edit locally, but hold the message back, as a slow connection would. */
  sendLater(batch: OpBatch): () => void {
    this.session = localCommit(this.session, batch);
    return () => this.room.receive(batch);
  }

  deliver(batch: OpBatch): void {
    this.session = serverBatch(this.session, batch);
  }

  get document(): Score {
    return sessionView(this.session);
  }

  get music(): string {
    return toAlphaTex(this.document);
  }

  get pendingCount(): number {
    return this.session.pending.length;
  }
}

/** What a client that joins at the end sees: the log replayed over the base. */
function replay(base: Score, log: OpBatch[]): string {
  return toAlphaTex(log.reduce(applyBatch, base));
}

describe("live session ordering", () => {
  it("converges when two clients edit the same note at the same moment", () => {
    const base = createScore("Conflict");
    const target = beatAt(base, 0, 0).id;
    const room = new Room();
    const alice = new Client(base, room);
    const bob = new Client(base, room);

    // Same beat, same string, different frets: a genuine conflict, where the
    // result depends entirely on which one is applied second.
    const deliverAlice = alice.sendLater(
      batch("alice", { type: "note.insert", beatId: target, note: createNote(67, 1, 3) }),
    );
    const deliverBob = bob.sendLater(
      batch("bob", { type: "note.insert", beatId: target, note: createNote(69, 1, 5) }),
    );

    // Before either message lands, each client is showing its own edit. This
    // is the divergence the old scheme made permanent.
    expect(alice.music).not.toBe(bob.music);

    deliverAlice();
    deliverBob();

    expect(alice.pendingCount).toBe(0);
    expect(bob.pendingCount).toBe(0);
    expect(alice.music).toBe(bob.music);
    // And it is the server's order they agreed on, not either client's.
    expect(alice.music).toBe(replay(base, room.log));
    // Bob's edit arrived second in the log, so Bob's fret is the one that won,
    // on both machines.
    expect(alice.document.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes[0]?.fret).toBe(5);
  });

  it("converges when messages cross in flight in opposite orders", () => {
    const base = createScore("Crossed");
    const room = new Room();
    const alice = new Client(base, room);
    const bob = new Client(base, room);
    const target = beatAt(base, 0, 1).id;

    // Three edits queued on each side, released interleaved.
    const a1 = alice.sendLater(batch("a1", { type: "note.insert", beatId: target, note: createNote(64, 1, 0) }));
    const b1 = bob.sendLater(batch("b1", { type: "note.insert", beatId: target, note: createNote(66, 1, 2) }));
    const a2 = alice.sendLater(batch("a2", { type: "beat.setDots", beatId: target, dots: 1 }));
    const b2 = bob.sendLater(batch("b2", { type: "note.insert", beatId: target, note: createNote(62, 2, 3) }));

    b1();
    a1();
    b2();
    a2();

    expect(alice.music).toBe(bob.music);
    expect(alice.music).toBe(replay(base, room.log));
    expect(alice.pendingCount + bob.pendingCount).toBe(0);
  });

  it("shows a local edit before the server has ordered it", () => {
    const base = createScore("Responsive");
    const room = new Room();
    const alice = new Client(base, room);
    const before = alice.music;

    const deliver = alice.sendLater(
      batch("a", { type: "note.insert", beatId: beatAt(base, 0, 0).id, note: createNote(64, 1, 0) }),
    );
    expect(alice.music).not.toBe(before);
    expect(alice.pendingCount).toBe(1);

    // And the acknowledgement does not apply it a second time.
    const provisional = alice.music;
    deliver();
    expect(alice.music).toBe(provisional);
    expect(alice.pendingCount).toBe(0);
  });

  it("keeps a pending edit visible while other people's edits land under it", () => {
    const base = createScore("Rebase");
    const room = new Room();
    const alice = new Client(base, room);
    const bob = new Client(base, room);

    const deliverAlice = alice.sendLater(
      batch("alice", { type: "note.insert", beatId: beatAt(base, 0, 0).id, note: createNote(64, 1, 0) }),
    );
    // Bob's edits are ordered first, while Alice's is still in flight.
    bob.send(batch("bob1", { type: "note.insert", beatId: beatAt(base, 1, 0).id, note: createNote(59, 2, 0) }));
    bob.send(batch("bob2", { type: "score.setTitle", title: "Renamed" }));

    // Alice sees Bob's work and her own, even though hers is unacknowledged.
    expect(alice.document.title).toBe("Renamed");
    expect(alice.document.tracks[0]?.bars[0]?.voices[0]?.beats[0]?.notes).toHaveLength(1);
    expect(alice.pendingCount).toBe(1);

    deliverAlice();
    expect(alice.music).toBe(bob.music);
    expect(alice.music).toBe(replay(base, room.log));
  });

  it("survives a batch delivered twice", () => {
    const base = createScore("Duplicate");
    const room = new Room();
    const alice = new Client(base, room);
    const bob = new Client(base, room);

    const doubled = batch("bob", {
      type: "note.insert",
      beatId: beatAt(base, 0, 0).id,
      note: createNote(64, 1, 0),
    });
    bob.send(doubled);
    const once = alice.music;
    // A reconnect, or a server that resends its log, delivers it again.
    alice.deliver(doubled);
    bob.deliver(doubled);

    expect(alice.music).toBe(once);
    expect(bob.music).toBe(once);
  });

  /**
   * note.insert is idempotent by construction — it filters the string, then
   * appends — so testing redelivery with it proves nothing about the ops that
   * splice. Those add a second element carrying the identical id, and from then
   * on every op addressing that id is ambiguous.
   */
  it("survives redelivery of the ops that insert by index", () => {
    const base = createScore("Redelivered inserts");
    const track = base.tracks[0];
    if (!track) throw new Error("no track");
    const voice = track.bars[0]?.voices[0];
    if (!voice) throw new Error("no voice");

    const cases = [
      {
        what: "beat.insert",
        b: batch("beat", { type: "beat.insert", voiceId: voice.id, index: 1, beat: createRest(duration(4)) }),
        count: (s: Score) => s.tracks[0]?.bars[0]?.voices[0]?.beats.length ?? 0,
      },
      {
        what: "bar.insert",
        b: batch("bar", { type: "bar.insert", trackId: track.id, index: 1, bar: createBar() }),
        count: (s: Score) => s.tracks[0]?.bars.length ?? 0,
      },
      {
        what: "track.insert",
        b: batch("track", {
          type: "track.insert",
          index: 1,
          track: createTrack("Second", frettedGuitar(), 2),
        }),
        count: (s: Score) => s.tracks.length,
      },
    ];

    for (const { what, b, count } of cases) {
      const once = applyBatch(base, b);
      const twice = applyBatch(once, b);
      expect(count(twice), `${what} applied twice`).toBe(count(once));
      // And no two elements anywhere share an id, which is the damage the count
      // check is standing in for.
      const ids = [
        ...twice.tracks.map((t) => t.id),
        ...twice.tracks.flatMap((t) => t.bars.map((bar) => bar.id)),
        ...twice.tracks.flatMap((t) => t.bars.flatMap((bar) => bar.voices.flatMap((v) => v.beats.map((x) => x.id)))),
      ];
      expect(new Set(ids).size, `${what} left duplicate ids`).toBe(ids.length);
    }
  });

  /**
   * Batches arrive from anyone holding the session link. A batch with no ops
   * array threw out of the React state updater that applied it, and with no
   * error boundary above it that blanked every member's tab — then crashed
   * everyone who joined afterwards, because the server had stored it.
   */
  it("treats a malformed batch as one that does nothing", () => {
    const base = createScore("Malformed");
    const session = beginSession(base);
    const junk = [
      { id: "k1", label: "no ops" },
      { id: "k2", label: "null ops", ops: null },
      { id: "k3", label: "ops is not an array", ops: { 0: "x" } },
      { id: "k4", label: "op is not an object", ops: ["nope", 42, null] },
      42,
      "batch",
      null,
    ];
    for (const value of junk) {
      const batchLike = value as unknown as OpBatch;
      expect(() => applyBatch(base, batchLike), JSON.stringify(value)).not.toThrow();
      expect(applyBatch(base, batchLike)).toBe(base);
      expect(() => serverBatch(session, batchLike), JSON.stringify(value)).not.toThrow();
    }
  });

  it("reports no change by identity when a batch moves nothing", () => {
    const base = createScore("Inert");
    const started = beginSession(base);
    // An op addressing an id this document does not have.
    const inert = batch("nobody", { type: "note.remove", noteId: "n-missing" });
    expect(serverBatch(started, inert)).toBe(started);
    expect(sessionView(started)).toBe(base);
  });

  it("gives a late joiner the same document as everyone else", () => {
    const base = createScore("Late");
    const room = new Room();
    const alice = new Client(base, room);
    const bob = new Client(base, room);

    alice.send(batch("a", { type: "note.insert", beatId: beatAt(base, 0, 0).id, note: createNote(64, 1, 0) }));
    bob.send(batch("b", { type: "note.insert", beatId: beatAt(base, 0, 0).id, note: createNote(67, 1, 3) }));
    alice.send(batch("c", { type: "score.setArtist", artist: "Both" }));

    // A joiner is handed the snapshot and the log, which is exactly replay.
    const joiner = new Client(base, room);
    for (const entry of room.log) joiner.deliver(entry);

    expect(joiner.music).toBe(alice.music);
    expect(joiner.music).toBe(bob.music);
  });
});
