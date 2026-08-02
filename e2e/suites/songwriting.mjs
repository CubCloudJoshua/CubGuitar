/**
 * Songwriting: chord and lyric entry on the music, sections, and the compose bridge.
 *
 * The layer under test is the one the corpus comparison cannot see. Every note can
 * round-trip perfectly while the chart above the staff silently vanishes; these
 * checks read the engraved SVG text, so a chord that commits to the model but never
 * reaches the engraver fails here and nowhere else.
 */
import { appReady, newDevice, openPalette, scoreText } from "../harness.mjs";

export const name = "songwriting";

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "songwriting");
  const settle = (ms = 1000) => page.waitForTimeout(ms);
  const entry = (mode) => page.locator(`[data-songwriting-entry="${mode}"] input`);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);

  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await settle(1400);

  // Notes on the first four beats, so the chords sit over real music.
  for (const digit of ["Digit0", "Digit2", "Digit3", "Digit0"]) {
    await page.keyboard.press(digit);
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowLeft");
  await settle();

  // C opens chord entry at the caret; with no previous chord the openers are offered.
  await page.keyboard.press("c");
  await settle(500);
  recorder.check("C opens the chord input", (await entry("chord").count()) === 1);
  recorder.check(
    "the chord input takes focus immediately",
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Chord symbol"),
  );
  const openers = await page.locator("[data-songwriting-chip]").allInnerTexts();
  recorder.check("opener suggestions are offered before any chord exists", openers.length === 4, openers.join(", "));
  recorder.check("openers carry roman numerals", openers.some((t) => t.includes("I")), openers.join(", "));

  await page.keyboard.type("Am7", { delay: 40 });
  await page.keyboard.press("Enter");
  await settle(1400);
  recorder.check("committed chord renders in the engraving", (await scoreText(page)).includes("Am7"));
  recorder.check("Enter closes the input", (await entry("chord").count()) === 0);

  // On the next beat the suggestions follow from Am7; a click commits one.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("c");
  await settle(500);
  const chip = page.locator("[data-songwriting-chip]").first();
  const chipName = await chip.getAttribute("data-songwriting-chip");
  await chip.click();
  await settle(1400);
  recorder.check(
    `clicked suggestion (${chipName}) renders in the engraving`,
    (await scoreText(page)).includes(chipName),
    (await scoreText(page)).slice(0, 160),
  );

  // Tab is the one-pass chart workflow: commit, step to the next beat, stay open.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("c");
  await settle(400);
  await page.keyboard.type("Dm7", { delay: 40 });
  await page.keyboard.press("Tab");
  await settle(800);
  recorder.check("Tab keeps the input open", (await entry("chord").count()) === 1);
  recorder.check(
    "Tab advances the caret to the next beat",
    (await page.locator("text=/beat 4/").count()) >= 1,
  );
  await page.keyboard.type("G7", { delay: 40 });
  await page.keyboard.press("Enter");
  await settle(1400);
  const chart = await scoreText(page);
  recorder.check("both chords of the Tab pass render", chart.includes("Dm7") && chart.includes("G7"), chart.slice(0, 200));

  // The chord in force at the caret, written into the beat as playable notes.
  const beforeVoicing = await scoreText(page);
  await openPalette(page);
  await page.keyboard.type("voicing", { delay: 30 });
  await settle(400);
  await page.keyboard.press("Enter");
  await settle(1400);
  recorder.check("insert voicing writes notes into the beat", (await scoreText(page)) !== beforeVoicing);

  // A symbol the parser refuses is warned about once, then kept on purpose.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("c");
  await settle(400);
  await page.keyboard.type("Qzz", { delay: 40 });
  await page.keyboard.press("Enter");
  await settle(400);
  recorder.check("unknown chord warns instead of committing", (await page.locator("text=/Unknown chord/").count()) === 1);
  recorder.check("the input stays open through the warning", (await entry("chord").count()) === 1);
  await page.keyboard.press("Enter");
  await settle(1400);
  recorder.check("a second Enter keeps the writer's symbol", (await scoreText(page)).includes("Qzz"));

  // L opens lyric entry; the syllable lands under the staff.
  await page.keyboard.press("l");
  await settle(400);
  recorder.check("L opens the lyric input", (await entry("lyric").count()) === 1);
  await page.keyboard.type("moonlight", { delay: 30 });
  await page.keyboard.press("Enter");
  await settle(1400);
  recorder.check("the syllable renders in the engraving", (await scoreText(page)).includes("moonlight"));

  // Escape dismisses without touching the beat.
  await page.keyboard.press("c");
  await settle(300);
  await page.keyboard.press("Escape");
  await settle(400);
  recorder.check("Escape closes the input", (await entry("chord").count()) === 0);

  // Song structure: the section chip names the bar the caret is on.
  await page.locator("[data-section-chip]").click();
  await settle(300);
  await page.keyboard.type("Chorus", { delay: 30 });
  await page.keyboard.press("Enter");
  await settle(1400);
  recorder.check(
    "the named section shows on its chip",
    (await page.locator("[data-section-chip]").innerText()).includes("Chorus"),
  );

  // The chart plays: compose builds the accompaniment track as one undo step.
  await openPalette(page);
  await page.keyboard.type("strummed", { delay: 30 });
  await settle(400);
  await page.keyboard.press("Enter");
  await settle(2200);
  const composed = await scoreText(page);
  recorder.check("compose adds the accompaniment track", composed.includes("Accompaniment"), composed.slice(0, 200));
  await page.keyboard.press("Control+z");
  await settle(2000);
  recorder.check("one undo removes the whole accompaniment", !(await scoreText(page)).includes("Accompaniment"));

  // The chart is part of the document, so it survives a full reload.
  await settle(1800);
  await page.reload({ waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "LIBRARY", exact: true }).click();
  await settle(600);
  await page.locator('button[title*="New Score"]').first().click();
  await settle(2200);
  const reopened = await scoreText(page);
  recorder.check(
    "chords, lyrics and structure survive a reload",
    reopened.includes("Am7") && reopened.includes("moonlight"),
    reopened.slice(0, 200),
  );
}
