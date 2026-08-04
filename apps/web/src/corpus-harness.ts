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
  mergeTies,
  nextId,
  pitchAt,
  quantise,
  toAlphaTex,
  type DetectedNote,
  type Op,
  type OpKind,
  type Score,
  timeline,
} from "@cubscore/core";
import { fromAlphaTab, fromMusicXml, parseMidi, toMidi, toMusicXml } from "@cubscore/formats";

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
 * Our MusicXML, read by somebody else.
 *
 * A writer and a reader we both wrote agree with each other by construction, so the
 * MusicXML round trip in packages/formats proves only that the pair is
 * self-consistent. This is the independent judge: our file is handed to alphaTab's own
 * MusicXML importer, and what it finds is compared against what it found in the
 * original. A mistake both halves of our pair make survives the unit tests and dies
 * here.
 *
 * Also runs our own reader over the same file, so the two readings can be compared to
 * each other rather than only to the source. Where they disagree, one of us is wrong
 * and the disagreement says where to look.
 */
export interface MusicXmlCompareResult {
  ok: boolean;
  error?: string;
  original?: Stats;
  /** alphaTab's reading of the MusicXML we wrote. */
  theirs?: Stats;
  /** Our own reading of the same file. */
  ours?: Stats;
  pitchDrift?: { missing: number[]; added: number[] };
  /**
   * Notes alphaTab found that we did not, and the reverse.
   *
   * Compared over *every* note including dead ones, because alphaTab's MusicXML reader
   * has no concept of a dead note and returns them as ordinary pitches. Comparing our
   * dead-excluded multiset against its dead-included one reports a disagreement on
   * every muted strum in the file and says nothing about either reader.
   */
  readerDrift?: { missing: number[]; added: number[] };
  unsupported?: string[];
  /** Strings and frets alphaTab kept, which is the tablature claim. */
  fretted?: { theirs: number; ours: number };
  xml?: string;
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
      transcribeTex(tex: string, jitterMs: number): Promise<TranscribeResult>;
      transcribeBytes(bytes: number[], jitterMs: number): Promise<TranscribeResult>;
      midiTex(tex: string): Promise<MidiCompareResult>;
      midiBytes(bytes: number[]): Promise<MidiCompareResult>;
      musicXmlTex(tex: string): Promise<MusicXmlCompareResult>;
      musicXmlBytes(bytes: number[]): Promise<MusicXmlCompareResult>;
    };
  }
}

/**
 * A score played, heard back, and graded against itself.
 *
 * The transcription gate. See `transcribe()` below for what is under test and what is
 * deliberately not: exact pitches with detector-shaped timing error, which isolates
 * the two pipeline stages that are ours from the two we would rent from a GPU.
 */
export interface TranscribeResult {
  ok: boolean;
  error?: string;
  /** The timing error added to each onset before quantising, in milliseconds. */
  jitterMs?: number;
  /** Sounding notes in the original's first track, ties merged. */
  truth?: number;
  /** Sounding notes in the recovered score. */
  placed?: number;
  matched?: number;
  pitchRecall?: number;
  pitchPrecision?: number;
  /**
   * Of the matched notes, the fraction on the same string and fret as the original.
   * A measurement of taste, not correctness — see the note at the match loop.
   */
  fingeringAgreement?: number;
  /**
   * Fraction of fingered notes whose string and fret actually sound their own pitch.
   * One right answer, so this is the one that is gated.
   */
  fingeringValid?: number;
  /** The subdivision chosen, and what it still could not separate. */
  grid?: number;
  mergedByGrid?: number;
  meterChanges?: number;
  /** Mean distance between a matched note and where it should have been. */
  onsetErrorMs?: number;
  /** The quantiser's own confidence signals, so a bad row says which stage gave way. */
  gridFit?: number;
  onsetShiftMs?: number;
  tripletsWanted?: number;
  bpmTruth?: number;
  /** More than one means the single-tempo quantiser is being asked the impossible. */
  tempoChanges?: number;
  barsTruth?: number;
  barsRecovered?: number;
  /**
   * Silence before the original's first note, which the transcription does not keep.
   * Both sides are aligned by this before matching — see the note at the match loop.
   */
  leadInMs?: number;
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
  /**
   * Dead notes, counted separately because they are excluded from `notes`.
   *
   * A dead note is unpitched and GP3 encodes it at a nonsense fret, so comparing its
   * pitch measures a format quirk. But it is still a note in the file, and a format
   * that cannot carry it drops a real event — MusicXML has no dead note and alphaTab's
   * MusicXML reader has no concept of one, so this is the number that says how many.
   */
  dead: number;
  /** Sorted MIDI pitches, so a wrong tuning shows up even when counts match. */
  pitches: number[];
}

