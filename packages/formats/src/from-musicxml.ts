/**
 * MusicXML import.
 *
 * The other half of `to-musicxml.ts`, and the half that has to survive files we did
 * not write. A MusicXML file in the wild comes out of MuseScore, Sibelius, Finale,
 * Dorico or a scanner, each with its own habits, and the format is large enough that
 * no reader supports all of it. So this one is explicit about its boundary: it reads
 * what our model can hold, reports by name everything it dropped, and never invents a
 * note to fill a gap.
 *
 * Two things it does that a naive reader does not.
 *
 * **It reads tablature as tablature.** `<staff-tuning>` gives the instrument, and
 * `<string>`/`<fret>` on a note give the fingering, so a guitar part imported here
 * arrives with its frets rather than as pitches that have to be re-fingered. When a
 * file has the tuning but a note has no string, `arrange.ts` can finger it; when the
 * file has neither, the part stays pitched and the editor says so rather than
 * guessing at a tuning.
 *
 * **It follows the measure clock.** MusicXML positions notes with `<duration>`,
 * `<backup>` and `<forward>` rather than by order, and a chord is marked on the second
 * note rather than the first. A reader that walks notes in order and ignores backup
 * turns a two-voice piano part into one voice of twice the length, which is the single
 * most common way MusicXML import goes wrong.
 */
import {
  duration as durationOf,
  nextId,
  QUARTER_TICKS,
  type Articulation,
  type Bar,
  type Beat,
  type Instrument,
  type KeySignature,
  type Note,
  type Score,
  type TimeSignature,
  type Track,
  type Tuning,
  type Voice,
} from "@cubscore/core";
import { child, childNumber, childText, children, descendants, has, parseXml, type XmlNode } from "./xml.js";

export interface MusicXmlImportReport {
  /** Everything the file contained that the model cannot hold, by name. */
  unsupported: string[];
  trackCount: number;
  barCount: number;
  noteCount: number;
  /** Parts that carried a tuning, so a caller can say how many are real tablature. */
  frettedCount: number;
}

export interface MusicXmlImportResult {
  score: Score;
  report: MusicXmlImportReport;
}

/** Semitones above C for each step name. */
const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** A written note as a MIDI pitch. */
function pitchOf(node: XmlNode | undefined): number | undefined {
  const step = childText(node, "step");
  const octave = childNumber(node, "octave");
  if (step === undefined || octave === undefined) return undefined;
  const base = STEPS[step.toUpperCase()];
  if (base === undefined) return undefined;
  return (octave + 1) * 12 + base + (childNumber(node, "alter") ?? 0);
}

/**
 * Ticks per quarter note declared by the file, mapped onto ours.
 *
 * MusicXML lets a file pick its own divisions and most files are not 960, so every
 * duration is scaled. Kept as a factor rather than applied per note by rounding twice.
 */
function scaleFor(divisions: number): number {
  return divisions > 0 ? QUARTER_TICKS / divisions : 1;
}

/**
 * The note value a tick count represents, as a denominator, dots and tuplet.
 *
 * MusicXML states `<type>` and `<dot>` explicitly, which is what this prefers, because
 * a duration alone cannot distinguish a dotted quarter from a quarter in a triplet
 * whose file rounded. The tick count is the fallback for files that omit `<type>`,
 * which scanners and some exporters do.
 */
function valueOf(
  node: XmlNode,
  ticks: number,
): { duration: { numerator: number; denominator: number }; dots: 0 | 1 | 2; tuplet?: { actual: number; normal: number } } {
  const dots = Math.min(2, children(node, "dot").length) as 0 | 1 | 2;
  const mod = child(node, "time-modification");
  const actual = childNumber(mod, "actual-notes");
  const normal = childNumber(mod, "normal-notes");
  const tuplet = actual !== undefined && normal !== undefined && actual > 0 ? { actual, normal } : undefined;

  const typeName = childText(node, "type");
  const byName: Record<string, number> = {
    whole: 1, half: 2, quarter: 4, eighth: 8, "16th": 16, "32nd": 32, "64th": 64, "128th": 128,
    breve: 1, long: 1, maxima: 1,
  };
  const named = typeName ? byName[typeName] : undefined;
  if (named !== undefined) {
    return { duration: durationOf(named), dots, ...(tuplet ? { tuplet } : {}) };
  }

  // No `<type>`: recover the closest power-of-two value from the tick count, undoing
  // dots and tuplet so the stated value and the duration agree.
  let base = ticks;
  if (tuplet) base = (base * tuplet.actual) / tuplet.normal;
  if (dots === 1) base /= 1.5;
  if (dots === 2) base /= 1.75;
  const whole = QUARTER_TICKS * 4;
  const denominator = base > 0 ? 2 ** Math.round(Math.log2(whole / base)) : 4;
  const clamped = Math.min(128, Math.max(1, denominator));
  return { duration: durationOf(clamped), dots, ...(tuplet ? { tuplet } : {}) };
}

