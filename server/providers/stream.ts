/**
 * Provider execution.
 *
 * This module owns the details the user sees as errors: turning a failed HTTP
 * response into an honest, categorized message, redacting anything that could
 * be a credential from the provider's own text, and stopping when the client
 * aborts or the provider stalls.
 *
 * Two rules it enforces:
 *   - A failure in one pane never touches another. Each call owns its own
 *     AbortController and its own fetch.
 *   - Retries are explicit, never automatic. A 429 or 5xx surfaces to the
 *     client with `retryable`, and the client's Retry button is the only thing
 *     that re-issues the request, so a billable call is never duplicated
 *     silently.
 */

import type { ChatStreamEvent } from "../../shared/types.ts";
import { getAdapter } from "./registry.ts";
import type { ChatRequestInput } from "./adapter.ts";
import { redactSecrets, truncate } from "../security/redact.ts";
import { redactUrlForLog } from "../security/url.ts";

/** Classification of a failure, mapped to a stable client-facing code. */
export type FailureCode =
  | "invalid_api_key"
  | "unauthorized"
  | "forbidden"
  | "model_not_found"
  | "rate_limited"
  | "quota_exhausted"
  | "timeout"
  | "aborted"
  | "network_error"
  | "bad_gateway"
  | "server_error"
  | "bad_response"
  | "redirect_blocked"
  | "too_large"
  | "unknown";

export interface ProviderFailure {
  code: FailureCode;
  message: string;
  retryable: boolean;
  /** HTTP status, when we have one. */
  status?: number;
  /** Suggested client wait before retrying, in seconds. */
  retryAfterSeconds?: number;
}

export class ProviderError extends Error {
  readonly failure: ProviderFailure;
  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderError";
    this.failure = failure;
  }
}

/** Classify an HTTP status from the provider. */
export function classifyHttpStatus(status: number, retryAfterHeader?: string | null): ProviderFailure {
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;

  switch (status) {
    case 401:
      return {
        code: "invalid_api_key",
        message: "The provider rejected the API key (401). Check the key, its permissions and its expiry.",
        retryable: false,
        status,
      };
    case 403:
      return {
        code: "forbidden",
        message:
          "The provider refused the request (403). The key may lack access to this model, or your account may be restricted.",
        retryable: false,
        status,
      };
    case 404:
      return {
        code: "model_not_found",
        message: "The provider has no resource at that URL (404). Check the Base URL and the selected model id.",
        retryable: false,
        status,
      };
    case 408:
      return { code: "timeout", message: "The provider timed out before responding (408).", retryable: true, status };
    case 413:
      return {
        code: "too_large",
        message: "The provider rejected the request as too large (413). Shorten the conversation or reduce max tokens.",
        retryable: false,
        status,
      };
    case 422:
      return {
        code: "bad_response",
        message: "The provider rejected the request body (422). The model may not support a parameter that was sent.",
        retryable: false,
        status,
      };
    case 429: {
      const seconds = Number.isFinite(retryAfter) ? Number(retryAfter) : undefined;
      const wait = seconds && seconds > 0 ? ` Try again in ${seconds}s.` : "";
      return {
        code: "rate_limited",
        message: `The provider is rate limiting this key (429).${wait}`,
        retryable: true,
        status,
        retryAfterSeconds: seconds && seconds > 0 ? seconds : undefined,
      };
    }
    case 402:
      return {
        code: "quota_exhausted",
        message: "The provider reports exhausted credit or billing problems (402).",
        retryable: false,
        status,
      };
    default:
      if (status >= 500) {
        return {
          code: status === 502 || status === 503 || status === 504 ? "bad_gateway" : "server_error",
          message: `The provider returned a server error (${status}). This is usually temporary.`,
          retryable: true,
          status,
        };
      }
      return {
        code: "unknown",
        message: `The provider returned an unexpected status (${status}).`,
        retryable: false,
        status,
      };
  }
}

