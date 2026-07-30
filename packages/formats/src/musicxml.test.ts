/**
 * MusicXML, both directions.
 *
 * The pair is tested as a pair, because that is the only way a format either half of
 * which we wrote can be checked at all: a writer graded against its own reader agrees
 * with itself by construction and proves nothing on its own. So the round trip is the
 * spine of this file, and beside it sit the claims a round trip cannot make — that the
 * bytes are the shape MusicXML says, and that files we did not write are read the way
 * their authors meant.
 *
 * The cases that earn their place are the ones where MusicXML is unlike our model:
 * `<backup>` means order and time are different things, `<chord/>` is marked on the
 * second note rather than the first, and `<divisions>` is whatever the file felt like.
 * Each of those is a way an import silently mangles a piano part.
 */
import { describe, expect, it } from "vitest";
import {
  createScore,
  createTrack,
  duration,
  frettedGuitar,
  nextId,
  QUARTER_TICKS,
  STANDARD_BASS,
  type Bar,
  type Beat,
  type Instrument,
  type Note,
  type Score,
  type Voice,
} from "@cubscore/core";
import { fromMusicXml } from "./from-musicxml.js";
import { toMusicXml } from "./to-musicxml.js";
import { child, childNumber, childText, children, descendants, has, parseXml } from "./xml.js";

/** A note with a fingering, the way a fretted staff holds one. */
function note(pitch: number, string?: number, fret?: number, extra: Partial<Note> = {}): Note {
  return {
    id: nextId("n"),
    pitch,
    ...(string === undefined ? {} : { string }),
    ...(fret === undefined ? {} : { fret }),
    articulations: [],
    ...extra,
  };
}

function beat(notes: Note[], denominator = 4, extra: Partial<Beat> = {}): Beat {
  return { id: nextId("b"), duration: duration(denominator), dots: 0, notes, ...extra };
}

function voice(beats: Beat[]): Voice {
  return { id: nextId("v"), beats };
}

function bar(voices: Voice[], extra: Partial<Bar> = {}): Bar {
  return { id: nextId("m"), voices, ...extra };
}

/** A one-track score built from bars, with a tempo on the first. */
function scoreOf(bars: Bar[], instrument: Instrument = frettedGuitar(), name = "Guitar"): Score {
  const first = bars[0];
  if (first && first.tempoBpm === undefined) first.tempoBpm = 120;
  return {
    ...createScore("Test piece"),
    artist: "Someone",
    tracks: [{ id: nextId("t"), name, instrument, bars }],
  };
}

/** Every note of a score's first track, in written order. */
function notesOf(score: Score, trackIndex = 0) {
  return (score.tracks[trackIndex]?.bars ?? []).flatMap((b) =>
    b.voices.flatMap((v) => v.beats.flatMap((beat) => beat.notes)),
  );
}

/** Writes and reads back, which is the operation a user performs across two apps. */
function roundTrip(score: Score) {
  const written = toMusicXml(score);
  const read = fromMusicXml(written.text);
  return { written, ...read };
}

const SCALE = scoreOf([
  bar([voice([beat([note(64, 1, 0)]), beat([note(66, 1, 2)]), beat([note(67, 1, 3)]), beat([note(69, 1, 5)])])]),
]);

