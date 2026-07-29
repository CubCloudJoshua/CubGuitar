/**
 * Two people, one browser profile — a school lab, a band's laptop, a library
 * computer. Signing out left the whole local library in place, so the next
 * person to sign in saw someone else's scores and pushed them into their own
 * cloud account the first time they hit SYNC. Entries are owned now; this
 * proves it, and proves the owner still gets their work back.
 */
import { appReady, newDevice, withLibrary } from "../harness.mjs";

export const name = "shared-device";

/** How many entries the library drawer reports. */
async function count(page) {
  return withLibrary(page, (aside) =>
    aside.innerText().then((t) => Number(t.match(/LIBRARY \((\d+)\)/)?.[1] ?? -1)),
  );
}

/** Idempotent: the header button toggles, so clicking blindly can close it. */
async function openAccountPanel(page) {
  if ((await page.locator("text=ACCOUNT").count()) > 0) return;
  await page.getByRole("button", { name: /^(SIGN IN|E2E)/ }).first().click();
  await page.waitForSelector("text=ACCOUNT", { timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function submitAccount(page, email, password, action) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  if (action === "register") {
    await page.getByRole("button", { name: "CREATE ACCOUNT" }).click();
  } else {
    await page.getByRole("button", { name: "SIGN IN", exact: true }).last().click();
  }
  await page.waitForSelector("text=SYNC LIBRARY", { timeout: 20_000 });
  await page.waitForTimeout(900);
}

export async function run({ browser, baseUrl, recorder }) {
  const stamp = Date.now();
  const alice = `e2e+alice${stamp}@cubscore.test`;
  const bob = `e2e+bob${stamp}@cubscore.test`;
  const password = "grizzly-mountain-9";

  const { page } = await newDevice(browser, recorder, "shared", { width: 1400, height: 1100 });
  const settle = (ms = 900) => page.waitForTimeout(ms);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(page);

  // Alice signs in. The demo she was already given becomes hers rather than
  // disappearing, which is the whole reason sign-out does not just wipe the
  // library.
  const beforeSignIn = await count(page);
  recorder.check("a signed-out visitor gets a seeded library", beforeSignIn >= 1, String(beforeSignIn));
  await openAccountPanel(page);
  await submitAccount(page, alice, password, "register");
  recorder.equal("signing in adopts work done while signed out", await count(page), beforeSignIn);

  // Alice writes something of her own, then leaves.
  await page.getByRole("button", { name: "NEW", exact: true }).click();
  await settle(1200);
  await page.keyboard.press("Digit7");
  await settle(2500);
  await page.getByRole("button", { name: "PLAYER", exact: true }).click();
  await settle(1200);
  const aliceCount = await count(page);
  recorder.equal("Alice's new score is in her library", aliceCount, beforeSignIn + 1);

  await openAccountPanel(page);
  await page.getByRole("button", { name: "SIGN OUT" }).click();
  await settle(1600);
  recorder.equal("signing out takes the library with it", await count(page), 0);

  // Bob registers on the same machine. Alice's scores must not be here.
  await submitAccount(page, bob, password, "register");
  const bobCount = await count(page);
  recorder.equal("Bob does not inherit Alice's library", bobCount, 0);

  // And the sync must not carry them into Bob's cloud account.
  await page.getByRole("button", { name: "SYNC LIBRARY" }).click();
  await page.waitForSelector("text=/synced: /", { timeout: 25_000 });
  const syncText = (await page.locator("text=/synced: /").textContent()) ?? "";
  recorder.check("Bob's sync pushes nothing of Alice's", /synced: 0 pushed/.test(syncText), syncText);

  // A tab that was open before the account changed must not sync. The library's
  // owner is per-tab module state while the session cookie is per-profile, so an
  // older tab believes it belongs to whoever was signed in when it loaded while
  // its requests carry the current account's session — and a sync from it pushed
  // one person's scores into the other's cloud library.
  const stale = await page.context().newPage();
  recorder.watch?.(stale, "stale-tab");
  await stale.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(stale);
  // The tab loaded as Bob. Alice signs in in the original tab, which leaves the
  // stale tab holding Bob's owner and Alice's cookie.
  await openAccountPanel(page);
  await page.getByRole("button", { name: "SIGN OUT" }).click();
  await settle(1400);
  await submitAccount(page, alice, password, "login");

  await openAccountPanel(stale);
  await stale.getByRole("button", { name: "SYNC LIBRARY" }).click();
  await stale.waitForTimeout(4000);
  const staleResult = await stale.locator("aside, body").first().innerText();
  recorder.check(
    "a stale tab refuses to sync across an account change",
    /different account is signed in/.test(staleResult),
    (staleResult.match(/synced:[^\n]*|different account[^\n]*/) ?? ["no message"])[0],
  );
  await stale.close();
  await settle(800);

  // Alice's library is untouched by that attempt.
  recorder.equal("the refused sync changed nothing locally", await count(page), aliceCount);

  // Alice comes back to the same machine and finds her work.
  await openAccountPanel(page);
  await page.getByRole("button", { name: "SIGN OUT" }).click();
  await settle(1400);
  await submitAccount(page, alice, password, "login");
  recorder.equal("Alice's library returns when she signs back in", await count(page), aliceCount);

  // Including across a reload, which is where a signed-in user used to be
  // shown an empty library for a moment and handed a second demo score.
  await page.reload({ waitUntil: "networkidle" });
  await appReady(page);
  await settle(1200);
  recorder.equal("a reload neither loses entries nor seeds a duplicate demo", await count(page), aliceCount);
}