/** Articulations a note carries, read from every place MusicXML hides them. */
function articulationsOf(note: XmlNode, unsupported: Set<string>): Articulation[] {
  const out = new Set<Articulation>();
  const notations = child(note, "notations");
  const technical = child(notations, "technical");
  const arts = child(notations, "articulations");
  const ornaments = child(notations, "ornaments");

  if (has(technical, "hammer-on")) out.add("hammerOn");
  if (has(technical, "pull-off")) out.add("pullOff");
  if (has(technical, "tap")) out.add("tap");
  if (has(technical, "bend")) out.add("bend");
  if (has(notations, "slide") || has(notations, "glissando")) out.add("slide");
  const harmonic = child(technical, "harmonic");
  if (harmonic) out.add(has(harmonic, "artificial") ? "artificialHarmonic" : "naturalHarmonic");
  if (has(arts, "staccato")) out.add("staccato");
  if (has(arts, "accent") || has(arts, "strong-accent")) out.add("accent");
  if (has(ornaments, "wavy-line")) out.add("vibrato");
  if (has(ornaments, "tremolo")) out.add("tremolo");

  // Our own round trip: these have no standard element, so they went out as
  // `other-technical` and come back the same way.
  for (const other of children(technical, "other-technical")) {
    const label = other.text.trim().toLowerCase();
    if (label === "palm mute") out.add("palmMute");
    else if (label === "let ring") out.add("letRing");
    else if (label === "dead note") out.add("deadNote");
  }
  // A dead note written by another program is an X notehead and nothing else.
  if (childText(note, "notehead")?.trim().toLowerCase() === "x") out.add("deadNote");
  if (child(note, "notehead")?.attrs["parentheses"] === "yes") out.add("ghost");

  if (has(notations, "dynamics")) unsupported.add("dynamics");
  if (has(notations, "fermata")) unsupported.add("fermatas");
  if (has(notations, "arpeggiate")) unsupported.add("arpeggio marks");
  return [...out];
}

/**
 * A part's instrument, from its staff details.
 *
 * A `<staff-tuning>` list is the only reliable statement that a part is tablature.
 * Line 1 is the bottom line of the staff, which is the lowest string, so the list is
 * reversed into our order of highest string first.
 */
function instrumentOf(part: XmlNode, midiProgram: number): Instrument {
  const tunings = descendants(part, "staff-tuning");
  if (tunings.length >= 4) {
    const byLine = [...tunings].sort(
      (a, b) => Number(b.attrs["line"] ?? 0) - Number(a.attrs["line"] ?? 0),
    );
    const tuning: Tuning = [];
    for (const t of byLine) {
      const step = childText(t, "tuning-step");
      const octave = childNumber(t, "tuning-octave");
      if (step === undefined || octave === undefined) continue;
      const base = STEPS[step.toUpperCase()];
      if (base === undefined) continue;
      tuning.push((octave + 1) * 12 + base + (childNumber(t, "tuning-alter") ?? 0));
    }
    if (tuning.length >= 4) {
      const capo = descendants(part, "capo").map((c) => Number(c.text.trim()) || 0)[0] ?? 0;
      // 24 frets rather than a number read from the file: MusicXML has no place to
      // state a fret count, and 24 is the range that holds every note a file can
      // contain rather than a guess that might reject one.
      return { kind: "fretted", tuning, frets: 24, capo };
    }
  }
  return { kind: "pitched", midiProgram };
}

/** The MIDI program a part declares, 0-based. */
function programOf(scorePart: XmlNode | undefined): number {
  const stated = childNumber(child(scorePart, "midi-instrument"), "midi-program");
  return stated === undefined ? 0 : Math.max(0, Math.min(127, Math.round(stated) - 1));
}

