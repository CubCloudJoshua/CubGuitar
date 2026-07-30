/**
 * Listening: the microphone path, in a real browser.
 *
 * The numerical work is unit-tested against synthesized buffers in
 * packages/core/src/pitch.test.ts and listen.test.ts, where a waveform has a known
 * frequency and the answer has a right value. What those tests cannot reach is
 * everything between a microphone and the report: a permission prompt, an
 * AudioContext, an AnalyserNode's window, frames stamped in score time rather than
 * wall-clock time, and a React overlay positioned from alphaTab's engraved bars.
 * Every one of those is a place where a correct algorithm produces nothing at all.
 *
 * So this suite feeds Chromium a WAV file as its microphone and checks that a note in
 * that file arrives as a note in the score's report.
 *
 * What it deliberately does *not* assert is an accuracy figure, and the reason is worth
 * writing down because it looks like the obvious thing to check. With no audio device,
 * alphaTab's playhead does not run in real time: it races through the written music the
 * moment playback starts, jumping to roughly the end of the last note within 400ms.
 * Measured across three fixtures — 4 notes jumped 1.6s, 8 notes jumped 3.6s, 16 notes
 * jumped 7s — so the jump is the length of the music, not a fixed warm-up. There is
 * therefore no real-time clock here to grade against, and an accuracy assertion would
 * be measuring the headless synth rather than the feature.
 *
 * That maths is covered where it can be covered honestly: packages/core/src/listen.test.ts
 * grades synthesized audio against the timeline it was synthesized from, end to end,
 * with a clock the test controls. What this suite proves is the part those tests cannot
 * reach — that a real microphone reaches that maths, that the timestamps land in score
 * time closely enough for a written note to match a played one, and that the result
 * arrives on screen and can be cleared and turned off.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appReady, launchBrowser, newDevice } from "../harness.mjs";

export const name = "listening";

const RATE = 44100;
/** E4, which is fret 0 of the first string and so the easiest note to enter. */
const HZ = 329.63;
/** Eighth notes at 120bpm. See the file comment for why not quarters. */
const PERIOD = 0.25;
/** Longer than the score, so nothing depends on how the fake device loops. */
const SECONDS = 12;

/**
 * A WAV of a string being plucked over and over.
 *
 * Harmonics and a decay, both load-bearing: the second harmonic is what a real
 * plucked string has too much of, and the decay is what makes each pluck a new onset
 * rather than one long note. A sine held forever would be detected once.
 */
function pluckedWav() {
  const total = Math.round(SECONDS * RATE);
  const samples = new Int16Array(total);
  const partials = [1, 0.6, 0.35, 0.2];
  const scale = partials.reduce((a, b) => a + b, 0);
  for (let i = 0; i < total; i += 1) {
    const intoNote = (i % Math.round(PERIOD * RATE)) / RATE;
    const envelope = Math.exp(-9 * intoNote);
    let value = 0;
    for (const [h, amplitude] of partials.entries()) {
      value += amplitude * Math.sin((2 * Math.PI * HZ * (h + 1) * i) / RATE);
    }
    samples[i] = Math.round(22000 * envelope * (value / scale));
  }

  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer)]);
}

/** Every heat band the overlay has drawn, keyed by bar. */
const readHeat = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-listen-bar]")).map((el) => ({
      bar: Number(el.getAttribute("data-listen-bar")),
      heat: el.getAttribute("data-listen-heat"),
      accuracy: Number(el.getAttribute("data-listen-accuracy")),
    })),
  );

