/**
 * One playhead for the whole room.
 *
 * Collaboration in music software means editing a document together. This is the
 * other thing a group of musicians actually does: read one chart at the same time.
 * A rehearsal room has five people and one chart, and today each of them scrolls
 * their own copy — so the leader says "from bar 33" and everyone hunts for it.
 *
 * With a shared transport the person who presses play is driving: everybody's
 * playhead follows, stopping stops everyone, and seeking takes the room with you.
 * Anyone can stop following, because a player working on their own part in the
 * middle of a rehearsal is a normal thing to want.
 *
 * What this is *not* is sample-accurate sync. Two browsers on two machines cannot
 * agree on a clock to that precision without a real clock-sync protocol, and they
 * do not need to: the requirement is that five people are reading the same bar, not
 * that five speakers are phase-aligned. So the design is:
 *
 * - Transport actions are relayed as intents carrying an absolute position, not a
 *   delta. A dropped message then costs one action rather than desynchronising the
 *   room permanently.
 * - While the driver plays, it broadcasts its position periodically, and a follower
 *   corrects only when it has drifted past a threshold. Correcting continuously
 *   would make every follower's playhead stutter; correcting never would let them
 *   walk apart over a four-minute song.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type TransportAction = "play" | "pause" | "stop" | "seek" | "sync";

export interface TransportMessage {
  action: TransportAction;
  seconds: number;
}

/** What this hook needs of a player, so it can be tested against a fake one. */
export interface TransportTarget {
  playing: boolean;
  playPause: () => void;
  stop: () => void;
  seekTo: (seconds: number) => void;
  positionSeconds: () => number;
}

/** How often the driver states where it is, while playing. */
const SYNC_INTERVAL_MS = 2000;
/**
 * How far a follower may drift before it is corrected.
 *
 * Wide enough that network jitter does not cause a correction — a correction is a
 * visible jump, and a playhead that twitches every two seconds is worse than one
 * that is a beat out. Narrow enough that nobody is reading the wrong bar: a quarter
 * of a second is under a beat at any tempo a band rehearses at.
 */
const DRIFT_TOLERANCE_SECONDS = 0.35;

export interface SharedTransport {
  /** Whether this client follows the room's playhead. */
  following: boolean;
  setFollowing: (on: boolean) => void;
  /** Who last drove the transport, for the banner. Null until somebody does. */
  driver: string | null;
  /** Wrap a local transport action so the room hears about it. */
  playPause: () => void;
  stop: () => void;
  seekTo: (seconds: number) => void;
  /** Handler to hand to the collab client for incoming transport messages. */
  apply: (from: string, name: string, message: TransportMessage) => void;
}

export function useSharedTransport({
  target,
  live,
  send,
}: {
  target: TransportTarget;
  /** True while a session is live. Off, this is a pass-through. */
  live: boolean;
  send: (message: TransportMessage) => void;
}): SharedTransport {
  const [following, setFollowing] = useState(true);
  const [driver, setDriver] = useState<string | null>(null);

  /**
   * Set while a remote message is being applied.
   *
   * Applying one calls the same player methods a user does, and the player has no
   * idea which is which. Without this, a follower's play would be broadcast back as
   * its own action, the driver would follow that, and the room would ring.
   */
  const applyingRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  const sendRef = useRef(send);
  sendRef.current = send;
  const followingRef = useRef(following);
  followingRef.current = following;
  const liveRef = useRef(live);
  liveRef.current = live;

  const announce = useCallback((action: TransportAction, seconds: number) => {
    if (!liveRef.current || applyingRef.current) return;
    sendRef.current({ action, seconds });
  }, []);

  const playPause = useCallback(() => {
    const t = targetRef.current;
    const wasPlaying = t.playing;
    t.playPause();
    // The position is read before the player has acted on the toggle, which is what
    // a follower needs: where to start from, not where the driver got to.
    announce(wasPlaying ? "pause" : "play", t.positionSeconds());
  }, [announce]);

  const stop = useCallback(() => {
    targetRef.current.stop();
    announce("stop", 0);
  }, [announce]);

  const seekTo = useCallback(
    (seconds: number) => {
      targetRef.current.seekTo(seconds);
      announce("seek", seconds);
    },
    [announce],
  );

  const apply = useCallback((_from: string, name: string, message: TransportMessage) => {
    setDriver(name);
    if (!followingRef.current) return;
    const t = targetRef.current;
    applyingRef.current = true;
    try {
      switch (message.action) {
        case "play":
          t.seekTo(message.seconds);
          if (!t.playing) t.playPause();
          break;
        case "pause":
          t.seekTo(message.seconds);
          if (t.playing) t.playPause();
          break;
        case "stop":
          t.stop();
          break;
        case "seek":
          t.seekTo(message.seconds);
          break;
        case "sync": {
          // The periodic correction. Only acted on when the drift is past the
          // tolerance, so a follower in step is left alone rather than nudged
          // every two seconds.
          if (!t.playing) break;
          if (Math.abs(t.positionSeconds() - message.seconds) > DRIFT_TOLERANCE_SECONDS) {
            t.seekTo(message.seconds);
          }
          break;
        }
      }
    } finally {
      applyingRef.current = false;
    }
  }, []);

  /**
   * The driver's heartbeat.
   *
   * Sent by whoever is playing and not following — which is the driver, because
   * pressing play is what makes you it. A follower must not send these or the room
   * would have two clocks arguing.
   */
  useEffect(() => {
    if (!live || !target.playing) return;
    const timer = setInterval(() => {
      const t = targetRef.current;
      if (!t.playing) return;
      // A client that is following is not driving, so it stays quiet.
      if (followingRef.current && driver !== null) return;
      sendRef.current({ action: "sync", seconds: t.positionSeconds() });
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [live, target.playing, driver]);

  // Leaving a session clears the driver: the name in the banner belongs to a room
  // that no longer exists.
  useEffect(() => {
    if (!live) setDriver(null);
  }, [live]);

  return { following, setFollowing, driver, playPause, stop, seekTo, apply };
}
