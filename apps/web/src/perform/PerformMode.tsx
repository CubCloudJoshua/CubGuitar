/**
 * Perform mode (UI-DESIGN.md, Phase D).
 *
 * The one mode where the user is not at a desk. They are holding an instrument,
 * two metres from the screen, mid-song, and cannot read 11px mono or hit a 22px
 * button. So: true black, engraving pushed to full white, a position readout
 * large enough to read across a room, and page turns on tap zones a fifth of
 * the screen wide — the target a foot or an elbow can actually hit.
 *
 * Everything else leaves. The setlist is a bottom filmstrip that hides while the
 * music plays, because mid-song there is nothing to choose.
 *
 * This is deliberately a restyling of the app shell rather than a separate
 * screen. alphaTab binds to one DOM node for the life of its api, so rendering
 * the score somewhere else in the tree would give React a different node and
 * cost a full reload — new soundfont fetch, playback back to zero — every time
 * someone entered or left the mode. The score element stays exactly where it
 * is; what changes is everything around it.
 *
 * The stage palette doubles as the app's high-contrast accessibility theme,
 * which is why nothing in it is dimmer than the default.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { color, font, motion, stage } from "@cubscore/design";
import type { LibraryEntry } from "../library/db";

export function clockText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Turns a page: most of a screen, not all of it. The overlap is what keeps a
 * player from losing their place across the turn.
 *
 * The preference is read here rather than left to CSS: an explicit `behavior`
 * on scrollBy overrides `scroll-behavior`, so the global reduced-motion rule in
 * index.html cannot reach it.
 */
export function turnPage(scroller: HTMLElement | null, direction: 1 | -1): void {
  if (!scroller) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  scroller.scrollBy({
    top: direction * scroller.clientHeight * 0.8,
    behavior: still ? "auto" : "smooth",
  });
}

/**
 * A tap zone. Enormous, and unlabelled until touched: on stage the target
 * matters and the label does not, and a permanent label over the music is
 * chrome in the one mode that exists to have none.
 */
function TapZone({ side, label, onTap }: { side: "left" | "right"; label: string; onTap: () => void }) {
  const [hot, setHot] = useState(false);
  return (
    <button
      onClick={onTap}
      onPointerDown={() => setHot(true)}
      onPointerUp={() => setHot(false)}
      onPointerLeave={() => setHot(false)}
      onMouseUp={(ev) => ev.currentTarget.blur()}
      aria-label={label}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        ...(side === "left" ? { left: 0 } : { right: 0 }),
        width: "20%",
        maxWidth: 240,
        border: "none",
        background: hot
          ? `linear-gradient(to ${side === "left" ? "right" : "left"}, rgba(240,125,0,0.22), transparent)`
          : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: side === "left" ? "flex-start" : "flex-end",
        padding: "0 20px",
        fontFamily: font.mono,
        fontSize: 40,
        color: hot ? color.accentLive : "transparent",
        transition: `background ${motion.fast}, color ${motion.fast}`,
        zIndex: 4,
      }}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}

const bigButton = (accented: boolean): React.CSSProperties => ({
  padding: "14px 18px",
  minWidth: 92,
  background: accented ? color.accent : "transparent",
  border: `${accented ? 2 : 1}px solid ${accented ? color.accent : stage.hairline}`,
  borderRadius: 8,
  color: accented ? stage.bg : stage.textDim,
  fontFamily: font.display,
  fontSize: 24,
  letterSpacing: 1,
  cursor: "pointer",
  transition: `background ${motion.base}, color ${motion.base}`,
});

/** The stage controls: the only permanent chrome in the mode. */
export function PerformBar({
  playing,
  currentSeconds,
  remainingSeconds,
  onPlayPause,
  onStop,
  onExit,
}: {
  playing: boolean;
  currentSeconds: number;
  remainingSeconds: number;
  onPlayPause: () => void;
  onStop: () => void;
  onExit: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        padding: "10px 18px",
        borderTop: `1px solid ${stage.hairline}`,
        background: stage.raised,
      }}
    >
      <button
        onClick={onPlayPause}
        onMouseUp={(ev) => ev.currentTarget.blur()}
        aria-label={playing ? "Pause" : "Play"}
        style={{ ...bigButton(true), color: playing ? stage.bg : color.accent, background: playing ? color.accent : "transparent" }}
      >
        {playing ? "PAUSE" : "PLAY"}
      </button>
      <button onClick={onStop} onMouseUp={(ev) => ev.currentTarget.blur()} aria-label="Stop" style={bigButton(false)}>
        STOP
      </button>

      <span
        aria-label="Position"
        style={{
          fontFamily: font.mono,
          fontSize: 44,
          lineHeight: 1,
          color: stage.text,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {clockText(currentSeconds)}
      </span>
      <span style={{ fontFamily: font.mono, fontSize: 20, color: stage.textDim }}>
        {"−"}
        {clockText(remainingSeconds)}
      </span>

      <span style={{ flex: 1 }} />
      <button
        onClick={onExit}
        onMouseUp={(ev) => ev.currentTarget.blur()}
        aria-label="Leave perform mode"
        style={bigButton(false)}
      >
        EXIT
      </button>
    </div>
  );
}

