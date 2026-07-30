/**
 * Joining a session (UI-DESIGN.md, signature moment 3): "Opening a collab link
 * plays a 400ms sequence: score materializes system by system, then peer carets
 * fade in with names."
 *
 * It is the first impression of the feature the product is built around, and
 * without it joining looked like a bug: a blank surface for as long as the
 * handshake took, then a whole score and a stranger's caret arriving in the same
 * frame with nothing to say which was which.
 *
 * The score is not animated — alphaTab engraves into one canvas and there is no
 * per-system handle to fade. What moves is a set of bands in the background
 * colour, one per staff system, lifting in order. The music is already there
 * underneath, so nothing about the sequence can delay or disturb the render, and
 * if it were skipped entirely the score would simply be visible.
 */
import { useEffect, useRef, useState } from "react";
import { color, motion } from "@cubscore/design";
import type { SystemBox } from "../useAlphaTab";

/**
 * The materialize pass, and the caret fade that follows it. 400ms in total, as
 * specified — long enough to read as deliberate, short enough that nobody who
 * joins to get to work is waiting on it.
 */
const SYSTEMS_MS = 260;
const CARETS_MS = 140;
/** Each band's own fade. Overlaps its neighbours, so the pass reads as a sweep. */
const BAND_MS = 180;

/**
 * "armed" is the gap between the snapshot arriving and the score being engraved:
 * carets are already suppressed, but there is nothing to draw bands over yet.
 */
export type RevealPhase = "none" | "armed" | "systems" | "carets";

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs the sequence when `joinCount` increments, which the collab client does on
 * each snapshot it loads as a guest.
 *
 * Arming and starting are separate because the arrival and the engraving are
 * separate events: the snapshot has to be turned into alphaTex, parsed, laid out
 * and measured before there is any system geometry, and starting the timers
 * before that would spend the sequence on an empty surface.
 */
export function useJoinReveal(joinCount: number, systemCount: number): RevealPhase {
  const [phase, setPhase] = useState<RevealPhase>("none");
  const handledRef = useRef(0);
  const armedRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  useEffect(() => () => timersRef.current.forEach((id) => clearTimeout(id)), []);

  useEffect(() => {
    if (joinCount === 0 || joinCount === handledRef.current) return;
    handledRef.current = joinCount;
    // Someone who has asked for less motion gets the score and the carets at
    // once. Not a shortened sequence — a sequence is the thing they turned off.
    if (prefersReducedMotion()) return;
    armedRef.current = true;
    setPhase("armed");
  }, [joinCount]);

  useEffect(() => {
    if (!armedRef.current || systemCount === 0) return;
    armedRef.current = false;
    setPhase("systems");
    // Timers live in a ref rather than this effect's cleanup on purpose. A
    // re-layout mid-sequence — a window resize, a track appearing — changes
    // systemCount, and cleanup would then cancel the timers without anything
    // restarting them, leaving the bands parked over the score for good.
    timersRef.current.push(
      window.setTimeout(() => setPhase("carets"), SYSTEMS_MS),
      window.setTimeout(() => setPhase("none"), SYSTEMS_MS + CARETS_MS),
    );
  }, [systemCount]);

  return phase;
}

/** Whether peer carets should be on screen during a given phase. */
export function caretsVisible(phase: RevealPhase): boolean {
  return phase === "none" || phase === "carets";
}

/**
 * How to bring the carets in: a fade during the sequence, nothing otherwise.
 *
 * A keyframe rather than a transition. The carets mount at the start of the
 * fade, and a transition needs a committed frame at the old value before the new
 * one to have anything to interpolate — an earlier version set `opacity: 1` with
 * a transition, so the carets simply appeared: the sequence's whole point
 * missing, while looking like it had been implemented.
 */
export function caretEntry(phase: RevealPhase): { animation?: string } {
  return phase === "carets" ? { animation: `cubscore-caret-in ${CARETS_MS}ms ease-out both` } : {};
}

export function JoinReveal({ phase, systemBoxes }: { phase: RevealPhase; systemBoxes: SystemBox[] }) {
  if (phase !== "systems" || systemBoxes.length === 0) return null;

  // The whole pass fits in SYSTEMS_MS however many systems there are, so a
  // 40-system import sweeps at the same speed as a 2-system sketch rather than
  // taking twenty times as long.
  const step = systemBoxes.length > 1 ? (SYSTEMS_MS - BAND_MS / 2) / (systemBoxes.length - 1) : 0;

  return (
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 4 }}>
      {systemBoxes.map((box, i) => (
        <div
          key={i}
          // A stable hook for the e2e sequencer, which samples every animation
          // frame of the join to check the bands really are staggered rather than
          // all lifting at once. Cheaper and steadier than matching on computed
          // animation names sixty times a second.
          data-reveal-band={i}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: box.y - 1,
            // Stretched to meet the system below rather than using its own
            // height. alphaTab reserves a little space around each system that
            // belongs to neither, and bands cut to their own bounds left a
            // visible stripe of un-lifted background between every pair — the
            // pass read as stripes instead of one curtain. Where a band ends is
            // therefore where the next one starts, whatever the layout reserves.
            height: (systemBoxes[i + 1]?.y ?? box.y + box.height) - box.y + 1,
            background: color.bg,
            animation: `cubscore-reveal ${BAND_MS}ms ${motion.base.split(" ").slice(1).join(" ")} ${Math.round(i * step)}ms both`,
          }}
        />
      ))}
      {/* Keyframes rather than a transition: a transition needs a committed
          starting frame before the value changes, and these mount already
          opaque. Scoped here because this is the only thing that uses it. */}
      <style>{`@keyframes cubscore-reveal { from { opacity: 1 } to { opacity: 0 } }`}</style>
    </div>
  );
}
