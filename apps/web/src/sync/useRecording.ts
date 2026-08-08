/**
 * A recording, playing with the score.
 *
 * The alignment maths is in `packages/core/src/sync.ts` and is pure. What is here is the
 * part that has to hold an audio element, a blob and a playhead: attaching a file,
 * keeping it and its marks with the score, and driving the notation from the recording's
 * clock while it plays.
 *
 * The direction of control is the whole design. When a recording is playing it is the
 * clock, and the score follows: the audio element runs on the hardware's own timer,
 * alphaTab's playhead runs on its synth's, and two independent clocks nudging each other
 * is how a scroll ends up half a bar out and juddering. So the recording leads, the
 * synth is silenced, and the notation cursor is *seeked* to wherever the audio says it
 * should be. One clock, one truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  alignmentOf,
  recordingTimeAt,
  scoreTimeAt,
  speedAt,
  suspectPoints,
  withoutPointNear,
  withPoint,
  type Alignment,
  type SyncPoint,
} from "@cubscore/core";

/**
 * How often the notation is pulled back into line with the recording.
 *
 * Not every frame. A seek makes alphaTab re-place its cursor, and doing that sixty times
 * a second fights its own animation and reads as a judder. Four times a second is often
 * enough that the cursor never looks lost and rare enough that its own interpolation
 * does the smooth work in between.
 */
const FOLLOW_INTERVAL_MS = 250;

export interface RecordingController {
  /** An object URL for the attached audio, or null when there is none. */
  url: string | null;
  fileName: string | null;
  /**
   * The audio itself, for the caller to keep with the score.
   *
   * The blob and not the URL: a URL is a handle to memory owned by one document and dies
   * with the tab, which is what kept recordings — and therefore marks — from being stored
   * at all before now.
   */
  blob: Blob | null;
  playing: boolean;
  /** Where the recording is, in its own seconds. */
  seconds: number;
  duration: number;
  alignment: Alignment;
  /** Marks whose local tempo is wildly out of step, so a mis-tap can be found. */
  suspects: number[];
  /** The score's speed against the recording at this moment. One means they agree. */
  speed: number;

  attach: (file: File) => void;
  /**
   * Puts back a recording that was stored with the score, marks and all.
   *
   * Distinct from `attach` in exactly one way, and it is the important one: attaching a
   * *new* file clears the marks, because a mark means "this moment of this recording",
   * and restoring must not. Sharing one function and a flag was the alternative, and a
   * flag that silently erases a user's alignment is worth a second function.
   */
  restore: (blob: Blob, fileName: string) => void;
  detach: () => void;
  playPause: () => void;
  /** Marks the recording's current moment as the score's current moment. */
  mark: (scoreSeconds: number) => void;
  /** Removes the mark nearest where the recording is now. */
  unmark: () => void;
  /** Jumps the recording to a moment in the score. */
  seekToScore: (scoreSeconds: number) => void;
  /** The audio element, for the app to mount. */
  ref: (el: HTMLAudioElement | null) => void;
  /**
   * Handlers to spread onto that element.
   *
   * Whether it is playing comes from the element's own events rather than from a flag
   * set beside `play()`: that flag lies whenever the browser refuses to start, which it
   * does for an unsupported codec.
   */
  events: {
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLAudioElement>) => void;
    onSeeked: (e: React.SyntheticEvent<HTMLAudioElement>) => void;
  };
}

interface Deps {
  /** Moves the notation's playhead. */
  seekTo: (seconds: number) => void;
  /** Silences the synth while a recording is the thing making sound. */
  setSynthMuted: (muted: boolean) => void;
  /** Stored marks for the open score, and a place to put them back. */
  saved: Alignment;
  onAlignmentChange: (next: Alignment) => void;
}

