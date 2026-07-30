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
  timeline,
} from "@cubscore/core";
import { fromAlphaTab, parseMidi, toMidi } from "@cubscore/formats";

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
      timingTex(tex: string): Promise<TimingResult>;
      timingBytes(bytes: number[]): Promise<TimingResult>;
      midiTex(tex: string): Promise<MidiCompareResult>;
      midiBytes(bytes: number[]): Promise<MidiCompareResult>;
    };
  }
}

/**
 * alphaTab's playback length against our own timeline's.
 *
 * The timeline in @cubscore/core claims to line up with alphaTab's clock, and
 * that claim carries the fretboard reader: a note placed by our seconds against a
 * cursor driven by alphaTab's would drift visibly. The honest way to check it is
 * against what alphaTab actually plays, so `alphaTabMs` is measured by
 * synthesizing the score to its end rather than by re-deriving it from the model.
 */
export interface TimingResult {
  ok: boolean;
  error?: string;
  alphaTabMs?: number;
  coreMs?: number;
  notes?: number;
  /** Diagnostics, so a disagreement says which of the two inputs is off. */
  writtenBars?: number;
  playedBars?: number;
  tempo?: number;
}

/**
 * Our MIDI export against alphaTab's, for the same score.
 *
 * The unit tests grade our writer against our own reader, which proves the pair
 * agrees and cannot catch a mistake both halves make. alphaTab writes MIDI too, so
 * this reads *its* file with *our* parser and compares — which grades the writer
 * against an independent implementation and the parser against an independent
 * writer at the same time. Both directions in one measurement.
 */
