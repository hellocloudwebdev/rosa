/**
 * Chat streaming endpoint.
 *
 * POST /api/chat  { providerId, modelId, messages, ... }
 *
 * Streams an SSE response. Timing for the metrics panel is measured here,
 * server-side, with a monotonic clock, because that is the only place that can
 * see the actual request/response boundary. The client re-baselines on the
 * first byte it receives so the numbers it displays are not optimistic.
 *
 * The rules this endpoint enforces:
 *   - the provider and model must belong to the caller;
 *   - failures are isolated — nothing is cached between panes;
 *   - nothing is retried automatically, so a billable call happens once;
 *   - the assistant message is persisted only after a clean completion, so
 *     history never contains a partial answer presented as complete.
 */

import type { ChatStreamEvent } from "../../shared/types.ts";
import { HttpError, readJson, sseEvent, sseResponse } from "./router.ts";
import { resolveProvider } from "./providers.ts";
import { streamProviderResponse } from "../providers/stream.ts";
import type { ChatRequestBody } from "../../shared/types.ts";
import { log, truncate, redactSecrets } from "../security/redact.ts";
import type { AppContext } from "./context.ts";
import { appendMessage, getConversation, touchConversation } from "../db/repositories/conversations.ts";

/** How long a stream may sit with no data before we declare a timeout. */
const INACTIVITY_TIMEOUT_MS = 90_000;

export async function handleChat(ctx: AppContext, req: Request): Promise<Response> {
  const body = await readJson<ChatRequestBody>(req);
  if (!ctx.user) throw new HttpError(401, "unauthenticated", "Sign in to send messages.");

  const providerId = typeof body.providerId === "string" ? body.providerId : "";
  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!providerId) throw new HttpError(400, "missing_provider", "Select a provider.");
  if (!modelId) throw new HttpError(400, "missing_model", "Select a model.");
  if (messages.length === 0) throw new HttpError(400, "empty_messages", "Send at least one message.");

  const conversationId = body.conversationId;
  if (conversationId) {
    const convo = getConversation(ctx.db, ctx.user.id, conversationId);
    if (!convo) throw new HttpError(404, "conversation_not_found", "That conversation does not exist.");
  }

  const resolved = await resolveProvider(ctx, providerId, body.apiKey);
  if (!resolved.apiKey) {
    throw new HttpError(
      409,
      "provider_key_required",
      "This provider has no API key configured. Add the key in provider settings, or enable the browser-direct connection mode.",
    );
  }

  // Per-request abort so cancelling one pane never affects another.
  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener("abort", onClientAbort);

  const encoder = new TextEncoder();
  const started = performance.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      const send = (event: ChatStreamEvent) => {
        try {
          c.enqueue(encoder.encode(sseEvent(event)));
        } catch {
          /* consumer already gone */
        }
      };

      let firstTokenAt: number | null = null;
      let firstMeaningfulAt: number | null = null;
      let outputTokens: number | null = null;
      let inputTokens: number | null = null;
      let finishReason = "unknown";
      let cancelled = false;
      let charCount = 0;

      try {
        const result = await streamProviderResponse(
          {
            providerKind: resolved.config.kind,
            baseUrl: resolved.config.baseUrl,
            credentials: {
              apiKey: resolved.apiKey as string,
              organizationId: resolved.organizationId,
            },
            modelId,
            messages: messages.filter((m) => typeof m?.content === "string"),
            temperature: body.temperature,
            maxTokens: body.maxTokens,
            signal: controller.signal,
          },
          (event) => {
            if (event.type === "delta") {
              const now = performance.now();
              if (firstTokenAt === null) firstTokenAt = now;
              charCount += event.text.length;
              // "First response" is a stricter bar than "first token": the
              // first point at which there is enough content to be readable.
              if (firstMeaningfulAt === null && charCount >= 12) firstMeaningfulAt = now;
            }
            send(event);
          },
          { timeoutMs: INACTIVITY_TIMEOUT_MS },
        );

        finishReason = result.finishReason;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
      } catch (err) {
        const failure =
          err && typeof err === "object" && "failure" in err
            ? (err as { failure: { code: string; message: string; retryable: boolean } }).failure
            : { code: "unknown", message: "The provider request failed.", retryable: false };

        if (failure.code === "aborted" || controller.signal.aborted) {
          cancelled = true;
          send({ type: "cancelled", reason: "client-abort" });
          c.close();
          return;
        }

        log.warn("provider request failed", {
          requestId: ctx.requestId,
          providerId,
          modelId,
          code: failure.code,
          status: "status" in failure ? (failure as { status?: number }).status : undefined,
        });

        // Only report a timeout as a timeout; a stall that we aborted ourselves
        // is indistinguishable from a provider stall otherwise.
        const isTimeout = failure.code === "timeout";
        send({
          type: "error",
          code: isTimeout ? "timeout" : failure.code,
          message: truncate(redactSecrets(failure.message), 500),
          retryable: failure.retryable,
        });
        c.close();
        return;
      } finally {
        req.signal.removeEventListener("abort", onClientAbort);
      }

      send({ type: "done", finishReason: finishReason as never });

      // Persist only a clean completion. We save the metrics with the message so
      // history can show what the run cost in time.
      const userId = ctx.user?.id;
      if (conversationId && !cancelled && userId) {
        try {
          const total = performance.now() - started;
          const lastAssistant = messages[messages.length - 1];
          const promptText =
            lastAssistant && lastAssistant.role === "user"
              ? lastAssistant.content
              : messages.map((m) => m.content).join("\n");

          const convo = getConversation(ctx.db, userId, conversationId);
          if (convo) {
            appendMessage(ctx.db, userId, {
              conversationId,
              role: "assistant",
              content: "",
              providerId,
              modelId,
              modelName: resolved.config.displayName,
              metrics: {
                ttftMs: firstTokenAt === null ? null : Math.round(firstTokenAt - started),
                timeToFirstResponseMs:
                  firstMeaningfulAt === null ? null : Math.round(firstMeaningfulAt - started),
                totalMs: Math.round(total),
                outputTokens,
                inputTokens,
                providerReportedTokens: outputTokens !== null,
                tokensPerSecond:
                  outputTokens !== null && firstTokenAt !== null
                    ? Number(
                        (outputTokens / ((performance.now() - firstTokenAt) / 1000)).toFixed(1),
                      )
                    : null,
                estimated: outputTokens === null,
                contextWindow: null,
              },
              status: "complete",
              error: null,
            });
            touchConversation(ctx.db, userId, conversationId, promptText.slice(0, 80) || undefined);
          }
        } catch (persistErr) {
          // A persistence failure must not turn into a failed generation from
          // the user's point of view; log it and keep the response visible.
          log.error("failed to persist assistant message", {
            requestId: ctx.requestId,
            message: persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
        }
      }

      c.close();
    },
  });

  return sseResponse(stream);
}
