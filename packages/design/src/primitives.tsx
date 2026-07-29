/**
 * UI primitives. Every interactive element in the app is one of these,
 * so a change here restyles the product in one place. Primitives never
 * add or alter text/aria — behavior-testing selectors must keep working
 * through any restyle.
 */
import { useEffect } from "react";
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { color, font, motion, radius, typeScale } from "./tokens";

export type ButtonVariant = "outline" | "solid" | "ghost" | "danger";

const buttonBase: CSSProperties = {
  fontFamily: font.mono,
  fontSize: typeScale.base,
  padding: "6px 12px",
  borderRadius: radius.sm,
  cursor: "pointer",
  background: "transparent",
  border: `1px solid ${color.border}`,
  color: color.text,
};

export function buttonStyle(variant: ButtonVariant, active = false, disabled = false): CSSProperties {
  const style = { ...buttonBase };
  switch (variant) {
    case "outline":
      style.border = `1px solid ${color.accent}`;
      style.color = color.accent;
      break;
    case "solid":
      style.background = color.accent;
      style.border = `1px solid ${color.accent}`;
      style.color = color.bg;
      style.fontWeight = 700;
      break;
    case "ghost":
      style.background = color.raisedHigh;
      break;
    case "danger":
      style.border = `1px solid ${color.dangerBorder}`;
      style.color = color.dangerText;
      break;
  }
  if (active) {
    style.background = color.accent;
    style.border = `1px solid ${color.accent}`;
    style.color = color.bg;
    style.fontWeight = 700;
  }
  if (disabled) {
    style.opacity = 0.4;
    style.cursor = "default";
  }
  return style;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  active?: boolean;
  size?: "sm" | "md";
}

export function Button({ variant = "ghost", active = false, size = "md", style, disabled, onMouseUp, ...rest }: ButtonProps) {
  const base = buttonStyle(variant, active, disabled ?? false);
  if (size === "sm") {
    base.fontSize = typeScale.sm;
    base.padding = "5px 9px";
  }
  return (
    <button
      {...rest}
      disabled={disabled}
      // Mouse clicks release focus so the spacebar stays the transport key;
      // keyboard focus is untouched, so tab-and-space activation still works.
      onMouseUp={(e) => {
        e.currentTarget.blur();
        onMouseUp?.(e);
      }}
      style={{ ...base, ...style }}
    />
  );
}

const fieldBase: CSSProperties = {
  fontFamily: font.mono,
  fontSize: typeScale.base,
  padding: "6px 8px",
  background: color.bg,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  color: color.text,
  minWidth: 0,
};

export function TextField({ style, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} style={{ ...fieldBase, ...style }} />;
}

export function SelectField({ style, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} style={{ ...fieldBase, padding: "5px 6px", ...style }} />;
}

/** Small dim uppercase section label. */
export function Label({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: font.mono,
        fontSize: typeScale.sm,
        color: color.textDim,
        letterSpacing: 0.5,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** Vertical rule between control groups. */
export function VDivider() {
  return <span style={{ width: 1, height: 18, background: color.border, alignSelf: "center" }} />;
}

/**
 * Edge drawer with backdrop. Always mounted so the slide transition runs;
 * inert when closed. Motion explains where the panel lives (UI-DESIGN.md 1.5).
 */
export function Drawer({
  open,
  onClose,
  children,
  width = 300,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  label: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden={!open}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: `opacity ${motion.base}`,
          zIndex: 40,
        }}
      />
      <div
        role="dialog"
        aria-label={label}
        aria-hidden={!open}
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          left: 0,
          width,
          maxWidth: "85vw",
          background: color.raised,
          borderRight: `1px solid ${color.hairline}`,
          transform: open ? "translateX(0)" : "translateX(-102%)",
          transition: `transform ${motion.base}`,
          zIndex: 41,
          overflowY: "auto",
          padding: 10,
        }}
      >
        {children}
      </div>
    </>
  );
}

/** Raised surface. `accent` marks panels that demand attention; `as` keeps semantics. */
export function Panel({
  children,
  accent = false,
  as: Tag = "div",
  style,
}: {
  children: ReactNode;
  accent?: boolean;
  as?: "div" | "aside" | "section" | "nav";
  style?: CSSProperties;
}) {
  return (
    <Tag
      style={{
        background: color.raised,
        border: `1px solid ${accent ? color.accent : color.hairline}`,
        borderRadius: radius.md,
        padding: 10,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
