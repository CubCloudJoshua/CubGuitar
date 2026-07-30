/**
 * Client side of realtime collaboration.
 *
 * The host starts a session from the score they are editing; guests join by
 * link. Every local commit streams to the room, every remote batch applies
 * to the local document. The session lives as long as the room has members.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Score as CoreScore, OpBatch } from "@cubscore/core";
import type { EditorController } from "../editor/useEditor";

export type CollabStatus = "off" | "connecting" | "live" | "error";

/** One playhead for the room; see useSharedTransport for what it is and is not. */
export interface TransportRelay {
  action: "play" | "pause" | "stop" | "seek" | "sync";
  seconds: number;
}

export interface Peer {
  id: string;
  name: string;
}

export interface PeerCursor {
  name: string;
  bar: number;
  beat: number;
}

interface ServerMessage {
  type: "state" | "batch" | "peers" | "cursor" | "full" | "transport";
  reason?: string;
  you?: string;
  snapshot?: unknown;
  batches?: unknown[];
  batch?: unknown;
  peers?: Peer[];
  from?: string;
  name?: string;
  cursor?: { bar: number; beat: number };
  transport?: { action: string; seconds: number };
  /** Everyone else's caret at the moment of joining, see the sync server. */
  cursors?: Array<{ from: string; name: string; cursor: { bar: number; beat: number } }>;
}

export function collabIdFromLocation(): string | null {
  const match = /^#c=([A-Za-z0-9_-]{8,64})$/.exec(location.hash);
  return match?.[1] ?? null;
}

function newRoomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function useCollab(editor: EditorController, displayName: string) {
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<CollabStatus>("off");
  const [url, setUrl] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [cursors, setCursors] = useState<Map<string, PeerCursor>>(new Map());
  const [error, setError] = useState<string | null>(null);
  /**
   * Incremented each time this client loads a room's snapshot as a guest.
   *
   * The join sequence (JoinReveal) keys off it. A counter rather than a flag
   * because a reconnect to the same room is another arrival, and a flag that was
   * already true would let the second one land with no sequence at all.
   */
  const [joinCount, setJoinCount] = useState(0);

  const { applyRemote, setCommitListener, setLiveOrdering, loadScore } = editor;

  /**
   * The document, and the display name, read at the moment they are needed.
   *
   * Both used to be captured in `connect`'s closure, and `displayName` was in
   * its dependency list. It is derived from the signed-in user, which resolves
   * asynchronously after boot, so `connect` changed identity a few hundred
   * milliseconds in — and the effect that joins a room from a #c= link re-ran
   * and reconnected. Every signed-in person opening a collab link therefore
   * dropped and remade their socket, which was enough to delete a room they
   * were briefly alone in and lose its snapshot for good.
   */
  /**
   * Where incoming transport messages go. A ref rather than state because the
   * socket handler is bound once, and a listener captured in its closure would go
   * stale the first time the component re-rendered.
   */
  const transportListenerRef = useRef<((from: string, name: string, message: TransportRelay) => void) | null>(
    null,
  );
  const setTransportListener = useCallback(
    (listener: ((from: string, name: string, message: TransportRelay) => void) | null) => {
      transportListenerRef.current = listener;
    },
    [],
  );

  const sendTransport = useCallback((message: TransportRelay) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "transport", transport: message }));
    }
  }, []);

  const scoreRef = useRef(editor.score);
  scoreRef.current = editor.score;
  const nameRef = useRef(displayName);
  nameRef.current = displayName;

  const connect = useCallback(
    (roomId: string, seed: boolean) => {
      // Detach the old socket before closing it. Its close event fires later,
      // and if that lands after the new socket opens, its handler would hand
      // ordering back mid-session and unsubscribe a live room.
      const previous = socketRef.current;
      if (previous) {
        previous.onclose = null;
        previous.onmessage = null;
        previous.onerror = null;
        previous.close();
      }
      setStatus("connecting");
      setError(null);

      const proto = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(
        `${proto}://${location.host}/ws?room=${roomId}&name=${encodeURIComponent(nameRef.current)}`,
      );
      socketRef.current = socket;

      socket.onopen = () => {
        // Before anything can arrive: from here the server decides the order in
        // which edits apply, and local edits are provisional until it says
        // where they landed. Done here rather than in an effect so a batch that
        // arrives in the same tick cannot be applied under the old rule.
        setLiveOrdering(true);
        // Seeded from the document as it is now, not as it was when the button
        // was pressed. The handshake takes time, and edits made during it went
        // into the host's own state without reaching the room — every guest was
        // then permanently missing them, with no batch that would ever carry
        // them, because the commit listener only attaches once the session is
        // live.
        if (seed) socket.send(JSON.stringify({ type: "init", score: scoreRef.current }));
        setStatus("live");
        setUrl(`${location.origin}${location.pathname}#c=${roomId}`);
      };

      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case "state":
            // Guests replay the snapshot plus every batch since.
            if (message.snapshot) {
              loadScore(message.snapshot as CoreScore);
              for (const batch of message.batches ?? []) applyRemote(batch as OpBatch);
              setJoinCount((n) => n + 1);
            } else {
              // The room has no snapshot: it was never seeded, or it was emptied
              // when its last member left. Nobody would ever seed it again, and
              // everyone in it would edit their own document while the banner
              // said LIVE, so whoever notices first offers theirs. The server
              // accepts only the unseeded case, so this cannot overwrite a live
              // session.
              socket.send(JSON.stringify({ type: "init", score: scoreRef.current }));
            }
            if (message.peers) setPeers(message.peers);
            // Presence on arrival. Cursor messages only go out when a caret
            // moves, so without this a joiner saw no peer carets until somebody
            // happened to move one — the room looked empty while it was not.
            if (message.cursors) {
              setCursors(
                new Map(
                  message.cursors.map((c) => [c.from, { name: c.name, bar: c.cursor.bar, beat: c.cursor.beat }]),
                ),
              );
            }
            break;
          case "batch":
            if (message.batch) applyRemote(message.batch as OpBatch);
            break;
          case "full":
            // The room stopped accepting edits. Saying so is the point: the
            // alternative was the user going on seeing their own work while
            // nobody else received any of it.
            setError(message.reason ?? "this live session is full");
            break;
          case "peers":
            if (message.peers) setPeers(message.peers);
            break;
          case "transport":
            if (message.from && message.transport) {
              transportListenerRef.current?.(message.from, message.name ?? "guest", message.transport as TransportRelay);
            }
            break;
          case "cursor":
            if (message.from && message.cursor) {
              const { from, name, cursor } = message;
              setCursors((prev) => {
                const next = new Map(prev);
                next.set(from, { name: name ?? "guest", bar: cursor.bar, beat: cursor.beat });
                return next;
              });
            }
            break;
        }
      };

      socket.onerror = () => {
        setStatus("error");
        setError("collaboration connection failed");
      };
      socket.onclose = () => {
        // Ordering comes home. Anything still pending stays in the document:
        // the connection dropped, and losing the user's last few edits would
        // be a worse answer than keeping work the room never saw.
        setLiveOrdering(false);
        setStatus((s) => (s === "error" ? s : "off"));
        setPeers([]);
        setCursors(new Map());
      };
    },
    // Deliberately free of displayName and of the score: both are read from
    // refs, so `connect` — and therefore `join` — keeps a stable identity and
    // the effect that joins from a link never reconnects on its own.
    [loadScore, applyRemote, setLiveOrdering],
  );

  /** Host: open a room seeded with the score being edited. */
  const start = useCallback(() => connect(newRoomId(), true), [connect]);

  /** Guest: join an existing room from a #c= link. */
  const join = useCallback((roomId: string) => connect(roomId, false), [connect]);

  const stop = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setLiveOrdering(false);
    setStatus("off");
    setUrl(null);
  }, [setLiveOrdering]);

  // Stream local commits into the room while live.
  useEffect(() => {
    if (status !== "live") {
      setCommitListener(null);
      return;
    }
    setCommitListener((batch) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "batch", batch }));
      }
    });
    return () => setCommitListener(null);
  }, [status, setCommitListener]);

  // Presence: share the caret position, lightly throttled.
  const { cursor } = editor;
  useEffect(() => {
    if (status !== "live") return;
    const timer = setTimeout(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "cursor", cursor: { bar: cursor.bar, beat: cursor.beat } }));
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [status, cursor]);

  useEffect(() => () => socketRef.current?.close(), []);

  return {
    status,
    url,
    peers,
    cursors,
    error,
    joinCount,
    start,
    join,
    stop,
    sendTransport,
    setTransportListener,
  };
}

export type CollabController = ReturnType<typeof useCollab>;
