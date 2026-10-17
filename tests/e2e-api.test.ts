/**
 * End-to-end tests for the account-scoped API surface.
 *
 * These drive the real router over a real SQLite database with real session
 * cookies. They exist mainly because ownership checks are where a repository is
 * easiest to get subtly wrong: a query whose placeholders and bind values are
 * out of order still compiles, still runs, and still returns no rows — so it
 * looks like a 404 rather than a bug, and a delete that silently does nothing
 * looks like success.
 *
 * What it proves:
 *   - a provider can be created, listed, renamed and deleted through the API;
 *   - the API key never comes back in a response;
 *   - a refused Base URL is reported with a reason and is not stored;
 *   - a conversation round-trips messages, and delete actually deletes;
 *   - deleting a folder keeps the conversations inside it;
 *   - one account's rows are invisible and untouchable to another.
 */

import test from "node:test";
import assert from "node:assert/strict";
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
const SECRET = ["sk", "api", "test", "placeholder"].join("-");

interface Account {
  userId: string;
  cookie: string;
}

interface Ctx extends Account {
  /** Call the API as this account (or as another one, by passing its cookie). */
  call: (path: string, init?: RequestInit, as?: Account) => Promise<Response>;
  /** Add a second signed-in account in the same database. */
  addAccount: (email: string) => Promise<Account>;
  close: () => void;
}

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), "rosa-api-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  const handle = createServer(db);

  const makeAccount = async (email: string): Promise<Account> => {
    const user = createUser(db, {
      email,
      displayName: email.split("@")[0] ?? email,
      authProvider: "local",
      passwordHash: await hashPassword("account-password-value"),
    });
    const session = createSession(db, user.id, { userAgent: "api-test" });
    return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.id}` };
  };

  const owner = await makeAccount("owner@example.com");

  return {
    ...owner,
    async addAccount(email) {
      return makeAccount(email);
    },
    async call(path, init = {}, as) {
      const headers = new Headers(init.headers);
      headers.set("cookie", (as ?? owner).cookie);
      if (init.body) headers.set("content-type", "application/json");
      return handle(new Request(`http://api.test${path}`, { ...init, headers }));
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createProvider(api: Ctx, overrides: Record<string, unknown> = {}) {
  const res = await api.call("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      displayName: "Test provider",
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: SECRET,
      credentialMode: "per-request",
      ...overrides,
    }),
  });
  return res;
}

test("a provider is created, listed, renamed and deleted", async () => {
  const api = await boot();
  try {
    const created = await createProvider(api, { displayName: "My OpenAI" });
    assert.equal(created.status, 201, await created.clone().text());
    const body = await jsonBody<{ provider: { id: string; displayName: string } }>(created);
    assert.equal(body.provider.displayName, "My OpenAI");

    // The key is never echoed back, not even truncated into the JSON.
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(SECRET), "the API key must not be returned");

    const listed = await jsonBody<{ items: Array<{ id: string }> }>(await api.call("/api/providers"));
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.id, body.provider.id);

    const renamed = await api.call(`/api/providers/${body.provider.id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "Renamed" }),
    });
    assert.equal(renamed.status, 200, await renamed.clone().text());
    assert.equal(
      (await jsonBody<{ provider: { displayName: string } }>(renamed)).provider.displayName,
      "Renamed",
    );

    const deleted = await api.call(`/api/providers/${body.provider.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200, await deleted.clone().text());

    const after = await jsonBody<{ items: unknown[] }>(await api.call("/api/providers"));
    assert.equal(after.items.length, 0, "the delete actually removed the row");
  } finally {
    api.close();
  }
});

