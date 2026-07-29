/**
 * The floating transport (UI-DESIGN.md, Listen mode). Always on screen,
 * bottom center: play, position, speed readout, one dot per track. The
 * practice controls (speed trainer, loop, click, zoom) and the full mixer
 * live one press away behind the more-controls toggle, so the resting
 * state stays quiet.
 */
import { useState } from "react";
import { Button, color, font, Label, Panel, typeScale, VDivider } from "@cubscore/design";
import type { AlphaTabController } from "../useAlphaTab";
import { TrackRows } from "./TrackMixer";

const SPEED_PRESETS = [0.5, 0.75, 1];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function TransportPill({ c }: { c: AlphaTabController }) {
  const [expanded, setExpanded] = useState(false);
  const disabled = !c.ready;
  const progress = c.position.endTime > 0 ? c.position.currentTime / c.position.endTime : 0;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        maxWidth: "calc(100vw - 24px)",
      }}
    >
      {expanded && (
        <Panel
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            width: 560,
            maxWidth: "calc(100vw - 24px)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
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
            <Label style={{ color: color.text }}>{Math.round(c.zoom * 100)}%</Label>
            <Button size="sm" onClick={() => c.setZoom(Math.min(2, Math.round((c.zoom + 0.1) * 10) / 10))}>
              +
            </Button>
          </div>

          {c.tracks.length > 0 && (
            <div>
              <div style={{ marginBottom: 6 }}>
                <Label>TRACKS ({c.tracks.length})</Label>
              </div>
              <TrackRows c={c} />
            </div>
          )}
        </Panel>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: color.raisedHigh,
          border: `1px solid ${color.hairline}`,
          borderRadius: 999,
          padding: "8px 14px",
          boxShadow: "0 8px 30px rgba(0,0,0,0.55)",
        }}
      >
        <Button variant="solid" onClick={c.playPause} disabled={disabled} style={{ borderRadius: 999, minWidth: 74 }}>
          {c.playing ? "PAUSE" : "PLAY"}
        </Button>
        <Button size="sm" onClick={c.stop} disabled={disabled} style={{ borderRadius: 999 }}>
          STOP
        </Button>

        <span style={{ fontFamily: font.mono, fontSize: typeScale.sm, color: color.textDim, whiteSpace: "nowrap" }}>
          {formatTime(c.position.currentTime / 1000)} / {formatTime(c.position.endTime / 1000)}
        </span>

        <div style={{ width: 120, height: 3, background: color.border, borderRadius: 2 }}>
          <div
            style={{
              width: `${Math.min(100, progress * 100)}%`,
              height: "100%",
              background: color.accentLive,
              borderRadius: 2,
            }}
          />
        </div>

        <span style={{ fontFamily: font.mono, fontSize: typeScale.sm, color: color.textDim }}>
          {Math.round(c.speed * 100)}%
        </span>

        {c.tracks.length > 1 && (
          <span style={{ display: "flex", gap: 4 }} title="Tracks; open more controls to mix">
            {c.tracks.map((t) => (
              <span
                key={t.index}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: t.muted ? color.textFaint : color.accent,
                  display: "inline-block",
                }}
              />
            ))}
          </span>
        )}

        <Button
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          active={expanded}
          aria-label="More controls"
          aria-expanded={expanded}
          style={{ borderRadius: 999 }}
        >
          ⋯
        </Button>
      </div>
    </div>
  );
}
