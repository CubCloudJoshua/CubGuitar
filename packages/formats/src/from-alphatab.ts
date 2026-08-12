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
  DRUM_VOICE_NAMES,
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
  /**
   * Tracks the notation writer can actually write.
   *
   * Now every track: drum tracks used to be excluded because alphaTex carried no
   * percussion, and a caller that stored a core for a drum-only file made EDIT available
   * and then showed a blank guitar staff, because the serializer substitutes a default
   * track for a score with nothing writable in it. That is fixed at the source — see
   * percussion.ts — so the count no longer needs to lie about what is there.
   */
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

/**
 * Articulation index to General MIDI drum number, for the track being converted.
 *
 * A module-level map because `noteOf` has no reference to the track, and threading
 * one through every call for the percussion case alone would touch every signature
 * in this file. Set by `trackOf` before it walks a track's bars and cleared after,
 * so a note can never read another track's kit.
 */
const percussionArticulations = new Map<number, number>();

/**
 * A staff's open-string pitches, highest string first, or empty for an unstringed one.
 *
 * Passed down to the note so a clamped fret can be given a pitch that matches it. The
 * alternative is trusting alphaTab's `realValue`, and for a note whose fret we had to
 * change that value describes a fingering the model no longer holds.
 */
type Strings = readonly number[];

function noteOf(note: alphaTab.model.Note, strings: Strings, ctx: Ctx): Note {
  ctx.noteCount += 1;
  const out: Note = {
    id: nextId("n"),
    pitch: note.realValue,
    articulations: articulationsOf(note, ctx),
  };
  if (note.isPercussion) {
    // The drum voice as a General MIDI drum number, which is what alphaTex writes
    // on a percussion staff and what channel 10 plays.
    //
    // `note.percussionArticulation` is an *index* into the track's articulation
    // list, not that number — reading it directly wrote drum voices 0, 1, 2, 3
    // where alphaTab plays 35, 38, 42, 49, so the hit count was right and every
    // sound was wrong. `pnpm midi` caught that on the first run by comparing
    // channel-10 pitch multisets, which is exactly why it compares them.
    const articulation = percussionArticulations.get(note.percussionArticulation);
    out.pitch = articulation ?? note.percussionArticulation;
    // A track with no articulation list of its own uses alphaTab's built-in GP7
    // default kit, and for that kit the index *is* the General MIDI drum number —
    // so the fallback is correct there and needs no warning. Verified rather than
    // assumed: `pnpm midi` matches our channel-10 output to alphaTab's on a
    // percussion-only fixture that takes exactly this path. A track that states a
    // list and then uses an index outside it is the case worth reporting.
    if (articulation === undefined && percussionArticulations.size > 0) {
      ctx.unsupported.add("a drum voice outside the track's own articulation list");
    }
    return out;
  }
  if (note.isStringed) {
    // alphaTab numbers strings from the lowest; our model (and alphaTex)
    // number from the highest. Verified against the parser, not assumed:
    // a 6-string note written on string 6 arrives as string 1.
    out.string = strings.length + 1 - note.string;
    // GP3 encodes dead notes at a negative fret; frets are never negative here.
    out.fret = Math.max(0, note.fret);
    // And when the fret moves, the pitch moves with it, taken from the string rather
    // than adjusted from alphaTab's own value — for a note whose fret we just changed,
    // that value describes a fingering the model no longer holds.
    //
    // Defensive rather than observed: no file in the corpus takes this branch, so the
    // clamp above has never actually fired. It is here because the alternative is a
    // note that says two things — fret 0 on a string whose open pitch is not the note's
    // pitch, which no fingering produces — and everything downstream then splits by
    // which half it trusts. Our MIDI writer takes the pitch; a tablature reader and
    // alphaTab's MusicXML reader take the fret.
    if (note.fret < 0) {
      const open = strings[out.string - 1];
      if (open !== undefined) out.pitch = open + out.fret;
    }
  }
  if (note.isTieOrigin) out.tiedToNext = true;
  return out;
}

function beatOf(beat: alphaTab.model.Beat, strings: Strings, ctx: Ctx): Beat {
  const out: Beat = {
    id: nextId("b"),
    duration: durationOf(beat.duration),
    notes: beat.isRest ? [] : beat.notes.map((n) => noteOf(n, strings, ctx)),
    dots: (Math.min(2, Math.max(0, beat.dots)) as 0 | 1 | 2),
  };
  if (beat.hasTuplet) {
    out.tuplet = { actual: beat.tupletNumerator, normal: beat.tupletDenominator };
  }
  if (beat.text) ctx.unsupported.add("beat text annotations");
  // The chord *symbol* is carried; the fingering diagram some files attach to it is
  // not in the model, and saying so is what keeps the report honest.
  if (beat.chord) {
    if (beat.chord.name) out.chord = beat.chord.name;
    if (beat.chord.showDiagram) ctx.unsupported.add("chord diagrams (names kept, diagrams dropped)");
  }
  // Multi-line lyrics exist in Guitar Pro; the model carries one line, which is the
  // one the engraver draws, and reports the rest rather than interleaving them.
  const lyric = beat.lyrics?.[0];
  if (lyric !== undefined && lyric !== "") out.lyric = lyric;
  if ((beat.lyrics?.length ?? 0) > 1) ctx.unsupported.add("additional lyric lines (the first is kept)");
  return out;
}

