import path from "node:path";
import { createDatabase, migrate, type DbDatabase } from "./node-driver.ts";

export type { DbDatabase } from "./node-driver.ts";

/** Validate and resolve safe sqlite db path */
function resolveDbPath(targetPath?: string): string {
  const raw = targetPath ?? process.env.ROSA_DB_PATH ?? "data/rosa.db";
  // Protect against arbitrary command injection / argument injection
  if (/[\0\r\n`$|;&<>]/.test(raw)) {
    throw new Error("Invalid characters in ROSA_DB_PATH");
  }
  return path.normalize(raw);
}

/**
 * Opens a SQLite database and brings it to the current schema version.
 *
 * The file lives at `ROSA_DB_PATH` (default `data/rosa.db`). Kept out of the
 * request path on purpose: the server calls this exactly once at boot.
 */
export function openDatabase(dbPath?: string): DbDatabase {
  const resolved = resolveDbPath(dbPath);
  const db = createDatabase(resolved);
  migrate(db);
  return db;
}
