/**
 * Conversations, folders and messages.
 *
 * Every function takes `userId` first and filters on it. That is the whole
 * access-control story for history data, and it is why the schema repeats
 * `user_id` on messages even though conversation_id would be enough to reach
 * them through a join.
 */

import { uuid } from "./../types.ts";
import type { DbDatabase } from "./../node-driver.ts";
import {
  type Conversation,
  type ConversationMode,
  type Folder,
  type Role,
  type StoredMessage,
  type MessageMetrics,
  type MessageStatus,
} from "../../../shared/types.ts";

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  mode: string;
  pane_count: number;
  pinned: number;
  favourite: number;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: string;
  content: string;
  provider_id: string | null;
  model_id: string | null;
  model_name: string | null;
  metrics_json: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

function toConversation(
  row: ConversationRow,
  messageCount: number,
  preview: string | null,
): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
    favourite: row.favourite === 1,
    folderId: row.folder_id,
    mode: row.mode as ConversationMode,
    paneCount: row.pane_count,
    messageCount,
    preview,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  let metrics: MessageMetrics | null = null;
  if (row.metrics_json) {
    try {
      metrics = JSON.parse(row.metrics_json) as MessageMetrics;
    } catch {
      metrics = null;
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as Role,
    content: row.content,
    createdAt: row.created_at,
    providerId: row.provider_id,
    modelId: row.model_id,
    modelName: row.model_name,
    metrics,
    status: row.status as MessageStatus,
    error: row.error,
  };
}

/* ------------------------------------------------------------------ */
/* Folders                                                             */
/* ------------------------------------------------------------------ */

