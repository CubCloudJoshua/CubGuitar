#!/usr/bin/env node
/**
 * E2E runner: builds nothing, but stands up the whole stack against the
 * existing production build and drives it in a real browser.
 *
 * Services run on isolated ports against a throwaway data directory, so a
 * developer's own stack and data are never touched. Usage:
 *
 *   pnpm build && pnpm e2e            # every suite
 *   pnpm build && pnpm e2e collab     # one or more suites by name
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "apps", "web");

const API_PORT = Number(process.env.E2E_API_PORT ?? 8797);
const SYNC_PORT = Number(process.env.E2E_SYNC_PORT ?? 8798);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4399);
const BASE_URL = `http://localhost:${WEB_PORT}/`;

const SUITES = ["editor", "tracks", "palette", "responsive", "share-save", "collab", "accounts"];

const children = [];
let dataDir;

function start(command, args, options) {
  const child = spawn(command, args, { stdio: "ignore", ...options });
  children.push(child);
  return child;
}

async function waitFor(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`);
}

const ok = (url) => fetch(url).then((r) => r.ok, () => false);

async function cleanup() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}

function report(results) {
  console.log("");
  for (const r of results) {
    const failed = r.failed.length;
    const status = r.passed ? "PASS" : "FAIL";
    console.log(
      `${status.padEnd(5)}${r.suite.padEnd(14)}${r.checks.length - failed}/${r.checks.length} checks` +
        (r.errors.length > 0 ? `, ${r.errors.length} browser error(s)` : ""),
    );
    for (const c of r.failed) {
      console.log(`        ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    for (const e of r.errors) console.log(`        ! ${e}`);
  }

  const totalChecks = results.reduce((n, r) => n + r.checks.length, 0);
  const totalFailed = results.reduce((n, r) => n + r.failed.length, 0);
  const failedSuites = results.filter((r) => !r.passed);
  console.log("");
  console.log(
    `${results.length} suites, ${totalChecks} checks: ${totalChecks - totalFailed} passed, ${totalFailed} failed` +
      `${failedSuites.length > 0 ? ` (${failedSuites.map((r) => r.suite).join(", ")} failing)` : ""}`,
  );
  return failedSuites.length === 0;
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const selected = requested.length > 0 ? requested : SUITES;
  const unknown = selected.filter((s) => !SUITES.includes(s));
  if (unknown.length > 0) {
    console.error(`unknown suite(s): ${unknown.join(", ")}\nknown: ${SUITES.join(", ")}`);
    process.exit(2);
  }

  if (!existsSync(path.join(WEB, "dist", "index.html"))) {
    console.error("apps/web/dist is missing. Run `pnpm build` first.");
    process.exit(2);
  }

  dataDir = await mkdtemp(path.join(tmpdir(), "cubscore-e2e-"));

  start("pnpm", ["dev"], {
    cwd: path.join(ROOT, "services", "api"),
    env: { ...process.env, PORT: String(API_PORT), CUBSCORE_DATA: dataDir },
  });
  start("pnpm", ["dev"], {
    cwd: path.join(ROOT, "services", "sync"),
    env: { ...process.env, PORT: String(SYNC_PORT) },
  });
  start("pnpm", ["preview", "--port", String(WEB_PORT), "--strictPort"], {
    cwd: WEB,
    env: {
      ...process.env,
      CUBSCORE_API_PORT: String(API_PORT),
      CUBSCORE_SYNC_PORT: String(SYNC_PORT),
    },
  });

  await waitFor(() => ok(`http://127.0.0.1:${API_PORT}/api/health`), "the API");
  await waitFor(() => ok(BASE_URL), "the web app");
  // Proves the preview proxy reaches the API, which several suites rely on.
  await waitFor(() => ok(`${BASE_URL}api/health`), "the API through the web proxy");

  const browser = await launchBrowser();
  const results = [];
  try {
    for (const suiteName of selected) {
      const suite = await import(`./suites/${suiteName}.mjs`);
      const { createRecorder } = await import("./harness.mjs");
      const recorder = createRecorder(suite.name ?? suiteName);
      const started = Date.now();
      try {
        await suite.run({ browser, baseUrl: BASE_URL, recorder });
      } catch (e) {
        recorder.check(`suite completed without throwing`, false, String(e).slice(0, 300));
      }
      const result = recorder.result();
      result.ms = Date.now() - started;
      results.push(result);
      console.log(`${result.passed ? "ok  " : "FAIL"} ${result.suite} (${Math.round(result.ms / 1000)}s)`);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return report(results);
}

let passed = false;
try {
  passed = await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  await cleanup();
}
process.exit(passed ? 0 : 1);
