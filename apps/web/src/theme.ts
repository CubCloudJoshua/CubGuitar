/**
 * Compatibility shim over @cubscore/design tokens. New code imports the
 * design package directly; this mapping keeps older call sites compiling
 * while Phase A conversions land, and disappears with them.
 */
import { color, font, notation, stageNotation } from "@cubscore/design";

export const theme = {
  bg: color.bg,
  panel: color.raised,
  panelAlt: color.raisedHigh,
  border: color.border,
  text: color.text,
  textDim: color.textDim,
  accent: color.accent,
  accentBright: color.accentLive,
  mono: font.mono,
} as const;

/** alphaTab render colors, from the design tokens. */
export const notationColors = notation;
/** The brighter engraving Perform mode switches to. */
export const stageNotationColors = stageNotation;
