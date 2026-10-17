/**
 * Users, sessions, OAuth state and rate limiting.
 *
 * Sessions are opaque random ids stored server-side; the browser only ever
 * holds the id in an HttpOnly cookie. That means logout is a real server-side
 * revocation, and a stolen cookie is useless once we delete the row.
 */

import { uuid } from "./../types.ts";
import type { DbDatabase } from "./../node-driver.ts";
import { timingSafeEqual } from "../../security/crypto.ts";

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  auth_provider: "google" | "github" | "local";
  password_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateUserInput {
  email: string;
  displayName?: string;
  avatarUrl?: string | null;
  authProvider: "google" | "github" | "local";
  passwordHash?: string | null;
}

export const SESSION_COOKIE = "rosa_session";

/** Session lifetime. Absolute, not sliding, so a stolen cookie has a horizon. */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

export function createUser(db: DbDatabase, input: CreateUserInput): UserRow {
  const id = uuid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (id, email, display_name, avatar_url, auth_provider, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      normalizeEmail(input.email),
      input.displayName?.trim() || normalizeEmail(input.email),
      input.avatarUrl ?? null,
      input.authProvider,
      input.passwordHash ?? null,
      now,
      now,
    ],
  );
  return {
    id,
    email: normalizeEmail(input.email),
    display_name: input.displayName?.trim() || normalizeEmail(input.email),
    avatar_url: input.avatarUrl ?? null,
    auth_provider: input.authProvider,
    password_hash: input.passwordHash ?? null,
    created_at: now,
    updated_at: now,
  };
}

export function getUserById(db: DbDatabase, id: string): UserRow | null {
  return db.first<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
}

export function getUserByEmail(db: DbDatabase, email: string): UserRow | null {
  return db.first<UserRow>("SELECT * FROM users WHERE email = ?", [normalizeEmail(email)]);
}

export function updateUserProfile(
  db: DbDatabase,
  id: string,
  patch: { displayName?: string; avatarUrl?: string | null },
): UserRow | null {
  const existing = getUserById(db, id);
  if (!existing) return null;
  const next: UserRow = {
    ...existing,
    display_name: patch.displayName?.trim() || existing.display_name,
    avatar_url: patch.avatarUrl === undefined ? existing.avatar_url : patch.avatarUrl,
    updated_at: new Date().toISOString(),
  };
  db.run(
    "UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?",
    [next.display_name, next.avatar_url, next.updated_at, id],
  );
  return next;
}

/**
 * Delete an account and everything it owns. Relies on ON DELETE CASCADE for
 * the user-owned tables; messages are deleted explicitly because D1 needs the
 * cascade declared on the referencing table (it is).
 */
export function deleteUser(db: DbDatabase, id: string): boolean {
  return db.run("DELETE FROM users WHERE id = ?", [id]).changes > 0;
}

/* ------------------------------------------------------------------ */
/* OAuth identities                                                    */
/* ------------------------------------------------------------------ */

export function linkOAuthIdentity(
  db: DbDatabase,
  userId: string,
  provider: "google" | "github",
  providerUserId: string,
  email: string | null,
  rawProfile?: unknown,
): void {
  db.run(
    `INSERT INTO oauth_identities (id, user_id, provider, provider_user_id, email, raw_profile, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_user_id) DO UPDATE SET
       user_id = excluded.user_id, email = excluded.email, raw_profile = excluded.raw_profile`,
    [
      uuid(),
      userId,
      provider,
      providerUserId,
      email ? normalizeEmail(email) : null,
      rawProfile ? JSON.stringify(rawProfile) : null,
      new Date().toISOString(),
    ],
  );
}

export function findUserByOAuthIdentity(
  db: DbDatabase,
  provider: "google" | "github",
  providerUserId: string,
): UserRow | null {
  const row = db.first<{ user_id: string }>(
    "SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?",
    [provider, providerUserId],
  );
  return row ? getUserById(db, row.user_id) : null;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  ip_hint: string | null;
  user_agent: string | null;
}

/** A session id has 128 bits of entropy — enough that guessing is infeasible. */
function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createSession(
  db: DbDatabase,
  userId: string,
  opts: { ipHint?: string | null; userAgent?: string | null } = {},
): SessionRow {
  const id = newSessionId();
  const now = new Date();
  const session: SessionRow = {
    id,
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    revoked_at: null,
    ip_hint: opts.ipHint ?? null,
    user_agent: opts.userAgent ? opts.userAgent.slice(0, 255) : null,
  };
  db.run(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at, ip_hint, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.user_id,
      session.created_at,
      session.expires_at,
      session.revoked_at,
      session.ip_hint,
      session.user_agent,
    ],
  );
  return session;
}

/** Look up a session and return the owning user, or null when invalid. */
export function resolveSession(db: DbDatabase, sessionId: string | undefined): UserRow | null {
  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId)) return null;
  const session = db.first<SessionRow>("SELECT * FROM sessions WHERE id = ?", [sessionId]);
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    revokeSession(db, sessionId);
    return null;
  }
  return getUserById(db, session.user_id);
}

