/**
 * A very small HTTP router.
 *
 * The app has ~25 routes, so a hand-rolled matcher beats pulling a framework
 * into a 64 MiB Worker bundle, and keeps route behavior identical between the
 * Node dev server and the Cloudflare Pages Function that serves production.
 *
 * Handlers are built by `createApi(db)`, which binds the database explicitly.
 * No module-level mutable state: the same code runs under tests, Node and
 * Workers without a global to reset in between.
 */

import { redactSecrets, truncate } from "../security/redact.ts";
import type { DbDriver } from "../db/types.ts";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";

/** The context every handler receives. */
export interface RequestContext {
  params: Record<string, string>;
  url: URL;
  db: DbDriver;
}

export type Handler = (
  req: Request,
  ctx: RequestContext,
) => Promise<Response> | Response;

interface Route {
  method: Method;
  /** Pattern with `:name` segments. */
  pattern: string;
  handler: Handler;
  /** Skip the auth check for this route. */
  public?: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler, opts: { public?: boolean } = {}): this {
    this.routes.push({ method, pattern, handler, public: opts.public });
    return this;
  }

  get(pattern: string, handler: Handler, opts?: { public?: boolean }): this {
    return this.add("GET", pattern, handler, opts);
  }
  post(pattern: string, handler: Handler, opts?: { public?: boolean }): this {
    return this.add("POST", pattern, handler, opts);
  }
  patch(pattern: string, handler: Handler, opts?: { public?: boolean }): this {
    return this.add("PATCH", pattern, handler, opts);
  }
  delete(pattern: string, handler: Handler, opts?: { public?: boolean }): this {
    return this.add("DELETE", pattern, handler, opts);
  }

  /** Dispatch a request. Returns null when no route matched. */
  async handle(req: Request, db: DbDriver): Promise<Response | null> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase() as Method;

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPattern(route.pattern, url.pathname);
      if (!params) continue;
      try {
        return await route.handler(req, { params, url, db });
      } catch (err) {
        // An HttpError is a deliberate, typed answer: keep its status and code.
        if (err instanceof HttpError) {
          return jsonError(err.status, err.code, err.message, { retryable: err.retryable });
        }
        // Anything else is a bug. Report it without leaking internals — the
        // message is redacted and truncated in case it echoed part of a request.
        return jsonError(500, "internal_error", truncate(redactSecrets(errorMessage(err)), 300));
      }
    }
    return null;
  }

  /** Every route this router knows about, for documentation and auth wiring. */
  listRoutes(): Array<{ method: Method; pattern: string; public: boolean }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern, public: r.public === true }));
  }
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    const actual = pathParts[i];
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (p !== actual) return null;
  }
  return params;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: { message, code, ...extra } }, status);
}

/** SSE response with the headers that stop proxies from buffering. */
export function sseResponse(body: ReadableStream<Uint8Array>): Response {
  const headers = new Headers();
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("connection", "keep-alive");
  // nginx-style buffers that ignore Cache-Control.
  headers.set("x-accel-buffering", "no");
  return new Response(body, { status: 200, headers });
}

/** Format one SSE event with a JSON payload. */
export function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function readJson<T>(req: Request, maxBytes = 1_000_000): Promise<T> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Send a JSON body.");
  }
  const text = await req.text();
  if (text.length === 0) throw new HttpError(400, "empty_body", "Send a JSON body.");
  if (text.length > maxBytes) {
    throw new HttpError(413, "payload_too_large", `Request body exceeds ${maxBytes} bytes.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Wrap a handler so thrown HttpErrors become clean JSON responses. */
export function withErrors(handler: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonError(err.status, err.code, err.message, { retryable: err.retryable });
      }
      return jsonError(500, "internal_error", "The server could not complete the request.");
    }
  };
}

/** Random request id for correlating logs without storing user data. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
