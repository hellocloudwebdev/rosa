/**
 * Node entry point: boots the database and serves the API plus the built SPA.
 *
 * `npm start` runs this after `npm run build`. `npm run dev` runs it against the
 * dev frontend, so both paths share one implementation.
 */

import { createServer } from "node:http";
import { createServer as createApi, serveStatic } from "./app.ts";
import { openDatabase } from "./db/index.ts";
import { log } from "./security/redact.ts";
import { purgeExpiredSessions, purgeRateLimits } from "./db/repositories/auth.ts";

const PORT = Number(process.env.PORT ?? process.env.ROSA_PORT ?? 8787);
const DIST = process.env.ROSA_DIST_DIR ?? "dist";

const db = openDatabase();
const handle = createApi(db);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  const request = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    // A body is only forwarded for methods that can carry one; undici needs the
    // explicit duplex flag for a streaming request body.
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    duplex: "half",
  } as RequestInit);

  try {
    const response = url.pathname.startsWith("/api/")
      ? await handle(request)
      : ((await serveStatic(request, DIST)) ?? (await handle(request)));

    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      // Stream rather than buffer: a chat response must reach the browser as it
      // is generated, and a buffered one would defeat SSE entirely.
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    log.error("request failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { code: "internal_error", message: "Request failed." } }));
  }
});

server.listen(PORT, () => {
  log.info("server listening", { port: PORT, db: db.path, schemaVersion: db.schemaVersion });
});

/**
 * Housekeeping. Two DELETEs on indexed columns, once at boot — a Worker runtime
 * has no timers worth spending on this, and a long-lived dev server is the only
 * case where rows accumulate.
 */
purgeExpiredSessions(db);
purgeRateLimits(db);

// Close cleanly so WAL mode does not leave a hot journal behind.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
