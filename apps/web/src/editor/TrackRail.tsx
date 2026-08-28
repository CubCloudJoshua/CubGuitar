/**
 * The instrument rail (UI-DESIGN.md, Write mode: "track switching is a left
 * rail of instrument glyphs").
 *
 * Switching tracks was buried two clicks deep in a popover behind a select,
 * which is the wrong cost for the thing a multitrack arrangement asks you to do
 * most. The rail puts every track one click away, beside the score, showing
 * which one the caret is in — and it carries add and remove, so the popover it
 * replaces is gone rather than merely lightened.
 */
import { color, font, motion, typeScale } from "@cubscore/design";
import type { Track } from "@cubscore/core";

/**
 * Instrument glyphs, one stroke weight, no fill. A bass reads as a guitar with
 * a longer neck and fewer pegs, which is exactly how it reads on a stage.
 */
/**
 * What the track is, in twenty pixels.
 *
 * `strings` is null for a track that has none. It used to be 6 for every such track,
 * which drew a guitar beside a drum kit and labelled it "6 strings" — harmless while
 * percussion was unwritable and read-only, wrong the moment a kit became something you
 * type into.
 */
function InstrumentGlyph({ strings, active }: { strings: number | null; active: boolean }) {
  const stroke = active ? color.accent : color.textDim;
  const bass = strings !== null && strings <= 4;
  if (strings === null) {
    return (
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ transition: `stroke ${motion.base}` }}
      >
        {/* A kit read from the front: kick, snare, and a cymbal on its stand. */}
        <circle cx="7" cy="14" r="4" />
        <line x1="13" y1="14" x2="13" y2="6" />
        <line x1="9.5" y1="6" x2="16.5" y2="6" />
      </svg>
    );
  }
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke={stroke}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transition: `stroke ${motion.base}` }}
    >
      <ellipse cx="7" cy="13" rx="5" ry="5.5" />
      <line x1="10.5" y1="9.5" x2={bass ? 17.5 : 16} y2={bass ? 2.5 : 4} />
      <line x1={bass ? 15 : 13.6} y1={bass ? 2 : 3.4} x2={bass ? 17 : 15.6} y2={bass ? 4 : 5.4} />
      {!bass && <line x1="15.2" y1="1.8" x2="17.2" y2="3.8" />}
    </svg>
  );
}

function railButton(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    width: 52,
    padding: "6px 0",
    background: active ? color.raisedHigh : "transparent",
    border: "none",
    borderLeft: `2px solid ${active ? color.accent : "transparent"}`,
    borderRadius: 4,
    cursor: "pointer",
    fontFamily: font.mono,
    fontSize: typeScale.xs,
    color: active ? color.accentLive : color.textDim,
    transition: `background ${motion.base}, color ${motion.base}`,
  };
}

/** A track's string count, or null for a staff that has none. */
function stringCount(track: Track): number | null {
  return track.instrument.kind === "fretted" ? track.instrument.tuning.length : null;
}

/** What the rail's tooltip says the track is. */
function describe(track: Track): string {
  const strings = stringCount(track);
  if (strings !== null) return `${track.name} · ${strings} strings`;
  return `${track.name} · ${track.instrument.kind === "drums" ? "drum kit" : "pitched staff"}`;
}

export function TrackRail({
  tracks,
  activeIndex,
  onSelect,
  onAdd,
  onRemove,
}: {
  tracks: Track[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onAdd: (kind: "guitar" | "bass") => void;
  onRemove: () => void;
}) {
  return (
    <nav
      aria-label="Tracks"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 2,
        flex: "0 0 auto",
        paddingRight: 6,
        borderRight: `1px solid ${color.hairline}`,
      }}
    >
      {tracks.map((track, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={track.id}
            onClick={() => onSelect(index)}
            // Buttons keep focus after a click, and the spacebar then reaches
            // the button instead of the transport. Blur on release, not on
            // mousedown, so the click still lands.
            onMouseUp={(ev) => ev.currentTarget.blur()}
            aria-current={active ? "true" : undefined}
            aria-label={`Track ${index + 1}: ${track.name}`}
            title={describe(track)}
            style={railButton(active)}
          >
            <InstrumentGlyph strings={stringCount(track)} active={active} />
            <span
              style={{
                maxWidth: 48,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {track.name}
            </span>
          </button>
        );
      })}

      <div style={{ height: 1, background: color.hairline, margin: "4px 2px" }} />

      <button
        onClick={() => onAdd("guitar")}
        onMouseUp={(ev) => ev.currentTarget.blur()}
        aria-label="Add guitar track"
        title="Add a standard-tuned guitar track"
        style={railButton(false)}
      >
        <span style={{ fontSize: typeScale.base, lineHeight: 1 }}>+</span>
        <span>GTR</span>
      </button>
      <button
        onClick={() => onAdd("bass")}
        onMouseUp={(ev) => ev.currentTarget.blur()}
        aria-label="Add bass track"
        title="Add a standard-tuned bass track"
        style={railButton(false)}
      >
        <span style={{ fontSize: typeScale.base, lineHeight: 1 }}>+</span>
        <span>BASS</span>
      </button>
      {tracks.length > 1 && (
        <button
          onClick={onRemove}
          onMouseUp={(ev) => ev.currentTarget.blur()}
          aria-label="Remove active track"
          title="Remove the active track"
          style={{ ...railButton(false), color: color.textFaint }}
        >
          <span style={{ fontSize: typeScale.base, lineHeight: 1 }}>×</span>
          <span>TRK</span>
        </button>
      )}
    </nav>
  );
}
