import { Button, color, font, typeScale } from "@cubscore/design";
import type { AlphaTabController } from "../useAlphaTab";

/** Per-track volume/mute/solo rows; hosted by the transport's expanded panel. */
export function TrackRows({ c }: { c: AlphaTabController }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {c.tracks.map((t) => (
        <div key={t.index} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: font.mono,
              fontSize: typeScale.base,
              color: t.muted ? color.textDim : color.text,
              flex: "1 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {t.name}
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={t.volume}
            onChange={(e) => c.setTrackVolume(t.index, Number(e.target.value))}
            style={{ width: 88, accentColor: color.accent }}
            aria-label={`${t.name} volume`}
          />
          <Button
            size="sm"
            onClick={() => c.setTrackMuted(t.index, !t.muted)}
            active={t.muted}
            aria-pressed={t.muted}
            style={{ padding: "4px 10px" }}
          >
            M
          </Button>
          <Button
            size="sm"
            onClick={() => c.setTrackSolo(t.index, !t.solo)}
            active={t.solo}
            aria-pressed={t.solo}
            style={{ padding: "4px 10px" }}
          >
            S
          </Button>
        </div>
      ))}
    </div>
  );
}
