#!/usr/bin/env node
/**
 * The transcription gate: how much of a score survives being played and heard back.
 *
 * DIFFERENTIATION.md §2 is the flagship — audio to tablature on our own GPUs — and it
 * says accuracy should be measured before it is claimed. This measures it, and the
 * reason it can is that we own both ends: `timeline()` turns any score into the notes
 * a perfect detector would report, so every file in the corpus is a labelled example
 * with exact labels, at no annotation cost. Most attempts at this buy a dataset first.
 *
 * ## What is under test, and what is not
 *
 * Four stages take audio to a tab. Separation and multi-pitch estimation are model
 * downloads and GPU time; quantisation and fingering are ours. This harness feeds the
 * quantiser *exact pitches* with detector-shaped timing error, which isolates our two
 * stages from the two we would be renting. A row here is not a claim about
 * transcribing a recording; it is a claim about what our half does with what a
 * detector hands it.
 *
 * That separation is the point. When the GPU stages land, their error compounds with
 * whatever this table shows, and the two are measured apart so a regression has one
 * owner.
 *
 * ## Reading the table
 *
 * The sweep over jitter is the useful part. At 0ms the pipeline should be near
 * perfect — anything less is a bug in our own arithmetic, not a limit of the
 * approach. At 15ms it is being asked to read a tight player, at 40ms a loose one.
 * Where the columns fall off is where the work is.
 *
 * PITCH  fraction of the original's notes recovered at the right moment
 * FINGER of those, the fraction on the same string and fret as the original — the
 *        stage every other product skips, and the difference between a tab and a pile
 *        of MIDI. Reported, not gated: see FLOOR_FINGERING_VALID below
 * VALID  fraction of written fingerings that actually sound their own pitch. Gated
 * ERR    mean distance from where a recovered note should have been
 * GRID   the subdivision chosen from the material
 * MERGED distinct onsets the grid still could not separate, so they became chords
 * TRIP   onsets a triplet would have fitted better, which we do not write yet
 *
 * Usage: pnpm build && pnpm transcribe
 * Exits non-zero if any score falls below the floors below.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const PORT = Number(process.env.TRANSCRIBE_CHECK_PORT ?? 4187);
const BASE = `http://localhost:${PORT}`;
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
const CHROMIUM =
  process.env.CHROMIUM_PATH ?? (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);
const GP_EXTENSIONS = [".gp", ".gp3", ".gp4", ".gp5", ".gpx"];

/** Timing error swept per score, in milliseconds. 0 is the arithmetic check. */
const JITTERS = [0, 15, 40];

/**
 * Floors, applied only at 0ms jitter.
 *
 * Deliberately only there. With no timing error the pipeline is doing arithmetic we
 * control end to end, so a shortfall is a defect and a gate is fair. At 15 and 40ms
 * the right answer is genuinely unknown — a note exactly between two grid positions
 * has no correct home — and a gate on those numbers would be a gate on how the dice
 * fell, which is how a suite starts getting its thresholds loosened instead of its
 * bugs fixed. Those rows are measured and printed, not enforced.
 */
const FLOOR_PITCH_RECALL = 0.95;
/**
 * Every fingering we write must sound the note it claims, on this instrument's
 * tuning and capo. There is exactly one right answer, so the floor is 100%.
 *
 * Note what is *not* gated: whether our fingering matches the one the original
 * author chose. A2 is string 5 open or string 6 fret 5 and a guitarist plays either;
 * our solver picks by hand movement, the transcriber picked by preference, and
 * grading agreement would grade taste. The FINGER column reports it because it is
 * worth watching, and this floor covers the part that can actually be wrong.
 */
const FLOOR_FINGERING_VALID = 1;

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

