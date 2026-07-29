/**
 * Track management, tempo, and meter editing.
 *
 * Tempo and meter are chips on the score itself, positioned from the same
 * render as the engraving, so these checks verify both that editing works and
 * that the chips land inside the bar they label. Tracks are on the instrument
 * rail beside the score, one click each, and the rail is expected to report
 * which track the caret is in.
 */
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "tracks";

/** Opens a popover by its trigger and waits for the panel to render. */
async function openPopover(page, selector) {
  await page.locator(selector).first().click();
  await page.waitForTimeout(400);
}

const MORE_POPOVER = 'button[aria-label="More articulations"]';
const RAIL = 'nav[aria-label="Tracks"]';
const SCORE_BOX = "main";

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "tracks", { width: 1500, height: 1100 });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1000);

  // Tempo and meter are edited on the score itself, as chips over the caret's
  // bar. They must be positioned from the same render as the engraving, so the
  // first thing to check is that they land inside the bar they label.
  const chipInBar = async () => {
    const chip = await page.locator('[aria-label^="Time signature"]').first().boundingBox();
    const frame = await page.locator(`${SCORE_BOX} div[aria-hidden="true"]`).first().boundingBox();
    if (!chip || !frame) return null;
    return (
      chip.x >= frame.x - 2 &&
      chip.x + chip.width <= frame.x + frame.width + 2 &&
      chip.y >= frame.y - 2 &&
      chip.y <= frame.y + frame.height
    );
  };
  recorder.check("the caret's bar is framed in the score", (await chipInBar()) !== null);
  recorder.check("the meter chip sits inside the bar it labels", (await chipInBar()) === true);

  await page.locator('[aria-label^="Tempo"]').first().click();
  await page.waitForTimeout(400);
  await page.getByLabel("Tempo in beats per minute").fill("150");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1600);
  recorder.check("tempo edited on the score reaches the engraving", (await scoreText(page)).includes("= 150"));
  recorder.check(
    "the tempo chip reads back the new tempo",
    ((await page.locator('[aria-label^="Tempo"]').first().getAttribute("aria-label")) ?? "").includes("150"),
  );

  // Meter, from the chip on the same bar.
  await page.locator('[aria-label^="Time signature"]').first().click();
  await page.waitForTimeout(400);
  await page.getByLabel("Beats per bar").selectOption("3");
  await page.waitForTimeout(1600);
  // Deliberately not asserted against the rendered text. alphaTab draws the time
  // signature as glyph paths, not <text>, so it never appears in scoreText — an
  // earlier version of this checked for a "3" in the score and was matching the
  // bar-3 label, which meant it passed whatever the meter did. The chip below
  // reads the model back, which is the part this control is responsible for.
  recorder.check(
    "the meter chip reads back the new signature",
    ((await page.locator('[aria-label^="Time signature"]').first().getAttribute("aria-label")) ?? "").includes("3/4"),
  );

  // Tempo belongs to the score, not to every bar, so it is only offered where
  // the model actually keeps it.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
  recorder.check(
    "the caret left bar 1",
    (await page.locator("text=/bar 2 · beat/").count()) === 1,
  );
  recorder.equal(
    "the tempo chip is offered only on the bar that holds it",
    await page.locator('[aria-label^="Tempo"]').count(),
    0,
  );
  recorder.equal(
    "the meter chip follows the caret to the new bar",
    await page.locator('[aria-label^="Time signature"]').count(),
    1,
  );

  // The rail is present in the editor and lists the one track we have.
  recorder.check("the instrument rail is beside the score", (await page.locator(RAIL).count()) === 1);
  recorder.equal(
    "the rail lists one track for a new score",
    await page.locator(`${RAIL} button[aria-label^="Track "]`).count(),
    1,
  );

  // Adding a bass track from the rail selects it and accepts notes.
  await page.getByRole("button", { name: "Add bass track" }).click();
  await page.waitForTimeout(1600);
  recorder.check("bass track renders", (await scoreText(page)).includes("Bass"));
  recorder.equal(
    "the rail grew a second track",
    await page.locator(`${RAIL} button[aria-label^="Track "]`).count(),
    2,
  );
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

  // The rail marks which track the caret is in, and clicking one moves it.
  const railCurrent = () =>
    page.locator(`${RAIL} button[aria-current="true"]`).getAttribute("aria-label");
  recorder.check(
    "the rail marks the active track",
    (await railCurrent())?.includes("Bass") ?? false,
    (await railCurrent()) ?? "none",
  );
  await page.locator(`${RAIL} button[aria-label^="Track 1"]`).click();
  await page.waitForTimeout(900);
  recorder.check(
    "clicking the rail switches track",
    (await railCurrent())?.includes("Guitar") ?? false,
    (await railCurrent()) ?? "none",
  );
  recorder.check(
    "switching track puts the caret at the start of it",
    (await page.locator("text=/bar 1 · beat 1 · string 1/").count()) === 1,
  );
  await page.locator(`${RAIL} button[aria-label^="Track 2"]`).click();
  await page.waitForTimeout(900);

  // Removing the active track from the rail, then undo restoring it.
  await page.getByRole("button", { name: "Remove active track" }).click();
  await page.waitForTimeout(1400);
  recorder.check("removed track leaves the score", !(await scoreText(page)).includes("Bass"));
  recorder.equal(
    "the rail drops the removed track",
    await page.locator(`${RAIL} button[aria-label^="Track "]`).count(),
    1,
  );
  recorder.equal(
    "the remove control hides when only one track is left",
    await page.getByRole("button", { name: "Remove active track" }).count(),
    0,
  );
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
