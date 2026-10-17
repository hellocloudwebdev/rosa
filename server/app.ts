/**
 * The HTTP surface of the app: one place that wires routes, resolves the
 * session, applies the security headers, and serves the built frontend.
 *
 * Deliberately small. There is no framework, because the routes are known and
 * few, and every dependency here is code we can read. The same handler runs
 * under Node (`server/entry.ts`) and, in production, behind Cloudflare Pages
 * Functions (`functions/api/[[route]].ts`).
 *
 * The API layer's factories take a context *getter* rather than a context, so
 * they can be built once while the context itself is rebuilt per request. That
 * getter is the only shared mutable state in this file, and it is assigned
 * synchronously before any `await` in the dispatch path — never read after one
 * — so concurrent requests cannot observe each other's context.
 */

import type { DbDatabase } from "./db/index.ts";
import { Router, json, newRequestId } from "./api/router.ts";
import type { AppContext } from "./api/context.ts";
import { validateBaseUrl } from "./security/url.ts";
import { handleChat } from "./api/chat.ts";
import { createModelApi } from "./api/models.ts";
import { createProviderRoutes } from "./api/providers.ts";
import { createConversationApi, createFolderApi, createAccountApi } from "./api/conversations.ts";
import { resolveUser, handleLogin, handleLogout, handleLogoutAll, handleOAuthCallback, handleOAuthStart, handleRegister } from "./api/auth.ts";
import { PROVIDER_PRESETS } from "../shared/types.ts";
import { consumeRateLimit } from "./db/repositories/auth.ts";

/**
 * Routes that need no session. Everything else is authenticated by default,
 * which is the safe default to forget to override.
 */
const PUBLIC_ROUTES = new Set([
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/health",
  "/api/providers/presets",
  "/api/providers/validate-url",
]);

/** OAuth is public by pattern: two providers, each with a callback route. */
const OAUTH_ROUTE = /^\/api\/auth\/oauth\/(google|github)(\/callback)?$/;

/**
 * Per-route rate limits for the cheap, abusable endpoints. Keyed on the exact
 * path; `:id` routes are not rate limited here because the handler already
 * scopes the work to one user's rows.
 */
const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  "/api/chat": { limit: 120, windowMs: 60_000 },
};

export function createServer(db: DbDatabase): (req: Request) => Promise<Response> {
  /**
   * Mutable slot the API layer reads through. Dispatch fills it at the top of
   * each request, before any await, and clears it in a finally.
   */
  const holder: { value: AppContext | null } = { value: null };
  const ctx = (): AppContext => {
    if (!holder.value) throw new Error("The request context was read outside of a dispatch.");
    return holder.value;
  };

  const providers = createProviderRoutes(ctx);
  const models = createModelApi(ctx);
  const conversations = createConversationApi(ctx);
  const folders = createFolderApi(ctx);
  const account = createAccountApi(ctx);

  const router = new Router();

  /* ---- health and metadata ---- */
  router.get("/api/health", () => json({ ok: true, version: 1 }), { public: true });
  router.get("/api/providers/presets", () => json({ presets: PROVIDER_PRESETS }), {
    public: true,
  });
  router.post(
    "/api/providers/validate-url",
    async (req) => {
      const body = (await req.json().catch(() => ({}))) as { baseUrl?: string };
      const check = validateBaseUrl(body.baseUrl ?? "");
      if (!check.ok) return json({ ok: false, code: check.code, message: check.message });
      return json({ ok: true, url: check.url.toString() });
    },
    { public: true },
  );

  /* ---- auth ---- */
  router.post("/api/auth/login", (req) => handleLogin(ctx(), req), { public: true });
  router.post("/api/auth/register", (req) => handleRegister(ctx(), req), { public: true });
  router.post("/api/auth/logout", (req) => handleLogout(ctx(), req), { public: true });
  router.post("/api/auth/logout-all", (req) => handleLogoutAll(ctx(), req), { public: true });
  router.get("/api/auth/me", account.me);
  router.get(
    "/api/auth/oauth/:provider",
    (req, c) => handleOAuthStart(ctx(), c.params.provider as "google" | "github", req),
    { public: true },
  );
  router.get(
    "/api/auth/oauth/:provider/callback",
    (req, c) => handleOAuthCallback(ctx(), c.params.provider as "google" | "github", req),
    { public: true },
  );

  /* ---- providers and credentials ---- */
  router.get("/api/providers", providers.list);
  router.post("/api/providers", providers.create);
  router.patch("/api/providers/:id", providers.update);
  router.delete("/api/providers/:id", providers.remove);
  router.post("/api/providers/:id/session-key", providers.setSessionKey);
  router.delete("/api/providers/:id/session-key", providers.clearSessionKey);
  router.post("/api/providers/test", providers.test);
  router.post("/api/providers/:id/test", providers.test);
  router.delete("/api/credentials", providers.deleteAllCredentials);

  /* ---- models ---- */
  router.get("/api/models", models.list);
  router.patch("/api/models/:id/favourite", models.favourite);
  router.patch("/api/models/:id/pin", models.pin);
  router.get("/api/providers/:id/discover/freshness", models.freshness);
  router.post("/api/providers/:id/discover", models.discover);

  /* ---- conversations, folders, account ---- */
  router.get("/api/conversations", conversations.list);
  router.post("/api/conversations", conversations.create);
  router.get("/api/conversations/:id", conversations.get);
  router.patch("/api/conversations/:id", conversations.rename);
  router.delete("/api/conversations/:id", conversations.remove);
  router.post("/api/conversations/:id/pin", conversations.pin);
  router.post("/api/conversations/:id/favourite", conversations.favourite);
  router.post("/api/conversations/:id/mode", conversations.mode);
  router.post("/api/conversations/:id/folder", conversations.move);
  router.post("/api/conversations/:id/messages", conversations.createMessage);
  router.post("/api/conversations/:id/messages/save", conversations.saveMessage);
  router.post("/api/conversations/:id/truncate", conversations.truncateAfter);
  router.patch("/api/messages/:id", conversations.updateMessage);
  router.get("/api/conversations/:id/export", conversations.export);
  router.post("/api/conversations/clear-history", conversations.clearHistory);

  router.get("/api/folders", folders.list);
  router.post("/api/folders", folders.create);
  router.patch("/api/folders/:id", folders.rename);
  router.delete("/api/folders/:id", folders.remove);

  router.delete("/api/account", account.deleteAccount);

  /* ---- chat ---- */
  router.post("/api/chat", (req) => handleChat(ctx(), req));

  return (req: Request) => dispatch(router, req, db, holder);
}

