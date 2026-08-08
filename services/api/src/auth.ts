/**
 * Password hashing and session tokens on node:crypto, no dependencies.
 *
 * scrypt for passwords (memory-hard, built in), random 256-bit session
 * tokens stored server-side. Blocking scryptSync is acceptable at dev
 * scale and swaps for the async variant behind the same signatures.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