/** Setlist filmstrip. Gone while the music plays. */
export function Setlist({
  entries,
  currentId,
  onOpen,
}: {
  entries: LibraryEntry[];
  currentId: string | null;
  onOpen: (entry: LibraryEntry) => void;
}) {
  return (
    <div
      aria-label="Setlist"
      style={{
        display: "flex",
        gap: 8,
        overflowX: "auto",
        padding: "10px 14px",
        borderTop: `1px solid ${stage.hairline}`,
        background: stage.bg,
      }}
    >
      {entries.map((entry) => {
        const active = entry.id === currentId;
        return (
          <button
            key={entry.id}
            onClick={() => onOpen(entry)}
            onMouseUp={(ev) => ev.currentTarget.blur()}
            aria-label={`Play ${entry.title}`}
            aria-current={active ? "true" : undefined}
            style={{
              flex: "0 0 auto",
              maxWidth: 240,
              textAlign: "left",
              padding: "12px 16px",
              background: active ? color.accent : "transparent",
              border: `1px solid ${active ? color.accent : stage.hairline}`,
              borderRadius: 8,
              color: active ? stage.bg : stage.text,
              fontFamily: font.mono,
              fontSize: 16,
              cursor: "pointer",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              transition: `background ${motion.base}, color ${motion.base}`,
            }}
          >
            {entry.title}
            {entry.artist ? (
              <span style={{ color: active ? stage.bg : stage.textDim }}> · {entry.artist}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export { TapZone };

/**
 * The keyboard and body-background side of the mode. Kept as a hook so the
 * shell can own layout while this owns the behaviour that has to be undone on
 * the way out.
 */
/** How much larger the notation is on stage than at a desk. */
const STAGE_ZOOM = 1.4;

export function usePerformShell({
  active,
  scroller,
  onExit,
  seekSeconds,
  setStageEngraving,
  setScrollElement,
  zoom,
  setZoom,
}: {
  active: boolean;
  scroller: HTMLElement | null;
  onExit: () => void;
  seekSeconds: (delta: number) => void;
  setStageEngraving: (on: boolean) => void;
  setScrollElement: (element: HTMLElement | null) => void;
  zoom: number;
  setZoom: (value: number) => void;
}) {
  // Brighter engraving for the duration, restored on the way out so the editor
  // and player keep the palette tuned for close reading.
  useEffect(() => {
    if (!active) return;
    setStageEngraving(true);
    return () => setStageEngraving(false);
  }, [active, setStageEngraving]);

  // Bigger notation, because "maximum width" on stage means legible at
  // instrument distance rather than merely edge to edge. The zoom the user had
  // is restored on the way out; held in a ref so raising it inside the mode
  // does not re-run the effect and fight itself. Tracked while outside the mode
  // rather than captured once, or entering would restore whatever zoom the app
  // started with instead of the one the user had just set.
  const zoomOnEntry = useRef(zoom);
  if (!active) zoomOnEntry.current = zoom;
  useEffect(() => {
    if (!active) return;
    const previous = zoomOnEntry.current;
    setZoom(STAGE_ZOOM);
    return () => setZoom(previous);
  }, [active, setZoom]);

  // True black behind the browser's overscroll too, or the stage has a grey halo.
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.background;
    document.body.style.background = stage.bg;
    return () => {
      document.body.style.background = previous;
    };
  }, [active]);

  // The score gets its own scroller here, and alphaTab has to follow playback
  // in it rather than in the window.
  useEffect(() => {
    if (!active || !scroller) return;
    setScrollElement(scroller);
    return () => setScrollElement(null);
  }, [active, scroller, setScrollElement]);

  const page = useCallback((direction: 1 | -1) => turnPage(scroller, direction), [scroller]);

  useEffect(() => {
    if (!active) return;
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      switch (ev.key) {
        case "Escape": ev.preventDefault(); onExit(); break;
        case "PageDown":
        case "ArrowDown": ev.preventDefault(); page(1); break;
        case "PageUp":
        case "ArrowUp": ev.preventDefault(); page(-1); break;
        case "ArrowLeft": ev.preventDefault(); seekSeconds(-5); break;
        case "ArrowRight": ev.preventDefault(); seekSeconds(5); break;
        default: break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, onExit, page, seekSeconds]);

  return { page };
}
