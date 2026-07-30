#!/usr/bin/env node
/**
 * Our MusicXML, read by alphaTab, for every score in the corpus.
 *
 * The unit tests in `packages/formats/src/musicxml.test.ts` grade our writer against
 * our own reader. That proves the pair agrees with itself and by construction cannot
 * catch a mistake both halves make — a misread of what `<chord/>` marks, a tuning
 * written in the wrong direction, an element order a real reader rejects. So this
 * hands our file to alphaTab's own MusicXML importer and compares what it finds
 * against what it found in the original score.
 *
 * Three gradings from one measurement:
 *   - our writer against alphaTab's reader (does a stranger read what we meant)
 *   - our reader against alphaTab's reader (do the two disagree, and where)
 *   - whether the fingering survived, which is the one claim about guitar MusicXML
 *     that most exporters quietly fail
 *
 * Usage: pnpm musicxml
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
const PORT = 4187;
const BASE = `http://localhost:${PORT}`;
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
const CHROMIUM =
  process.env.CHROMIUM_PATH ?? (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

/**
 * How far the note count may drift.
 *
 * Not zero, and the reason is not sloppiness. A grace note has no duration and is
 * dropped rather than given one; a drum part exports as pitched notes; alphaTab's own
 * MusicXML reader makes its own choices about ornaments that expand into notes. A
 * tolerance of a few percent catches the failures that matter — a whole part missing,
 * a voice collapsed, every chord flattened to one note — while not failing the build
 * over a mordent.
 */
const NOTE_TOLERANCE_RATIO = 0.03;
const NOTE_TOLERANCE_FLOOR = 4;

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
        result = await page.evaluate((t) => window.cubscore.musicXmlTex(t), tex);
      } else {
        const bytes = Array.from(new Uint8Array(await readFile(file)));
        result = await page.evaluate((b) => window.cubscore.musicXmlBytes(b), bytes);
      }

      if (!result.ok) {
        rows.push({ rel, ok: false, note: result.error ?? "failed" });
        failures += 1;
        continue;
      }

      const { original, theirs, ours, pitchDrift, readerDrift, unsupported, fretted } = result;
      const allowed = Math.max(NOTE_TOLERANCE_FLOOR, original.notes * NOTE_TOLERANCE_RATIO);
      // alphaTab's MusicXML reader has no concept of a dead note, so what the source
      // counted as dead comes back as an ordinary note. Its total is therefore measured
      // against the source's live notes *plus* its dead ones; measuring it against the
      // live notes alone reports every muted strum in the file as an invented note.
      const theirDrift = Math.abs(theirs.notes - (original.notes + original.dead));
      const ourDrift = Math.abs(ours.notes - original.notes);
      // Dead notes are their own comparison. Ours keeps them, because MusicXML has an
      // X notehead and we write one; alphaTab's MusicXML reader has no concept of a
      // dead note, so on its side they come back as ordinary notes and the count is
      // expected to differ. What is *not* expected is our own reader losing them.
      const deadKept = original.dead === 0 || ours.dead > 0;
      // Two readers of the same file should agree about the notes in it, and the
      // tolerance is the same one the counts get, for the same reason. Zero tolerance
      // between two independent readers of a six-thousand-note file always finds a
      // handful of edge cases — a harmonic one of them computes and the other carries,
      // an ornament one expands — and failing the build on those would train everyone
      // to ignore this check. What it is here to catch is systematic: every chord
      // flattened, every string shifted, a whole part read as pitches.
      const readerGap = Math.max(readerDrift?.missing.length ?? 0, readerDrift?.added.length ?? 0);
      const agree = readerGap <= allowed;
      // Every note that had a fingering should still have one. This is the claim
      // about guitar MusicXML, and a silent zero here is the failure being tested.
      const fingeringKept = fretted.ours === 0 || fretted.theirs > 0;
      const ok = theirDrift <= allowed && ourDrift <= allowed && agree && fingeringKept && deadKept;
      if (!ok) failures += 1;

      const detail = [];
      if (theirDrift > allowed) {
        detail.push(
          `alphaTab read ${theirs.notes} of ${original.notes + original.dead}` +
            `${pitchDrift?.missing.length ? `, missing ${pitchDrift.missing.slice(0, 6).join(" ")}` : ""}`,
        );
      }
      if (ourDrift > allowed) detail.push(`we read ${ours.notes} of ${original.notes}`);
      if (readerGap > 0) {
        detail.push(
          `readers differ on ${readerGap}` +
            `${readerDrift.missing.length ? `, we missed ${readerDrift.missing.slice(0, 6).join(" ")}` : ""}` +
            `${readerDrift.added.length ? `, we added ${readerDrift.added.slice(0, 6).join(" ")}` : ""}`,
        );
      }
      if (!fingeringKept) detail.push(`fingering lost: we wrote ${fretted.ours}, alphaTab read 0`);
      if (!deadKept) detail.push(`dead notes lost: source had ${original.dead}, we read 0`);

      rows.push({
        rel,
        ok,
        source: original.notes,
        theirs: theirs.notes,
        ours: ours.notes,
        allowed: Math.round(allowed),
        dead: `${original.dead}/${ours.dead}`,
        gap: readerGap,
        fretted: `${fretted.theirs}/${fretted.ours}`,
        note: detail.join("; "),
      });
      for (const u of unsupported ?? []) notes.push(u);
    }

    console.log("");
    console.log(
      "SCORE".padEnd(36) + "OK  SOURCE  THEIRS  OURS    ALLOWED  GAP    DEAD(S/O)  FRET(T/O)   NOTE",
    );
    console.log("-".repeat(120));
    for (const r of rows) {
      console.log(
        r.rel.padEnd(36) +
          (r.ok ? "yes " : "NO  ") +
          String(r.source ?? "-").padEnd(8) +
          String(r.theirs ?? "-").padEnd(8) +
          String(r.ours ?? "-").padEnd(8) +
          String(r.allowed ?? "-").padEnd(9) +
          String(r.gap ?? "-").padEnd(7) +
          String(r.dead ?? "-").padEnd(11) +
          String(r.fretted ?? "-").padEnd(12) +
          r.note,
      );
    }

    const unique = [...new Set(notes)].sort();
    if (unique.length > 0) {
      console.log("");
      console.log("Reported as not carried through MusicXML:");
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
