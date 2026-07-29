/**
 * An imported file is the user's only copy. This suite exists because it was
 * not safe: pressing EDIT on an import used to hand the row to the autosave,
 * which a second later replaced the original bytes with the editor's lossy
 * alphaTex projection — no edit made, no warning, no way back.
 *
 * The corpus of real Guitar Pro files is deliberately not committed, so the
 * binary fixture is made here: export the seeded demo to .gp, then import that
 * file back. It is a genuine byte-backed import as far as the app is concerned.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appReady, newDevice, openPalette, scoreText, withLibrary } from "../harness.mjs";

export const name = "import-safety";

/** Reads the library listing as one line per entry. */
async function listing(page) {
  return withLibrary(page, (aside) => aside.innerText());
}

/** Runs a palette command by its visible title. */
async function runCommand(page, title) {
  await openPalette(page);
  await page.locator('input[aria-label="Command search"]').fill(title);
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
}

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "import-safety");
  const settle = (ms = 900) => page.waitForTimeout(ms);
  const downloads = await mkdtemp(path.join(tmpdir(), "cubscore-import-"));

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await appReady(page);

    // Make the binary fixture: export the demo as a real .gp file.
    const download = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      runCommand(page, "Export Guitar Pro"),
    ]).then(([d]) => d);
    const gpPath = path.join(downloads, "fixture.gp");
    await download.saveAs(gpPath);
    const gpSize = (await stat(gpPath)).size;
    recorder.check("exported .gp is a non-trivial file", gpSize > 500, `${gpSize} bytes`);

    // Import it. The app has no idea this file came from itself.
    await page.setInputFiles('input[type="file"]', gpPath);
    await settle(3000);
    const imported = await listing(page);
    recorder.check("import is listed as Guitar Pro", imported.includes("Guitar Pro"), imported.slice(0, 200));
    const countAfterImport = Number(imported.match(/LIBRARY \((\d+)\)/)?.[1]);
    recorder.equal("import added exactly one entry", countAfterImport, 2);

    // The regression: enter the editor and touch nothing. Wait well past the
    // one-second autosave debounce, then leave.
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await settle(3000);
    await page.getByRole("button", { name: "PLAYER", exact: true }).click();
    await settle(1500);

    const afterIdleEdit = await listing(page);
    recorder.check(
      "opening the editor keeps the entry a Guitar Pro import",
      afterIdleEdit.includes("Guitar Pro"),
      afterIdleEdit.slice(0, 200),
    );
    recorder.equal(
      "opening the editor adds no rows",
      Number(afterIdleEdit.match(/LIBRARY \((\d+)\)/)?.[1]),
      countAfterImport,
    );

    // Now make a real edit. It must persist, and it still must not cost the
    // original: the row keeps both.
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await settle(1500);
    await page.keyboard.press("Digit9");
    await settle(2500);
    await page.getByRole("button", { name: "PLAYER", exact: true }).click();
    await settle(1500);

    const afterRealEdit = await listing(page);
    recorder.check(
      "an edited import is still stored as Guitar Pro",
      afterRealEdit.includes("Guitar Pro"),
      afterRealEdit.slice(0, 200),
    );
    recorder.equal(
      "editing in place does not fork the row",
      Number(afterRealEdit.match(/LIBRARY \((\d+)\)/)?.[1]),
      countAfterImport,
    );

    // The preserved bytes are reachable, which is the only thing that makes
    // preserving them worth anything.
    await runCommand(page, "Show imported original");
    await settle(3500);
    // The 9 typed above is the one thing that tells the original apart from the
    // edit. Checking that *something* rendered passed whichever one appeared,
    // which is exactly the confusion this command exists to resolve.
    const original = await scoreText(page);
    recorder.check("the original renders", original.length > 0);
    recorder.check(
      "what renders is the original, not the edit",
      !original.includes("9"),
      original.slice(0, 90),
    );
    recorder.check(
      "the original is play-only, with EDIT offered to resume",
      (await page.getByRole("button", { name: "EDIT", exact: true }).count()) === 1,
    );

    // And the edit was not thrown away by going back to the original.
    await page.getByRole("button", { name: "EDIT", exact: true }).click();
    await settle(2000);
    recorder.check("resumed edit still has the entered note", (await scoreText(page)).includes("9"));

    // Survives a reload: the row on disk, not just this tab's memory.
    await page.getByRole("button", { name: "PLAYER", exact: true }).click();
    await settle(1200);
    await page.reload({ waitUntil: "networkidle" });
    await appReady(page);
    const afterReload = await listing(page);
    recorder.check(
      "import survives a reload as Guitar Pro",
      afterReload.includes("Guitar Pro"),
      afterReload.slice(0, 200),
    );
    recorder.equal(
      "reload shows the same number of entries",
      Number(afterReload.match(/LIBRARY \((\d+)\)/)?.[1]),
      countAfterImport,
    );

    // A deleted row stays deleted: autosave must not resurrect it.
    await page.getByRole("button", { name: "LIBRARY", exact: true }).click();
    await settle(600);
    const titles = await page.locator("aside button[aria-label^='Delete ']").count();
    recorder.check("delete controls are present", titles >= 2);
    await page.locator("aside button[aria-label^='Delete ']").first().click();
    await settle(1200);
    await page.keyboard.press("Escape");
    await settle(400);
    await page.reload({ waitUntil: "networkidle" });
    await appReady(page);
    const afterDelete = await listing(page);
    recorder.equal(
      "a deleted entry does not come back",
      Number(afterDelete.match(/LIBRARY \((\d+)\)/)?.[1]),
      countAfterImport - 1,
    );
  } finally {
    await rm(downloads, { recursive: true, force: true }).catch(() => undefined);
  }
}
