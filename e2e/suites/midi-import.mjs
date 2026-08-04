/**
 * MIDI import, in the real app.
 *
 * The unit tests grade the importer against our own MIDI writer with no browser. What
 * this adds is the half that cannot be unit-tested: that the file picker accepts a
 * `.mid`, that what comes out reaches the engraver as notation rather than as a piano
 * roll, that the guesses land in the notice a user actually reads, and that it survives
 * a reload like every other import.
 *
 * The file under test is built here byte by byte rather than committed as a fixture, so
 * what is being imported is visible in the test that imports it.
 */
import { appReady, newDevice, scoreText } from "../harness.mjs";

export const name = "midi-import";

/** A minimal Standard MIDI File: one guitar track, eight quarter notes, 480 division. */
function midiFile() {
  const bytes = [];
  const u8 = (n) => bytes.push(n & 0xff);
  const u16 = (n) => {
    u8(n >> 8);
    u8(n);
  };
  const u32 = (n) => {
    u8(n >> 24);
    u8(n >> 16);
    u8(n >> 8);
    u8(n);
  };
  const ascii = (s) => {
    for (const ch of s) u8(ch.charCodeAt(0));
  };
  /** Variable-length quantity, which is how MIDI writes every delta time. */
  const vlq = (n) => {
    const parts = [n & 0x7f];
    let left = n >> 7;
    while (left > 0) {
      parts.unshift((left & 0x7f) | 0x80);
      left >>= 7;
    }
    for (const p of parts) u8(p);
  };

  const DIVISION = 480;
  const track = [];
  const t8 = (n) => track.push(n & 0xff);
  const tvlq = (n) => {
    const parts = [n & 0x7f];
    let left = n >> 7;
    while (left > 0) {
      parts.unshift((left & 0x7f) | 0x80);
      left >>= 7;
    }
    for (const p of parts) t8(p);
  };
  // Track name, so the import has a name to carry rather than one to invent.
  const label = "Riff Gtr";
  tvlq(0);
  t8(0xff);
  t8(0x03);
  tvlq(label.length);
  for (const ch of label) t8(ch.charCodeAt(0));
  // 120 BPM: 500000 microseconds per quarter.
  tvlq(0);
  t8(0xff);
  t8(0x51);
  tvlq(3);
  t8(0x07);
  t8(0xa1);
  t8(0x20);
  // 4/4.
  tvlq(0);
  t8(0xff);
  t8(0x58);
  tvlq(4);
  t8(4);
  t8(2);
  t8(24);
  t8(8);
  // Acoustic guitar (steel), program 25.
  tvlq(0);
  t8(0xc0);
  t8(25);
  // Eight quarter notes, which is two bars of 4/4 and the point of the count below:
  // four would fill one bar whether or not the file's division was rescaled, so the
  // rhythm error that matters most would not show up.
  for (const pitch of [64, 66, 67, 69, 71, 72, 74, 76]) {
    tvlq(0);
    t8(0x90);
    t8(pitch);
    t8(100);
    tvlq(DIVISION);
    t8(0x80);
    t8(pitch);
    t8(0);
  }
  tvlq(0);
  t8(0xff);
  t8(0x2f);
  tvlq(0);

  ascii("MThd");
  u32(6);
  u16(1);
  u16(1);
  u16(DIVISION);
  ascii("MTrk");
  u32(track.length);
  for (const b of track) u8(b);
  return Buffer.from(bytes);
}

export async function run({ browser, baseUrl, recorder }) {
  const { page } = await newDevice(browser, recorder, "midi-import");
  const settle = (ms = 1200) => page.waitForTimeout(ms);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);

  // A blank score first, so anything that appears can only have come from the file.
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await settle(1600);
  const before = await scoreText(page);
  recorder.check("a new score has none of the imported riff", !before.includes("12"));

  await page.setInputFiles('input[type="file"]', {
    name: "riff.mid",
    mimeType: "audio/midi",
    buffer: midiFile(),
  });
  await settle(4000);

  const imported = await scoreText(page);
  // E4 G4 B4 E5 on a standard-tuned guitar: our solver is free to choose positions, so
  // what is asserted is that notation appeared and that the part is named, not which
  // frets it picked — that choice is graded in the unit tests where it can be read.
  // Specific content, not just "more text than before": a length comparison passes on
  // any change at all, including a failure that happens to render an error somewhere.
  recorder.check("the MIDI file renders as engraved frets", /\b12\b/.test(imported), imported.slice(0, 160));
  recorder.check("with the guitar's tuning stated", imported.includes("E") && imported.includes("A"), imported.slice(0, 80));

  // The rhythm, which is the thing a MIDI importer most obviously gets wrong and the one
  // no amount of checking pitches will catch. This file states 480 ticks to the quarter
  // and we work in 960: eight quarter notes are two bars of 4/4 rescaled, and one bar of
  // eighth notes if the rescaling is skipped. This check exists because removing the
  // rescaling left every other check in this suite passing.
  const bars = (await page.locator("header").innerText()).match(/(\d+) bars/)?.[1] ?? null;
  recorder.check("eight quarter notes come in as two bars, not one", bars === "2", `${bars} bars`);
  recorder.check("the track keeps the name the file gave it", imported.includes("Riff Gtr"), imported.slice(0, 160));

  // The guesses a MIDI file forces have to reach the user, not just the report object.
  const body = await page.locator("body").innerText();
  recorder.check(
    "it says the fretted tuning was a guess",
    /tuning was guessed/i.test(body),
    body.match(/[^\n]*guessed[^\n]*/)?.[0] ?? "no notice shown",
  );

  // A file that is not MIDI must say so and leave the score alone. `parseMidi` refuses
  // it by its header, and that message is what the notice carries.
  const survives = await scoreText(page);
  await page.setInputFiles('input[type="file"]', {
    name: "nope.mid",
    mimeType: "audio/midi",
    buffer: Buffer.from("this is not a midi file at all", "utf8"),
  });
  await settle(2600);
  const afterBad = await page.locator("body").innerText();
  recorder.check(
    "a file that is not MIDI says so in words",
    /MThd|could not be read as MIDI/i.test(afterBad),
    afterBad.match(/[^\n]*(MThd|MIDI)[^\n]*/)?.[0] ?? "no notice shown",
  );
  recorder.check("and leaves the score that was open alone", (await scoreText(page)) === survives);

  // Editable, which is the whole point of importing to notation rather than to a roll.
  await page.getByRole("button", { name: "EDIT", exact: true }).click().catch(() => undefined);
  await settle(1800);
  recorder.check(
    "the imported MIDI opens in the editor",
    (await page.locator("text=/^EDIT$/").count()) === 1,
  );
  // Unconditional on purpose. Guarding this behind the check above would make it vanish
  // rather than fail on the one outcome worth catching: an import that cannot be edited.
  await page.keyboard.press("Digit9");
  await settle();
  recorder.check("and takes an edit", (await scoreText(page)).includes("9"));

  // Survives a reload, like every other import.
  await settle(1800);
  await page.reload({ waitUntil: "networkidle" });
  await appReady(page);
  await page.getByRole("button", { name: "LIBRARY", exact: true }).click();
  await settle(700);
  const rows = await page.locator("aside").innerText();
  recorder.check("the imported file is in the library", /riff/i.test(rows), rows.slice(0, 200));
}
