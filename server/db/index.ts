import { createDatabase, migrate, type DbDatabase } from "./node-driver.ts";

export type { DbDatabase } from "./node-driver.ts";
/**
 * Opens a SQLite database and brings it to the current schema version.
 *
 * The file lives at `ROSA_DB_PATH` (default `data/rosa.db`). Kept out of the
 * request path on purpose: the server calls this exactly once at boot.
 */
export function openDatabase(path?: string): DbDatabase {
  const resolved = path ?? process.env.ROSA_DB_PATH ?? "data/rosa.db";
  const db = createDatabase(resolved);
  migrate(db);
  return db;
}
