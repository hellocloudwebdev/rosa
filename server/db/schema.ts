/**
 * Schema.
 *
 * Plain SQLite so the same file runs on node:sqlite, Cloudflare D1 and Turso.
 * Every user-owned row carries `user_id`, and every query that touches user
 * data filters on it — that is the access control that stops one user reading
 * another's chats, settings and provider keys.
 */

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: Array<{ version: number; statements: string[] }> = [
  {
    version: 1,
    statements: [
      /* --- bookkeeping --- */
      `CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,

      /* --- accounts --- */
      `CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL DEFAULT '',
        avatar_url    TEXT,
        auth_provider TEXT NOT NULL,             /* google | github | local */
        password_hash TEXT,                      /* only for auth_provider = 'local' */
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )`,

      /* OAuth identities are separate from users so one account can later
         attach more than one identity, and so we can match on the provider's
         own subject id rather than trusting the email address. */
      `CREATE TABLE IF NOT EXISTS oauth_identities (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        provider_user_id  TEXT NOT NULL,
        email             TEXT,
        raw_profile       TEXT,
        created_at        TEXT NOT NULL,
        UNIQUE (provider, provider_user_id)
      )`,

      /* --- sessions ---
         The cookie holds an opaque, random session id; this table is the only
         thing that maps it to a user. Sessions expire absolutely and are
         rotated on login. */
      `CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        revoked_at  TEXT,
        ip_hint     TEXT,
        user_agent  TEXT
      )`,

      /* Rate limiting counters for auth and provider-test endpoints. Keyed on
         (bucket, subject) with a window start so we can expire rows cheaply. */
      `CREATE TABLE IF NOT EXISTS rate_limits (
        bucket       TEXT NOT NULL,
        subject      TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, subject, window_start)
      )`,

      /* CSRF tokens for the OAuth flow (state) and, if needed, logins. */
      `CREATE TABLE IF NOT EXISTS oauth_states (
        state        TEXT PRIMARY KEY,
        provider     TEXT NOT NULL,
        redirect_to  TEXT,
        code_verifier TEXT,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      )`,

      /* --- provider configurations ---
         The API key is never stored in plaintext. `credential_mode` decides
         whether it is encrypted at rest, held only for the session, or sent
         per request from the browser. */
      `CREATE TABLE IF NOT EXISTS providers (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name        TEXT NOT NULL,
        kind                TEXT NOT NULL,          /* openai-compatible | anthropic */
        base_url            TEXT NOT NULL,
        credential_mode     TEXT NOT NULL,          /* session | encrypted | per-request */
        key_ciphertext      TEXT,                   /* AES-GCM, only when mode = encrypted */
        key_preview         TEXT,
        organization_id     TEXT,
        connection_status   TEXT NOT NULL DEFAULT 'untested',
        last_connected_at   TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      )`,

      /* Session-only keys live here, not in the providers table, so they can
         never outlive the session that created them. */
      `CREATE TABLE IF NOT EXISTS provider_session_keys (
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        api_key     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (session_id, provider_id)
      )`,

      /* --- models --- */
      `CREATE TABLE IF NOT EXISTS models (
        id                       TEXT PRIMARY KEY,
        user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id             TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id                 TEXT NOT NULL,
        name                     TEXT NOT NULL,
        metadata_json            TEXT NOT NULL,
        favourite                INTEGER NOT NULL DEFAULT 0,
        pinned                   INTEGER NOT NULL DEFAULT 0,
        available                INTEGER NOT NULL DEFAULT 1,
        first_seen_at            TEXT NOT NULL,
        last_fetched_at          TEXT NOT NULL,
        UNIQUE (user_id, provider_id, model_id)
      )`,

      /* --- conversations --- */
      `CREATE TABLE IF NOT EXISTS folders (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        mode       TEXT NOT NULL DEFAULT 'single',  /* single | compare */
        pane_count INTEGER NOT NULL DEFAULT 1,
        pinned     INTEGER NOT NULL DEFAULT 0,
        favourite  INTEGER NOT NULL DEFAULT 0,
        folder_id  TEXT REFERENCES folders(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        provider_id     TEXT REFERENCES providers(id) ON DELETE SET NULL,
        model_id        TEXT,
        model_name      TEXT,
        metrics_json    TEXT,
        status          TEXT NOT NULL DEFAULT 'complete',
        error           TEXT,
        created_at      TEXT NOT NULL
      )`,

      /* Indexes for the queries the app actually issues. */
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_providers_user ON providers(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id)`,
      `CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
         ON conversations(user_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation
         ON messages(conversation_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_user
         ON messages(user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start)`,
    ],
  },
];

/** The tables owned by a user, in an order safe for cascade deletes. */
export const USER_TABLES = [
  "messages",
  "conversations",
  "folders",
  "models",
  "provider_session_keys",
  "providers",
  "oauth_identities",
  "sessions",
] as const;
