/**
 * Importer tests.
 *
 * This package had no test script at all, so `pnpm -r test` silently skipped
 * the alphaTab-to-core conversion — the code that decides whether a user's file
 * survives being imported, and the code with the worst bug history in the
 * project. Only the browser corpus suite covered it, and that compares pitches
 * and counts: a whole class of mistake sits underneath what it can see.
 *
 * alphaTab's alphaTex importer runs in plain Node with no DOM, so these are fast
 * and exact. Each test corresponds to something that was actually wrong once, or
 * to a claim the report makes to the user.
 */
import { describe, expect, it } from "vitest";
import * as alphaTab from "@coderline/alphatab";
import { fromAlphaTab } from "./from-alphatab.js";
import type { Bar, Note } from "@cubscore/core";

function parse(tex: string): alphaTab.model.Score {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  return importer.readScore();
}

function convert(tex: string) {
  return fromAlphaTab(parse(tex));
}

const GUITAR = '\\track "G"\n\\staff{score tabs} \\tuning e4 b3 g3 d3 a2 e2\n';

function notesOf(bar: Bar | undefined): Note[] {
  return (bar?.voices[0]?.beats ?? []).flatMap((b) => b.notes);
}

describe("string numbering", () => {
  /**
   * The bug this exists for: alphaTab numbers strings from the lowest and this
   * model numbers from the highest, and getting it backwards left every note
   * transposed by two octaves while every count still matched. Nothing but a
   * pitch comparison caught it.
   */
  it("keeps a low-string note on the low string, at its real pitch", () => {
    const { score } = convert(`${GUITAR}3.6.4 0.1.4`);
    const notes = notesOf(score.tracks[0]?.bars[0]);
    expect(notes).toHaveLength(2);

    const low = notes.find((n) => n.fret === 3);
    const high = notes.find((n) => n.fret === 0);
    // String 6 is the low E in this model, and low E plus three frets is G2.
    expect(low?.string).toBe(6);
    expect(low?.pitch).toBe(43);
    // String 1 is the high E.
    expect(high?.string).toBe(1);
    expect(high?.pitch).toBe(64);
  });

  it("reads the tuning highest string first", () => {
    const { score } = convert(`${GUITAR}0.1.4`);
    const instrument = score.tracks[0]?.instrument;
    expect(instrument?.kind).toBe("fretted");
    if (instrument?.kind !== "fretted") throw new Error("not fretted");
    expect(instrument.tuning).toEqual([64, 59, 55, 50, 45, 40]);
  });
});

describe("notes the model has to be careful with", () => {
  it("keeps a dead note's fret and marks it dead", () => {
    // A dead note that lost its fret came back as an open string, which moved
    // 520 notes in one Led Zeppelin transcription.
    const { score } = convert(`${GUITAR}7.3{x}.4 r.4`);
    const note = notesOf(score.tracks[0]?.bars[0])[0];
    expect(note?.fret).toBe(7);
    expect(note?.articulations).toContain("deadNote");
  });

  it("never produces a negative fret", () => {
    // GP3 encodes dead notes at fret -1, and this model's frets are positions.
    const { score } = convert(`${GUITAR}0.6{x}.4 r.4`);
    for (const note of notesOf(score.tracks[0]?.bars[0])) {
      expect(note.fret ?? 0).toBeGreaterThanOrEqual(0);
    }
  });

  it("carries a tie as a property of the note it starts on", () => {
    const { score } = convert(`${GUITAR}3.3.4 -.3.4 r.2`);
    const notes = notesOf(score.tracks[0]?.bars[0]);
    expect(notes.some((n) => n.tiedToNext === true)).toBe(true);
  });

  it("carries the articulations the editor can show", () => {
    const { score } = convert(`${GUITAR}3.3{pm}.4 5.3{v}.4 7.3{st}.4 9.3{nh}.4`);
    const all = notesOf(score.tracks[0]?.bars[0]).flatMap((n) => n.articulations);
    expect(all).toContain("palmMute");
    expect(all).toContain("vibrato");
    expect(all).toContain("staccato");
    expect(all).toContain("naturalHarmonic");
  });
});

