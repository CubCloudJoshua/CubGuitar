/**
 * The floating transport (UI-DESIGN.md, Listen mode). Always on screen,
 * bottom center: play, position, speed readout, one dot per track. The
 * practice controls (speed trainer, loop, click, zoom) and the full mixer
 * live one press away behind the more-controls toggle, so the resting
 * state stays quiet.
 */
import { useState } from "react";
import { Button, color, font, Label, motion, Panel, typeScale, VDivider } from "@cubscore/design";
import type { AlphaTabController } from "../useAlphaTab";
import { usePhone } from "../useNarrow";
import { TrackRows } from "./TrackMixer";

const SPEED_PRESETS = [0.5, 0.75, 1];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Play, wearing the progress (UI-DESIGN.md, signature moment: "the transport
 * pill contracts to a progress ring").
 *
 * The label stays as the accessible name rather than as text: the ring is the
 * only round thing on the surface, so it needs no caption, but "Play" and
 * "Pause" still have to be announced and still have to be findable.
 */
function PlayRing({
  playing,
  progress,
  disabled,
  compact,
  onClick,
}: {
  playing: boolean;
  progress: number;
  disabled: boolean;
  compact: boolean;
  onClick: () => void;
}) {
  const size = compact ? 40 : 46;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const swept = circumference * Math.max(0, Math.min(1, progress));

  return (
    <button
      onClick={onClick}
      onMouseUp={(ev) => ev.currentTarget.blur()}
      disabled={disabled}
      aria-label={playing ? "PAUSE" : "PLAY"}
      title={playing ? "Pause (Space)" : "Play (Space)"}
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        padding: 0,
        border: "none",
        borderRadius: 999,
        background: playing ? "transparent" : color.accent,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        display: "grid",
        placeItems: "center",
        transition: `background ${motion.base}`,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={playing ? color.hairline : "transparent"}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color.accentLive}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - swept}
          opacity={playing ? 1 : 0}
          style={{ transition: `stroke-dashoffset ${motion.fast}, opacity ${motion.base}` }}
        />
      </svg>
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          fontSize: compact ? 13 : 15,
          lineHeight: 1,
          color: playing ? color.accentLive : color.bg,
          letterSpacing: playing ? 1 : 0,
          // The glyph is nudged right when it is a triangle, which is optically
          // off-centre inside a circle if it is not.
          paddingLeft: playing ? 0 : 2,
        }}
      >
        {playing ? "❙❙" : "▶"}
      </span>
    </button>
  );
}

/**
 * Play, stop and seek, routed so a live session can hear them.
 *
 * Optional because the pill is also the shared view's transport, where there is no
 * session to tell. When a session is live these come from
 * collab/useSharedTransport, and everything the user does here moves the whole
 * room's playhead — which is why they must all go through one place rather than
 * calling the player directly from five handlers.
 */
export interface TransportOverrides {
  playPause: () => void;
  stop: () => void;
  seekTo: (seconds: number) => void;
}

