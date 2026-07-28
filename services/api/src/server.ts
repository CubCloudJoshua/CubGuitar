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
const COOKIE_NAME = "cub_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const scores = new FileStore(path.join(DATA_DIR, "scores"));
const users = new FileUserStore(path.join(DATA_DIR, "users"));
const sessions = new FileSessionStore(path.join(DATA_DIR, "sessions"));
const library = new FileLibraryStore(path.join(DATA_DIR, "library"));

const app = Fastify({ bodyLimit: MAX_BODY });

/** In-memory per-IP limit on writes. Enough for dev and single-node deploys. */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const writeCounts = new Map<string, { count: number; resetAt: number }>();

function overWriteLimit(ip: string): boolean {
  const now = Date.now();
  const entry = writeCounts.get(ip);
  if (!entry || now >= entry.resetAt) {
    writeCounts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
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
  if (overWriteLimit(request.ip)) return reply.status(429).send({ error: "rate limit exceeded" });
  const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
  const email = normalizeEmail(body.email);
  if (!email) return reply.status(400).send({ error: "a valid email is required" });
  if (!validPassword(body.password)) {
    return reply.status(400).send({ error: "password must be at least 8 characters" });
  }
  if (await users.byEmail(email)) {
    return reply.status(409).send({ error: "an account with this email already exists" });
  }
  const user: User = {
    id: newShareId(),
    email,
    passwordHash: hashPassword(body.password),
    createdAt: Date.now(),
  };
  await users.put(user);
  const token = newSessionToken();
  await sessions.create(token, user.id);
  setSessionCookie(reply, token);
  return { user: publicUser(user) };
});

app.post("/api/auth/login", async (request, reply) => {
  if (overWriteLimit(request.ip)) return reply.status(429).send({ error: "rate limit exceeded" });
  const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
  const email = normalizeEmail(body.email);
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
  if (overWriteLimit(request.ip)) return reply.status(429).send({ error: "rate limit exceeded" });
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
  if (overWriteLimit(request.ip)) {
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
  const own = await scores.listByOwner(user.id);
  return own.map((s) => ({ id: s.id, title: s.title, artist: s.artist, createdAt: s.createdAt }));
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

app
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(() => console.log(`cubscore api on :${PORT}, data in ${DATA_DIR}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
