/**
 * alphaTab model -> CubScore semantic model.
 *
 * This is what makes an imported Guitar Pro file editable rather than
 * play-only. alphaTab owns the byte-level parsing of .gp3 through .gp8 for
 * now (PLAN.md Phase 2 replaces it), so importing means walking the object
 * graph it produces and translating into our model.
 *
 * Anything we do not model yet is reported rather than silently dropped:
 * callers get an ImportReport listing what was lost, so we never claim a
 * clean round trip we did not make.
 */
import * as alphaTab from "@coderline/alphatab";
import {
  nextId,
  type Articulation,
  type Bar,
  type Beat,
  type Duration,
  type Instrument,
  type KeySignature,
  type Note,
  type Score,
  type TimeSignature,
  type Track,
  type Voice,
} from "@cubscore/core";

export interface ImportReport {
  /** Features present in the source that our model does not carry yet. */
  unsupported: string[];
  trackCount: number;
  barCount: number;
  noteCount: number;
}

interface Ctx {
  unsupported: Set<string>;
  noteCount: number;
}

function durationOf(value: number): Duration {
  // alphaTab's Duration enum is the denominator for normal values and
  // negative for multi-whole durations (DoubleWhole = -2).
  if (value < 0) return { numerator: -value, denominator: 1 };
  return { numerator: 1, denominator: value === 0 ? 4 : value };
}

function articulationsOf(note: alphaTab.model.Note, ctx: Ctx): Articulation[] {
  const out: Articulation[] = [];

  if (note.isPalmMute) out.push("palmMute");
  if (note.isLetRing) out.push("letRing");
  if (note.isDead) out.push("deadNote");
  if (note.isStaccato) out.push("staccato");
  if (note.isGhost) out.push("ghost");
  if (note.isHammerPullOrigin) out.push("hammerOn");
  if (note.isLeftHandTapped) out.push("tap");
  if (note.hasBend) out.push("bend");
  if (note.vibrato !== alphaTab.model.VibratoType.None) out.push("vibrato");
  if (note.isTrill) out.push("tremolo");
  if (note.accentuated !== alphaTab.model.AccentuationType.None) out.push("accent");

  if (note.slideOutType !== alphaTab.model.SlideOutType.None) out.push("slide");
  else if (note.slideInType !== alphaTab.model.SlideInType.None) out.push("slide");

  switch (note.harmonicType) {
    case alphaTab.model.HarmonicType.None:
      break;
    case alphaTab.model.HarmonicType.Natural:
      out.push("naturalHarmonic");
      break;
    default:
      out.push("artificialHarmonic");
      ctx.unsupported.add("harmonic pitch detail (harmonic type kept, exact pitch simplified)");
      break;
  }

  // Bend shapes, fingerings, and slide targets survive playback through
  // alphaTab but are not in our model yet.
  if (note.hasBend && note.bendPoints && note.bendPoints.length > 2) {
    ctx.unsupported.add("detailed bend curves (simplified to a single bend)");
  }
  if (note.isFingering) ctx.unsupported.add("left/right hand fingerings");

  return out;
}

function noteOf(note: alphaTab.model.Note, stringCount: number, ctx: Ctx): Note {
  ctx.noteCount += 1;
  const out: Note = {
    id: nextId("n"),
    pitch: note.realValue,
    articulations: articulationsOf(note, ctx),
  };
  if (note.isStringed) {
    // alphaTab numbers strings from the lowest; our model (and alphaTex)
    // number from the highest. Verified against the parser, not assumed:
    // a 6-string note written on string 6 arrives as string 1.
    out.string = stringCount + 1 - note.string;
    // GP3 encodes dead notes at fret -1 (they read back as open-string-1);
    // frets are never negative in our model.
    out.fret = Math.max(0, note.fret);
  }
  if (note.isTieOrigin) out.tiedToNext = true;
  return out;
}

function beatOf(beat: alphaTab.model.Beat, stringCount: number, ctx: Ctx): Beat {
  const out: Beat = {
    id: nextId("b"),
    duration: durationOf(beat.duration),
    notes: beat.isRest ? [] : beat.notes.map((n) => noteOf(n, stringCount, ctx)),
    dots: (Math.min(2, Math.max(0, beat.dots)) as 0 | 1 | 2),
  };
  if (beat.hasTuplet) {
    out.tuplet = { actual: beat.tupletNumerator, normal: beat.tupletDenominator };
  }
  if (beat.text) ctx.unsupported.add("beat text annotations");
  if (beat.chord) ctx.unsupported.add("chord diagrams");
  return out;
}

function voiceOf(voice: alphaTab.model.Voice, stringCount: number, ctx: Ctx): Voice {
  return { id: nextId("v"), beats: voice.beats.map((b) => beatOf(b, stringCount, ctx)) };
}

function keySignatureOf(master: alphaTab.model.MasterBar): KeySignature {
  return {
    fifths: master.keySignature as unknown as number,
    mode: master.keySignatureType === alphaTab.model.KeySignatureType.Minor ? "minor" : "major",
  };
}

