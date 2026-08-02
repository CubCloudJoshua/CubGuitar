/**
 * The microphone, wired to the score.
 *
 * Everything difficult about this is in core (`pitch.ts`, `listen.ts`), which is the
 * point: what is left here is plumbing, and plumbing is what a browser is good for.
 * This hook opens an input, pulls frames off it, stamps each one with a position in
 * *score* time, and hands them to the same `Listener` the unit tests feed with
 * synthesized audio.
 *
 * Score time rather than wall-clock time is the whole trick. A report compares what
 * was heard against `timeline()`, which is written in seconds from the start of the
 * piece, so a frame's timestamp has to be the playhead's position when that frame's
 * audio happened — not when it arrived, and not what the clock said.
 *
 * Two honest limitations, both surfaced in the UI rather than buried here.
 *
 * The microphone hears the room, which includes CubScore's own playback. Play along
 * through speakers and the app grades itself, cheerfully, at 100%. Headphones, or the
 * metronome alone, are the only way this measures a person.
 *
 * And the path from a string vibrating to a frame arriving carries a latency this
 * cannot fully know: the driver's buffer, the browser's, and the frame window itself.
 * The window is accounted for exactly and `baseLatency` where the browser reports it;
 * what remains is a constant of a few milliseconds to a few tens of them, which
 * shifts the timing number without affecting which notes were played. Worth stating
 * plainly rather than presenting a millisecond figure as if it were calibrated.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  compareToTimeline,
  Listener,
  type ListenReport,
  type PitchReading,
  type Timeline,
} from "@cubscore/core";

/**
 * 2048 samples, which at 44.1kHz is 46ms and holds two periods of a dropped low E.
 *
 * The floor, not a preference: YIN needs two periods of the lowest note it claims to
 * hear, and a 1024-sample window cannot find anything below 86Hz — the bottom of a
 * guitar in standard tuning.
 */
const FFT_SIZE = 2048;

/** How often the report is recomputed. Six times a second reads as live. */
const REPORT_INTERVAL_MS = 160;

/**
 * A jump in the playhead this large starts a new take.
 *
 * Stopping and playing again, seeking, or a loop wrapping round are all the same
 * thing from here: what came before belongs to a previous attempt and grading it
 * together with this one would report a bar as both missed and clean.
 */
const NEW_TAKE_SECONDS = 0.4;

/**
 * How far behind the playhead the grading stops.
 *
 * Nothing ahead of the playhead has been played yet, and grading the whole piece from
 * the first frame opened every take at "0% of 87" and climbed from there — a report
 * that calls you a failure for not having played bar 40 yet. So the comparison is
 * bounded by where the playhead has actually been.
 *
 * Bounded a little further back than that, by two things that both have to have
 * happened before a note can fairly be called missed: the window in which it could
 * still have been played late (`compareToTimeline`'s tolerance, a quarter second) and
 * the few frames the detector spends deciding what pitch an attack was. Grading right
 * up to the playhead paints a bar red a fraction of a second before the note it is
 * complaining about could possibly have arrived.
 */
const GRADE_LAG_SECONDS = 0.35;

export interface ListeningController {
  on: boolean;
  /** Requests the microphone and starts, or stops. Must be called from a gesture. */
  toggle: () => void;
  /** Throws away the current take without releasing the microphone. */
  clear: () => void;
  error: string | null;
  report: ListenReport | null;
  /** The pitch in the newest frame, for a live readout. Null when nothing sounds. */
  current: PitchReading | null;
  /** True once audio has been heard in this take, so the UI can stop saying "waiting". */
  heard: boolean;
}

interface Deps {
  /**
   * Whether listening is offered at all.
   *
   * Turning false releases the device. The microphone must not outlive the surface
   * that shows what it is doing: leaving the editor with the recording indicator lit
   * and nothing on screen accounting for it is alarming, and correctly so.
   */
  enabled: boolean;
  timeline: Timeline;
  /** Which staff is being played. A monophonic pass can only grade one. */
  trackIndex: number;
  /** The playhead, read at the moment a frame is pulled. */
  positionSeconds: () => number;
  playing: boolean;
}

interface Rig {
  ctx: AudioContext;
  stream: MediaStream;
  analyser: AnalyserNode;
  listener: Listener;
  raf: number;
  /** Score time of the last frame pushed, for detecting a new take. */
  lastAt: number;
  lastReport: number;
}

