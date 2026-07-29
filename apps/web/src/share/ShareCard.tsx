/**
 * The share moment (UI-DESIGN.md, signature moments): "One press produces the
 * link with a spring-in card and auto-copy; the card shows a live miniature of
 * the first system of the score, so what you send looks like music, not a URL."
 *
 * The miniature is the point. A share used to be a text field containing a
 * random string, which tells the sender nothing about whether they shared the
 * right thing. Showing the first system answers that in one glance, and it costs
 * nothing to render: the notation is already on the page.
 */
import { useEffect, useRef, useState } from "react";
import { Button, color, font, Label, motion, TextField, typeScale } from "@cubscore/design";

/**
 * Renames every id in a cloned SVG.
 *
 * SVG references are document-wide. The card renders above the score, so a
 * clone with the original's ids comes first in document order and the *original*
 * score's `url(#glyph)` references start resolving into the copy — the real
 * score visibly breaks because of its own thumbnail. Prefixing makes the clone
 * self-contained.
 */
function isolateIds(svg: SVGElement, prefix: string): void {
  const renamed = new Map<string, string>();
  for (const el of svg.querySelectorAll("[id]")) {
    const old = el.getAttribute("id");
    if (!old) continue;
    const next = `${prefix}${old}`;
    renamed.set(old, next);
    el.setAttribute("id", next);
  }
  if (renamed.size === 0) return;

  const rewrite = (value: string): string =>
    value.replace(/#([^)"'\s]+)/g, (whole, id: string) => {
      const next = renamed.get(id);
      return next ? `#${next}` : whole;
    });

  // Any attribute can carry a reference: fill="url(#x)", href="#x", clip-path,
  // mask, filter, marker-*. Rewriting by value rather than by name keeps this
  // correct as alphaTab's output changes.
  const walk = (el: Element) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === "id" || !attr.value.includes("#")) continue;
      const next = rewrite(attr.value);
      if (next !== attr.value) el.setAttribute(attr.name, next);
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(svg);
}

/** alphaTab writes sizes as "1262px", which Number() reads as NaN. */
function sizeOf(svg: SVGElement, attribute: "width" | "height"): number {
  const parsed = Number.parseFloat(svg.getAttribute(attribute) ?? "");
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const rect = svg.getBoundingClientRect();
  return attribute === "width" ? rect.width : rect.height;
}

/**
 * The first staff system in the rendered score.
 *
 * Picked by height rather than by position, because alphaTab emits several
 * short svgs around the music — spacers of twelve and twenty pixels, and a
 * header block holding the centred title. Taking the first tall-enough one
 * chose that header, and since the title is centred it fell outside the
 * thumbnail's width: a black rectangle. Systems are the tallest thing on the
 * page, and ties resolve to the earliest, which is the first system.
 */
function firstSystem(): SVGElement | null {
  const svgs = Array.from(document.querySelectorAll<SVGElement>(".at-surface svg"));
  return svgs.reduce<SVGElement | null>(
    (tallest, svg) =>
      !tallest || sizeOf(svg, "height") > sizeOf(tallest, "height") ? svg : tallest,
    null,
  );
}

/** The first staff system of the rendered score, scaled to fit. */
function ScoreThumbnail({ height = 104 }: { height?: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const source = firstSystem();
    if (!source) return;

    const clone = source.cloneNode(true) as SVGElement;
    isolateIds(clone, `share-${Math.random().toString(36).slice(2, 8)}-`);
    clone.removeAttribute("style");
    // Hidden from assistive tech: it is decoration, and the score itself is
    // already on the page for anyone reading it.
    clone.setAttribute("aria-hidden", "true");

    const width = sizeOf(source, "width");
    const sourceHeight = sizeOf(source, "height");
    if (!width || !sourceHeight) return;
    // Fit by height so the whole system is visible; a wide arrangement clips at
    // the right edge, which reads as "there is more" rather than as a crop.
    const scale = Math.min(1, height / sourceHeight);

    const stage = document.createElement("div");
    stage.style.transform = `scale(${scale})`;
    stage.style.transformOrigin = "top left";
    stage.style.width = `${width}px`;
    stage.appendChild(clone);
    host.replaceChildren(stage);
    setRendered(true);

    return () => host.replaceChildren();
  }, [height]);

  return (
    <div
      ref={hostRef}
      style={{
        height,
        flex: "1 1 260px",
        minWidth: 0,
        overflow: "hidden",
        borderRadius: 4,
        background: color.bg,
        opacity: rendered ? 1 : 0,
        transition: `opacity ${motion.base}`,
      }}
    />
  );
}

export function ShareCard({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  // Auto-copy, then say so. The link is useless in the app; the only thing the
  // user wants is it on their clipboard, so doing it for them removes the one
  // step that was always next.
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => live && setCopied(true))
      .catch(() => live && setCopied(false));
    return () => {
      live = false;
    };
  }, [url]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
        background: color.raised,
        border: `1px solid ${color.accent}`,
        borderRadius: 8,
        padding: 10,
        marginBottom: 10,
        // Springs in from where the SHARE button is, which is what says the card
        // came from that press rather than merely appearing.
        animation: "cub-share-in 220ms cubic-bezier(0.2, 0.9, 0.3, 1.2)",
      }}
    >
      <ScoreThumbnail />
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "2 1 320px", minWidth: 0 }}>
        <Label style={{ color: color.accent }}>{copied === true ? "COPIED" : "LINK"}</Label>
        <TextField
          readOnly
          value={url}
          aria-label="Share link"
          onFocus={(e) => e.target.select()}
          style={{ flex: 1, minWidth: 0 }}
        />
        {/* Only offered when the automatic copy did not happen: a browser that
            refuses clipboard access without a gesture, or an insecure origin. */}
        {copied !== true && (
          <Button
            variant="outline"
            onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined)}
          >
            COPY
          </Button>
        )}
        <Button onClick={onDismiss} aria-label="Dismiss share link" style={{ color: color.textDim }}>
          ×
        </Button>
      </div>
      <span style={{ flexBasis: "100%", fontFamily: font.mono, fontSize: typeScale.xs, color: color.textDim }}>
        {copied === true
          ? "On your clipboard. The recipient gets a read-only player with the practice tools, nothing to install."
          : "The recipient gets a read-only player with the practice tools, nothing to install."}
      </span>
    </div>
  );
}
