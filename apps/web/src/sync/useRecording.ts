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
  detach: () => void;
  playPause: () => void;
  /** Marks the recording's current moment as the score's current moment. */
  mark: (scoreSeconds: number) => void;
  /** Removes the mark nearest where the recording is now. */
  unmark: () => void;
  clearMarks: () => void;
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
  const audio = useRef<HTMLAudioElement | null>(null);
  const live = useRef(deps);
  live.current = deps;

  const alignment = deps.saved;

  // Revoked when the file changes or the hook goes away: an object URL pins its blob in
  // memory for the life of the document, and a user who tries four recordings would be
  // holding all four.
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const attach = useCallback((file: File) => {
    setUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
    setFileName(file.name);
    setSeconds(0);
    setPlaying(false);
  }, []);

  const detach = useCallback(() => {
    audio.current?.pause();
    setUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setFileName(null);
    setPlaying(false);
    setSeconds(0);
    live.current.setSynthMuted(false);
  }, []);

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

  const clearMarks = useCallback(() => {
    live.current.onAlignmentChange(alignmentOf([]));
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
    playing,
    seconds,
    duration,
    alignment,
    suspects,
    speed,
    attach,
    detach,
    playPause,
    mark,
    unmark,
    clearMarks,
    seekToScore,
    ref,
    events,
  };
}