export function listFolders(db: DbDatabase, userId: string): Folder[] {
  return db.all<{ id: string; name: string; created_at: string }>(
    "SELECT id, name, created_at FROM folders WHERE user_id = ? ORDER BY name ASC",
    [userId],
  ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

export function createFolder(db: DbDatabase, userId: string, name: string): Folder {
  const id = uuid();
  const now = new Date().toISOString();
  db.run("INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, ?)", [
    id,
    userId,
    name.trim(),
    now,
  ]);
  return { id, name: name.trim(), createdAt: now };
}

export function renameFolder(
  db: DbDatabase,
  userId: string,
  folderId: string,
  name: string,
): Folder | null {
  const res = db.run("UPDATE folders SET name = ? WHERE id = ? AND user_id = ?", [
    name.trim(),
    folderId,
    userId,
  ]);
  if (res.changes === 0) return null;
  const row = db.first<{ id: string; name: string; created_at: string }>(
    "SELECT id, name, created_at FROM folders WHERE id = ? AND user_id = ?",
    [folderId, userId],
  );
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
}

/** Deleting a folder leaves conversations alive (folder_id becomes NULL). */
export function deleteFolder(db: DbDatabase, userId: string, folderId: string): boolean {
  const res = db.run("DELETE FROM folders WHERE id = ? AND user_id = ?", [folderId, userId]);
  return res.changes > 0;
}

export function assignConversationFolder(
  db: DbDatabase,
  userId: string,
  conversationId: string,
  folderId: string | null,
): boolean {
  if (folderId) {
    const owned = db.first<{ id: string }>("SELECT id FROM folders WHERE id = ? AND user_id = ?", [
      folderId,
      userId,
    ]);
    if (!owned) return false;
  }
  const res = db.run(
    "UPDATE conversations SET folder_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    [folderId, new Date().toISOString(), conversationId, userId],
  );
  return res.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

const CONVERSATION_SELECT = `
  SELECT c.*,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
         (SELECT content FROM messages m WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC LIMIT 1) AS preview
    FROM conversations c
`;

export interface ListConversationsOptions {
  folderId?: string | null;
  favouritesOnly?: boolean;
  pinnedOnly?: boolean;
  query?: string;
  /** 1-based page number. */
  page?: number;
  perPage?: number;
}

export function listConversations(
  db: DbDatabase,
  userId: string,
  options: ListConversationsOptions = {},
): { items: Conversation[]; total: number } {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(100, Math.max(1, options.perPage ?? 30));

  const where: string[] = ["c.user_id = ?"];
  const params: (string | number | null)[] = [userId];

  if (options.folderId !== undefined) {
    where.push("c.folder_id IS ?");
    params.push(options.folderId);
  }
  if (options.favouritesOnly) where.push("c.favourite = 1");
  if (options.pinnedOnly) where.push("c.pinned = 1");
  if (options.query && options.query.trim()) {
    where.push("(c.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?))");
    const like = `%${options.query.trim()}%`;
    params.push(like, like);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total =
    db.scalar<number>(`SELECT COUNT(*) FROM conversations c ${whereSql}`, params) ?? 0;

  const items = db
    .all<ConversationRow & { message_count: number; preview: string | null }>(
      `${CONVERSATION_SELECT} ${whereSql}
        ORDER BY c.pinned DESC, c.updated_at DESC
        LIMIT ? OFFSET ?`,
      [...params, perPage, (page - 1) * perPage],
    )
    .map((r) => toConversation(r, Number(r.message_count ?? 0), r.preview));

  return { items, total };
}

export function getConversation(db: DbDatabase, userId: string, id: string): Conversation | null {
  const row = db.first<ConversationRow & { message_count: number; preview: string | null }>(
    `${CONVERSATION_SELECT} WHERE c.id = ? AND c.user_id = ?`,
    [id, userId],
  );
  if (!row) return null;
  return toConversation(row, Number(row.message_count ?? 0), row.preview);
}

export function createConversation(
  db: DbDatabase,
  userId: string,
  input: { title?: string; mode?: ConversationMode; paneCount?: number; folderId?: string | null } = {},
): Conversation {
  const id = uuid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO conversations
       (id, user_id, title, mode, pane_count, pinned, favourite, folder_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    [
      id,
      userId,
      input.title?.trim() || "New conversation",
      input.mode ?? "single",
      Math.min(4, Math.max(1, input.paneCount ?? 1)),
      input.folderId ?? null,
      now,
      now,
    ],
  );
  return {
    id,
    title: input.title?.trim() || "New conversation",
    createdAt: now,
    updatedAt: now,
    pinned: false,
    favourite: false,
    folderId: input.folderId ?? null,
    mode: input.mode ?? "single",
    paneCount: Math.min(4, Math.max(1, input.paneCount ?? 1)),
    messageCount: 0,
    preview: null,
  };
}

export function updateConversationTitle(
  db: DbDatabase,
  userId: string,
  id: string,
  title: string,
): Conversation | null {
  const res = db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
    title.trim(),
    new Date().toISOString(),
    id,
    userId,
  ]);
  return res.changes > 0 ? getConversation(db, userId, id) : null;
}

export function setConversationPinned(
  db: DbDatabase,
  userId: string,
  id: string,
  pinned: boolean,
): boolean {
  return (
    db.run("UPDATE conversations SET pinned = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
      pinned ? 1 : 0,
      new Date().toISOString(),
      id,
      userId,
    ]).changes > 0
  );
}

export function setConversationFavourite(
  db: DbDatabase,
  userId: string,
  id: string,
  favourite: boolean,
): boolean {
  return (
    db.run("UPDATE conversations SET favourite = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
      favourite ? 1 : 0,
      new Date().toISOString(),
      id,
      userId,
    ]).changes > 0
  );
}

export function setConversationMode(
  db: DbDatabase,
  userId: string,
  id: string,
  mode: ConversationMode,
  paneCount: number,
): boolean {
  return (
    db.run("UPDATE conversations SET mode = ?, pane_count = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
      mode,
      Math.min(4, Math.max(1, paneCount)),
      new Date().toISOString(),
      id,
      userId,
    ]).changes > 0
  );
}

export function deleteConversation(db: DbDatabase, userId: string, id: string): boolean {
  return db.run("DELETE FROM conversations WHERE id = ? AND user_id = ?", [id, userId]).changes > 0;
}

export function deleteAllConversations(db: DbDatabase, userId: string): number {
  return db.run("DELETE FROM conversations WHERE user_id = ?", [userId]).changes;
}

