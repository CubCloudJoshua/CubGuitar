/**
 * ASCII tablature, both directions.
 *
 * The round trip is the load-bearing test: what we write, we must read back to the
 * same strings and frets. That grades both halves at once with no alphaTab and no
 * browser. What it cannot grade is whether the output looks like a tab a person
 * would recognise, so the shape of the text is asserted directly too — string
 * labels, bar lines, proportional spacing — because a "tab" that round-trips
 * perfectly and looks like nothing anyone has seen is not the deliverable.
 *
 * The import tests are written against tab as it is actually found: inconsistent
 * bar lines, a missing string, prose about the tuning, lyrics mixed in.
 */
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  createNote,
  createScore,
  createTrack,
  duration,
  frettedGuitar,
  STANDARD_BASS,
  type Op,
  type OpBatch,
  type OpKind,
  type Score,
} from "@cubscore/core";
import { toAscii } from "./to-ascii.js";
import { fromAscii } from "./from-ascii.js";

let counter = 0;
function batch(...kinds: OpKind[]): OpBatch {
  counter += 1;
  return {
    id: `a-${counter}`,
    ops: kinds.map((kind): Op => {
      counter += 1;
      return { id: `a-op-${counter}`, author: "test", at: 0, ...kind };
    }),
  };
}

const OPEN = [64, 59, 55, 50, 45, 40];

function withNote(score: Score, bar: number, beat: number, string: number, fret: number): Score {
  const target = score.tracks[0]!.bars[bar]!.voices[0]!.beats[beat]!;
  return applyBatch(
    score,
    batch({
      type: "note.insert",
      beatId: target.id,
      note: createNote((OPEN[string - 1] ?? 64) + fret, string, fret),
    }),
  );
}

/** Every (string, fret) pair in the document, in order. */
function fingerings(score: Score): string[] {
  const out: string[] = [];
  for (const track of score.tracks) {
    for (const bar of track.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          // Within a beat, order is not meaningful, so sort for comparison.
          const cell = beat.notes
            .map((n) => `${n.string}/${n.fret}`)
            .sort()
            .join("+");
          if (cell) out.push(cell);
        }
      }
    }
  }
  return out;
}

function riff(): Score {
  let score = createScore("Test Riff", "Someone");
  score = withNote(score, 0, 0, 1, 0);
  score = withNote(score, 0, 1, 1, 3);
  score = withNote(score, 0, 2, 2, 5);
  score = withNote(score, 0, 3, 3, 12);
  score = withNote(score, 1, 0, 6, 7);
  return score;
}

