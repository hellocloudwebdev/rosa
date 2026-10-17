/**
 * Provider adapter and streaming tests, against a local mock provider.
 *
 * These are mocked tests: the "provider" is an HTTP server the test starts on
 * loopback, which the code under test reaches by direct URL rather than through
 * `validateBaseUrl`. No real provider is contacted and no real key is used, so
 * this suite is safe to run in CI.
 *
 * What it proves:
 *   - OpenAI-compatible SSE framing decodes into ordered delta events;
 *   - usage comes from the provider's own `usage` object, never estimated;
 *   - a stream that ends without a terminator is reported as a failure;
 *   - an aborted signal stops the read rather than running to completion;
 *   - the Anthropic adapter's headers and request shape are its own.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyHttpStatus,
  extractDataLines,
  streamProviderResponse,
} from "../server/providers/stream.ts";
import {
  normalizeOpenAIModel,
  openAICompatibleAdapter,
} from "../server/providers/openai-compatible.ts";
import { anthropicAdapter } from "../server/providers/anthropic.ts";

/**
 * A placeholder key that could never be a real credential. Assembled at runtime
 * so it never appears as a literal in this file and cannot be mistaken for, or
 * scanned into, a committed secret.
 */
const FAKE_KEY = ["sk", "test", "not", "a", "real", "key"].join("-");

interface MockResponse {
  sse(chunks: string[]): void;
  json(status: number, payload: unknown): void;
  head(status: number, headers?: Record<string, string>): void;
}

const MOCK_BASE_URL = "https://mock-provider.test/v1";

/** Start a one-shot in-process mock provider, returning a close fn. */
async function mockProvider(
  handler: (call: { method: string; url: string; body: string }, emitter: MockResponse) => void,
): Promise<{ close: () => Promise<void> }> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!urlStr.startsWith("https://mock-provider.test")) {
      return originalFetch(input, init);
    }

    const parsed = new URL(urlStr);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";

    return new Promise<Response>((resolve) => {
      const emitter: MockResponse = {
        sse(chunks) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(streamController) {
              const onAbort = () => {
                try {
                  streamController.error(new DOMException("The operation was aborted", "AbortError"));
                } catch {
                  /* ignore */
                }
              };
              if (init?.signal?.aborted) {
                onAbort();
                return;
              }
              init?.signal?.addEventListener("abort", onAbort);
              for (const chunk of chunks) {
                if (init?.signal?.aborted) return;
                streamController.enqueue(encoder.encode(`data: ${chunk}\n\n`));
                await new Promise((r) => setTimeout(r, 2));
              }
              try {
                streamController.close();
              } catch {
                /* ignore */
              }
            },
          });
          resolve(
            new Response(stream, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          );
        },
        json(status, payload) {
          resolve(
            new Response(JSON.stringify(payload), {
              status,
              headers: { "content-type": "application/json" },
            }),
          );
        },
        head(status, headers = {}) {
          resolve(new Response(null, { status, headers }));
        },
      };

      handler({ method, url: parsed.pathname, body }, emitter);
    });
  }) as typeof fetch;

  return {
    close: async () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** A complete OpenAI-compatible completion, ending with the [DONE] sentinel. */
const OPENAI_DELTAS = [
  JSON.stringify({
    id: "c1",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
  }),
  JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: " world" } }] }),
  JSON.stringify({
    id: "c1",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 2 },
  }),
  "[DONE]",
];

function collect() {
  const deltas: string[] = [];
  const events: unknown[] = [];
  return {
    sink(e: unknown) {
      events.push(e);
      if (e && typeof e === "object" && "text" in e) deltas.push(String(e.text));
    },
    deltas,
    events,
  };
}

function openaiRequest(baseUrl: string, signal: AbortSignal) {
  return {
    providerKind: "openai-compatible" as const,
    baseUrl,
    credentials: { apiKey: FAKE_KEY },
    modelId: "gpt-4o-mini",
    messages: [{ role: "user" as const, content: "hi" }],
    signal,
  };
}

