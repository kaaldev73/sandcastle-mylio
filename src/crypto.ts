import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

/**
 * Password hashing and token helpers. Passwords are hashed with scrypt and a
 * per-password random salt (PRD Security: passwords stored hashed). Opaque
 * tokens (invitations, sessions, password resets) are random and only their
 * SHA-256 hash is stored, so a database leak does not hand out live tokens.
 */

const SCRYPT_KEYLEN = 64;

/** Hash a password for storage. Returns a self-describing `scrypt$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Verify a password against a stored hash in constant time. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Generate a fresh opaque token to hand to a client (invite/session/reset). */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Hash an opaque token for storage/lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
