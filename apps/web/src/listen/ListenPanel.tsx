/**
 * What the microphone heard, on the score.
 *
 * The heat is painted as a band under each bar rather than a wash over it. A tint
 * across the staff would put chrome on top of the music, which is the thing this
 * product refuses to do everywhere else, and it would do it precisely while the user
 * is reading the notes to play them. A band under the bar is visible in peripheral
 * vision at playing distance and covers nothing.
 *
 * The readout says the same thing in words and numbers. Not as a fallback: it is the
 * more useful of the two. A band tells you which bar, a number tells you what to do
 * about it, and "18ms behind the beat" is advice in a way that a colour is not.
 */
import { color, font, heat, motion, typeScale } from "@cubscore/design";
import { passageTempo, type BarResult, type ListenReport, type PitchReading, type PracticeSummary } from "@cubscore/core";
import type { BarBox } from "../useAlphaTab";

const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** A pitch as a musician would say it: note name, octave, and cents off. */
export function noteName(midi: number): string {
  const nearest = Math.round(midi);
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12] ?? "?";
  return `${name}${Math.floor(nearest / 12) - 1}`;
}

/**
 * Bars in played order, folded onto the bars that are engraved.
 *
 * A repeated section is played twice and graded twice, but it is drawn once. Two
 * passes over bar 3 have to become one band, and the honest fold is to add the
 * counts: a bar played cleanly the first time and fumbled on the repeat did not go
 * well, and showing only the better pass would be flattery.
 */
function foldPasses(bars: readonly BarResult[]): Map<number, BarResult> {
  const out = new Map<number, BarResult>();
  for (const bar of bars) {
    const seen = out.get(bar.bar);
    if (!seen) {
      out.set(bar.bar, { ...bar });
      continue;
    }
    const clean = seen.clean + bar.clean;
    const early = seen.early + bar.early;
    const late = seen.late + bar.late;
    const wrongPitch = seen.wrongPitch + bar.wrongPitch;
    const missed = seen.missed + bar.missed;
    const judged = clean + early + late + wrongPitch + missed;
    out.set(bar.bar, {
      ...seen,
      clean,
      early,
      late,
      wrongPitch,
      missed,
      unverified: seen.unverified + bar.unverified,
      accuracy: judged === 0 ? null : (clean + early + late) / judged,
      timingSeconds: mean([seen.timingSeconds, bar.timingSeconds]),
    });
  }
  return out;
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

/** How a bar went, as a word. Null accuracy means there was nothing to judge. */
function heatOf(bar: BarResult): keyof typeof heat {
  if (bar.accuracy === null) return "unheard";
  if (bar.accuracy >= 0.999) return bar.early + bar.late > 0 ? "weak" : "clean";
  if (bar.accuracy >= 0.6) return "weak";
  return "wrong";
}

/** A plain-language summary of one bar, for the band's title and for screen readers. */
function describe(bar: BarResult): string {
  if (bar.accuracy === null) return `Bar ${bar.bar + 1}: nothing to check`;
  const parts = [`${Math.round(bar.accuracy * 100)}% of notes played`];
  if (bar.wrongPitch > 0) parts.push(`${bar.wrongPitch} wrong`);
  if (bar.missed > 0) parts.push(`${bar.missed} missed`);
  if (bar.early + bar.late > 0) parts.push(`${bar.early + bar.late} off the beat`);
  if (bar.unverified > 0) parts.push(`${bar.unverified} not checked`);
  return `Bar ${bar.bar + 1}: ${parts.join(", ")}`;
}

export function BarHeat({ report, barBoxes }: { report: ListenReport; barBoxes: BarBox[] }) {
  if (barBoxes.length === 0) return null;
  const folded = foldPasses(report.bars);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {barBoxes.map((box) => {
        const bar = folded.get(box.index);
        // A bar with nothing in it gets no band at all, rather than a grey one. The
        // absence of a mark is the clearest possible way to say "nothing here".
        if (!bar || bar.accuracy === null) return null;
        const kind = heatOf(bar);
        return (
          <div
            key={box.index}
            title={describe(bar)}
            data-listen-bar={box.index}
            data-listen-heat={kind}
            data-listen-accuracy={Math.round(bar.accuracy * 100)}
            style={{
              position: "absolute",
              left: box.x,
              top: box.y + box.height - 3,
              width: box.width,
              height: 3,
              background: heat[kind],
              // Full strength for a bar that went badly, softer for one that went
              // well: the ones worth looking at should be the ones that catch the eye.
              opacity: bar.accuracy >= 0.999 ? 0.55 : 0.9,
              borderRadius: 2,
              transition: `background ${motion.base}, opacity ${motion.base}`,
            }}
          />
        );
      })}
    </div>
  );
}

const cell: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: typeScale.sm,
  color: color.text,
  whiteSpace: "nowrap",
};

const dim: React.CSSProperties = { ...cell, color: color.textDim };

