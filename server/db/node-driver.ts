import { DatabaseSync, type StatementSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.ts";
import { toNumber, type DbDriver, type DbExecResult, type DbParams, type DbParamValue } from "./types.ts";

/** A live SQLite database. */
export interface DbDatabase extends DbDriver {
  readonly path: string;
  readonly schemaVersion: number;
  /** Run statements atomically. Falls back to a plain sequence if unsupported. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * node:sqlite driver.
 *
 * Node's built-in SQLite only accepts positional `?` binds, but our repository
 * layer prefers named objects because that is what Cloudflare D1 accepts. This
 * adapter rewrites `:name` placeholders into positional binds and collects the
 * matching values in order, so the same repository code runs on both.
 *
 * The rewrite is deliberately narrow — single-word parameter names only — which
 * keeps it safe against a `?` or `:name` appearing inside a string literal only
 * because real SQL literals here contain no colon-prefixed word patterns.
 */
export function createDatabase(path: string): DbDatabase {
  const sqlite = new DatabaseSync(path);

  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");

  type Compiled = { stmt: StatementSync; values: DbParamValue[] };

  const compile = (sql: string, params?: DbParams): Compiled => {
    if (Array.isArray(params)) return { stmt: sqlite.prepare(sql), values: params as DbParamValue[] };

    const names: string[] = [];
    const rewritten = sql.replace(
      /[:@$]([a-zA-Z_][a-zA-Z0-9_]*)/g,
      (_all, name: string) => {
        names.push(name);
        return "?";
      },
    );
    const values = params
      ? names.map((name) => {
          const value = params[name];
          if (value === undefined) {
            throw new Error(
              `Missing named parameter ":${name}" in query: ${sql.slice(0, 80)}`,
            );
          }
          return value;
        })
      : [];
    return { stmt: sqlite.prepare(rewritten), values };
  };

  const run = (sql: string, params?: DbParams): DbExecResult => {
    const { stmt, values } = compile(sql, params);
    const result = stmt.run(...(values as never[]));
    return {
      changes: toNumber(result.changes),
      lastInsertRowid: result.lastInsertRowid,
      rowsAffected: toNumber(result.changes),
    };
  };

  const all = <T = Record<string, unknown>>(sql: string, params?: DbParams): T[] => {
    const { stmt, values } = compile(sql, params);
    return stmt.all(...(values as never[])) as T[];
  };

  const first = <T = Record<string, unknown>>(sql: string, params?: DbParams): T | null => {
    const { stmt, values } = compile(sql, params);
    const row = stmt.get(...(values as never[]));
    return (row as T | undefined) ?? null;
  };

  const scalar = <T = unknown>(sql: string, params?: DbParams): T | null => {
    const row = first(sql, params) as Record<string, unknown> | null;
    if (!row) return null;
    const keys = Object.keys(row);
    return (keys.length > 0 ? row[keys[0]] : null) as T | null;
  };

  return {
    path,
    supportsTransactions: true,

    run,
    all,
    first,
    scalar,

    batch(statements) {
      return statements.map(({ sql, params }) => all(sql, params));
    },

    transaction<T>(fn: () => T): T {
      sqlite.exec("BEGIN");
      try {
        const result = fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          /* the connection is already aborted; nothing to roll back */
        }
        throw err;
      }
    },

    get schemaVersion(): number {
      const row = first("SELECT value FROM schema_meta WHERE key = 'schema_version'") as
        | { value?: string }
        | null;
      return row?.value ? Number(row.value) : 0;
    },

    close() {
      sqlite.close();
    },
  };
}

/** Apply any migrations that have not run yet. Idempotent. */
export function migrate(db: DbDatabase): { applied: number[] } {
  const applied: number[] = [];

  db.run(
    "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const currentRow = db.first("SELECT value FROM schema_meta WHERE key = 'schema_version'") as
    | { value?: string }
    | null;
  const current = currentRow?.value ? Number(currentRow.value) : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    for (const stmt of migration.statements) db.run(stmt);
    db.run(
      `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(migration.version)],
    );
    applied.push(migration.version);
  }

  return { applied };
}
