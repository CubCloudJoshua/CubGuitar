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

const fixture = (name) =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", name);
const FIXTURE = fixture("09-pitched-staff.altex");
const PERCUSSION_ONLY = fixture("10-percussion-only.altex");

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

  // What autosave committed is what a reload shows, so the reload is where it is
  // provable that nothing was invented. Counting note heads on the piano staff is
  // the check that can actually fail: asserting the guitar's 9 survived says
  // nothing about the piano at all.
  const pianoNoteCount = () =>
    page.evaluate(() => {
      // The second staff group in document order is the piano; its note heads are
      // the glyphs alphaTab draws inside it.
      const systems = Array.from(document.querySelectorAll(".at-surface svg"));
      const tallest = systems.sort(
        (a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height,
      )[0];
      return tallest ? tallest.querySelectorAll("path, use").length : -1;
    });

  const glyphsBefore = await pianoNoteCount();
  await settle(2200);
  await page.reload({ waitUntil: "networkidle" });
  await appReady(page);
  await settle(1800);
  recorder.check("the guitar edit survived the reload", (await scoreText(page)).includes("9"));
  recorder.equal(
    "the reload added no glyphs, so nothing was invented and saved",
    await pianoNoteCount(),
    glyphsBefore,
  );

  // The other end of the same problem: a file with nothing editable in it at
  // all. Percussion is not in the model yet, so a drum-only transcription
  // converts to zero tracks — and the serializer substitutes a default guitar
  // track for an empty score, so offering EDIT handed the user a blank staff
  // where their music had been.
  await page.setInputFiles('input[type="file"]', PERCUSSION_ONLY);
  await settle(4000);
  recorder.check(
    "the drum file plays",
    (await page.locator(".at-surface svg").count()) > 0 &&
      (await page.locator("header").innerText()).includes("Percussion Only"),
  );
  recorder.equal(
    "editing is not offered for a file with nothing editable in it",
    await page.getByRole("button", { name: "EDIT", exact: true }).count(),
    0,
  );
  const notice = await page.locator("body").innerText();
  recorder.check(
    "and the player says why",
    /nothing here CubScore can edit/.test(notice) && /percussion is not editable/.test(notice),
    (notice.match(/nothing here[^\n]*/) ?? ["no notice"])[0],
  );
}