/**
 * One event in a measure: notes that sound together at a tick, in a voice.
 *
 * Built by walking the measure with a clock rather than by reading notes in order,
 * because `<backup>` and `<forward>` mean order and time are different things.
 */
interface Event {
  tick: number;
  ticks: number;
  voice: string;
  node: XmlNode;
  notes: Note[];
  /** Chord symbol from the harmony element preceding this event's notes. */
  chord?: string;
}

/**
 * A harmony element back into the symbol a writer would type.
 *
 * The `text` attribute wins when present, because it is the exact suffix the source
 * carried — our own exports put it there, and so does MuseScore. The kind enum is the
 * fallback vocabulary for files that state only that.
 */
const KIND_SUFFIX: Record<string, string> = {
  major: "",
  minor: "m",
  dominant: "7",
  "major-seventh": "maj7",
  "minor-seventh": "m7",
  "major-sixth": "6",
  "minor-sixth": "m6",
  diminished: "dim",
  "diminished-seventh": "dim7",
  "half-diminished": "m7b5",
  augmented: "aug",
  "suspended-fourth": "sus4",
  "suspended-second": "sus2",
  power: "5",
  "dominant-ninth": "9",
  "major-ninth": "maj9",
  "minor-ninth": "m9",
  "dominant-11th": "11",
  "dominant-13th": "13",
  "major-13th": "maj13",
};

function harmonySymbol(node: XmlNode): string | null {
  const root = child(node, "root");
  const step = childText(root, "root-step");
  if (!step) return null;
  const alter = childNumber(root, "root-alter") ?? 0;
  const accidental = alter > 0 ? "#".repeat(alter) : "b".repeat(-alter);
  const kind = child(node, "kind");
  const suffix = kind?.attrs["text"] ?? KIND_SUFFIX[kind?.text.trim() ?? "major"] ?? "";
  const bass = child(node, "bass");
  const bassStep = childText(bass, "bass-step");
  const bassAlter = childNumber(bass, "bass-alter") ?? 0;
  const bassText = bassStep
    ? `/${bassStep}${bassAlter > 0 ? "#".repeat(bassAlter) : "b".repeat(-bassAlter)}`
    : "";
  return `${step}${accidental}${suffix}${bassText}`;
}

function readMeasure(
  measure: XmlNode,
  scale: number,
  unsupported: Set<string>,
): { events: Event[]; ticks: number } {
  const events: Event[] = [];
  let tick = 0;
  let last: Event | undefined;
  /** A harmony read but not yet attached: it applies to the next event that starts. */
  let pendingChord: string | null = null;

  for (const node of measure.children) {
    if (node.name === "harmony") {
      pendingChord = harmonySymbol(node);
      continue;
    }
    if (node.name === "backup") {
      tick = Math.max(0, tick - Math.round((childNumber(node, "duration") ?? 0) * scale));
      last = undefined;
      continue;
    }
    if (node.name === "forward") {
      tick += Math.round((childNumber(node, "duration") ?? 0) * scale);
      last = undefined;
      continue;
    }
    if (node.name !== "note") continue;

    const ticks = Math.round((childNumber(node, "duration") ?? 0) * scale);
    const voice = childText(node, "voice") ?? "1";
    const isChord = has(node, "chord");
    const isRest = has(node, "rest");

    if (has(node, "grace")) {
      // A grace note has no duration and cannot be placed on our grid. Dropping it is
      // better than giving it a duration the file does not claim it has.
      unsupported.add("grace notes");
      continue;
    }

    if (isChord && last) {
      // Sounds with the previous note rather than after it, so the clock does not move.
      const note = noteOf(node, unsupported);
      if (note) last.notes.push(note);
      continue;
    }

    const event: Event = { tick, ticks, voice, node, notes: [] };
    if (pendingChord !== null) {
      event.chord = pendingChord;
      pendingChord = null;
    }
    if (!isRest) {
      const note = noteOf(node, unsupported);
      if (note) event.notes.push(note);
    }
    events.push(event);
    last = event;
    tick += ticks;
  }

  const ticks = events.reduce((n, e) => Math.max(n, e.tick + e.ticks), 0);
  return { events, ticks };
}

