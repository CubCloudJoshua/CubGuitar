import { useCallback, useEffect, useRef, useState } from "react";
import * as alphaTab from "@coderline/alphatab";
import { notationColors, stageNotationColors } from "./theme";

export interface TrackState {
  index: number;
  name: string;
  muted: boolean;
  solo: boolean;
  /** 0..1 */
  volume: number;
}

export interface ScoreInfo {
  title: string;
  artist: string;
  barCount: number;
}

export interface LoopRange {
  startTick: number;
  endTick: number;
}

export interface Position {
  currentTime: number;
  endTime: number;
}

/**
 * Where a bar was engraved, in the notation's own pixel coordinates.
 *
 * This is what lets controls sit on the music instead of in a panel above it:
 * an overlay positioned from these can never drift from the bar it labels,
 * because it is measured from the same render.
 */
export interface BarBox {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Where each beat's notes are centred, in the same coordinates. alphaTab calls
   * this onNotesX and defines it as where a playback cursor belongs at that
   * beat, which is exactly where someone else's caret belongs too.
   */
  beats: number[];
}

/**
 * The vertical extent of one engraved staff system.
 *
 * Only the vertical extent, because the one thing that reads these — the join
 * sequence, which materializes a score system by system — draws bands the full
 * width of the surface. A horizontal bound would have to include the clef and
 * key signature at the left edge, which sit outside every bar's own bounds.
 */
export interface SystemBox {
  y: number;
  height: number;
}

/** Speed trainer: each completed loop pass bumps speed by `step` up to `max`. */
export interface RampConfig {
  enabled: boolean;
  step: number;
  max: number;
}

const DEFAULT_RAMP: RampConfig = { enabled: false, step: 0.05, max: 1 };

/**
 * The engrave cost, in milliseconds, above which a keystroke is worth coalescing.
 *
 * The same 100ms as `tools/edit-perf.mjs`, and for the same reason: under it a keystroke
 * feels like typing, so delaying one to save an engrave trades something a user notices
 * for something they do not. Over it the editor is already visibly behind, and a wait no
 * longer than the engrave it skips is invisible next to the engrave.
 */
const COALESCE_ABOVE_MS = 100;

/** Longest a keystroke is ever held back, however expensive engraving has become. */
const COALESCE_CAP_MS = 300;

const SOUND_FONT = "/soundfont/sonivox.sf3";
/**
 * Players that have already asked for the soundfont.
 *
 * Per player rather than per page: a module-level boolean would mean a remounted
 * renderer never got one, and the failure mode is silent playback rather than an
 * error, which is the worst kind. Weak so a discarded player is collectable.
 */
const soundFontArmed = new WeakSet<alphaTab.AlphaTabApi>();

/**
 * Fetches the soundfont once the score is on screen.
 *
 * Not at boot, because a cold load was four roughly equal quarters — the notation
 * font, the renderer, the player's worker and the soundfont, 1,263 KB between them —
 * and the soundfont is the only one of the four that nothing on screen is waiting
 * for. Reading a tab needs the first three; hearing it needs all four, and hearing it
 * cannot happen before the score has rendered and a human has reached for the
 * spacebar.
 *
 * On an idle callback so it does not compete with the layout work that follows a
 * render, with a timeout so a busy page still gets it promptly: a soundfont that
 * arrives after the user presses play is a worse bug than the one this fixes.
 */
function armSoundFont(api: alphaTab.AlphaTabApi): void {
  if (soundFontArmed.has(api)) return;
  soundFontArmed.add(api);
  const load = () => api.loadSoundFont(SOUND_FONT, false);
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (idle) idle(load, { timeout: 500 });
  else setTimeout(load, 0);
}

