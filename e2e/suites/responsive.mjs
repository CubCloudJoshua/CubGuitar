/**
 * Phone-width function. The README claims full controls down to phone width,
 * and the Listen-mode rework (floating pill, library drawer) changed every
 * layout assumption, so the claim needs a standing test rather than a memory.
 */
import { appReady, newDevice, openPalette, scoreText, withLibrary } from "../harness.mjs";

export const name = "responsive";

/** iPhone 14 logical viewport. */
const PHONE = { width: 390, height: 844 };

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "phone", PHONE);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);

  // The page must never scroll sideways; wide content scrolls inside its own
  // container instead.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  recorder.check(
    "no horizontal page overflow",
    overflow.scrollWidth <= overflow.innerWidth + 1,
    `scrollWidth ${overflow.scrollWidth} vs viewport ${overflow.innerWidth}`,
  );

  // The transport must be on screen and fully within the viewport.
  const pill = await page.getByRole("button", { name: "PLAY" }).boundingBox();
  recorder.check("transport play button is visible", pill !== null);
  if (pill) {
    recorder.check(
      "transport sits inside the viewport",
      pill.x >= 0 && pill.x + pill.width <= PHONE.width + 1,
      `x=${Math.round(pill.x)} w=${Math.round(pill.width)}`,
    );
    recorder.check(
      "transport is vertically on screen",
      pill.y >= 0 && pill.y + pill.height <= PHONE.height + 1,
      `y=${Math.round(pill.y)} h=${Math.round(pill.height)}`,
    );
  }

  // Playback is reachable by touch.
  await page.getByRole("button", { name: "PLAY" }).click();
  await page.waitForTimeout(1500);
  recorder.check("playback starts on a phone", (await page.getByRole("button", { name: "PAUSE" }).count()) === 1);
  await page.getByRole("button", { name: "PAUSE" }).click();
  await page.waitForTimeout(400);

  // The expanded practice controls must fit too: this is where a 560px panel
  // would silently overflow a 390px screen.
  await page.getByRole("button", { name: "More controls" }).click();
  await page.waitForTimeout(600);
  const expandedOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  recorder.check("expanded transport controls do not overflow", expandedOverflow);
  const loopBox = await page.getByRole("button", { name: "LOOP", exact: true }).boundingBox();
  recorder.check(
    "practice controls stay within the viewport",
    loopBox !== null && loopBox.x >= 0 && loopBox.x + loopBox.width <= PHONE.width + 1,
    loopBox ? `x=${Math.round(loopBox.x)} w=${Math.round(loopBox.width)}` : "not found",
  );
  await page.getByRole("button", { name: "More controls" }).click();
  await page.waitForTimeout(400);

  // The library drawer is the only route to scores on a phone.
  const listing = await withLibrary(page, (aside) => aside.innerText());
  recorder.check("library drawer opens on a phone", listing.includes("LIBRARY"), listing.slice(0, 80));
  const drawerBox = await page.locator('div[role="dialog"][aria-label="Library"]').boundingBox();
  recorder.check(
    "drawer fits the phone width",
    drawerBox !== null && drawerBox.width <= PHONE.width,
    drawerBox ? `w=${Math.round(drawerBox.width)}` : "not found",
  );

  // The command palette is the escape hatch for controls that do not fit.
  await openPalette(page);
  const paletteBox = await page.locator('div[role="dialog"][aria-label="Command palette"]').boundingBox();
  recorder.check(
    "command palette fits the phone width",
    paletteBox !== null && paletteBox.x >= 0 && paletteBox.width <= PHONE.width,
    paletteBox ? `x=${Math.round(paletteBox.x)} w=${Math.round(paletteBox.width)}` : "not found",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Editing must work at this width, and the edit bar must not overflow.
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1400);
  recorder.check("editor opens on a phone", (await page.locator("text=/^EDIT$/").count()) === 1);
  await page.keyboard.press("Digit7");
  await page.waitForTimeout(900);
  recorder.check("fret entry works on a phone", (await scoreText(page)).includes("7"));
  const editOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  recorder.check("editor layout does not overflow", editOverflow);

  // The score itself may be wider than the phone, but only inside its own
  // scroll container.
  const scoreScrolls = await page.evaluate(() => {
    const host = document.querySelector(".alphaTab")?.parentElement;
    if (!host) return null;
    const style = getComputedStyle(host);
    return { overflowX: style.overflowX, clientWidth: host.clientWidth, viewport: window.innerWidth };
  });
  recorder.check(
    "wide scores scroll inside their own container",
    scoreScrolls !== null && scoreScrolls.overflowX === "auto",
    JSON.stringify(scoreScrolls),
  );
}