export interface MidiCompareResult {
  ok: boolean;
  error?: string;
  /** Note counts, and pitch multisets so a wrong tuning shows up when counts match. */
  ours?: { notes: number; ticksPerQuarter: number; lastTick: number; pitches: number[] };
  theirs?: { notes: number; ticksPerQuarter: number; lastTick: number; pitches: number[] };
  /** Notes we wrote that alphaTab did not, and the reverse, as pitch counts. */
  missing?: string[];
  extra?: string[];
  /** Channel-10 note counts on both sides, which grades the drum-voice mapping. */
  percussion?: { ours: number; theirs: number };
  drumsMissing?: string[];
  unsupported?: string[];
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
  // Percussion is excluded from the *round trip* comparison because the trip goes
  // through alphaTex, which does not carry drum tracks — see toAlphaTex for the
  // measurement behind that. The model does carry them, and `pnpm midi` is where
  // that is graded, against alphaTab's own channel-10 notes.
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

/** Synthesizes to the end — no cap — so `ms` is alphaTab's whole track. */
async function timing(trigger: () => void): Promise<TimingResult> {
  const loaded = await run(trigger);
  if (!loaded.ok) return { ok: false, error: loaded.error ?? "score failed to load" };
  const source = api.score;
  if (!source) return { ok: false, error: "no score after load" };

  const core = fromAlphaTab(source).score;
  const line = timeline(core);

  const options = new alphaTab.synth.AudioExportOptions();
  options.soundFonts = [await soundFont()];
  options.sampleRate = 44100;
  options.metronomeVolume = 0;
  const exporter = await api.exportAudio(options);
  try {
    // Counted in samples, not read off chunk.currentTime. currentTime advances
    // one chunk at a time, so with 1000ms chunks every score's length was a
    // whole number of seconds and half the corpus looked like it disagreed by
    // exactly 1000ms. Samples are exact and cost nothing extra.
    let samples = 0;
    for (;;) {
      const chunk = await exporter.render(1000);
      if (!chunk) break;
      samples += chunk.samples.length;
    }
    const CHANNELS = 2;
    return {
      ok: true,
      alphaTabMs: Math.round((samples / CHANNELS / options.sampleRate) * 1000),
      coreMs: Math.round(line.durationSeconds * 1000),
      notes: line.notes.length,
      writtenBars: source.masterBars.length,
      playedBars: line.bars.length,
      tempo: core.tracks[0]?.bars[0]?.tempoBpm ?? 0,
    };
  } finally {
    exporter.destroy();
  }
}

/**
 * A comparable summary of one file's note content.
 *
 * Positions are in forty-eighths of a quarter note, so two files with different
 * divisions compare directly. The note list is passed in rather than taken from
 * the parse, because the comparison is over *pitched* content: percussion is
 * dropped by our importer on purpose, and a length taken from the whole file while
 * the count came from the pitched notes is the two halves of one comparison
 * disagreeing about what is being compared — which is how a percussion-only file
 * came out as "0 notes off, 8 quarters short".
 */
function summarise(parsed: ReturnType<typeof parseMidi>, notes: ReturnType<typeof parseMidi>["notes"]) {
  const toFortyEighths = (tick: number) => Math.round((tick / parsed.ticksPerQuarter) * 48);
  return {
    notes: notes.length,
    ticksPerQuarter: parsed.ticksPerQuarter,
    lastTick: toFortyEighths(notes.reduce((max, n) => Math.max(max, n.startTicks + n.durationTicks), 0)),
    pitches: notes.map((n) => n.key).sort((a, b) => a - b),
  };
}

/** Multiset difference, reported as "pitch xN", so a near-miss is readable. */
function pitchDiff(a: number[], b: number[]): string[] {
  const counts = new Map<number, number>();
  for (const p of a) counts.set(p, (counts.get(p) ?? 0) + 1);
  for (const p of b) counts.set(p, (counts.get(p) ?? 0) - 1);
  return [...counts.entries()]
    .filter(([, n]) => n > 0)
    .sort(([x], [y]) => x - y)
    .map(([pitch, n]) => `${pitch}x${n}`);
}

async function compareMidi(trigger: () => void): Promise<MidiCompareResult> {
  const loaded = await run(trigger);
  if (!loaded.ok) return { ok: false, error: loaded.error ?? "score failed to load" };
  const source = api.score;
  if (!source) return { ok: false, error: "no score after load" };

  // alphaTab's own MIDI for this score, written to bytes the same way its export
  // does. SMF1 mode, because that is what a file on disk has to be.
  const theirFile = new alphaTab.midi.MidiFile();
  theirFile.format = alphaTab.midi.MidiFileFormat.MultiTrack;
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(theirFile, true);
  const generator = new alphaTab.midi.MidiFileGenerator(source, api.settings, handler);
  generator.generate();
  const theirBytes = theirFile.toBinary();

  const core = fromAlphaTab(source).score;
  const mine = toMidi(core);

  try {
    const oursParsed = parseMidi(mine.bytes);
    const theirsParsed = parseMidi(theirBytes);
    // Percussion is compared now rather than excluded. It used to be filtered out
    // because our importer dropped drum tracks, so their channel-10 notes counted
    // as our drift and reported a known gap twice. Now that drums are carried, this
    // comparison is what grades the drum-voice mapping: alphaTab reports a
    // percussion articulation index, we write it as a channel-10 key, and if that
    // number is not the General MIDI drum number the pitch multisets diverge here.
    const ourDrums = oursParsed.notes.filter((n) => n.channel === 9);
    const theirDrums = theirsParsed.notes.filter((n) => n.channel === 9);
    return {
      ok: true,
      ours: summarise(oursParsed, oursParsed.notes),
      theirs: summarise(theirsParsed, theirsParsed.notes),
      percussion: { ours: ourDrums.length, theirs: theirDrums.length },
      drumsMissing: pitchDiff(theirDrums.map((n) => n.key), ourDrums.map((n) => n.key)),
      missing: pitchDiff(theirsParsed.notes.map((n) => n.key), oursParsed.notes.map((n) => n.key)),
      extra: pitchDiff(oursParsed.notes.map((n) => n.key), theirsParsed.notes.map((n) => n.key)),
      unsupported: mine.report.unsupported,
    };
  } catch (e) {
    return { ok: false, error: `parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

window.cubscore = {
  loadTex: (tex) => run(() => api.tex(tex)),
  midiTex: (tex) => compareMidi(() => api.tex(tex)),
  midiBytes: (bytes) => compareMidi(() => api.load(new Uint8Array(bytes))),
  timingTex: (tex) => timing(() => api.tex(tex)),
  timingBytes: (bytes) => timing(() => api.load(new Uint8Array(bytes))),
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
