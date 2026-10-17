/**
 * Migration runner.
 *
 * Called at boot by `server/db/index.ts` and standalone by `npm run db:migrate`.
 * Migrations are forward-only and idempotent.
 */
import { createDatabase, migrate, type DbDatabase } from "./node-driver.ts";

export function runMigrations(path?: string): DbDatabase {
  const resolved = path ?? process.env.ROSA_DB_PATH ?? "data/rosa.db";
  const db = createDatabase(resolved);
  const { applied } = migrate(db);
  if (applied.length === 0) {
    console.log(`schema up to date (v${db.schemaVersion}) at ${resolved}`);
  } else {
    console.log(`applied migrations [${applied.join(", ")}] -> v${db.schemaVersion} at ${resolved}`);
  }
  return db;
}

/* istanbul ignore next -- only reachable via `npm run db:migrate` */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  const db = runMigrations();
  db.close();
}
