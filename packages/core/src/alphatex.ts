/**
 * Score -> alphaTex serializer.
 *
 * alphaTab is the Phase 1 renderer, and alphaTex is the cleanest way to hand
 * it our model without depending on its object graph. When our own engine
 * lands (PLAN.md Phase 2), this becomes an export format rather than the
 * render path.
 */
import type { Articulation, Bar, Beat, Instrument, Score, Track } from "./score.js";

const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

/**
 * alphaTab names octaves one higher than scientific pitch notation: MIDI 64
 * (scientific E4, a guitar's high E) is written e5.
 */
function pitchToName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12] ?? "C";
  return `${name}${Math.floor(midi / 12)}`;
}

/** Note-level effects, written between the string and the duration. */
const NOTE_EFFECTS: Partial<Record<Articulation, string>> = {
  bend: "b (0 4)",
  slide: "sl",
  hammerOn: "h",
  pullOff: "h",
  vibrato: "v",
  palmMute: "pm",
  letRing: "lr",
  naturalHarmonic: "nh",
  artificialHarmonic: "ah",
  tap: "st",
  staccato: "st",
  accent: "ac",
  ghost: "g",
  tremolo: "tr",
};

function noteToken(beat: Beat, instrument: Instrument): string {
  const parts = beat.notes.map((note) => {
    const effects = note.articulations
      .map((a) => NOTE_EFFECTS[a])
      .filter((e): e is string => e !== undefined);
    const suffix = effects.length > 0 ? `{${effects.join(" ")}}` : "";

    if (note.articulations.includes("deadNote")) {
      return `x.${note.string ?? 1}${suffix}`;
    }
    if (instrument.kind === "fretted" && note.string !== undefined && note.fret !== undefined) {
      return `${note.fret}.${note.string}${suffix}`;
    }
    return `${pitchToName(note.pitch)}${suffix}`;
  });

  if (parts.length === 0) return "r";
  if (parts.length === 1) return parts[0] ?? "r";
  return `(${parts.join(" ")})`;
}

function beatToTex(beat: Beat, instrument: Instrument): string {
  let token = `${noteToken(beat, instrument)}.${beat.duration.denominator}`;
  const properties: string[] = [];
  if (beat.dots === 1) properties.push("d");
  if (beat.dots === 2) properties.push("dd");
  if (beat.tuplet) properties.push(`tu ${beat.tuplet.actual}`);
  if (properties.length > 0) token += `{${properties.join(" ")}}`;
  return token;
}

function barToTex(bar: Bar, instrument: Instrument): string {
  const prefix: string[] = [];
  if (bar.timeSignature) prefix.push(`\\ts ${bar.timeSignature.beats} ${bar.timeSignature.beatValue}`);
  if (bar.tempoBpm !== undefined) prefix.push(`\\tempo ${bar.tempoBpm}`);
  if (bar.repeat?.start) prefix.push("\\ro");

  // Multi-voice bars are Phase 2; the editor writes a single voice today.
  const voice = bar.voices[0];
  const beats = voice ? voice.beats.map((b) => beatToTex(b, instrument)).join(" ") : "r.1";

  const suffix = bar.repeat?.endCount ? ` \\rc ${bar.repeat.endCount}` : "";
  return `${prefix.length > 0 ? `${prefix.join(" ")} ` : ""}${beats}${suffix}`;
}

function trackToTex(track: Track): string {
  const lines = [`\\track "${track.name.replace(/"/g, "'")}"`];

  if (track.instrument.kind === "fretted") {
    const tuning = track.instrument.tuning.map(pitchToName).join(" ");
    lines.push(`\\staff{score tabs} \\tuning ${tuning}`);
    if (track.instrument.capo > 0) lines.push(`\\capo ${track.instrument.capo}`);
  } else if (track.instrument.kind === "pitched") {
    lines.push(`\\staff{score} \\instrument ${track.instrument.midiProgram}`);
  } else {
    lines.push("\\instrument percussion");
    lines.push("\\articulation defaults");
  }

  const bars = track.bars.map((bar) => barToTex(bar, track.instrument));
  lines.push(bars.join(" |\n"));
  return lines.join("\n");
}

export function toAlphaTex(score: Score): string {
  const header = [`\\title "${score.title.replace(/"/g, "'")}"`];
  if (score.artist) header.push(`\\artist "${score.artist.replace(/"/g, "'")}"`);
  header.push(".");
  return `${header.join("\n")}\n${score.tracks.map(trackToTex).join("\n\n")}\n`;
}

const QUARTER_TICKS = 960;

/** Ticks a beat occupies, including dots and tuplets. Matches alphaTab's clock. */
export function beatTicks(beat: Beat): number {
  let ticks = (QUARTER_TICKS * 4) / beat.duration.denominator;
  if (beat.dots === 1) ticks *= 1.5;
  if (beat.dots === 2) ticks *= 1.75;
  if (beat.tuplet) ticks = (ticks * beat.tuplet.normal) / beat.tuplet.actual;
  return Math.round(ticks);
}

/** Absolute tick of a beat from the start of a track, for cursor placement. */
export function tickAt(track: Track, barIndex: number, beatIndex: number): number {
  let ticks = 0;
  for (let b = 0; b < barIndex && b < track.bars.length; b++) {
    const voice = track.bars[b]?.voices[0];
    if (voice) for (const beat of voice.beats) ticks += beatTicks(beat);
  }
  const voice = track.bars[barIndex]?.voices[0];
  if (voice) {
    for (let i = 0; i < beatIndex && i < voice.beats.length; i++) {
      const beat = voice.beats[i];
      if (beat) ticks += beatTicks(beat);
    }
  }
  return ticks;
}