export function useAlphaTab() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  // Ramp settings are read inside an alphaTab event handler that is bound
  // once, so they live in a ref as well as state.
  const rampRef = useRef<RampConfig>(DEFAULT_RAMP);
  /** Latest track length, for seek clamping outside a render. */
  const endTimeRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [rendering, setRendering] = useState(false);
  /**
   * The tex waiting to be engraved, whether a render is in flight, and a handle on the
   * drain function for the render-finished handler to call.
   *
   * Refs rather than state on all three: the coalescing decision happens inside a
   * callback and inside an event handler registered once at mount, both of which need
   * the value as of *now* rather than as of the last React render, and neither should
   * cause one. The handler cannot close over `drainRender` directly — it is registered
   * in a mount effect and would capture the first one forever.
   */
  const pendingTex = useRef<string | null>(null);
  const renderInFlight = useRef(false);
  const drainRenderRef = useRef<(() => void) | null>(null);
  /**
   * How long a whole engrave took, when the current one began, and the timer waiting to
   * start the next.
   *
   * A whole engrave, deliberately, and not the render phase alphaTab reports: `api.tex()`
   * blocks the calling thread for most of the cost before it fires renderStarted at all —
   * 856ms of blocked main thread ahead of an 895ms render phase, on a 274-bar score in one
   * sample. (Not our serialization: STANDALONE.md §3 measured that at ~10ms.) Sizing the
   * coalescing delay off the render phase alone therefore underestimated the cost it is
   * protecting against by more than half. The clock starts when the document is handed
   * over and stops when the pixels are up, because that is the interval a user waits.
   */
  const lastEngraveMs = useRef(0);
  const engraveStarted = useRef(0);
  const renderTimer = useRef<number | null>(null);
  /**
   * Engrave passes since mount.
   *
   * Reported to the DOM so the perf gate can count them. Coalescing is a claim about how
   * many times a burst of typing lays the score out, and a wall-clock burst number cannot
   * check it: on a large score the same six keystrokes measured 4.4s and 5.3s on
   * consecutive runs, which is noise wide enough to hide the whole effect. The count is
   * exact. See `tools/edit-perf.mjs`, ENGRAVES.
   */
  const [engraves, setEngraves] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [score, setScore] = useState<ScoreInfo | null>(null);
  const [tracks, setTracks] = useState<TrackState[]>([]);
  const [position, setPosition] = useState<Position>({ currentTime: 0, endTime: 0 });
  const [loop, setLoop] = useState(false);
  const [loopRange, setLoopRange] = useState<LoopRange | null>(null);
  const [speed, setSpeedState] = useState(1);
  const [metronome, setMetronomeState] = useState(false);
  const [countIn, setCountInState] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [ramp, setRampState] = useState<RampConfig>(DEFAULT_RAMP);
  const [barBoxes, setBarBoxes] = useState<BarBox[]>([]);
  const [systemBoxes, setSystemBoxes] = useState<SystemBox[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const api = new alphaTab.AlphaTabApi(host, {
      core: {
        // The alphaTab vite plugin emits assets at the site root rather
        // than beside the JS chunks, which is where alphaTab looks by default.
        fontDirectory: "/font/",
      },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledAutomatic,
        // No soundFont here on purpose. Stating it in the initial settings makes
        // alphaTab fetch it during boot, and measurement said that cost more than it
        // looked: of 1,263 KB on a cold load, 296 KB was a soundfont competing for
        // bandwidth with the font and the renderer needed to put the score on screen.
        // Nobody can press play before the score exists, so it is loaded once the
        // first render is done. See `armSoundFont` below.
        scrollMode: alphaTab.ScrollMode.Continuous,
        enableCursor: true,
        enableUserInteraction: true,
        enableAnimatedBeatCursor: true,
      },
      display: { resources: notationColors },
    } as alphaTab.json.SettingsJson);
    apiRef.current = api;

    api.scoreLoaded.on((s) => {
      setError(null);
      setScore({
        title: s.title || "Untitled",
        artist: s.artist || "",
        barCount: s.masterBars.length,
      });
      setTracks(
        s.tracks.map((t, i) => ({
          index: i,
          name: t.name || `Track ${i + 1}`,
          muted: false,
          solo: false,
          volume: 1,
        })),
      );
      // A new score clears any selection carried over from the previous one.
      setLoopRange(null);
      // alphaTab renders only the first track by default; a multitrack
      // editor needs all of them on screen.
      if (s.tracks.length > 1) api.renderTracks(s.tracks);
    });

    api.renderStarted.on(() => {
      setRendering(true);
      setEngraves((n) => n + 1);
      // Marks this pass busy even when nothing here started it. Zoom, the stage palette
      // and a file load all render through alphaTab directly, and a queue that only knew
      // about its own passes would hand the engraver a second document mid-layout. The
      // diagnostic that found this showed four keystrokes in a row deciding the engraver
      // was idle while a render was still half a second from finishing.
      renderInFlight.current = true;
      if (engraveStarted.current === 0) engraveStarted.current = performance.now();
      // The old geometry describes a layout that is being replaced. Keeping it
      // would leave overlays pinned to bars that have moved.
      setBarBoxes([]);
      setSystemBoxes([]);
    });
    api.postRenderFinished.on(() => {
      // Provisional. The drain below turns it back on if there is more to draw, and React
      // batches both into one commit, so a burst never flickers the indicator between
      // passes — it stays on from the first keystroke until the last one is on screen.
      setRendering(false);
      renderInFlight.current = false;
      if (engraveStarted.current > 0) lastEngraveMs.current = performance.now() - engraveStarted.current;
      engraveStarted.current = 0;
      // Whatever the user typed while this was laying out gets drawn now, in one pass.
      drainRenderRef.current?.();
      armSoundFont(api);
      const lookup = api.renderer.boundsLookup;
      if (!lookup) return;
      // One entry per master bar. A bar that appears in several staff systems
      // cannot happen, but a multi-staff score reports the bar once per system
      // with bounds spanning every staff, which is what an overlay wants.
      const boxes: BarBox[] = [];
      for (const system of lookup.staffSystems) {
        for (const bar of system.bars) {
          const b = bar.visualBounds;
          boxes.push({
            index: bar.index,
            x: b.x,
            y: b.y,
            width: b.w,
            height: b.h,
            // The first staff's beats. A master bar holds one BarBounds per
            // staff and they share a rhythm, so any of them gives the same x
            // positions; the visual bounds above already span every staff.
            beats: (system.bars.length > 0 ? bar.bars[0]?.beats ?? [] : []).map((beat) => beat.onNotesX),
          });
        }
      }
      setBarBoxes(boxes);
      // realBounds rather than visualBounds: the visual bounds stop at the
      // outermost staff line, so bands built from them left an unlifted stripe of
      // background between every pair of systems. The real bounds include the
      // space the layout reserves around a system, so consecutive bands meet and
      // the pass reads as one curtain instead of stripes.
      setSystemBoxes(
        lookup.staffSystems.map((system) => ({ y: system.realBounds.y, height: system.realBounds.h })),
      );
    });
    api.playerReady.on(() => setReady(true));
    api.error.on((e) => setError(e.message || String(e)));

    api.playerStateChanged.on((e) => {
      setPlaying(e.state === alphaTab.synth.PlayerState.Playing);
    });

    api.playerPositionChanged.on((e) => {
      endTimeRef.current = e.endTime;
      setPosition({ currentTime: e.currentTime, endTime: e.endTime });
    });

    api.playbackRangeChanged.on((e) => {
      const r = e.playbackRange;
      setLoopRange(r ? { startTick: r.startTick, endTick: r.endTick } : null);
    });

    // Speed trainer: alphaTab fires playerFinished at the end of each pass,
    // including each loop repetition.
    api.playerFinished.on(() => {
      const cfg = rampRef.current;
      if (!cfg.enabled) return;
      const current = apiRef.current?.playbackSpeed ?? 1;
      const next = Math.min(cfg.max, Math.round((current + cfg.step) * 100) / 100);
      if (next !== current && apiRef.current) {
        apiRef.current.playbackSpeed = next;
        setSpeedState(next);
      }
    });

    return () => {
      apiRef.current = null;
      api.destroy();
    };
  }, []);

  /**
   * Starts the newest pending render, if the engraver is free.
   *
   * Called from `loadTex` and again when a render finishes, which is what makes this a
   * coalescing queue of depth one rather than a debounce: the latest document always
   * gets engraved, and every superseded one in between is dropped without ever being
   * laid out.
   */
  const drainRender = useCallback(() => {
    if (renderInFlight.current) {
      // Comes back on its own from postRenderFinished; this is only the watchdog. The
      // in-flight flag is set from renderStarted, which alphaTab fires for renders nothing
      // here asked for, and a pass whose finish event never arrives would otherwise wedge
      // the editor for good — no keystroke would ever be drawn again. Polling instead
      // costs one no-op timer per engrave and cannot deadlock.
      if (renderTimer.current === null && pendingTex.current !== null) {
        renderTimer.current = window.setTimeout(() => {
          renderTimer.current = null;
          drainRenderRef.current?.();
        }, COALESCE_CAP_MS);
      }
      return;
    }
    const next = pendingTex.current;
    if (next === null) return;
    pendingTex.current = null;
    if (renderTimer.current !== null) {
      window.clearTimeout(renderTimer.current);
      renderTimer.current = null;
    }
    renderInFlight.current = true;
    // Before the call, not inside renderStarted: `tex()` does most of its work on the
    // caller's thread and only then fires renderStarted, so a clock started there misses
    // the larger half.
    engraveStarted.current = performance.now();
    // Said here rather than left to renderStarted, for the same reason. The call blocks this
    // thread and renderStarted does not fire until it returns, so an indicator driven by
    // that event alone went dark for the whole time the page was frozen — the app looked
    // idle at exactly the moment it was least responsive. Two things were reading that lie:
    // a user deciding whether their keystroke had registered, and `settled()` in the perf
    // tool, which called an engrave finished while its expensive half had not begun.
    setRendering(true);
    apiRef.current?.tex(next);
  }, []);

  // Reassigned every React render so the mount-effect handler always calls the current
  // one. It cannot close over `drainRender` itself; it would hold the first forever.
  drainRenderRef.current = drainRender;

  /**
   * Hands the engraver a document, coalescing bursts.
   *
   * alphaTab re-parses and re-lays out the whole score on every call, and on a real song
   * that is a second and a half or more (measured: `pnpm editperf`, and STANDALONE.md §3
   * on why the floor is alphaTab's rather than ours). Issuing one call per keystroke
   * therefore bought one full engrave per keystroke, and typing six frets on a 274-bar
   * score cost 7.6 seconds — the editor falling further behind the longer you typed, which
   * is the complaint this fixes.
   *
   * Coalescing does not make one engrave faster; nothing short of owning the engraver
   * will. What it fixes is the pile-up: six frets now cost three engraves on the 274-bar
   * score and one on the 166-bar score, against five and six without it, because every
   * state the user typed *through* is superseded before it is drawn. A single keystroke is
   * slower by the wait, on purpose — that is the trade, and it is only ever taken on a
   * score already past the point of feeling immediate. The ENGRAVES column exists because
   * the per-keystroke number cannot see any of this, and because the wall-clock burst
   * number is too noisy on a large score to see it either.
   */
  const loadTex = useCallback(
    (tex: string) => {
      pendingTex.current = tex;
      // On from the moment a keystroke is accepted, not from the moment engraving starts.
      // The gap between the two is the coalescing wait, and an indicator that was dark
      // through it told the user their keystroke had not registered — the one thing the
      // wait must not be allowed to imply. It also made the perf tool call a keystroke
      // finished during the wait, which is how a 173ms median came out of a score that
      // takes a second and a half to engrave.
      setRendering(true);
      if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
      /**
       * How long to hold a keystroke back, decided by what engraving currently costs.
       *
       * Coalescing on "is a render in flight" is not enough on its own, and measuring
       * showed why: `api.tex()` blocks the main thread, so keystrokes typed during an
       * engrave are not delivered until it is over. They arrive one at a
       * time *between* passes, never during one, and an in-flight check has nothing to
       * merge. Six frets on a 274-bar score therefore still cost six engraves.
       *
       * So the wait is real, but it exists only where it is free. Under
       * COALESCE_ABOVE_MS the editor already answers a keystroke faster than a person can
       * notice and nothing is held back at all — the four-bar case engraves in about
       * thirty milliseconds and types straight through. Over it the user is watching a
       * spinner either way, and a fraction of a second of that spinner spent gathering the
       * rest of the phrase is invisible next to the engraves it removes. One rule, no
       * arbitrary threshold: the number that decides it is the number the perf gate fails on.
       */
      const cost = lastEngraveMs.current;
      if (cost <= COALESCE_ABOVE_MS) {
        renderTimer.current = null;
        drainRender();
        return;
      }
      // One engrave's worth of wait, capped. Not a fraction of one: a keystroke that lands
      // inside the time the last engrave took would have been superseded before it was
      // drawn anyway, so waiting exactly that long is the window in which coalescing is
      // free. A quarter of it was tried first and left a 166-bar score merging one pair out
      // of six, because the timer kept firing while the user was still typing.
      renderTimer.current = window.setTimeout(() => {
        renderTimer.current = null;
        drainRender();
      }, Math.min(COALESCE_CAP_MS, Math.round(cost)));
    },
    [drainRender],
  );

  const loadBytes = useCallback((buffer: ArrayBuffer) => {
    // Drops any queued tex. It belongs to the document being left, and draining it after
    // this file finishes rendering would engrave the old score over the new one — the
    // hazard a coalescing queue introduces and the reason the queue is cleared here
    // rather than only filled in `loadTex`.
    pendingTex.current = null;
    if (renderTimer.current !== null) {
      window.clearTimeout(renderTimer.current);
      renderTimer.current = null;
    }
    apiRef.current?.load(new Uint8Array(buffer));
  }, []);

  const loadFile = useCallback(async (file: File) => {
    loadBytes(await file.arrayBuffer());
  }, [loadBytes]);

  const playPause = useCallback(() => apiRef.current?.playPause(), []);
  const stop = useCallback(() => apiRef.current?.stop(), []);

  const setSpeed = useCallback((value: number) => {
    if (!apiRef.current) return;
    apiRef.current.playbackSpeed = value;
    setSpeedState(value);
  }, []);

  const toggleLoop = useCallback(() => {
    setLoop((prev) => {
      const next = !prev;
      if (apiRef.current) apiRef.current.isLooping = next;
      return next;
    });
  }, []);

  const clearLoopRange = useCallback(() => {
    if (apiRef.current) apiRef.current.playbackRange = null;
    setLoopRange(null);
  }, []);

  /**
   * Loops a tick range and moves the playhead to its start.
   *
   * The programmatic sibling of drag-to-select: the practice plan uses it to turn
   * "work on bar 7" into a loop without asking the user to find bar 7 by hand. Looping
   * is switched on with it, because a range that plays once is a seek with extra steps.
   *
   * `loopRange` state is deliberately NOT set here. It updates from alphaTab's own
   * playbackRangeChanged event, same as a drag selection, so the indicator reflects
   * what the player will actually do rather than what this function meant to do — a
   * version that set the state itself showed a loop that did not exist when the
   * assignment was dropped, and the e2e mutation run is how that was caught.
   */
  const setLoopBars = useCallback((startTick: number, endTick: number) => {
    const api = apiRef.current;
    if (!api) return;
    api.playbackRange = { startTick, endTick } as never;
    api.isLooping = true;
    api.tickPosition = startTick;
    setLoop(true);
  }, []);

  const toggleMetronome = useCallback(() => {
    setMetronomeState((prev) => {
      const next = !prev;
      if (apiRef.current) apiRef.current.metronomeVolume = next ? 1 : 0;
      return next;
    });
  }, []);

  const toggleCountIn = useCallback(() => {
    setCountInState((prev) => {
      const next = !prev;
      if (apiRef.current) apiRef.current.countInVolume = next ? 1 : 0;
      return next;
    });
  }, []);

  const setZoom = useCallback((value: number) => {
    const api = apiRef.current;
    if (!api) return;
    api.settings.display.scale = value;
    api.updateSettings();
    api.render();
    setZoomState(value);
  }, []);

  /** Jumps to a fraction of the song, for scrubbing the transport. */
  const seekFraction = useCallback((fraction: number) => {
    const api = apiRef.current;
    const end = endTimeRef.current;
    if (!api || end <= 0) return;
    api.timePosition = Math.max(0, Math.min(1, fraction)) * (end - 1);
  }, []);

  /**
   * Absolute seek, in seconds.
   *
   * Separate from `seekSeconds`, which is a nudge. A shared transport needs to put
   * a follower's playhead at a stated position rather than move it by an amount:
   * "go to 41.2 seconds" survives a dropped message, "skip forward five" does not.
   */
  const seekTo = useCallback((seconds: number) => {
    const api = apiRef.current;
    if (!api) return;
    const end = endTimeRef.current;
    const ms = Math.max(0, seconds * 1000);
    api.timePosition = end > 0 ? Math.min(ms, end - 1) : ms;
  }, []);

  /**
   * The playhead now, in seconds, without waiting for a render.
   *
   * The `position` state is a render away from the truth, and a drift check that
   * compares a stale local position against a fresh remote one measures the render
   * loop rather than the drift.
   */
  const positionSeconds = useCallback(() => (apiRef.current?.timePosition ?? 0) / 1000, []);

  /** Nudges playback, for the coarse seeking a player wants mid-song. */
  /**
   * Silences the synth without touching the transport.
   *
   * For a recording playing with the score: the record is making the sound, and the
   * synth playing the same music a beat out is the worst possible result. Master volume
   * rather than muting every track, so the user's own per-track mutes are untouched and
   * come back exactly as they were.
   */
  const setSynthMuted = useCallback((muted: boolean) => {
    const api = apiRef.current;
    if (api) api.masterVolume = muted ? 0 : 1;
  }, []);

  const seekSeconds = useCallback((delta: number) => {
    const api = apiRef.current;
    if (!api) return;
    const end = endTimeRef.current;
    const next = api.timePosition + delta * 1000;
    // Clamped at both ends: seeking past the end silently stops playback, which
    // reads as the app having crashed when you only meant to skip forward.
    api.timePosition = Math.max(0, end > 0 ? Math.min(next, end - 1) : next);
  }, []);

  // There is deliberately no setScrollElement here. alphaTab resolves a scroll
  // container the first time it needs one and caches it for the renderer's
  // lifetime with nothing to invalidate it, so assigning
  // settings.player.scrollElement afterwards is accepted and then ignored —
  // it appeared to work or not depending on whether anything had scrolled yet.
  // Perform mode follows the playhead itself; see perform/PerformMode.tsx.

  /**
   * Swaps the engraving palette. Perform mode is read from across a room under
   * stage light, so the notation has to be brighter there than the palette
   * tuned for arm's length in a dark room (UI-DESIGN.md, Perform).
   */
  const setStageEngraving = useCallback((on: boolean) => {
    const api = apiRef.current;
    if (!api) return;
    // Through fillFromJson, not by assigning onto settings.display.resources:
    // those fields are alphaTab Color instances, and writing strings into them
    // is accepted silently and then ignored by the renderer.
    api.settings.fillFromJson({
      display: { resources: on ? stageNotationColors : notationColors },
    } as alphaTab.json.SettingsJson);
    api.updateSettings();
    api.render();
  }, []);

  const setRamp = useCallback((next: RampConfig) => {
    rampRef.current = next;
    setRampState(next);
  }, []);

  const setTrackMuted = useCallback((index: number, muted: boolean) => {
    const api = apiRef.current;
    const track = api?.score?.tracks[index];
    if (!api || !track) return;
    api.changeTrackMute([track], muted);
    setTracks((prev) => prev.map((t) => (t.index === index ? { ...t, muted } : t)));
  }, []);

  const setTrackSolo = useCallback((index: number, solo: boolean) => {
    const api = apiRef.current;
    const track = api?.score?.tracks[index];
    if (!api || !track) return;
    api.changeTrackSolo([track], solo);
    setTracks((prev) => prev.map((t) => (t.index === index ? { ...t, solo } : t)));
  }, []);

  const setTrackVolume = useCallback((index: number, volume: number) => {
    const api = apiRef.current;
    const track = api?.score?.tracks[index];
    if (!api || !track) return;
    api.changeTrackVolume([track], volume);
    setTracks((prev) => prev.map((t) => (t.index === index ? { ...t, volume } : t)));
  }, []);

  /** Live alphaTab handles, for callers that need the model (export, library). */
  const getApi = useCallback(() => apiRef.current, []);
  const getScore = useCallback(() => apiRef.current?.score ?? null, []);

  return {
    hostRef,
    getApi,
    getScore,
    ready,
    rendering,
    engraves,
    playing,
    score,
    tracks,
    position,
    loop,
    loopRange,
    speed,
    metronome,
    countIn,
    zoom,
    ramp,
    barBoxes,
    systemBoxes,
    error,
    loadTex,
    loadBytes,
    loadFile,
    playPause,
    stop,
    setSpeed,
    toggleLoop,
    clearLoopRange,
    setLoopBars,
    toggleMetronome,
    toggleCountIn,
    setZoom,
    setStageEngraving,
    seekSeconds,
    setSynthMuted,
    seekFraction,
    seekTo,
    positionSeconds,
    setRamp,
    setTrackMuted,
    setTrackSolo,
    setTrackVolume,
  };
}

export type AlphaTabController = ReturnType<typeof useAlphaTab>;