test("a refused Base URL is reported with a reason and not stored", async () => {
  const api = await boot();
  try {
    const cases: Array<[string, string]> = [
      ["http://127.0.0.1:11434/v1", "local_url_blocked"],
      ["file:///etc/passwd", "unsupported_scheme"],
      ["http://169.254.169.254/latest", "local_url_blocked"],
    ];
    for (const [baseUrl, expected] of cases) {
      const res = await createProvider(api, { baseUrl });
      assert.equal(res.status, 400, `${baseUrl} must be refused`);
      const body = await jsonBody<{ error?: { code?: string; message?: string } }>(res);
      assert.equal(body.error?.code, expected, `${baseUrl} → ${expected}`);
      // The message has to explain what to do instead, not just say no.
      assert.ok((body.error?.message ?? "").length > 20, "the refusal explains itself");
    }

    const listed = await jsonBody<{ items: unknown[] }>(await api.call("/api/providers"));
    assert.equal(listed.items.length, 0, "nothing was stored");
  } finally {
    api.close();
  }
});

test("a conversation round-trips messages and can be deleted", async () => {
  const api = await boot();
  try {
    const created = await api.call("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "First chat" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const convo = await jsonBody<{ conversation: { id: string } }>(created);
    const id = convo.conversation.id;

    const saved = await api.call(`/api/conversations/${id}/messages/save`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "Hello there", requestId: "req-1" }),
    });
    // Saving creates a message row, so the answer is 201 like every other
    // create in this API — not 200, which is reserved for updates.
    assert.equal(saved.status, 201, await saved.clone().text());

    const fetched = await jsonBody<{ messages: Array<{ content: string; role: string }> }>(
      await api.call(`/api/conversations/${id}`),
    );
    assert.equal(fetched.messages.length, 1);
    assert.equal(fetched.messages[0]?.content, "Hello there");
    assert.equal(fetched.messages[0]?.role, "user");

    const renamed = await api.call(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed chat" }),
    });
    assert.equal(renamed.status, 200, await renamed.clone().text());
    const listed = await jsonBody<{ items: Array<{ id: string; title: string }> }>(
      await api.call("/api/conversations"),
    );
    assert.equal(listed.items.find((c) => c.id === id)?.title, "Renamed chat");

    const deleted = await api.call(`/api/conversations/${id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200, await deleted.clone().text());

    // This is the assertion that fails when the repository's bind order is wrong:
    // the delete reports success while the row stays put.
    const after = await jsonBody<{ items: unknown[] }>(await api.call("/api/conversations"));
    assert.equal(after.items.length, 0, "the conversation is gone");
    assert.equal((await api.call(`/api/conversations/${id}`)).status, 404);
  } finally {
    api.close();
  }
});

test("deleting a folder keeps the conversations inside it", async () => {
  const api = await boot();
  try {
    const folder = await jsonBody<{ folder: { id: string; name: string } }>(
      await api.call("/api/folders", { method: "POST", body: JSON.stringify({ name: "Work" }) }),
    );
    const convo = await jsonBody<{ conversation: { id: string } }>(
      await api.call("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "In a folder" }),
      }),
    );

    const moved = await api.call(`/api/conversations/${convo.conversation.id}/folder`, {
      method: "POST",
      body: JSON.stringify({ folderId: folder.folder.id }),
    });
    assert.equal(moved.status, 200, await moved.clone().text());

    const renamed = await api.call(`/api/folders/${folder.folder.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Work (renamed)" }),
    });
    assert.equal(renamed.status, 200, await renamed.clone().text());
    assert.equal((await jsonBody<{ folder: { name: string } }>(renamed)).folder.name, "Work (renamed)");

    assert.equal((await api.call(`/api/folders/${folder.folder.id}`, { method: "DELETE" })).status, 200);
    assert.equal(
      (await api.call(`/api/conversations/${convo.conversation.id}`)).status,
      200,
      "the conversation survives its folder",
    );
    const folders = await jsonBody<{ items: unknown[] }>(await api.call("/api/folders"));
    assert.equal(folders.items.length, 0, "the folder delete actually removed the row");
  } finally {
    api.close();
  }
});

