/**
 * Imported staves that have no strings — a piano or vocal part.
 *
 * They are carried pitch-exact (fixtures/09-pitched-staff.altex round-trips
 * exactly in the corpus suite), which makes them look editable. They are not:
 * fret entry needs a tuning to turn a digit into a pitch, and there is none, so
 * every keystroke used to append a stray middle C to the user's imported part —
 * and autosave wrote it down. This suite pins the guard, and pins that the guard
 * is selective rather than a blanket break of note entry.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appReady, newDevice, openPalette, scoreText, withLibrary } from "../harness.mjs";

export const name = "pitched-staff";

const fixture = (name) =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", name);
const FIXTURE = fixture("09-pitched-staff.altex");
const PERCUSSION_ONLY = fixture("10-percussion-only.altex");

const RAIL = 'nav[aria-label="Tracks"]';

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "pitched", { width: 1500, height: 1100 });
  const settle = (ms = 900) => page.waitForTimeout(ms);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);

  await page.setInputFiles('input[type="file"]', FIXTURE);
  await settle(3500);
  const listing = await withLibrary(page, (aside) => aside.innerText());
  recorder.check("the import is in the library", listing.includes("Pitched Staff"), listing.slice(0, 120));

  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await settle(2500);
  recorder.equal(
    "all three staves are carried into the editor",
    await page.locator(`${RAIL} button[aria-label^="Track "]`).count(),
    3,
  );
  // The importer used to report a pitched staff as something the conversion
  // could not carry, which the banner presents as "absent from the editable
  // version". It is present, so that claim must not appear.
  const body = await page.locator("body").innerText();
  recorder.check(
    "a carried staff is not reported as lost",
    !body.includes("pitched staff"),
    body.slice(0, 200),
  );

  // The piano staff must refuse fret entry rather than inventing notes.
  await page.locator(`${RAIL} button[aria-label^="Track 2"]`).click();
  await settle(1400);
  recorder.check(
    "the caret is on the piano staff",
    ((await page.locator(`${RAIL} button[aria-current="true"]`).getAttribute("aria-label")) ?? "").includes("Piano"),
  );
  // A staff with no strings is no longer read-only: the number row enters scale degrees of
  // the bar's key there. What it must never do is enter a *fret* — the old behaviour was a
  // stray middle C appended per keystroke, because pitchAt had no tuning and answered the
  // same pitch every time while the note carried a string the existing notes did not.
  recorder.check(
    "the degree strip is shown for a staff with no strings",
    (await page.locator("[data-degree-strip]").count()) === 1,
  );
  const readoutPiano = await page.locator("text=/^bar \\d+ · beat/").first().innerText().catch(() => "");
  recorder.check(
    "the caret readout names a pitch rather than a string",
    /[A-G]#?b?\d/.test(readoutPiano) && !/string/.test(readoutPiano),
    readoutPiano,
  );

  // Degree 5 of the key, in the caret's own octave. The strip states which pitch that is,
  // so this is asserted against the app's own claim rather than against a hard-coded note.
  const degreePitch = async (degree) =>
    page.locator(`[data-degree="${degree}"]`).getAttribute("data-degree-pitch");
  const fifth = await degreePitch(5);
  await page.keyboard.press("Digit5");
  await settle(1800);
  recorder.equal(
    "typing 5 puts the dominant on the staff",
    await page.locator('[data-degree="5"]').getAttribute("data-degree-on"),
    "true",
  );
  recorder.check(
    "and the caret moved to that degree",
    (await page.locator('[data-degree="5"]').getAttribute("data-degree-caret")) === "true",
    `fifth is ${fifth}`,
  );

  // The octave is the caret's own, so the same digit writes a different pitch after the
  // arrows have moved. Seven rows is exactly one octave.
  const lowFifth = await degreePitch(5);
  for (let i = 0; i < 7; i += 1) await page.keyboard.press("ArrowUp");
  await settle(900);
  const highFifth = await degreePitch(5);
  recorder.check(
    "moving up seven rows moves the degrees an octave",
    highFifth !== lowFifth && highFifth?.slice(0, -1) === lowFifth?.slice(0, -1),
    `${lowFifth} -> ${highFifth}`,
  );
  recorder.equal(
    "the degree there is not sounding yet",
    await page.locator('[data-degree="5"]').getAttribute("data-degree-on"),
    "false",
  );
  await page.keyboard.press("Digit5");
  await settle(1700);
  recorder.check(
    "and typing 5 writes the fifth of the caret's octave, not of the bottom one",
    // Pinned to the pitch, not to the strip's relative view: entry also moves the caret,
    // so a version that wrote the bottom octave would drag the strip down with it and
    // every relative check would agree with itself.
    (await page.locator('[data-degree="5"]').getAttribute("data-degree-on")) === "true" &&
      (await degreePitch(5)) === highFifth,
    `${await degreePitch(5)} expected ${highFifth}`,
  );
  for (let i = 0; i < 7; i += 1) await page.keyboard.press("ArrowDown");
  await settle(900);

  // A row is one voice of the beat, so the same row twice is a replacement, not a chord —
  // while a *different* degree is a chord, which is the whole point of a pitched staff.
  // Counted by removing one and checking nothing is left: a boolean "is it sounding" reads
  // the same for one note and for two stacked at the same pitch, so it cannot see this.
  await page.keyboard.press("Digit5");
  await settle(1500);
  await page.keyboard.press("Digit5");
  await settle(1500);
  await page.keyboard.press("Delete");
  await settle(1500);
  recorder.equal(
    "typing the same degree twice leaves one note, not two stacked",
    await page.locator('[data-degree="5"]').getAttribute("data-degree-on"),
    "false",
  );
  await page.keyboard.press("Digit5");
  await settle(1500);
  await page.keyboard.press("Digit3");
  await settle(1600);
  const chord = await page.$$eval('[data-degree-on="true"]', (els) => els.map((el) => el.getAttribute("data-degree")));
  recorder.check(
    "a second degree builds a chord rather than replacing the first",
    chord.includes("3") && chord.includes("5"),
    JSON.stringify(chord),
  );

  // Delete had no way to find a note on this staff either, for the same reason.
  await page.keyboard.press("Delete");
  await settle(1500);
  const afterDelete = await page.$$eval('[data-degree-on="true"]', (els) => els.map((el) => el.getAttribute("data-degree")));
  recorder.check(
    "Delete removes the note at the caret's degree",
    !afterDelete.includes("3") && afterDelete.includes("5"),
    JSON.stringify(afterDelete),
  );

  // Undo everything typed here, so the reload check below still measures an untouched
  // piano staff — its whole purpose is to prove nothing was invented on it.
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press("Control+z");
    await settle(700);
  }
  await settle(1200);

  // And the guard is selective: the same keystroke on the guitar staff works.
  await page.locator(`${RAIL} button[aria-label^="Track 1"]`).click();
  await settle(1400);
  const beforeGuitar = await scoreText(page);
  await page.keyboard.press("Digit9");
  await settle(2000);
  recorder.check(
    "the same keystroke still works on a fretted staff",
    (await scoreText(page)) !== beforeGuitar,
  );
  recorder.check("the entered fret is the one typed", (await page.locator("text=/fret 9/").count()) === 1);

  // What autosave committed is what a reload shows, so the reload is where it is
  // provable that nothing was invented. Counting note heads on the piano staff is
  // the check that can actually fail: asserting the guitar's 9 survived says
  // nothing about the piano at all.
  const pianoNoteCount = () =>
    page.evaluate(() => {
      // The second staff group in document order is the piano; its note heads are
      // the glyphs alphaTab draws inside it.
      const systems = Array.from(document.querySelectorAll(".at-surface svg"));
      const tallest = systems.sort(
        (a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height,
      )[0];
      return tallest ? tallest.querySelectorAll("path, use").length : -1;
    });

  const glyphsBefore = await pianoNoteCount();
  await settle(2200);
  await page.reload({ waitUntil: "networkidle" });
  await appReady(page);
  await settle(1800);
  recorder.check("the guitar edit survived the reload", (await scoreText(page)).includes("9"));
  recorder.equal(
    "the reload added no glyphs, so nothing was invented and saved",
    await pianoNoteCount(),
    glyphsBefore,
  );

  // A drum-only file. This used to be the "nothing editable" case: percussion was
  // carried by the model but the notation serializer could not write it, so a drum-only
  // score serialized to nothing and the writer substituted a default guitar track —
  // offering EDIT would have handed the user a blank staff where their music had been.
  // The serializer writes drum voices by name now (packages/core/src/percussion.ts), so
  // this is an ordinary editable score and the check is that EDIT is offered rather than
  // withheld.
  await page.setInputFiles('input[type="file"]', PERCUSSION_ONLY);
  await settle(4000);
  recorder.check(
    "the drum file plays",
    (await page.locator(".at-surface svg").count()) > 0 &&
      (await page.locator("header").innerText()).includes("Percussion Only"),
  );
  recorder.equal(
    "editing is offered for a drum-only file",
    await page.getByRole("button", { name: "EDIT", exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await settle(3000);
  // The real claim: the kit is on screen as notation, not a blank guitar staff standing
  // in for it. A substituted default track is what this whole case exists to catch, and
  // it would show as an empty staff with a tuning rather than a drum clef.
  const drumStaff = await scoreText(page);
  recorder.check(
    "and the kit is engraved rather than replaced by a blank staff",
    (await page.locator(".at-surface svg").count()) > 0 && !/Guitar/i.test(drumStaff),
    drumStaff.slice(0, 120),
  );
  const notice = await page.locator("body").innerText();
  recorder.check(
    "no stale warning claims drum notation cannot be edited",
    !/drum notation is not editable/.test(notice),
    (notice.match(/drum[^\n]*/) ?? ["no drum notice"])[0],
  );

  // Drum entry. The number row means kit voices here rather than frets, and the strip is
  // what makes that discoverable at all: a drum staff has no frets to make the digits
  // self-evident the way a guitar staff does.
  recorder.check("the kit strip is shown for a drum staff", (await page.locator("[data-drum-kit]").count()) === 1);
  // The readout used to say "string 4 · fret undefined" over a hi-hat, on a staff that has
  // neither strings nor frets.
  const readout = await page.locator("text=/^bar \\d+ · beat/").first().innerText().catch(() => "");
  recorder.check(
    "the caret readout names a drum rather than a string and a fret",
    !/string/.test(readout) && !/fret/.test(readout),
    readout,
  );
  const slots = await page.locator("[data-drum-slot]").count();
  recorder.equal("with one slot per kit voice", slots, 10);

  const soundingNow = () =>
    page.$$eval('[data-drum-on="true"]', (els) => els.map((el) => el.getAttribute("data-drum-slot")));

  // The fixture's first beat is a kick, and the strip reads the beat rather than only the
  // keyboard, so it says so before anything is typed.
  recorder.check(
    "the strip shows what the caret's beat already sounds",
    (await soundingNow()).includes("Kick"),
    JSON.stringify(await soundingNow()),
  );

  await page.keyboard.press("Digit2");
  await settle(1600);
  recorder.check("2 enters a snare", (await soundingNow()).includes("Snare"), JSON.stringify(await soundingNow()));
  recorder.check(
    "and the caret follows the key it was entered with",
    (await page.locator('[data-drum-slot="Snare"]').getAttribute("data-drum-caret")) === "true",
  );

  await page.keyboard.press("Digit4");
  await settle(1600);
  const both = await soundingNow();
  recorder.check(
    "a second voice joins the beat rather than replacing it",
    both.includes("Snare") && both.includes("HH closed"),
    JSON.stringify(both),
  );

  // The rule a drum editor lives by: one voice per beat, and the same key takes it back.
  // `note.insert` appends for a note with no string, so without the toggle this would be
  // two snares on one beat, played twice as loud and impossible to see.
  await page.keyboard.press("Digit2");
  await settle(1600);
  const afterToggle = await soundingNow();
  recorder.check(
    "pressing the same key again removes that voice",
    !afterToggle.includes("Snare") && afterToggle.includes("HH closed"),
    JSON.stringify(afterToggle),
  );

  // Delete matched on string, which a drum note does not have, so it did nothing at all.
  await page.keyboard.press("Digit0");
  await settle(1400);
  recorder.check("0 is the tenth slot, not the zeroth", (await soundingNow()).includes("Crash"));
  await page.keyboard.press("Delete");
  await settle(1400);
  recorder.check(
    "Delete removes the voice at the caret",
    !(await soundingNow()).includes("Crash"),
    JSON.stringify(await soundingNow()),
  );

  // The caret runs the kit here, not six imaginary strings, and up means up: the crash is
  // the top of a drum staff and the kick the bottom. Both were wrong at once — the range
  // was a hard-coded six, so the top four voices did not exist, and the direction was
  // inherited from a fretboard where string 1 is the highest, so ArrowUp walked downwards.
  for (let i = 0; i < 12; i += 1) await page.keyboard.press("ArrowUp");
  await settle(800);
  recorder.check(
    "ArrowUp reaches the top of the kit",
    (await page.locator('[data-drum-slot="Crash"]').getAttribute("data-drum-caret")) === "true",
  );
  for (let i = 0; i < 12; i += 1) await page.keyboard.press("ArrowDown");
  await settle(800);
  recorder.check(
    "and ArrowDown reaches the kick at the bottom",
    (await page.locator('[data-drum-slot="Kick"]').getAttribute("data-drum-caret")) === "true",
  );

  // And it is a real edit: on a beat with nothing in it, a keystroke puts a drum there,
  // the engraving carries it, and one undo takes it back.
  await page.keyboard.press("ArrowRight");
  await settle(900);
  // Measured against whatever this beat already holds rather than against an assumption
  // about the fixture: the pattern is a real one, so no beat is empty, and an earlier
  // version of this check asserted otherwise and failed for that reason alone.
  const before = (await soundingNow()).sort();
  await page.keyboard.press("Digit5");
  await settle(1800);
  const after = (await soundingNow()).sort();
  recorder.check(
    "a voice the beat lacked is added to it, leaving the rest alone",
    after.includes("HH open") && before.every((v) => after.includes(v)) && after.length === before.length + 1,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );
  const engraved = await page.locator(".at-surface svg").count();
  recorder.check("the drum staff is still engraved after editing", engraved > 0, `${engraved} svg`);
  await page.keyboard.press("Control+z");
  await settle(1600);
  recorder.check(
    "and one undo puts the beat back exactly as it was",
    JSON.stringify((await soundingNow()).sort()) === JSON.stringify(before),
    `${JSON.stringify(await soundingNow())} vs ${JSON.stringify(before)}`,
  );

  // Articulations matched the caret on its string too, so an accent on a drum staff did
  // nothing at all — and an accented backbeat is about as ordinary as drum writing gets.
  // HH open, which this fixture never uses, so the voice is certainly added rather than
  // toggled away and the caret certainly lands on a note. Pressing 2 here removed the
  // fixture's own snare instead, which left nothing at the caret and the buttons disabled.
  await page.keyboard.press("Digit5");
  await settle(1500);
  recorder.check(
    "the articulation controls are live on a drum note",
    await page.getByRole("button", { name: "More articulations" }).isEnabled(),
  );
  // Accent lives behind MORE, not in the primary row.
  const openMore = async () => {
    await page.getByRole("button", { name: "More articulations" }).click();
    await settle(400);
  };
  await openMore();
  const accent = page.getByRole("button", { name: "Accent", exact: true });
  recorder.equal("the accent is not set yet", await accent.getAttribute("aria-pressed"), "false");
  await accent.click();
  await settle(1800);
  // Asserted on the model rather than the engraving: an accent is a glyph, so the SVG's
  // text content is identical either way and an earlier version of this check compared
  // exactly that and could never fail. `aria-pressed` is read back off the note.
  await openMore();
  recorder.equal(
    "the accent is on the drum note",
    await page.getByRole("button", { name: "Accent", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "Accent", exact: true }).click();
  await settle(1500);
  await openMore();
  recorder.equal(
    "and clicking again takes it off",
    await page.getByRole("button", { name: "Accent", exact: true }).getAttribute("aria-pressed"),
    "false",
  );

  // The fretboard reader can show a pitched staff, because fingering one is exactly
  // the problem @cubscore/core's `fingerSequence` solves: pitches in, playable
  // positions out. That is the user-visible payoff of extracting it — a piano part
  // you can see where to put your hands for, on a staff that cannot be typed into.
  //
  // Re-imported first: the drum-file case above leaves a document with no editable
  // track, so an earlier version of this section quietly did nothing at all.
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await settle(4000);
  await page.getByRole("button", { name: "EDIT", exact: true }).click();
  await settle(2500);
  await page.locator(`${RAIL} button[aria-label^="Track 2"]`).click();
  await settle(1200);
  recorder.check(
    "back on the piano staff",
    ((await page.locator(`${RAIL} button[aria-current="true"]`).getAttribute("aria-label")) ?? "").includes("Piano"),
  );

  await page.getByRole("button", { name: "FRETBOARD", exact: true }).click();
  await settle(1800);
  const placed = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-iso-note]")).map((el) => ({
      fret: Number(el.getAttribute("data-iso-note")),
      string: Number(el.getAttribute("data-iso-note-string")),
    })),
  );
  recorder.check(
    "a staff with no fingering of its own is still placed on the neck",
    placed.length > 0,
    JSON.stringify(placed),
  );
  recorder.check(
    "every inferred position is on a real string at a real fret",
    placed.length > 0 && placed.every((p) => p.string >= 1 && p.string <= 6 && p.fret >= 0 && p.fret <= 24),
    JSON.stringify(placed),
  );
  // The hand stays put. Choosing each note's lowest playable position independently
  // — the rule this replaced — spreads a phrase across the whole neck.
  const frets = placed.filter((p) => p.fret > 0).map((p) => p.fret);
  const span = frets.length > 1 ? Math.max(...frets) - Math.min(...frets) : 0;
  recorder.check(
    "and they sit within a hand's reach rather than across the neck",
    span <= 9,
    `span ${span} across ${JSON.stringify(frets)}`,
  );

  // Arranging the pitched staff for guitar. This is the payoff of the fingering solver as
  // a *feature* rather than a capability: a staff with no strings gets some, and because
  // it is an op batch the whole thing is one undo step.
  const railLabel = async () =>
    (await page.locator(`${RAIL} button[aria-current="true"]`).getAttribute("aria-label")) ?? "";
  recorder.check("still on the piano staff before arranging", (await railLabel()).includes("Piano"));

  await openPalette(page);
  await page.keyboard.type("Arrange this staff for guitar");
  await settle(700);
  await page.keyboard.press("Enter");
  await settle(3000);

  // Fret entry is the test that the staff really became a fretted one: it was
  // refused above precisely because there was no tuning to turn a digit into a
  // pitch, and it must work now.
  const beforeTyping = await scoreText(page);
  await page.keyboard.press("Digit4");
  await settle(2000);
  recorder.check(
    "the arranged staff accepts fret entry, which it refused before",
    (await scoreText(page)) !== beforeTyping,
    (await scoreText(page)).slice(0, 90),
  );
  recorder.check(
    "and the status line reports a fret, so the caret is on a string",
    (await page.locator("text=/fret 4/").count()) === 1,
  );
  recorder.check(
    "the arrangement said what it did",
    (await page.locator("text=/Every note placed|Transposed|could not be reached/").count()) >= 1,
    (await page.locator("body").innerText()).match(/[^\n]*(placed|Transposed)[^\n]*/)?.[0] ?? "no report",
  );

  // One undo takes the whole arrangement back, including the fret just typed being
  // a separate step before it.
  await page.keyboard.press("Control+z");
  await settle(1500);
  await page.keyboard.press("Control+z");
  await settle(2500);
  // The staff is pitched again, which used to be the same thing as read-only and is not
  // any more: the number row goes back to meaning a scale degree rather than a fret. The
  // readout is what says which, so it is what this asserts.
  recorder.check(
    "the degree strip is back, so the staff is pitched again",
    (await page.locator("[data-degree-strip]").count()) === 1,
  );
  await page.keyboard.press("Digit5");
  await settle(2000);
  const undoneReadout = await page.locator("text=/^bar \\d+ · beat/").first().innerText().catch(() => "");
  recorder.check(
    "and a digit enters a pitch there, not a fret",
    /[A-G]#?b?\d/.test(undoneReadout) && !/fret/.test(undoneReadout),
    undoneReadout,
  );
}