export function TransportPill({ c, transport }: { c: AlphaTabController; transport?: TransportOverrides }) {
  const [expanded, setExpanded] = useState(false);
  const phone = usePhone();
  const disabled = !c.ready;
  const progress = c.position.endTime > 0 ? c.position.currentTime / c.position.endTime : 0;
  const endSeconds = c.position.endTime / 1000;

  const playPause = transport?.playPause ?? c.playPause;
  const stop = transport?.stop ?? c.stop;
  /** Absolute seeks, because that is what a follower can be told to do. */
  const seekTo = transport?.seekTo ?? c.seekTo;
  const seekBy = (delta: number) => seekTo(Math.max(0, c.position.currentTime / 1000 + delta));

  const scrubTo = (track: HTMLElement, clientX: number) => {
    const box = track.getBoundingClientRect();
    if (box.width <= 0 || endSeconds <= 0) return;
    const fraction = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    seekTo(fraction * endSeconds);
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        // Insetting both edges rather than centring with a transform keeps the
        // pill inside the viewport even when its content wants more room than
        // the screen has, which is what pushed PLAY off a 390px phone.
        left: 12,
        right: 12,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        // The wrapper spans the width, so it must not eat clicks on the score.
        pointerEvents: "none",
      }}
    >
      {expanded && (
        <Panel
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            width: 560,
            maxWidth: "100%",
            boxSizing: "border-box",
            pointerEvents: "auto",
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

      {/*
        On a phone the pill keeps only play, position, and the more-controls
        entry: stop, the speed readout, and the track dots are all reachable
        one press away, and at 390px the full set overflowed the screen.
      */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: phone ? 8 : 10,
          maxWidth: "100%",
          boxSizing: "border-box",
          background: color.raisedHigh,
          border: `1px solid ${color.hairline}`,
          borderRadius: 999,
          padding: phone ? "8px 12px" : "8px 14px",
          pointerEvents: "auto",
          boxShadow: "0 8px 30px rgba(0,0,0,0.55)",
        }}
      >
        <PlayRing
          playing={c.playing}
          progress={progress}
          disabled={disabled}
          compact={phone}
          onClick={playPause}
        />
        {!phone && (
          <Button size="sm" onClick={stop} disabled={disabled} style={{ borderRadius: 999 }}>
            STOP
          </Button>
        )}

        <span
          style={{
            fontFamily: font.mono,
            fontSize: typeScale.sm,
            color: color.textDim,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {formatTime(c.position.currentTime / 1000)} / {formatTime(c.position.endTime / 1000)}
        </span>

        {/*
          Scrubbable. It looked like a progress bar and had always been inert,
          which is worse than not having one: the only way to move through a
          song was to click a note in the score, which needs the right bar to be
          on screen first.
        */}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuetext={`${formatTime(c.position.currentTime / 1000)} of ${formatTime(c.position.endTime / 1000)}`}
          onPointerDown={(ev) => {
            if (disabled) return;
            ev.currentTarget.setPointerCapture(ev.pointerId);
            scrubTo(ev.currentTarget, ev.clientX);
          }}
          onPointerMove={(ev) => {
            // Only while dragging: buttons is 0 for a plain hover.
            if (disabled || ev.buttons === 0) return;
            scrubTo(ev.currentTarget, ev.clientX);
          }}
          onKeyDown={(ev) => {
            if (disabled) return;
            if (ev.key === "ArrowRight") seekBy(5);
            else if (ev.key === "ArrowLeft") seekBy(-5);
            else if (ev.key === "Home") seekTo(0);
            else return;
            ev.preventDefault();
            // The editor listens for arrows on the document to move its caret.
            // Without this, one press on this slider both seeked and walked the
            // caret, so the next fret typed landed in a different beat than the
            // one the user was looking at.
            ev.stopPropagation();
          }}
          style={{
            width: phone ? undefined : 120,
            flex: phone ? "1 1 40px" : undefined,
            minWidth: 32,
            // A 3px bar is a 3px target. The padding makes it thumb-sized
            // without making it look heavier.
            padding: "9px 0",
            cursor: disabled ? "default" : "pointer",
            touchAction: "none",
          }}
        >
          <div style={{ height: 3, background: color.border, borderRadius: 2 }}>
            <div
              style={{
                width: `${Math.min(100, progress * 100)}%`,
                height: "100%",
                background: color.accentLive,
                borderRadius: 2,
              }}
            />
          </div>
        </div>

        {!phone && (
          <span style={{ fontFamily: font.mono, fontSize: typeScale.sm, color: color.textDim }}>
            {Math.round(c.speed * 100)}%
          </span>
        )}

        {!phone && c.tracks.length > 1 && (
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
          style={{ borderRadius: 999, flexShrink: 0 }}
        >
          ⋯
        </Button>
      </div>
    </div>
  );
}
