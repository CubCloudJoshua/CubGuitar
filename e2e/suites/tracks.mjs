/**
 * Track management, tempo, and meter editing.
 *
 * These controls live behind the SCORE and TRACK popovers rather than on the
 * strip, so each check opens the popover it needs — which also exercises that
 * the popovers close correctly after acting.
 */
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "tracks";

/** Opens a popover by its trigger and waits for the panel to render. */
async function openPopover(page, selector) {
  await page.locator(selector).first().click();
  await page.waitForTimeout(400);
}

const SCORE_POPOVER = 'button:has-text("SCORE")';
const TRACK_POPOVER = 'button[aria-label="Tracks"]';
const MORE_POPOVER = 'button[aria-label="More articulations"]';

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "tracks", { width: 1500, height: 1100 });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1000);

  // Tempo, from the score popover, reaches the engraved score.
  await openPopover(page, SCORE_POPOVER);
  await page.getByLabel("Score bpm").fill("150");
  await page.getByLabel("Score bpm").press("Enter");
  await page.waitForTimeout(1400);
  recorder.check("tempo change renders in the score", (await scoreText(page)).includes("= 150"));

  // Meter change from the caret's bar, in the same popover.
  await page.getByLabel("Beats per bar").selectOption("3");
  await page.waitForTimeout(1200);
  recorder.equal("meter selection applies", await page.getByLabel("Beats per bar").inputValue(), "3");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Adding a bass track selects it and accepts notes.
  await openPopover(page, TRACK_POPOVER);
  await page.getByRole("button", { name: "+BASS", exact: true }).click();
  await page.waitForTimeout(1600);
  recorder.check("bass track renders", (await scoreText(page)).includes("Bass"));
  await page.keyboard.press("Digit5");
  await page.waitForTimeout(1000);
  recorder.check("bass accepts a fret", (await page.locator("text=/fret 5/").count()) === 1);

  // A 4-string bass must clamp string movement at 4.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(400);
  recorder.check(
    "string movement clamps to the bass string count",
    (await page.locator("text=/string 4/").count()) === 1,
  );

  // The trigger reflects the active track, which is how the strip stays small.
  const triggerLabel = await page.locator(TRACK_POPOVER).innerText();
  recorder.check(
    "track popover trigger names the active track",
    triggerLabel.includes("Bass"),
    triggerLabel,
  );

  // Removing the active track, then undo restoring it.
  await openPopover(page, TRACK_POPOVER);
  await page.getByRole("button", { name: "✕TRK", exact: true }).click();
  await page.waitForTimeout(1400);
  recorder.check("removed track leaves the score", !(await scoreText(page)).includes("Bass"));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1400);
  recorder.check("undo restores the removed track", (await scoreText(page)).includes("Bass"));

  // Secondary articulations are reachable from the strip's MORE popover.
  await page.keyboard.press("Digit3");
  await page.waitForTimeout(700);
  await openPopover(page, MORE_POPOVER);
  await page.getByRole("button", { name: "Slide", exact: true }).click();
  await page.waitForTimeout(1200);
  recorder.check(
    "the MORE popover closes after applying an articulation",
    (await page.getByRole("button", { name: "Slide", exact: true }).count()) === 0,
  );
  // Reopening shows it applied, which proves the op landed on the note rather
  // than the popover merely closing.
  await openPopover(page, MORE_POPOVER);
  const slidePressed = await page
    .getByRole("button", { name: "Slide", exact: true })
    .evaluate((el) => getComputedStyle(el).fontWeight);
  recorder.check("the applied articulation reads as active", slidePressed === "700", slidePressed);
}
