/**
 * Conversation, folder and account endpoints.
 *
 * Every handler re-checks ownership through the repository. Where the schema
 * already enforces it with `user_id`, the repository still filters on it, so a
 * future refactor that drops the filter cannot silently widen access.
 */

import { toCsv, toMarkdown } from "./export.ts";
import type { ConversationExport } from "./export.ts";
import { HttpError, json, readJson, withErrors } from "./router.ts";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  deleteMessagesFrom,
  deleteAllConversations,
  exportConversation,
  getConversation,
  listConversations,
  listMessages,
  setConversationFavourite,
  setConversationMode,
  setConversationPinned,
  touchConversation,
  updateConversationTitle,
  updateMessage,
} from "../db/repositories/conversations.ts";
import {
  assignConversationFolder,
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
} from "../db/repositories/conversations.ts";
import type { AppContext } from "./context.ts";
import { deleteUser } from "../db/repositories/auth.ts";
import { publicUser } from "./auth.ts";

/** Render a conversation as Markdown for export. */
export function conversationToMarkdown(exported: ConversationExport): string {
  return toMarkdown(exported);
}

interface CreateConversationBody {
  title?: string;
  mode?: "single" | "compare";
  paneCount?: number;
  folderId?: string | null;
}

/** Shared fallback so `.catch()` cannot widen `CreateConversationBody`. */
const EMPTY_CONVERSATION_BODY: CreateConversationBody = {};

export function createConversationApi(ctx: () => AppContext) {
  return {
    list: withErrors(async (_req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");

      const url = m.url;
      const page = Number(url.searchParams.get("page") ?? "1") || 1;
      const perPage = Number(url.searchParams.get("perPage") ?? "30") || 30;
      const query = url.searchParams.get("q") ?? undefined;
      const favourites = url.searchParams.get("favourites") === "1";
      const pinned = url.searchParams.get("pinned") === "1";
      const folderParam = url.searchParams.get("folderId");
      const folderId =
        folderParam === null ? undefined : folderParam === "" ? null : folderParam;

      const { items, total } = listConversations(c.db, c.user.id, {
        page,
        perPage,
        query,
        favouritesOnly: favourites,
        pinnedOnly: pinned,
        folderId,
      });

      return json({
        items,
        total,
        page,
        perPage,
        hasMore: page * perPage < total,
      });
    }),

    create: withErrors(async (_req) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      // An empty body is fine — a conversation with defaults is created.
      const body = await readJson<CreateConversationBody>(_req).catch(
        () => EMPTY_CONVERSATION_BODY,
      );

      const conversation = createConversation(c.db, c.user.id, {
        title: body.title,
        mode: body.mode,
        paneCount: body.paneCount,
        folderId: body.folderId,
      });
      return json({ conversation }, 201);
    }),

    get: withErrors(async (_req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const conversation = getConversation(c.db, c.user.id, m.params.id);
      if (!conversation) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");

      const url = m.url;
      const before = url.searchParams.get("before") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? "60") || 60;
      const { items, hasMore } = listMessages(c.db, c.user.id, m.params.id, { before, limit });
      return json({ conversation, messages: items, hasMore });
    }),

    rename: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ title: string }>(req);
      if (!body.title?.trim()) throw new HttpError(400, "empty_title", "Enter a title.");
      const conversation = updateConversationTitle(c.db, c.user.id, m.params.id, body.title);
      if (!conversation) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");
      return json({ conversation });
    }),

    pin: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ pinned: boolean }>(req);
      const ok = setConversationPinned(c.db, c.user.id, m.params.id, body.pinned === true);
      if (!ok) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");
      return json({ ok: true });
    }),

    favourite: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ favourite: boolean }>(req);
      const ok = setConversationFavourite(c.db, c.user.id, m.params.id, body.favourite === true);
      if (!ok) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");
      return json({ ok: true });
    }),

    mode: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ mode: "single" | "compare"; paneCount: number }>(req);
      const ok = setConversationMode(
        c.db,
        c.user.id,
        m.params.id,
        body.mode === "compare" ? "compare" : "single",
        Math.min(4, Math.max(1, body.paneCount ?? 1)),
      );
      if (!ok) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");
      return json({ ok: true });
    }),

    move: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ folderId: string | null }>(req);
      const ok = assignConversationFolder(c.db, c.user.id, m.params.id, body.folderId ?? null);
      if (!ok) throw new HttpError(404, "conversation_not_found", "That conversation or folder does not exist.");
      return json({ ok: true });
    }),

    remove: withErrors(async (_req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const ok = deleteConversation(c.db, c.user.id, m.params.id);
      if (!ok) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");
      return json({ ok: true });
    }),

    clearHistory: withErrors(async (_req) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const deleted = deleteAllConversations(c.db, c.user.id);
      return json({ ok: true, deleted });
    }),

    /** Store the user's turn (assistant turns are stored by the chat endpoint). */
    createMessage: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const conversation = getConversation(c.db, c.user.id, m.params.id);
      if (!conversation) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");

      const body = await readJson<{
        role: "user" | "assistant" | "system";
        content: string;
        providerId?: string;
        modelId?: string;
        modelName?: string;
      }>(req);
      if (typeof body.content !== "string" || body.content.trim().length === 0) {
        throw new HttpError(400, "empty_content", "Message content is required.");
      }

      const message = appendMessage(c.db, c.user.id, {
        conversationId: m.params.id,
        role: body.role,
        content: body.content,
        providerId: body.providerId ?? null,
        modelId: body.modelId ?? null,
        modelName: body.modelName ?? null,
      });
      touchConversation(c.db, c.user.id, m.params.id);
      return json({ message }, 201);
    }),

    /** Save a finished assistant reply (used when the client owns the stream). */
    saveMessage: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const conversation = getConversation(c.db, c.user.id, m.params.id);
      if (!conversation) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");
      const body = await readJson<{
        role: "user" | "assistant" | "system";
        content: string;
        providerId?: string;
        modelId?: string;
        modelName?: string;
        metrics?: Record<string, unknown> | null;
        status?: string;
        error?: string;
      }>(req);
      const message = appendMessage(c.db, c.user.id, {
        conversationId: m.params.id,
        role: body.role ?? "assistant",
        content: body.content,
        providerId: body.providerId ?? null,
        modelId: body.modelId ?? null,
        modelName: body.modelName ?? null,
        metrics: body.metrics ? (body.metrics as never) : null,
        status: (body.status as never) ?? "complete",
        error: body.error ?? null,
      });
      touchConversation(c.db, c.user.id, m.params.id);
      return json({ message }, 201);
    }),

    /** Truncate everything from a message onward, for edit-and-resubmit. */
    truncateAfter: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ afterMessageId: string }>(req);
      const deleted = deleteMessagesFrom(c.db, c.user.id, m.params.id, body.afterMessageId);
      touchConversation(c.db, c.user.id, m.params.id);
      return json({ ok: true, deleted });
    }),

    /** Update a stored message, e.g. to attach its metrics. */
    updateMessage: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{
        content?: string;
        metrics?: Record<string, unknown> | null;
        status?: string;
        error?: string;
      }>(req);
      const updated = updateMessage(c.db, c.user.id, m.params.id, {
        content: body.content,
        metrics: (body.metrics ?? undefined) as never,
        status: (body.status as never) ?? undefined,
        error: body.error,
      });
      if (!updated) throw new HttpError(404, "message_not_found", "That message does not exist.");
      return json({ message: updated });
    }),

    export: withErrors(async (_req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const format = m.url.searchParams.get("format") ?? "json";
      const exported = exportConversation(c.db, c.user.id, m.params.id);
      if (!exported) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");

      if (format === "markdown") {
        const body = toMarkdown(exported);
        return new Response(body, {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="${slug(exported.conversation.title)}.md"`,
          },
        });
      }
      if (format === "csv") {
        const body = toCsv(exported);
        return new Response(body, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${slug(exported.conversation.title)}-metrics.csv"`,
          },
        });
      }
      return json(exported, 200, {
        "content-disposition": `attachment; filename="${slug(exported.conversation.title)}.json"`,
      });
    }),
  };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "conversation"
  );
}

