#!/usr/bin/env node
/**
 * Does CubScore actually make a sound?
 *
 * Every other gate in this project checks the notation and assumes the audio.
 * It has to: the app is built and tested in headless browsers with no audio
 * device, so nobody involved has ever heard it. That assumption is worth
 * exactly nothing — a soundfont that fails to load, a muted track, a synth
 * that never starts, all render perfect notation over perfect silence.
 *
 * alphaTab can synthesize to raw samples instead of to a speaker, so this
 * measures what came out. Silence is the failure it exists to catch, but the
 * measurements also catch the cases either side of it: a single click that is
 * technically not silence, and output so loud it is distortion rather than
 * music.
 *
 * Usage: pnpm build && pnpm audio
 * Exits non-zero if any score fails.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const PORT = Number(process.env.AUDIO_CHECK_PORT ?? 4184);
const BASE = `http://localhost:${PORT}`;
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
const CHROMIUM =
  process.env.CHROMIUM_PATH ?? (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);
const GP_EXTENSIONS = new Set([".gp", ".gp3", ".gp4", ".gp5", ".gpx"]);

/** Synthesizing a whole song is pointless; the first few seconds prove it works. */
const RENDER_MS = 6000;

/**
 * What counts as working audio.
 *
 * The floor is deliberately generous: this is a smoke test for "sound comes
 * out", not a mixing judgement. A quiet passage is legitimate; total silence
 * and pure distortion are not.
 */
const LIMITS = {
  /** Below this the loudest sample in six seconds is inaudible. */
  minPeak: 0.005,
  /** Below this there is a click or a tail, not sustained music. */
  minRms: 0.0002,
  /** Above this the output is clipping rather than playing. */
  maxClipped: 0.01,
  /** At least this share of 100ms windows must contain something audible. */
  minAudibleShare: 0.2,
};

async function listFiles(dir, filter) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && filter(e.name))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview server did not start at ${url}`);
}

/** Why a result failed, or null if it passed. */
function verdict(result) {
  if (!result.ok) return result.error ?? "render failed";
  if ((result.peak ?? 0) < LIMITS.minPeak) return `silent (peak ${(result.peak ?? 0).toFixed(5)})`;
  if ((result.rms ?? 0) < LIMITS.minRms) return `no sustained signal (rms ${(result.rms ?? 0).toFixed(6)})`;
  if ((result.clipped ?? 0) > LIMITS.maxClipped) {
    return `clipping (${((result.clipped ?? 0) * 100).toFixed(1)}% of samples at full scale)`;
  }
  const share = (result.windows ?? 0) > 0 ? (result.audibleWindows ?? 0) / result.windows : 0;
  if (share < LIMITS.minAudibleShare) {
    return `mostly silence (${(share * 100).toFixed(0)}% of windows audible)`;
  }
  return null;
}

function report(rows) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("");
  console.log(
    `${pad("SCORE", 36)}${pad("OK", 4)}${pad("MS", 7)}${pad("PEAK", 9)}${pad("RMS", 10)}${pad("AUDIBLE", 9)}NOTE`,
  );
  console.log("-".repeat(96));
  for (const row of rows) {
    const share = (row.windows ?? 0) > 0 ? (row.audibleWindows ?? 0) / row.windows : 0;
    console.log(
      `${pad(row.name, 36)}${pad(row.failure ? "NO" : "yes", 4)}${pad(row.ms, 7)}` +
        `${pad((row.peak ?? 0).toFixed(4), 9)}${pad((row.rms ?? 0).toFixed(5), 10)}` +
        `${pad(`${Math.round(share * 100)}%`, 9)}${row.failure ?? ""}`,
    );
  }
  const failed = rows.filter((r) => r.failure);
  console.log("");
  console.log(`${rows.length} scores: ${rows.length - failed.length} audible, ${failed.length} failed`);
  return failed.length === 0;
}

async function main() {
  const fixtures = await listFiles(path.join(ROOT, "fixtures"), (n) => n.endsWith(".altex"));
  const corpus = await listFiles(path.join(ROOT, "corpus"), (n) =>
    GP_EXTENSIONS.has(path.extname(n).toLowerCase()),
  );
  if (fixtures.length === 0 && corpus.length === 0) {
    console.error("No scores found in fixtures/ or corpus/.");
    process.exit(1);
  }
  if (!existsSync(path.join(WEB, "dist", "corpus.html"))) {
    console.error("apps/web/dist is missing. Run `pnpm build` first.");
    process.exit(2);
  }

  const server = spawn("pnpm", ["preview", "--port", String(PORT), "--strictPort"], {
    cwd: WEB,
    stdio: "ignore",
    detached: true,
  });
  let browser;

  try {
    await waitForServer(BASE);
    browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
    });
    await page.goto(`${BASE}/corpus.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof window.cubscore !== "undefined", null, { timeout: 30_000 });

    const rows = [];
    for (const file of fixtures) {
      const tex = await readFile(file, "utf8");
      const name = path.relative(ROOT, file);
      const result = await page.evaluate(
        ([t, ms]) => window.cubscore.renderAudioTex(t, ms),
        [tex, RENDER_MS],
      );
      rows.push({ name, ...result, failure: verdict(result) });
    }
    for (const file of corpus) {
      const bytes = Array.from(await readFile(file));
      const name = path.relative(ROOT, file);
      const result = await page.evaluate(
        ([b, ms]) => window.cubscore.renderAudioBytes(b, ms),
        [bytes, RENDER_MS],
      );
      rows.push({ name, ...result, failure: verdict(result) });
    }

    const passed = report(rows);
    if (!passed && consoleErrors.length > 0) {
      console.log("");
      console.log("Browser errors:");
      for (const e of consoleErrors.slice(0, 10)) console.log(`  ! ${e}`);
    }
    process.exitCode = passed ? 0 : 1;
  } finally {
    await browser?.close();
    try {
      if (server.pid) process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill();
    }
  }
}

await main();