function noteOf(node: XmlNode, unsupported: Set<string>): Note | undefined {
  const pitch = pitchOf(child(node, "pitch"));
  if (pitch === undefined) {
    // Unpitched percussion. The model has drum tracks but MusicXML's
    // `<unpitched>` names a display position rather than a drum voice, and mapping
    // one to the other is guesswork we would rather report than perform.
    if (has(node, "unpitched")) unsupported.add("unpitched percussion");
    return undefined;
  }
  const technical = child(child(node, "notations"), "technical");
  const string = childNumber(technical, "string");
  const fret = childNumber(technical, "fret");
  const tied = children(node, "tie").some((t) => t.attrs["type"] === "start");

  return {
    id: nextId("n"),
    pitch,
    ...(string !== undefined ? { string } : {}),
    ...(fret !== undefined ? { fret } : {}),
    ...(tied ? { tiedToNext: true } : {}),
    articulations: articulationsOf(node, unsupported),
  };
}

/**
 * Events of one voice as a run of beats, with rests filling any gap.
 *
 * A gap happens whenever a file states a voice that does not start at the beginning of
 * the measure, which is normal in a piano part. Filling it with rests is what keeps the
 * voice's notes at the right moment; leaving it out would slide them earlier.
 */
function beatsOf(events: Event[], barTicks: number): Beat[] {
  const beats: Beat[] = [];
  let at = 0;
  for (const event of [...events].sort((a, b) => a.tick - b.tick)) {
    if (event.tick > at) {
      beats.push(restFor(event.tick - at));
      at = event.tick;
    }
    // Two events at the same tick in the same voice cannot both be written; the
    // second is a file saying something contradictory, and the note keeps its place.
    if (event.tick < at) continue;
    const value = valueOf(event.node, event.ticks);
    const lyric = childText(child(event.node, "lyric"), "text");
    beats.push({
      id: nextId("b"),
      duration: value.duration,
      dots: value.dots,
      ...(value.tuplet ? { tuplet: value.tuplet } : {}),
      ...(event.chord !== undefined ? { chord: event.chord } : {}),
      ...(lyric !== undefined && lyric !== "" ? { lyric } : {}),
      notes: event.notes,
    });
    at = event.tick + event.ticks;
  }
  if (at < barTicks) beats.push(restFor(barTicks - at));
  return beats;
}

/** A rest of a given tick length, as the closest single written value. */
function restFor(ticks: number): Beat {
  const whole = QUARTER_TICKS * 4;
  const denominator = ticks > 0 ? 2 ** Math.round(Math.log2(whole / ticks)) : 4;
  return {
    id: nextId("b"),
    duration: durationOf(Math.min(128, Math.max(1, denominator))),
    dots: 0,
    notes: [],
  };
}

/**
 * Reads a MusicXML document.
 *
 * Throws only when the file is not MusicXML at all. Anything else is carried as far as
 * the model allows and reported, because a partial import a user can see and fix beats
 * a refusal they cannot.
 */
