/** A share recipient keeps a copy: the teacher-to-student loop. */
import { appReady, newDevice, scoreText, withLibrary } from "../harness.mjs";

export const name = "share-save";

export async function run({ browser, baseUrl, recorder }) {
  // Teacher shares the seeded demo. Clipboard access is granted explicitly so
  // the automatic copy is actually exercised rather than left to whatever the
  // runner's browser happens to permit.
  const teacher = await newDevice(browser, recorder, "teacher", { width: 1400, height: 1000 }, [
    "clipboard-read",
    "clipboard-write",
  ]);
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
  // Whether the browser allows a clipboard write is not the app's decision, so
  // the check is that the card is honest about which happened: it either says
  // COPIED and offers nothing further, or it admits it could not and offers the
  // button. Silently claiming a copy that did not happen is the failure.
  const copiedShown = (await teacher.page.locator("text=COPIED").count()) === 1;
  const copyOffered = (await teacher.page.getByRole("button", { name: "COPY" }).count()) === 1;
  recorder.check(
    "the card either copied the link or offers to",
    copiedShown !== copyOffered,
    `copied=${copiedShown} button=${copyOffered}`,
  );
  if (copiedShown) {
    recorder.check(
      "the link really is on the clipboard",
      (await teacher.page.evaluate(() => navigator.clipboard.readText())) === url,
    );
  }

  // And the other branch, forced rather than left to the environment. A browser
  // that refuses the write — an insecure origin, a policy, a runner without the
  // permission — must offer the button rather than claim a copy that never
  // happened. This is the path CI takes.
  const refused = await newDevice(browser, recorder, "clipboard-refused");
  await refused.page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await refused.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(refused.page);
  await refused.page.getByRole("button", { name: "SHARE", exact: true }).click();
  await refused.page.waitForSelector('input[aria-label="Share link"]', { timeout: 20_000 });
  await refused.page.waitForTimeout(900);
  recorder.check(
    "a refused copy does not claim to have copied",
    (await refused.page.locator("text=COPIED").count()) === 0,
  );
  recorder.equal(
    "a refused copy offers the button instead",
    await refused.page.getByRole("button", { name: "COPY" }).count(),
    1,
  );
  await refused.page.close();

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