/** The take, in numbers. */
export function ListenReadout({
  report,
  current,
  heard,
  track,
  onClear,
}: {
  report: ListenReport | null;
  current: PitchReading | null;
  heard: boolean;
  /** The staff being graded. A single-pitch pass can only grade one, so say which. */
  track: string;
  onClear: () => void;
}) {
  const timing = report?.timingSeconds;
  const ms = timing === null || timing === undefined ? null : Math.round(timing * 1000);

  return (
    <div
      // A status region: the whole point of this strip is that it changes while the
      // user is looking somewhere else, and a screen reader user gets nothing from a
      // coloured band under a bar.
      role="status"
      aria-live="polite"
      data-listen-readout=""
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        background: color.raised,
        border: `1px solid ${color.hairline}`,
        borderRadius: 8,
        padding: "8px 10px",
        marginBottom: 10,
      }}
    >
      <span style={{ ...cell, color: color.accentLive, letterSpacing: 0.5 }}>LISTENING</span>

      {/* Which part. One detected pitch cannot speak for two staves, so the report is
          about the selected one — and a user watching a bar go red is owed the answer
          to "graded against what?" without having to look at the rail. */}
      <span style={cell} data-listen-track={track}>
        {track}
      </span>

      {/* Said once, up front, because it is the difference between a real
          measurement and a machine grading its own playback. */}
      <span style={dim}>Headphones — a microphone hears the app too</span>

      <span style={{ flex: 1 }} />

      {current ? (
        <span style={cell} data-listen-pitch={noteName(current.midi)}>
          {noteName(current.midi)}
          <span style={{ color: color.textDim }}>
            {" "}
            {(current.midi - Math.round(current.midi) >= 0 ? "+" : "") +
              Math.round((current.midi - Math.round(current.midi)) * 100)}
            ¢
          </span>
        </span>
      ) : (
        <span style={dim}>{heard ? "—" : "waiting for a note"}</span>
      )}

      {report && report.judged > 0 && (
        <>
          <span style={cell} data-listen-accuracy={Math.round((report.accuracy ?? 0) * 100)}>
            {Math.round((report.accuracy ?? 0) * 100)}%
            <span style={{ color: color.textDim }}> of {report.judged}</span>
          </span>
          {ms !== null && (
            <span style={cell}>
              {/* Signed, and in words. "−18ms" is ambiguous to everyone; "18ms
                  ahead" is the thing you can act on. */}
              {Math.abs(ms)}ms <span style={{ color: color.textDim }}>{ms < 0 ? "ahead" : "behind"}</span>
            </span>
          )}
          {report.unverified > 0 && (
            <span style={dim} title="Notes in chords, which a single-pitch pass cannot check one by one">
              {report.unverified} not checked
            </span>
          )}
        </>
      )}

      <button
        onClick={onClear}
        style={{
          ...cell,
          background: "none",
          border: `1px solid ${color.hairline}`,
          borderRadius: 6,
          padding: "2px 8px",
          cursor: "pointer",
          color: color.textDim,
        }}
        title="Throw away this take and start again"
      >
        RESET TAKE
      </button>
    </div>
  );
}

/**
 * What the history says, in one line.
 *
 * Deliberately one line and deliberately always on, not a panel behind a button.
 * A practice record you have to go and look at is a practice record you stop looking
 * at, and the whole value of storing takes is that the answer is in front of you when
 * you open the piece.
 *
 * Three things, because they are the three a player asks: how much have I done, what
 * should I do now, and can I play it yet.
 */
export function PracticeStrip({
  summary,
  barCount,
  onClear,
}: {
  summary: PracticeSummary;
  /** Bars in the score, for the passage tempo. */
  barCount: number;
  onClear: () => void;
}) {
  if (summary.takes === 0) return null;
  const drill = summary.drill.slice(0, 3);
  const tempo = passageTempo(summary.bars, 0, Math.max(0, barCount - 1));
  const learned = summary.bars.filter((b) => b.streak > 0).length;

  return (
    <div
      role="status"
      data-practice-strip=""
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        background: color.raised,
        border: `1px solid ${color.hairline}`,
        borderRadius: 8,
        padding: "6px 10px",
        marginBottom: 10,
      }}
    >
      <span style={{ ...cell, color: color.textDim, letterSpacing: 0.5 }}>PRACTICE</span>
      <span style={cell} data-practice-takes={summary.takes}>
        {summary.takes} take{summary.takes === 1 ? "" : "s"}
      </span>
      <span style={dim}>
        {learned} of {summary.bars.length} bars clean
      </span>

      {/* The point of the whole feature: not a score out of ten, but which bar to go
          back to. Named in the user's numbering, which is one-based. */}
      {drill.length > 0 ? (
        <span style={cell} data-practice-drill={drill.map((b) => b + 1).join(",")}>
          Work on bar{drill.length === 1 ? "" : "s"}{" "}
          <span style={{ color: heat.wrong }}>{drill.map((b) => b + 1).join(", ")}</span>
        </span>
      ) : (
        <span style={dim}>Nothing due — every bar is clean and rested</span>
      )}

      <span style={{ flex: 1 }} />

      {/* The number every guitarist means by "I can play it", and the one nobody
          records: the tempo of the passage's *worst* bar, not its best. */}
      {tempo !== null && (
        <span style={cell} data-practice-tempo={Math.round(tempo)}>
          Clean at <span style={{ color: heat.clean }}>{Math.round(tempo)}</span> bpm
        </span>
      )}

      <button
        onClick={onClear}
        style={{
          ...cell,
          background: "none",
          border: `1px solid ${color.hairline}`,
          borderRadius: 6,
          padding: "2px 8px",
          cursor: "pointer",
          color: color.textDim,
        }}
        title="Forget this score's practice history, including its tempo record"
      >
        FORGET
      </button>
    </div>
  );
}
