#!/usr/bin/env node
/**
 * Phase 0 exit test: load every score in the corpus and confirm it parses
 * and renders.
 *
 * Sources:
 *   fixtures/*.altex  original alphaTex scores, committed, run in CI
 *   corpus/*.gp*      real Guitar Pro files, gitignored, dropped in locally
 *
 * Usage: pnpm corpus
 * Exits non-zero if any score fails.
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const PORT = 4183;
const BASE = `http://localhost:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const GP_EXTENSIONS = new Set([".gp", ".gp3", ".gp4", ".gp5", ".gpx"]);

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
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview server did not start at ${url}`);
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

  const server = spawn("pnpm", ["preview", "--port", String(PORT), "--strictPort"], {
    cwd: WEB,
    stdio: "ignore",
  });
  let browser;

  try {
    await waitForServer(BASE);
    browser = await chromium.launch({ executablePath: CHROMIUM });
    const page = await browser.newPage();
    // alphaTab reports parser/semantic diagnostics to the console rather than
    // through the error event, and they are what actually tells you why a
    // score failed. Capture the most recent one for each load.
    let lastDiagnostics = "";
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().includes("diagnostics")) lastDiagnostics = m.text();
    });
    await page.goto(`${BASE}/corpus.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof window.cubscore !== "undefined", null, { timeout: 30_000 });

    const results = [];

    for (const file of fixtures) {
      const tex = await readFile(file, "utf8");
      lastDiagnostics = "";
      const result = await page.evaluate((t) => window.cubscore.loadTex(t), tex);
      results.push({ name: path.relative(ROOT, file), diagnostics: lastDiagnostics, ...result });
    }

    for (const file of corpus) {
      const bytes = Array.from(await readFile(file));
      lastDiagnostics = "";
      const result = await page.evaluate((b) => window.cubscore.loadBytes(b), bytes);
      results.push({ name: path.relative(ROOT, file), diagnostics: lastDiagnostics, ...result });
    }

    report(results, fixtures.length, corpus.length);
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    await browser?.close();
    server.kill();
  }
}

function report(results, fixtureCount, corpusCount) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("");
  console.log(
    `${pad("SCORE", 34)}${pad("OK", 4)}${pad("TRK", 5)}${pad("BARS", 6)}${pad("NOTES", 7)}${pad("MS", 6)}TITLE`,
  );
  console.log("-".repeat(96));
  for (const r of results) {
    console.log(
      `${pad(r.name, 34)}${pad(r.ok ? "yes" : "NO", 4)}${pad(r.tracks, 5)}${pad(r.bars, 6)}` +
        `${pad(r.notes, 7)}${pad(r.renderMs, 6)}${r.ok ? (r.title ?? "") : r.error}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  for (const f of failed) {
    if (!f.diagnostics) continue;
    console.log("");
    console.log(`--- ${f.name} ---`);
    console.log(f.diagnostics.split("\n").slice(0, 20).join("\n"));
  }
  console.log("");
  console.log(
    `${results.length} scores (${fixtureCount} fixtures, ${corpusCount} corpus): ` +
      `${results.length - failed.length} passed, ${failed.length} failed`,
  );
  if (corpusCount === 0) {
    console.log("");
    console.log("Note: corpus/ is empty. Drop real .gp files there to exercise the importers.");
    console.log("See corpus/README.md.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