export function revokeSession(db: DbDatabase, sessionId: string): boolean {
  return (
    db.run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [
      new Date().toISOString(),
      sessionId,
    ]).changes > 0
  );
}

export function revokeAllSessions(db: DbDatabase, userId: string): number {
  return db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [
    new Date().toISOString(),
    userId,
  ]).changes;
}

/** Housekeeping: drop sessions that expired long enough ago to be irrelevant. */
export function purgeExpiredSessions(db: DbDatabase): number {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  return db.run("DELETE FROM sessions WHERE expires_at < ?", [cutoff]).changes;
}

/* ------------------------------------------------------------------ */
/* OAuth state                                                         */
/* ------------------------------------------------------------------ */

export function createOAuthState(
  db: DbDatabase,
  provider: "google" | "github",
  redirectTo: string | null,
  codeVerifier: string | null,
): { state: string; expiresAt: number } {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const state = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const createdAt = Date.now();
  const expiresAt = createdAt + 10 * 60 * 1000; // 10 minutes
  db.run(
    `INSERT INTO oauth_states (state, provider, redirect_to, code_verifier, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [state, provider, redirectTo, codeVerifier, createdAt, expiresAt],
  );
  return { state, expiresAt };
}

export function consumeOAuthState(
  db: DbDatabase,
  state: string,
): { provider: "google" | "github"; redirectTo: string | null; codeVerifier: string | null } | null {
  const row = db.first<{
    provider: string;
    redirect_to: string | null;
    code_verifier: string | null;
    expires_at: number;
  }>("SELECT * FROM oauth_states WHERE state = ?", [state]);
  if (!row) return null;
  db.run("DELETE FROM oauth_states WHERE state = ?", [state]);
  if (row.expires_at <= Date.now()) return null;
  return {
    provider: row.provider as "google" | "github",
    redirectTo: row.redirect_to,
    codeVerifier: row.code_verifier,
  };
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fixed-window counter. Cheap by design: one row per bucket/window, incremented
 * with a single UPDATE. Enough to blunt brute force and abuse; it is not a
 * token bucket and will not smooth bursts, which is acceptable here.
 */
export function consumeRateLimit(
  db: DbDatabase,
  bucket: string,
  subject: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const existing = db.first<{ count: number; window_start: number }>(
    "SELECT count, window_start FROM rate_limits WHERE bucket = ? AND subject = ? AND window_start = ?",
    [bucket, subject, windowStart],
  );
  const count = existing?.count ?? 0;
  if (count >= limit) {
    const retryAfterSeconds = Math.ceil((windowStart + windowMs - Date.now()) / 1000);
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }
  if (existing) {
    db.run("UPDATE rate_limits SET count = count + 1 WHERE bucket = ? AND subject = ? AND window_start = ?", [
      bucket,
      subject,
      windowStart,
    ]);
  } else {
    db.run(
      "INSERT INTO rate_limits (bucket, subject, window_start, count) VALUES (?, ?, ?, 1)",
      [bucket, subject, windowStart],
    );
  }
  return { allowed: true, remaining: Math.max(0, limit - count - 1), retryAfterSeconds: 0 };
}

/** Drop counters older than a day so the table cannot grow forever. */
export function purgeRateLimits(db: DbDatabase): number {
  const cutoff = Math.floor((Date.now() - 86_400_000) / 3_600_000) * 3_600_000;
  return db.run("DELETE FROM rate_limits WHERE window_start < ?", [cutoff]).changes;
}

/**
 * Password hashing for the local dev login. PBKDF2-SHA256 with a per-user
 * salt. Deliberately modest iterations so a request stays inside a
 * serverless CPU budget; the local account is a development convenience,
 * not the production authentication path.
 */
const PBKDF2_ITERATIONS = 150_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${encodeBase64(salt)}$${encodeBase64(new Uint8Array(bits))}`;
}

/**
 * A real hash of a value nobody knows, in exactly the format `hashPassword`
 * produces.
 *
 * The login path compares against this when no account matches the email, so a
 * missing account costs the same PBKDF2 work as a wrong password. Generating it
 * through the same helpers as a real hash is deliberate: a hand-written decoy
 * that drifts from the real format would throw instead of comparing, which is
 * both a 500 and a timing tell.
 */
export function dummyPasswordHash(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${encodeBase64(random)}$${encodeBase64(
    crypto.getRandomValues(new Uint8Array(32)),
  )}`;
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Decode standard or URL-safe base64. Returns null rather than throwing, so a
 * corrupted stored hash is a failed comparison instead of a 500.
 */
function decodeBase64(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) return false;

  const salt = decodeBase64(parts[2]);
  const expected = decodeBase64(parts[3]);
  if (!salt || !expected || expected.length === 0) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    expected.length * 8,
  );
  return timingSafeEqual(
    [...new Uint8Array(bits)].map((b) => b.toString(16)).join(""),
    [...expected].map((b) => b.toString(16)).join(""),
  );
}
