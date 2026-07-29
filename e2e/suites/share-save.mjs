/** A share recipient keeps a copy: the teacher-to-student loop. */
import { appReady, newDevice, scoreText, withLibrary } from "../harness.mjs";

export const name = "share-save";

export async function run({ browser, baseUrl, recorder }) {
  // Teacher shares the seeded demo.
  const teacher = await newDevice(browser, recorder, "teacher");
  await teacher.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(teacher.page);
  const beforeShare = await scoreText(teacher.page);
  const systemsBefore = await teacher.page.locator(".at-surface svg").count();
  await teacher.page.getByRole("button", { name: "SHARE", exact: true }).click();
  await teacher.page.waitForSelector('input[aria-label="Share link"]', { timeout: 20_000 });
  const url = await teacher.page.locator('input[aria-label="Share link"]').inputValue();
  recorder.check("share link has the expected shape", /#s=[A-Za-z0-9_-]{16}$/.test(url), url);

  // The card carries a miniature of the score, which is a clone of the live
  // notation. SVG references are document-wide, so a clone that kept the
  // original's ids would make the real score resolve its glyphs into the
  // thumbnail and visibly break. This is that check.
  await teacher.page.waitForTimeout(900);
  recorder.check(
    "the card shows a miniature of the score",
    (await teacher.page.locator('div:has(> div > svg[aria-hidden="true"])').count()) > 0,
  );
  recorder.equal("the miniature did not disturb the real score", await scoreText(teacher.page), beforeShare);
  recorder.equal(
    "the score still renders every system",
    await teacher.page.locator('.at-surface svg:not([aria-hidden="true"])').count(),
    systemsBefore,
  );
  recorder.check(
    "the link is copied without asking",
    (await teacher.page.locator("text=COPIED").count()) === 1,
  );

  // Student opens it cold: no cookies, no library.
  const student = await newDevice(browser, recorder, "student", { width: 1300, height: 900 });
  await student.page.goto(url, { waitUntil: "networkidle" });
  await appReady(student.page);
  recorder.check(
    "recipient is offered a save",
    (await student.page.getByRole("button", { name: "SAVE TO MY LIBRARY" }).count()) === 1,
  );
  await student.page.getByRole("button", { name: "SAVE TO MY LIBRARY" }).click();
  await student.page.waitForTimeout(900);
  recorder.check(
    "save confirms and offers the library",
    (await student.page.locator("text=SAVED — OPEN MY LIBRARY").count()) === 1,
  );

  // Following into the full app, the saved score is in their library.
  await student.page.locator("text=SAVED — OPEN MY LIBRARY").click();
  await appReady(student.page);
  const listing = await withLibrary(student.page, (aside) => aside.innerText());
  recorder.check("saved score is in the recipient's library", listing.includes("CubScore Demo"), listing.slice(0, 120));
}