export function createFolderApi(ctx: () => AppContext) {
  const c = () => ctx();
  return {
    list: withErrors(async () => {
      const ctx = c();
      if (!ctx.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      return json({ items: listFolders(ctx.db, ctx.user.id) });
    }),
    create: withErrors(async (req) => {
      const ctx = c();
      if (!ctx.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ name: string }>(req);
      if (!body.name?.trim()) throw new HttpError(400, "empty_name", "Enter a folder name.");
      return json({ folder: createFolder(ctx.db, ctx.user.id, body.name) }, 201);
    }),
    rename: withErrors(async (req, m) => {
      const ctx = c();
      if (!ctx.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ name: string }>(req);
      const folder = renameFolder(ctx.db, ctx.user.id, m.params.id, body.name);
      if (!folder) throw new HttpError(404, "folder_not_found", "That folder does not exist.");
      return json({ folder });
    }),
    remove: withErrors(async (_req, m) => {
      const ctx = c();
      if (!ctx.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      if (!deleteFolder(ctx.db, ctx.user.id, m.params.id)) {
        throw new HttpError(404, "folder_not_found", "That folder does not exist.");
      }
      return json({ ok: true });
    }),
  };
}

export function createAccountApi(ctx: () => AppContext) {
  return {
    me: withErrors(async () => {
      const c = ctx();
      if (!c.user) return json({ user: null });
      return json({ user: publicUser(c.user) });
    }),

    /** Delete the account and every row it owns. */
    deleteAccount: withErrors(async () => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const ok = deleteUser(c.db, c.user.id);
      if (!ok) throw new HttpError(500, "delete_failed", "The account could not be deleted.");
      return json({ ok: true });
    }),
  };
}
