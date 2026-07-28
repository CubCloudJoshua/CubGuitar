import type { CSSProperties } from "react";
import { theme } from "../theme";
import type { AlphaTabController } from "../useAlphaTab";

const SPEED_PRESETS = [0.5, 0.75, 1];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const buttonBase: CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 12,
  padding: "6px 12px",
  border: `1px solid ${theme.border}`,
  background: theme.panelAlt,
  color: theme.text,
  cursor: "pointer",
};

export function toggleStyle(active: boolean): CSSProperties {
  return active
    ? { ...buttonBase, background: theme.accent, color: theme.bg, borderColor: theme.accent, fontWeight: 700 }
    : buttonBase;
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
        background: theme.panel,
        border: `1px solid ${theme.border}`,
        marginBottom: 10,
      }}
    >
      <button
        onClick={c.playPause}
        disabled={disabled}
        style={{
          ...buttonBase,
          background: disabled ? "#333" : theme.accent,
          color: disabled ? theme.textDim : theme.bg,
          borderColor: disabled ? theme.border : theme.accent,
          fontWeight: 700,
          minWidth: 76,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        {c.playing ? "PAUSE" : "PLAY"}
      </button>
      <button onClick={c.stop} disabled={disabled} style={buttonBase}>
        STOP
      </button>

      <span style={{ fontFamily: theme.mono, fontSize: 12, color: theme.textDim, minWidth: 92 }}>
        {formatTime(c.position.currentTime / 1000)} / {formatTime(c.position.endTime / 1000)}
      </span>

      <div style={{ flex: "1 1 120px", height: 4, background: theme.border, minWidth: 80 }}>
        <div style={{ width: `${Math.min(100, progress * 100)}%`, height: "100%", background: theme.accentBright }} />
      </div>

      <Divider />

      {/* Speed trainer */}
      <label style={labelStyle}>SPEED</label>
      {SPEED_PRESETS.map((s) => (
        <button key={s} onClick={() => c.setSpeed(s)} style={toggleStyle(Math.abs(c.speed - s) < 0.001)}>
          {s * 100}%
        </button>
      ))}
      <input
        type="range"
        min={0.25}
        max={2}
        step={0.05}
        value={c.speed}
        onChange={(e) => c.setSpeed(Number(e.target.value))}
        style={{ width: 96, accentColor: theme.accent }}
        aria-label="Playback speed"
      />
      <span style={{ ...labelStyle, minWidth: 40, color: theme.text }}>{Math.round(c.speed * 100)}%</span>

      <button
        onClick={() => c.setRamp({ ...c.ramp, enabled: !c.ramp.enabled })}
        style={toggleStyle(c.ramp.enabled)}
        title="Speed trainer: increase speed by 5% after each loop pass, up to 100%"
      >
        RAMP
      </button>

      <Divider />

      <button onClick={c.toggleLoop} style={toggleStyle(c.loop)}>
        LOOP
      </button>
      {c.loopRange && (
        <button onClick={c.clearLoopRange} style={buttonBase} title="Clear the selected loop region">
          CLEAR SEL
        </button>
      )}
      <button onClick={c.toggleMetronome} style={toggleStyle(c.metronome)}>
        CLICK
      </button>
      <button onClick={c.toggleCountIn} style={toggleStyle(c.countIn)}>
        COUNT-IN
      </button>

      <Divider />

      <label style={labelStyle}>ZOOM</label>
      <button onClick={() => c.setZoom(Math.max(0.5, Math.round((c.zoom - 0.1) * 10) / 10))} style={buttonBase}>
        −
      </button>
      <span style={{ ...labelStyle, minWidth: 40, color: theme.text }}>{Math.round(c.zoom * 100)}%</span>
      <button onClick={() => c.setZoom(Math.min(2, Math.round((c.zoom + 0.1) * 10) / 10))} style={buttonBase}>
        +
      </button>
    </div>
  );
}

const labelStyle: CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 11,
  color: theme.textDim,
  letterSpacing: 0.5,
};

function Divider() {
  return <span style={{ width: 1, height: 20, background: theme.border }} />;
}