test("one account cannot see or touch another account's rows", async () => {
  const api = await boot();
  const other = await api.addAccount("intruder@example.com");
  try {
    const convo = await jsonBody<{ conversation: { id: string } }>(
      await api.call("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Private" }),
      }),
    );
    const folder = await jsonBody<{ folder: { id: string } }>(
      await api.call("/api/folders", { method: "POST", body: JSON.stringify({ name: "Private" }) }),
    );
    const provider = await jsonBody<{ provider: { id: string } }>(
      await createProvider(api, { displayName: "Private provider" }),
    );

    // Reads are invisible, and the answer is 404 rather than 403 so the id's
    // existence is not confirmed.
    assert.equal((await api.call(`/api/conversations/${convo.conversation.id}`, {}, other)).status, 404);
    assert.equal(
      (await api.call(`/api/conversations/${convo.conversation.id}/export`, {}, other)).status,
      404,
    );

    // Writes and deletes must fail too, and must not report success.
    assert.equal(
      (await api.call(`/api/conversations/${convo.conversation.id}`, { method: "DELETE" }, other)).status,
      404,
    );
    assert.equal(
      (
        await api.call(
          `/api/folders/${folder.folder.id}`,
          { method: "PATCH", body: JSON.stringify({ name: "Stolen" }) },
          other,
        )
      ).status,
      404,
    );
    assert.equal(
      (await api.call(`/api/providers/${provider.provider.id}`, { method: "DELETE" }, other)).status,
      404,
    );

    // The intruder's own lists are empty, so nothing leaked sideways either.
    for (const path of ["/api/conversations", "/api/folders", "/api/providers", "/api/models"]) {
      const body = await jsonBody<{ items?: unknown[] }>(await api.call(path, {}, other));
      assert.equal((body.items ?? []).length, 0, `${path} is empty for the other account`);
    }

    // The owner still sees everything, untouched.
    assert.equal((await api.call(`/api/conversations/${convo.conversation.id}`)).status, 200);
    assert.equal(
      (await jsonBody<{ items: Array<{ name: string }> }>(await api.call("/api/folders"))).items[0]?.name,
      "Private",
    );
    // Providers are listed but have no GET-by-id route, so owner visibility is
    // checked the same way the folder above is: through the list.
    const ownerProviders = await jsonBody<{ items: Array<{ id: string }> }>(
      await api.call("/api/providers"),
    );
    assert.ok(
      ownerProviders.items.some((p) => p.id === provider.provider.id),
      "the owner still sees the provider the intruder could not delete",
    );
  } finally {
    api.close();
  }
});

test("a signed-in account is told it is signed in, and an anonymous one is refused", async () => {
  const api = await boot();
  try {
    const me = await jsonBody<{ user: { email: string; displayName: string } }>(
      await api.call("/api/auth/me"),
    );
    assert.equal(me.user.email, "owner@example.com");
    // The password hash is server-side only and must never appear here.
    assert.ok(!JSON.stringify(me).includes("pbkdf2"), "no credential material in the response");
  } finally {
    api.close();
  }
});

test("an unauthenticated request is refused on every account-scoped route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rosa-anon-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  const handle = createServer(db);
  try {
    for (const path of [
      "/api/providers",
      "/api/models",
      "/api/conversations",
      "/api/folders",
      "/api/auth/me",
    ]) {
      const res = await handle(new Request(`http://api.test${path}`));
      assert.equal(res.status, 401, `${path} must require a session`);
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "unauthenticated");
    }

    // A chat request without a session must not reach a provider at all.
    const chat = await handle(
      new Request("http://api.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "p", modelId: "m", messages: [{ role: "user", content: "x" }] }),
      }),
    );
    assert.equal(chat.status, 401);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forged session cookie is not accepted", async () => {
  const api = await boot();
  try {
    for (const forged of [
      `${SESSION_COOKIE}=${"a".repeat(32)}`,
      `${SESSION_COOKIE}=not-a-session-id`,
      `${SESSION_COOKIE}=`,
    ]) {
      const res = await api.call(
        "/api/conversations",
        { headers: { cookie: forged } },
        { userId: "x", cookie: forged },
      );
      assert.equal(res.status, 401, `${forged} must be refused`);
    }
  } finally {
    api.close();
  }
});
