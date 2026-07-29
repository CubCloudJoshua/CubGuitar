/**
 * CubScore API.
 *
 * Auth:    POST /api/auth/register | login | logout, GET /api/auth/me
 * Library: GET /api/library, PUT/GET/DELETE /api/library/:id   (owner only)
 * Shares:  POST /api/scores (owner attached when signed in),
 *          GET /api/scores/:id (public), GET /api/shares (own),
 *          DELETE /api/scores/:id (owner only; revokes the link)
 *
 * Sessions ride an HttpOnly cookie. Set COOKIE_SECURE=1 behind TLS.
 * No email verification yet; accounts are credentials, not identity proof.
 */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, newSessionToken, normalizeEmail, validPassword, verifyPassword } from "./auth.js";
import {
  FileLibraryStore,
  FileSessionStore,
  FileStore,
  FileUserStore,
  newShareId,
  type CloudEntry,
  type SharedScore,
  type User,
} from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR =
  process.env.CUBSCORE_DATA ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

/** ~16 MB of base64 fits comfortably; real .gp files are far smaller. */
const MAX_BODY = 24 * 1024 * 1024;
const MAX_TEX = 2 * 1024 * 1024;
const MAX_CORE = 8 * 1024 * 1024;
const MAX_TEXT_FIELD = 500;
/**
 * Per-account cloud library limits.
 *
 * Nothing bounded this: 600 writes an hour at up to 24 MB each, and an account
 * costs nothing to create, so filling the disk was free and every real user's
 * autosave and sync then failed with ENOSPC. Generous for a real library —
 * transcriptions are tens of kilobytes and Guitar Pro files rarely reach one
 * megabyte — and it will move behind the production store's own quota.
 */
const MAX_ENTRIES_PER_OWNER = 2000;
const MAX_BYTES_PER_OWNER = 2 * 1024 * 1024 * 1024;
const COOKIE_NAME = "cub_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const scores = new FileStore(path.join(DATA_DIR, "scores"));
const users = new FileUserStore(path.join(DATA_DIR, "users"));
const sessions = new FileSessionStore(path.join(DATA_DIR, "sessions"), COOKIE_MAX_AGE * 1000);
const library = new FileLibraryStore(path.join(DATA_DIR, "library"));

// Behind a reverse proxy every request arrives from the proxy, so keying a rate
// limit on the socket address would put every user in one bucket and let one
// busy client lock out the rest. TRUST_PROXY=1 means "trust exactly one hop":
// take the address our own proxy appended and ignore anything the client sent.
// `true` here would have meant "trust every hop", which makes request.ip the
// leftmost X-Forwarded-For token — an arbitrary attacker-supplied string, not
// even necessarily an address. That defeats every per-IP limit at once and, since
// each distinct value allocates a counter, lets one client grow the counter map
// until the process runs out of memory.
const app = Fastify({
  bodyLimit: MAX_BODY,
  trustProxy: process.env.TRUST_PROXY === "1" ? 1 : false,
});

/**
 * In-memory rate limiting, per client and per bucket.
 *
 * The buckets are separate because they defend different things. Syncing a
 * large library is hundreds of legitimate writes; guessing a password is
 * twenty illegitimate attempts. One shared budget means either the sync
 * breaks or the guessing is comfortable.
 */
const LIMITS = {
  auth: { max: 30, windowMs: 15 * 60 * 1000 },
  write: { max: 600, windowMs: 60 * 60 * 1000 },
} as const;

const hits = new Map<string, { count: number; resetAt: number }>();

/** Bounds a rate-limit key, so a long header cannot become a long map key. */
const MAX_KEY = 100;

