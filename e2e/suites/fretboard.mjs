/**
 * The fretboard reader: an isometric neck drawn from our own timeline.
 *
 * The checks that matter are about *where* the geometry comes from. Nothing here
 * is measured off alphaTab's engraved canvas — every position is computed from
 * @cubscore/core's timeline and the track's tuning — so the assertions are about
 * notes landing on the string and fret the document says, and about them moving
 * toward the strike line as the clock advances. A view that merely looked like a
 * fretboard would pass none of them.
 */
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "fretboard";

/** Everything the reader has drawn, read straight out of the SVG. */
const readNeck = (page) =>
  page.evaluate(() => {
    const svg = document.querySelector(".iso-surface");
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const num = (el, attr) => Number(el.getAttribute(attr));
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      strings: Array.from(svg.querySelectorAll("[data-iso-string]")).map((el) => ({
        n: Number(el.getAttribute("data-iso-string")),
        width: Number(getComputedStyle(el).strokeWidth.replace("px", "")),
        // Both ends of the string, at the same two moments for every string, so
        // spacing across the neck can be measured without time getting mixed in.
        nearX: Number(el.getAttribute("x1")),
        nearY: Number(el.getAttribute("y1")),
        farX: Number(el.getAttribute("x2")),
      })),
      bars: Array.from(svg.querySelectorAll("[data-iso-bar]")).map((el) => Number(el.getAttribute("data-iso-bar"))),
      strike: svg.querySelectorAll("[data-iso-strike]").length,
      notes: Array.from(svg.querySelectorAll("[data-iso-note]")).map((el) => ({
        fret: Number(el.getAttribute("data-iso-note")),
        string: Number(el.getAttribute("data-iso-note-string")),
        lit: el.getAttribute("data-iso-lit") === "1",
        x: Math.round(num(el, "cx")),
        y: Math.round(num(el, "cy")),
        r: num(el, "r"),
      })),
    };
  });

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "fretboard", { width: 1400, height: 1000 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await page.waitForTimeout(1400);

  recorder.check(
    "the reader is off until asked for",
    (await page.locator(".iso-surface").count()) === 0,
  );

  // A riff that uses three strings and a two-digit fret, so the checks below can
  // tell a marker in the right place from a marker.
  const keys = [
    "Digit3", "ArrowRight", "Digit5", "ArrowRight", "Digit7", "ArrowRight",
    "ArrowDown", "Digit2", "ArrowRight", "ArrowDown", "Digit1", "Digit2",
  ];
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(140);
  }
  await page.waitForTimeout(1400);
  recorder.check("the riff is in the score", (await scoreText(page)).includes("12"));

  // Back to the top first. Moving the caret seeks playback, so after entering a
  // riff the playhead sits at the last note — and a reader shows what is *ahead*
  // of the playhead, so everything just typed would be behind it and correctly
  // not drawn. An earlier version of this suite read the neck from there and
  // concluded three of the five notes were missing.
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await page.waitForTimeout(700);

  await page.getByRole("button", { name: "FRETBOARD", exact: true }).click();
  await page.waitForTimeout(1200);

  const neck = await readNeck(page);
  recorder.check("FRETBOARD draws a neck", neck !== null);
  recorder.check(
    "one line per string of the track's tuning",
    neck?.strings.length === 6,
    `${neck?.strings.length} strings`,
  );
  recorder.check(
    "the strings thicken from the first to the sixth, as on the instrument",
    (neck?.strings ?? []).every((s, i) => i === 0 || s.width > neck.strings[i - 1].width),
    JSON.stringify(neck?.strings.map((s) => s.width)),
  );
  recorder.check("there is exactly one strike line", neck?.strike === 1);
  recorder.check("bar lines cross the neck", (neck?.bars.length ?? 0) >= 2, JSON.stringify(neck?.bars));

  // The frets and strings are the document's, not decoration. Fret 12 on string 3
  // was entered above and must be drawn there.
  const twelve = neck?.notes.find((n) => n.fret === 12);
  recorder.check("the two-digit fret is drawn as one note", twelve !== undefined, JSON.stringify(neck?.notes));
  recorder.check("and on the string it was entered on", twelve?.string === 3, `string ${twelve?.string}`);
  recorder.check(
    "every note the riff entered is on the neck",
    [3, 5, 7, 2, 12].every((fret) => (neck?.notes ?? []).some((n) => n.fret === fret)),
    JSON.stringify((neck?.notes ?? []).map((n) => `${n.fret}/${n.string}`)),
  );

  // Isometry: markers are the same size wherever they are on the neck. A
  // perspective view would shrink the far ones, which is the wrong trade for a
  // reader — the notes you have least time to prepare for would be smallest.
  const radii = new Set((neck?.notes ?? []).map((n) => n.r));
  recorder.check("markers are the same size near and far", radii.size === 1, JSON.stringify([...radii]));

  // Evenly spaced strings are what make this a parallel projection rather than a
  // drawing of one. Measured on the string lines, all of which start at the same
  // moment: an earlier version compared the notes, whose x carries how far ahead
  // they are as well as which string they are on, so it was comparing two things
  // at once and no spacing would ever have satisfied it.
  const gaps = (neck?.strings ?? []).slice(1).map((s, i) => s.nearX - neck.strings[i].nearX);
  recorder.check(
    "strings are evenly spaced across the neck",
    gaps.length === 5 && gaps.every((gsize) => gsize > 0 && Math.abs(gsize - gaps[0]) <= 1),
    JSON.stringify(gaps),
  );
  // And the neck recedes: the far end of each string is further along than the
  // near end, in the same direction for all six.
  recorder.check(
    "every string runs up the neck in the same direction",
    (neck?.strings ?? []).every((str) => str.farX > str.nearX),
    JSON.stringify((neck?.strings ?? []).map((str) => `${str.nearX}->${str.farX}`)),
  );

  // The whole neck is inside the panel. The first version fixed the depth at
  // 150px per second, which projected everything past the second bar off the top
  // of a short panel and drew two notes out of nine.
  recorder.check(
    "the neck is drawn inside the panel rather than off its edges",
    (neck?.notes ?? []).every(
      (n) => n.x > 0 && n.x < (neck?.width ?? 0) && n.y > 0 && n.y < (neck?.height ?? 0),
    ),
    JSON.stringify((neck?.notes ?? []).map((n) => `${n.x},${n.y}`)),
  );
  recorder.check(
    "and it uses the space it is given",
    (neck?.width ?? 0) > 600 && (neck?.height ?? 0) > 300,
    `${neck?.width}x${neck?.height}`,
  );

  // Playback moves the music toward the strike line. This is the claim that the
  // reader follows the clock at all.
  // Sampled repeatedly through the first couple of seconds rather than twice, so
  // the approach is measured while the note is still ahead of the line: fret 12 is
  // the last of the riff and reaches the strike line about a second and a half in.
  const samples = [];
  await page.keyboard.press("Space");
  for (let i = 0; i < 8; i += 1) {
    await page.waitForTimeout(250);
    samples.push(await readNeck(page));
  }
  await page.keyboard.press("Space");
  await page.waitForTimeout(500);

  const twelveTrack = samples
    .map((snap) => snap?.notes.find((n) => n.fret === 12)?.x)
    .filter((x) => typeof x === "number");
  recorder.check(
    "notes approach the strike line as playback advances",
    twelveTrack.length >= 3 && twelveTrack.every((x, i) => i === 0 || x <= twelveTrack[i - 1]) &&
      twelveTrack[twelveTrack.length - 1] < twelveTrack[0],
    JSON.stringify(twelveTrack),
  );
  recorder.check(
    "a note is lit while it is the one sounding",
    samples.some((snap) => (snap?.notes ?? []).some((n) => n.lit)),
    JSON.stringify(samples.map((snap) => (snap?.notes ?? []).filter((n) => n.lit).map((n) => n.fret))),
  );
  recorder.check(
    "never more than a chord's worth lit at once",
    samples.every((snap) => (snap?.notes ?? []).filter((n) => n.lit).length <= 6),
  );

  // Toggling off restores the score. alphaTab's host stays mounted underneath the
  // whole time, so this must not cost a reload — the engraved music has to be
  // there immediately, with the notes still in it.
  await page.getByRole("button", { name: "FRETBOARD", exact: true }).click();
  await page.waitForTimeout(700);
  recorder.check("turning it off removes the reader", (await page.locator(".iso-surface").count()) === 0);
  recorder.check(
    "the engraved score is still there, not reloading",
    (await scoreText(page)).includes("12"),
  );

  // It resizes with the window rather than scaling a fixed viewBox, because a
  // neck whose strings converge on a phone is the one thing this view cannot do.
  await page.getByRole("button", { name: "FRETBOARD", exact: true }).click();
  await page.waitForTimeout(900);
  const wide = await readNeck(page);
  await page.setViewportSize({ width: 720, height: 900 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await page.waitForTimeout(900);
  const narrow = await readNeck(page);
  recorder.check(
    "the reader is narrower on a narrow window",
    (narrow?.width ?? 0) < (wide?.width ?? 0),
    `${wide?.width} -> ${narrow?.width}`,
  );
  const narrowGaps = (narrow?.strings ?? []).slice(1).map((str, i) => str.nearX - narrow.strings[i].nearX);
  recorder.check(
    "and the strings stay far enough apart to tell apart",
    narrowGaps.length === 5 && narrowGaps.every((gsize) => gsize >= 14),
    JSON.stringify(narrowGaps),
  );
  recorder.check(
    "the neck still fits inside the narrow panel",
    (narrow?.notes ?? []).every(
      (n) => n.x > 0 && n.x < (narrow?.width ?? 0) && n.y > 0 && n.y < (narrow?.height ?? 0),
    ),
    `${narrow?.width}x${narrow?.height} ${JSON.stringify((narrow?.notes ?? []).map((n) => `${n.x},${n.y}`))}`,
  );
}
