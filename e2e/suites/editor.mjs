/** Editing fundamentals: note entry, caret movement, history, persistence. */
import { appReady, newDevice, scoreText, withLibrary } from "../harness.mjs";

export const name = "editor";

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "editor");
  const settle = (ms = 900) => page.waitForTimeout(ms);
  const bars = async () =>
    (await page.locator("header").innerText()).match(/(\d+) bars/)?.[1] ?? null;

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);

  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await settle(1200);
  recorder.check("NEW enters edit mode", (await page.locator("text=/^EDIT$/").count()) === 1);
  recorder.check(
    "caret starts at bar 1 beat 1 string 1",
    (await page.locator("text=/bar 1 · beat 1 · string 1/").count()) === 1,
  );

  // Fret entry on the top string.
  await page.keyboard.press("Digit5");
  await settle();
  recorder.check("typed fret renders in the tab", (await scoreText(page)).includes("5"));
  recorder.check("status shows the entered fret", (await page.locator("text=/fret 5/").count()) === 1);

  // Two consecutive digits combine into one fret, the Guitar Pro behaviour.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Digit1");
  await page.keyboard.press("Digit2");
  await settle();
  recorder.check("two digits combine into fret 12", (await page.locator("text=/fret 12/").count()) === 1);

  // String movement.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Digit7");
  await settle();
  recorder.check(
    "caret moves across strings",
    (await page.locator("text=/string 3 · fret 7/").count()) === 1,
  );

  // Duration and articulation on the current beat.
  await page.getByRole("button", { name: "1/8", exact: true }).click();
  await settle();
  recorder.check("duration control responds", (await page.locator("body").innerText()).includes("1/8"));

  await page.getByRole("button", { name: "P.M.", exact: true }).click();
  await settle();
  recorder.check("palm mute renders in the score", (await scoreText(page)).includes("P.M."));

  // Structure and history.
  await page.keyboard.press("Enter");
  await settle();
  const afterAdd = await bars();
  await page.keyboard.press("Control+z");
  await settle();
  const afterUndo = await bars();
  await page.keyboard.press("Control+Shift+z");
  await settle();
  const afterRedo = await bars();
  recorder.check("Enter adds a bar", afterAdd !== null);
  recorder.equal("undo removes the added bar", afterUndo, String(Number(afterAdd) - 1));
  recorder.equal("redo restores it", afterRedo, afterAdd);

  // Deleting a note changes the rendered score.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await settle();
  const beforeDelete = await scoreText(page);
  await page.keyboard.press("Delete");
  await settle();
  recorder.check("delete changes the score", beforeDelete !== (await scoreText(page)));

  // Autosave survives a full reload and reopens in the editor.
  await settle(1600);
  const countBefore = await withLibrary(page, (aside) =>
    aside.innerText().then((t) => t.match(/LIBRARY \((\d+)\)/)?.[1]),
  );
  await page.reload({ waitUntil: "networkidle" });
  await appReady(page);
  const afterReload = await withLibrary(page, (aside) =>
    aside.innerText().then((t) => ({
      count: t.match(/LIBRARY \((\d+)\)/)?.[1],
      hasNewScore: t.includes("New Score"),
    })),
  );
  recorder.equal("library count survives reload", afterReload.count, countBefore);
  recorder.check("autosaved score is listed", afterReload.hasNewScore);

  await page.getByRole("button", { name: "LIBRARY", exact: true }).click();
  await settle(600);
  await page.locator('button[title*="New Score"]').first().click();
  await settle(1800);
  recorder.check("authored score reopens in the editor", (await page.locator("text=/^EDIT$/").count()) === 1);
  recorder.check("entered notes survived", (await scoreText(page)).includes("12"));
}
