import { theme } from "../theme";

export const headerButton = {
  fontFamily: theme.mono,
  fontSize: 12,
  padding: "6px 12px",
  border: `1px solid ${theme.accent}`,
  background: "transparent",
  color: theme.accent,
  cursor: "pointer",
} as const;
