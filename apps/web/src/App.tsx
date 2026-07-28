import { useEffect, useRef, useState } from "react";
import { theme } from "./theme";
import { useAlphaTab } from "./useAlphaTab";
import { Toolbar } from "./components/Toolbar";
import { TrackMixer } from "./components/TrackMixer";
import { DEMO_SCORE } from "./demo";

export function App() {
  const c = useAlphaTab();
  const { loadTex } = c;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    loadTex(DEMO_SCORE);
  }, [loadTex]);

  return (
    <div
      style={{ maxWidth: 1100, margin: "0 auto", padding: 16 }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) void c.loadFile(file);
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <h1 style={{ color: theme.accent, fontSize: 24, margin: 0, letterSpacing: 1 }}>CubScore</h1>
        {c.score && (
          <span style={{ fontSize: 13, color: theme.text }}>
            {c.score.title}
            {c.score.artist && <span style={{ color: theme.textDim }}> — {c.score.artist}</span>}
            <span style={{ color: theme.textDim }}> · {c.score.barCount} bars</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            fontFamily: theme.mono,
            fontSize: 12,
            padding: "6px 12px",
            border: `1px solid ${theme.accent}`,
            background: "transparent",
            color: theme.accent,
            cursor: "pointer",
          }}
        >
          OPEN FILE
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".gp,.gp3,.gp4,.gp5,.gpx,.xml,.musicxml,.cap"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void c.loadFile(file);
            e.target.value = "";
          }}
        />
      </header>

      <Toolbar c={c} />
      <TrackMixer c={c} />

      {c.error && (
        <div
          style={{
            background: "#2a1010",
            border: "1px solid #7a2020",
            color: "#ffb0b0",
            fontFamily: theme.mono,
            fontSize: 12,
            padding: 10,
            marginBottom: 10,
            whiteSpace: "pre-wrap",
          }}
        >
          {c.error}
        </div>
      )}

      <div
        style={{
          background: dragging ? "#1a1206" : theme.panel,
          border: `1px solid ${dragging ? theme.accent : theme.border}`,
          padding: 8,
          position: "relative",
          minHeight: 200,
        }}
      >
        {c.rendering && (
          <span
            style={{
              position: "absolute",
              top: 8,
              right: 12,
              fontFamily: theme.mono,
              fontSize: 11,
              color: theme.textDim,
            }}
          >
            rendering…
          </span>
        )}
        <div ref={c.hostRef} />
      </div>

      <p style={{ fontFamily: theme.mono, fontSize: 11, color: theme.textDim, lineHeight: 1.7 }}>
        Drop a .gp3/.gp4/.gp5/.gpx/.gp file anywhere to open it. Click a note to seek. Drag across
        the score to select a loop region, then press LOOP. RAMP raises playback speed 5% after each
        loop pass until it reaches 100%.
      </p>
    </div>
  );
}
