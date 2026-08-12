/**
 * Email verification, driven through a real confirmation link.
 *
 * The link is read off disk rather than out of a mailbox: with no MAIL_COMMAND configured
 * the API's default transport writes each message under the data directory (services/api/
 * src/mail.ts), which is both what a single-machine deployment does and what makes this
 * testable without a mail server. So the suite exercises the shipping code path, not a
 * test double.
 *
 * What it has to prove, beyond "the happy path works":
 *   - the link works in a browser that is not signed in, which is the normal case, since
 *     mail is usually opened somewhere other than where the account was created;
 *   - it works exactly once, so a leaked or forwarded link is spent;
 *   - an unconfirmed account is not a broken one — the notice is a nudge, never a wall;
 *   - RESEND issues a link that also works, because a first mail that never arrives is
 *     the ordinary reason anyone touches this feature at all.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { appReady, newDevice } from "../harness.mjs";

export const name = "verify-email";

/** The newest message the API spooled, as text. */
async function newestMessage(dataDir) {
  const dir = path.join(dataDir, "mail");
  const files = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".eml")).sort();
  const latest = files.at(-1);
  return latest ? await readFile(path.join(dir, latest), "utf8") : null;
}

async function newestLink(dataDir) {
  const message = await newestMessage(dataDir);
  return message?.match(/https?:\/\/\S*\?verify=\S+/)?.[0] ?? null;
}

