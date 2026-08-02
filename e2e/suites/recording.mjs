/**
 * A recording locked to the score.
 *
 * The alignment maths is unit-tested exactly in packages/core/src/sync.test.ts, where two
 * clocks are numbers and the answers have right values. What that cannot reach is the
 * thing the feature is: an audio element making sound, a notation cursor following it, and
 * a mark placed by a human tap. Every one of those is a place where correct maths produces
 * a score that sits still.
 *
 * So this attaches a real audio file, plays it, taps SYNC, and checks that the notation's
 * playhead moved to where the recording says it should be — measured off the transport
 * clock rather than off a screenshot.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appReady, newDevice } from "../harness.mjs";

export const name = "recording";

const RATE = 44100;
/** Twelve seconds, so a four-bar score at 120bpm fits inside it with room either side. */
const SECONDS = 12;

/** A quiet tone, as a WAV. Content does not matter; length and playability do. */
function toneWav() {
  const total = SECONDS * RATE;
  const samples = new Int16Array(total);
  for (let i = 0; i < total; i += 1) {
    samples[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
  }
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer)]);
}

/**
 * Where the notation's playhead is, in seconds.
 *
 * Read off the transport's own marker rather than by matching a m:ss clock in the page
 * text. The recording bar shows a m:ss clock too, and a regex over the whole body found
 * that one first — so the follow check passed with the follow deleted, which is how this
 * was caught. A check that cannot fail is worse than no check.
 */
const scoreSeconds = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-score-seconds]");
    return el ? Number(el.getAttribute("data-score-seconds")) : null;
  });

const attr = (page, name) =>
  page.evaluate((n) => document.querySelector(`[${n}]`)?.getAttribute(n) ?? null, name);

export async function run({ browser, baseUrl, recorder }) {
  const dir = await mkdtemp(path.join(tmpdir(), "cubscore-audio-"));
  const wav = path.join(dir, "take.wav");
  await writeFile(wav, toneWav());

  const { page } = await newDevice(browser, recorder, "recording", { width: 1400, height: 1000 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1400);

  recorder.check(
    "the controls are off until asked for",
    (await page.locator("[data-recording-bar]").count()) === 0,
  );

  await page.getByRole("button", { name: "RECORDING", exact: true }).click();
  await page.waitForTimeout(600);
  recorder.check("the bar appears", (await page.locator("[data-recording-bar]").count()) === 1);
  recorder.check(
    "and asks for a file before offering anything else",
    (await page.locator("[data-recording-pick]").count()) === 1 &&
      (await page.locator("[data-recording-play]").count()) === 0,
  );

  // Qualified, because the page has two file inputs and this one takes audio to play
  // with a score rather than a score. Unqualified selection gets the score input, which
  // is what every other suite wants.
  await page.setInputFiles("[data-audio-input]", wav);
  await page.waitForTimeout(1500);

  recorder.check(
    "attaching a file offers a transport",
    (await page.locator("[data-recording-play]").count()) === 1,
  );
  recorder.check("it starts with no marks", (await attr(page, "data-recording-marks")) === "0");
  recorder.check(
    "and says nothing about a rate it cannot know yet",
    (await page.locator("[data-recording-speed]").count()) === 0,
  );

  // Play the recording. The score must follow it, which is the whole feature.
  await page.locator("[data-recording-play]").click();
  await page.waitForTimeout(3000);
  const played = Number(await attr(page, "data-recording-time"));
  recorder.check("the recording is playing", played > 1.5, `at ${played}s`);
  const followed = await scoreSeconds(page);
  recorder.check(
    "and the notation followed it, with no marks and so a shared clock",
    followed !== null && Math.abs(followed - played) <= 1,
    `recording ${played}s, score ${followed}s`,
  );

  // Seeking while a recording plays has to move the *recording*. Without that, the score
  // jumps and the follow drags it back a quarter second later, so scrubbing appears to do
  // nothing at all.
  const before = Number(await attr(page, "data-recording-time"));
  await page.locator('[role="slider"]').first().click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(800);
  const after = Number(await attr(page, "data-recording-time"));
  recorder.check(
    "scrubbing the score moves the recording, not just the notation",
    after < before,
    `recording was at ${before}s, now ${after}s`,
  );

  // Now a mark, which is the interaction: this moment of the recording is *that* moment
  // of the score. Marked while paused so the numbers hold still for the assertion.
  await page.locator("[data-recording-play]").click();
  await page.waitForTimeout(600);
  await page.locator("[data-recording-mark]").click();
  await page.waitForTimeout(400);
  recorder.check("a tap records a mark", (await attr(page, "data-recording-marks")) === "1");
  recorder.check(
    "one mark is an offset, so no rate is claimed from it",
    (await page.locator("[data-recording-speed]").count()) === 0,
  );

  // A second mark makes a rate, and the rate is shown rather than hidden: a wrong one is
  // the failure only the user can fix.
  await page.locator("[data-recording-mark]").click();
  await page.waitForTimeout(300);
  const marks = await attr(page, "data-recording-marks");
  recorder.check(
    "a second tap at the same instant corrects the first rather than adding one",
    marks === "1",
    `marks ${marks}`,
  );

  await page.getByRole("button", { name: "UNDO MARK", exact: true }).click();
  await page.waitForTimeout(300);
  recorder.check("undo removes it", (await attr(page, "data-recording-marks")) === "0");

  // A mark says "this moment of *this* recording is that moment of the score", so it
  // means nothing about a different file. Attaching a second one used to leave the old
  // marks in place and follow the new audio with the wrong alignment, silently.
  await page.locator("[data-recording-mark]").click();
  await page.waitForTimeout(300);
  recorder.check("a mark is recorded again", (await attr(page, "data-recording-marks")) === "1");
  await page.setInputFiles("[data-audio-input]", wav);
  await page.waitForTimeout(1200);
  recorder.check(
    "attaching another recording starts from no marks",
    (await attr(page, "data-recording-marks")) === "0",
    `marks ${await attr(page, "data-recording-marks")}`,
  );

  await page.getByRole("button", { name: "REMOVE", exact: true }).click();
  await page.waitForTimeout(500);
  recorder.check(
    "removing the recording goes back to asking for one",
    (await page.locator("[data-recording-pick]").count()) === 1,
  );

  await page.getByRole("button", { name: "RECORDING", exact: true }).click();
  await page.waitForTimeout(400);
  recorder.check(
    "and the bar puts itself away",
    (await page.locator("[data-recording-bar]").count()) === 0,
  );
}