describe("the document a reader receives", () => {
  it("is a partwise score with a version and a work title", () => {
    const root = parseXml(toMusicXml(SCALE).text);
    expect(root.name).toBe("score-partwise");
    expect(root.attrs["version"]).toBe("4.0");
    expect(childText(child(root, "work"), "work-title")).toBe("Test piece");
  });

  it("declares our own tick clock as its divisions, so no duration is converted", () => {
    // 960 is QUARTER_TICKS. Any other value means every duration in the file went
    // through a division and a rounding, and tuplets are where that shows up.
    const root = parseXml(toMusicXml(SCALE).text);
    expect(childNumber(child(descendants(root, "measure")[0], "attributes"), "divisions")).toBe(QUARTER_TICKS);
  });

  it("names the part, and gives it a program a synth can use", () => {
    const root = parseXml(toMusicXml(SCALE).text);
    const scorePart = descendants(root, "score-part")[0];
    expect(childText(scorePart, "part-name")).toBe("Guitar");
    // MusicXML programs are 1-based; 25 zero-based is the acoustic guitar.
    expect(childNumber(child(scorePart, "midi-instrument"), "midi-program")).toBe(26);
  });

  it("states divisions once, in the first measure only", () => {
    // Restating it is legal and makes some readers reset their clock mid-score.
    const two = scoreOf([
      bar([voice([beat([note(64, 1, 0)])])]),
      bar([voice([beat([note(67, 1, 3)])])], { timeSignature: { beats: 3, beatValue: 4 } }),
    ]);
    const measures = descendants(parseXml(toMusicXml(two).text), "measure");
    expect(childNumber(child(measures[0], "attributes"), "divisions")).toBe(QUARTER_TICKS);
    expect(childNumber(child(measures[1], "attributes"), "divisions")).toBeUndefined();
  });

  it("writes the same bytes twice, so a file can be diffed", () => {
    expect(toMusicXml(SCALE).text).toBe(toMusicXml(SCALE).text);
  });

  it("carries an encoding date only when it is given one", () => {
    expect(toMusicXml(SCALE).text).not.toContain("encoding-date");
    expect(toMusicXml(SCALE, { encodedOn: "2026-07-30" }).text).toContain(
      "<encoding-date>2026-07-30</encoding-date>",
    );
  });
});

describe("tablature is written as tablature", () => {
  it("states the staff's tuning, lowest string on line 1", () => {
    // The half most MusicXML exporters skip. Without it the receiving program has
    // fret numbers and no way to know what string 1 is, so it falls back to pitches.
    const root = parseXml(toMusicXml(SCALE).text);
    const tunings = descendants(root, "staff-tuning");
    expect(tunings).toHaveLength(6);
    expect(tunings.map((t) => t.attrs["line"])).toEqual(["1", "2", "3", "4", "5", "6"]);
    // Line 1 is the bottom line, which is the low E.
    expect(childText(tunings[0], "tuning-step")).toBe("E");
    expect(childNumber(tunings[0], "tuning-octave")).toBe(2);
    expect(childText(tunings[5], "tuning-step")).toBe("E");
    expect(childNumber(tunings[5], "tuning-octave")).toBe(4);
  });

  it("uses a TAB clef with one line per string", () => {
    const clef = descendants(parseXml(toMusicXml(SCALE).text), "clef")[0];
    expect(childText(clef, "sign")).toBe("TAB");
    expect(childNumber(clef, "line")).toBe(6);
  });

  it("puts the string and fret on every note", () => {
    const root = parseXml(toMusicXml(SCALE).text);
    const technical = descendants(root, "technical");
    expect(technical).toHaveLength(4);
    expect(technical.map((t) => childNumber(t, "fret"))).toEqual([0, 2, 3, 5]);
    expect(technical.every((t) => childNumber(t, "string") === 1)).toBe(true);
  });

  it("writes a bass with four strings, not six", () => {
    const bass: Instrument = { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 };
    const root = parseXml(toMusicXml(scoreOf([bar([voice([beat([note(43, 1, 0)])])])], bass, "Bass")).text);
    expect(descendants(root, "staff-tuning")).toHaveLength(4);
    expect(childNumber(descendants(root, "clef")[0], "line")).toBe(4);
  });

  it("gives a staff with no strings a treble clef and no tuning", () => {
    const piano: Instrument = { kind: "pitched", midiProgram: 0 };
    const root = parseXml(toMusicXml(scoreOf([bar([voice([beat([note(60)])])])], piano, "Piano")).text);
    expect(descendants(root, "staff-tuning")).toHaveLength(0);
    expect(childText(descendants(root, "clef")[0], "sign")).toBe("G");
  });

  it("records a capo where there is one", () => {
    const capoed: Instrument = { ...frettedGuitar(), capo: 2 } as Instrument;
    const root = parseXml(toMusicXml(scoreOf([bar([voice([beat([note(66, 1, 0)])])])], capoed)).text);
    expect(childNumber(descendants(root, "staff-details")[0], "capo")).toBe(2);
  });
});

