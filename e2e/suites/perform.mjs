/**
 * Perform mode: the stage view.
 *
 * The checks that matter here are the ones a player would notice from two
 * metres away with an instrument in their hands. Two of them exist because the
 * first implementation got them wrong in ways that looked fine in code: the
 * engraving palette silently did not apply (alphaTab's colour fields are not
 * strings), and the page-turn scroller was never bounded, so the page grew
 * instead of turning.
 */
import { appReady, newDevice, withLibrary } from "../harness.mjs";

export const name = "perform";

/** The score's scroll container, found by the property that defines it. */
function scrollState(page) {
  return page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("main *")).find(
      (e) => getComputedStyle(e).overflowY === "auto" && e.scrollHeight > e.clientHeight + 4,
    );
    return el ? { top: Math.round(el.scrollTop), height: el.clientHeight, scrollHeight: el.scrollHeight } : null;
  });
}

function glyphFill(page) {
  return page.evaluate(
    () => document.querySelector(".at-surface svg text")?.getAttribute("fill") ?? null,
  );
}

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "perform", { width: 1400, height: 900 });
  const settle = (ms = 900) => page.waitForTimeout(ms);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  const deskFill = await glyphFill(page);

  await page.getByRole("button", { name: "PERFORM", exact: true }).click();
  await settle(3000);

  recorder.equal("the header is gone", await page.locator("header").evaluate((el) => getComputedStyle(el).display), "none");
  // One transport, and it is the stage one: a 44px-tall target rather than the
  // desk pill's compact button.
  recorder.equal("there is exactly one play control", await page.getByRole("button", { name: "Play", exact: true }).count(), 1);
  recorder.check(
    "the play control is big enough to hit without looking",
    ((await page.getByRole("button", { name: "Play", exact: true }).boundingBox())?.height ?? 0) >= 44,
  );
  recorder.check(
    "the position readout is present and large",
    (await page.locator('[aria-label="Position"]').evaluate((el) =>
      Number.parseInt(getComputedStyle(el).fontSize, 10),
    )) >= 36,
  );
  recorder.equal("the background is true black", await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(0, 0, 0)");

  const stageFill = await glyphFill(page);
  recorder.check(
    "the engraving switched to the stage palette",
    stageFill === "#FFFFFF" && stageFill !== deskFill,
    `desk=${deskFill} stage=${stageFill}`,
  );

  recorder.equal("both tap zones are present", await page.locator('[aria-label$="page"]').count(), 2);
  recorder.check("the setlist is offered while stopped", (await page.locator('[aria-label="Setlist"]').count()) === 1);
  recorder.check(
    "nothing overflows sideways",
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );

  // A page turn has to move a bounded scroller, not grow the page.
  const before = await scrollState(page);
  recorder.check("the score has its own bounded scroller", before !== null, JSON.stringify(before));
  await page.getByRole("button", { name: "Next page" }).click();
  await settle(1500);
  const after = await scrollState(page);
  recorder.check(
    "tapping turns the page forward",
    (after?.top ?? 0) > (before?.top ?? 0),
    `${before?.top} -> ${after?.top}`,
  );
  recorder.check(
    "a turn keeps some of the previous page in view",
    (after?.top ?? 0) < (before?.height ?? 0),
    `scrolled ${after?.top} of a ${before?.height}px page`,
  );
  await page.getByRole("button", { name: "Previous page" }).click();
  await settle(1500);
  recorder.equal("tapping turns it back", (await scrollState(page))?.top, 0);

  // Keyboard equivalents, for a foot pedal that sends key events.
  await page.keyboard.press("PageDown");
  await settle(1200);
  recorder.check("PageDown turns the page", ((await scrollState(page))?.top ?? 0) > 0);
  await page.keyboard.press("PageUp");
  await settle(1200);
  recorder.equal("PageUp turns it back", (await scrollState(page))?.top, 0);

  // Picking from the setlist must not drop the user into the editor. Perform
  // hides every editing control, so an authored score opening in edit mode
  // would mean typing frets with no visible tools and landing in the editor on
  // the way out.
  await page.keyboard.press("Escape");
  await settle(2000);
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await settle(1200);
  await page.keyboard.press("Digit5");
  await settle(2500);
  await page.getByRole("button", { name: "PERFORM", exact: true }).click();
  await settle(2500);
  const authored = page.locator('[aria-label^="Play New Score"]').first();
  recorder.check("an authored score is offered in the setlist", (await authored.count()) === 1);
  await authored.click();
  await settle(3000);
  recorder.equal(
    "the setlist keeps the editor closed",
    await page.getByRole("button", { name: "Leave perform mode" }).count(),
    1,
  );
  recorder.check(
    "the authored score actually renders on the stage",
    (await page.locator(".at-surface svg").count()) > 0,
  );

  // Escape leaves, and everything it changed is put back.
  await page.keyboard.press("Escape");
  await settle(2500);
  recorder.equal(
    "Escape leaves perform mode",
    await page.getByRole("button", { name: "Leave perform mode" }).count(),
    0,
  );
  recorder.equal("the header is back", await page.locator("header").evaluate((el) => getComputedStyle(el).display), "flex");
  // The real proof that the setlist did not open the editor: PLAYER only exists
  // while editing, so its absence here means the app is in the player.
  recorder.equal(
    "leaving after a setlist pick lands in the player, not the editor",
    await page.getByRole("button", { name: "PLAYER", exact: true }).count(),
    0,
  );
  recorder.equal("the engraving palette is restored", await glyphFill(page), deskFill);
  recorder.check(
    "the library still works after a round trip",
    (await withLibrary(page, (aside) => aside.innerText())).includes("LIBRARY"),
  );
}
