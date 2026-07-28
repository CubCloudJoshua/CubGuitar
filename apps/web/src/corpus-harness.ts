/**
 * Headless corpus harness.
 *
 * Loaded by corpus.html and driven by tools/corpus-check.mjs. Exposes a
 * global that loads a score (alphaTex or Guitar Pro bytes), waits for a
 * full render pass, and reports what came back. Rendering is included on
 * purpose: layout is where importer bugs actually surface.
 */
import * as alphaTab from "@coderline/alphatab";

export interface LoadResult {
  ok: boolean;
  error?: string;
  title?: string;
  artist?: string;
  tracks?: number;
  bars?: number;
  notes?: number;
  tempo?: number;
  renderMs?: number;
}

declare global {
  interface Window {
    cubscore: {
      loadTex(tex: string): Promise<LoadResult>;
      loadBytes(bytes: number[]): Promise<LoadResult>;
    };
  }
}

const host = document.getElementById("host");
if (!host) throw new Error("corpus harness: #host missing");

const api = new alphaTab.AlphaTabApi(host, {
  core: { fontDirectory: "/font/" },
  // The player is irrelevant to import fidelity and costs seconds per file.
  player: { playerMode: alphaTab.PlayerMode.Disabled },
} as alphaTab.json.SettingsJson);

function countNotes(score: alphaTab.model.Score): number {
  let n = 0;
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            n += beat.notes.length;
          }
        }
      }
    }
  }
  return n;
}

/** Resolves on the first render pass or error after `trigger` runs. */
function run(trigger: () => void): Promise<LoadResult> {
  return new Promise<LoadResult>((resolve) => {
    const started = performance.now();
    let score: alphaTab.model.Score | null = null;
    let settled = false;

    const finish = (result: LoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      api.scoreLoaded.off(onScore);
      api.postRenderFinished.off(onRendered);
      api.error.off(onError);
      resolve(result);
    };

    const onScore = (s: alphaTab.model.Score) => {
      score = s;
    };

    const onRendered = () => {
      if (!score) {
        finish({ ok: false, error: "rendered without a score" });
        return;
      }
      finish({
        ok: true,
        title: score.title,
        artist: score.artist,
        tracks: score.tracks.length,
        bars: score.masterBars.length,
        notes: countNotes(score),
        tempo: score.tempo,
        renderMs: Math.round(performance.now() - started),
      });
    };

    const onError = (e: Error) => finish({ ok: false, error: e.message || String(e) });

    const timer = setTimeout(() => finish({ ok: false, error: "timeout after 30s" }), 30_000);

    api.scoreLoaded.on(onScore);
    api.postRenderFinished.on(onRendered);
    api.error.on(onError);

    try {
      trigger();
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

window.cubscore = {
  loadTex: (tex) => run(() => api.tex(tex)),
  // Bytes cross the CDP boundary as a plain array.
  loadBytes: (bytes) => run(() => api.load(new Uint8Array(bytes))),
};
