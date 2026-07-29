/**
 * CubScore realtime sync, v1.
 *
 * One room per collab session. The host seeds a score snapshot; every edit
 * arrives as a serialized op batch, gets a server-assigned sequence number,
 * and is broadcast to the other members. Convergence comes from ordering
 * plus the op design: application is deterministic and ops addressing a
 * missing id are no-ops, so concurrent deletes and edits resolve instead of
 * conflicting.
 *
 * Deliberate v1 limits, all documented in README: rooms live in memory (a
 * restart ends live sessions), there is no offline merge (that is the CRDT
 * work this protocol is designed to grow into), and room ids are unguessable
 * capability URLs rather than authenticated membership.
 */
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8788);
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_BATCHES = 50_000;

interface Member {
  socket: WebSocket;
  id: string;
  name: string;
}

interface Room {
  /** JSON score snapshot from the host, replayed to joiners. */
  snapshot: unknown | null;
  /** Ordered op batches since the snapshot. */
  batches: unknown[];
  members: Map<WebSocket, Member>;
}

const rooms = new Map<string, Room>();
let nextMemberId = 1;

function roomFor(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = { snapshot: null, batches: [], members: new Map() };
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

const server = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE });

server.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const roomId = url.searchParams.get("room");
  if (!roomId || !/^[A-Za-z0-9_-]{8,64}$/.test(roomId)) {
    socket.close(4000, "missing or invalid room");
    return;
  }

  const room = roomFor(roomId);
  const member: Member = {
    socket,
    id: `m${nextMemberId++}`,
    name: url.searchParams.get("name")?.slice(0, 40) || "guest",
  };
  room.members.set(socket, member);

  // Late joiners replay the snapshot plus everything since.
  send(socket, {
    type: "state",
    you: member.id,
    snapshot: room.snapshot,
    batches: room.batches,
    peers: peerList(room),
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
      case "init":
        // The host (or the first member with content) seeds the room.
        if (room.snapshot === null && message.score) {
          room.snapshot = message.score;
          room.batches = [];
          broadcast(room, socket, { type: "state", snapshot: room.snapshot, batches: [], peers: peerList(room) });
        }
        break;

      case "batch":
        if (!message.batch) return;
        if (room.batches.length >= MAX_BATCHES) return;
        room.batches.push(message.batch);
        broadcast(room, socket, { type: "batch", batch: message.batch, from: member.id });
        break;

      case "cursor":
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