function collect(score: alphaTab.model.Score, skipPercussion: boolean): Stats {
  const pitches: number[] = [];
  let dead = 0;
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
              if (note.isDead) {
                dead += 1;
                continue;
              }
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
    dead,
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

async function compareMusicXml(trigger: () => void): Promise<MusicXmlCompareResult> {
  const first = await run(trigger);
  if (!first.ok) return { ok: false, error: first.error ?? "source failed to load" };
  const source = api.score;
  if (!source) return { ok: false, error: "no score after load" };
  // Percussion counted, unlike the alphaTex round trip: our MusicXML writes a drum
  // part as pitched notes rather than dropping it, so excluding percussion from the
  // baseline while including it in the file under test compares 24 notes against 47
  // and calls a working exporter broken.
  const original = collect(source, false);
  original.tracks = source.tracks.length;

  let xml: string;
  let unsupported: string[];
  let ours: Stats;
  let ourEveryPitch: number[] = [];
  try {
    const converted = fromAlphaTab(source);
    const written = toMusicXml(converted.score);
    xml = written.text;
    const reread = fromMusicXml(xml);
    unsupported = [...new Set([...written.report.unsupported, ...reread.report.unsupported])].sort();
    const pitches: number[] = [];
    /** Every pitch including dead notes, for the reader-against-reader comparison. */
    const everyPitch: number[] = [];
    let notes = 0;
    let dead = 0;
    let bars = 0;
    for (const track of reread.score.tracks) {
      bars = Math.max(bars, track.bars.length);
      const tuning = track.instrument.kind === "fretted" ? track.instrument.tuning : [];
      for (const bar of track.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              // Harmonics compare by fretted pitch, the same choice `collect` makes on
              // alphaTab's side and for the same reason: the model keeps the harmonic
              // flag and the sounding pitch, alphaTab reports the stopped pitch, and
              // comparing one against the other reports a disagreement on every
              // harmonic in the file while saying nothing about either reader.
              const harmonic =
                note.articulations.includes("naturalHarmonic") ||
                note.articulations.includes("artificialHarmonic");
              const open = note.string === undefined ? undefined : tuning[note.string - 1];
              const stopped =
                harmonic && open !== undefined && note.fret !== undefined ? open + note.fret : note.pitch;
              everyPitch.push(stopped);
              // Counted the way `collect` counts alphaTab's side, or the two numbers
              // are not comparable: dead notes out of the pitch multiset, into their
              // own total.
              if (note.articulations.includes("deadNote")) {
                dead += 1;
                continue;
              }
              notes += 1;
              pitches.push(stopped);
            }
          }
        }
      }
    }
    ours = { tracks: reread.score.tracks.length, bars, notes, dead, pitches: pitches.sort((a, b) => a - b) };
    ourEveryPitch = everyPitch.sort((a, b) => a - b);
  } catch (e) {
    return { ok: false, error: `conversion threw: ${e instanceof Error ? e.message : String(e)}`, original };
  }

  const bytes = new TextEncoder().encode(xml);
  const second = await run(() => api.load(bytes));
  if (!second.ok) {
    return { ok: false, error: `alphaTab refused our MusicXML: ${second.error ?? "?"}`, original, ours, unsupported, xml };
  }
  const after = api.score;
  if (!after) return { ok: false, error: "no score after reload", original, ours, unsupported, xml };
  const theirs = collect(after, true);

  // How many notes came back with a string and a fret, on each side. Every MusicXML
  // exporter claims guitar support; keeping the fingering is what separates the ones
  // that mean it, and this is the number that says whether we did.
  let theirFretted = 0;
  for (const track of after.tracks) {
    for (const stave of track.staves) {
      for (const bar of stave.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) if (note.string > 0 && note.fret >= 0) theirFretted += 1;
          }
        }
      }
    }
  }
  let ourFretted = 0;
  const reread = fromMusicXml(xml);
  for (const track of reread.score.tracks) {
    for (const bar of track.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) if (note.string !== undefined && note.fret !== undefined) ourFretted += 1;
        }
      }
    }
  }

  return {
    ok: true,
    original,
    theirs,
    ours,
    pitchDrift: diffPitches(original.pitches, theirs.pitches),
    readerDrift: diffPitches(theirs.pitches, ourEveryPitch),
    unsupported,
    fretted: { theirs: theirFretted, ours: ourFretted },
    xml,
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

/**
 * The transcription gate: a score, played, heard back, and graded against itself.
 *
 * DIFFERENTIATION.md §2 scopes audio-to-tab as research and says accuracy should be
 * measured before it is claimed. This is where it gets measured, and the reason it
 * can be measured at all is that we own both ends of the pipeline: `timeline()` turns
 * a score into the notes a perfect detector would report, so every file in the corpus
 * is a labelled example for free. No annotation, no purchased dataset, and the labels
 * are exact rather than someone's best transcription.
 *
 * What this does *not* test is stages 1 and 2 — separation and pitch detection. Those
 * are model downloads and GPU time. Feeding the quantiser exact pitches with
 * detector-shaped timing error isolates the stage that is ours, which is the stage
 * that decides whether the output is a *tab* or a pile of MIDI. `jitterMs` is the
 * knob: sweep it and the report says where our half gives way, separately from
 * whatever the models do.
 */
async function transcribe(trigger: () => void, jitterMs: number): Promise<TranscribeResult> {
  const loaded = await run(trigger);
  if (!loaded.ok) return { ok: false, error: loaded.error ?? "score failed to load" };
  const source = api.score;
  if (!source) return { ok: false, error: "no score after load" };

  const core = fromAlphaTab(source).score;
  const line = timeline(core);
  const track = core.tracks[0];
  if (!track) return { ok: false, error: "no first track" };

  // One instrument, which is what a transcription is. Grading a mixed timeline
  // against a single-track result would charge the quantiser for notes nobody asked
  // it to write. Ties merged, because a tie sounds as one note and a detector hears
  // one note — the written pair is our notation, not the performance.
  const truth = mergeTies(line.notes.filter((n) => n.trackIndex === 0)).sort(
    (a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch,
  );
  if (truth.length === 0) return { ok: false, error: "first track has no pitched notes" };

  // Deterministic pseudo-random jitter. A seeded generator rather than Math.random
  // so a regression in the gate is a regression in the code, not in the dice.
  let seed = 0x2f6e2b1;
  const nextUnit = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const jitterSeconds = jitterMs / 1000;
  const detected: DetectedNote[] = truth.map((n) => ({
    pitch: n.pitch,
    startSeconds: Math.max(0, n.startSeconds + (nextUnit() * 2 - 1) * jitterSeconds),
    // Length is the least reliable thing a detector reports — a decaying string has no
    // defined end — so it is jittered harder than the onset, but *scaled by the same
    // knob*. It used to be a flat 30% regardless, which meant the 0ms row was not the
    // clean arithmetic check this harness claims it is: an inflated final note pushed
    // past the last bar line and the transcription grew a bar out of the harness's own
    // noise. At 0ms the input is now exact, so a 0ms discrepancy is ours.
    durationSeconds: Math.max(
      0.02,
      n.durationSeconds * (1 + (nextUnit() * 2 - 1) * (jitterMs / 40) * 0.3),
    ),
  }));

  const bpmTruth = line.tempoChanges[0]?.bpm ?? 120;
  const meter = line.meterChanges[0];
  // The maps are handed over because a *file* states them. This models MIDI import
  // rather than audio transcription: a detector listening to a recording knows neither
  // map, and inferring where a piece changes meter from onsets alone is its own
  // problem. Passing them here measures what the notation stage does when the
  // structure is known, which is the half a wrong bar length would otherwise hide.
  //
  // Ticks are rebased to the first note, since that is where a transcription starts.
  const firstTick = truth[0]?.startTicks ?? 0;
  const { score: recovered, report } = quantise(detected, {
    bpm: bpmTruth,
    ...(meter ? { meter: { beats: meter.beats, beatValue: meter.beatValue } } : {}),
    tempos: line.tempoChanges.map((t) => ({ atTicks: t.tick - firstTick, bpm: t.bpm })),
    meters: line.meterChanges.map((m) => ({
      atTicks: m.tick - firstTick,
      beats: m.beats,
      beatValue: m.beatValue,
    })),
    instrument: track.instrument,
  });

  const got = mergeTies(timeline(recovered).notes).sort(
    (a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch,
  );

  // Both sides are measured from their own first onset before being compared.
  //
  // The quantiser starts a transcription at its first note on purpose: leading silence
  // is not music, and a detector cannot tell a rest before the entry from noise before
  // the count-in. So on a track whose guitar enters a bar late, every recovered note
  // sits exactly that far earlier than the original — a constant offset, not drift.
  // Comparing raw positions scored one such file at 21% recall while its rhythm was
  // recovered perfectly, which is the metric being wrong rather than the code.
  const truthOrigin = truth[0]?.startSeconds ?? 0;
  const gotOrigin = got[0]?.startSeconds ?? 0;

  // How many of the score's bars the first track's notes reach into.
  const firstSounding = truthOrigin;
  const lastSounding = truth.reduce((max, n) => Math.max(max, n.startSeconds + n.durationSeconds), 0);
  const barsSpanned = line.bars.filter(
    (b) => b.endSeconds > firstSounding + 1e-6 && b.startSeconds < lastSounding - 1e-6,
  ).length;

  // Matched greedily on pitch within a tolerance of the true onset. Half a beat is
  // generous on purpose: this measures whether the note is *in the right place in the
  // bar*, and a stricter window would be measuring the grid resolution instead.
  const tolerance = (60 / bpmTruth) * 0.5;
  const taken = new Set<number>();
  let matched = 0;
  let fingeringSame = 0;
  let onsetErrorTotal = 0;
  for (const want of truth) {
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const [i, have] of got.entries()) {
      if (taken.has(i) || have.pitch !== want.pitch) continue;
      const delta = Math.abs(
        have.startSeconds - gotOrigin - (want.startSeconds - truthOrigin),
      );
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    if (bestIndex < 0 || bestDelta > tolerance) continue;
    taken.add(bestIndex);
    matched += 1;
    onsetErrorTotal += bestDelta;
    const have = got[bestIndex]!;
    // The stage everyone else skips. A transcription that recovers the pitch but not
    // the position on the neck is MIDI, and the user still has to finger it.
    //
    // Reported, not gated. Our solver picks its own positions, and where it disagrees
    // with the original both are usually playable — A2 is string 5 open or string 6
    // fret 5, and a guitarist would accept either. Gating on agreement would be
    // gating on whether we guessed a human's preference, which is not correctness.
    if (have.string === want.string && have.fret === want.fret) fingeringSame += 1;
  }

  // Correctness, as opposed to style: does every fingering we wrote actually sound the
  // note we wrote it for, on this instrument's tuning and capo? Unlike agreement this
  // has exactly one right answer, so it *is* gated — a fret that produces a different
  // pitch than its note claims is a bug that would put a wrong tab in front of a user.
  const fretted = track.instrument.kind === "fretted";
  let fingered = 0;
  let fingeringWrong = 0;
  for (const note of got) {
    if (note.string === undefined || note.fret === undefined) continue;
    fingered += 1;
    if (fretted && pitchAt(track.instrument, note.string, note.fret) !== note.pitch) {
      fingeringWrong += 1;
    }
  }

  return {
    ok: true,
    jitterMs,
    truth: truth.length,
    placed: got.length,
    matched,
    pitchRecall: matched / truth.length,
    pitchPrecision: got.length === 0 ? 0 : matched / got.length,
    fingeringAgreement: matched === 0 ? 0 : fingeringSame / matched,
    fingeringValid: fingered === 0 ? 1 : (fingered - fingeringWrong) / fingered,
    onsetErrorMs: matched === 0 ? 0 : Math.round((onsetErrorTotal / matched) * 1000),
    gridFit: report.gridFit,
    onsetShiftMs: Math.round(report.onsetShift.p95 * 1000),
    tripletsWanted: report.tripletsWanted,
    grid: report.grid,
    mergedByGrid: report.mergedByGrid,
    bpmTruth,
    tempoChanges: line.tempoChanges.length,
    meterChanges: line.meterChanges.length,
    // Bars the truth notes actually *span*, not every bar the score plays.
    //
    // A transcription covers the music it heard: it starts at the first note and ends at
    // the last. A score whose first track rests for the last forty bars plays those bars
    // and the transcription rightly has nothing to say about them, so the total played
    // count is the wrong denominator — it reported one file as writing 118 bars for 166
    // when its guitar part is 118 bars long. (Played rather than written is still the
    // right basis: `timeline()` expands repeats, and comparing against the written count
    // made every score with a repeat look 20% too long.)
    barsTruth: barsSpanned,
    barsRecovered: report.barsWritten,
    leadInMs: Math.round((truthOrigin - gotOrigin) * 1000),
  };
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
  transcribeTex: (tex, jitterMs) => transcribe(() => api.tex(tex), jitterMs),
  transcribeBytes: (bytes, jitterMs) => transcribe(() => api.load(new Uint8Array(bytes)), jitterMs),
  timingBytes: (bytes) => timing(() => api.load(new Uint8Array(bytes))),
  renderAudioTex: (tex, maxMs) => renderAudio(() => api.tex(tex), maxMs),
  renderAudioBytes: (bytes, maxMs) => renderAudio(() => api.load(new Uint8Array(bytes)), maxMs),
  // Bytes cross the CDP boundary as a plain array.
  loadBytes: (bytes) => run(() => api.load(new Uint8Array(bytes))),
  roundTripTex: (tex) => roundTrip(() => api.tex(tex)),
  musicXmlTex: (tex) => compareMusicXml(() => api.tex(tex)),
  musicXmlBytes: (bytes) => compareMusicXml(() => api.load(new Uint8Array(bytes))),
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
