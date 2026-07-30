#!/usr/bin/env node
/**
 * Does our own timeline agree with what alphaTab actually plays?
 *
 * packages/core/src/timeline.ts is the seam that lets views be built on our
 * model instead of alphaTab's — the fretboard reader places every note by its
 * seconds. While the two coexist, the cursor those notes are read against comes
 * from alphaTab's clock, so a disagreement shows up as notes drifting past the
 * strike line. Unit tests can only check the timeline against itself; this checks
 * it against the synthesizer, by rendering each score to its end and comparing.
 *
 * Usage: pnpm timing
 * Exits non-zero if any score disagrees by more than the tolerance below.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const PORT = 4184;
const BASE = `http://localhost:${PORT}`;
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
const CHROMIUM =
  process.env.CHROMIUM_PATH ?? (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

/**
 * How far apart the two may be, per score.
 *
 * Not zero, and it should not be: the synthesizer's length includes each voice's
 * release tail, so alphaTab's number is a little longer than the written music by
 * an amount that depends on the last note's instrument. What would be a real
 * defect is proportional drift — a tempo or repeat read differently accumulates
 * over a track, so the tolerance is a percentage with a small floor rather than a
 * flat allowance.
 */
const TOLERANCE_RATIO = 0.04;
const TOLERANCE_FLOOR_MS = 900;

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
  throw new Error(`server did not start at ${url}`);
}

async function main() {
  if (!existsSync(path.join(WEB, "dist", "corpus.html"))) {
    console.error("apps/web/dist is missing. Run `pnpm build` first.");
    process.exit(1);
  }

  const server = spawn("npx", ["--yes", "sirv-cli", "dist", "--port", String(PORT), "--single"], {
    cwd: WEB,
    stdio: "ignore",
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-server.pid);
    } catch {
      // already gone
    }
  };
  process.on("exit", stop);

  let failures = 0;
  try {
    await waitForServer(`${BASE}/corpus.html`);
    const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
    await page.goto(`${BASE}/corpus.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.cubscore), null, { timeout: 30_000 });

    const fixtures = await listFiles(path.join(ROOT, "fixtures"), (n) => n.endsWith(".altex"));
    const scores = await listFiles(path.join(ROOT, "corpus"), (n) =>
      [".gp", ".gp3", ".gp4", ".gp5", ".gpx"].includes(path.extname(n).toLowerCase()),
    );

    const rows = [];
    for (const file of [...fixtures, ...scores]) {
      const rel = path.relative(ROOT, file);
      const isTex = file.endsWith(".altex");
      let result;
      if (isTex) {
        const tex = await readFile(file, "utf8");
        result = await page.evaluate((t) => window.cubscore.timingTex(t), tex);
      } else {
        const bytes = Array.from(new Uint8Array(await readFile(file)));
        result = await page.evaluate((b) => window.cubscore.timingBytes(b), bytes);
      }

      if (!result.ok) {
        rows.push({ rel, ok: false, note: result.error ?? "failed" });
        failures += 1;
        continue;
      }
      const { alphaTabMs, coreMs, notes, writtenBars, playedBars, tempo } = result;
      // A score our importer does not carry has no timeline to compare. The one
      // case today is a percussion-only file, which the importer drops on
      // purpose; calling that a timing drift would be reporting a known gap
      // twice and hiding real drift behind it.
      if (notes === 0 && coreMs === 0) {
        rows.push({ rel, ok: true, alphaTabMs, coreMs, notes, note: "not carried by the model, skipped" });
        continue;
      }
      const drift = alphaTabMs - coreMs;
      const allowed = Math.max(TOLERANCE_FLOOR_MS, coreMs * TOLERANCE_RATIO);
      const ok = Math.abs(drift) <= allowed;
      if (!ok) failures += 1;
      rows.push({
        rel,
        ok,
        alphaTabMs,
        coreMs,
        drift,
        allowed: Math.round(allowed),
        notes,
        note: ok
          ? ""
          : `off by ${drift}ms (allowed ${Math.round(allowed)}) — ${playedBars} played of ${writtenBars} written at ${tempo}bpm`,
      });
    }

    console.log("");
    console.log(
      "SCORE".padEnd(36) + "OK  ALPHATAB  OURS      DRIFT   ALLOWED  NOTES  NOTE",
    );
    console.log("-".repeat(110));
    for (const r of rows) {
      console.log(
        r.rel.padEnd(36) +
          (r.ok ? "yes " : "NO  ") +
          String(r.alphaTabMs ?? "-").padEnd(10) +
          String(r.coreMs ?? "-").padEnd(10) +
          String(r.drift ?? "-").padEnd(8) +
          String(r.allowed ?? "-").padEnd(9) +
          String(r.notes ?? "-").padEnd(7) +
          r.note,
      );
    }
    console.log("");
    console.log(`${rows.length} scores: ${rows.length - failures} agree, ${failures} drifted`);
    if (consoleErrors.length > 0) {
      console.log(`browser errors: ${consoleErrors.join(" | ")}`);
      failures += 1;
    }
    await browser.close();
  } finally {
    stop();
  }
  process.exit(failures === 0 ? 0 : 1);
}

await main();
