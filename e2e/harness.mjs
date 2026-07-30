/**
 * Shared e2e harness.
 *
 * These suites drive the real built app in a real browser, which is how every
 * UI regression in this project has actually been caught: focus races,
 * double-committed ops, semantic elements lost in a refactor. Assertions are
 * collected rather than thrown so one failure does not hide the rest.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
/** Explicit env var, then this sandbox's browser, then playwright's own cache. */
export const CHROMIUM =
  process.env.CHROMIUM_PATH ?? (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

export function launchBrowser() {
  return chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
}

/** Console noise that is expected and not a defect. */
const IGNORED_CONSOLE = [
  /status of 401/, // signed-out /api/auth/me probe on boot
  /status of 404/, // favicon
];

/**
 * Collects checks and console/page errors for one suite. A suite fails if any
 * check is false or any unexpected browser error appeared.
 */
export function createRecorder(suiteName) {
  const checks = [];
  const errors = [];

  return {
    suiteName,
    /** Records a boolean expectation. */
    check(name, condition, detail) {
      checks.push({ name, pass: Boolean(condition), detail });
      return Boolean(condition);
    },
    /** Records an equality expectation, reporting both sides on failure. */
    equal(name, actual, expected) {
      const pass = actual === expected;
      checks.push({ name, pass, detail: pass ? undefined : `expected ${expected}, got ${actual}` });
      return pass;
    },
    /** Attaches error listeners to a page; tag distinguishes multi-page suites. */
    watch(page, tag = "page") {
      page.on("pageerror", (e) => errors.push(`${tag}: ${String(e).slice(0, 300)}`));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
        errors.push(`${tag}: ${text.slice(0, 300)}`);
      });
      return page;
    },
    result() {
      const failed = checks.filter((c) => !c.pass);
      return {
        suite: suiteName,
        passed: failed.length === 0 && errors.length === 0,
        checks,
        failed,
        errors,
      };
    },
  };
}

/** Waits until the app has booted far enough to interact with. */
export async function appReady(page, { score = true } = {}) {
  await page.waitForFunction(() => !document.querySelector("button")?.disabled, null, { timeout: 30_000 });
  if (score) {
    await page
      .waitForFunction(() => document.querySelectorAll(".at-surface svg").length > 0, null, { timeout: 30_000 })
      .catch(() => undefined);
  }
  await page.waitForTimeout(1200);
}

/** All text rendered inside the score, the ground truth for notation checks. */
export function scoreText(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".at-surface svg text"))
      .map((t) => t.textContent)
      .join(" "),
  );
}

/** The library is a drawer now; reads of it must open and close it. */
export async function withLibrary(page, fn) {
  await page.getByRole("button", { name: "LIBRARY", exact: true }).click();
  await page.waitForTimeout(600);
  try {
    return await fn(page.locator("aside"));
  } finally {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
}

/** Opens the command palette and waits for its input to hold focus. */
export async function openPalette(page) {
  await page.keyboard.press("Control+k");
  await page.waitForSelector('input[aria-label="Command search"]', { timeout: 8000 });
}

/**
 * A fresh isolated browser context: no cookies, no IndexedDB. Acts as a device.
 *
 * `permissions` is opt-in because granting them changes what is being tested:
 * the share card copies the link automatically, and whether that is allowed is
 * the browser's decision, not the app's.
 */
export async function newDevice(
  browser,
  recorder,
  tag,
  viewport = { width: 1400, height: 1000 },
  permissions = undefined,
  options = undefined,
) {
  const context = await browser.newContext({
    viewport,
    acceptDownloads: true,
    ...(permissions ? { permissions } : {}),
    ...(options ?? {}),
  });
  const page = await context.newPage();
  recorder.watch(page, tag);
  return { context, page };
}