describe("bar-level structure", () => {
  it("writes a time signature only where it changes", () => {
    const { score } = convert(`${GUITAR}\\ts 4 4 3.3.4*4 | 3.3.4*4 | \\ts 3 4 3.3.4*3`);
    const bars = score.tracks[0]?.bars ?? [];
    expect(bars).toHaveLength(3);
    // The first bar always states it; the second repeats it and so carries none.
    expect(bars[0]?.timeSignature).toEqual({ beats: 4, beatValue: 4 });
    expect(bars[1]?.timeSignature).toBeUndefined();
    expect(bars[2]?.timeSignature).toEqual({ beats: 3, beatValue: 4 });
  });

  it("puts the score's tempo on the first bar, where the serializer looks", () => {
    const { score } = convert(`\\tempo 96\n.\n${GUITAR}3.3.4 r.2 r.4`);
    expect(score.tracks[0]?.bars[0]?.tempoBpm).toBe(96);
  });

  it("carries a tuplet with its ratio", () => {
    const { score } = convert(`${GUITAR}3.3.8{tu 3} 3.3.8{tu 3} 3.3.8{tu 3} r.2 r.4`);
    const tuplets = (score.tracks[0]?.bars[0]?.voices[0]?.beats ?? []).filter((b) => b.tuplet);
    expect(tuplets.length).toBeGreaterThanOrEqual(3);
    expect(tuplets[0]?.tuplet).toEqual({ actual: 3, normal: 2 });
  });

  it("gives an empty bar a voice, so it serializes to a rest rather than nothing", () => {
    const { score } = convert(`${GUITAR}3.3.4 r.2 r.4 | r.1`);
    const second = score.tracks[0]?.bars[1];
    expect(second?.voices).toHaveLength(1);
    expect(second?.voices[0]).toBeDefined();
  });
});

describe("what the report tells the user", () => {
  it("carries a percussion track with nothing left to report about it", () => {
    // Drum tracks were dropped outright once, then carried by the model but unwritable
    // by the notation serializer. Both are fixed, so a kit of ordinary voices is no
    // longer a caveat at all — and this asserts the absence, because a stale warning is
    // its own kind of lie.
    const { score, report } = convert(
      `${GUITAR}3.3.4 5.3.4 | 7.3.4 9.3.4\n\\track "Kit"\n\\staff{score} \\instrument percussion\n\\articulation defaults\n"Kick (hit)".4 r.2 r.4`,
    );
    expect(score.tracks.map((t) => t.instrument.kind)).toContain("drums");
    expect(score.tracks.map((t) => t.instrument.kind)).toContain("fretted");
    expect(report.unsupported.some((u) => /drum/i.test(u))).toBe(false);
    // And it counts toward what is editable, which is what decides whether the library
    // stores an editable core at all.
    expect(report.trackCount).toBe(2);
  });

  /**
   * A pitched staff round-trips pitch-exact, and the banner presents this list
   * as things "absent from the editable version" — so reporting it there was a
   * false warning, which teaches users to ignore the entries that are real.
   */
  it("carries a stringless staff and does not report it as lost", () => {
    const { score, report } = convert(
      `${GUITAR}3.3.4 r.2 r.4\n\\track "Piano"\n\\staff{score} \\instrument 0\nC4.4 E4.4 G4.2`,
    );
    expect(score.tracks).toHaveLength(2);
    const piano = score.tracks[1];
    expect(piano?.instrument.kind).toBe("pitched");
    expect(notesOf(piano?.bars[0]).map((n) => n.pitch)).toEqual([60, 64, 67]);
    expect(report.unsupported.join(" ")).not.toMatch(/pitched staff/);
  });

  it("counts what it actually converted", () => {
    const { report } = convert(`${GUITAR}3.3.4 5.3.4 7.3.4 9.3.4 | 3.3.4 5.3.4 7.3.4 9.3.4`);
    expect(report.trackCount).toBe(1);
    expect(report.barCount).toBe(2);
    expect(report.noteCount).toBe(8);
  });

  it("reports chord diagrams and beat text rather than dropping them silently", () => {
    const { report } = convert(`${GUITAR}3.3.4{txt "riff"} r.2 r.4`);
    expect(report.unsupported.join(" ")).toMatch(/beat text/);
  });
});

describe("degenerate input", () => {
  it("carries a score whose only track is percussion, and it is editable", () => {
    const { score, report } = convert(
      `\\track "Kit"\n\\instrument percussion\n\\articulation defaults\n"Kick (hit)".4 r.2 r.4`,
    );
    // A drum-only score is now an ordinary editable score: the notation writer carries
    // percussion, so `trackCount` counts this track and the library stores a core for it.
    // The previous behaviour — EDIT withheld, because alphaTex would have substituted a
    // blank guitar staff for the whole file — is the thing that changed.
    expect(score.tracks).toHaveLength(1);
    expect(score.tracks[0]?.instrument.kind).toBe("drums");
    expect(report.trackCount).toBe(1);
    expect(report.unsupported.some((u) => /drum/i.test(u))).toBe(false);
  });

  it("gives every entity a distinct id", () => {
    const { score } = convert(`${GUITAR}3.3.4 5.3.4 | 7.3.4 9.3.4`);
    const ids = [
      score.id,
      ...score.tracks.map((t) => t.id),
      ...score.tracks.flatMap((t) => t.bars.map((b) => b.id)),
      ...score.tracks.flatMap((t) => t.bars.flatMap((b) => b.voices.map((v) => v.id))),
      ...score.tracks.flatMap((t) =>
        t.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.map((x) => x.id))),
      ),
      ...score.tracks.flatMap((t) => t.bars.flatMap((b) => notesOf(b).map((n) => n.id))),
    ];
    // Ops address entities by id, so a duplicate makes one op hit two things.
    expect(new Set(ids).size).toBe(ids.length);
  });
});