export function useRecording(deps: Deps): RecordingController {
  const [url, setUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [duration, setDuration] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  /**
   * The object URL currently handed out, so it can be released exactly once.
   *
   * A ref rather than the state, because releasing has to happen outside React's
   * rendering: see `attach`.
   */
  const objectUrl = useRef<string | null>(null);
  const live = useRef(deps);
  live.current = deps;

  const alignment = deps.saved;

  /**
   * Releases the current object URL, if there is one.
   *
   * An object URL pins its blob in memory for the life of the document, so a user who
   * tries four recordings would be holding all four — and an audio file is tens of
   * megabytes, not kilobytes.
   */
  const release = useCallback(() => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);

  // The last one goes when the hook does, so leaving the page does not leave a blob
  // pinned behind it.
  useEffect(() => release, [release]);

  const attach = useCallback(
    (file: File) => {
      // Created here and not inside a state updater. React invokes an updater twice in
      // StrictMode, which minted two URLs and tracked one, leaking the whole audio file
      // on every attach — the exact reason side effects do not belong in an updater.
      release();
      const next = URL.createObjectURL(file);
      objectUrl.current = next;
      setUrl(next);
      setFileName(file.name);
      setBlob(file);
      setSeconds(0);
      setPlaying(false);
      // A mark says "this moment of *this* recording is that moment of the score", so
      // it means nothing about a different file. Keeping marks across an attach let the
      // notation follow a new recording using the old one's alignment, silently.
      live.current.onAlignmentChange(alignmentOf([]));
    },
    [release],
  );

  const restore = useCallback(
    (stored: Blob, name: string) => {
      release();
      const next = URL.createObjectURL(stored);
      objectUrl.current = next;
      setUrl(next);
      setFileName(name);
      setBlob(stored);
      setSeconds(0);
      setPlaying(false);
      // No `onAlignmentChange` here. The marks came out of storage with this audio and
      // are the whole reason it was worth keeping.
    },
    [release],
  );

  const detach = useCallback(() => {
    audio.current?.pause();
    release();
    setUrl(null);
    setFileName(null);
    setBlob(null);
    setPlaying(false);
    setSeconds(0);
    live.current.setSynthMuted(false);
    // Detaching drops the marks too. They align a recording that is no longer here, and
    // keeping them would silently apply one file's alignment to the next one attached.
    live.current.onAlignmentChange(alignmentOf([]));
  }, [release]);

  const playPause = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      // Silenced before it starts, not after: the alternative is a bar of the synth
      // and the record playing over each other every time somebody presses play.
      live.current.setSynthMuted(true);
      void el.play().catch(() => undefined);
    } else {
      el.pause();
      live.current.setSynthMuted(false);
    }
  }, []);

  const mark = useCallback((scoreSeconds: number) => {
    const el = audio.current;
    if (!el) return;
    const point: SyncPoint = { recordingSeconds: el.currentTime, scoreSeconds };
    live.current.onAlignmentChange(withPoint(live.current.saved, point));
  }, []);

  const unmark = useCallback(() => {
    const el = audio.current;
    live.current.onAlignmentChange(withoutPointNear(live.current.saved, el?.currentTime ?? 0));
  }, []);

  const seekToScore = useCallback((scoreSeconds: number) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = recordingTimeAt(live.current.saved, scoreSeconds);
    setSeconds(el.currentTime);
  }, []);

  /**
   * Pulls the notation back to where the recording is.
   *
   * On an interval rather than on the audio element's own `timeupdate`, which fires at
   * whatever rate the browser feels like — around four times a second in practice, but
   * unspecified, and a follow that stutters because the event did is untraceable.
   */
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const el = audio.current;
      if (!el) return;
      setSeconds(el.currentTime);
      live.current.seekTo(scoreTimeAt(live.current.saved, el.currentTime));
    };
    tick();
    const timer = window.setInterval(tick, FOLLOW_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  const ref = useCallback((el: HTMLAudioElement | null) => {
    audio.current = el;
  }, []);

  const suspects = useMemo(() => suspectPoints(alignment), [alignment]);
  const speed = useMemo(() => speedAt(alignment, seconds), [alignment, seconds]);

  const events = useMemo(
    () => ({
      onPlay: () => setPlaying(true),
      onPause: () => {
        setPlaying(false);
        // Unmuted whenever the recording stops, however it stopped. Leaving the synth
        // silenced after a recording ends is a score that plays nothing and says
        // nothing about why.
        live.current.setSynthMuted(false);
      },
      onEnded: () => {
        setPlaying(false);
        live.current.setSynthMuted(false);
      },
      onLoadedMetadata: (e: React.SyntheticEvent<HTMLAudioElement>) =>
        setDuration(e.currentTarget.duration || 0),
      onSeeked: (e: React.SyntheticEvent<HTMLAudioElement>) => setSeconds(e.currentTarget.currentTime),
    }),
    [],
  );

  return {
    url,
    fileName,
    blob,
    playing,
    seconds,
    duration,
    alignment,
    suspects,
    speed,
    attach,
    restore,
    detach,
    playPause,
    mark,
    unmark,
    seekToScore,
    ref,
    events,
  };
}
