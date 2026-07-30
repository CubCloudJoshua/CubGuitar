/**
 * ASCII tablature, through the app: write it out, read it back in.
 *
 * The unit tests grade the pair against each other in isolation. This grades the
 * whole path a user actually takes — export writes a file *and* the clipboard,
 * the file picker accepts a `.txt` somebody copied out of a forum, and what comes
 * back renders as the same frets. A format that round-trips in a test but cannot
 * be got into or out of the product is not a feature.
 */
import { readFile } from "node:fs/promises";
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "ascii-tab";

export async function run({ browser, baseUrl, recorder }) {
  // Clipboard permission granted deliberately: ASCII tab exists to be pasted, so
  // "did it reach the clipboard" is part of the feature rather than incidental.
  const { page } = await newDevice(browser, recorder, "ascii", { width: 1400, height: 1000 }, [
    "clipboard-read",
    "clipboard-write",
  ]);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1400);

  // A riff across three strings including a two-digit fret: enough that a wrong
  // string or a split fret shows up in the text.
  for (const key of [
    "Digit3", "ArrowRight", "Digit5", "ArrowRight",
    "ArrowDown", "Digit7", "ArrowRight",
    "ArrowDown", "Digit1", "Digit2",
  ]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(140);
  }
  await page.waitForTimeout(1500);
  recorder.check("the riff is in the score", (await scoreText(page)).includes("12"));

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    (async () => {
      await page.getByRole("button", { name: "EXPORT" }).click();
      await page.waitForTimeout(400);
      await page.getByText("ASCII tab (.txt, copied)", { exact: true }).click();
    })(),
  ]).then(([d]) => d);

  recorder.check("the export is a text file", /\.txt$/.test(download.suggestedFilename()), download.suggestedFilename());
  const filePath = await download.path();
  const text = filePath ? await readFile(filePath, "utf8") : "";
  const staff = text.split("\n").filter((l) => l.includes("|"));

  // Wrapped into systems of six at the default line width, which is the point of
  // wrapping: a tab that runs off the right of an email is not pasteable.
  recorder.check(
    "it is written as systems of six strings",
    staff.length > 0 && staff.length % 6 === 0,
    `${staff.length} lines`,
  );
  recorder.check(
    "each system is labelled the way a hand-written tab is",
    staff.every((_, i) => i % 6 !== 0 || staff.slice(i, i + 6).map((l) => l.trim()[0]).join("") === "eBGDAE"),
    staff.map((l) => l.trim()[0]).join(""),
  );
  recorder.check(
    "and no line runs past the wrap width",
    staff.every((l) => l.length <= 80),
    `longest ${Math.max(...staff.map((l) => l.length))}`,
  );
  recorder.check("the frets are on the strings they were entered on", /3/.test(staff[0] ?? "") && /5/.test(staff[0] ?? ""), staff[0]);
  recorder.check("including the two-digit one, unsplit", /12/.test(staff[2] ?? ""), staff[2]);
  recorder.check("and the tuning is stated", /Tuning: E A D G B E/.test(text));

  // The clipboard is the point of this format, so it is checked rather than
  // assumed. Read back through the page, which is the only place it exists.
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  recorder.check(
    "the tab is on the clipboard, ready to paste",
    clip.includes("|") && clip.split("\n").filter((l) => l.includes("|")).length === staff.length,
    clip.slice(0, 60).replace(/\n/g, "\\n"),
  );

  // Now back in. A fresh document first, so what appears can only have come from
  // the file.
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1600);
  recorder.check("a new score has none of the riff in it", !(await scoreText(page)).includes("12"));

  await page.setInputFiles('input[type="file"]', {
    name: "forum-tab.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(text, "utf8"),
  });
  await page.waitForTimeout(3000);

  const reimported = await scoreText(page);
  recorder.check("the imported tab renders the same frets", reimported.includes("12"), reimported.slice(0, 90));
  recorder.check("including the ones on other strings", reimported.includes("3") && reimported.includes("7"));
  recorder.check(
    "and it says rhythm was not carried, because the format records none",
    (await page.locator("text=/rhythm/i").count()) >= 1,
  );

  // A tab typed by hand, with no header, inconsistent bar lines and lyrics around
  // it: what a file off a forum actually looks like.
  const messy = [
    "Verse 1",
    "Am        C         G",
    "I once had a girl",
    "",
    "e|-----------------|",
    "B|-----------------|",
    "G|-----------------|",
    "D|-------7---------|",
    "A|---5-------------|",
    "E|-3---------------|",
    "",
    "or should I say",
  ].join("\n");
  await page.setInputFiles('input[type="file"]', {
    name: "hand-typed.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(messy, "utf8"),
  });
  await page.waitForTimeout(3000);
  const hand = await scoreText(page);
  recorder.check(
    "a hand-typed tab with lyrics around it imports its frets",
    hand.includes("3") && hand.includes("5") && hand.includes("7"),
    hand.slice(0, 90),
  );

  // And a file with no tablature in it must not replace what is on screen.
  const before = await scoreText(page);
  await page.setInputFiles('input[type="file"]', {
    name: "not-a-tab.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Just some words about a song.\nNothing here at all.\n", "utf8"),
  });
  await page.waitForTimeout(2500);
  recorder.check(
    "a text file with no tab in it leaves the score alone",
    (await scoreText(page)) === before,
    (await scoreText(page)).slice(0, 60),
  );
  recorder.check(
    "and says why rather than failing silently",
    (await page.locator("text=/no tablature staff found/i").count()) >= 1,
  );
}