/**
 * Resolve the session, rate limit, dispatch, and attach security headers.
 *
 * `holder` is the mutable slot the API layer reads through; it is filled here
 * so the whole request sees exactly one context.
 */
async function dispatch(
  router: Router,
  req: Request,
  db: DbDatabase,
  holder: { value: AppContext | null },
): Promise<Response> {
  const url = new URL(req.url);

  // CORS preflight exists only for the dev proxy; in production the app and API
  // share an origin, so no Access-Control-Allow-Origin is ever needed.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      },
    });
  }

  // The cookie is the only input that decides who the caller is. It is read
  // synchronously, so holder.value is live before any later await.
  const { user, sessionId } = resolveUser({ db } as AppContext, req);
  holder.value = {
    db,
    user,
    sessionId,
    origin: `${url.protocol}//${url.host}`,
    requestId: newRequestId(),
  };

  try {
    const rate = RATE_LIMITS[url.pathname];
    if (rate && user) {
      const gate = consumeRateLimit(db, "api", user.id, rate.limit, rate.windowMs);
      if (!gate.allowed) {
        return json(
          {
            error: {
              code: "rate_limited",
              message: `Too many requests. Try again in ${gate.retryAfterSeconds} seconds.`,
              retryable: true,
            },
          },
          429,
        );
      }
    }

    const response = await router.handle(req, db);
    if (!response) {
      return json({ error: { code: "not_found", message: "No such endpoint." } }, 404);
    }

    // Handlers check `ctx.user` themselves; this is the backstop for a route
    // that was added without the public flag.
    const isPublic = PUBLIC_ROUTES.has(url.pathname) || OAUTH_ROUTE.test(url.pathname);
    if (!isPublic && !user) {
      return json({ error: { code: "unauthenticated", message: "Sign in to continue." } }, 401);
    }

    return withSecurityHeaders(response, url.pathname);
  } finally {
    holder.value = null;
  }
}

/**
 * Headers on every response. `no-store` on API responses matters: a cached or
 * shared response would leak one user's conversations to another.
 */
function withSecurityHeaders(response: Response, path: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-opener-policy", "same-origin");
  if (path.startsWith("/api/")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Serve the built SPA from disk, with index.html as the fallback. */
export async function serveStatic(req: Request, distDir: string): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return null;

  const { readFile } = await import("node:fs/promises");
  const { join, normalize, resolve } = await import("node:path");

  const root = resolve(distDir);
  // Reject traversal before joining, and re-check after, because `normalize`
  // on a raw string is not enough to contain `..` across separators.
  const requested = normalize(decodeURIComponent(url.pathname));
  if (requested.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  const filePath = join(root, requested);
  if (!filePath.startsWith(root)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const body = await readFile(filePath);
    return new Response(body, { headers: { "content-type": contentTypeFor(filePath) } });
  } catch {
    // SPA fallback, but never for a missing asset that has an extension.
    if (/\.[a-z0-9]+$/i.test(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const index = await readFile(join(root, "index.html"));
      return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch {
      return new Response(
        "The frontend has not been built yet. Run `npm run build` first.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
  }
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}
