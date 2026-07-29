/**
 * Realtime collaboration: two browsers, one score. Convergence to a
 * byte-identical rendered document is the assertion that matters.
 */
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "collab";

export async function run({ browser, baseUrl, recorder }) {
  // Host opens a live session from a new score.
  const host = await newDevice(browser, recorder, "host");
  await host.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(host.page);
  await host.page.getByRole("button", { name: "NEW", exact: true }).click();
  await host.page.waitForTimeout(1000);
  await host.page.getByRole("button", { name: "COLLAB", exact: true }).click();
  await host.page.waitForSelector('input[aria-label="Collab link"]', { timeout: 20_000 });
  const url = await host.page.locator('input[aria-label="Collab link"]').inputValue();
  recorder.check("collab link has the expected shape", /#c=[a-f0-9]{32}$/.test(url), url);

  // Guest joins cold by link.
  const guest = await newDevice(browser, recorder, "guest");
  await guest.page.goto(url, { waitUntil: "networkidle" });
  await appReady(guest.page);
  await guest.page.waitForTimeout(1500);
  recorder.check("guest lands in the editor", (await guest.page.locator("text=/^EDIT$/").count()) === 1);
  recorder.check("guest sees the session", (await guest.page.locator("text=/LIVE · 2/").count()) === 1);
  recorder.check("host sees the guest", (await host.page.locator("text=/LIVE · 2/").count()) === 1);

  // Edits stream in both directions.
  await host.page.keyboard.press("Digit7");
  await host.page.waitForTimeout(1800);
  recorder.check("host's note is local", (await scoreText(host.page)).includes("7"));
  recorder.check("host's note reached the guest", (await scoreText(guest.page)).includes("7"));

  await guest.page.keyboard.press("ArrowRight");
  await guest.page.keyboard.press("Digit9");
  await guest.page.waitForTimeout(1800);
  recorder.check("guest's note is local", (await scoreText(guest.page)).includes("9"));
  recorder.check("guest's note reached the host", (await scoreText(host.page)).includes("9"));

  recorder.check(
    "presence shows the peer's caret",
    (await host.page.locator("text=/guest at bar 1, beat 2/").count()) === 1,
  );

  // Concurrent edits on different beats must converge.
  await host.page.keyboard.press("ArrowRight");
  await host.page.keyboard.press("ArrowRight");
  await host.page.keyboard.press("Digit3");
  await guest.page.keyboard.press("ArrowRight");
  await guest.page.keyboard.press("ArrowRight");
  await guest.page.keyboard.press("Digit5");
  await host.page.waitForTimeout(2200);
  const hostTab = await scoreText(host.page);
  const guestTab = await scoreText(guest.page);
  recorder.check("host holds both concurrent edits", hostTab.includes("3") && hostTab.includes("5"));
  recorder.check("guest holds both concurrent edits", guestTab.includes("3") && guestTab.includes("5"));
  recorder.check("documents are identical", hostTab === guestTab);

  // Undo is disabled while live: local snapshot undo would fork the document.
  const beforeUndo = await scoreText(host.page);
  await host.page.keyboard.press("Control+z");
  await host.page.waitForTimeout(1400);
  recorder.check("Ctrl+Z is inert during a live session", (await scoreText(host.page)) === beforeUndo);
  recorder.check("still converged after the undo attempt", (await scoreText(host.page)) === (await scoreText(guest.page)));
}