/** Classify a thrown network/abort error. */
export function classifyThrown(err: unknown): ProviderFailure {
  if (err instanceof ProviderError) return err.failure;

  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    // Distinguish our own timeout from a client abort by the signal state.
    return { code: "timeout", message: "The request timed out.", retryable: true };
  }

  const message = err instanceof Error ? redactSecrets(err.message) : String(err);
  const cause = err instanceof Error && err.cause ? String(err.cause) : "";
  const haystack = `${message} ${cause}`.toLowerCase();

  if (haystack.includes("abort")) {
    return { code: "aborted", message: "The request was cancelled.", retryable: false };
  }
  if (
    haystack.includes("fetch failed") ||
    haystack.includes("network") ||
    haystack.includes("econnrefused") ||
    haystack.includes("enotfound") ||
    haystack.includes("getaddrinfo")
  ) {
    return {
      code: "network_error",
      message: "Could not reach the provider. Check the Base URL and your network connection.",
      retryable: true,
    };
  }
  if (haystack.includes("redirect")) {
    return {
      code: "redirect_blocked",
      message: "The provider attempted a redirect, which is refused for security.",
      retryable: false,
    };
  }
  return { code: "unknown", message: "The provider request failed unexpectedly.", retryable: false };
}

/** Best-effort extraction of a provider's error message, with secrets removed. */
function extractProviderErrorText(raw: string, providerLabel: string): string {
  let text = raw.slice(0, 4000);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const error = (parsed.error ?? parsed.detail ?? parsed.message) as Record<string, unknown> | string | undefined;
    if (typeof error === "string") text = error;
    else if (error && typeof error === "object" && typeof error.message === "string") {
      text = error.message;
    } else if (typeof parsed.message === "string") {
      text = parsed.message;
    }
  } catch {
    /* not JSON — use the raw text */
  }
  return truncate(redactSecrets(text), 500) || `The ${providerLabel} request failed.`;
}

export interface StreamOptions {
  /** milliseconds of no data before we give up; 0 disables */
  timeoutMs: number;
}

export interface StreamResult {
  finishReason: string;
  inputTokens: number | null;
  outputTokens: number | null;
  contextWindow: number | null;
}

/**
 * Run one provider request and stream it out.
 *
 * The caller supplies an `onEvent` sink. Cancellation flows through `signal`;
 * SSE framing, usage collection and per-chunk error translation happen here so
 * no other part of the server has to know about provider stream shapes.
 */