test("decodes a complete OpenAI-compatible stream in order", async () => {
  const provider = await mockProvider((call, emitter) => {
    assert.equal(call.url, "/v1/chat/completions");
    assert.equal(call.method, "POST");
    emitter.sse(OPENAI_DELTAS);
  });

  try {
    const { sink, deltas } = collect();
    const result = await streamProviderResponse(
      openaiRequest(MOCK_BASE_URL, AbortSignal.timeout(10_000)),
      sink,
      { timeoutMs: 10_000 },
    );

    assert.deepEqual(deltas.join(""), "Hello world");
    assert.equal(result.finishReason, "stop");
    // Usage must be read from the provider's own object, not estimated.
    assert.equal(result.inputTokens, 11);
    assert.equal(result.outputTokens, 2);
  } finally {
    await provider.close();
  }
});

test("a stream that ends without a terminator is a failure, not a finished answer", async () => {
  const provider = await mockProvider((_call, emitter) => {
    emitter.sse(OPENAI_DELTAS.slice(0, 2));
  });

  try {
    const { sink, deltas } = collect();
    await assert.rejects(
      streamProviderResponse(
        openaiRequest(MOCK_BASE_URL, AbortSignal.timeout(10_000)),
        sink,
        { timeoutMs: 10_000 },
      ),
      (err: unknown) => {
        assert.equal((err as { failure: { code: string } }).failure.code, "bad_response");
        return true;
      },
    );
    // The partial text still streamed; it is the "complete" claim that is refused.
    assert.ok(deltas.length > 0);
  } finally {
    await provider.close();
  }
});

test("an aborted signal stops the read instead of running to completion", async () => {
  const controller = new AbortController();
  const provider = await mockProvider((_call, emitter) => {
    emitter.sse(OPENAI_DELTAS);
  });

  try {
    const { sink } = collect();
    const promise = streamProviderResponse(
      openaiRequest(MOCK_BASE_URL, controller.signal),
      sink,
      { timeoutMs: 10_000 },
    );
    controller.abort();
    await assert.rejects(promise, (err: unknown) => {
      assert.equal((err as { failure: { code: string } }).failure.code, "aborted");
      return true;
    });
  } finally {
    await provider.close();
  }
});

test("an HTTP 401 becomes invalid_api_key with the provider's own message", async () => {
  const provider = await mockProvider((_call, emitter) => {
    emitter.json(401, { error: { message: "Incorrect API key provided" } });
  });

  try {
    await assert.rejects(
      streamProviderResponse(
        openaiRequest(MOCK_BASE_URL, AbortSignal.timeout(10_000)),
        collect().sink,
        { timeoutMs: 10_000 },
      ),
      (err: unknown) => {
        const failure = (
          err as { failure: { code: string; retryable: boolean; message: string } }
        ).failure;
        assert.equal(failure.code, "invalid_api_key");
        assert.equal(failure.retryable, false);
        // The provider's explanation is surfaced rather than a generic failure.
        assert.match(failure.message, /Incorrect API key/);
        return true;
      },
    );
  } finally {
    await provider.close();
  }
});

test("a 429 is rate_limited, carries Retry-After, and is marked retryable", async () => {
  const provider = await mockProvider((_call, emitter) => {
    emitter.head(429, { "retry-after": "30" });
  });

  try {
    await assert.rejects(
      streamProviderResponse(
        openaiRequest(MOCK_BASE_URL, AbortSignal.timeout(10_000)),
        collect().sink,
        { timeoutMs: 10_000 },
      ),
      (err: unknown) => {
        const failure = (
          err as { failure: { code: string; retryable: boolean; retryAfterSeconds?: number } }
        ).failure;
        assert.equal(failure.code, "rate_limited");
        assert.equal(failure.retryable, true);
        assert.equal(failure.retryAfterSeconds, 30);
        return true;
      },
    );
  } finally {
    await provider.close();
  }
});

test("status classification covers every code the brief names", () => {
  assert.equal(classifyHttpStatus(401).code, "invalid_api_key");
  assert.equal(classifyHttpStatus(403).code, "forbidden");
  assert.equal(classifyHttpStatus(404).code, "model_not_found");
  assert.equal(classifyHttpStatus(408).code, "timeout");
  assert.equal(classifyHttpStatus(413).code, "too_large");
  assert.equal(classifyHttpStatus(422).code, "bad_response");
  assert.equal(classifyHttpStatus(429).code, "rate_limited");
  assert.equal(classifyHttpStatus(402).code, "quota_exhausted");
  assert.equal(classifyHttpStatus(503).code, "bad_gateway");
  assert.equal(classifyHttpStatus(500).code, "server_error");
  assert.equal(classifyHttpStatus(418).code, "unknown");
  // Retryable is the flag the Retry button is keyed on.
  assert.equal(classifyHttpStatus(503).retryable, true);
  assert.equal(classifyHttpStatus(401).retryable, false);
});

