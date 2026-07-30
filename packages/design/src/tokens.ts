/**
 * CubScore design tokens (UI-DESIGN.md, section 2).
 *
 * The entire visual language: a 9-value core palette on near-black, two
 * type families, one spacing unit, one motion voice. Components consume
 * these; nothing outside this package hard-codes a color.
 */

export const color = {
  /** The one continuous background. */
  bg: "#080808",
  /** Elevation tints; depth without borders. */
  raised: "#111111",
  raisedHigh: "#161616",
  /** The single hairline, used sparingly. */
  hairline: "#2A2A2A",
  border: "#333333",

  text: "#EEEEEE",
  textDim: "#9A9A9A",
  textFaint: "#6A6A6A",

  /** Spent on exactly three things: playing, selected, primary action. */
  accent: "#F07D00",
  /** Live/active pulses only. */
  accentLive: "#FF9120",

  dangerBg: "#2A1010",
  dangerBorder: "#7A2020",
  dangerText: "#FFB0B0",
  noticeBg: "#241A06",
} as const;

/**
 * Collaborator colours: the one sanctioned exception to one-accent.
 *
 * UI-DESIGN.md spends the accent on exactly three things — playing, selected,
 * primary action — and then asks for presence to render as "coloured carets with
 * name tags in the score". Those two only reconcile if peers get their own hues,
 * so these are deliberately none of them orange: a caret must never be mistaken
 * for the playback cursor or for your own selection. Chosen to stay legible on
 * near-black and to differ from each other for the common kinds of colour
 * blindness, which is why there is no red-green pair.
 */
export const presence = ["#4EC9E8", "#B08CFF", "#FFD166", "#5DD39E", "#FF8FB1"] as const;

/**
 * Practice heat: how a bar went, painted on the bar itself.
 *
 * The second sanctioned exception, for the same reason as the first — the accent
 * means playing, selected or primary action, and a bar that went badly is none of
 * those. Drawn from the presence hues rather than invented, since those are already
 * chosen to stay legible on near-black and to avoid a red-green pair, which matters
 * more here than anywhere else in the product: this is the one surface whose whole
 * job is to be read at a glance.
 *
 * Colour is never the only signal. The readout beside the score states the same
 * thing in numbers, because a heatmap alone is unreadable to a fair number of people
 * and unreadable in a photograph of a screen to everybody.
 */
export const heat = {
  /** Played, in time. */
  clean: "#5DD39E",
  /** Played, but not all of it, or not in time. */
  weak: "#FFD166",
  /** Wrong notes, or nothing at all. */
  wrong: "#FF8FB1",
  /** Nothing to judge: a bar of rests, or notes a monophonic pass cannot check. */
  unheard: "#4A4A4A",
} as const;

export const font = {
  /** Data readouts: positions, tempo, tuning, code-like text. */
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  /** Wordmark and mode labels only. */
  display: '"Bebas Neue", "Arial Narrow", sans-serif',
} as const;

/** Four sizes, nothing else (px). */
export const typeScale = { xs: 10, sm: 11, base: 12, lg: 24 } as const;

/** Spacing unit: 4px grid. */
export const space = (n: number): number => n * 4;

export const radius = { sm: 4, md: 8 } as const;

export const motion = {
  fast: "150ms cubic-bezier(0.4, 0, 0.2, 1)",
  base: "200ms cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

/** Score engraving colors, tuned for the dark surface. */
export const notation = {
  mainGlyphColor: color.text,
  secondaryGlyphColor: color.textDim,
  staffLineColor: "#555555",
  barSeparatorColor: "#555555",
  barNumberColor: color.accent,
  scoreInfoColor: color.text,
} as const;

/**
 * The stage palette (UI-DESIGN.md, Perform mode). True black rather than
 * near-black, and engraving pushed to full white with brighter staff lines,
 * because Perform is read from two metres away under stage light rather than
 * from arm's length in a dark room. It doubles as the high-contrast
 * accessibility theme, which is why nothing here is dimmer than the base
 * palette rather than merely different.
 */
export const stage = {
  bg: "#000000",
  raised: "#0A0A0A",
  hairline: "#333333",
  text: "#FFFFFF",
  textDim: "#B4B4B4",
} as const;

export const stageNotation = {
  mainGlyphColor: stage.text,
  secondaryGlyphColor: stage.textDim,
  staffLineColor: "#8A8A8A",
  barSeparatorColor: "#8A8A8A",
  barNumberColor: color.accentLive,
  scoreInfoColor: stage.text,
} as const;
