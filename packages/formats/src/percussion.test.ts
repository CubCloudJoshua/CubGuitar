/**
 * The drum-voice table, re-measured against the parser that has to accept it.
 *
 * `packages/core/src/percussion.ts` maps General MIDI drum numbers to the articulation
 * names alphaTex takes, and every row of it came from asking alphaTab. A hand-kept table
 * against somebody else's renderer is exactly the kind of thing that is right on the day
 * it is written and wrong two versions later, silently, in a way that shows up as the
 * wrong drum sounding rather than as an error. So the measurement is the test: each name
 * is written into a one-note percussion staff, parsed, and the drum it resolves to is
 * compared to the number the table claims.
 *
 * The table lives in core because core is where the serializer is, and core has no
 * alphaTab dependency. This is the package that does, which is why the check is here.
 */
import { describe, expect, it } from "vitest";
import * as alphaTab from "@coderline/alphatab";
import { DRUM_VOICE_NAMES, drumVoiceName, toAlphaTex, type Score } from "@cubscore/core";

function parse(tex: string): alphaTab.model.Score {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  return importer.readScore();
}

const HEAD = '\\track "Kit"\n\\staff{score} \\instrument percussion\n\\articulation defaults\n';

/** The drum numbers a parsed percussion track actually sounds, beat by beat. */
function voicesOf(score: alphaTab.model.Score): number[][] {
  const track = score.tracks[0];
  if (!track) return [];
  return (track.staves[0]?.bars ?? []).flatMap((bar) =>
    (bar.voices[0]?.beats ?? [])
      .filter((beat) => !beat.isRest)
      .map((beat) =>
        beat.notes.map((note) => {
          const articulation = track.percussionArticulations[note.percussionArticulation];
          return articulation?.outputMidiNumber ?? note.percussionArticulation;
        }),
      ),
  );
}

describe("the drum voice table", () => {
  it("names a drum that alphaTab sounds as the number the table claims", () => {
    const wrong: string[] = [];
    for (const [midiNumber, name] of DRUM_VOICE_NAMES) {
      let sounded: number | undefined;
      try {
        sounded = voicesOf(parse(`${HEAD}"${name}".4`))[0]?.[0];
      } catch (e) {
        wrong.push(`${midiNumber} "${name}": threw ${String(e).slice(0, 60)}`);
        continue;
      }
      if (sounded !== midiNumber) wrong.push(`${midiNumber} "${name}": sounded ${sounded}`);
    }
    expect(wrong).toEqual([]);
  });

  it("covers the whole General MIDI percussion range without gaps in 35..81", () => {
    // 35 to 81 is the General MIDI standard kit, which is what a drum part written
    // anywhere else will use. Above it alphaTab's kit is sparse and the table follows,
    // rather than inventing names for numbers it cannot sound.
    const missing: number[] = [];
    for (let n = 35; n <= 81; n += 1) if (!DRUM_VOICE_NAMES.has(n)) missing.push(n);
    expect(missing).toEqual([]);
  });

  it("answers a voice outside the kit with null rather than a near miss", () => {
    // The nearest number is a different drum. Answering 84 with the name for 83 turns a
    // bell tree into a jingle bell with nothing said, which is worse than a writer that
    // reports it cannot write this.
    for (const outside of [0, 1, 34, 88, 120, -5]) expect(drumVoiceName(outside)).toBeNull();
    expect(drumVoiceName(35)).toBe("Kick (hit)");
    // Fractional numbers cannot occur from an import, but the model's field is a number.
    expect(drumVoiceName(35.4)).toBe("Kick (hit)");
  });
});

describe("what the serializer writes for a kit", () => {
  const drumScore = (voices: number[][]): Score => ({
    id: "s",
    title: "Kit",
    artist: "",
    revision: 0,
    tracks: [
      {
        id: "t",
        name: "Kit",
        instrument: { kind: "drums" },
        bars: [
          {
            id: "b1",
            voices: [
              {
                id: "v1",
                beats: voices.map((notes, i) => ({
                  id: `beat${i}`,
                  duration: { numerator: 1, denominator: 4 },
                  dots: 0,
                  notes: notes.map((pitch, j) => ({
                    id: `n${i}-${j}`,
                    pitch,
                    articulations: [],
                  })),
                })),
              },
            ],
          },
        ],
      },
    ],
  });

  it("round-trips a kick, a snare and a hi-hat through alphaTab", () => {
    const tex = toAlphaTex(drumScore([[35], [42], [38], [42]]));
    expect(voicesOf(parse(tex))).toEqual([[35], [42], [38], [42]]);
  });

  it("writes simultaneous hits as one beat", () => {
    // A kick and a hi-hat on the same beat is the most ordinary thing in a drum part, and
    // it is the case a per-note serializer gets wrong by emitting two beats.
    const tex = toAlphaTex(drumScore([[35, 42], [38, 42]]));
    expect(voicesOf(parse(tex))).toEqual([[35, 42], [38, 42]]);
  });

  it("writes a rest for a beat whose every voice is unwritable", () => {
    // Voice 0 names no drum. The beat has to stay a beat: dropping it shortens the bar,
    // and alphaTex has no way to write a beat with neither a note nor a rest.
    const tex = toAlphaTex(drumScore([[0], [38]]));
    expect(tex).toContain("r.4");
    expect(voicesOf(parse(tex))).toEqual([[38]]);
  });

  it("keeps the writable voices of a beat that also has an unwritable one", () => {
    const tex = toAlphaTex(drumScore([[0, 38]]));
    expect(voicesOf(parse(tex))).toEqual([[38]]);
  });

  it("declares the default kit, or every name in the file resolves to nothing", () => {
    // Without `\\articulation defaults` in scope, alphaTab reports an unknown articulation
    // and falls back to the first voice of its kit — which is how a file that renders a
    // full kit and plays one sound gets made.
    expect(toAlphaTex(drumScore([[35]]))).toContain("\\articulation defaults");
  });

  it("writes the track rather than dropping it, which is what it used to do", () => {
    const tex = toAlphaTex(drumScore([[35]]));
    expect(tex).toContain('\\track "Kit"');
    expect(tex).toContain("\\instrument percussion");
    // The old behaviour substituted a default guitar track for a score with only drums.
    expect(tex).not.toContain("\\tuning");
  });
});
