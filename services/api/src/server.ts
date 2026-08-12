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
import { hashPassword, newSessionToken, normalizeEmail, validPassword, verifyPassword,
  newRecoveryCode,
  normalizeRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
  newVerificationToken,
  splitVerificationToken,
  verifyVerificationSecret,
  type VerificationToken,
} from "./auth.js";
import { deliver, mailConfig, publicOrigin, verificationMessage } from "./mail.js";
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
/**
 * Loopback by default, on purpose: this service has no TLS and expects a reverse
 * proxy in front of it, so a default that listened on every interface would put
 * session cookies on the wire in plain text the first time someone ran it on a box
 * with a public address.
 *
 * Overridable because a container's loopback is its own. Inside one, 127.0.0.1
 * cannot be reached from anywhere else in the deployment, so the service came up
 * healthy and answered nobody. HOST=0.0.0.0 is correct there and wrong on a host
 * that is not behind a proxy — which is why it is a decision the deployment makes
 * rather than a default. See DEPLOY.md.
 */
const HOST = process.env.HOST ?? "127.0.0.1";
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

/**
 * Mail settings, read once at boot.
 *
 * `MAIL_ORIGIN` being null is the switch for the whole verification feature: no
 * PUBLIC_URL means no trusted origin to build a link from, and the alternative — building
 * it from the request's Host header — would let anyone who can reach this service email a
 * victim a link to a host of their choosing carrying a token for the victim's account.
 * See mail.ts.
 */
const MAIL_ORIGIN = publicOrigin();
const MAIL = mailConfig(DATA_DIR);

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
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== undefined,
    /**
     * Whether this deployment can verify an address at all.
     *
     * Sent with the user because the client cannot otherwise tell "you have not confirmed
     * your address" from "nobody here can confirm addresses", and those want opposite
     * interfaces: the first is a thing to act on, the second is a thing to say nothing
     * about. A banner nagging every user of a deployment with no mail configured to click
     * a link that cannot be sent would be worse than no verification.
     */
    verificationAvailable: MAIL_ORIGIN !== null,
  };
}

/**
 * Issues a verification link and hands it to the mail transport.
 *
 * Returns the outstanding token to store, or null when this deployment cannot verify.
 * Never throws and never blocks the caller's response on delivery: a signup whose mail
 * fails still made an account, and the user can ask for another link. The failure is
 * logged because a spool that silently stopped working is the kind of thing an operator
 * finds out about from a user.
 */
async function issueVerification(user: User): Promise<VerificationToken | null> {
  if (MAIL_ORIGIN === null) return null;
  const issued = newVerificationToken(user.id);
  const link = `${MAIL_ORIGIN}/?verify=${encodeURIComponent(issued.token)}`;
  void deliver(verificationMessage(user.email, link), MAIL)
    .then((result) => {
      if (!result.sent) console.error(`cubscore api: verification mail failed — ${result.detail}`);
    })
    .catch((err) => console.error("cubscore api: verification mail threw", err));
  return issued;
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
  const recoveryCode = newRecoveryCode();
  const user: User = {
    id: newShareId(),
    email,
    passwordHash: hashPassword(body.password),
    recoveryHash: hashRecoveryCode(normalizeRecoveryCode(recoveryCode)!),
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
  // After the address is claimed, not before: a registration that lost the race for the
  // email must not send a verification link for an account nobody can sign in to.
  const issued = await issueVerification(user);
  if (issued) {
    user.verifyHash = issued.hash;
    user.verifyExpiresAt = issued.expiresAt;
    await users.put(user);
  }
  const token = newSessionToken();
  await sessions.create(token, user.id);
  setSessionCookie(reply, token);
  // The code goes over the wire exactly once, here, and is never readable again:
  // the server keeps only its hash. The client's job is to make the user save it.
  return { user: publicUser(user), recoveryCode };
});

/**
 * Confirms an address from the link that was mailed to it.
 *
 * Unauthenticated on purpose: the link is clicked in whatever browser opened the mail,
 * which is often not the one that signed up, and requiring a session would make the
 * common case fail. The token is the proof, and it is single use — cleared here whether or
 * not it had expired, so a link that leaked cannot be retried and a stale one cannot sit
 * on an account forever.
 *
 * One message for every failure. A token names an account, so distinguishing "no such
 * account" from "wrong token" would turn this into a way to test whether an id exists.
 */
