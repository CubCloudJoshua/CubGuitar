/**
 * Password hashing and session tokens on node:crypto, no dependencies.
 *
 * scrypt for passwords (memory-hard, built in), random 256-bit session
 * tokens stored server-side. Blocking scryptSync is acceptable at dev
 * scale and swaps for the async variant behind the same signatures.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), KEY_LENGTH);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // NFC first: the same address typed and pasted can differ in composition, and
  // the store hashes this string. Without it "josé@..." registers twice — once
  // composed, once decomposed — and the second signup silently creates an empty
  // second account while the first one's library appears to have vanished.
  const email = raw.normalize("NFC").trim().toLowerCase();
  // Deliberately loose: enough to keep garbage out, not a deliverability check.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  return email;
}

export function validPassword(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length >= 8 && raw.length <= 200;
}

/**
 * A recovery code: the password reset that needs no email service.
 *
 * Sixteen base32-ish characters in four groups, from the platform's own randomness —
 * no external mail provider, which is not a shortcut but the point: an account system
 * on sovereign infrastructure should not have a hard dependency on somebody else's
 * SMTP to give a user their account back. The code is shown once at signup, stored
 * only as a hash (it is a password equivalent and gets a password's treatment), and
 * rotated on every use so a code that recovered an account once is spent.
 *
 * The alphabet drops 0/O/1/I: a code someone writes on paper gets read back.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newRecoveryCode(): string {
  const raw = randomBytes(16);
  const chars = Array.from(raw, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}`;
}

/** Case- and hyphen-insensitive, because the code is typed back by a human. */
export function normalizeRecoveryCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return cleaned.length === 16 ? cleaned : null;
}

export function hashRecoveryCode(code: string): string {
  return hashPassword(code);
}

export function verifyRecoveryCode(code: string, stored: string): boolean {
  return verifyPassword(code, stored);
}

/**
 * An email verification token, as the two halves a link has to carry.
 *
 * The id is in the token because the secret is only ever stored hashed, and a hash
 * cannot be looked up by. Handing back both means one read: find the account by id, then
 * compare. The alternative — a second index from hash to account — is another writable
 * mapping to keep consistent for no gain.
 *
 * A verification token is not a password equivalent, so it does not get scrypt's
 * treatment: it is 256 bits of randomness with a 24-hour life and one use, which leaves
 * nothing for a slow hash to defend. SHA-256 keeps the comparison constant-time (below)
 * without making every verification cost 64 MB of memory.
 */
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export interface VerificationToken {
  /** Goes in the link. Never stored. */
  token: string;
  /** Stored on the account. */
  hash: string;
  expiresAt: number;
}

export function newVerificationToken(userId: string, now = Date.now()): VerificationToken {
  const secret = randomBytes(32).toString("base64url");
  return {
    token: `${userId}.${secret}`,
    hash: hashVerificationSecret(secret),
    expiresAt: now + VERIFY_TTL_MS,
  };
}

export function hashVerificationSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Splits a token into the account it names and the secret it proves.
 *
 * Null for anything malformed, including an id with a dot in it: ids come from
 * `newShareId`, the separator is the first dot, and a token with no dot or an empty half
 * is not a token. The split is on the *first* dot so a secret containing one — base64url
 * cannot, but the parser should not depend on that — cannot move the boundary.
 */
export function splitVerificationToken(raw: unknown): { userId: string; secret: string } | null {
  if (typeof raw !== "string" || raw.length > 400) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { userId: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

/**
 * Constant-time comparison of a presented secret against the stored hash.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak length by throwing, so
 * the presented secret is hashed first: two SHA-256 hex digests are always the same
 * length, whatever was presented.
 */
export function verifyVerificationSecret(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashVerificationSecret(secret), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
