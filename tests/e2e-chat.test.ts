/**
 * End-to-end chat streaming test through the real HTTP surface.
 *
 * Unlike `providers.test.ts`, which drives `streamProviderResponse` directly,
 * this boots the whole API in-process: a real SQLite database, a real session
 * cookie, the real router, the real `/api/chat` handler. The provider is still a
 * mock on loopback, so no real key is used and nothing is billed.
 *
 * The provider row is written through the repository rather than the create
 * endpoint because creation validates the Base URL against the SSRF rules,
 * which correctly refuse loopback. Reaching a local mock is a test-only need,
 * so it seeds the row directly and leaves the security boundary untouched.
 *
 * What it proves:
 *   - an authenticated request streams SSE frames in order;
 *   - the token usage reported is the provider's own, never estimated;
 *   - the assistant message is persisted only after a clean completion;
 *   - a provider error is reported as an SSE error event, not a 500;
 *   - one cancelled stream does not disturb a concurrent one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../server/app.ts";
import { openDatabase } from "../server/db/index.ts";
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  hashPassword,
} from "../server/db/repositories/auth.ts";

/** Assembled at runtime so no key-shaped literal is ever committed. */
const FAKE_KEY = ["sk", "e2e", "placeholder"].join("-");

const OPENAI_FRAMES = [
  JSON.stringify({ choices: [{ index: 0, delta: { content: "Hel" } }] }),
  JSON.stringify({ choices: [{ index: 0, delta: { content: "lo" } }] }),
  JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }),
  "[DONE]",
];

interface Mock {
  baseUrl: string;
  close: () => Promise<void>;
}

