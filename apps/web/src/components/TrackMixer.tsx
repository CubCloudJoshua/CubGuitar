import { theme } from "../theme";
import { toggleStyle } from "./Toolbar";
import type { AlphaTabController } from "../useAlphaTab";

export function TrackMixer({ c }: { c: AlphaTabController }) {
  if (c.tracks.length === 0) return null;

  return (
    <div
      style={{
        background: theme.panel,
        border: `1px solid ${theme.border}`,
        padding: 10,
        marginBottom: 10,
      }}
    >
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 11,
          color: theme.textDim,
          letterSpacing: 0.5,
          marginBottom: 8,
        }}
      >
        TRACKS ({c.tracks.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {c.tracks.map((t) => (
          <div key={t.index} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontFamily: theme.mono,
                fontSize: 12,
                color: t.muted ? theme.textDim : theme.text,
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
              style={{ width: 88, accentColor: theme.accent }}
              aria-label={`${t.name} volume`}
            />
            <button
              onClick={() => c.setTrackMuted(t.index, !t.muted)}
              style={{ ...toggleStyle(t.muted), padding: "4px 10px" }}
              aria-pressed={t.muted}
            >
              M
            </button>
            <button
              onClick={() => c.setTrackSolo(t.index, !t.solo)}
              style={{ ...toggleStyle(t.solo), padding: "4px 10px" }}
              aria-pressed={t.solo}
            >
              S
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
