import { useEffect, useRef, useState } from "react";
import * as alphaTab from "@coderline/alphatab";

// Phase 0 spike: prove that alphaTab renders and plays a score in the
// browser. The sample is alphaTex so the repo carries no binary assets;
// .gp file loading is exercised by drag-and-drop below.
const SAMPLE_TEX = String.raw`
\title "CubScore Spike"
\subtitle "Phase 0"
\tempo 120
.
\track "Guitar"
\staff {score tabs} \tuning e5 b4 g4 d4 a3 e3
3.3.4 5.3.4 7.3.4 5.3.4 | 3.3.8 5.3.8 7.3.4 r.2 |
0.4.4 0.4.4 2.4.4 3.4.4 | 5.4.1{v} |
`;

const ACCENT = "#F07D00";

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [title, setTitle] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const api = new alphaTab.AlphaTabApi(host, {
      core: {
        // The vite plugin copies assets to the site root, not next to the
        // JS chunks where alphaTab looks by default.
        fontDirectory: "/font/",
      },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledAutomatic,
        soundFont: "/soundfont/sonivox.sf3",
        enableCursor: true,
        enableUserInteraction: true,
      },
      display: {
        resources: {
          mainGlyphColor: "#eeeeee",
          secondaryGlyphColor: "#888888",
          staffLineColor: "#555555",
          barSeparatorColor: "#555555",
          scoreInfoColor: "#eeeeee",
        },
      },
    } as alphaTab.json.SettingsJson);
    apiRef.current = api;

    api.scoreLoaded.on((score) => {
      setTitle(`${score.title || "Untitled"}${score.artist ? ` – ${score.artist}` : ""}`);
    });
    api.playerReady.on(() => setReady(true));
    api.playerStateChanged.on((e) => {
      setPlaying(e.state === alphaTab.synth.PlayerState.Playing);
    });

    api.tex(SAMPLE_TEX);

    return () => {
      apiRef.current = null;
      api.destroy();
    };
  }, []);

  const openFile = (file: File) => {
    file.arrayBuffer().then((buffer) => {
      apiRef.current?.load(new Uint8Array(buffer));
    });
  };

  return (
    <div
      style={{ maxWidth: 960, margin: "0 auto", padding: 16 }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) openFile(file);
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 12 }}>
        <h1 style={{ color: ACCENT, fontSize: 24, margin: 0 }}>CubScore</h1>
        <span style={{ color: "#888", fontSize: 12 }}>
          Phase 0 spike – drop a .gp3/.gp4/.gp5/.gpx/.gp file anywhere to open it
        </span>
      </header>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button
          onClick={() => apiRef.current?.playPause()}
          disabled={!ready}
          style={{
            background: ready ? ACCENT : "#333",
            color: "#080808",
            border: "none",
            padding: "8px 20px",
            fontFamily: "inherit",
            fontWeight: 700,
            cursor: ready ? "pointer" : "default",
          }}
        >
          {playing ? "PAUSE" : "PLAY"}
        </button>
        <button
          onClick={() => apiRef.current?.stop()}
          disabled={!ready}
          style={{
            background: "#222",
            color: "#eee",
            border: "1px solid #444",
            padding: "8px 20px",
            fontFamily: "inherit",
            cursor: ready ? "pointer" : "default",
          }}
        >
          STOP
        </button>
        <span style={{ color: "#888", fontSize: 12 }}>{title}</span>
      </div>

      <div style={{ background: "#111", border: "1px solid #333", padding: 8 }}>
        <div ref={hostRef} />
      </div>
    </div>
  );
}
