/**
 * Headless corpus harness.
 *
 * Loaded by corpus.html and driven by tools/corpus-check.mjs. Exposes a
 * global that loads a score (alphaTex or Guitar Pro bytes), waits for a
 * full render pass, and reports what came back. Rendering is included on
 * purpose: layout is where importer bugs actually surface.
 */
import * as alphaTab from "@coderline/alphatab";
import {
  applyBatch,
  createNote,
  createScore,
  duration,
  nextId,
  pitchAt,
  toAlphaTex,
  type Op,
  type OpKind,
  type Score,
} from "@cubscore/core";
import { fromAlphaTab } from "@cubscore/formats";

export interface LoadResult {
  ok: boolean;
  error?: string;
  title?: string;
  artist?: string;
  tracks?: number;
  bars?: number;
  notes?: number;
  tempo?: number;
  renderMs?: number;
}

/**
 * Fidelity of alphaTab -> core -> alphaTex -> alphaTab. Counts on both sides
 * are what tell us whether the importer is safe to build editing on.
 */
export interface RoundTripResult {
  ok: boolean;
  error?: string;
  original?: Stats;
  converted?: Stats;
  /** Pitches present before but not after (or vice versa), as MIDI numbers. */
  pitchDrift?: { missing: number[]; added: number[] };
  unsupported?: string[];
  tex?: string;
}

/**
 * What the synthesizer actually produced.
 *
 * Nobody has ever heard this app: it is developed and tested in headless
 * browsers with no audio device, so every check so far has confirmed that the
 * notation is right and simply assumed the sound was. Rendering the audio to
 * samples is the way to check without ears — and silence, the failure that
 * matters most, is trivially detectable.
 */
export interface AudioResult {
  ok: boolean;
  error?: string;
  /** Milliseconds of audio synthesized. */
  ms?: number;
  sampleRate?: number;
  /** Loudest absolute sample. Silence means no sound came out at all. */
  peak?: number;
  /** Root mean square over everything, so one click cannot pass for music. */
  rms?: number;
  /** Fraction of samples at or past full scale: distortion, not music. */
  clipped?: number;
  /** 100ms windows containing audible signal, and how many there were. */
  audibleWindows?: number;
  windows?: number;
}

declare global {
  interface Window {
    cubscore: {
      loadTex(tex: string): Promise<LoadResult>;
      loadBytes(bytes: number[]): Promise<LoadResult>;
      checkCore(): Promise<LoadResult & { tex: string }>;
      roundTripTex(tex: string): Promise<RoundTripResult>;
      roundTripBytes(bytes: number[]): Promise<RoundTripResult>;
      describeTex(tex: string): Promise<unknown>;
      renderAudioTex(tex: string, maxMs: number): Promise<AudioResult>;
      renderAudioBytes(bytes: number[], maxMs: number): Promise<AudioResult>;
    };
  }
}

const host = document.getElementById("host");
if (!host) throw new Error("corpus harness: #host missing");

const api = new alphaTab.AlphaTabApi(host, {
  core: { fontDirectory: "/font/" },
  // The player is irrelevant to import fidelity and costs seconds per file.
  player: { playerMode: alphaTab.PlayerMode.Disabled },
} as alphaTab.json.SettingsJson);

export interface Stats {
  tracks: number;
  bars: number;
  notes: number;
  /** Sorted MIDI pitches, so a wrong tuning shows up even when counts match. */
  pitches: number[];
}

function collect(score: alphaTab.model.Score, skipPercussion: boolean): Stats {
  const pitches: number[] = [];
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (skipPercussion && staff.isPercussion) continue;
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              // Dead notes are unpitched; GP3 additionally encodes them at
              // open-string-1 (fret -1), so comparing their "pitch" measures
              // a format quirk rather than musical content. Their placement
              // fidelity is covered by fret-preserving serialization.
              if (note.isDead) continue;
              // Harmonics compare by fretted pitch: the model keeps the
              // harmonic flag but not the exact harmonic pitch math, which
              // the importer reports as simplified.
              pitches.push(
                note.harmonicType !== alphaTab.model.HarmonicType.None
                  ? note.realValueWithoutHarmonic
                  : note.realValue,
              );
            }
          }
        }
      }
    }
  }
  pitches.sort((a, b) => a - b);
  return {
    tracks: score.tracks.length,
    bars: score.masterBars.length,
    notes: pitches.length,
    pitches,
  };
}

function countNotes(score: alphaTab.model.Score): number {
  return collect(score, false).notes;
}

/** Multiset difference, so repeated pitches are compared honestly. */
function diffPitches(before: number[], after: number[]) {
  const counts = new Map<number, number>();
  for (const p of before) counts.set(p, (counts.get(p) ?? 0) + 1);
  const added: number[] = [];
  for (const p of after) {
    const n = counts.get(p) ?? 0;
    if (n > 0) counts.set(p, n - 1);
    else added.push(p);
  }
  const missing: number[] = [];
  for (const [pitch, n] of counts) for (let i = 0; i < n; i++) missing.push(pitch);
  return { missing: missing.sort((a, b) => a - b), added: added.sort((a, b) => a - b) };
}

