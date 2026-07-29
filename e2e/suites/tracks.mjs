/** Track management, tempo, and meter editing. */
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "tracks";

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "tracks", { width: 1500, height: 1100 });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1000);

  // Tempo reaches the engraved score.
  await page.getByLabel("Score bpm").fill("150");
  await page.getByLabel("Score bpm").press("Enter");
  await page.waitForTimeout(1200);
  recorder.check("tempo change renders in the score", (await scoreText(page)).includes("= 150"));

  // Adding a bass track selects it and accepts notes.
  await page.getByRole("button", { name: "+BASS", exact: true }).click();
  await page.waitForTimeout(1500);
  recorder.check("bass track renders", (await scoreText(page)).includes("Bass"));
  recorder.equal("new track becomes active", await page.getByLabel("Active track").inputValue(), "1");
  await page.keyboard.press("Digit5");
  await page.waitForTimeout(1000);
  recorder.check("bass accepts a fret", (await page.locator("text=/fret 5/").count()) === 1);

  // A 4-string bass must clamp string movement at 4.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(400);
  recorder.check("string movement clamps to the bass string count", (await page.locator("text=/string 4/").count()) === 1);

  // Meter change from the caret's bar.
  await page.getByLabel("Beats per bar").selectOption("3");
  await page.waitForTimeout(1200);
  recorder.equal("meter selection applies", await page.getByLabel("Beats per bar").inputValue(), "3");

  // Removing the active track, then undo restoring it.
  await page.getByLabel("Active track").selectOption("1");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "✕TRK", exact: true }).click();
  await page.waitForTimeout(1200);
  recorder.check("removed track leaves the score", !(await scoreText(page)).includes("Bass"));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1200);
  recorder.check("undo restores the removed track", (await scoreText(page)).includes("Bass"));
}
