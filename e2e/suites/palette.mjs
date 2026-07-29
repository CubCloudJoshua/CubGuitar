/** Command palette: context-aware commands, filtering, keyboard navigation. */
import { appReady, newDevice, openPalette, scoreText } from "../harness.mjs";

export const name = "palette";

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "palette");

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);

  // Open, filter, and run a command by keyboard alone.
  await openPalette(page);
  recorder.check("Cmd+K opens the palette", true);
  await page.keyboard.type("new sco", { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  recorder.check("filtered command runs", (await page.locator("text=/^EDIT$/").count()) === 1);
  recorder.check(
    "palette closes after running",
    (await page.locator('input[aria-label="Command search"]').count()) === 0,
  );

  // Edit-only commands appear now that we are editing, and the query starts
  // empty on each open (a stale query previously made Enter match nothing).
  await openPalette(page);
  await page.keyboard.type("bass", { delay: 40 });
  await page.waitForTimeout(400);
  recorder.equal(
    "query starts empty on reopen",
    await page.locator('input[aria-label="Command search"]').inputValue(),
    "bass",
  );
  const topMatch = await page.locator('[role="option"][aria-selected="true"]').innerText();
  recorder.check("context-aware edit command is offered", topMatch.includes("Add bass track"), topMatch);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  recorder.check("palette command mutates the score", (await scoreText(page)).includes("Bass"));

  // Arrow navigation moves the selection.
  await openPalette(page);
  await page.keyboard.type("turn", { delay: 30 });
  await page.waitForTimeout(400);
  const optionCount = await page.locator('[role="option"]').count();
  recorder.check("multiple matches listed", optionCount > 1, `${optionCount} options`);
  const first = await page.locator('[role="option"][aria-selected="true"]').innerText();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  const second = await page.locator('[role="option"][aria-selected="true"]').innerText();
  recorder.check("arrow keys move the selection", first !== second, `${first} -> ${second}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  recorder.check(
    "Escape closes the palette",
    (await page.locator('input[aria-label="Command search"]').count()) === 0,
  );

  // Playback is reachable from the palette in any mode.
  await openPalette(page);
  await page.keyboard.type("play", { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  recorder.check("playback starts from the palette", (await page.getByRole("button", { name: "PAUSE" }).count()) === 1);
  await page.getByRole("button", { name: "PAUSE" }).click();
  await page.waitForTimeout(500);

  // A closed drawer must be out of the keyboard's way. It is translated off
  // screen, which hides it from sight and from nothing else: every control
  // inside kept its place in the tab order, so tabbing from the header walked
  // invisibly through the search field and every score's Delete button, and a
  // keyboard user could delete a score they could not see.
  const reachable = async () =>
    page.evaluate(() => {
      const drawer = document.querySelector('[role="dialog"]');
      if (!drawer) return null;
      const focusable = drawer.querySelectorAll("button, input, select, a[href], [tabindex]");
      let reached = 0;
      for (const el of focusable) {
        el.focus?.();
        if (document.activeElement === el) reached += 1;
      }
      document.activeElement?.blur?.();
      return { total: focusable.length, reached };
    });

  const closed = await reachable();
  recorder.check("the drawer has controls to reach", (closed?.total ?? 0) > 0, JSON.stringify(closed));
  recorder.equal("none of a closed drawer's controls can take focus", closed?.reached, 0);

  await page.getByRole("button", { name: "LIBRARY", exact: true }).click();
  await page.waitForTimeout(700);
  const opened = await reachable();
  recorder.check(
    "an open drawer's controls can take focus again",
    (opened?.reached ?? 0) > 0,
    JSON.stringify(opened),
  );
}
