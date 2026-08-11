#!/usr/bin/env node
/**
 * Does the thing we would actually deploy actually run?
 *
 * Every other gate here runs the code through a dev server or a bundler. This one runs
 * the compiled artifacts — each service's `dist/server.js` under plain `node`, with the
 * environment DEPLOY.md tells an operator to set — because that is a different program
 * from the one `pnpm dev` runs, and until now nothing built it: both services' `build`
 * script was `tsc --noEmit`, so `pnpm build` proved the code compiled and produced
 * nothing to ship. Deploying meant running `tsx`, which is a devDependency and therefore
 * absent from any `pnpm install --prod`.
 *
 * What it checks, and why each one is a way a deployment breaks rather than a way the
 * code breaks:
 *
 *   1. The artifacts exist at all.
 *   2. Nothing in the compiled output imports a package that is not a production
 *      dependency. This is what makes `pnpm install --prod` safe, and a devDependency
 *      creeping into a service is invisible in dev because the whole tree is installed.
 *   3. The session cookie carries Secure when COOKIE_SECURE=1 — and does not when it is
 *      unset. Both directions, because a check that only looked for Secure would still
 *      pass if someone hard-coded it, and the flag would then be a lie an operator
 *      trusts.
 *   4. HOST actually moves the socket. It used to be hard-coded to 127.0.0.1 in the API,
 *      which cannot work in a container: the service comes up healthy and answers
 *      nobody, because a container's loopback is its own.
 *   5. The sync service completes a websocket handshake, admits a valid room and rejects
 *      an invalid one, in the compiled build.
 *   6. The web bundle has no dev origin baked into it, which would send a browser on a
 *      real domain to 127.0.0.1.
 *
 * What it deliberately does NOT check: behaviour. `pnpm e2e` covers that, against the
 * same code. This is about the packaging.
 *
 * Usage: pnpm build && pnpm deploycheck
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = path.join(ROOT, "services", "api");
const SYNC = path.join(ROOT, "services", "sync");
const WEB = path.join(ROOT, "apps", "web");

/**
 * Ports and addresses for this run.
 *
 * On loopback aliases rather than 127.0.0.1 so the check cannot collide with a
 * developer's running stack, and so there is a second address available to prove HOST
 * does something. All of 127.0.0.0/8 is local on Linux.
 */
const BIND = process.env.DEPLOY_CHECK_BIND ?? "127.0.0.2";
const OTHER = "127.0.0.3";
const API_PORT = Number(process.env.DEPLOY_CHECK_API_PORT ?? 8901);
const SYNC_PORT = Number(process.env.DEPLOY_CHECK_SYNC_PORT ?? 8902);

const checks = [];
const children = [];
let dataDir;

function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Starts a compiled service and returns the child. Own process group, so cleanup works. */
function start(cwd, env) {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stderr.on("data", (d) => {
    const text = String(d);
    // Worth surfacing: a compiled service that dies on boot fails every check below
    // with a connection error, and the reason is only ever in here.
    if (/error|Error|ERR_/.test(text)) process.stderr.write(`  [${path.basename(cwd)}] ${text}`);
  });
  children.push(child);
  return child;
}

async function stopAll() {
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  children.length = 0;
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(host, port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (answer) => {
        socket.destroy();
        resolve(answer);
      };
      socket.setTimeout(800);
      socket.on("connect", () => done(true));
      socket.on("timeout", () => done(false));
      socket.on("error", () => done(false));
    });
    if (open) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Bare package names imported by a compiled bundle.
 *
 * A regex over emitted JS rather than a parse, which is enough here because tsc emits
 * import statements verbatim at the top of each file and nothing in these services
 * builds a specifier at runtime. Relative paths and node: builtins are not packages.
 */