describe("chords, rests and voices", () => {
  it("marks the second and third notes of a chord, not the first", () => {
    // Backwards from how it reads: MusicXML's <chord/> means "sounds with the
    // previous note", so the first note of a chord is the one without it.
    const chord = scoreOf([bar([voice([beat([note(52, 6, 0), note(59, 5, 2), note(64, 4, 2)])])])]);
    const notes = descendants(parseXml(toMusicXml(chord).text), "note");
    expect(notes).toHaveLength(3);
    expect(has(notes[0], "chord")).toBe(false);
    expect(has(notes[1], "chord")).toBe(true);
    expect(has(notes[2], "chord")).toBe(true);
  });

  it("orders a chord from the low string up", () => {
    const chord = scoreOf([bar([voice([beat([note(64, 4, 2), note(52, 6, 0), note(59, 5, 2)])])])]);
    const notes = descendants(parseXml(toMusicXml(chord).text), "note");
    expect(notes.map((n) => childNumber(child(child(n, "notations"), "technical"), "string"))).toEqual([6, 5, 4]);
  });

  it("writes a rest as a rest with a duration", () => {
    const withRest = scoreOf([bar([voice([beat([note(64, 1, 0)]), beat([])])])]);
    const notes = descendants(parseXml(toMusicXml(withRest).text), "note");
    expect(has(notes[1], "rest")).toBe(true);
    expect(childNumber(notes[1], "duration")).toBe(QUARTER_TICKS);
  });

  it("winds the clock back between voices", () => {
    // Without <backup> the second voice would be appended after the first, and a
    // two-voice bar would come out twice as long with the parts one after the other.
    const two = scoreOf([
      bar([
        voice([beat([note(64, 1, 0)]), beat([note(66, 1, 2)])]),
        voice([beat([note(52, 6, 0)], 2)]),
      ]),
    ]);
    const measure = descendants(parseXml(toMusicXml(two).text), "measure")[0]!;
    const backup = child(measure, "backup");
    expect(backup).toBeDefined();
    expect(childNumber(backup, "duration")).toBe(2 * QUARTER_TICKS);
  });
});

describe("what the notation says", () => {
  it("writes a tie on both notes and a tied notation on both", () => {
    const tied = scoreOf([
      bar([voice([beat([note(64, 1, 0, { tiedToNext: true })]), beat([note(64, 1, 0)])])]),
    ]);
    const notes = descendants(parseXml(toMusicXml(tied).text), "note");
    expect(children(notes[0]!, "tie").map((t) => t.attrs["type"])).toEqual(["start"]);
    expect(children(notes[1]!, "tie").map((t) => t.attrs["type"])).toEqual(["stop"]);
    expect(children(child(notes[0]!, "notations"), "tied").map((t) => t.attrs["type"])).toEqual(["start"]);
  });

  it("writes a tuplet as a time modification", () => {
    const triplet = scoreOf([
      bar([voice([beat([note(64, 1, 0)], 8, { tuplet: { actual: 3, normal: 2 } })])]),
    ]);
    const mod = descendants(parseXml(toMusicXml(triplet).text), "time-modification")[0];
    expect(childNumber(mod, "actual-notes")).toBe(3);
    expect(childNumber(mod, "normal-notes")).toBe(2);
  });

  it("writes repeat barlines rather than expanding the section", () => {
    // MusicXML is a document format. The MIDI export writes a performance and
    // expands; this writes the sign, because a reader is a person.
    const repeated = scoreOf([
      bar([voice([beat([note(64, 1, 0)])])], { repeat: { start: true } }),
      bar([voice([beat([note(67, 1, 3)])])], { repeat: { endCount: 3 } }),
    ]);
    const root = parseXml(toMusicXml(repeated).text);
    const repeats = descendants(root, "repeat");
    expect(repeats.map((r) => r.attrs["direction"])).toEqual(["forward", "backward"]);
    expect(repeats[1]?.attrs["times"]).toBe("3");
    // And the notes are written once each, not three times.
    expect(descendants(root, "note")).toHaveLength(2);
  });

  it("writes the tempo where it changes, as a mark and as a sound", () => {
    // The mark is for a person and the sound is for a synth. Writing only the
    // metronome mark makes a file that looks right and plays at 120.
    const root = parseXml(toMusicXml(SCALE).text);
    expect(childNumber(descendants(root, "metronome")[0], "per-minute")).toBe(120);
    expect(descendants(root, "sound")[0]?.attrs["tempo"]).toBe("120");
  });

  it("spells a note with flats in a flat key", () => {
    // A reader handed A# in the key of F has to work out what was meant.
    const flat = scoreOf([
      bar([voice([beat([note(70, 1, 6)])])], { keySignature: { fifths: -1, mode: "major" } }),
    ]);
    const pitch = descendants(parseXml(toMusicXml(flat).text), "pitch")[0];
    expect(childText(pitch, "step")).toBe("B");
    expect(childNumber(pitch, "alter")).toBe(-1);
  });

  it("spells it with sharps in a sharp key", () => {
    const sharp = scoreOf([
      bar([voice([beat([note(70, 1, 6)])])], { keySignature: { fifths: 2, mode: "major" } }),
    ]);
    const pitch = descendants(parseXml(toMusicXml(sharp).text), "pitch")[0];
    expect(childText(pitch, "step")).toBe("A");
    expect(childNumber(pitch, "alter")).toBe(1);
  });

  it("says plainly that a bend's depth was assumed", () => {
    const bent = scoreOf([bar([voice([beat([note(64, 1, 0, { articulations: ["bend"] })])])])]);
    const { text, report } = toMusicXml(bent);
    expect(text).toContain("<bend-alter>2</bend-alter>");
    expect(report.unsupported.join(" ")).toMatch(/bend depth/);
  });
});

