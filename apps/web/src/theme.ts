export const theme = {
  bg: "#080808",
  panel: "#111111",
  panelAlt: "#161616",
  border: "#333333",
  text: "#eeeeee",
  textDim: "#888888",
  accent: "#F07D00",
  accentBright: "#FF9120",
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** alphaTab render colors, tuned for the dark UI. */
export const notationColors = {
  mainGlyphColor: theme.text,
  secondaryGlyphColor: theme.textDim,
  staffLineColor: "#555555",
  barSeparatorColor: "#555555",
  barNumberColor: theme.accent,
  scoreInfoColor: theme.text,
};
