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
 * Scientific pitch notation, which is what alphaTex parses: a guitar's high E
 * (MIDI 64) is E4, and alphaTab reads that back as 64. Verified against the
 * parser, not assumed.
 */
function pitchToName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12] ?? "C";
  return `${name}${Math.floor(midi / 12) - 1}`;
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

/** Strings whose note carries into the next beat, for tie destinations. */
function tiedStrings(beat: Beat): Set<number> {
  const out = new Set<number>();
  for (const note of beat.notes) {
    if (note.tiedToNext && note.string !== undefined) out.add(note.string);
  }
  return out;
}

function noteToken(beat: Beat, instrument: Instrument, tiedFromPrev: Set<number>): string {
  // A percussion staff takes drum voices, not pitches — alphaTex rejects a pitch
  // name outright ("Cannot use pitched note value on percussion staff"). The voice
  // number goes in parentheses even when there is only one of them, which is the
  // one form of the four candidates tried that the parser accepts.
  if (instrument.kind === "drums") {
    if (beat.notes.length === 0) return "r";
    return `(${beat.notes.map((note) => String(Math.round(note.pitch))).join(" ")})`;
  }

  const parts = beat.notes.map((note) => {
    const effects = note.articulations
      .map((a) => NOTE_EFFECTS[a])
      .filter((e): e is string => e !== undefined);
    const isDead = note.articulations.includes("deadNote");
    const wrap = (list: string[]) => (list.length > 0 ? `{${list.join(" ")}}` : "");

    // A tie destination is written as a dash on its string; alphaTab restores
    // the pitch from the origin. Verified against the parser.
    if (note.string !== undefined && tiedFromPrev.has(note.string)) {
      return `-.${note.string}${wrap(effects)}`;
    }
    // Dead notes keep their fret: `3.4{x}` parses as a dead note at fret 3
    // (verified against the parser); the bare `x` form loses placement and is
    // only the fallback when no usable fret exists.
    if (isDead && note.fret !== undefined && note.fret >= 0 && note.string !== undefined) {
      return `${note.fret}.${note.string}${wrap([...effects, "x"])}`;
    }
    if (isDead) {
      return `x.${note.string ?? 1}${wrap(effects)}`;
    }
    if (instrument.kind === "fretted" && note.string !== undefined && note.fret !== undefined) {
      return `${note.fret}.${note.string}${wrap(effects)}`;
    }
    return `${pitchToName(note.pitch)}${wrap(effects)}`;
  });

  if (parts.length === 0) return "r";
  if (parts.length === 1) return parts[0] ?? "r";
  return `(${parts.join(" ")})`;
}

function beatToTex(beat: Beat, instrument: Instrument, tiedFromPrev: Set<number>): string {
  let token = `${noteToken(beat, instrument, tiedFromPrev)}.${beat.duration.denominator}`;
  const properties: string[] = [];
  if (beat.dots === 1) properties.push("d");
  if (beat.dots === 2) properties.push("dd");
  if (beat.tuplet) properties.push(`tu ${beat.tuplet.actual}`);
  // Chord symbols and lyrics are beat effects in alphaTex, which means the engraver
  // draws them natively — the chord above the staff, the syllable below — with no
  // overlay of ours anywhere near the music.
  if (beat.chord !== undefined) properties.push(`ch "${texString(beat.chord)}"`);
  if (beat.lyric !== undefined) properties.push(`lyrics "${texString(beat.lyric)}"`);
  if (properties.length > 0) token += `{${properties.join(" ")}}`;
  return token;
}

/** alphaTex strings take no escapes, so a double quote inside one becomes a single. */
function texString(value: string): string {
  return value.replace(/"/g, "'");
}

/** Bar-level directives (meter, tempo, repeats) belong to the first voice only. */
function barPrefix(bar: Bar): string[] {
  const prefix: string[] = [];
  if (bar.timeSignature) prefix.push(`\\ts ${bar.timeSignature.beats} ${bar.timeSignature.beatValue}`);
  if (bar.tempoBpm !== undefined) prefix.push(`\\tempo ${bar.tempoBpm}`);
  if (bar.section !== undefined) prefix.push(`\\section "${texString(bar.section)}"`);
  if (bar.repeat?.start) prefix.push("\\ro");
  // Repeat close must lead the bar it belongs to. Written after the beats it
  // binds to the *next* bar instead, which adds a bar on every round trip.
  if (bar.repeat?.endCount) prefix.push(`\\rc ${bar.repeat.endCount}`);
  return prefix;
}

/** One voice's bars for a whole track, with tie state carried across barlines. */
function voiceLineToTex(track: Track, voiceIndex: number): string {
  let tied = new Set<number>();
  const bars = track.bars.map((bar) => {
    const prefix = voiceIndex === 0 ? barPrefix(bar) : [];
    const voice = bar.voices[voiceIndex];
    let beats: string;
    if (voice && voice.beats.length > 0) {
      beats = voice.beats
        .map((beat) => {
          const token = beatToTex(beat, track.instrument, tied);
          tied = tiedStrings(beat);
          return token;
        })
        .join(" ");
    } else {
      // An empty bar must still emit a rest, or alphaTex sees a stray
      // separator and the bar count drifts on every round trip.
      beats = "r.1";
      tied = new Set();
    }
    return `${prefix.length > 0 ? `${prefix.join(" ")} ` : ""}${beats}`;
  });
  return bars.join(" |\n");
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
    // `\staff{score}` is required: a percussion track without it fails to parse.
    lines.push("\\staff{score} \\instrument percussion");
    lines.push("\\articulation defaults");
  }

  const voiceCount = Math.max(1, ...track.bars.map((bar) => bar.voices.length));
  if (voiceCount === 1) {
    lines.push(voiceLineToTex(track, 0));
  } else {
    for (let v = 0; v < voiceCount; v++) {
      lines.push("\\voice");
      lines.push(voiceLineToTex(track, v));
    }
  }
  return lines.join("\n");
}

export function toAlphaTex(score: Score): string {
  const header = [`\\title "${score.title.replace(/"/g, "'")}"`];
  if (score.artist) header.push(`\\artist "${score.artist.replace(/"/g, "'")}"`);
  header.push(".");
  /**
   * Drum tracks are still omitted, and now for a measured reason rather than an
   * assumed one.
   *
   * The model carries percussion as General MIDI drum numbers, and a percussion
   * staff does take a number in parentheses — `(38).4` parses. But that number is
   * an *index into the staff's articulation list*, not a drum number. Writing all
   * 47 GM voices under `\articulation defaults` and reading back what alphaTab's
   * own MIDI generator sounded gave exactly five notes, voices 35 to 39: every
   * index past the end of the default list is silent. So writing drum numbers here
   * would produce a file that renders a full kit and plays five sounds, which is
   * worse than a track the player is honest about not editing.
   *
   * What this needs is for the tex to declare its own articulation list, so the
   * index we write is one we defined. That is the next step, and it starts from
   * this measurement rather than from a guess. Percussion *is* carried through the
   * model and out to MIDI on channel 10, where it is graded against alphaTab's own
   * channel-10 notes by `pnpm midi`.
   */
  const tracks = score.tracks.filter((t) => t.instrument.kind !== "drums");
  const body = tracks.length > 0 ? tracks.map(trackToTex).join("\n\n") : trackToTex(EMPTY_TRACK);
  return `${header.join("\n")}\n${body}\n`;
}

const EMPTY_TRACK: Track = {
  id: "empty",
  name: "Guitar",
  instrument: { kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], frets: 24, capo: 0 },
  bars: [{ id: "empty-bar", voices: [] }],
};

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