app.post("/api/auth/verify", async (request, reply) => {
  if (tooMany("auth", request.ip)) return reply.status(429).send({ error: "rate limit exceeded" });
  if (MAIL_ORIGIN === null) {
    return reply.status(503).send({ error: "email verification is not enabled here" });
  }
  const body = (request.body ?? {}) as { token?: unknown };
  const parts = splitVerificationToken(body.token);
  const user = parts ? await users.byId(parts.userId) : undefined;
  const stored = user?.verifyHash;
  const fresh = user?.verifyExpiresAt !== undefined && Date.now() < user.verifyExpiresAt;
  if (!parts || !user || !stored || !verifyVerificationSecret(parts.secret, stored)) {
    return reply.status(400).send({ error: "this confirmation link is not valid" });
  }
  // Spent either way. An expired token that stayed usable after a failed attempt would
  // make expiry advisory.
  const { verifyHash: _hash, verifyExpiresAt: _expires, ...rest } = user;
  if (!fresh) {
    await users.put(rest);
    return reply.status(400).send({ error: "this confirmation link has expired" });
  }
  const verified: User = { ...rest, emailVerifiedAt: Date.now() };
  await users.put(verified);
  return { user: publicUser(verified) };
});

/**
 * Sends another link, to the signed-in account's own address.
 *
 * Authenticated and takes no email, so it cannot be used to mail an arbitrary address:
 * an endpoint that accepted one would be an open relay for our own domain, and a way to
 * find out which addresses have accounts. Rate limited per account as well as per client,
 * because the cost of this endpoint is somebody else's inbox.
 */
app.post("/api/auth/verify/resend", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "not signed in" });
  if (tooMany("auth", request.ip) || tooMany("auth", `verify ${user.id}`)) {
    return reply.status(429).send({ error: "rate limit exceeded" });
  }
  if (MAIL_ORIGIN === null) {
    return reply.status(503).send({ error: "email verification is not enabled here" });
  }
  if (user.emailVerifiedAt !== undefined) return { user: publicUser(user) };
  const issued = await issueVerification(user);
  if (!issued) return reply.status(503).send({ error: "email verification is not enabled here" });
  await users.put({ ...user, verifyHash: issued.hash, verifyExpiresAt: issued.expiresAt });
  return { user: publicUser(user) };
});

/**
 * Password reset by recovery code — the email-less kind, on purpose.
 *
 * Accounts here run on CubScore's own infrastructure with no external mail provider in
 * the loop, so recovery cannot lean on "we emailed you a link". The recovery code is
 * the replacement: minted at signup, shown once, stored hashed. Using it sets the new
 * password, rotates the code (a code that worked is spent), and ends every session the
 * account has — the code gets used precisely when the password may be in someone
 * else's hands, and a reset that leaves their session alive has reset nothing.
 */
app.post("/api/auth/recover", async (request, reply) => {
  if (tooMany("auth", request.ip)) return reply.status(429).send({ error: "rate limit exceeded" });
  const body = (request.body ?? {}) as { email?: unknown; recoveryCode?: unknown; newPassword?: unknown };
  const email = normalizeEmail(body.email);
  // Per-account limiting, same as login: a recovery code is guessable in principle
  // and must not be guessable in practice.
  if (email && tooMany("auth", `to ${email}`)) {
    return reply.status(429).send({ error: "rate limit exceeded" });
  }
  if (!validPassword(body.newPassword)) {
    return reply.status(400).send({ error: "password must be at least 8 characters" });
  }
  const code = normalizeRecoveryCode(body.recoveryCode);
  const user = email ? await users.byEmail(email) : undefined;
  // One failure message for unknown email, missing hash, and wrong code, so the
  // endpoint confirms nothing about which addresses have accounts.
  if (!user || !code || !user.recoveryHash || !verifyRecoveryCode(code, user.recoveryHash)) {
    return reply.status(401).send({ error: "invalid email or recovery code" });
  }
  const nextCode = newRecoveryCode();
  await users.put({
    ...user,
    passwordHash: hashPassword(body.newPassword as string),
    recoveryHash: hashRecoveryCode(normalizeRecoveryCode(nextCode)!),
  });
  await sessions.destroyAllFor(user.id);
  const token = newSessionToken();
  await sessions.create(token, user.id);
  setSessionCookie(reply, token);
  return { user: publicUser(user), recoveryCode: nextCode };
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
  .then(() => app.listen({ port: PORT, host: HOST }))
  .then(() => console.log(`cubscore api on ${HOST}:${PORT}, data in ${DATA_DIR}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
