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

  // Presence is a caret in the music, not a sentence about it. What matters is
  // that it is positioned from the score's own geometry — inside the bar the
  // peer is actually in — because a name tag parked at the wrong bar is worse
  // than no name tag.
  const caret = async (page) =>
    page.evaluate(() => {
      const tag = Array.from(document.querySelectorAll("span")).find(
        (el) => el.textContent === "guest" && el.parentElement?.style.position === "absolute",
      );
      const marker = tag?.parentElement;
      if (!marker) return null;
      const box = marker.getBoundingClientRect();
      const surface = document.querySelector(".at-surface")?.getBoundingClientRect();
      return surface
        ? {
            x: Math.round(box.x),
            height: Math.round(box.height),
            insideScore:
              box.x >= surface.x - 4 &&
              box.x <= surface.x + surface.width + 4 &&
              box.y >= surface.y - 24,
          }
        : null;
    });

  const hostCaret = await caret(host.page);
  recorder.check("the peer's caret is drawn in the score", hostCaret !== null, JSON.stringify(hostCaret));
  recorder.check("it sits inside the rendered music", hostCaret?.insideScore === true, JSON.stringify(hostCaret));
  recorder.check(
    "it spans the staff rather than being a dot",
    (hostCaret?.height ?? 0) > 20,
    `height ${hostCaret?.height}`,
  );
  // And the same information stays available in words, since a caret in a staff
  // is not something a screen reader can convey.
  recorder.check(
    "presence is also announced in words",
    (await host.page.locator("text=/guest at bar 1, beat 2/").count()) === 1,
  );

  // Moving must move the caret, or it is a decoration rather than presence.
  const before = hostCaret?.x ?? 0;
  await guest.page.keyboard.press("ArrowRight");
  await guest.page.keyboard.press("ArrowRight");
  await host.page.waitForTimeout(1600);
  const moved = await caret(host.page);
  recorder.check(
    "the caret follows the peer as they move",
    (moved?.x ?? 0) > before,
    `${before} -> ${moved?.x}`,
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
  // Which fret won is the server's business; that one of them did is not. Read
  // from the status line, which reports the model at the caret, because the
  // rendered score also contains bar numbers — an earlier version of this asked
  // whether the text contained a 4 or a 6 and matched the bar-4 label every
  // time, so it would have passed even if both edits had been dropped.
  const fretAt = async (page) => {
    const text = await page.locator("text=/bar 1 · beat 1 · string 1/").first().innerText();
    return text.match(/fret (\d+)/)?.[1] ?? "none";
  };
  const hostFret = await fretAt(host.page);
  const guestFret = await fretAt(guest.page);
  recorder.check(
    "one of the two conflicting frets won, and the same one on both",
    hostFret === guestFret && (hostFret === "4" || hostFret === "6"),
    `host=${hostFret} guest=${guestFret}`,
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

  // Undo works during the session, as the inverse of this client's own last
  // edit sent through the server. Three things have to hold at once: the edit
  // is actually taken back, the room stays converged, and the guest's work —
  // made *after* the host's edit — survives the host undoing.
  // The host's last edit was the conflicting fret 4 on this beat, which
  // overwrote the fret 7 it typed at the start. So undo has one right answer,
  // whichever of the two conflicting frets the server happened to order last:
  // fret 7 comes back, on both machines.
  await host.page.keyboard.press("Control+z");
  await host.page.waitForTimeout(1800);
  recorder.check(
    "Ctrl+Z restores what the host's own edit overwrote",
    (await fretAt(host.page)) === "7",
    `fret ${await fretAt(host.page)} (was ${hostFret})`,
  );
  recorder.check(
    "the undo reached the guest, so the room stays converged",
    (await scoreText(host.page)) === (await scoreText(guest.page)),
  );
  recorder.check("the guest sees the restored fret too", (await fretAt(guest.page)) === "7");

  // Redo re-sends the original ops, so the host's fret 4 lands again — and
  // lands last, which is why this is 4 rather than whichever fret won the
  // original race.
  await host.page.keyboard.press("Control+Shift+z");
  await host.page.waitForTimeout(1800);
  recorder.check("redo puts the host's edit back", (await fretAt(host.page)) === "4");
  recorder.check(
    "the redo reached the guest too",
    (await scoreText(host.page)) === (await scoreText(guest.page)) && (await fretAt(guest.page)) === "4",
  );

  // The case snapshot undo could never handle: the host undoes an edit made
  // before the guest's latest one, and the guest's note has to survive it.
  await host.page.keyboard.press("Digit2");
  await host.page.waitForTimeout(1200);
  await guest.page.keyboard.press("ArrowRight");
  await guest.page.keyboard.press("ArrowRight");
  await guest.page.keyboard.press("Digit8");
  await guest.page.waitForTimeout(1600);
  const guestNoteBar = await guest.page.locator("text=/bar 1 · beat 3 · string 1/").first().innerText();
  recorder.check("the guest's later note landed", /fret 8/.test(guestNoteBar), guestNoteBar);
  await host.page.keyboard.press("Control+z");
  await host.page.waitForTimeout(1800);
  const survived = await guest.page.locator("text=/bar 1 · beat 3 · string 1/").first().innerText();
  recorder.check(
    "the guest's later edit survives the host's undo",
    /fret 8/.test(survived),
    survived,
  );
  recorder.check(
    "still converged after undoing across a collaborator's edit",
    (await scoreText(host.page)) === (await scoreText(guest.page)),
  );

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
