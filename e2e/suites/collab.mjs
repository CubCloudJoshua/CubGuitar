/**
 * Realtime collaboration: two browsers, one score. Convergence to a
 * byte-identical rendered document is the assertion that matters.
 */
import { appReady, newDevice, scoreText, withLibrary } from "../harness.mjs";

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

  // The hard case: both edit the *same* note at the same instant. Disjoint
  // edits commute, so they converged even before the server ordered them;
  // conflicting ones only converge because both clients wait to be told where
  // their own edit landed. Fired without awaiting in between so the two
  // messages are genuinely in flight together.
  // Both carets back to the first beat of the first string, the beat that
  // already holds a note, so the two inserts land on the same target.
  for (let i = 0; i < 6; i += 1) {
    await host.page.keyboard.press("ArrowLeft");
    await guest.page.keyboard.press("ArrowLeft");
  }
  await host.page.waitForTimeout(600);
  recorder.check(
    "both carets are on the same beat before the conflict",
    (await host.page.locator("text=/bar 1 · beat 1 · string 1/").count()) === 1 &&
      (await guest.page.locator("text=/bar 1 · beat 1 · string 1/").count()) === 1,
  );
  await Promise.all([host.page.keyboard.press("Digit4"), guest.page.keyboard.press("Digit6")]);
  await host.page.waitForTimeout(2500);
  const hostConflict = await scoreText(host.page);
  const guestConflict = await scoreText(guest.page);
  recorder.check(
    "a conflicting simultaneous edit resolves the same way on both",
    hostConflict === guestConflict,
    `host=${hostConflict.slice(0, 70)} guest=${guestConflict.slice(0, 70)}`,
  );
  // Which fret won is the server's business; that one of them did is not.
  recorder.check(
    "the conflicting edit landed at all",
    /[46]/.test(hostConflict),
    hostConflict.slice(0, 70),
  );

  // A joiner replaying the server's log must land on that same document.
  const latecomer = await newDevice(browser, recorder, "latecomer");
  await latecomer.page.goto(url, { waitUntil: "networkidle" });
  await appReady(latecomer.page);
  await latecomer.page.waitForTimeout(2500);
  recorder.check(
    "a late joiner replays into the same document",
    (await scoreText(latecomer.page)) === hostConflict,
    (await scoreText(latecomer.page)).slice(0, 60),
  );
  await latecomer.page.close();
  await host.page.waitForTimeout(1200);

  // Undo is disabled while live: local snapshot undo would fork the document.
  const beforeUndo = await scoreText(host.page);
  await host.page.keyboard.press("Control+z");
  await host.page.waitForTimeout(1400);
  recorder.check("Ctrl+Z is inert during a live session", (await scoreText(host.page)) === beforeUndo);
  recorder.check("still converged after the undo attempt", (await scoreText(host.page)) === (await scoreText(guest.page)));

  // A guest owns no library entry, so they must be offered a way to keep the
  // work; the host, whose entry autosaves, must not see the offer.
  recorder.check(
    "guest is offered a copy to keep",
    (await guest.page.getByRole("button", { name: "KEEP A COPY" }).count()) === 1,
  );
  recorder.check(
    "host is not offered one",
    (await host.page.getByRole("button", { name: "KEEP A COPY" }).count()) === 0,
  );

  await guest.page.getByRole("button", { name: "KEEP A COPY" }).click();
  await guest.page.waitForTimeout(2000);
  recorder.check(
    "the offer disappears once taken",
    (await guest.page.getByRole("button", { name: "KEEP A COPY" }).count()) === 0,
  );

  // The kept copy survives the session ending and a reload.
  await guest.page.reload({ waitUntil: "networkidle" });
  await appReady(guest.page);
  const kept = await withLibrary(guest.page, (aside) => aside.innerText());
  recorder.check("the guest's copy is in their library after reload", kept.includes("New Score"), kept.slice(0, 120));
}
