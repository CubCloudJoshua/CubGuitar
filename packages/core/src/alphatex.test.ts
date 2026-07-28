import { describe, expect, it } from "vitest";
import { beatTicks, tickAt, toAlphaTex } from "./alphatex.js";
import { createBar, createNote, createRest, createScore, duration } from "./build.js";
import type { Score, Track } from "./score.js";

function trackOf(score: Score): Track {
  const track = score.tracks[0];
  if (!track) throw new Error("no track");
  return track;
}

describe("beatTicks", () => {
  it("matches alphaTab's 960-tick quarter", () => {
    expect(beatTicks(createRest(duration(4)))).toBe(960);
    expect(beatTicks(createRest(duration(8)))).toBe(480);
    expect(beatTicks(createRest(duration(1)))).toBe(3840);
  });

  it("applies dots", () => {
    const dotted = { ...createRest(duration(4)), dots: 1 as const };
    expect(beatTicks(dotted)).toBe(1440);
    const doubleDotted = { ...createRest(duration(4)), dots: 2 as const };
    expect(beatTicks(doubleDotted)).toBe(1680);
  });

  it("applies tuplets exactly", () => {
    const tripletEighth = { ...createRest(duration(8)), tuplet: { actual: 3, normal: 2 } };
    expect(beatTicks(tripletEighth)).toBe(320);
  });
});

describe("tickAt", () => {
  it("accumulates across bars", () => {
    const score = createScore("t");
    const track = trackOf(score);
    // Bars are pre-filled with quarter rests in 4/4.
    expect(tickAt(track, 0, 0)).toBe(0);
    expect(tickAt(track, 0, 2)).toBe(1920);
    expect(tickAt(track, 1, 0)).toBe(3840);
    expect(tickAt(track, 1, 1)).toBe(4800);
  });
});

describe("toAlphaTex", () => {
  it("writes scientific octaves for standard tuning", () => {
    const tex = toAlphaTex(createScore("t"));
    expect(tex).toContain("\\tuning E4 B3 G3 D3 A2 E2");
  });

  it("emits a rest for an empty bar so bar counts are stable", () => {
    const score = createScore("t");
    const track = trackOf(score);
    const empty = { ...createBar(), voices: [] };
    const withEmpty: Score = {
      ...score,
      tracks: [{ ...track, bars: [...track.bars, empty] }],
    };
    const lastLine = toAlphaTex(withEmpty).trim().split("\n").at(-1);
    expect(lastLine).toContain("r.1");
  });

  it("leads a bar with its repeat close rather than trailing it", () => {
    const score = createScore("t");
    const track = trackOf(score);
    const bars = track.bars.map((bar, i) => (i === 1 ? { ...bar, repeat: { endCount: 2 } } : bar));
    const tex = toAlphaTex({ ...score, tracks: [{ ...track, bars }] });
    const barLines = tex.trim().split("\n");
    const closing = barLines.find((line) => line.includes("\\rc 2"));
    expect(closing).toBeDefined();
    expect(closing?.trimStart().startsWith("\\rc 2")).toBe(true);
  });

  it("omits drum tracks instead of writing wrong notation", () => {
    const score = createScore("t");
    const drums: Track = {
      id: "d",
      name: "Drums",
      instrument: { kind: "drums" },
      bars: [createBar()],
    };
    const tex = toAlphaTex({ ...score, tracks: [...score.tracks, drums] });
    expect(tex).not.toContain("percussion");
    expect(tex).not.toContain("Drums");
  });

  it("escapes double quotes in metadata", () => {
    const tex = toAlphaTex(createScore('The "Best" Song'));
    expect(tex).toContain("\\title \"The 'Best' Song\"");
  });

  it("writes dead notes as x on the string", () => {
    const score = createScore("t");
    const track = trackOf(score);
    const beat = track.bars[0]!.voices[0]!.beats[0]!;
    const dead = { ...createNote(0, 5, 0), articulations: ["deadNote" as const] };
    const bars = track.bars.map((bar, i) =>
      i === 0
        ? {
            ...bar,
            voices: [{ ...bar.voices[0]!, beats: [{ ...beat, notes: [dead] }, ...bar.voices[0]!.beats.slice(1)] }],
          }
        : bar,
    );
    const tex = toAlphaTex({ ...score, tracks: [{ ...track, bars }] });
    expect(tex).toContain("x.5");
  });
});
