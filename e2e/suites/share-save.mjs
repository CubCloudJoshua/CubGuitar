/** A share recipient keeps a copy: the teacher-to-student loop. */
import { appReady, newDevice, withLibrary } from "../harness.mjs";

export const name = "share-save";

export async function run({ browser, baseUrl, recorder }) {
  // Teacher shares the seeded demo.
  const teacher = await newDevice(browser, recorder, "teacher");
  await teacher.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(teacher.page);
  await teacher.page.getByRole("button", { name: "SHARE", exact: true }).click();
  await teacher.page.waitForSelector('input[aria-label="Share link"]', { timeout: 20_000 });
  const url = await teacher.page.locator('input[aria-label="Share link"]').inputValue();
  recorder.check("share link has the expected shape", /#s=[A-Za-z0-9_-]{16}$/.test(url), url);

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