/** Bump `updated_at` so the sidebar ordering reflects the newest message. */
export function touchConversation(
  db: DbDatabase,
  userId: string,
  id: string,
  title?: string,
): void {
  db.run(
    "UPDATE conversations SET updated_at = ?, title = COALESCE(?, title) WHERE id = ? AND user_id = ?",
    [new Date().toISOString(), title?.trim() ?? null, id, userId],
  );
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export function listMessages(
  db: DbDatabase,
  userId: string,
  conversationId: string,
  options: { before?: string; limit?: number } = {},
): { items: StoredMessage[]; hasMore: boolean } {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const before = options.before;
  const rows = before
    ? db.all<MessageRow>(
        `SELECT * FROM messages WHERE user_id = ? AND conversation_id = ? AND created_at < ?
           ORDER BY created_at DESC LIMIT ?`,
        [userId, conversationId, before, limit + 1],
      )
    : db.all<MessageRow>(
        `SELECT * FROM messages WHERE user_id = ? AND conversation_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        [userId, conversationId, limit + 1],
      );
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit).map(toMessage).reverse(), hasMore };
}

export function getMessage(db: DbDatabase, userId: string, id: string): StoredMessage | null {
  const row = db.first<MessageRow>(
    "SELECT * FROM messages WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return row ? toMessage(row) : null;
}

export interface AppendMessageInput {
  conversationId: string;
  role: Role;
  content: string;
  providerId?: string | null;
  modelId?: string | null;
  modelName?: string | null;
  metrics?: MessageMetrics | null;
  status?: MessageStatus;
  error?: string | null;
}

export function appendMessage(
  db: DbDatabase,
  userId: string,
  input: AppendMessageInput,
): StoredMessage {
  const id = uuid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO messages
       (id, conversation_id, user_id, role, content, provider_id, model_id, model_name,
        metrics_json, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.conversationId,
      userId,
      input.role,
      input.content,
      input.providerId ?? null,
      input.modelId ?? null,
      input.modelName ?? null,
      input.metrics ? JSON.stringify(input.metrics) : null,
      input.status ?? "complete",
      input.error ?? null,
      now,
    ],
  );
  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    createdAt: now,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    modelName: input.modelName ?? null,
    metrics: input.metrics ?? null,
    status: input.status ?? "complete",
    error: input.error ?? null,
  };
}

/** Rewrite a stored assistant message (used when a stream completes). */
export function updateMessage(
  db: DbDatabase,
  userId: string,
  id: string,
  patch: {
    content?: string;
    metrics?: MessageMetrics | null;
    status?: MessageStatus;
    error?: string | null;
  },
): StoredMessage | null {
  const existing = getMessage(db, userId, id);
  if (!existing) return null;
  const next: StoredMessage = {
    ...existing,
    content: patch.content ?? existing.content,
    metrics: patch.metrics === undefined ? existing.metrics : patch.metrics,
    status: patch.status ?? existing.status,
    error: patch.error === undefined ? existing.error : patch.error,
  };
  db.run(
    "UPDATE messages SET content = ?, metrics_json = ?, status = ?, error = ? WHERE id = ? AND user_id = ?",
    [
      next.content,
      next.metrics ? JSON.stringify(next.metrics) : null,
      next.status,
      next.error,
      id,
      userId,
    ],
  );
  return next;
}

/** Delete every message from `exclusiveFromId` onward in a conversation. */
export function deleteMessagesFrom(
  db: DbDatabase,
  userId: string,
  conversationId: string,
  exclusiveFromId: string,
): number {
  const anchor = db.first<{ created_at: string }>(
    "SELECT created_at FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?",
    [exclusiveFromId, conversationId, userId],
  );
  if (!anchor) return 0;
  return db.run(
    "DELETE FROM messages WHERE conversation_id = ? AND user_id = ? AND created_at >= ?",
    [conversationId, userId, anchor.created_at],
  ).changes;
}

/* ------------------------------------------------------------------ */
/* Export / import                                                     */
/* ------------------------------------------------------------------ */

export interface ConversationExport {
  conversation: Conversation;
  messages: StoredMessage[];
}

export function exportConversation(
  db: DbDatabase,
  userId: string,
  conversationId: string,
): ConversationExport | null {
  const conversation = getConversation(db, userId, conversationId);
  if (!conversation) return null;
  const rows = db.all<MessageRow>(
    "SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC",
    [conversationId, userId],
  );
  return { conversation, messages: rows.map(toMessage) };
}