/** Resolves on the first render pass or error after `trigger` runs. */
function run(trigger: () => void): Promise<LoadResult> {
  return new Promise<LoadResult>((resolve) => {
    const started = performance.now();
    let score: alphaTab.model.Score | null = null;
    let settled = false;

    const finish = (result: LoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      api.scoreLoaded.off(onScore);
      api.postRenderFinished.off(onRendered);
      api.error.off(onError);
      resolve(result);
    };

    const onScore = (s: alphaTab.model.Score) => {
      score = s;
    };

    const onRendered = () => {
      if (!score) {
        finish({ ok: false, error: "rendered without a score" });
        return;
      }
      finish({
        ok: true,
        title: score.title,
        artist: score.artist,
        tracks: score.tracks.length,
        bars: score.masterBars.length,
        notes: countNotes(score),
        tempo: score.tempo,
        renderMs: Math.round(performance.now() - started),
      });
    };

    const onError = (e: Error) => finish({ ok: false, error: e.message || String(e) });

    const timer = setTimeout(() => finish({ ok: false, error: "timeout after 30s" }), 30_000);

    api.scoreLoaded.on(onScore);
    api.postRenderFinished.on(onRendered);
    api.error.on(onError);

    try {
      trigger();
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * Round-trips the semantic model through the serializer: build a score with
 * the same ops the editor emits, serialize, and confirm alphaTab parses and
 * renders the result. Guards against serializer regressions breaking editing.
 */
function buildCoreSample(): Score {
  let score = createScore("Core Serializer Check", "CubScore");
  const track = score.tracks[0];
  if (!track) return score;
  const instrument = track.instrument;

  const ops: OpKind[] = [];
  const bar = track.bars[0];
  const voice = bar?.voices[0];
  if (voice) {
    voice.beats.forEach((beat, i) => {
      const fret = [0, 3, 5, 7][i] ?? 0;
      ops.push({
        type: "note.insert",
        beatId: beat.id,
        note: createNote(pitchAt(instrument, 6, fret), 6, fret),
      });
    });
    // Exercise durations, dots, and articulations, not just plain notes.
    const first = voice.beats[0];
    const second = voice.beats[1];
    if (first) ops.push({ type: "beat.setDots", beatId: first.id, dots: 1 });
    if (second) ops.push({ type: "beat.setDuration", beatId: second.id, duration: duration(8) });
  }

  const secondBar = track.bars[1];
  const secondVoice = secondBar?.voices[0];
  const chordBeat = secondVoice?.beats[0];
  if (chordBeat) {
    for (const [string, fret] of [[4, 2], [3, 2], [2, 0]] as const) {
      ops.push({
        type: "note.insert",
        beatId: chordBeat.id,
        note: createNote(pitchAt(instrument, string, fret), string, fret),
      });
    }
  }

  const withArticulation = secondVoice?.beats[1];
  if (withArticulation) {
    const note = createNote(pitchAt(instrument, 3, 7), 3, 7);
    ops.push({ type: "note.insert", beatId: withArticulation.id, note });
    ops.push({ type: "note.addArticulation", noteId: note.id, articulation: "palmMute" });
    ops.push({ type: "note.addArticulation", noteId: note.id, articulation: "vibrato" });
  }

  const asOps: Op[] = ops.map((kind) => ({ id: nextId("o"), author: "check", at: 0, ...kind }));
  score = applyBatch(score, { id: nextId("k"), ops: asOps, label: "core check" });
  return score;
}

async function roundTrip(trigger: () => void): Promise<RoundTripResult> {
  const first = await run(trigger);
  if (!first.ok) return { ok: false, error: first.error ?? "source failed to load" };

  const source = api.score;
  if (!source) return { ok: false, error: "no score after load" };
  // Percussion is deliberately dropped by the importer, so exclude it from the
  // pitch comparison rather than reporting it as drift.
  const original = collect(source, true);
  original.tracks = source.tracks.length;

  let tex: string;
  let unsupported: string[];
  try {
    const converted = fromAlphaTab(source);
    unsupported = converted.report.unsupported;
    tex = toAlphaTex(converted.score);
  } catch (e) {
    return { ok: false, error: `conversion threw: ${e instanceof Error ? e.message : String(e)}`, original };
  }

  const second = await run(() => api.tex(tex));
  if (!second.ok) return { ok: false, error: `reload failed: ${second.error ?? "?"}`, original, tex, unsupported };

  const after = api.score;
  if (!after) return { ok: false, error: "no score after reload", original, tex, unsupported };

  const converted = collect(after, true);
  return {
    ok: true,
    original,
    converted,
    pitchDrift: diffPitches(original.pitches, converted.pitches),
    unsupported,
    tex,
  };
}

/** Fetched once: the soundfont is a few megabytes and every score needs it. */
let soundFontBytes: Uint8Array | null = null;
async function soundFont(): Promise<Uint8Array> {
  if (!soundFontBytes) {
    const response = await fetch("/soundfont/sonivox.sf3");
    if (!response.ok) throw new Error(`soundfont fetch failed (${response.status})`);
    soundFontBytes = new Uint8Array(await response.arrayBuffer());
  }
  return soundFontBytes;
}

/**
 * Synthesizes the loaded score and measures it.
 *
 * The soundfont is passed explicitly rather than relied on: this harness runs
 * with the player disabled (it costs seconds per file and import fidelity does
 * not need it), and alphaTab documents that an exporter with no initialized
 * synthesizer produces audio with nothing audible in it — which would make this
 * check quietly pass on silence, the one thing it exists to catch.
 */
async function renderAudio(trigger: () => void, maxMs: number): Promise<AudioResult> {
  const loaded = await run(trigger);
  if (!loaded.ok) return { ok: false, error: loaded.error ?? "score failed to load" };

  const options = new alphaTab.synth.AudioExportOptions();
  options.soundFonts = [await soundFont()];
  options.sampleRate = 44100;
  options.masterVolume = 1;
  options.metronomeVolume = 0;

  const exporter = await api.exportAudio(options);
  try {
    const CHUNK_MS = 500;
    const WINDOW = 4410; // 100ms at 44.1kHz
    let peak = 0;
    let sumSquares = 0;
    let count = 0;
    let clipped = 0;
    let audibleWindows = 0;
    let windows = 0;
    let windowPeak = 0;
    let windowCount = 0;
    let ms = 0;

    for (;;) {
      const chunk = await exporter.render(CHUNK_MS);
      if (!chunk) break;
      ms = chunk.currentTime;
      for (const sample of chunk.samples) {
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
        if (magnitude >= 1) clipped += 1;
        sumSquares += sample * sample;
        count += 1;
        if (magnitude > windowPeak) windowPeak = magnitude;
        if (++windowCount === WINDOW) {
          windows += 1;
          // A window counts as audible around -60 dBFS, which is quieter than
          // any intended note and louder than dither or a denormal tail.
          if (windowPeak > 0.001) audibleWindows += 1;
          windowPeak = 0;
          windowCount = 0;
        }
      }
      if (ms >= maxMs) break;
    }

    return {
      ok: count > 0,
      ...(count > 0 ? {} : { error: "synthesizer produced no samples" }),
      ms: Math.round(ms),
      sampleRate: options.sampleRate,
      peak,
      rms: count > 0 ? Math.sqrt(sumSquares / count) : 0,
      clipped: count > 0 ? clipped / count : 0,
      audibleWindows,
      windows,
    };
  } finally {
    exporter.destroy();
  }
}

window.cubscore = {
  loadTex: (tex) => run(() => api.tex(tex)),
  renderAudioTex: (tex, maxMs) => renderAudio(() => api.tex(tex), maxMs),
  renderAudioBytes: (bytes, maxMs) => renderAudio(() => api.load(new Uint8Array(bytes)), maxMs),
  // Bytes cross the CDP boundary as a plain array.
  loadBytes: (bytes) => run(() => api.load(new Uint8Array(bytes))),
  roundTripTex: (tex) => roundTrip(() => api.tex(tex)),
  // Bar-level detail, for diagnosing where a round trip drifts.
  describeTex: async (tex) => {
    const result = await run(() => api.tex(tex));
    const score = api.score;
    if (!result.ok || !score) return { ok: false, error: result.error };
    return {
      ok: true,
      tuning: score.tracks[0]?.staves[0]?.stringTuning.tunings ?? [],
      notes: (score.tracks[0]?.staves[0]?.bars ?? []).flatMap((b, bi) =>
        b.voices[0]?.beats.flatMap((beat) =>
          beat.notes.map((n) => ({
            bar: bi,
            string: n.string,
            fret: n.fret,
            pitch: n.realValue,
            dead: n.isDead,
          })),
        ) ?? [],
      ),
      bars: score.masterBars.map((m, i) => ({
        i,
        repeatStart: m.isRepeatStart,
        repeatCount: m.repeatCount,
        beats: score.tracks[0]?.staves[0]?.bars[i]?.voices[0]?.beats.length ?? 0,
      })),
    };
  },
  roundTripBytes: (bytes) => roundTrip(() => api.load(new Uint8Array(bytes))),
  checkCore: async () => {
    const tex = toAlphaTex(buildCoreSample());
    const result = await run(() => api.tex(tex));
    return { ...result, tex };
  },
};