describe("what the text looks like", () => {
  const text = () => toAscii(riff()).text;

  it("labels the strings the way a hand-written tab does", () => {
    const staff = toAscii(riff(), { width: 400 }).text.split("\n").filter((l) => /\|/.test(l));
    expect(staff).toHaveLength(6);
    // e B G D A E, high string first. Only the top string is lower case: both E
    // strings would otherwise carry the same label.
    expect(staff.map((l) => l.trim()[0])).toEqual(["e", "B", "G", "D", "A", "E"]);
  });

  it("puts the frets on the strings they belong to", () => {
    const staff = text().split("\n").filter((l) => /\|/.test(l));
    expect(staff[0]).toMatch(/0/);
    expect(staff[0]).toMatch(/3/);
    expect(staff[1]).toMatch(/5/);
    expect(staff[2]).toMatch(/12/);
    expect(staff[5]).toMatch(/7/);
    // And not on the ones they do not: string 4 has nothing in this riff.
    expect(staff[3]).not.toMatch(/[0-9]/);
  });

  it("separates bars with bar lines", () => {
    // Wide enough that the four bars stay on one system; wrapping is its own test.
    const staff = toAscii(riff(), { width: 400 }).text.split("\n").filter((l) => /\|/.test(l));
    expect(staff).toHaveLength(6);
    // The opening bar line, then one closing each of four bars.
    expect((staff[0]?.match(/\|/g) ?? []).length).toBe(5);
  });

  it("states the title, artist and tuning", () => {
    const out = text();
    expect(out).toMatch(/Test Riff/);
    expect(out).toMatch(/Someone/);
    expect(out).toMatch(/Tuning: E A D G B E/);
  });

  it("can be asked for the staff alone, with no header", () => {
    const bare = toAscii(riff(), { header: false, width: 400 }).text;
    expect(bare).not.toMatch(/Test Riff/);
    expect(bare).not.toMatch(/Tuning/);
    expect(bare.split("\n").filter((l) => /\|/.test(l))).toHaveLength(6);
  });

  it("spaces a bar of sixteenths wider than a bar of quarters", () => {
    // Spacing is the only rhythm information ASCII tab can carry, so a held note
    // must not look the same as a fast one.
    const quarters = createScore("Q");
    // Applied to `quarters` itself: built from a second createScore, the beat ids in
    // the ops would belong to a different document and every one would no-op,
    // leaving two identical scores and a test that passes on nothing.
    const fast = applyBatch(
      quarters,
      batch(
        ...quarters.tracks[0]!.bars[0]!.voices[0]!.beats.map(
          (b): OpKind => ({ type: "beat.setDuration", beatId: b.id, duration: duration(16) }),
        ),
      ),
    );
    // Compared with wrapping out of the way: at a fixed line width a narrower bar
    // simply means more bars per line and the same line length, which would make
    // this pass whatever the spacing did.
    const wide = toAscii(quarters, { header: false, width: 4000 }).text.split("\n")[0] ?? "";
    const narrow = toAscii(fast, { header: false, width: 4000 }).text.split("\n")[0] ?? "";
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it("wraps into systems rather than running off the line", () => {
    const long = createScore("Long", "", 32);
    const lines = toAscii(long, { width: 60, header: false }).text.split("\n").filter((l) => /\|/.test(l));
    // More than one system of six lines, and none of them over the width.
    expect(lines.length).toBeGreaterThan(6);
    expect(lines.every((l) => l.length <= 62)).toBe(true);
  });

  it("marks a repeat rather than writing the section out again", () => {
    // Unlike the MIDI export, which writes a performance, this writes notation: a
    // reader is a person who can follow a repeat sign.
    const score = structuredClone(riff());
    score.tracks[0]!.bars[0]!.repeat = { start: true };
    score.tracks[0]!.bars[1]!.repeat = { endCount: 2 };
    const out = toAscii(score, { header: false, width: 400 }).text;
    expect(out).toMatch(/\|:/);
    expect(out).toMatch(/:\|/);
    // Bar 1's fret 0 appears once, not twice.
    const first = out.split("\n")[0] ?? "";
    expect((first.match(/0/g) ?? []).length).toBe(1);
  });

  it("names each track when there is more than one", () => {
    const two = applyBatch(
      riff(),
      batch({ type: "track.insert", index: 1, track: createTrack("Bass", { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, 2) }),
    );
    const out = toAscii(two).text;
    expect(out).toMatch(/\[Guitar\]/);
    expect(out).toMatch(/\[Bass\]/);
    // And the bass gets four lines, not six.
    const blocks = out.split(/\[Bass\]/)[1] ?? "";
    expect(blocks.split("\n").filter((l) => /\|/.test(l))).toHaveLength(4);
  });

  it("writes articulation markers the format has, and reports the ones it does not", () => {
    const score = withNote(createScore("Art"), 0, 0, 1, 5);
    const note = score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    const bent = applyBatch(score, batch({ type: "note.addArticulation", noteId: note.id, articulation: "bend" }));
    expect(toAscii(bent, { header: false }).text).toMatch(/5b/);

    const dead = applyBatch(score, batch({ type: "note.addArticulation", noteId: note.id, articulation: "deadNote" }));
    expect(toAscii(dead, { header: false }).text).toMatch(/5x/);

    const ghost = applyBatch(score, batch({ type: "note.addArticulation", noteId: note.id, articulation: "ghost" }));
    expect(toAscii(ghost).report.unsupported.some((u) => u.includes("articulation"))).toBe(true);
  });

  it("reports a drum track and a pitched staff rather than writing nonsense", () => {
    const drums = createTrack("Kit", { kind: "drums" }, 2);
    const piano = createTrack("Piano", { kind: "pitched", midiProgram: 0 }, 2);
    const mixed: Score = { ...riff(), tracks: [...riff().tracks, drums, piano] };
    const { report } = toAscii(mixed);
    expect(report.unsupported.some((u) => u.includes("drum"))).toBe(true);
    expect(report.unsupported.some((u) => u.includes("pitched staff"))).toBe(true);
    expect(report.trackCount).toBe(1);
  });

  it("says so when there is nothing it can write", () => {
    const piano: Score = { ...createScore("Piano only"), tracks: [createTrack("Piano", { kind: "pitched", midiProgram: 0 }, 2)] };
    const { text, report } = toAscii(piano);
    expect(report.unsupported.some((u) => u.includes("nothing in this score"))).toBe(true);
    expect(text).not.toMatch(/\|/);
  });
});

describe("round trip", () => {
  it("reads our own output back to the same strings and frets", () => {
    const original = riff();
    const { text } = toAscii(original);
    const { score, report } = fromAscii(text);
    expect(fingerings(score)).toEqual(fingerings(original));
    expect(report.noteCount).toBe(5);
  });

  it("recovers a chord as one beat, not as several", () => {
    let score = createScore("Chord");
    score = withNote(score, 0, 0, 1, 0);
    score = withNote(score, 0, 0, 2, 2);
    score = withNote(score, 0, 0, 3, 2);
    const back = fromAscii(toAscii(score).text).score;
    expect(fingerings(back)).toEqual(["1/0+2/2+3/2"]);
  });

  it("recovers a two-digit fret as one note", () => {
    const score = withNote(createScore("High"), 0, 0, 1, 17);
    const back = fromAscii(toAscii(score).text).score;
    expect(fingerings(back)).toEqual(["1/17"]);
  });

  it("reads the tuning back off the string labels", () => {
    const drop: Score = {
      ...createScore("Drop D"),
      tracks: [createTrack("Guitar", { kind: "fretted", tuning: [64, 59, 55, 50, 45, 38], frets: 24, capo: 0 }, 2)],
    };
    const withOne = withNote(drop, 0, 0, 6, 0);
    const { score, report } = fromAscii(toAscii(withOne).text);
    expect(report.tuningStated).toBe(true);
    const instrument = score.tracks[0]!.instrument;
    expect(instrument.kind === "fretted" && instrument.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    // And the recovered note therefore has the right pitch, not a standard-tuning one.
    expect(score.tracks[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.pitch).toBe(38);
  });

  it("survives a round trip through a bass", () => {
    const bass: Score = {
      ...createScore("Bass line"),
      tracks: [createTrack("Bass", { kind: "fretted", tuning: [...STANDARD_BASS], frets: 24, capo: 0 }, 2)],
    };
    let score = bass;
    const beat = (b: number, i: number) => score.tracks[0]!.bars[b]!.voices[0]!.beats[i]!;
    score = applyBatch(score, batch({ type: "note.insert", beatId: beat(0, 0).id, note: createNote(33, 3, 0) }));
    score = applyBatch(score, batch({ type: "note.insert", beatId: beat(0, 2).id, note: createNote(38, 2, 0) }));
    const { score: back, report } = fromAscii(toAscii(score).text);
    expect(report.stringCount).toBe(4);
    expect(fingerings(back)).toEqual(fingerings(score));
  });

  it("always reports that rhythm was not carried", () => {
    // The format records none, and a plausible-looking wrong rhythm is worse than
    // an honest even one.
    const { report } = fromAscii(toAscii(riff()).text);
    expect(report.unsupported.some((u) => u.includes("rhythm"))).toBe(true);
  });
});

describe("reading tab as it is actually found", () => {
  it("reads a hand-written tab with no header at all", () => {
    const text = [
      "e|-----------------|",
      "B|-----------------|",
      "G|-----------------|",
      "D|-------7---------|",
      "A|---5-------------|",
      "E|-3---------------|",
    ].join("\n");
    const { score, report } = fromAscii(text);
    expect(report.noteCount).toBe(3);
    expect(fingerings(score)).toEqual(["6/3", "5/5", "4/7"]);
  });

  it("ignores lyrics and chord names around the staff", () => {
    const text = [
      "Verse 1",
      "Am        C         G",
      "I once had a girl",
      "",
      "e|--0--3--|",
      "B|--------|",
      "G|--------|",
      "D|--------|",
      "A|--------|",
      "E|--------|",
      "",
      "or should I say",
    ].join("\n");
    const { score, report } = fromAscii(text);
    expect(report.systems).toBe(1);
    expect(fingerings(score)).toEqual(["1/0", "1/3"]);
  });

  it("takes the tuning from prose when the labels do not give one", () => {
    const text = [
      "Tuning: D A D G A D",
      "-------7---|",
      "-----------|",
      "-----------|",
      "-----------|",
      "-----------|",
      "-0---------|",
    ].join("\n");
    const { score, report } = fromAscii(text);
    expect(report.tuningStated).toBe(true);
    const instrument = score.tracks[0]!.instrument;
    // DADGAD, high string first.
    expect(instrument.kind === "fretted" && instrument.tuning[5]).toBe(38);
  });

  it("assumes standard tuning and says so when none is stated", () => {
    const text = ["---0---|", "-------|", "-------|", "-------|", "-------|", "-------|"].join("\n");
    const { report } = fromAscii(text);
    expect(report.tuningStated).toBe(false);
    expect(report.unsupported.some((u) => u.includes("standard tuning assumed"))).toBe(true);
  });

  it("reads several systems as consecutive bars", () => {
    const system = (fret: string) =>
      [`e|--${fret}--|`, "B|-----|", "G|-----|", "D|-----|", "A|-----|", "E|-----|"].join("\n");
    const { score, report } = fromAscii(`${system("3")}\n\n${system("5")}`);
    expect(report.systems).toBe(2);
    expect(fingerings(score)).toEqual(["1/3", "1/5"]);
  });

  it("handles a system with a string line left out", () => {
    // Common in hand-typed tabs, where an unused string is simply not written.
    const text = ["e|--0--|", "B|-----|", "G|-----|", "D|-----|", "A|-----|"].join("\n");
    const { report } = fromAscii(text);
    expect(report.stringCount).toBe(5);
    expect(report.noteCount).toBe(1);
  });

  it("returns an empty score and says why when there is no tab in the text", () => {
    const { report, score } = fromAscii("Just some words about a song.\nNothing here.");
    expect(report.systems).toBe(0);
    expect(report.noteCount).toBe(0);
    expect(report.unsupported).toEqual(["no tablature staff found in this text"]);
    // Still a usable document rather than a throw.
    expect(score.tracks).toHaveLength(1);
  });

  it("does not mistake a line of prose with dashes for a staff", () => {
    const text = [
      "Intro -- play it twice --",
      "then the chorus -- loud --",
      "and out -- fading --",
    ].join("\n");
    expect(fromAscii(text).report.systems).toBe(0);
  });

  it("does not throw on ragged bar lines", () => {
    // Real files are like this. It need not recover well; it must not crash.
    const text = [
      "e|--0--|--3---|",
      "B|--------|",
      "G|--2--|",
      "D|",
      "A|--------------|",
      "E|--0--|--0--|",
    ].join("\n");
    expect(() => fromAscii(text)).not.toThrow();
    expect(fromAscii(text).report.noteCount).toBeGreaterThan(0);
  });

  it("drops a fret higher than the instrument has", () => {
    const text = ["e|--99--|", "B|------|", "G|------|", "D|------|", "A|------|", "E|--3---|"].join("\n");
    const { report } = fromAscii(text);
    expect(report.noteCount).toBe(1);
  });
});

describe("the chart above the tab", () => {
  it("writes chords over the beats they change on, aligned to the column", () => {
    const base = { ...createScore("Chart"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const beats = base.tracks[0]!.bars[0]!.voices[0]!.beats;
    const charted = applyBatch(
      base,
      batch(
        { type: "note.insert", beatId: beats[0]!.id, note: { id: "a1", pitch: 45, string: 5, fret: 0, articulations: [] } },
        { type: "note.insert", beatId: beats[2]!.id, note: { id: "a2", pitch: 48, string: 5, fret: 3, articulations: [] } },
        { type: "beat.setChord", beatId: beats[0]!.id, chord: "Am" },
        { type: "beat.setChord", beatId: beats[2]!.id, chord: "C" },
      ),
    );
    const { text } = toAscii(charted);
    const lines = text.split("\n");
    const chordLine = lines.find((l) => l.includes("Am"))!;
    expect(chordLine).toBeDefined();
    expect(chordLine.includes("|")).toBe(false);
    // The A string row carries the frets; each chord must sit over its own fret.
    const aString = lines.find((l) => l.startsWith("A"))!;
    expect(chordLine.indexOf("Am")).toBe(aString.indexOf("0"));
    expect(chordLine.indexOf("C")).toBe(aString.indexOf("3"));
  });

  it("writes lyrics under the staff the same way", () => {
    const base = { ...createScore("Words"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const beats = base.tracks[0]!.bars[0]!.voices[0]!.beats;
    const sung = applyBatch(
      base,
      batch(
        { type: "beat.setLyric", beatId: beats[0]!.id, lyric: "hel-" },
        { type: "beat.setLyric", beatId: beats[1]!.id, lyric: "lo" },
      ),
    );
    const { text } = toAscii(sung);
    const lines = text.split("\n");
    const staffEnd = lines.map((l) => l.includes("|")).lastIndexOf(true);
    const lyricLine = lines[staffEnd + 1]!;
    expect(lyricLine).toContain("hel-");
    expect(lyricLine.indexOf("hel-")).toBeLessThan(lyricLine.indexOf("lo"));
  });

  it("starts a new system under a section heading", () => {
    const base = { ...createScore("Form"), tracks: [createTrack("Guitar", frettedGuitar(), 2)] };
    const sectioned = applyBatch(
      base,
      batch({ type: "bar.setSection", barId: base.tracks[0]!.bars[1]!.id, section: "Chorus" }),
    );
    const { text } = toAscii(sectioned);
    const lines = text.split("\n");
    const heading = lines.indexOf("[Chorus]");
    expect(heading).toBeGreaterThan(0);
    // The heading sits between two systems, not inside one: the line right before
    // it is blank or a staff end, and a staff follows it.
    expect(lines.slice(heading + 1).some((l) => l.includes("|"))).toBe(true);
  });

  it("adds no chart rows to a score that has no chart", () => {
    const base = { ...createScore("Plain"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const { text } = toAscii(base);
    const lines = text.split("\n").filter((l) => l.length > 0);
    // Header lines plus exactly six staff rows: nothing above, nothing below.
    expect(lines.filter((l) => l.includes("|"))).toHaveLength(6);
    expect(lines.at(-1)!.includes("|")).toBe(true);
  });

  it("widens a beat rather than letting a long chord name drift off it", () => {
    const base = { ...createScore("Wide"), tracks: [createTrack("Guitar", frettedGuitar(), 1)] };
    const beats = base.tracks[0]!.bars[0]!.voices[0]!.beats;
    const charted = applyBatch(
      base,
      batch(
        { type: "beat.setChord", beatId: beats[0]!.id, chord: "F#m7b5" },
        { type: "note.insert", beatId: beats[1]!.id, note: { id: "w1", pitch: 45, string: 5, fret: 0, articulations: [] } },
        { type: "beat.setChord", beatId: beats[1]!.id, chord: "B7" },
      ),
    );
    const { text } = toAscii(charted);
    const lines = text.split("\n");
    const chordLine = lines.find((l) => l.includes("F#m7b5"))!;
    const aString = lines.find((l) => l.startsWith("A"))!;
    // The second beat moved right to make room, and the chord still sits on it.
    expect(chordLine.indexOf("B7")).toBe(aString.indexOf("0"));
    expect(chordLine.indexOf("B7")).toBeGreaterThan(chordLine.indexOf("F#m7b5") + "F#m7b5".length - 1);
  });
});