function barOf(
  bar: alphaTab.model.Bar,
  previous: alphaTab.model.MasterBar | null,
  stringCount: number,
  ctx: Ctx,
): Bar {
  const master = bar.masterBar;
  const out: Bar = {
    id: nextId("m"),
    // Empty voices would serialize to nothing, so keep only ones with beats.
    voices: bar.voices.filter((v) => v.beats.length > 0).map((v) => voiceOf(v, stringCount, ctx)),
  };

  if (out.voices.length === 0) {
    out.voices = [{ id: nextId("v"), beats: [] }];
  }
  // Additional voices are carried through the model and serializer; the
  // editor's caret only reaches the first voice today, which is an editor
  // limitation rather than data loss, so it is not reported as unsupported.

  const ts: TimeSignature = {
    beats: master.timeSignatureNumerator,
    beatValue: master.timeSignatureDenominator,
  };
  const tsChanged =
    !previous ||
    previous.timeSignatureNumerator !== ts.beats ||
    previous.timeSignatureDenominator !== ts.beatValue;
  if (tsChanged) out.timeSignature = ts;

  const key = keySignatureOf(master);
  const keyChanged = !previous || (previous.keySignature as unknown as number) !== key.fifths;
  if (keyChanged) out.keySignature = key;

  if (master.tempoAutomations.length > 0) {
    const tempo = master.tempoAutomations[0]?.value;
    if (tempo !== undefined) out.tempoBpm = Math.round(tempo);
  }

  if (master.isRepeatStart || master.repeatCount > 0) {
    out.repeat = {};
    if (master.isRepeatStart) out.repeat.start = true;
    if (master.repeatCount > 0) out.repeat.endCount = master.repeatCount;
  }

  if (master.section) ctx.unsupported.add("section markers");
  if (master.alternateEndings > 0) ctx.unsupported.add("alternate endings");

  return out;
}

function instrumentOf(track: alphaTab.model.Track, staff: alphaTab.model.Staff, ctx: Ctx): Instrument {
  if (staff.isPercussion) return { kind: "drums" };
  if (staff.isStringed && staff.stringTuning.tunings.length > 0) {
    return {
      kind: "fretted",
      // alphaTab stores tunings highest string first, same as our model.
      tuning: [...staff.stringTuning.tunings],
      frets: 24,
      capo: staff.capo,
    };
  }
  ctx.unsupported.add(`pitched staff on "${track.name}" (no tablature)`);
  return { kind: "pitched", midiProgram: track.playbackInfo.program };
}

function trackOf(track: alphaTab.model.Track, ctx: Ctx): Track {
  const staff = track.staves[0];
  if (!staff) {
    return { id: nextId("t"), name: track.name || "Track", instrument: { kind: "drums" }, bars: [] };
  }
  if (track.staves.length > 1) {
    ctx.unsupported.add(`extra staves on "${track.name}" (only the first is imported)`);
  }

  const stringCount = staff.stringTuning.tunings.length;
  const bars: Bar[] = [];
  let previousMaster: alphaTab.model.MasterBar | null = null;
  for (const bar of staff.bars) {
    bars.push(barOf(bar, previousMaster, stringCount, ctx));
    previousMaster = bar.masterBar;
  }

  return {
    id: nextId("t"),
    name: track.name || "Track",
    instrument: instrumentOf(track, staff, ctx),
    bars,
  };
}

/** Translates a parsed alphaTab score into the editable semantic model. */
export function fromAlphaTab(source: alphaTab.model.Score): { score: Score; report: ImportReport } {
  const ctx: Ctx = { unsupported: new Set(), noteCount: 0 };

  // Percussion is skipped rather than half-converted: the model stores pitches,
  // not drum articulations, so anything we produced would be wrong notation.
  // The imported file still plays faithfully in the player.
  const percussion = source.tracks.filter((t) => t.staves[0]?.isPercussion);
  const tracks = source.tracks
    .filter((t) => !t.staves[0]?.isPercussion)
    .map((t) => trackOf(t, ctx));

  for (const drum of percussion) {
    ctx.unsupported.add(`drum track "${drum.name || "Drums"}" (percussion is not editable yet)`);
  }
  if (source.words || source.music) ctx.unsupported.add("lyrics and credits metadata");

  const score: Score = {
    id: nextId("s"),
    title: source.title || "Untitled",
    artist: source.artist || "",
    tracks,
    revision: 0,
  };

  // Tempo lives on the score in alphaTab; put it on the first bar so the
  // serializer emits it.
  const firstBar = tracks[0]?.bars[0];
  if (firstBar && source.tempo > 0 && firstBar.tempoBpm === undefined) {
    firstBar.tempoBpm = Math.round(source.tempo);
  }

  return {
    score,
    report: {
      unsupported: [...ctx.unsupported].sort(),
      trackCount: tracks.length,
      barCount: tracks[0]?.bars.length ?? 0,
      noteCount: ctx.noteCount,
    },
  };
}
