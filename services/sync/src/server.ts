/**
 * CubScore realtime sync, v1.
 *
 * One room per collab session. The host seeds a score snapshot; every edit
 * arrives as a serialized op batch, gets a server-assigned sequence number,
 * and is broadcast to every member including the one who sent it.
 *
 * That echo is the whole convergence story. This order is the document's
 * order: clients hold their own edits as provisional until they come back
 * with a place in the sequence, so every client applies the same batches in
 * the same order and arrives at the same document. The op design does the
 * rest — application is deterministic and ops addressing a missing id are
 * no-ops, so concurrent deletes and edits resolve instead of conflicting.
 *
 * Deliberate v1 limits, all documented in README: rooms live in memory (a
 * restart ends live sessions), there is no offline merge (that is the CRDT
 * work this protocol is designed to grow into), and room ids are unguessable
 * capability URLs rather than authenticated membership.
 */
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_BATCHES = 50_000;
/**
 * A room's whole retained log, in bytes.
 *
 * The count cap alone bounded nothing that matters: 50,000 batches of 4 MB is
 * 200 GB of retained memory, so one unauthenticated socket could exhaust the
 * heap and, because rooms live in memory, end every live session on the host.
 * Bytes are what the machine actually runs out of.
 */
const MAX_ROOM_BYTES = 16 * 1024 * 1024;
const MAX_MEMBERS = 32;

interface Member {
  socket: WebSocket;
  id: string;
  name: string;
  /**
   * Where this member's caret is, as last reported.
   *
   * Retained so a joiner can be told immediately. Cursor messages are only sent
   * when a caret moves, so without this a new arrival saw no peer carets at all
   * until somebody happened to move one — the room could look empty for minutes
   * while three people were working in it.
   */
  cursor: { bar: number; beat: number } | null;
}

/** Shape check on an untrusted cursor before it is retained or forwarded. */
function isCursor(value: unknown): value is { bar: number; beat: number } {
  if (typeof value !== "object" || value === null) return false;
  const c = value as { bar?: unknown; beat?: unknown };
  return Number.isInteger(c.bar) && Number.isInteger(c.beat) && (c.bar as number) >= 0 && (c.beat as number) >= 0;
}

interface Room {
  /** JSON score snapshot from the host, replayed to joiners. */
  snapshot: unknown | null;
  /** Ordered op batches since the snapshot. */
  batches: unknown[];
  /** Retained size of snapshot plus batches, to bound memory per room. */
  bytes: number;
  members: Map<WebSocket, Member>;
}

/**
 * Is this shaped like an op batch?
 *
 * Anyone holding a session link can send anything. `if (!message.batch)` let
 * `{}`, `42` and `{"ops":null}` through, and applying one threw out of the React
 * state updater on every member — blanking their tabs — and then crashed
 * everyone who joined afterwards, because the server had stored what it
 * broadcast. The room stayed dead until the process restarted. The client is
 * hardened too; this stops the poison being retained in the first place.
 */
function isBatch(value: unknown): value is { id: string; ops: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; ops?: unknown };
  return typeof candidate.id === "string" && Array.isArray(candidate.ops);
}

const rooms = new Map<string, Room>();
let nextMemberId = 1;

function roomFor(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = { snapshot: null, batches: [], bytes: 0, members: new Map() };
    rooms.set(id, room);
  }
  return room;
}

function send(socket: WebSocket, message: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room: Room, from: WebSocket | null, message: object): void {
  for (const member of room.members.values()) {
    if (member.socket !== from) send(member.socket, message);
  }
}

function peerList(room: Room): Array<{ id: string; name: string }> {
  return [...room.members.values()].map((m) => ({ id: m.id, name: m.name }));
}

/**
 * Every other member's caret, in the same shape a live `cursor` message carries,
 * so a joining client can apply them through the path it already has.
 *
 * The recipient is excluded: its own caret is not presence, and a client that
 * drew a caret for itself would show two on the same beat.
 */