describe("a file that comes back", () => {
  it("keeps every pitch, string and fret", () => {
    const { score, report } = roundTrip(SCALE);
    expect(report.noteCount).toBe(4);
    expect(notesOf(score).map((n) => [n.pitch, n.string, n.fret])).toEqual([
      [64, 1, 0],
      [66, 1, 2],
      [67, 1, 3],
      [69, 1, 5],
    ]);
  });

  it("keeps the instrument, so a guitar comes back a guitar", () => {
    const { score, report } = roundTrip(SCALE);
    const instrument = score.tracks[0]?.instrument;
    expect(instrument?.kind).toBe("fretted");
    expect(instrument?.kind === "fretted" && instrument.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(report.frettedCount).toBe(1);
  });

  it("keeps the title, the composer and the part name", () => {
    const { score } = roundTrip(SCALE);
    expect(score.title).toBe("Test piece");
    expect(score.artist).toBe("Someone");
    expect(score.tracks[0]?.name).toBe("Guitar");
  });

  it("keeps note values, dots and tuplets", () => {
    const mixed = scoreOf([
      bar([
        voice([
          beat([note(64, 1, 0)], 2, { dots: 1 }),
          beat([note(66, 1, 2)], 8),
          beat([note(67, 1, 3)], 8, { tuplet: { actual: 3, normal: 2 } }),
        ]),
      ]),
    ]);
    const { score } = roundTrip(mixed);
    const beats = score.tracks[0]!.bars[0]!.voices[0]!.beats;
    expect(beats[0]?.duration.denominator).toBe(2);
    expect(beats[0]?.dots).toBe(1);
    expect(beats[1]?.duration.denominator).toBe(8);
    expect(beats[2]?.tuplet).toEqual({ actual: 3, normal: 2 });
  });

  it("keeps a tie as a tie and not as two notes", () => {
    const tied = scoreOf([
      bar([voice([beat([note(64, 1, 0, { tiedToNext: true })]), beat([note(64, 1, 0)])])]),
    ]);
    const { score } = roundTrip(tied);
    const notes = notesOf(score);
    expect(notes[0]?.tiedToNext).toBe(true);
    expect(notes[1]?.tiedToNext).toBeUndefined();
  });

  it("keeps two voices as two voices", () => {
    const two = scoreOf([
      bar([
        voice([beat([note(64, 1, 0)]), beat([note(66, 1, 2)]), beat([note(67, 1, 3)]), beat([note(69, 1, 5)])]),
        voice([beat([note(52, 6, 0)], 2), beat([note(55, 6, 3)], 2)]),
      ]),
    ]);
    const { score } = roundTrip(two);
    const voices = score.tracks[0]!.bars[0]!.voices;
    expect(voices).toHaveLength(2);
    expect(voices[0]!.beats.flatMap((b) => b.notes).map((n) => n.pitch)).toEqual([64, 66, 67, 69]);
    expect(voices[1]!.beats.flatMap((b) => b.notes).map((n) => n.pitch)).toEqual([52, 55]);
  });

  it("keeps meter, key and tempo", () => {
    const marked = scoreOf([
      bar([voice([beat([note(64, 1, 0)], 4), beat([note(66, 1, 2)], 4), beat([note(67, 1, 3)], 4)])], {
        timeSignature: { beats: 3, beatValue: 4 },
        keySignature: { fifths: -2, mode: "minor" },
        tempoBpm: 96,
      }),
    ]);
    const { score } = roundTrip(marked);
    const first = score.tracks[0]!.bars[0]!;
    expect(first.timeSignature).toEqual({ beats: 3, beatValue: 4 });
    expect(first.keySignature).toEqual({ fifths: -2, mode: "minor" });
    expect(first.tempoBpm).toBe(96);
  });

  it("keeps repeats as marks", () => {
    const repeated = scoreOf([
      bar([voice([beat([note(64, 1, 0)])])], { repeat: { start: true } }),
      bar([voice([beat([note(67, 1, 3)])])], { repeat: { endCount: 3 } }),
    ]);
    const { score } = roundTrip(repeated);
    expect(score.tracks[0]?.bars[0]?.repeat?.start).toBe(true);
    expect(score.tracks[0]?.bars[1]?.repeat?.endCount).toBe(3);
  });

  it("keeps a chord's notes on their own strings", () => {
    const chord = scoreOf([bar([voice([beat([note(52, 6, 0), note(59, 5, 2), note(64, 4, 2)])])])]);
    const { score } = roundTrip(chord);
    const beats = score.tracks[0]!.bars[0]!.voices[0]!.beats;
    expect(beats[0]?.notes).toHaveLength(3);
    expect(beats[0]?.notes.map((n) => n.string)).toEqual([6, 5, 4]);
  });

  it("keeps every articulation the format has a name for", () => {
    const marks = [
      "hammerOn", "pullOff", "tap", "bend", "slide", "naturalHarmonic",
      "artificialHarmonic", "staccato", "accent", "vibrato", "tremolo",
      "palmMute", "letRing", "deadNote",
    ] as const;
    const decorated = scoreOf([
      bar([voice(marks.map((a) => beat([note(64, 1, 0, { articulations: [a] })], 16)))]),
    ]);
    const { score } = roundTrip(decorated);
    const read = notesOf(score).map((n) => n.articulations);
    for (const [i, mark] of marks.entries()) {
      expect(read[i], `${mark} survived the round trip`).toContain(mark);
    }
  });

  it("keeps several tracks, each with its own instrument", () => {
    const band: Score = {
      ...createScore("Band"),
      tracks: [
        { id: nextId("t"), name: "Guitar", instrument: frettedGuitar(), bars: [bar([voice([beat([note(64, 1, 0)])])], { tempoBpm: 120 })] },
        { id: nextId("t"), name: "Bass", instrument: { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, bars: [bar([voice([beat([note(43, 1, 0)])])])] },
        { id: nextId("t"), name: "Piano", instrument: { kind: "pitched", midiProgram: 0 }, bars: [bar([voice([beat([note(60)])])])] },
      ],
    };
    const { score, report } = roundTrip(band);
    expect(report.trackCount).toBe(3);
    expect(score.tracks.map((t) => t.name)).toEqual(["Guitar", "Bass", "Piano"]);
    expect(score.tracks.map((t) => t.instrument.kind)).toEqual(["fretted", "fretted", "pitched"]);
    expect(report.frettedCount).toBe(2);
  });
});

describe("files we did not write", () => {
  /** A minimal MusicXML document around one part's measures. */
  function file(measures: string, attributes = "<divisions>1</divisions>"): string {
    return `<?xml version="1.0"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes>${attributes}</attributes>${measures}</measure>
  </part>
</score-partwise>`;
  }

  const quarter = (step: string, octave: number) =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>1</duration><type>quarter</type></note>`;

  it("scales durations from whatever divisions the file chose", () => {
    // Divisions of 1 means a quarter note has duration 1. A reader that assumed its
    // own clock would read every quarter note as a thousandth of one.
    const { score } = fromMusicXml(file(quarter("C", 4) + quarter("D", 4)));
    const beats = score.tracks[0]!.bars[0]!.voices[0]!.beats;
    expect(beats[0]?.duration.denominator).toBe(4);
    expect(beats.slice(0, 2).flatMap((b) => b.notes).map((n) => n.pitch)).toEqual([60, 62]);
  });

  it("reads an alteration, so C sharp is not C", () => {
    const { score } = fromMusicXml(
      file(`<note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration></note>`),
    );
    expect(notesOf(score)[0]?.pitch).toBe(61);
  });

  it("places a chord's later notes with the first, not after it", () => {
    const { score } = fromMusicXml(
      file(
        `<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>` +
          `<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>` +
          `<note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>`,
      ),
    );
    const beats = score.tracks[0]!.bars[0]!.voices[0]!.beats;
    expect(beats[0]?.notes.map((n) => n.pitch)).toEqual([60, 64, 67]);
    expect(beats.filter((b) => b.notes.length > 0)).toHaveLength(1);
  });

  it("follows backup, so a two-voice bar is two voices and not a longer one", () => {
    // The most common way MusicXML import goes wrong. Without backup this reads as
    // one voice of eight quarters, and the left hand plays after the right hand.
    const { score } = fromMusicXml(
      file(
        `<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>` +
          `<note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>` +
          `<backup><duration>4</duration></backup>` +
          `<note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>whole</type></note>`,
      ),
    );
    const voices = score.tracks[0]!.bars[0]!.voices;
    expect(voices).toHaveLength(2);
    expect(voices[0]!.beats.flatMap((b) => b.notes).map((n) => n.pitch)).toEqual([72, 74]);
    expect(voices[1]!.beats.flatMap((b) => b.notes).map((n) => n.pitch)).toEqual([48]);
  });

  it("fills a gap a forward leaves, so a late voice stays late", () => {
    const { score } = fromMusicXml(
      file(
        `<forward><duration>2</duration></forward>` +
          `<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>`,
      ),
    );
    const beats = score.tracks[0]!.bars[0]!.voices[0]!.beats;
    // A rest first, then the note: the note is on beat three and stays there.
    expect(beats[0]?.notes).toHaveLength(0);
    expect(beats[1]?.notes.map((n) => n.pitch)).toEqual([60]);
  });

  it("recovers a note value from its duration when the file omits the type", () => {
    // Scanners and some exporters write duration and no type at all.
    const { score } = fromMusicXml(
      file(`<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>`, "<divisions>4</divisions>"),
    );
    expect(score.tracks[0]!.bars[0]!.voices[0]!.beats[0]?.duration.denominator).toBe(8);
  });

  it("reads a tab staff's tuning into an instrument", () => {
    const tab = `<divisions>1</divisions><staff-details><staff-lines>6</staff-lines>
      <staff-tuning line="1"><tuning-step>E</tuning-step><tuning-octave>2</tuning-octave></staff-tuning>
      <staff-tuning line="2"><tuning-step>A</tuning-step><tuning-octave>2</tuning-octave></staff-tuning>
      <staff-tuning line="3"><tuning-step>D</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>
      <staff-tuning line="4"><tuning-step>G</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>
      <staff-tuning line="5"><tuning-step>B</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>
      <staff-tuning line="6"><tuning-step>E</tuning-step><tuning-octave>4</tuning-octave></staff-tuning>
      </staff-details><clef><sign>TAB</sign><line>6</line></clef>`;
    const { score, report } = fromMusicXml(file(quarter("E", 4), tab));
    const instrument = score.tracks[0]!.instrument;
    expect(instrument.kind).toBe("fretted");
    expect(instrument.kind === "fretted" && instrument.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(report.frettedCount).toBe(1);
  });

  it("leaves a part with no tuning pitched, rather than guessing at one", () => {
    const { score, report } = fromMusicXml(file(quarter("C", 4)));
    expect(score.tracks[0]?.instrument.kind).toBe("pitched");
    expect(report.frettedCount).toBe(0);
  });

  it("reads a glissando as a slide, which is what other programs write", () => {
    const { score } = fromMusicXml(
      file(
        `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>` +
          `<notations><glissando type="start"/></notations></note>`,
      ),
    );
    expect(notesOf(score)[0]?.articulations).toContain("slide");
  });

  it("reads an X notehead as a dead note even with no technical marks", () => {
    const { score } = fromMusicXml(
      file(`<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><notehead>x</notehead></note>`),
    );
    expect(notesOf(score)[0]?.articulations).toContain("deadNote");
  });

  it("drops a grace note and says so, rather than giving it a length", () => {
    const { score, report } = fromMusicXml(
      file(
        `<note><grace/><pitch><step>B</step><octave>3</octave></pitch></note>` + quarter("C", 4),
      ),
    );
    expect(notesOf(score).map((n) => n.pitch)).toEqual([60]);
    expect(report.unsupported).toContain("grace notes");
  });

  it("names what it could not carry", () => {
    const { report } = fromMusicXml(
      file(
        quarter("C", 4) +
          `<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>` +
          `<note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration>` +
          `<lyric><text>la</text></lyric><notations><slur type="start"/><dynamics><f/></dynamics></notations></note>`,
      ),
    );
    expect(report.unsupported).toContain("chord symbols");
    expect(report.unsupported).toContain("lyrics");
    expect(report.unsupported).toContain("slurs");
    expect(report.unsupported).toContain("dynamics");
  });

  it("reports unpitched percussion rather than inventing a drum", () => {
    const { report } = fromMusicXml(
      file(`<note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration></note>`),
    );
    expect(report.unsupported).toContain("unpitched percussion");
  });

  it("refuses a timewise file with an instruction, not a stack trace", () => {
    expect(() => fromMusicXml('<?xml version="1.0"?><score-timewise version="3.1"><measure/></score-timewise>')).toThrow(
      /partwise/,
    );
  });

  it("refuses something that is not a score at all", () => {
    expect(() => fromMusicXml("<html><body>hello</body></html>")).toThrow(/Not a MusicXML score/);
  });
});

describe("the XML parser underneath", () => {
  it("reads elements, attributes and text", () => {
    const root = parseXml('<a x="1" y="two"><b>text</b></a>');
    expect(root.name).toBe("a");
    expect(root.attrs).toEqual({ x: "1", y: "two" });
    expect(childText(root, "b")).toBe("text");
  });

  it("reads self-closing elements", () => {
    const root = parseXml('<a><b/><c n="1"/></a>');
    expect(root.children.map((c) => c.name)).toEqual(["b", "c"]);
    expect(child(root, "c")?.attrs["n"]).toBe("1");
  });

  it("resolves the entities MusicXML may contain", () => {
    const root = parseXml('<a t="&lt;&amp;&gt;">&quot;&apos;&#65;&#x42;</a>');
    expect(root.attrs["t"]).toBe("<&>");
    expect(root.text).toBe("\"'AB");
  });

  it("keeps CDATA literal", () => {
    expect(parseXml("<a><![CDATA[<not>&an;element]]></a>").text).toBe("<not>&an;element");
  });

  it("skips comments, processing instructions and a doctype", () => {
    const root = parseXml(
      '<?xml version="1.0"?><!DOCTYPE score-partwise PUBLIC "x" "y"><!-- note --><a><b/></a>',
    );
    expect(root.name).toBe("a");
    expect(root.children).toHaveLength(1);
  });

  it("skips a doctype with an internal subset", () => {
    // The brackets contain a '>' and a naive skip stops at it, leaving the parser
    // reading the middle of a declaration as markup.
    const root = parseXml('<!DOCTYPE a [<!ELEMENT a (b)> <!ELEMENT b EMPTY>]><a><b/></a>');
    expect(root.name).toBe("a");
  });

  it("handles a '>' inside an attribute value", () => {
    expect(parseXml('<a t="1 > 0"><b/></a>').attrs["t"]).toBe("1 > 0");
  });

  it("says where a mismatched tag is", () => {
    expect(() => parseXml("<a>\n<b></c>\n</a>")).toThrow(/closes <b> at 2,/);
  });

  it("refuses a truncated document rather than returning half of it", () => {
    expect(() => parseXml("<a><b>text")).toThrow(/still open/);
  });

  it("refuses a document with no elements", () => {
    expect(() => parseXml("just some words")).toThrow(/not an XML document/);
  });

  it("escapes what it writes, so a title with an ampersand survives", () => {
    const awkward: Score = { ...createScore('Rock & "Roll" <live>'), tracks: [createTrack("A & B", frettedGuitar(), 1)] };
    const round = roundTrip(awkward);
    expect(round.score.title).toBe('Rock & "Roll" <live>');
    expect(round.score.tracks[0]?.name).toBe("A & B");
  });
});
