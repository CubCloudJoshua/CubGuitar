/**
 * Imported staves that have no strings — a piano or vocal part.
 *
 * They are carried pitch-exact (fixtures/09-pitched-staff.altex round-trips
 * exactly in the corpus suite), which makes them look editable. They are not:
 * fret entry needs a tuning to turn a digit into a pitch, and there is none, so
 * every keystroke used to append a stray middle C to the user's imported part —
 * and autosave wrote it down. This suite pins the guard, and pins that the guard
 * is selective rather than a blanket break of note entry.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appReady, newDevice, scoreText, withLibrary } from "../harness.mjs";

export const name = "pitched-staff";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "09-pitched-staff.altex",
);

const RAIL = 'nav[aria-label="Tracks"]';

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "pitched", { width: 1500, height: 1100 });
  const settle = (ms = 900) => page.waitForTimeout(ms);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);

  await page.setInputFiles('input[type="file"]', FIXTURE);
  await settle(3500);
  const listing = await withLibrary(page, (aside) => aside.innerText());
  recorder.check("the import is in the library", listing.includes("Pitched Staff"), listing.slice(0, 120));

  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await settle(2500);
  recorder.equal(
    "all three staves are carried into the editor",
    await page.locator(`${RAIL} button[aria-label^="Track "]`).count(),
    3,
  );
  // The importer used to report a pitched staff as something the conversion
  // could not carry, which the banner presents as "absent from the editable
  // version". It is present, so that claim must not appear.
  const body = await page.locator("body").innerText();
  recorder.check(
    "a carried staff is not reported as lost",
    !body.includes("pitched staff"),
    body.slice(0, 200),
  );

  // The piano staff must refuse fret entry rather than inventing notes.
  await page.locator(`${RAIL} button[aria-label^="Track 2"]`).click();
  await settle(1400);
  recorder.check(
    "the caret is on the piano staff",
    ((await page.locator(`${RAIL} button[aria-current="true"]`).getAttribute("aria-label")) ?? "").includes("Piano"),
  );
  const beforePiano = await scoreText(page);
  for (const key of ["Digit7", "Digit3", "Digit1"]) {
    await page.keyboard.press(key);
    await settle(500);
  }
  await settle(1800);
  recorder.equal("typing a fret on a stringless staff changes nothing", await scoreText(page), beforePiano);

  // And the guard is selective: the same keystroke on the guitar staff works.
  await page.locator(`${RAIL} button[aria-label^="Track 1"]`).click();
  await settle(1400);
  const beforeGuitar = await scoreText(page);
  await page.keyboard.press("Digit9");
  await settle(2000);
  recorder.check(
    "the same keystroke still works on a fretted staff",
    (await scoreText(page)) !== beforeGuitar,
  );
  recorder.check("the entered fret is the one typed", (await page.locator("text=/fret 9/").count()) === 1);

  // Nothing invented survives a reload either, which is what autosave would
  // have committed.
  await settle(2200);
  await page.reload({ waitUntil: "networkidle" });
  await appReady(page);
  await settle(1500);
  const afterReload = await scoreText(page);
  recorder.check(
    "the reloaded document has no invented notes on the piano staff",
    afterReload.includes("9"),
    afterReload.slice(0, 80),
  );
}