export async function run({ browser, baseUrl, recorder, dataDir }) {
  const email = `verify+${Date.now()}@cubscore.test`;
  const password = "spruce-ridge-launch-7";
  const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

  const a = await newDevice(browser, recorder, "signup", { width: 1400, height: 1100 });
  await a.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(a.page);

  await a.page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await a.page.getByLabel("Email").fill(email);
  await a.page.getByLabel("Password").fill(password);
  await a.page.getByRole("button", { name: "CREATE ACCOUNT" }).click();
  await a.page.waitForSelector("text=SYNC LIBRARY", { timeout: 20_000 });
  await a.page.getByRole("button", { name: "I SAVED IT", exact: true }).click();
  await settle(800);

  // The address is unconfirmed, and the panel says so without getting in the way.
  recorder.check(
    "a new account is shown as unconfirmed",
    (await a.page.locator("[data-email-unconfirmed]").count()) === 1,
  );
  const notice = await a.page.locator("[data-email-unconfirmed]").innerText().catch(() => "");
  recorder.check(
    "and the notice says the account still works",
    /works/i.test(notice) && /recovery code/i.test(notice),
    notice.slice(0, 120),
  );
  // Not a wall: the account is fully usable while unconfirmed, which is the whole
  // policy — gating function on the operator's mail configuration would let one missing
  // environment variable lock out every real user.
  recorder.check(
    "an unconfirmed account can still use its library",
    (await a.page.locator("text=SYNC LIBRARY").count()) === 1,
  );

  const message = await newestMessage(dataDir);
  recorder.check(
    "registration spooled a message to the address",
    typeof message === "string" && message.includes(`To: ${email}`),
    (message ?? "no message").slice(0, 80),
  );
  const link = await newestLink(dataDir);
  recorder.check("the message carries a confirmation link", typeof link === "string", link ?? "none");
  if (!link) return;

  // Opened in a browser with no session, which is the normal case: mail is read wherever
  // mail is read, not necessarily where the account was made. A confirmation that needed
  // the signup session would fail for most people.
  const b = await newDevice(browser, recorder, "mailreader", { width: 1200, height: 900 });
  await b.page.goto(link, { waitUntil: "networkidle" });
  await appReady(b.page);
  await b.page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await settle(900);
  recorder.check(
    "the link confirms the address from a signed-out browser",
    (await b.page.locator('[data-verify-result="ok"]').count()) === 1,
    await b.page.locator("[data-verify-result]").innerText().catch(() => "no result"),
  );
  recorder.check(
    "and the token is stripped from the address bar",
    !b.page.url().includes("verify="),
    b.page.url(),
  );

  // Single use. A link that still worked after being spent would mean a forwarded mail
  // stays live for as long as the account does. The refusal is a 400, which the browser
  // logs as a failed request, so the suite declares it rather than tripping its own gate.
  await recorder.expecting(/status of 400/, async () => {
    await b.page.goto(link, { waitUntil: "networkidle" });
    await appReady(b.page);
    await b.page.getByRole("button", { name: "SIGN IN", exact: true }).click();
    await settle(900);
  });
  recorder.check(
    "the same link cannot be used twice",
    (await b.page.locator('[data-verify-result="failed"]').count()) === 1,
    await b.page.locator("[data-verify-result]").innerText().catch(() => "no result"),
  );

  // Back on the device that signed up: the state is the server's, so it is there after a
  // reload even though the confirmation happened in another browser entirely.
  await a.page.reload({ waitUntil: "networkidle" });
  await appReady(a.page);
  await a.page.getByRole("button", { name: /SIGN IN|VERIFY\+/ }).first().click();
  await settle(900);
  recorder.check(
    "the signup browser sees the address confirmed after a reload",
    (await a.page.locator("[data-email-unconfirmed]").count()) === 0,
  );
  const verified = await a.page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.ok ? await response.json() : null;
  });
  recorder.check("the API reports the address verified", verified?.user?.emailVerified === true);
  recorder.check(
    "and reports that this deployment can verify at all",
    verified?.user?.verificationAvailable === true,
  );

  // RESEND, on a second account, because the first has nothing left to confirm. This is
  // the path anyone whose first mail went missing actually takes.
  const second = `verify2+${Date.now()}@cubscore.test`;
  const c = await newDevice(browser, recorder, "resend", { width: 1400, height: 1100 });
  await c.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(c.page);
  await c.page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await c.page.getByLabel("Email").fill(second);
  await c.page.getByLabel("Password").fill(password);
  await c.page.getByRole("button", { name: "CREATE ACCOUNT" }).click();
  await c.page.waitForSelector("text=SYNC LIBRARY", { timeout: 20_000 });
  await c.page.getByRole("button", { name: "I SAVED IT", exact: true }).click();
  await settle(800);

  const firstLink = await newestLink(dataDir);
  await c.page.locator("[data-verify-resend]").click();
  await c.page.waitForSelector('[data-verify-result="ok"]', { timeout: 15_000 });
  await settle(600);
  const resentLink = await newestLink(dataDir);
  recorder.check(
    "RESEND spools a different link",
    typeof resentLink === "string" && resentLink !== firstLink,
    `${String(firstLink).slice(-12)} -> ${String(resentLink).slice(-12)}`,
  );

  await c.page.goto(resentLink, { waitUntil: "networkidle" });
  await appReady(c.page);
  await c.page.getByRole("button", { name: /SIGN IN|VERIFY2\+/ }).first().click();
  await settle(900);
  recorder.check(
    "the resent link confirms the address",
    (await c.page.locator('[data-verify-result="ok"]').count()) === 1,
    await c.page.locator("[data-verify-result]").innerText().catch(() => "no result"),
  );

  // The superseded link is dead. Only one token is stored per account, so issuing a new
  // one has to invalidate the old — otherwise every resend leaves another live key.
  await recorder.expecting(/status of 400/, async () => {
    await c.page.goto(firstLink, { waitUntil: "networkidle" });
    await appReady(c.page);
    await c.page.getByRole("button", { name: /SIGN IN|VERIFY2\+/ }).first().click();
    await settle(900);
  });
  recorder.check(
    "and the superseded link no longer works",
    (await c.page.locator('[data-verify-result="failed"]').count()) === 1,
    await c.page.locator("[data-verify-result]").innerText().catch(() => "no result"),
  );
}