export function useListening(deps: Deps): ListeningController {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ListenReport | null>(null);
  const [current, setCurrent] = useState<PitchReading | null>(null);
  const [heard, setHeard] = useState(false);
  const rig = useRef<Rig | null>(null);
  /**
   * Bumped by every start and every stop, so a start can tell whether it is still
   * wanted by the time the permission prompt has been answered.
   *
   * Opening a microphone is asynchronous and stopping is not. Without this, turning
   * LISTEN on and leaving the editor before the stream arrived ran the teardown first
   * and then stored a live stream behind it: the microphone stayed open, the browser's
   * recording indicator stayed lit, and nothing on screen accounted for either.
   */
  const attempt = useRef(0);

  // The frame loop reads these rather than closing over them, so changing track or
  // editing the score does not have to tear down the microphone.
  const live = useRef(deps);
  live.current = deps;

  const stop = useCallback(() => {
    attempt.current += 1;
    const it = rig.current;
    rig.current = null;
    if (!it) return;
    cancelAnimationFrame(it.raf);
    for (const track of it.stream.getTracks()) track.stop();
    void it.ctx.close().catch(() => undefined);
    setOn(false);
    setCurrent(null);
  }, []);

  const start = useCallback(async () => {
    const mine = (attempt.current += 1);
    setError(null);
    try {
      // All three processors off. They exist to make speech intelligible over a
      // network and each one destroys what this needs: echo cancellation removes
      // whatever it thinks is playback, noise suppression eats the decay of a
      // string, and automatic gain flattens the attack an onset is detected from.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      // Abandoned while the prompt was open. The stream exists and has to be closed
      // here, because nothing else holds a reference to it.
      if (attempt.current !== mine) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const ctx = new AudioContext();
      await ctx.resume().catch(() => undefined);
      if (attempt.current !== mine) {
        for (const track of stream.getTracks()) track.stop();
        void ctx.close().catch(() => undefined);
        return;
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      ctx.createMediaStreamSource(stream).connect(analyser);
      // Not connected to the destination. Routing the microphone to the speakers
      // would feed back through itself the moment anyone turned the volume up.

      const it: Rig = {
        ctx,
        stream,
        analyser,
        listener: new Listener(ctx.sampleRate, {
          // Frames arrive on animation frames, roughly every 16ms, while each holds
          // 46ms of audio — so consecutive frames overlap and one attack shows up in
          // three of them. The holdoff is what keeps that one note.
          onset: { holdoff: 5 },
        }),
        raf: 0,
        lastAt: -Infinity,
        lastReport: 0,
      };
      rig.current = it;
      // Held here rather than on the rig so its type stays exactly what
      // getFloatTimeDomainData wants, and reused rather than reallocated: this runs
      // on every animation frame, and a fresh 8KB buffer sixty times a second is
      // garbage for no reason.
      const frame = new Float32Array(analyser.fftSize);
      setHeard(false);
      setReport(null);
      setOn(true);

      const tick = () => {
        if (rig.current !== it) return;
        it.raf = requestAnimationFrame(tick);
        const { timeline, trackIndex, positionSeconds, playing } = live.current;
        it.analyser.getFloatTimeDomainData(frame);

        // The window ends now and spans the whole buffer, so the audio in it
        // happened, on average, half a window ago. `baseLatency` is what the browser
        // will admit to on top of that.
        const latency = it.ctx.baseLatency || 0;
        const at = positionSeconds() - frame.length / 2 / it.ctx.sampleRate - latency;

        const previous = it.lastAt;
        it.lastAt = at;
        // Nothing to compare the first frame against, and one frame is nothing to lose.
        if (previous === -Infinity) return;

        // Paused time is not score time: pushing while stopped would pile every note
        // played during a pause onto the single instant the playhead is sitting on.
        //
        // Asked of the playhead as well as of the transport, because the two disagree
        // at the start of playback — the flag is React state fed by a player event, and
        // the position is read live from the player. A frame arriving in between would
        // otherwise be thrown away, and it is the frame at the top of the take. Rolling
        // forward by a playback-sized step is the test rather than "moved at all", so
        // that scrubbing while paused, which also moves the playhead, is not mistaken
        // for playing.
        const step = at - previous;
        const rolling = step > 0 && step < NEW_TAKE_SECONDS;
        if (!playing && !rolling) {
          it.listener.flush();
          return;
        }
        // A seek, a stop and restart, or a loop wrapping round: all of them mean what
        // came before belongs to a previous attempt.
        if (at < previous - NEW_TAKE_SECONDS || at > previous + NEW_TAKE_SECONDS) {
          it.listener.reset();
          setHeard(false);
        }
        it.listener.push(frame, at);

        const now = performance.now();
        if (now - it.lastReport < REPORT_INTERVAL_MS) return;
        it.lastReport = now;
        const notes = it.listener.notes();
        setCurrent(it.listener.current);
        if (notes.length > 0) setHeard(true);
        setReport(
          compareToTimeline(timeline, notes, { trackIndex, toSeconds: at - GRADE_LAG_SECONDS }),
        );
      };
      it.raf = requestAnimationFrame(tick);
    } catch (cause) {
      // Denied, or no input device. Either way the user has to be told, because
      // nothing on screen would otherwise change and they would assume it worked.
      // A failure of a start nobody is waiting for should not raise a banner.
      if (attempt.current !== mine) return;
      const message =
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone access was declined. Listening needs it to hear you play."
          : "No microphone available. Listening needs an audio input.";
      setError(message);
      setOn(false);
    }
  }, []);

  const toggle = useCallback(() => {
    if (rig.current) stop();
    else void start();
  }, [start, stop]);

  const clear = useCallback(() => {
    rig.current?.listener.reset();
    setReport(null);
    setHeard(false);
  }, []);

  // Releasing the device on unmount, so the browser's recording indicator goes out
  // when the tab navigates away rather than staying lit until it is closed.
  useEffect(() => stop, [stop]);
  useEffect(() => {
    if (!deps.enabled) stop();
  }, [deps.enabled, stop]);

  return { on, toggle, clear, error, report, current, heard };
}