function tooMany(bucket: keyof typeof LIMITS, rawKey: string): boolean {
  const key = rawKey.slice(0, MAX_KEY);
  const now = Date.now();
  // Every distinct key allocates an entry, so a stream of unique addresses
  // would grow this map without bound. Sweeping only expired entries is not
  // enough on its own: inside one window nothing is expired, so the map kept
  // growing and every request paid for a full scan that reclaimed nothing.
  // Past the limit, the oldest entries go — losing a counter costs an attacker
  // a fresh budget, which is strictly better than losing the process.
  if (hits.size > 20_000) {
    for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    let excess = hits.size - 20_000;
    if (excess > 0) {
      // Map iteration is insertion-ordered, so this drops the least recently
      // created counters first.
      for (const k of hits.keys()) {
        if (excess-- <= 0) break;
        hits.delete(k);
      }
    }
  }
  const limit = LIMITS[bucket];
  const mapKey = `${bucket} ${key}`;
  const entry = hits.get(mapKey);
  if (!entry || now >= entry.resetAt) {
    hits.set(mapKey, { count: 1, resetAt: now + limit.windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > limit.max;
}

function sessionToken(request: FastifyRequest): string | null {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, token: string, maxAge = COOKIE_MAX_AGE): void {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

async function currentUser(request: FastifyRequest): Promise<User | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const userId = await sessions.userIdFor(token);
  if (!userId) return null;
  return (await users.byId(userId)) ?? null;
}

function publicUser(user: User) {
  return { id: user.id, email: user.email };
}

// ---------- auth ----------

app.post("/api/auth/register", async (request, reply) => {
  if (tooMany("auth", request.ip)) return reply.status(429).send({ error: "rate limit exceeded" });
  const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
  const email = normalizeEmail(body.email);
  if (!email) return reply.status(400).send({ error: "a valid email is required" });
  if (!validPassword(body.password)) {
    return reply.status(400).send({ error: "password must be at least 8 characters" });
  }
  const user: User = {
    id: newShareId(),
    email,
    passwordHash: hashPassword(body.password),
    createdAt: Date.now(),
  };
  // Record first, then claim the address. Claiming decides who wins a race, so
  // a loser leaves behind a user record no one holds an id or session for,
  // which is harmless; the reverse order would hand the address to an account
  // whose record failed to write.
  await users.put(user);
  if (!(await users.claimEmail(email, user.id))) {
    return reply.status(409).send({ error: "an account with this email already exists" });
  }
  const token = newSessionToken();
  await sessions.create(token, user.id);
  setSessionCookie(reply, token);
  return { user: publicUser(user) };
});

app.post("/api/auth/login", async (request, reply) => {
  if (tooMany("auth", request.ip)) return reply.status(429).send({ error: "rate limit exceeded" });
  const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
  const email = normalizeEmail(body.email);
  // Also limited per address, so spreading the guesses across many clients
  // does not buy an attacker an unlimited number of attempts at one account.
  if (email && tooMany("auth", `to ${email}`)) {
    return reply.status(429).send({ error: "rate limit exceeded" });
  }
  const user = email ? await users.byEmail(email) : undefined;
  // Same failure for unknown email and wrong password.
  if (!user || typeof body.password !== "string" || !verifyPassword(body.password, user.passwordHash)) {
    return reply.status(401).send({ error: "invalid email or password" });
  }
  const token = newSessionToken();
  await sessions.create(token, user.id);
  setSessionCookie(reply, token);
  return { user: publicUser(user) };
});

app.post("/api/auth/logout", async (request, reply) => {
  const token = sessionToken(request);
  if (token) await sessions.destroy(token);
  setSessionCookie(reply, "", 0);
  return { ok: true };
});

app.get("/api/auth/me", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "not signed in" });
  return { user: publicUser(user) };
});

// ---------- cloud library ----------

interface EntryBody {
  title?: unknown;
  artist?: unknown;
  format?: unknown;
  tex?: unknown;
  bytesB64?: unknown;
  core?: unknown;
  report?: unknown;
  authored?: unknown;
  tracks?: unknown;
  bars?: unknown;
  addedAt?: unknown;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}

app.get("/api/library", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "not signed in" });
  const entries = await library.list(user.id);
  // The list is metadata only; bodies come one at a time.
  return entries.map(({ tex, bytesB64, core, report, ...meta }) => meta);
});

app.put<{ Params: { id: string } }>("/api/library/:id", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "not signed in" });
  // Both, because either alone is a hole: per-account so one busy user behind a
  // shared address cannot lock out the others, and per-address so minting
  // accounts does not multiply the budget — registration costs an attacker
  // nothing, and there is no storage quota behind this yet.
  if (tooMany("write", user.id) || tooMany("write", request.ip)) {
    return reply.status(429).send({ error: "rate limit exceeded" });
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.params.id)) {
    return reply.status(400).send({ error: "invalid id" });
  }

  const body = (request.body ?? {}) as EntryBody;
  const format = body.format === "gp" || body.format === "altex" ? body.format : null;
  const tex = str(body.tex, MAX_TEX);
  const bytesB64 = str(body.bytesB64, MAX_BODY);
  if (!format || (tex === null && bytesB64 === null)) {
    return reply.status(400).send({ error: "format and one of tex/bytesB64 are required" });
  }
  if (bytesB64 !== null && !/^[A-Za-z0-9+/=]*$/.test(bytesB64)) {
    return reply.status(400).send({ error: "bytesB64 is not base64" });
  }

  // Quota, checked against what is already stored. Overwriting an entry that
  // exists is always allowed, so a user at their limit can still save the score
  // they are working on — only growing the library is refused.
  const existing = await library.get(user.id, request.params.id);
  if (!existing) {
    const used = await library.usage(user.id);
    if (used.entries >= MAX_ENTRIES_PER_OWNER || used.bytes >= MAX_BYTES_PER_OWNER) {
      return reply.status(413).send({
        error: "library is full — remove some scores to add more",
      });
    }
  }

  const entry: CloudEntry = {
    id: request.params.id,
    ownerId: user.id,
    title: str(body.title, MAX_TEXT_FIELD) ?? "Untitled",
    artist: str(body.artist, MAX_TEXT_FIELD) ?? "",
    format,
    tex,
    bytesB64,
    core: str(body.core, MAX_CORE),
    report: str(body.report, MAX_CORE),
    authored: body.authored === true,
    tracks: typeof body.tracks === "number" ? body.tracks : 0,
    bars: typeof body.bars === "number" ? body.bars : 0,
    addedAt: typeof body.addedAt === "number" ? body.addedAt : Date.now(),
    updatedAt: Date.now(),
  };
  await library.put(entry);
  return { id: entry.id, updatedAt: entry.updatedAt };
});