function cursorList(
  room: Room,
  exclude: Member,
): Array<{ from: string; name: string; cursor: { bar: number; beat: number } }> {
  const out: Array<{ from: string; name: string; cursor: { bar: number; beat: number } }> = [];
  for (const m of room.members.values()) {
    if (m === exclude || !m.cursor) continue;
    out.push({ from: m.id, name: m.name, cursor: m.cursor });
  }
  return out;
}

// Bound to the loopback interface like the API, so the web app's proxy is the
// only way in. It used to listen on every interface, which put an
// unauthenticated service on the network.
const server = new WebSocketServer({ port: PORT, host: HOST, maxPayload: MAX_MESSAGE });

server.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const roomId = url.searchParams.get("room");
  if (!roomId || !/^[A-Za-z0-9_-]{8,64}$/.test(roomId)) {
    socket.close(4000, "missing or invalid room");
    return;
  }

  const room = roomFor(roomId);
  if (room.members.size >= MAX_MEMBERS) {
    socket.close(4001, "this session is full");
    return;
  }
  const member: Member = {
    socket,
    id: `m${nextMemberId++}`,
    name: url.searchParams.get("name")?.slice(0, 40) || "guest",
    cursor: null,
  };
  room.members.set(socket, member);

  // Late joiners replay the snapshot plus everything since, and are handed
  // everyone's caret so presence is there on arrival rather than on next move.
  send(socket, {
    type: "state",
    you: member.id,
    snapshot: room.snapshot,
    batches: room.batches,
    peers: peerList(room),
    cursors: cursorList(room, member),
  });
  broadcast(room, socket, { type: "peers", peers: peerList(room) });

  socket.on("message", (raw) => {
    let message: { type?: string; score?: unknown; batch?: unknown; cursor?: unknown };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch {
      return;
    }

    switch (message.type) {
      case "init": {
        // The host, or whoever is present when a room has no snapshot: a room
        // that lost its snapshot could otherwise never get one again, and
        // everyone in it would edit their own document while the banner said
        // LIVE. Only the unseeded case is open, so a guest cannot overwrite a
        // live session with their own score.
        if (room.snapshot !== null || !message.score) break;
        const size = JSON.stringify(message.score).length;
        if (size > MAX_ROOM_BYTES) {
          send(socket, { type: "full", reason: "this score is too large to share live" });
          break;
        }
        room.snapshot = message.score;
        room.batches = [];
        room.bytes = size;
        broadcast(room, socket, { type: "state", snapshot: room.snapshot, batches: [], peers: peerList(room) });
        break;
      }

      case "batch": {
        if (!isBatch(message.batch)) return;
        const size = JSON.stringify(message.batch).length;
        if (room.batches.length >= MAX_BATCHES || room.bytes + size > MAX_ROOM_BYTES) {
          // Say so. Returning silently meant the sender never got its echo, so
          // it held the edit as provisional forever: it kept seeing its own
          // work while nobody else ever did, the banner still said LIVE, and
          // every later edit vanished the same way.
          send(socket, { type: "full", reason: "this session has reached its size limit" });
          return;
        }
        room.batches.push(message.batch);
        room.bytes += size;
        // Echoed to the sender as well, which is what makes the order here the
        // order everywhere. A client cannot know where its own edit landed in
        // the sequence until it is told, so it holds the edit as provisional
        // and replays it over confirmed state until this arrives. Without the
        // echo, two people editing at once kept two different documents.
        broadcast(room, null, {
          type: "batch",
          batch: message.batch,
          from: member.id,
          seq: room.batches.length,
        });
        break;
      }

      case "cursor":
        if (!isCursor(message.cursor)) break;
        member.cursor = message.cursor;
        broadcast(room, socket, { type: "cursor", from: member.id, name: member.name, cursor: message.cursor });
        break;

      default:
        break;
    }
  });

  socket.on("close", () => {
    room.members.delete(socket);
    broadcast(room, null, { type: "peers", peers: peerList(room) });
    // Rooms are ephemeral: last one out turns off the lights.
    if (room.members.size === 0) rooms.delete(roomId);
  });
});

console.log(`cubscore sync on :${PORT}`);
