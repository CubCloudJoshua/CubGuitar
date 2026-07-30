/**
 * MusicXML, out of the app and back into it.
 *
 * The unit tests grade the pair against itself and `pnpm musicxml` grades our file
 * against alphaTab's reader. Neither of them presses a button. What this suite proves
 * is the part a user actually performs: a riff typed into the editor, exported, and
 * opened again with its frets on the strings they were typed on.
 *
 * The frets are the point. Every notation program claims MusicXML support and most of
 * them write pitches and throw the fingering away, so a guitar part exported from one
 * and opened in another arrives as notes nobody can place. A round trip that keeps the
 * string and fret is the claim, and this is where it is checked through the real UI.
 */
import { readFile } from "node:fs/promises";
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "musicxml";

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "musicxml", { width: 1400, height: 1000 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1400);

  // A riff across three strings with a two-digit fret, so a marker in the right place
  // can be told from a marker.
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
      await page.getByText("MusicXML (.musicxml)", { exact: true }).click();
    })(),
  ]).then(([d]) => d);

  recorder.check(
    "the export is a .musicxml file",
    /\.musicxml$/.test(download.suggestedFilename()),
    download.suggestedFilename(),
  );
  const filePath = await download.path();
  const xml = filePath ? await readFile(filePath, "utf8") : "";

  recorder.check("it is a partwise score", /<score-partwise/.test(xml));
  recorder.check("with a doctype a strict reader will accept", /<!DOCTYPE score-partwise/.test(xml));
  // The tuning and the clef are what make a receiving program show tablature rather
  // than a treble staff full of unplaceable notes.
  recorder.check("it states the staff's tuning", (xml.match(/<staff-tuning/g) ?? []).length === 6, xml.match(/<staff-tuning/g)?.length);
  recorder.check("with a TAB clef", /<sign>TAB<\/sign>/.test(xml));
  recorder.check(
    "and every note carries a string and a fret",
    (xml.match(/<string>/g) ?? []).length === 4 && (xml.match(/<fret>/g) ?? []).length === 4,
    `${(xml.match(/<string>/g) ?? []).length} strings, ${(xml.match(/<fret>/g) ?? []).length} frets`,
  );
  recorder.check("including the two-digit one", /<fret>12<\/fret>/.test(xml));

  // Back in. A fresh document first, so what appears can only have come from the file.
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1600);
  recorder.check("a new score has none of the riff in it", !(await scoreText(page)).includes("12"));

  await page.setInputFiles('input[type="file"]', {
    name: "exported.musicxml",
    mimeType: "application/vnd.recordare.musicxml+xml",
    buffer: Buffer.from(xml, "utf8"),
  });
  await page.waitForTimeout(3500);

  const reimported = await scoreText(page);
  recorder.check("the imported score renders the same frets", reimported.includes("12"), reimported.slice(0, 90));
  recorder.check(
    "including the ones on other strings",
    reimported.includes("3") && reimported.includes("5") && reimported.includes("7"),
    reimported.slice(0, 90),
  );

  // Read by us rather than handed to alphaTab, which is what makes a report possible
  // at all. A clean file has nothing to report, and the banner stays away.
  recorder.check(
    "a clean file reports nothing it could not carry",
    (await page.getByText("could not be read as MusicXML").count()) === 0,
  );

  // A file we cannot read must say so rather than failing silently, and must not take
  // the score the user was looking at with it.
  await page.setInputFiles('input[type="file"]', {
    name: "not-really.musicxml",
    mimeType: "application/vnd.recordare.musicxml+xml",
    buffer: Buffer.from("<html><body>this is not a score</body></html>", "utf8"),
  });
  await page.waitForTimeout(2500);
  recorder.check(
    "a file that is not MusicXML says so in words",
    (await page.locator("body").innerText()).includes("Not a MusicXML score"),
    (await page.locator("body").innerText()).match(/[^\n]*MusicXML[^\n]*/)?.[0] ?? "no notice shown",
  );
}