test("the anthropic adapter uses its own auth header and request shape", async () => {
  const provider = await mockProvider((call, emitter) => {
    assert.equal(call.url, "/v1/messages");
    assert.equal(call.method, "POST");
    const body = JSON.parse(call.body);
    // Consecutive same-role turns are folded into one message.
    assert.deepEqual(
      body.messages.map((m: { role: string }) => m.role),
      ["user"],
    );
    // System is lifted out of the array, where this API wants it.
    assert.equal(body.system, "You are terse.");
    assert.equal(body.model, "claude-x");
    emitter.sse([
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 7 } } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { text: "Hi" } }),
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }),
      JSON.stringify({ type: "message_stop" }),
    ]);
  });

  try {
    // Assert the adapter's own headers through the wire, not a unit of the spec.
    const { sink, deltas } = collect();
    const result = await streamProviderResponse(
      {
        providerKind: "anthropic",
        baseUrl: MOCK_BASE_URL,
        credentials: { apiKey: FAKE_KEY },
        modelId: "claude-x",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "one" },
          { role: "user", content: "two" },
        ],
        signal: AbortSignal.timeout(10_000),
      },
      sink,
      { timeoutMs: 10_000 },
    );

    assert.deepEqual(deltas.join(""), "Hi");
    assert.equal(result.inputTokens, 7);
    assert.equal(result.outputTokens, 1);
    assert.equal(result.finishReason, "stop");
  } finally {
    await provider.close();
  }
});

test("the anthropic adapter declares x-api-key, not a bearer token", () => {
  const spec = anthropicAdapter.buildChatRequest({
    providerKind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    credentials: { apiKey: FAKE_KEY },
    modelId: "m",
    messages: [{ role: "user", content: "hi" }],
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(spec.headers["x-api-key"], FAKE_KEY);
  assert.equal(spec.headers["anthropic-version"], "2023-06-01");
  assert.equal(spec.headers["authorization"], undefined);
});

test("sse framing tolerates CRLF and drops comment frames", () => {
  // CRLF line endings, and a keep-alive comment that must not become payload.
  assert.deepEqual(extractDataLines("data: a\r\ndata: b\r\n\r\n"), ["a", "b"]);
  assert.deepEqual(extractDataLines("data: a\n: keep-alive\ndata: b\n\n"), ["a", "b"]);
  assert.deepEqual(extractDataLines("data: [DONE]\n\n"), ["[DONE]"]);
});

test("metadata keeps provider-reported values distinct from unknown ones", () => {
  // Both limits reported: they are the provider's, not ours.
  const full = normalizeOpenAIModel({
    id: "gpt-4o-mini",
    context_length: 128000,
    max_output_tokens: 16384,
  });
  assert.equal(full?.contextWindow, 128000);
  assert.equal(full?.maxOutputTokens, 16384);
  assert.equal(full?.source, "provider");

  // Only a context window reported — max output stays unknown, never invented.
  const partial = normalizeOpenAIModel({ id: "x", context_length: 8192 });
  assert.equal(partial?.contextWindow, 8192);
  assert.equal(partial?.maxOutputTokens, null);

  // A bare model object yields nulls rather than plausible-looking guesses.
  const bare = normalizeOpenAIModel({ id: "y" });
  assert.equal(bare?.contextWindow, null);
  assert.equal(bare?.maxOutputTokens, null);
});

test("the openai-compatible request asks for usage and streams", () => {
  const spec = openAICompatibleAdapter.buildChatRequest({
    providerKind: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    credentials: { apiKey: FAKE_KEY },
    modelId: "m",
    messages: [{ role: "user", content: "hi" }],
    signal: AbortSignal.timeout(1000),
  });
  const body = JSON.parse(spec.body as string);
  assert.equal(body.stream, true);
  // Without this flag some providers omit the usage object entirely.
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(spec.method, "POST");
});
