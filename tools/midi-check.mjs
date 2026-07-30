#!/usr/bin/env node
/**
 * Our MIDI export against alphaTab's, for every score in the corpus.
 *
 * The unit tests in `packages/formats/src/midi.test.ts` grade our writer against
 * our own reader. That proves the pair agrees and by construction cannot catch a
 * mistake both halves make — a wrong tick base, a swapped byte order, a note
 * length convention we invented. alphaTab writes MIDI too, so this reads *its*
 * file with *our* parser and compares note counts, pitch multisets and length.
 * One measurement, two independent gradings: our writer against theirs, and our
 * parser against their writer.
 *
 * Usage: pnpm midi
 * Exits non-zero if any score's note content disagrees.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const PORT = 4186;
const BASE = `http://localhost:${PORT}`;
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
const CHROMIUM =
  process.env.CHROMIUM_PATH ?? (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

/**
 * How much the two may differ in note count, as a fraction.
 *
 * Not zero, and the reasons are known rather than assumed. Our importer drops
 * percussion, so a score with a drum track legitimately has fewer notes on our
 * side. alphaTab also writes extra note events for some articulations — a
 * multi-note bend becomes several — which our single-pitch-bend approach does not.
 * A *proportional* allowance with a small floor is what distinguishes those from
 * the failure that matters, which is a whole part or a whole repeat going missing.
 */
const NOTE_TOLERANCE_RATIO = 0.06;
const NOTE_TOLERANCE_FLOOR = 4;
/** Length agreement, in forty-eighths of a quarter note. */
const LENGTH_TOLERANCE_QUARTERS = 4 * 48;

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
  const notes = [];
  try {
    await waitForServer(`${BASE}/corpus.html`);
    const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    await page.goto(`${BASE}/corpus.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.cubscore), null, { timeout: 30_000 });

    const fixtures = await listFiles(path.join(ROOT, "fixtures"), (n) => n.endsWith(".altex"));
    const scores = await listFiles(path.join(ROOT, "corpus"), (n) =>
      [".gp", ".gp3", ".gp4", ".gp5", ".gpx"].includes(path.extname(n).toLowerCase()),
    );

    const rows = [];
    for (const file of [...fixtures, ...scores]) {
      const rel = path.relative(ROOT, file);
      let result;
      if (file.endsWith(".altex")) {
        const tex = await readFile(file, "utf8");
        result = await page.evaluate((t) => window.cubscore.midiTex(t), tex);
      } else {
        const bytes = Array.from(new Uint8Array(await readFile(file)));
        result = await page.evaluate((b) => window.cubscore.midiBytes(b), bytes);
      }

      if (!result.ok) {
        rows.push({ rel, ok: false, note: result.error ?? "failed" });
        failures += 1;
        continue;
      }

      const { ours, theirs, missing, extra, unsupported, percussionDropped } = result;
      // A score with no pitched content on either side is a percussion-only file,
      // which our model does not carry. The importer already reports why, and
      // calling it MIDI drift would report the same known gap a second time.
      if (ours.notes === 0 && theirs.notes === 0) {
        rows.push({
          rel,
          ok: true,
          ours: 0,
          theirs: 0,
          note: `no pitched content — ${percussionDropped} percussion notes not carried by the model`,
        });
        for (const u of unsupported ?? []) notes.push(u);
        continue;
      }

      const allowed = Math.max(NOTE_TOLERANCE_FLOOR, theirs.notes * NOTE_TOLERANCE_RATIO);
      const noteDrift = Math.abs(ours.notes - theirs.notes);
      const lengthDrift = Math.abs(ours.lastTick - theirs.lastTick);
      const divisionOk = ours.ticksPerQuarter > 0 && theirs.ticksPerQuarter > 0;
      const ok = noteDrift <= allowed && lengthDrift <= LENGTH_TOLERANCE_QUARTERS && divisionOk;
      if (!ok) failures += 1;

      rows.push({
        rel,
        ok,
        ours: ours.notes,
        theirs: theirs.notes,
        noteDrift,
        lengthDrift,
        allowed: Math.round(allowed),
        percussionDropped,
        note: ok
          ? percussionDropped > 0
            ? `${percussionDropped} percussion notes not carried`
            : ""
          : `notes off by ${noteDrift} (allowed ${Math.round(allowed)}), length off by ${lengthDrift}/48q` +
            `${missing?.length ? `, missing ${missing.slice(0, 6).join(" ")}` : ""}` +
            `${extra?.length ? `, extra ${extra.slice(0, 6).join(" ")}` : ""}`,
      });
      for (const u of unsupported ?? []) notes.push(u);
    }

    console.log("");
    console.log("SCORE".padEnd(36) + "OK  OURS    THEIRS  NOTEΔ  LENΔ   ALLOWED  NOTE");
    console.log("-".repeat(112));
    for (const r of rows) {
      console.log(
        r.rel.padEnd(36) +
          (r.ok ? "yes " : "NO  ") +
          String(r.ours ?? "-").padEnd(8) +
          String(r.theirs ?? "-").padEnd(8) +
          String(r.noteDrift ?? "-").padEnd(7) +
          String(r.lengthDrift ?? "-").padEnd(7) +
          String(r.allowed ?? "-").padEnd(9) +
          r.note,
      );
    }

    const unique = [...new Set(notes)].sort();
    if (unique.length > 0) {
      console.log("");
      console.log("Reported as not carried by the MIDI export:");
      for (const u of unique) console.log(`  - ${u}`);
    }

    console.log("");
    console.log(`${rows.length} scores: ${rows.length - failures} agree, ${failures} disagreed`);
    if (pageErrors.length > 0) {
      console.log(`browser errors: ${pageErrors.join(" | ")}`);
      failures += 1;
    }
    await browser.close();
  } finally {
    stop();
  }
  process.exit(failures === 0 ? 0 : 1);
}

await main();
