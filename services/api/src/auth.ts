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
