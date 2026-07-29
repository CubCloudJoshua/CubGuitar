import type { CSSProperties } from "react";
import { Button, buttonStyle, color, font, Label, typeScale, VDivider } from "@cubscore/design";
import type { AlphaTabController } from "../useAlphaTab";

const SPEED_PRESETS = [0.5, 0.75, 1];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Kept for callers still styling raw elements; new code uses <Button active>. */
export function toggleStyle(active: boolean): CSSProperties {
  return buttonStyle("ghost", active);
}

export function Toolbar({ c }: { c: AlphaTabController }) {
  const disabled = !c.ready;
  const progress = c.position.endTime > 0 ? c.position.currentTime / c.position.endTime : 0;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
        padding: 10,
        background: color.raised,
        border: `1px solid ${color.hairline}`,
        borderRadius: 8,
        marginBottom: 10,
      }}
    >
      <Button variant="solid" onClick={c.playPause} disabled={disabled} style={{ minWidth: 76 }}>
        {c.playing ? "PAUSE" : "PLAY"}
      </Button>
      <Button variant="ghost" onClick={c.stop} disabled={disabled}>
        STOP
      </Button>

      <span style={{ fontFamily: font.mono, fontSize: typeScale.base, color: color.textDim, minWidth: 92 }}>
        {formatTime(c.position.currentTime / 1000)} / {formatTime(c.position.endTime / 1000)}
      </span>

      <div style={{ flex: "1 1 120px", height: 4, background: color.border, minWidth: 80, borderRadius: 2 }}>
        <div
          style={{
            width: `${Math.min(100, progress * 100)}%`,
            height: "100%",
            background: color.accentLive,
            borderRadius: 2,
          }}
        />
      </div>

      <VDivider />

      <Label>SPEED</Label>
      {SPEED_PRESETS.map((s) => (
        <Button key={s} size="sm" onClick={() => c.setSpeed(s)} active={Math.abs(c.speed - s) < 0.001}>
          {s * 100}%
        </Button>
      ))}
      <input
        type="range"
        min={0.25}
        max={2}
        step={0.05}
        value={c.speed}
        onChange={(e) => c.setSpeed(Number(e.target.value))}
        style={{ width: 96, accentColor: color.accent }}
        aria-label="Playback speed"
      />
      <Label style={{ minWidth: 40, color: color.text }}>{Math.round(c.speed * 100)}%</Label>

      <Button
        size="sm"
        onClick={() => c.setRamp({ ...c.ramp, enabled: !c.ramp.enabled })}
        active={c.ramp.enabled}
        title="Speed trainer: increase speed by 5% after each loop pass, up to 100%"
      >
        RAMP
      </Button>

      <VDivider />

      <Button size="sm" onClick={c.toggleLoop} active={c.loop}>
        LOOP
      </Button>
      {c.loopRange && (
        <Button size="sm" onClick={c.clearLoopRange} title="Clear the selected loop region">
          CLEAR SEL
        </Button>
      )}
      <Button size="sm" onClick={c.toggleMetronome} active={c.metronome}>
        CLICK
      </Button>
      <Button size="sm" onClick={c.toggleCountIn} active={c.countIn}>
        COUNT-IN
      </Button>

      <VDivider />

      <Label>ZOOM</Label>
      <Button size="sm" onClick={() => c.setZoom(Math.max(0.5, Math.round((c.zoom - 0.1) * 10) / 10))}>
        −
      </Button>
      <Label style={{ minWidth: 40, color: color.text }}>{Math.round(c.zoom * 100)}%</Label>
      <Button size="sm" onClick={() => c.setZoom(Math.min(2, Math.round((c.zoom + 0.1) * 10) / 10))}>
        +
      </Button>
    </div>
  );
}