function voiceOf(voice: alphaTab.model.Voice, strings: Strings, ctx: Ctx): Voice {
  return { id: nextId("v"), beats: voice.beats.map((b) => beatOf(b, strings, ctx)) };
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
  strings: Strings,
  ctx: Ctx,
): Bar {
  const master = bar.masterBar;
  const out: Bar = {
    id: nextId("m"),
    // Empty voices would serialize to nothing, so keep only ones with beats.
    voices: bar.voices.filter((v) => v.beats.length > 0).map((v) => voiceOf(v, strings, ctx)),
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

  if (master.section) {
    // A section's display text when it has one, its rehearsal marker otherwise —
    // the two fields Guitar Pro splits and a songwriter reads as one name.
    const name = master.section.text || master.section.marker;
    if (name) out.section = name;
  }
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
  // Deliberately not reported as unsupported. A pitched staff — a piano or
  // vocal part — is carried pitch-exact and round-trips exactly; the report is
  // specifically what the conversion could not carry, and the banner tells the
  // user those things are "absent from the editable version", which would be a
  // lie here. What is true is that this editor's fret entry does not apply to a
  // staff with no strings, so it is read-only; that is an editor limitation, the
  // same category as extra voices above, and the editor says so itself.
  return { kind: "pitched", midiProgram: track.playbackInfo.program };
}

function trackOf(track: alphaTab.model.Track, ctx: Ctx): Track {
  percussionArticulations.clear();
  for (const [index, articulation] of track.percussionArticulations.entries()) {
    percussionArticulations.set(index, articulation.outputMidiNumber);
  }
  const staff = track.staves[0];
  if (!staff) {
    return { id: nextId("t"), name: track.name || "Track", instrument: { kind: "drums" }, bars: [] };
  }
  if (track.staves.length > 1) {
    ctx.unsupported.add(`extra staves on "${track.name}" (only the first is imported)`);
  }

  const strings: Strings = staff.stringTuning.tunings;
  const bars: Bar[] = [];
  let previousMaster: alphaTab.model.MasterBar | null = null;
  for (const bar of staff.bars) {
    bars.push(barOf(bar, previousMaster, strings, ctx));
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

  // Percussion is carried now. It used to be dropped, on the reasoning that the
  // model stores pitches and not drum articulations — but a drum voice *is* a
  // number, and the same number serves all three consumers: alphaTex writes it as
  // `(38)` on a percussion staff, MIDI writes it as a key on channel 10, and the
  // model needs no new field. What is still missing is drum *notation editing*,
  // which is a UI gap rather than a model one.
  const tracks = source.tracks.map((t) => trackOf(t, ctx));

  // Drum tracks are carried whole now: model, notation and MIDI. What is worth reporting
  // is the one thing that is still lost — a hit whose articulation resolves to no drum at
  // all. Every GP3 drum track is on alphaTab's built-in kit with no list of its own, where
  // the articulation index is the drum number; an index that is not a General MIDI drum
  // voice therefore names nothing, alphaTab has no sound for it either, and the notation
  // writer has no name to write. Stairway has fourteen of them, all index 0, which is how
  // this case was found: `pnpm corpus` reported fourteen notes lost through the round trip
  // once percussion entered the comparison.
  const namelessVoices = new Set<number>();
  for (const track of tracks) {
    if (track.instrument.kind !== "drums") continue;
    for (const bar of track.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) {
            if (!DRUM_VOICE_NAMES.has(Math.round(note.pitch))) namelessVoices.add(Math.round(note.pitch));
          }
        }
      }
    }
  }
  if (namelessVoices.size > 0) {
    const list = [...namelessVoices].sort((a, b) => a - b).join(", ");
    ctx.unsupported.add(
      `drum hits on voice ${list}, which no General MIDI drum matches (they play as written but are not notated)`,
    );
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
      // Tracks the *editor* can render, which is what every consumer of this asks:
      // the banner uses zero to say "this file plays but there is nothing to edit",
      // and useLibrary uses it to decide whether to offer EDIT at all. Drum tracks
      // are carried by the model and written to MIDI but not rendered as notation
      // (see toAlphaTex), so counting them here made a drum-only file claim to be
      // editable and then open a blank staff.
      trackCount: tracks.length,
      barCount: tracks[0]?.bars.length ?? 0,
      noteCount: ctx.noteCount,
    },
  };
}
