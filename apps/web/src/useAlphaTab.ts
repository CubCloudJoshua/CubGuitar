import { useCallback, useEffect, useRef, useState } from "react";
import * as alphaTab from "@coderline/alphatab";
import { notationColors } from "./theme";

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

    api.renderStarted.on(() => setRendering(true));
    api.postRenderFinished.on(() => setRendering(false));
    api.playerReady.on(() => setReady(true));
    api.error.on((e) => setError(e.message || String(e)));

    api.playerStateChanged.on((e) => {
      setPlaying(e.state === alphaTab.synth.PlayerState.Playing);
    });

    api.playerPositionChanged.on((e) => {
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

  const loadFile = useCallback(async (file: File) => {
    const buffer = await file.arrayBuffer();
    apiRef.current?.load(new Uint8Array(buffer));
  }, []);

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

  return {
    hostRef,
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
    error,
    loadTex,
    loadFile,
    playPause,
    stop,
    setSpeed,
    toggleLoop,
    clearLoopRange,
    toggleMetronome,
    toggleCountIn,
    setZoom,
    setRamp,
    setTrackMuted,
    setTrackSolo,
    setTrackVolume,
  };
}

export type AlphaTabController = ReturnType<typeof useAlphaTab>;
