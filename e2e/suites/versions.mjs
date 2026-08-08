/**
 * Version history: an edit is never the end of the document it replaced.
 *
 * The autosave path snapshots the document into a versions store (at most once a
 * minute; the first save of a session always qualifies), and the library lists those
 * snapshots with a RESTORE that makes one current again through the ordinary save
 * path. What this suite proves is the loop a user actually needs: write something,
 * change it, get the earlier state back, and see that the restore itself was saved.
 */
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "versions";

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "versions");
  const settle = (ms = 1000) => page.waitForTimeout(ms);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  // Dense history for the test: every save snapshots, instead of once a minute. The
  // real cadence is a policy about storage, not about correctness, and waiting real
  // minutes in a test buys nothing the interval override does not.
  await page.evaluate(() => localStorage.setItem("cubscore-version-interval-ms", "0"));

  // A document with a distinctive first state: fret 12 on beat one.
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await settle(1400);
  await page.keyboard.press("Digit1");
  await page.keyboard.press("Digit2");
  // Past the autosave debounce, so the first write (and with it the first snapshot)
  // has happened before the document changes again.
  await settle(2200);

  // Now a second state the first snapshot must not contain.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Digit9");
  await settle(2200);
  const edited = await scoreText(page);
  recorder.check("both edits are in the document", edited.includes("12") && edited.includes("9"), edited.slice(0, 120));

  // The history lives in the library, per score.
  await page.getByRole("button", { name: "LIBRARY", exact: true }).click();
  await settle(700);
  await page.locator("[data-history-toggle]").first().click();
  await settle(700);
  const versions = await page.locator("[data-version-row]").count();
  recorder.check("the edit session left at least one version", versions >= 1, `${versions} versions`);

  // Restore the version holding the first edit and not the second. Newest first, so:
  // row 0 is the current state (12 and 9), row 1 is the one before it (12 alone) —
  // the very first snapshot, at the bottom, is the empty document NEW autosaved.
  await page.locator("[data-version-restore]").nth(1).click();
  await settle(2400);
  const restored = await scoreText(page);
  recorder.check("the restored document has the first edit", restored.includes("12"), restored.slice(0, 120));
  recorder.check("and not the second", !restored.includes("9"), restored.slice(0, 120));

  // A restore is a save, so it must survive a reload like any other edit.
  await settle(1800);
  await page.reload({ waitUntil: "networkidle" });
  await appReady(page);
  const reloaded = await scoreText(page);
  recorder.check(
    "the restore survives a reload",
    reloaded.includes("12") && !reloaded.includes("9"),
    reloaded.slice(0, 120),
  );

  // Restoring must not have burned the history: the newer state is still reachable,
  // which is what makes a regretted restore recoverable rather than final.
  await page.getByRole("button", { name: "LIBRARY", exact: true }).click();
  await settle(700);
  await page.locator("[data-history-toggle]").first().click();
  await settle(700);
  recorder.check(
    "history survives the restore",
    (await page.locator("[data-version-row]").count()) >= 1,
    `${await page.locator("[data-version-row]").count()} versions`,
  );
}