function importedPackages(distDir) {
  const found = new Set();
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = readFileSync(path.join(distDir, entry.name), "utf8");
    for (const m of source.matchAll(/(?:^|\n)\s*(?:import[^'"]*?|export[^'"]*?)from\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      // @scope/name keeps two segments; anything else keeps one.
      found.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  }
  return found;
}

/**
 * One websocket request, by hand.
 *
 * `ws` is a dependency of the sync service, not of the repo root, and adding it here to
 * test it would mean the test and the subject shared an installation. A raw handshake
 * needs about forty lines and proves more: the exact bytes a browser sends.
 */
function wsOpen(host, port, query) {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString("base64");
    const expect = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let handshake = null;
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(8000);
    socket.on("timeout", () => done({ ok: false, why: "timeout" }));
    socket.on("error", (e) => done({ ok: false, why: e.code ?? String(e) }));
    socket.on("connect", () => {
      socket.write(
        `GET /ws?${query} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (handshake === null) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        handshake = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/.test(handshake)) return done({ ok: false, why: handshake.split("\r\n")[0] });
        if (!handshake.includes(expect)) return done({ ok: false, why: "wrong Sec-WebSocket-Accept" });
      }
      // One server frame: unmasked, opcode 1 (text) or 8 (close). Only the two length
      // forms a message this small can use are handled.
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      if (opcode === 8) {
        return done({ ok: true, closed: true, code: length >= 2 ? payload.readUInt16BE(0) : 0 });
      }
      done({ ok: true, closed: false, text: payload.toString("utf8") });
    });
  });
}

async function main() {
  // ---------- 1. artifacts ----------
  const artifacts = [
    [path.join(API, "dist", "server.js"), "services/api/dist/server.js"],
    [path.join(SYNC, "dist", "server.js"), "services/sync/dist/server.js"],
    [path.join(WEB, "dist", "index.html"), "apps/web/dist/index.html"],
  ];
  const missing = artifacts.filter(([p]) => !existsSync(p)).map(([, label]) => label);
  check("the deployable artifacts exist", missing.length === 0, missing.join(", "));
  if (missing.length > 0) {
    console.error("\nRun `pnpm build` first.");
    return false;
  }

  // ---------- 2. production dependencies only ----------
  for (const [dir, label] of [
    [API, "api"],
    [SYNC, "sync"],
  ]) {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const allowed = new Set(Object.keys(manifest.dependencies ?? {}));
    const used = importedPackages(path.join(dir, "dist"));
    const strays = [...used].filter((name) => !allowed.has(name));
    check(
      `${label}: compiled output imports only production dependencies`,
      strays.length === 0,
      strays.length > 0 ? `not in dependencies: ${strays.join(", ")}` : `${[...used].join(", ") || "none"}`,
    );
  }

  // ---------- 3 & 4. the API as an operator runs it ----------
  dataDir = await mkdtemp(path.join(tmpdir(), "cubscore-deploy-"));
  start(API, {
    PORT: String(API_PORT),
    HOST: BIND,
    CUBSCORE_DATA: path.join(dataDir, "secure"),
    COOKIE_SECURE: "1",
    TRUST_PROXY: "1",
  });
  const up = await waitForPort(BIND, API_PORT);
  check(`the compiled API listens on HOST (${BIND}:${API_PORT})`, up);
  if (!up) return false;

  const health = await fetch(`http://${BIND}:${API_PORT}/api/health`).then(
    (r) => r.ok,
    () => false,
  );
  check("it answers /api/health", health);

  // HOST is a real bind, not a log line: nothing may answer on another loopback address.
  const leaked = await waitForPort(OTHER, API_PORT, 1500);
  check(`HOST confines the socket (nothing on ${OTHER}:${API_PORT})`, !leaked);

  const register = async (host, port, email) =>
    fetch(`http://${host}:${port}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "deploy-check-passphrase" }),
    });

  const secureReply = await register(BIND, API_PORT, "deploy-secure@example.com");
  const secureCookie = secureReply.headers.get("set-cookie") ?? "";
  check(
    "with COOKIE_SECURE=1 the session cookie is Secure, HttpOnly, SameSite=Lax",
    /Secure/.test(secureCookie) &&
      /HttpOnly/.test(secureCookie) &&
      /SameSite=Lax/.test(secureCookie) &&
      /Path=\//.test(secureCookie),
    secureCookie.replace(/=[^;]{8,}/, "=…"),
  );

  // The other direction. Without it, a hard-coded Secure would pass the check above and
  // the flag would be a promise nobody keeps.
  const plainPort = API_PORT + 10;
  start(API, {
    PORT: String(plainPort),
    HOST: BIND,
    CUBSCORE_DATA: path.join(dataDir, "plain"),
  });
  const plainUp = await waitForPort(BIND, plainPort);
  check("a second instance starts without COOKIE_SECURE", plainUp);
  if (plainUp) {
    const plainReply = await register(BIND, plainPort, "deploy-plain@example.com");
    const plainCookie = plainReply.headers.get("set-cookie") ?? "";
    check(
      "without COOKIE_SECURE the cookie is not Secure, so the flag is what controls it",
      plainCookie.length > 0 && !/Secure/.test(plainCookie),
      plainCookie.replace(/=[^;]{8,}/, "=…"),
    );
  }

  // ---------- 5. the sync service ----------
  start(SYNC, { PORT: String(SYNC_PORT), HOST: BIND });
  const syncUp = await waitForPort(BIND, SYNC_PORT);
  check(`the compiled sync service listens on HOST (${BIND}:${SYNC_PORT})`, syncUp);
  if (syncUp) {
    const admitted = await wsOpen(BIND, SYNC_PORT, "room=deploycheckroom&name=deploy");
    check(
      "a websocket handshake completes and a valid room is admitted with state",
      admitted.ok && !admitted.closed && (admitted.text ?? "").includes('"type":"state"'),
      admitted.ok ? (admitted.text ?? `closed ${admitted.code}`).slice(0, 90) : admitted.why,
    );
    const refused = await wsOpen(BIND, SYNC_PORT, "room=no");
    check(
      "and an invalid room is closed rather than joined",
      refused.ok && refused.closed && refused.code === 4000,
      refused.ok ? `close code ${refused.code}` : refused.why,
    );
  }

  // ---------- 6. the bundle carries no dev origin ----------
  const assets = path.join(WEB, "dist", "assets");
  const baked = [];
  for (const entry of readdirSync(assets, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = readFileSync(path.join(assets, entry.name), "utf8");
    const hit = source.match(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/);
    if (hit) baked.push(`${entry.name}: ${hit[0]}`);
  }
  check("the web bundle has no dev origin baked in", baked.length === 0, baked.join(", "));

  const failed = checks.filter((c) => !c.passed);
  console.log("");
  console.log(
    `${checks.length} checks: ${checks.length - failed.length} passed, ${failed.length} failed`,
  );
  return failed.length === 0;
}

let passed = false;
try {
  passed = await main();
} catch (e) {
  console.error(e instanceof Error ? e.stack : e);
} finally {
  await stopAll();
}
process.exit(passed ? 0 : 1);
