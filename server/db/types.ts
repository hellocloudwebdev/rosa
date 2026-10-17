/**
 * Database abstraction.
 *
 * The schema is plain SQLite on purpose: the same SQL runs on
 *   - node:sqlite (development, self-hosted, Vercel),
 *   - Cloudflare D1 (the free-tier production target),
 *   - Turso/libSQL (an alternative free host for Vercel).
 *
 * The interface is synchronous to match node:sqlite exactly. Cloudflare's D1 is
 * async, so `server/db/d1-driver.ts` wraps it in a driver whose methods return
 * promises — the repository layer treats them as values and awaits at the
 * boundary, which is why repository functions are `async`.
 */

/** A synchronous result set covering every row of a query. */
export interface DbExecResult {
  changes: number;
  lastInsertRowid: number | bigint | null;
  rowsAffected: number;
}

export type DbParamValue = string | number | bigint | boolean | null | Uint8Array;
export type DbParams = DbParamValue[] | Record<string, DbParamValue>;

/**
 * The synchronous subset of a SQLite driver.
 *
 * D1 satisfies this after wrapping (its methods resolve to the same shapes).
 */
export interface DbDriver {
  run(sql: string, params?: DbParams): DbExecResult;
  all<T = Record<string, unknown>>(sql: string, params?: DbParams): T[];
  first<T = Record<string, unknown>>(sql: string, params?: DbParams): T | null;
  scalar<T = unknown>(sql: string, params?: DbParams): T | null;
  batch<T = Record<string, unknown>>(statements: Array<{ sql: string; params?: DbParams }>): T[][];
  /** True when the driver supports real interactive transactions. */
  supportsTransactions: boolean;
}

/** Row ids are integers in SQLite; normalize them to numbers. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (value == null) return 0;
  return Number(value);
}

let _nextId = 0;
/** Ids for entities that are not autoincremented rows (folders, requests). */
export function localId(prefix: string): string {
  _nextId += 1;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const rand = [...bytes].map((b) => b.toString(36)).join("").slice(0, 10);
  return `${prefix}_${Date.now().toString(36)}${_nextId.toString(36)}${rand}`;
}

/** RFC 4122-style v4, from the platform CSPRNG. */
export function uuid(): string {
  const c = crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