export async function streamProviderResponse(
  input: ChatRequestInput,
  onEvent: (event: ChatStreamEvent) => void,
  options: StreamOptions = { timeoutMs: 120_000 },
): Promise<StreamResult> {
  const adapter = getAdapter(input.providerKind);
  const spec = adapter.buildChatRequest(input);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal.aborted) controller.abort();
  else input.signal.addEventListener("abort", onAbort);

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Distinguishes our own inactivity timeout from a caller-driven cancel: both
   * surface as an AbortError, but only the timeout is worth offering a retry
   * for, so the UI must be able to tell them apart.
   */
  let timedOut = false;
  const armTimer = () => {
    if (options.timeoutMs <= 0) return;
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("timeout", "TimeoutError"));
    }, options.timeoutMs);
  };

  let finishReason = "unknown";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let contextWindow: number | null = null;
  let sawDone = false;

  try {
    armTimer();
    const response = await fetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body.length > 0 ? spec.body : undefined,
      signal: controller.signal,
      // Never follow a redirect: a public URL that redirects to an internal
      // address is a classic SSRF bypass, and we refuse it rather than chase it.
      redirect: "manual",
      cache: "no-store",
    });

    if (response.status >= 300 && response.status < 400) {
      throw new ProviderError({
        code: "redirect_blocked",
        message: "The provider asked us to redirect, which is refused for security reasons.",
        retryable: false,
        status: response.status,
      });
    }

    if (!response.ok) {
      const raw = await safeReadText(response);
      const detail = extractProviderErrorText(raw, input.providerKind);
      const failure = classifyHttpStatus(response.status, response.headers.get("retry-after"));
      throw new ProviderError({ ...failure, message: detail });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body) {
      throw new ProviderError({
        code: "bad_response",
        message: "The provider returned an empty response body.",
        retryable: true,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    /**
     * Consume one `data:` payload.
     *
     * Both the frame loop and the trailing flush call this, so the `[DONE]`
     * sentinel, usage collection and error translation can never diverge. They
     * did once: the flush path did not recognise `[DONE]`, so whenever the
     * sentinel shared a chunk with the frame before it, a perfectly good
     * response was reported as truncated.
     */
    const consumePayload = (rawData: string): void => {
      if (rawData === "[DONE]" || rawData === "DONE") {
        sawDone = true;
        return;
      }
      const result = adapter.decodeSseData(rawData);
      for (const event of result.events) {
        if (event.type === "meta") {
          if (event.usage?.inputTokens !== undefined) inputTokens = event.usage.inputTokens;
          if (event.usage?.outputTokens !== undefined) outputTokens = event.usage.outputTokens;
          if (event.contextWindow !== undefined) contextWindow = event.contextWindow;
          // Meta is part of the client contract, so it is forwarded: the
          // metrics panel shows the provider's own token counts, not a guess.
          onEvent(event);
        } else if (event.type === "error") {
          throw new ProviderError({
            code: "bad_response",
            message: redactSecrets(event.message),
            retryable: event.retryable,
          });
        } else {
          onEvent(event);
        }
      }
      if (result.finishReason) {
        finishReason = result.finishReason;
        sawDone = true;
      }
    };

    const consumeFrame = (frame: string): void => {
      for (const rawData of extractDataLines(frame)) consumePayload(rawData);
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      armTimer();
      const { done, value } = await reader.read();
      if (done) break;
      armTimer();

      buffer += decoder.decode(value, { stream: true });

      // A chunk can hold several frames, so drain every complete one rather
      // than only the first.
      for (;;) {
        const boundary = findFrameBoundary(buffer);
        if (boundary === -1) break;
        consumeFrame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
      }
    }

    // Trailing bytes with no closing blank line: still a real frame in every
    // provider that omits the final separator.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) consumeFrame(buffer);

    if (!sawDone) {
      // The connection closed without a terminator. Treat as truncated rather
      // than silently succeeding, because a partial answer presented as
      // complete would be dishonest.
      throw new ProviderError({
        code: "bad_response",
        message: "The provider closed the stream without finishing the response.",
        retryable: true,
      });
    }

    void contentType;
    return { finishReason, inputTokens, outputTokens, contextWindow };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const failure = classifyThrown(err);
    // The caller's signal is the one the user's Stop button holds. Firing it is
    // a deliberate cancel — never retryable — even though the thrown error is
    // indistinguishable from the ones our timer produces.
    if (!timedOut && input.signal.aborted) {
      throw new ProviderError({
        code: "aborted",
        message: "The request was cancelled.",
        retryable: false,
      });
    }
    throw new ProviderError(failure);
  } finally {
    clearTimeout(inactivityTimer);
    input.signal.removeEventListener("abort", onAbort);
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Pull the `data:` payloads out of one SSE frame, ignoring comments. */
/**
 * Locate the end of the first complete SSE frame in `buffer`.
 *
 * Frames are separated by a blank line, which is `\n\n` or `\r\n\r\n`. The
 * earlier `\n\n` wins, so a CRLF stream is still split at the right place: in
 * `...\r\n\r\n`, the `\n\r` in the middle is not a separator, and the first
 * genuine `\n\n` is the one that ends it.
 *
 * Returns the separator's index and length, or -1 when no frame is complete yet.
 */
function findFrameBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

export function extractDataLines(frame: string): string[] {
  return frame
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.length > 0 && !l.startsWith(":"));
}

/** For tests and logs: never reveal the key, only the endpoint. */
export function describeEndpoint(spec: { url: string; method: string }): string {
  return `${spec.method} ${redactUrlForLog(spec.url)}`;
}