app.get<{ Params: { id: string } }>("/api/library/:id", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "not signed in" });
  const entry = await library.get(user.id, request.params.id);
  if (!entry) return reply.status(404).send({ error: "not found" });
  return entry;
});

app.delete<{ Params: { id: string } }>("/api/library/:id", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "not signed in" });
  // Validated like PUT: an unsafe id threw out of the store and answered 500
  // where the honest answer is 400.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.params.id)) {
    return reply.status(400).send({ error: "invalid id" });
  }
  await library.delete(user.id, request.params.id);
  return { ok: true };
});

// ---------- shares ----------

interface CreateBody {
  title?: unknown;
  artist?: unknown;
  format?: unknown;
  tex?: unknown;
  bytesB64?: unknown;
}

app.post("/api/scores", async (request, reply) => {
  if (tooMany("write", request.ip)) {
    return reply.status(429).send({ error: "rate limit exceeded, try again later" });
  }
  const body = (request.body ?? {}) as CreateBody;

  const format = body.format === "gp" || body.format === "altex" ? body.format : null;
  const tex = str(body.tex, MAX_TEX);
  const bytesB64 = str(body.bytesB64, MAX_BODY);

  if (!format || (tex === null && bytesB64 === null)) {
    return reply.status(400).send({ error: "format and one of tex/bytesB64 are required" });
  }
  if (bytesB64 !== null && !/^[A-Za-z0-9+/=]*$/.test(bytesB64)) {
    return reply.status(400).send({ error: "bytesB64 is not base64" });
  }

  const user = await currentUser(request);
  const record: SharedScore = {
    id: newShareId(),
    title: str(body.title, MAX_TEXT_FIELD) ?? "Untitled",
    artist: str(body.artist, MAX_TEXT_FIELD) ?? "",
    format,
    tex,
    bytesB64,
    createdAt: Date.now(),
    ...(user ? { ownerId: user.id } : {}),
  };
  await scores.put(record);
  return { id: record.id, owned: user !== null };
});

app.get<{ Params: { id: string } }>("/api/scores/:id", async (request, reply) => {
  const record = await scores.get(request.params.id);
  if (!record) return reply.status(404).send({ error: "not found" });
  // The owner id is private; the link is a read capability, nothing more.
  const { ownerId, ...publicRecord } = record;
  return publicRecord;
});

app.get("/api/shares", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "not signed in" });
  // Already metadata only: the store never loads share bodies for a list.
  return scores.listByOwner(user.id);
});

app.delete<{ Params: { id: string } }>("/api/scores/:id", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "not signed in" });
  const record = await scores.get(request.params.id);
  if (!record) return reply.status(404).send({ error: "not found" });
  if (record.ownerId !== user.id) return reply.status(403).send({ error: "not your share" });
  await scores.delete(request.params.id);
  return { ok: true };
});

app.get("/api/health", async () => ({ ok: true }));

// Index any account written before the email index existed, once, here. This is
// what lets login be a two-read lookup with no fallback scan — the scan it
// replaces cost one file read per account for every unrecognised address.
users
  .indexExistingEmails()
  .then((added) => {
    if (added > 0) console.log(`cubscore api: indexed ${added} pre-existing email(s)`);
  })
  .catch((err) => console.error("cubscore api: email index migration failed", err))
  .then(() => app.listen({ port: PORT, host: "127.0.0.1" }))
  .then(() => console.log(`cubscore api on :${PORT}, data in ${DATA_DIR}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
