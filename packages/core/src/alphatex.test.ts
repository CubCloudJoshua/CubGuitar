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

  it("writes drum tracks, which it used to omit", () => {
    // Percussion was left out while the serializer had no way to name a drum voice: a
    // number on a percussion staff is an index into a list alphaTab builds from the names
    // a file used, so writing General MIDI numbers rendered a full kit and played five
    // sounds. It writes names now — see percussion.ts, and percussion.test.ts in
    // packages/formats for the round trip through the real parser.
    const score = createScore("t");
    const drums: Track = {
      id: "d",
      name: "Drums",
      instrument: { kind: "drums" },
      bars: [createBar()],
    };
    const tex = toAlphaTex({ ...score, tracks: [...score.tracks, drums] });
    expect(tex).toContain("\\instrument percussion");
    expect(tex).toContain('\\track "Drums"');
    expect(tex).toContain("\\articulation defaults");
  });

  it("escapes double quotes in metadata", () => {
    const tex = toAlphaTex(createScore('The "Best" Song'));
    expect(tex).toContain("\\title \"The 'Best' Song\"");
  });

  it("writes tie destinations as a dash and carries ties across barlines", () => {
    const score = createScore("t");
    const track = trackOf(score);
    const note = createNote(59, 2, 8);
    const tiedOrigin = { ...note, tiedToNext: true };
    const bars = track.bars.map((bar, i) => {
      const voice = bar.voices[0]!;
      if (i === 0) {
        // Last beat of bar 1 ties into bar 2.
        const beats = voice.beats.map((b, j) =>
          j === voice.beats.length - 1 ? { ...b, notes: [tiedOrigin] } : b,
        );
        return { ...bar, voices: [{ ...voice, beats }] };
      }
      if (i === 1) {
        const beats = voice.beats.map((b, j) => (j === 0 ? { ...b, notes: [{ ...note }] } : b));
        return { ...bar, voices: [{ ...voice, beats }] };
      }
      return bar;
    });
    const tex = toAlphaTex({ ...score, tracks: [{ ...track, bars }] });
    expect(tex).toContain("8.2");
    expect(tex).toContain("-.2");
  });

  it("emits \\voice sections for multi-voice tracks, directives on the first only", () => {
    const score = createScore("t");
    const track = trackOf(score);
    const second = { id: "v2", beats: track.bars[0]!.voices[0]!.beats.map((b) => ({ ...b })) };
    const bars = track.bars.map((bar, i) =>
      i === 0 ? { ...bar, voices: [...bar.voices, second] } : bar,
    );
    const tex = toAlphaTex({ ...score, tracks: [{ ...track, bars }] });
    expect(tex.match(/\\voice/g)).toHaveLength(2);
    expect(tex.match(/\\ts 4 4/g)).toHaveLength(1);
  });

  it("writes dead notes with their fret preserved", () => {
    const score = createScore("t");
    const track = trackOf(score);
    const beat = track.bars[0]!.voices[0]!.beats[0]!;
    const dead = { ...createNote(48, 5, 3), articulations: ["deadNote" as const] };
    const bars = track.bars.map((bar, i) =>
      i === 0
        ? {
            ...bar,
            voices: [{ ...bar.voices[0]!, beats: [{ ...beat, notes: [dead] }, ...bar.voices[0]!.beats.slice(1)] }],
          }
        : bar,
    );
    const tex = toAlphaTex({ ...score, tracks: [{ ...track, bars }] });
    expect(tex).toContain("3.5{x}");
  });

  it("falls back to bare x when a dead note has no usable fret", () => {
    const score = createScore("t");
    const track = trackOf(score);
    const beat = track.bars[0]!.voices[0]!.beats[0]!;
    const dead = { id: "dn", pitch: 45, string: 5, articulations: ["deadNote" as const] };
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