export function fromMusicXml(source: string): MusicXmlImportResult {
  const unsupported = new Set<string>();
  const root = parseXml(source);

  if (root.name === "score-timewise") {
    throw new Error(
      "This is a timewise MusicXML file. CubScore reads the partwise form, which is what every " +
        "notation program writes; re-export it as MusicXML (partwise).",
    );
  }
  // A .mxl is a zip and cannot be handed here as text, so say so rather than failing
  // on binary noise.
  if (root.name !== "score-partwise") {
    throw new Error(`Not a MusicXML score: the document's root element is <${root.name}>.`);
  }

  const title =
    childText(child(root, "work"), "work-title") ||
    children(root, "movement-title")[0]?.text.trim() ||
    "Untitled";
  const artist =
    children(child(root, "identification"), "creator").find((c) => c.attrs["type"] === "composer")?.text.trim() ??
    children(child(root, "identification"), "creator")[0]?.text.trim() ??
    "";

  const partList = child(root, "part-list");
  const scoreParts = new Map<string, XmlNode>();
  for (const p of children(partList, "score-part")) {
    const id = p.attrs["id"];
    if (id) scoreParts.set(id, p);
  }

  const tracks: Track[] = [];
  let noteCount = 0;
  let frettedCount = 0;

  for (const part of children(root, "part")) {
    const partId = part.attrs["id"] ?? "";
    const scorePart = scoreParts.get(partId);
    const name = childText(scorePart, "part-name") || `Part ${tracks.length + 1}`;
    const instrument = instrumentOf(part, programOf(scorePart));
    if (instrument.kind === "fretted") frettedCount += 1;

    const measures = children(part, "measure");
    if (descendants(part, "staff").some((s) => Number(s.text.trim()) > 1)) {
      unsupported.add("multi-staff parts (both staves are read into one)");
    }

    let divisions = 1;
    let meter: TimeSignature | undefined;
    let key: KeySignature | undefined;
    const bars: Bar[] = [];

    for (const measure of measures) {
      const attributes = child(measure, "attributes");
      const statedDivisions = childNumber(attributes, "divisions");
      if (statedDivisions !== undefined && statedDivisions > 0) divisions = statedDivisions;
      const scale = scaleFor(divisions);

      const time = child(attributes, "time");
      const beats = childNumber(time, "beats");
      const beatType = childNumber(time, "beat-type");
      const newMeter =
        beats !== undefined && beatType !== undefined ? { beats, beatValue: beatType } : undefined;
      if (newMeter) meter = newMeter;

      const keyNode = child(attributes, "key");
      const fifths = childNumber(keyNode, "fifths");
      const newKey: KeySignature | undefined =
        fifths === undefined
          ? undefined
          : { fifths, mode: childText(keyNode, "mode") === "minor" ? "minor" : "major" };
      if (newKey) key = newKey;

      const impliedTicks = meter
        ? Math.round((QUARTER_TICKS * 4 * meter.beats) / meter.beatValue)
        : QUARTER_TICKS * 4;
      const { events, ticks } = readMeasure(measure, scale, unsupported);
      const barTicks = Math.max(impliedTicks, ticks);

      const byVoice = new Map<string, Event[]>();
      for (const event of events) {
        const list = byVoice.get(event.voice) ?? [];
        list.push(event);
        byVoice.set(event.voice, list);
      }
      if (byVoice.size === 0) byVoice.set("1", []);

      const voices: Voice[] = [...byVoice.entries()]
        // Numeric voice order, so voice 2 is the second voice and not the tenth.
        .sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0))
        .map(([, list]) => ({ id: nextId("v"), beats: beatsOf(list, barTicks) }));
      for (const voice of voices) {
        for (const beat of voice.beats) noteCount += beat.notes.length;
      }

      const bar: Bar = { id: nextId("m"), voices };
      if (newMeter) bar.timeSignature = newMeter;
      if (newKey) bar.keySignature = newKey;

      const tempo = descendants(measure, "sound")
        .map((s) => Number(s.attrs["tempo"] ?? ""))
        .find((t) => Number.isFinite(t) && t > 0);
      if (tempo !== undefined) bar.tempoBpm = Math.round(tempo);

      const rehearsal = descendants(measure, "rehearsal")[0]?.text.trim();
      if (rehearsal) bar.section = rehearsal;

      const barlines = children(measure, "barline");
      for (const barline of barlines) {
        const repeat = child(barline, "repeat");
        if (!repeat) continue;
        if (repeat.attrs["direction"] === "forward") bar.repeat = { ...bar.repeat, start: true };
        if (repeat.attrs["direction"] === "backward") {
          const times = Number(repeat.attrs["times"] ?? "2");
          bar.repeat = { ...bar.repeat, endCount: Number.isFinite(times) && times > 1 ? times : 2 };
        }
        if (has(barline, "ending")) unsupported.add("alternate endings");
      }

      bars.push(bar);
    }

    tracks.push({ id: nextId("t"), name, instrument, bars });
  }

  for (const name of [
    ["words", "text directions"],
    ["wedge", "hairpin dynamics"],
    ["slur", "slurs"],
    ["pedal", "pedal marks"],
    ["octave-shift", "octave shifts"],
  ] as const) {
    if (descendants(root, name[0]).length > 0) unsupported.add(name[1]);
  }

  const barCount = Math.max(0, ...tracks.map((t) => t.bars.length));
  return {
    score: {
      id: nextId("s"),
      title,
      artist,
      tracks,
      revision: 0,
    },
    report: {
      unsupported: [...unsupported].sort(),
      trackCount: tracks.length,
      barCount,
      noteCount,
      frettedCount,
    },
  };
}
