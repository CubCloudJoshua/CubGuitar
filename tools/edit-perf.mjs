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
 * That makes the tool only as honest as the indicator, and for a while it was not: alphaTab
 * parses a whole score synchronously before it announces a render, so the indicator went
 * dark through the most expensive part and this tool called the keystroke finished there.
 * It reported 173ms on a score that takes three seconds. The app now says it is engraving
 * from the moment it accepts a keystroke (apps/web/src/useAlphaTab.ts, loadTex), which is
 * true for the user and true for the measurement.
 *
 * The budget is not currently met on real songs and that is the point of having it.
 * Measured against alphaTab's own levers — its live-editing render hint and its
 * bar-window settings — one engrave costs a second and a half on a 274-bar score against a
 * 100ms budget. See STANDALONE.md §3: this number is the case for our own engraver, and
 * this tool is how that case will be judged when one exists.
 *
 * Usage: pnpm build && pnpm editperf
 * Exits non-zero on any row `judge` below rejects.
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

/** Frets in the burst. See the BURST6 comment in `measure`. */
const BURST_KEYSTROKES = 6;

/**
 * The most engraves a burst may cost on a score where engraving is already slow.
 *
 * Half the keystrokes, and the threshold is set from measurement on both real scores in
 * the corpus rather than picked. With coalescing the 274-bar score spends two or three and
 * the 166-bar score one; without it, five and six. Anything in between would be a rule
 * with no margin on one side and no teeth on the other.
 *
 * "Strictly fewer than the keystrokes" was the first attempt and it does not work: on the
 * largest score the parse blocks the main thread long enough that two keystrokes land in
 * the same pass by accident, so the un-coalesced build scored five of six and passed.
 */
const BURST_ENGRAVE_LIMIT = Math.floor(BURST_KEYSTROKES / 2);

/**
 * What makes a row fail.
 *
 * Two properties, because the editor has two ways of being unusable and only one of them
 * is a latency number. A keystroke over budget is the first, and on real songs it is
 * currently expected — see the header. The second is the pile-up: typing that buys one
 * whole engrave per keystroke gets further behind with every letter, so on a score where
 * engraving is already slow a burst has to coalesce. Under budget it must not: holding a
 * keystroke back on a score that answers in thirty milliseconds spends something a user
 * notices to save something they do not.
 *
 * A missing count fails too. It means the `data-engraves` hook moved, and a check that
 * silently stops checking is worse than no check.
 */
function judge(row) {
  if (row.errors.length > 0) return `PAGE ERROR — ${row.errors[0]}`;
  if (row.engraves === null) return "NO ENGRAVE COUNT (data-engraves hook missing)";
  if (row.engraves > BURST_KEYSTROKES) return `${row.engraves} engraves for ${BURST_KEYSTROKES} keystrokes`;
  const slow = row.median > BUDGET_MS;
  if (slow && row.engraves > BURST_ENGRAVE_LIMIT) {
    return `NOT COALESCING (${row.engraves} engraves, limit ${BURST_ENGRAVE_LIMIT})`;
  }
  if (!slow && row.engraves < BURST_KEYSTROKES) return `COALESCING UNDER BUDGET (${row.engraves} engraves)`;
  if (slow) return `OVER BUDGET (${BUDGET_MS}ms)`;
  return null;
}

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

  /**
   * EDITOR conflates two things on a large score, and should be read with that in mind.
   *
   * The click happens a fixed six seconds after the file is handed over, which is not
   * always long enough: a 274-bar multitrack score is still rendering, so this waits out
   * the tail of the *load* as well as the switch into edit mode. Since the indicator
   * became honest the column has swung between 48ms and 22 seconds on the same file for
   * that reason. Neither number is wrong; they are measuring different amounts of leftover
   * load. Fixing it means waiting for the load to settle before starting the clock, which
   * is worth doing when load time is the thing under investigation.
   */
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

  /**
   * A burst: six frets typed as fast as a person types, then the wait for the score to
   * catch up. This is what editing actually feels like, and it is a different thing from
   * the number above.
   *
   * The per-keystroke measurement waits for each render before pressing again, so it can
   * only ever see the cost of one engrave. Nobody types that way. If every keystroke buys
   * its own full re-engrave, a burst of six costs six of them and the editor falls further
   * behind the longer you type, which is the complaint.
   *
   * What is reported is the count of engraves, not the milliseconds. The wall clock here
   * is worthless: the same six keystrokes on the same score measured 4.4s and 5.3s on
   * consecutive runs, a spread wider than the effect being measured. The count is exact,
   * and it is the property the coalescing queue in useAlphaTab actually claims.
   */
  const engravesBefore = await page.evaluate(
    () => Number(document.querySelector("[data-engraves]")?.getAttribute("data-engraves") ?? -1),
  );
  await page.waitForTimeout(600);
  const burstStarted = Date.now();
  for (const digit of ["Digit7", "Digit5", "Digit3", "Digit2", "Digit7", "Digit9"]) {
    await page.keyboard.press(digit);
    // 40ms apart: brisk typing, and far inside one engrave on a large score.
    await page.waitForTimeout(40);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(40);
  }
  await settled(page, 120_000);
  const burst = Date.now() - burstStarted;
  const engravesAfter = await page.evaluate(
    () => Number(document.querySelector("[data-engraves]")?.getAttribute("data-engraves") ?? -1),
  );

  await context.close();

  return {
    label,
    bars,
    boot,
    intoEditor,
    median: samples[Math.floor(samples.length / 2)],
    worst: samples.at(-1),
    burst,
    engraves: engravesBefore < 0 || engravesAfter < 0 ? null : engravesAfter - engravesBefore,
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
    console.log("SCORE".padEnd(30) + "BARS   BOOT    EDITOR  KEYSTROKE  WORST   BURST6   ENGRAVES  VERDICT");
    console.log("-".repeat(98));
    for (const r of rows) {
      const verdict = judge(r);
      if (verdict) failures += 1;
      console.log(
        r.label.padEnd(30) +
          String(r.bars).padEnd(7) +
          `${r.boot}ms`.padEnd(8) +
          `${r.intoEditor}ms`.padEnd(8) +
          `${r.median}ms`.padEnd(11) +
          `${r.worst}ms`.padEnd(8) +
          `${r.burst}ms`.padEnd(9) +
          `${r.engraves ?? "?"}/${BURST_KEYSTROKES}`.padEnd(10) +
          (verdict ?? "ok"),
      );
    }

    console.log("");
    console.log(
      `${rows.length} scores: ${rows.length - failures} passing, ${failures} failing`,
    );
    await browser.close();
  } finally {
    stop();
  }
  process.exit(failures === 0 ? 0 : 1);
}

await main();
