/**
 * Provider-config and model persistence.
 *
 * Everything here is scoped by user id — a caller can never read another
 * user's rows because the id is a required argument to every function.
 */

import type {
  ConnectionStatus,
  ModelMetadata,
  ModelRecord,
  ProviderConfig,
  ProviderKind,
} from "../../../shared/types.ts";
import { uuid } from "./../types.ts";
import type { DbDatabase } from "./../node-driver.ts";

/** Row shape as stored. Exported so the API layer can type its queries. */
export interface ProviderRow {
  id: string;
  user_id: string;
  display_name: string;
  kind: string;
  base_url: string;
  credential_mode: "session" | "encrypted" | "per-request";
  key_ciphertext: string | null;
  key_preview: string | null;
  organization_id: string | null;
  connection_status: string;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toProviderConfig(row: ProviderRow, discoveredModelCount: number): ProviderConfig {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind as ProviderKind,
    baseUrl: row.base_url,
    credentialMode: row.credential_mode as "session" | "encrypted" | "per-request",
    hasKey: row.credential_mode === "encrypted" || row.credential_mode === "session",
    keyPreview: row.key_preview,
    organizationId: row.organization_id,
    connectionStatus: row.connection_status as ConnectionStatus,
    discoveredModelCount,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
  };
}

function discoveredCount(db: DbDatabase, userId: string, providerId: string): number {
  return (
    db.scalar<number>(
      "SELECT COUNT(*) FROM models WHERE user_id = ? AND provider_id = ?",
      [userId, providerId],
    ) ?? 0
  );
}

export function listProviders(db: DbDatabase, userId: string): ProviderConfig[] {
  const rows = db.all<ProviderRow>(
    "SELECT * FROM providers WHERE user_id = ? ORDER BY created_at ASC",
    [userId],
  );
  return rows.map((r) => toProviderConfig(r, discoveredCount(db, r.user_id ?? userId, r.id)));
}

export function getProviderRow(db: DbDatabase, userId: string, providerId: string): ProviderRow | null {
  return db.first<ProviderRow>("SELECT * FROM providers WHERE id = ? AND user_id = ?", [
    providerId,
    userId,
  ]);
}

export function getProvider(db: DbDatabase, userId: string, providerId: string): ProviderConfig | null {
  const row = getProviderRow(db, userId, providerId);
  return row ? toProviderConfig(row, discoveredCount(db, userId, row.id)) : null;
}

export function getProviderConfig(
  db: DbDatabase,
  userId: string,
  providerId: string,
): ProviderConfig | null {
  return getProvider(db, userId, providerId);
}

export interface CreateProviderInput {
  displayName: string;
  kind: ProviderKind;
  baseUrl: string;
  credentialMode: "session" | "encrypted" | "per-request";
  keyCiphertext: string | null;
  keyPreview: string | null;
  organizationId: string | null;
}

