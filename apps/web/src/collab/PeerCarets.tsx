/**
 * Collaborators, in the music (UI-DESIGN.md, Write mode: "Collab presence
 * renders as coloured carets with name tags in the score, not a banner").
 *
 * Presence used to be a sentence — "guest at bar 1, beat 2" — which is the
 * information without the point of it. What you want to know while two people
 * edit one score is whether the other person is near you, and a sentence makes
 * you count bars to find out. A caret in the staff answers it without reading.
 *
 * Positioned from alphaTab's own beat geometry, so a caret sits exactly where
 * that beat's notes are rather than at a guessed fraction of the bar.
 */
import { color, font, motion, presence, typeScale } from "@cubscore/design";
import type { BarBox } from "../useAlphaTab";
import type { PeerCursor } from "./useCollab";

/**
 * A stable colour per peer, so someone does not change colour because a third
 * person joined. Peer ids from the server are "m1", "m2", …, and the trailing
 * number is what makes them distinct.
 */
function colourFor(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i += 1) hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
  return presence[Math.abs(hash) % presence.length] ?? presence[0];
}

export function PeerCarets({
  cursors,
  barBoxes,
  entry,
}: {
  cursors: Map<string, PeerCursor>;
  barBoxes: BarBox[];
  /** How the carets arrive: the join sequence fades them in, see JoinReveal. */
  entry?: { animation?: string };
}) {
  if (cursors.size === 0 || barBoxes.length === 0) return null;

  return (
    <div style={{ ...entry, position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* The join sequence's caret fade. Declared here because this is the only
          thing it applies to, and it has to exist whenever a caret can mount. */}
      <style>{`@keyframes cubscore-caret-in { from { opacity: 0 } to { opacity: 1 } }`}</style>
      {[...cursors.entries()].map(([peerId, peer]) => {
        const box = barBoxes.find((b) => b.index === peer.bar);
        // A peer editing a bar this client has not rendered — a longer document
        // on their side, or a render in flight — simply has no caret to draw.
        if (!box) return null;
        const hue = colourFor(peerId);
        const x = box.beats[peer.beat] ?? box.x;

        return (
          <div
            key={peerId}
            aria-hidden="true"
            style={{
              position: "absolute",
              left: x,
              top: box.y,
              height: box.height,
              // Never intercepts a click: the score underneath stays clickable,
              // which is how you seek and select.
              pointerEvents: "none",
              zIndex: 3,
              transition: `left ${motion.base}, top ${motion.base}`,
            }}
          >
            <div style={{ width: 2, height: "100%", background: hue, opacity: 0.85 }} />
            <span
              style={{
                position: "absolute",
                top: -16,
                left: 0,
                whiteSpace: "nowrap",
                background: hue,
                color: color.bg,
                fontFamily: font.mono,
                fontSize: typeScale.xs,
                lineHeight: 1.5,
                padding: "0 4px",
                borderRadius: 3,
              }}
            >
              {peer.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The same names, for anyone who cannot see the carets. Carets are decoration to
 * a screen reader — position in a staff is not something it can convey — so the
 * fact of who is in the session, and where, still needs saying in words.
 */
export function PeerRoster({ cursors }: { cursors: Map<string, PeerCursor> }) {
  const peers = [...cursors.values()];
  if (peers.length === 0) return null;
  return (
    <span role="status" style={{ fontFamily: font.mono, fontSize: typeScale.sm, color: color.textDim }}>
      {/* Leading separator: this sits beside the session count, and without one
          the two run together as "2 in session guest at bar 2". */}
      {`· ${peers.map((p) => `${p.name} at bar ${p.bar + 1}, beat ${p.beat + 1}`).join(" · ")}`}
    </span>
  );
}