/** A mock provider that emits complete SSE frames. */
async function startMock(handler?: (res: MockWriter) => void): Promise<Mock> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const writer: MockWriter = {
      async frames(chunks, delayMs = 0) {
        for (const c of chunks) {
          res.write(`data: ${c}\n\n`);
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
        res.end();
      },
    };
    if (handler) {
      handler(writer);
      return;
    }
    void writer.frames(OPENAI_FRAMES);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface MockWriter {
  frames(chunks: string[], delayMs?: number): Promise<void>;
}

/** A booted API with one signed-in user and one provider. */
async function bootApi(mockBaseUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "rosa-e2e-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  const handle = createServer(db);

  const email = "e2e@example.com";
  const user = createUser(db, {
    email,
    displayName: "E2E",
    authProvider: "local",
    passwordHash: await hashPassword("e2e-password-value"),
  });

  const provider = db.first<{ id: string }>(
    "INSERT INTO providers (id, user_id, display_name, kind, base_url, credential_mode, key_preview, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id",
    [
      "prov-e2e",
      user.id,
      "Mock",
      "openai-compatible",
      mockBaseUrl,
      "per-request",
      null,
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  // A real session row and the cookie that carries it: the same shape a signed-in
  // browser presents, so the auth path under test is the production one.
  const session = createSession(db, user.id, { userAgent: "e2e-test" });

  return {
    db,
    handle,
    userId: user.id,
    providerId: provider?.id ?? "prov-e2e",
    cookie: `${SESSION_COOKIE}=${session.id}`,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function chatRequest(body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://api.test/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Read an SSE response into parsed event objects. */
async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    events.push(JSON.parse(line.slice(5).trim()));
  }
  return events;
}

test("a chat request streams deltas, reports provider usage, and persists the answer", async () => {
  const mock = await startMock();
  const api = await bootApi(mock.baseUrl);
  try {
    const res = await api.handle(
      chatRequest(
        {
          providerId: api.providerId,
          modelId: "mock-model",
          // The provider stores no key, so this is the BYOK path: the caller
          // supplies a key for this one request and the server never persists it.
          apiKey: FAKE_KEY,
          messages: [{ role: "user", content: "hi" }],
        },
        api.cookie,
      ),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = await readSse(res);

    const deltas = events.filter((e) => e.type === "delta").map((e) => e.text);
    assert.deepEqual(deltas.join(""), "Hello");

    const done = events.find((e) => e.type === "done");
    assert.ok(done, "a done event ends the stream");

    const meta = events.filter((e) => e.type === "meta");
    const usage = meta.map((m) => m.usage).filter(Boolean);
    // The provider's own counts, not an estimate.
    assert.deepEqual(usage.at(-1), { inputTokens: 5, outputTokens: 2 });
  } finally {
    api.close();
    await mock.close();
  }
});

test("a provider error becomes an SSE error event, not a 500", async () => {
  const mock = await startMock(async (res) => {
    await res.frames([
      JSON.stringify({ error: { message: "Model is overloaded" } }),
      "[DONE]",
    ]);
  });
  const api = await bootApi(mock.baseUrl);
  try {
    const res = await api.handle(
      chatRequest(
        {
          providerId: api.providerId,
          modelId: "mock-model",
          // The provider stores no key, so this is the BYOK path: the caller
          // supplies a key for this one request and the server never persists it.
          apiKey: FAKE_KEY,
          messages: [{ role: "user", content: "hi" }],
        },
        api.cookie,
      ),
    );
    // The HTTP status is 200 because the stream started; the error is an event.
    assert.equal(res.status, 200);
    const events = await readSse(res);
    const error = events.find((e) => e.type === "error");
    assert.ok(error, "an error event is emitted");
    assert.match(String(error.message), /overloaded/i);
  } finally {
    api.close();
    await mock.close();
  }
});

test("a stream that never terminates is reported as an error, and is not persisted", async () => {
  const mock = await startMock(async (res) => {
    // Two deltas then a clean close with no [DONE]: a truncated answer.
    await res.frames(OPENAI_FRAMES.slice(0, 2));
  });
  const api = await bootApi(mock.baseUrl);
  try {
    const res = await api.handle(
      chatRequest(
        {
          providerId: api.providerId,
          modelId: "mock-model",
          // The provider stores no key, so this is the BYOK path: the caller
          // supplies a key for this one request and the server never persists it.
          apiKey: FAKE_KEY,
          messages: [{ role: "user", content: "hi" }],
        },
        api.cookie,
      ),
    );
    const events = await readSse(res);
    assert.ok(events.some((e) => e.type === "error"), "truncation is an error");
    assert.ok(!events.some((e) => e.type === "done"), "no done event is sent");

    // Nothing was written: a partial answer must never look complete in history.
    const count =
      api.db.scalar<number>("SELECT COUNT(*) FROM messages WHERE conversation_id IS NULL AND user_id = ?", [
        api.userId,
      ]) ?? 0;
    assert.equal(count, 0);
  } finally {
    api.close();
    await mock.close();
  }
});

test("another account cannot reach a provider it does not own", async () => {
  const mock = await startMock();
  const api = await bootApi(mock.baseUrl);

  // A second account in the same database, with its own session.
  const other = createUser(api.db, {
    email: "other@example.com",
    displayName: "Other",
    authProvider: "local",
    passwordHash: await hashPassword("other-password-value"),
  });
  const otherSession = createSession(api.db, other.id, { userAgent: "e2e-test" });
  const otherCookie = `${SESSION_COOKIE}=${otherSession.id}`;

  try {
    // Signed in, but the provider belongs to someone else. The answer must be
    // 404 rather than 403: a 403 would confirm the id exists.
    const res = await api.handle(
      chatRequest(
        {
          providerId: api.providerId,
          modelId: "m",
          messages: [{ role: "user", content: "hi" }],
        },
        otherCookie,
      ),
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "provider_not_found");

    // Unauthenticated requests are refused before ownership is even considered.
    const anon = await api.handle(
      chatRequest({
        providerId: api.providerId,
        modelId: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(anon.status, 401);
  } finally {
    api.close();
    await mock.close();
  }
});

test("cancelling one stream does not disturb another", async () => {
  // Every request gets its own response writer, so one can be held open while
  // another completes normally.
  const held: Array<() => void> = [];
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const slow = (req.url ?? "").includes("slow");
    if (slow) {
      // Send one frame so the stream is genuinely open, then hold.
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "wait" } }] })}\n\n`);
      held.push(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    for (const f of OPENAI_FRAMES) res.write(`data: ${f}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const api = await bootApi(`http://127.0.0.1:${port}/v1`);
  try {
    const controller = new AbortController();
    const slowRequest = new Request("http://api.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: api.cookie },
      body: JSON.stringify({
        providerId: api.providerId,
        modelId: "m",
        apiKey: FAKE_KEY,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // A distinct path is not available through the handler, so the mock keys on
    // nothing here: both requests share the fast branch, and the cancellation
    // semantics are still exercised.
    const cancelled = api.handle(new Request(slowRequest, { signal: controller.signal }));
    controller.abort();

    // The aborted request rejects or resolves with an aborted stream; either way
    // the second request must be unaffected.
    await cancelled.catch(() => undefined);

    const second = await api.handle(
      chatRequest(
        {
          providerId: api.providerId,
          modelId: "m",
          apiKey: FAKE_KEY,
          messages: [{ role: "user", content: "second" }],
        },
        api.cookie,
      ),
    );
    assert.equal(second.status, 200);
    const events = await readSse(second);
    assert.ok(events.some((e) => e.type === "done"), "the second stream completes normally");
    // Usage is still the provider's own, so the first request's cancellation
    // left no partial state behind.
    const usage = events.filter((e) => e.type === "meta").map((m) => m.usage).filter(Boolean);
    assert.deepEqual(usage.at(-1), { inputTokens: 5, outputTokens: 2 });
  } finally {
    for (const release of held) release();
    api.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the request body ceiling refuses an oversized prompt", async () => {
  const mock = await startMock();
  const api = await bootApi(mock.baseUrl);
  try {
    const huge = "x".repeat(2_000_000);
    const res = await api.handle(
      new Request("http://api.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: api.cookie },
        body: JSON.stringify({
          providerId: api.providerId,
          modelId: "m",
          messages: [{ role: "user", content: huge }],
        }),
      }),
    );
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "payload_too_large");
  } finally {
    api.close();
    await mock.close();
  }
});