export function createProvider(
  db: DbDatabase,
  userId: string,
  input: CreateProviderInput,
): ProviderConfig {
  const id = uuid();
  const now = new Date().toISOString();
  const row: ProviderRow = {
    id,
    user_id: userId,
    display_name: input.displayName,
    kind: input.kind,
    base_url: input.baseUrl,
    credential_mode: input.credentialMode,
    key_ciphertext: input.keyCiphertext,
    key_preview: input.keyPreview,
    organization_id: input.organizationId,
    connection_status: "untested",
    last_connected_at: null,
    created_at: now,
    updated_at: now,
  };
  db.run(
    `INSERT INTO providers
       (id, user_id, display_name, kind, base_url, credential_mode, key_ciphertext,
        key_preview, organization_id, connection_status, last_connected_at, created_at, updated_at)
     VALUES
       (:id, :user_id, :display_name, :kind, :base_url, :credential_mode, :key_ciphertext,
        :key_preview, :organization_id, :connection_status, :last_connected_at, :created_at, :updated_at)`,
    {
      id: row.id,
      user_id: row.user_id,
      display_name: row.display_name,
      kind: row.kind,
      base_url: row.base_url,
      credential_mode: row.credential_mode,
      key_ciphertext: row.key_ciphertext,
      key_preview: row.key_preview,
      organization_id: row.organization_id,
      connection_status: row.connection_status,
      last_connected_at: row.last_connected_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  );
  return toProviderConfig(row, 0);
}

export interface UpdateProviderInput {
  displayName?: string;
  baseUrl?: string;
  kind?: ProviderKind;
  organizationId?: string | null;
  credentialMode?: "session" | "encrypted" | "per-request";
  keyCiphertext?: string | null;
  keyPreview?: string | null;
}
export function updateProvider(
  db: DbDatabase,
  userId: string,
  providerId: string,
  input: UpdateProviderInput,
): ProviderConfig | null {
  const existing = getProviderRow(db, userId, providerId);
  if (!existing) return null;

  const next: ProviderRow = {
    ...existing,
    display_name: input.displayName ?? existing.display_name,
    base_url: input.baseUrl ?? existing.base_url,
    kind: input.kind ?? existing.kind,
    organization_id: input.organizationId ?? existing.organization_id,
    credential_mode: input.credentialMode ?? existing.credential_mode,
    key_ciphertext: input.keyCiphertext ?? existing.key_ciphertext,
    key_preview: input.keyPreview ?? existing.key_preview,
    updated_at: new Date().toISOString(),
  };
  db.run(
    `UPDATE providers SET
       display_name = :display_name, base_url = :base_url, kind = :kind,
       organization_id = :organization_id, credential_mode = :credential_mode,
       key_ciphertext = :key_ciphertext, key_preview = :key_preview, updated_at = :updated_at
     WHERE id = :id AND user_id = :user_id`,
    { ...next },
  );
  return getProvider(db, userId, providerId);
}

/** Delete a provider. Its models go with it via ON DELETE CASCADE. */
export function deleteProvider(db: DbDatabase, userId: string, providerId: string): boolean {
  const res = db.run("DELETE FROM providers WHERE id = ? AND user_id = ?", [providerId, userId]);
  return res.changes > 0;
}

export function setConnectionStatus(
  db: DbDatabase,
  userId: string,
  providerId: string,
  status: ConnectionStatus,
  opts: { lastConnectedAt?: string | null } = {},
): void {
  db.run(
    `UPDATE providers SET connection_status = ?, last_connected_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      status,
      opts.lastConnectedAt ?? null,
      new Date().toISOString(),
      providerId,
      userId,
    ],
  );
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

interface ModelRow {
  id: string;
  user_id: string;
  provider_id: string;
  model_id: string;
  name: string;
  metadata_json: string;
  favourite: number;
  pinned: number;
  available: number;
  first_seen_at: string;
  last_fetched_at: string;
}

interface ModelListRow extends ModelRow {
  provider_name: string;
  provider_kind: string;
}

function rowToModel(row: ModelListRow): ModelRecord {
  const metadata = JSON.parse(row.metadata_json) as ModelMetadata;
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    providerKind: row.provider_kind as ModelRecord["providerKind"],
    modelId: row.model_id,
    name: row.name,
    metadata,
    favourite: row.favourite === 1,
    pinned: row.pinned === 1,
    available: row.available === 1,
  };
}

const MODEL_SELECT = `
  SELECT m.id, m.user_id, m.provider_id, m.model_id, m.name, m.metadata_json,
         m.favourite, m.pinned, m.available, m.first_seen_at, m.last_fetched_at,
         p.display_name AS provider_name, p.kind AS provider_kind
    FROM models m
    JOIN providers p ON p.id = m.provider_id
`;

export interface UpsertModelInput {
  id: string;
  modelId: string;
  name: string;
  metadata: ModelMetadata;
}

export function listModels(db: DbDatabase, userId: string): ModelRecord[] {
  return db.all<ModelListRow>(`${MODEL_SELECT} WHERE m.user_id = ? ORDER BY m.name ASC`, [
    userId,
  ]).map(rowToModel);
}

export function listModelsByProvider(
  db: DbDatabase,
  userId: string,
  providerId: string,
): ModelRecord[] {
  return db
    .all<ModelListRow>(`${MODEL_SELECT} WHERE m.user_id = ? AND m.provider_id = ? ORDER BY m.name ASC`, [
      userId,
      providerId,
    ])
    .map(rowToModel);
}

export function getModel(db: DbDatabase, userId: string, modelId: string): ModelRecord | null {
  const row = db.first<ModelListRow>(`${MODEL_SELECT} WHERE m.user_id = ? AND m.id = ?`, [
    userId,
    modelId,
  ]);
  return row ? rowToModel(row) : null;
}

/**
 * Insert or update one discovered model, preserving that user's existing
 * favourite/pinned flags and marking availability.
 */
export function upsertModel(
  db: DbDatabase,
  userId: string,
  providerId: string,
  input: UpsertModelInput,
): "inserted" | "updated" {
  const now = new Date().toISOString();
  const existing = db.first<ModelRow>(
    "SELECT * FROM models WHERE user_id = ? AND provider_id = ? AND model_id = ?",
    [userId, providerId, input.modelId],
  );
  if (existing) {
    db.run(
      `UPDATE models
          SET name = ?, metadata_json = ?, available = 1, last_fetched_at = ?
        WHERE id = ?`,
      [input.name, JSON.stringify(input.metadata), now, existing.id],
    );
    return "updated";
  }
  const id = `${providerId}:${input.modelId}`.slice(0, 191);
  db.run(
    `INSERT INTO models
       (id, user_id, provider_id, model_id, name, metadata_json, favourite, pinned,
        available, first_seen_at, last_fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
    [id, userId, providerId, input.modelId, input.name, JSON.stringify(input.metadata), now, now],
  );
  return "inserted";
}

/** Mark models no longer offered by the provider as unavailable (not deleted). */
export function markUnavailable(db: DbDatabase, userId: string, providerId: string): number {
  const res = db.run("UPDATE models SET available = 0 WHERE user_id = ? AND provider_id = ?", [
    userId,
    providerId,
  ]);
  return res.changes;
}

export function setFavourite(
  db: DbDatabase,
  userId: string,
  modelId: string,
  favourite: boolean,
): ModelRecord | null {
  const row = getModel(db, userId, modelId);
  if (!row) return null;
  db.run("UPDATE models SET favourite = ? WHERE id = ? AND user_id = ?", [
    favourite ? 1 : 0,
    modelId,
    userId,
  ]);
  return { ...row, favourite };
}

export function setPinned(
  db: DbDatabase,
  userId: string,
  modelId: string,
  pinned: boolean,
): ModelRecord | null {
  const row = getModel(db, userId, modelId);
  if (!row) return null;
  db.run("UPDATE models SET pinned = ? WHERE id = ? AND user_id = ?", [
    pinned ? 1 : 0,
    modelId,
    userId,
  ]);
  return { ...row, pinned };
}

export function setDefaultModel(
  db: DbDatabase,
  userId: string,
  modelId: string,
): ModelRecord | null {
  return setPinned(db, userId, modelId, true);
}

/* ------------------------------------------------------------------ */
/* Session-only provider keys                                          */
/* ------------------------------------------------------------------ */

export function setSessionKey(
  db: DbDatabase,
  sessionId: string,
  providerId: string,
  apiKey: string,
): void {
  db.run(
    `INSERT INTO provider_session_keys (session_id, provider_id, api_key, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, provider_id)
       DO UPDATE SET api_key = excluded.api_key, created_at = excluded.created_at`,
    [sessionId, providerId, apiKey, new Date().toISOString()],
  );
}

export function getSessionKey(
  db: DbDatabase,
  sessionId: string,
  providerId: string,
): string | null {
  const row = db.first<{ api_key: string }>(
    "SELECT api_key FROM provider_session_keys WHERE session_id = ? AND provider_id = ?",
    [sessionId, providerId],
  );
  return row?.api_key ?? null;
}

export function clearSessionKey(db: DbDatabase, sessionId: string, providerId: string): void {
  db.run("DELETE FROM provider_session_keys WHERE session_id = ? AND provider_id = ?", [
    sessionId,
    providerId,
  ]);
}

/** Remove every session-scoped key for a provider (used when it is deleted). */
export function clearProviderSessionKeys(db: DbDatabase, providerId: string): void {
  db.run("DELETE FROM provider_session_keys WHERE provider_id = ?", [providerId]);
}