export async function run({ baseUrl, recorder }) {
  const dir = await mkdtemp(path.join(tmpdir(), "cubscore-mic-"));
  const wav = path.join(dir, "plucks.wav");
  await writeFile(wav, pluckedWav());

  // Its own browser: a fake capture device is a launch flag, not a context option.
  const browser = await launchBrowser([
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    // Otherwise the prompt is auto-denied in headless and every check below would
    // be measuring a refusal.
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ]);

  try {
    const { page } = await newDevice(browser, recorder, "listening", { width: 1400, height: 1000 }, [
      "microphone",
    ]);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await appReady(page);
    await page.getByRole("button", { name: "NEW", exact: true }).click();
    await page.waitForTimeout(1400);

    recorder.check(
      "listening is off until asked for",
      (await page.locator("[data-listen-readout]").count()) === 0,
    );

    // Sixteen open first-string notes, filling all four bars: fret 0 is E4, which is
    // the pitch in the WAV. Entered rather than imported so the score under test and
    // the audio under test agree by construction.
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press("Digit0");
      await page.waitForTimeout(120);
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(1200);

    await page.getByRole("button", { name: "LISTEN", exact: true }).click();
    await page.waitForTimeout(600);

    recorder.check(
      "the readout appears when listening starts",
      (await page.locator("[data-listen-readout]").count()) === 1,
    );
    recorder.check(
      "and the button says it is on, in a way a screen reader can hear",
      (await page.getByRole("button", { name: "LISTEN", exact: true }).getAttribute("aria-pressed")) === "true",
    );
    recorder.check(
      "and no permission error was raised",
      (await page.getByText("Microphone access was declined").count()) === 0,
    );
    recorder.check(
      "the headphones caveat is stated up front, not buried",
      (await page.getByText("a microphone hears the app too").count()) === 1,
    );
    recorder.check(
      "and it says which staff it is grading",
      (await page.locator("[data-listen-track]").getAttribute("data-listen-track")) === "Guitar",
    );

    // Nothing is graded while the playhead is not moving: score time is the axis the
    // comparison happens on, and a paused playhead has no time in it.
    recorder.check(
      "nothing is graded before playback starts",
      (await readHeat(page)).length === 0,
    );

    await page.getByRole("button", { name: "PLAY", exact: true }).click();
    await page.waitForTimeout(6000);

    const pitch = await page.evaluate(
      () => document.querySelector("[data-listen-pitch]")?.getAttribute("data-listen-pitch") ?? null,
    );
    // The end-to-end proof: a waveform in a file, through getUserMedia, an
    // AnalyserNode and our own detector, arriving as the note a musician would name.
    recorder.check("the live readout names the note in the file", pitch === "E4", `pitch ${pitch}`);

    const heat = await readHeat(page);
    recorder.check(
      "every bar with notes in it was graded",
      [0, 1, 2, 3].every((bar) => heat.some((b) => b.bar === bar)),
      JSON.stringify(heat),
    );
    // The one thing about the grading this environment can honestly assert: a note in
    // the WAV was matched to a note in the score, which means the frames were stamped
    // in score time and not in wall-clock time. A pipeline that fed the detector
    // correctly but timestamped it wrongly would report every bar at zero.
    recorder.check(
      "and something played was matched to something written",
      heat.some((b) => b.accuracy > 0),
      JSON.stringify(heat),
    );
    recorder.check(
      "each band is coloured by how its bar went",
      heat.every((b) => ["clean", "weak", "wrong"].includes(b.heat)),
      JSON.stringify(heat.map((b) => b.heat)),
    );

    await page.getByRole("button", { name: "STOP", exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "RESET TAKE", exact: true }).click();
    await page.waitForTimeout(400);
    recorder.check(
      "resetting the take clears the grading",
      (await readHeat(page)).length === 0,
    );

    await page.getByRole("button", { name: "LISTEN", exact: true }).click();
    await page.waitForTimeout(500);
    recorder.check(
      "turning listening off puts the readout away",
      (await page.locator("[data-listen-readout]").count()) === 0,
    );
    recorder.check(
      "and takes the heat off the score with it",
      (await readHeat(page)).length === 0,
    );

    // The take that just happened has to have been *kept*. This is the difference
    // between a novelty and a practice tool: the record survives the page.
    const strip = await page.locator("[data-practice-strip]").count();
    recorder.check("the take was recorded and the history appeared", strip === 1);
    const takes = await page.evaluate(
      () => document.querySelector("[data-practice-takes]")?.getAttribute("data-practice-takes") ?? null,
    );
    recorder.check("it counts one take", takes === "1", `takes ${takes}`);
    recorder.check(
      "and names a bar to work on",
      (await page.locator("[data-practice-drill]").count()) === 1,
      (await page.locator("body").innerText()).match(/Work on bars?[^\n]*/)?.[0] ?? "nothing named",
    );

    // Leaving the editor has to release the device. A microphone that outlives the
    // surface accounting for it leaves the browser's recording indicator lit with
    // nothing on screen explaining why, which is alarming and ought to be.
    await page.getByRole("button", { name: "LISTEN", exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "PLAYER", exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await page.waitForTimeout(1600);
    recorder.check(
      "leaving the editor stops listening rather than leaving the microphone open",
      (await page.getByRole("button", { name: "LISTEN", exact: true }).getAttribute("aria-pressed")) === "false",
    );
    recorder.check(
      "and the readout does not come back on its own",
      (await page.locator("[data-listen-readout]").count()) === 0,
    );

    // Reloaded, which is the test that matters for storage: a history held in memory
    // looks identical to a stored one until the page goes away.
    await page.reload({ waitUntil: "domcontentloaded" });
    await appReady(page);
    await page.waitForTimeout(2500);
    // A reload reopens the score in the player, and the history lives beside the
    // microphone in the editor, so this is the way back to it.
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await page.waitForTimeout(2500);
    recorder.check(
      "the practice history survived a reload",
      (await page.locator("[data-practice-strip]").count()) === 1,
      (await page.locator("body").innerText()).slice(0, 120).replace(/\n/g, " | "),
    );

    await page.getByRole("button", { name: "FORGET", exact: true }).click();
    await page.waitForTimeout(800);
    recorder.check(
      "and forgetting it takes the history away",
      (await page.locator("[data-practice-strip]").count()) === 0,
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}
