/** Accounts, cross-device cloud sync, and share revocation. */
import { appReady, newDevice, withLibrary } from "../harness.mjs";

export const name = "accounts";

export async function run({ browser, baseUrl, recorder }) {
  const email = `e2e+${Date.now()}@cubscore.test`;
  const password = "grizzly-mountain-9";

  // Device A registers and syncs its library up.
  const a = await newDevice(browser, recorder, "deviceA", { width: 1400, height: 1100 });
  await a.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(a.page);

  await a.page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await a.page.getByLabel("Email").fill(email);
  await a.page.getByLabel("Password").fill(password);
  await a.page.getByRole("button", { name: "CREATE ACCOUNT" }).click();
  await a.page.waitForSelector("text=SYNC LIBRARY", { timeout: 20_000 });
  // Asserted against the API, not against `true`. The waitForSelector above
  // already throws if registration fails, so this used to be a hard-coded pass
  // dressed as a check — it could never fail and told a reader nothing.
  const me = await a.page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.ok ? await response.json() : null;
  });
  recorder.equal("registration signs the user in", me?.user?.email, email);
  recorder.check("header shows the account", (await a.page.locator("header").innerText()).includes("E2E+"));

  // The recovery code: shown exactly once, at signup, because there is no email reset
  // to fall back on. Captured here for the recovery flow at the end of the suite.
  const recoveryCode = await a.page
    .locator("[data-recovery-code]")
    .getAttribute("data-recovery-code")
    .catch(() => null);
  recorder.check(
    "signup shows a recovery code once",
    typeof recoveryCode === "string" && /^[-0-9A-Z]{19}$/.test(recoveryCode),
    recoveryCode ?? "none shown",
  );
  await a.page.getByRole("button", { name: "I SAVED IT", exact: true }).click();
  await a.page.waitForTimeout(300);
  recorder.check(
    "and never shows it again after dismissal",
    (await a.page.locator("[data-recovery-code]").count()) === 0,
  );

  // The session cookie is shared across tabs of the same device.
  const tab = await a.context.newPage();
  recorder.watch(tab, "deviceA-tab2");
  await tab.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(tab);
  await tab.getByRole("button", { name: /SIGN IN|E2E\+/ }).first().click();
  await tab.waitForTimeout(600);
  recorder.check("session persists across tabs", (await tab.locator("text=SYNC LIBRARY").count()) === 1);
  await tab.close();

  await a.page.getByRole("button", { name: "SYNC LIBRARY" }).click();
  await a.page.waitForSelector("text=/synced: /", { timeout: 25_000 });
  const syncA = await a.page.locator("text=/synced: /").textContent();
  recorder.check("device A pushed its library", /pushed/.test(syncA ?? ""), syncA ?? "");

  // Sharing while signed in produces an owned, listable, revocable link.
  await a.page.getByRole("button", { name: "SHARE", exact: true }).click();
  await a.page.waitForSelector('input[aria-label="Share link"]', { timeout: 20_000 });
  const shareUrl = await a.page.locator('input[aria-label="Share link"]').inputValue();
  // The panel loads shares when the user changes, so reopen it to refresh.
  await a.page.getByRole("button", { name: /E2E\+/ }).first().click();
  await a.page.getByRole("button", { name: /E2E\+/ }).first().click();
  await a.page.waitForTimeout(900);
  recorder.check("own share is listed", (await a.page.locator("text=/MY SHARE LINKS \\(1\\)/").count()) === 1);

  // Device B: cold context, signs in, pulls the score down from the cloud.
  const b = await newDevice(browser, recorder, "deviceB", { width: 1400, height: 1100 });
  await b.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(b.page);
  const beforeCount = await withLibrary(b.page, (aside) =>
    aside.innerText().then((t) => Number(t.match(/LIBRARY \((\d+)\)/)?.[1] ?? 0)),
  );
  await b.page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await b.page.getByLabel("Email").fill(email);
  await b.page.getByLabel("Password").fill(password);
  await b.page.getByRole("button", { name: "SIGN IN", exact: true }).last().click();
  await b.page.waitForSelector("text=SYNC LIBRARY", { timeout: 20_000 });
  await b.page.getByRole("button", { name: "SYNC LIBRARY" }).click();
  await b.page.waitForSelector("text=/synced: /", { timeout: 25_000 });
  await b.page.waitForTimeout(900);
  const afterCount = await withLibrary(b.page, (aside) =>
    aside.innerText().then((t) => Number(t.match(/LIBRARY \((\d+)\)/)?.[1] ?? 0)),
  );
  recorder.check(
    "device B pulled a score from the cloud",
    afterCount > beforeCount,
    `${beforeCount} -> ${afterCount}`,
  );

  // An outsider can open the share before revocation.
  const outsider = await newDevice(browser, recorder, "outsider");
  await outsider.page.goto(shareUrl, { waitUntil: "networkidle" });
  await outsider.page
    .waitForFunction(() => document.querySelectorAll(".at-surface svg").length > 0, null, { timeout: 25_000 })
    .catch(() => undefined);
  recorder.check(
    "share opens for an outsider",
    (await outsider.page.locator(".at-surface svg").count()) > 0,
  );
  await outsider.page.close();

  // Revoking kills the link.
  await a.page.getByRole("button", { name: /^Revoke /i }).click();
  await a.page.waitForTimeout(1200);
  recorder.check("share list empties after revoke", (await a.page.locator("text=/MY SHARE LINKS \\(0\\)/").count()) === 1);

  const afterRevoke = await outsider.context.newPage();
  await afterRevoke.goto(shareUrl, { waitUntil: "networkidle" });
  await afterRevoke.waitForTimeout(2200);
  recorder.check(
    "revoked link reports itself as gone",
    (await afterRevoke.locator("text=/does not exist or was removed/").count()) === 1,
  );

  // Wrong password fails honestly.
  const c = await newDevice(browser, recorder, "wrongpass");
  await c.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(c.page);
  await c.page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await c.page.getByLabel("Email").fill(email);
  await c.page.getByLabel("Password").fill("not-the-password");
  await c.page.getByRole("button", { name: "SIGN IN", exact: true }).last().click();
  await c.page.waitForTimeout(1400);
  recorder.check(
    "wrong password is rejected with a clear message",
    (await c.page.locator("text=/invalid email or password/").count()) === 1,
  );

  // Recovery: a forgotten password plus the saved code becomes a new password, on a
  // machine that has never seen this account. A wrong code fails with the same shape
  // of message as a wrong password, confirming nothing about the address.
  const newPassword = "missoula-sovereign-7";
  await c.page.locator("[data-recover-toggle]").click();
  await c.page.getByLabel("Email").fill(email);
  await c.page.getByLabel("Recovery code").fill("AAAA-AAAA-AAAA-AAAA");
  await c.page.getByLabel("New password").fill(newPassword);
  await c.page.getByRole("button", { name: "RESET PASSWORD", exact: true }).click();
  await c.page.waitForTimeout(1400);
  recorder.check(
    "a wrong recovery code is rejected",
    (await c.page.locator("text=/invalid email or recovery code/").count()) === 1,
  );

  await c.page.getByLabel("Recovery code").fill(recoveryCode ?? "");
  await c.page.getByRole("button", { name: "RESET PASSWORD", exact: true }).click();
  await c.page.waitForSelector("text=SYNC LIBRARY", { timeout: 20_000 });
  const recovered = await c.page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.ok ? await response.json() : null;
  });
  recorder.equal("the right code signs the user in", recovered?.user?.email, email);
  recorder.check(
    "and mints a fresh code, because a used code is spent",
    (await c.page.locator("[data-recovery-code]").count()) === 1 &&
      (await c.page.locator("[data-recovery-code]").getAttribute("data-recovery-code")) !== recoveryCode,
  );

  // The reset ended every other session: device A's cookie is dead, which is the
  // point — the code gets used when the password may be in someone else's hands.
  const aState = await a.page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.status;
  });
  recorder.equal("recovery signs out every other session", aState, 401);

  // And the new password is the password now.
  const d = await newDevice(browser, recorder, "newpass");
  await d.page.goto(baseUrl, { waitUntil: "networkidle" });
  await appReady(d.page);
  await d.page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await d.page.getByLabel("Email").fill(email);
  await d.page.getByLabel("Password").fill(newPassword);
  await d.page.getByRole("button", { name: "SIGN IN", exact: true }).last().click();
  await d.page.waitForSelector("text=SYNC LIBRARY", { timeout: 20_000 });
  const after = await d.page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.ok ? await response.json() : null;
  });
  recorder.equal("the new password signs in", after?.user?.email, email);
}