const pct = (n) => (n === undefined ? "-" : `${Math.round(n * 100)}%`);

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
  const skipped = [];
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
      GP_EXTENSIONS.includes(path.extname(n).toLowerCase()),
    );

    const rows = [];
    for (const file of [...fixtures, ...scores]) {
      const rel = path.relative(ROOT, file);
      const isTex = file.endsWith(".altex");
      const payload = isTex ? await readFile(file, "utf8") : Array.from(new Uint8Array(await readFile(file)));

      for (const jitterMs of JITTERS) {
        const result = isTex
          ? await page.evaluate(([t, j]) => window.cubscore.transcribeTex(t, j), [payload, jitterMs])
          : await page.evaluate(([b, j]) => window.cubscore.transcribeBytes(b, j), [payload, jitterMs]);

        if (!result.ok) {
          // A file our importer does not carry has nothing to transcribe. The known
          // case is a percussion-only score, dropped on purpose; counting that as a
          // transcription failure would report a known gap twice and hide a real one
          // behind it. Named at the end rather than silently passed over.
          skipped.push(`${rel}: ${result.error}`);
          break;
        }
        rows.push({ rel, ...result });

        if (jitterMs === 0) {
          const reasons = [];
          if (result.pitchRecall < FLOOR_PITCH_RECALL) {
            reasons.push(`recall ${pct(result.pitchRecall)} < ${pct(FLOOR_PITCH_RECALL)}`);
          }
          if (result.fingeringValid < FLOOR_FINGERING_VALID) {
            reasons.push(`${pct(1 - result.fingeringValid)} of frets sound the wrong pitch`);
          }
          if (reasons.length > 0) failures += 1;
          rows.at(-1).failed = reasons.join("; ");
        }
      }
    }

    console.log("");
    console.log(
      "SCORE".padEnd(34) +
        "JIT  NOTES  PITCH  FINGER  VALID  ERR    GRID  MERGED  TRIP  NOTE",
    );
    console.log("-".repeat(124));
    for (const r of rows) {
      const flags = [];
      if (r.leadInMs > 20) flags.push(`${r.leadInMs}ms lead-in dropped`);
      if (r.tempoChanges > 1) flags.push(`${r.tempoChanges} tempos, 1 written`);
      if (r.meterChanges > 1) flags.push(`${r.meterChanges} meters, 1 written`);
      if (r.failed) flags.push(`FLOOR: ${r.failed}`);
      console.log(
        r.rel.padEnd(34) +
          String(r.jitterMs).padEnd(5) +
          String(r.truth).padEnd(7) +
          pct(r.pitchRecall).padEnd(7) +
          pct(r.fingeringAgreement).padEnd(8) +
          pct(r.fingeringValid).padEnd(7) +
          `${r.onsetErrorMs}ms`.padEnd(7) +
          `1/${r.grid}`.padEnd(6) +
          String(r.mergedByGrid).padEnd(8) +
          String(r.tripletsWanted).padEnd(6) +
          flags.join("; "),
      );
    }

    const clean = rows.filter((r) => r.jitterMs === 0);
    const mean = (list, pick) =>
      list.length === 0 ? 0 : list.reduce((sum, r) => sum + pick(r), 0) / list.length;
    console.log("");
    for (const jitterMs of JITTERS) {
      const at = rows.filter((r) => r.jitterMs === jitterMs);
      if (at.length === 0) continue;
      console.log(
        `at ${String(jitterMs).padStart(2)}ms jitter: ` +
          `${pct(mean(at, (r) => r.pitchRecall))} of notes recovered, ` +
          `${pct(mean(at, (r) => r.fingeringAgreement))} of those fingered as written`,
      );
    }
    console.log("");
    if (skipped.length > 0) {
      console.log(`not carried by the model, skipped: ${skipped.length}`);
      for (const line of skipped) console.log(`  - ${line}`);
      console.log("");
    }
    console.log(
      `${clean.length} scores graded: ${clean.length - failures} above the floor, ${failures} below ` +
        `(floor applies at 0ms only: ${pct(FLOOR_PITCH_RECALL)} recall, ` +
        `${pct(FLOOR_FINGERING_VALID)} of frets sounding their own pitch)`,
    );
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
