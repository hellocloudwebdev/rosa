/**
 * Anthropic adapter.
 *
 * Anthropic is the reason the adapter registry exists: it differs from the
 * OpenAI-compatible family in four ways that all matter.
 *
 *   1. Auth. It uses `x-api-key` plus a required `anthropic-version` header,
 *      not `Authorization: Bearer`.
 *   2. System prompt. There is no `system` role; it is a top-level field, and
 *      consecutive system messages must be joined.
 *   3. Streaming shape. SSE events carry a `type` discriminator
 *      (`content_block_delta`, `message_start`, `message_delta`, ...), and
 *      usage arrives inside `message_start`/`message_delta` rather than as a
 *      trailing chunk.
 *   4. Model listing. `/models` returns `{ data: [{ id, display_name, ... }] }`
 *      with no context-window or pricing metadata at all, so we label those
 *      fields unknown rather than guessing.
 */

import type { ChatRequestMessage, ChatStreamEvent, FinishReason } from "../../shared/types.ts";
import {
  type ChatRequestInput,
  type ChatRequestSpec,
  type DiscoveredModel,
  type NormalizedMetadata,
  type ProviderAdapter,
  type SseDecodeResult,
} from "./adapter.ts";

/** Bump with Anthropic's API revisions; see their versioning docs. */
const ANTHROPIC_VERSION = "2023-06-01";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
/**
 * Split OpenAI-style messages into Anthropic's `system` + `messages` form.
 * `system` messages are joined into one string; everything else is passed
 * through, which is what Anthropic expects for user/assistant turns.
 */
export function splitAnthropicMessages(messages: ChatRequestMessage[]): {
  system: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const rest: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = rest[rest.length - 1];
    if (last && last.role === role) {
      last.content += `\n\n${m.content}`;
    } else {
      rest.push({ role, content: m.content });
    }
  }

  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : null, messages: rest };
}

interface AnthropicStreamEvent {
  type?: string;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  } | null;
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string } | null;
}

const ANTHROPIC_STOP: Record<string, FinishReason> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool-calls",
  pause_turn: "stop",
};

export const anthropicAdapter: ProviderAdapter = {
  kind: "anthropic",

  buildChatRequest(input: ChatRequestInput): ChatRequestSpec {
    const url = `${input.baseUrl.replace(/\/$/, "")}/messages`;
    const { system, messages } = splitAnthropicMessages(input.messages);

    const headers: Record<string, string> = {
      "x-api-key": input.credentials.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (input.credentials.organizationId) {
      headers["anthropic-organization"] = input.credentials.organizationId;
    }

    const body: Record<string, unknown> = {
      model: input.modelId,
      messages,
      stream: true,
      max_tokens: input.maxTokens ?? 4096,
    };
    if (system) body.system = system;
    if (input.temperature !== undefined) body.temperature = input.temperature;

    return { url, method: "POST", headers, body: JSON.stringify(body), signal: input.signal };
  },

  buildModelListRequest(baseUrl, credentials, signal): ChatRequestSpec {
    return {
      url: `${baseUrl.replace(/\/$/, "")}/models`,
      method: "GET",
      signal,
      headers: {
        "x-api-key": credentials.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        accept: "application/json",
      },
      body: "",
    };
  },

  parseModelList(raw: unknown): DiscoveredModel[] {
    const data = (raw as { data?: unknown })?.data ?? raw;
    if (!Array.isArray(data)) return [];

    const out: DiscoveredModel[] = [];
    for (const item of data) {
      const record = item as Record<string, unknown>;
      const modelId = str(record.id);
      if (!modelId) continue;

      // Anthropic publishes none of the metadata we display in /models, so
      // every field stays null and the UI shows it as unknown.
      const metadata: NormalizedMetadata = {
        contextWindow: null,
        maxOutputTokens: null,
        description: str(record.display_name) ?? null,
        capabilities: {},
        inputPricePerMTokens: null,
        outputPricePerMTokens: null,
        priceNote: null,
        source: "inferred",
      };
      out.push({
        modelId,
        name: str(record.display_name) ?? modelId,
        metadata,
      });
    }
    return out;
  },

  decodeSseData(payload: string): SseDecodeResult {
    if (!payload || payload === "[DONE]") return { events: [] };

    let event: AnthropicStreamEvent;
    try {
      event = JSON.parse(payload) as AnthropicStreamEvent;
    } catch {
      return { events: [] };
    }

    if (event.error) {
      return {
        events: [
          {
            type: "error",
            code: event.error.type ?? "provider_error",
            message: event.error.message ?? "Anthropic reported an error.",
            retryable: false,
          },
        ],
      };
    }

    const events: ChatStreamEvent[] = [];

    switch (event.type) {
      case "message_start": {
        const usage = event.message?.usage;
        if (usage?.input_tokens !== undefined) {
          events.push({
            type: "meta",
            usage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens ?? 0,
            },
          });
        }
        break;
      }
      case "content_block_delta": {
        const text = event.delta?.text ?? event.delta?.thinking;
        if (typeof text === "string" && text.length > 0) {
          events.push({ type: "delta", text });
        }
        break;
      }
      case "message_delta": {
        const usage = event.usage;
        if (usage?.output_tokens !== undefined) {
          events.push({
            type: "meta",
            usage: { outputTokens: usage.output_tokens },
          });
        }
        const stop = event.delta?.stop_reason;
        if (stop) {
          return { events, finishReason: ANTHROPIC_STOP[stop] ?? "unknown" };
        }
        break;
      }
      case "error": {
        return {
          events: [
            {
              type: "error",
              code: "provider_error",
              message: "Anthropic reported an error mid-stream.",
              retryable: false,
            },
          ],
        };
      }
      default:
        break;
    }

    return { events };
  },
};
