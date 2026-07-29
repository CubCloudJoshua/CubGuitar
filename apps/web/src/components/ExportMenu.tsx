import { useEffect, useRef, useState } from "react";
import { Button, color, font, typeScale } from "@cubscore/design";
import { exportGp, exportMidi, exportTex, printPdf } from "../export";
import type { AlphaTabController } from "../useAlphaTab";

export function ExportMenu({ c }: { c: AlphaTabController }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  const items: Array<[string, () => void]> = [
    ["Guitar Pro (.gp)", () => { const s = c.getScore(); if (s) exportGp(s); }],
    ["alphaTex (.altex)", () => { const s = c.getScore(); if (s) exportTex(s); }],
    ["MIDI (.mid)", () => { const api = c.getApi(); if (api) exportMidi(api); }],
    ["Print / PDF", () => { const api = c.getApi(); if (api) printPdf(api); }],
  ];

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <Button variant="ghost" onClick={() => setOpen((v) => !v)} disabled={!c.score} aria-expanded={open}>
        EXPORT ▾
      </Button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 10,
            background: color.raisedHigh,
            border: `1px solid ${color.hairline}`,
            borderRadius: 8,
            overflow: "hidden",
            minWidth: 180,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {items.map(([label, fn]) => (
            <button
              key={label}
              onClick={() => run(fn)}
              style={{
                fontFamily: font.mono,
                fontSize: typeScale.base,
                textAlign: "left",
                padding: "8px 12px",
                background: "transparent",
                border: "none",
                borderBottom: `1px solid ${color.hairline}`,
                color: color.text,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
