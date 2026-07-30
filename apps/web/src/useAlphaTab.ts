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

/** Speed trainer: each completed loop pass bumps speed by `step` up to `max`. */
export interface RampConfig {
  enabled: boolean;
  step: number;
  max: number;
}

const DEFAULT_RAMP: RampConfig = { enabled: false, step: 0.05, max: 1 };

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
        soundFont: "/soundfont/sonivox.sf3",
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
      // The old geometry describes a layout that is being replaced. Keeping it
      // would leave overlays pinned to bars that have moved.
      setBarBoxes([]);
    });
    api.postRenderFinished.on(() => {
      setRendering(false);
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

  const loadTex = useCallback((tex: string) => {
    apiRef.current?.tex(tex);
  }, []);

  const loadBytes = useCallback((buffer: ArrayBuffer) => {
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

  /** Nudges playback, for the coarse seeking a player wants mid-song. */
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
    error,
    loadTex,
    loadBytes,
    loadFile,
    playPause,
    stop,
    setSpeed,
    toggleLoop,
    clearLoopRange,
    toggleMetronome,
    toggleCountIn,
    setZoom,
    setStageEngraving,
    seekSeconds,
    seekFraction,
    setRamp,
    setTrackMuted,
    setTrackSolo,
    setTrackVolume,
  };
}

export type AlphaTabController = ReturnType<typeof useAlphaTab>;
