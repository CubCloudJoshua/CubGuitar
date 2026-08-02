#!/usr/bin/env node
/**
 * How long a keystroke takes, on scores of the size people actually work on.
 *
 * Every other gate here checks that the app is correct. This one checks that it is
 * usable, which is a different property and the one that was quietly failing: the
 * editor answers a fret in 39ms on a four-bar demo and in two seconds on a real song,
 * and nothing in the test suite could see the difference because every fixture is
 * small.
 *
 * The number measured is keystroke to re-engraved — from the key going down to the
 * "rendering…" indicator going away — because that is the number a user feels. Boot
 * time and time into the editor come with it, since both scale the same way and both
 * would otherwise regress unnoticed.
 *
 * The budget is not currently met on real songs and that is the point of having it.
 * Measured against alphaTab's own levers — its live-editing render hint and its
 * bar-window settings — the floor is around 480ms, against a 100ms budget. See
 * STANDALONE.md §3: this number is the case for our own engraver, and this tool is how
 * that case will be judged when one exists.
 *
 * Usage: pnpm build && pnpm editperf
 * Exits non-zero if a keystroke on any score is slower than the budget below.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const PORT = Number(process.env.EDIT_PERF_PORT ?? 4188);
const BASE = `http://localhost:${PORT}`;
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
const CHROMIUM =
  process.env.CHROMIUM_PATH ?? (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

/**
 * The budget, in milliseconds, for a keystroke on any score.
 *
 * 100ms is the number a keypress has to beat to feel like typing rather than like
 * waiting; past it a user starts to watch the screen instead of the fretboard. It is a
 * ceiling and not a target — the four-bar case runs in a tenth of it.
 *
 * Deliberately a hard failure rather than a warning. A performance number nobody fails
 * on is a performance number that drifts.
 */
const BUDGET_MS = Number(process.env.EDIT_PERF_BUDGET ?? 100);

/** Keystrokes per score. Enough to have a median that is not one unlucky frame. */
const SAMPLES = 7;

async function listCorpus() {
  try {
    const entries = await readdir(path.join(ROOT, "corpus"), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && [".gp", ".gp3", ".gp4", ".gp5", ".gpx"].includes(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(ROOT, "corpus", e.name))
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
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start at ${url}`);
}

/** Waits for alphaTab to finish whatever it is drawing. */
const settled = (page, timeout = 120_000) =>
  page
    .waitForFunction(() => !document.body.innerText.includes("rendering…"), null, { timeout })
    .catch(() => undefined);

async function measure(browser, label, open) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

  const booted = Date.now();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.querySelector("button")?.disabled, null, { timeout: 30_000 });
  await page
    .waitForFunction(() => document.querySelectorAll(".at-surface svg").length > 0, null, { timeout: 30_000 })
    .catch(() => undefined);
  const boot = Date.now() - booted;

  await open(page);

  const entered = Date.now();
  const edit = page.getByRole("button", { name: "EDIT", exact: true });
  if ((await edit.count()) > 0) {
    await edit.click();
    await settled(page);
  }
  const intoEditor = Date.now() - entered;
  await page.waitForTimeout(1500);

  const bars = await page.evaluate(() => Number(document.body.innerText.match(/·\s*(\d+)\s*bars/)?.[1] ?? 0));

  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = Date.now();
    await page.keyboard.press("Digit5");
    await settled(page, 60_000);
    samples.push(Date.now() - t);
    // Moved on between samples so each keystroke is a real edit rather than a
    // rewrite of the same fret, which the model would treat as a no-op.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
  }
  samples.sort((a, b) => a - b);
  await context.close();

  return {
    label,
    bars,
    boot,
    intoEditor,
    median: samples[Math.floor(samples.length / 2)],
    worst: samples.at(-1),
    errors,
  };
}

async function main() {
  if (!existsSync(path.join(WEB, "dist", "index.html"))) {
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
    await waitForServer(BASE);
    const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
    const rows = [];

    rows.push(
      await measure(browser, "a new score", async (page) => {
        await page.getByRole("button", { name: "NEW", exact: true }).click();
        await page.waitForTimeout(1500);
      }),
    );

    // Real songs, if the local corpus has any. They are gitignored, so CI measures the
    // small case only and a developer with the corpus measures the case that matters.
    for (const file of await listCorpus()) {
      const bytes = await readFile(file);
      const name = path.basename(file);
      rows.push(
        await measure(browser, name, async (page) => {
          await page.setInputFiles('input[type="file"]', {
            name,
            mimeType: "application/octet-stream",
            buffer: bytes,
          });
          await page.waitForTimeout(6000);
        }),
      );
    }

    console.log("");
    console.log("SCORE".padEnd(30) + "BARS   BOOT    EDITOR  KEYSTROKE  WORST   VERDICT");
    console.log("-".repeat(88));
    for (const r of rows) {
      const ok = r.median <= BUDGET_MS && r.errors.length === 0;
      if (!ok) failures += 1;
      console.log(
        r.label.padEnd(30) +
          String(r.bars).padEnd(7) +
          `${r.boot}ms`.padEnd(8) +
          `${r.intoEditor}ms`.padEnd(8) +
          `${r.median}ms`.padEnd(11) +
          `${r.worst}ms`.padEnd(8) +
          (ok ? "ok" : `OVER BUDGET (${BUDGET_MS}ms)${r.errors.length ? ` — ${r.errors[0]}` : ""}`),
      );
    }

    console.log("");
    console.log(
      `${rows.length} scores: ${rows.length - failures} within ${BUDGET_MS}ms, ${failures} over`,
    );
    await browser.close();
  } finally {
    stop();
  }
  process.exit(failures === 0 ? 0 : 1);
}

await main();
