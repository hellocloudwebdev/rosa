/**
 * OpenAI-compatible adapter.
 *
 * Covers OpenAI itself and the large family of services that copy its API:
 * OpenRouter, Groq, Together, DeepSeek, Mistral, vLLM, Ollama, LM Studio and
 * the new-api/one-api gateways.
 *
 * This family is deliberately treated conservatively. Providers differ in what
 * they return from `/models` and in how they stream, so:
 *   - metadata is only reported when the provider actually states it, and
 *     anything we guess is marked `inferred`;
 *   - usage is only surfaced when it arrives in the stream (many gateways
 *     omit it, and we label token counts as unavailable rather than inventing
 *     them).
 */

import type {
  ChatRequestMessage,
  ChatStreamEvent,
  FinishReason,
} from "../../shared/types.ts";
import {
  type ChatRequestInput,
  type ChatRequestSpec,
  type DiscoveredModel,
  type NormalizedMetadata,
  type ProviderAdapter,
  type SseDecodeResult,
} from "./adapter.ts";

/** The strip of metadata we can parse from a provider's own model object. */
interface RawModel {
  id?: string;
  name?: string;
  context_length?: number | string;
  context_window?: number | string;
  max_output_tokens?: number | string;
  max_output?: number | string;
  max_tokens?: number | string;
  description?: string | null;
  owned_by?: string;
  pricing?: { prompt?: string | number; completion?: string | number; input?: string; output?: string };
  pricing_prompt?: string;
  pricing_completion?: string;
  input_price?: string | number;
  output_price?: string | number;
  modality?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_parameters?: string[];
  supported_features?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  /** OpenRouter groups some limits here. */
  top_provider?: { max_output_tokens?: number | string; max_completion_tokens?: number | string };
  /** Azure/OpenAI publish the context length under a nested object. */
  top_level?: number | string;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n) && value.trim() !== "") return n;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The error shapes an OpenAI-compatible gateway uses mid-stream. */
interface RawError {
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
    status?: number | string;
  };
  /** Some gateways put the failure at the top level instead. */
  message?: string;
  detail?: string;
}

/**
 * Read a mid-stream error out of a chunk.
 *
 * Providers disagree on the shape, and a few send `message` with no `error`
 * object, so both are accepted. Returns null when the chunk is ordinary.
 */
function extractStreamError(chunk: unknown): { message: string; retryable: boolean } | null {
  if (!chunk || typeof chunk !== "object") return null;
  const raw = chunk as RawError;
  const err = raw.error;
  if (!err && !raw.detail) return null;

  const message =
    str(err?.message) ??
    str(raw.detail) ??
    // A bare `{error: {...}}` with no readable message still deserves a name.
    (err ? "The provider reported an error while streaming." : null);
  if (!message) return null;

  // A 5xx or an explicit overload marker is worth retrying; a bad request is not.
  const status = num(err?.status);
  const type = (str(err?.type) ?? String(err?.code ?? "")).toLowerCase();
  const retryable =
    (status !== null && status >= 500) ||
    status === 429 ||
    type.includes("overload") ||
    type.includes("rate") ||
    type.includes("timeout") ||
    type.includes("unavailable");

  return { message, retryable };
}

/** Normalize one provider model object into our metadata shape. */
export function normalizeOpenAIModel(raw: RawModel): NormalizedMetadata | null {
  const modelId = str(raw.id);
  if (!modelId) return null;

  const contextWindow =
    num(raw.context_length) ??
    num(raw.context_window) ??
    num((raw as Record<string, unknown>)["context"]) ??
    null;

  const maxOutputTokens =
    num(raw.max_output_tokens) ??
    num(raw.max_output) ??
    num(raw.max_tokens) ??
    num(raw.top_provider?.max_output_tokens) ??
    num(raw.top_provider?.max_completion_tokens) ??
    null;

  const inputModalities =
    raw.architecture?.input_modalities ?? raw.input_modalities ?? null;
  const outputModalities =
    raw.architecture?.output_modalities ?? raw.output_modalities ?? null;

  const supported = [
    ...(raw.supported_parameters ?? []),
    ...(raw.supported_features ?? []),
  ].map((s) => s.toLowerCase());

  const visionFromModalities = (inputModalities ?? []).some((m) =>
    ["image", "vision"].includes(m.toLowerCase()),
  );

  const capabilities: NormalizedMetadata["capabilities"] = {};
  const inferred: string[] = [];

  // Only claim a capability when the provider states it. `tools` is the one
  // case we infer, because the presence of a `tools` parameter in a model's
  // supported_parameters is a reliable, provider-declared signal.
  if (visionFromModalities) capabilities.vision = true;
  if (supported.length > 0) {
    capabilities.tools = supported.some((s) => s === "tools" || s === "tool_choice" || s.startsWith("tool"));
    capabilities.structuredOutput = supported.some(
      (s) => s.includes("response_format") || s === "structured_outputs",
    );
  }
  if (inputModalities) {
    capabilities.inputModalities = (inputModalities as NormalizedMetadata["capabilities"]["inputModalities"])!.map(
      (m) => m.toLowerCase() as "text" | "image" | "audio" | "video" | "file",
    );
  }
  if (outputModalities) {
    capabilities.outputModalities = (outputModalities as NonNullable<NormalizedMetadata["capabilities"]["outputModalities"]>)!.map(
      (m) => m.toLowerCase() as "text" | "image" | "audio" | "video" | "file",
    );
  }

  // Pricing. OpenRouter sends strings like "0.0000001"; OpenAI-style gateways
  // send per-token floats. Both are converted to USD per million tokens.
  let inputPrice: number | null = null;
  let outputPrice: number | null = null;
  let priceNote: string | null = null;

  const perTokenIn = num(raw.input_price) ?? num(raw.pricing?.prompt) ?? num(raw.pricing?.input);
  const perTokenOut = num(raw.output_price) ?? num(raw.pricing?.completion) ?? num(raw.pricing?.output);

  if (perTokenIn !== null) inputPrice = perTokenIn * 1_000_000;
  if (perTokenOut !== null) outputPrice = perTokenOut * 1_000_000;

  const promptStr = str(raw.pricing_prompt) ?? str(raw.pricing?.prompt);
  const completionStr = str(raw.pricing_completion) ?? str(raw.pricing?.completion);
  if (inputPrice === null && promptStr) {
    priceNote = `Provider reports input pricing "${promptStr}" that we do not parse.`;
  } else if (outputPrice === null && completionStr) {
    priceNote = `Provider reports output pricing "${completionStr}" that we do not parse.`;
  }

  const source: NormalizedMetadata["source"] =
    contextWindow === null && inferred.length === 0 && !promptStr ? "inferred" : "provider";

  return {
    contextWindow,
    maxOutputTokens,
    description: str(raw.description) ?? str(raw.name),
    capabilities,
    inputPricePerMTokens: inputPrice,
    outputPricePerMTokens: outputPrice,
    priceNote,
    source,
  };
}

/** One streamed choice delta in OpenAI's format. */
interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: unknown[];
      role?: string;
    };
    finish_reason?: string | null;
    text?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  [key: string]: unknown;
}

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  max_tokens: "length",
  content_filter: "content-filter",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  end_turn: "stop",
  eos: "stop",
};

function toFinishReason(reason: string | null | undefined): FinishReason {
  if (!reason) return "unknown";
  return FINISH_REASONS[reason] ?? "unknown";
}

export const openAICompatibleAdapter: ProviderAdapter = {
  kind: "openai-compatible",

  buildChatRequest(input: ChatRequestInput): ChatRequestSpec {
    const url = `${input.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.credentials.apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (input.credentials.organizationId) {
      headers["openai-organization"] = input.credentials.organizationId;
    }

    const messages = input.messages.map((m: ChatRequestMessage) => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: input.modelId,
      messages,
      stream: true,
    };
    // Ask for usage on the final chunk. Providers that ignore it simply never
    // send usage, and we then report token counts as unavailable.
    body.stream_options = { include_usage: true };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;

    return { url, method: "POST", headers, body: JSON.stringify(body), signal: input.signal };
  },

  buildModelListRequest(baseUrl, credentials, signal): ChatRequestSpec {
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    return {
      url,
      method: "GET",
      signal,
      headers: {
        authorization: `Bearer ${credentials.apiKey}`,
        accept: "application/json",
        ...(credentials.organizationId ? { "openai-organization": credentials.organizationId } : {}),
      },
      body: "",
    };
  },

  parseModelList(raw: unknown): DiscoveredModel[] {
    const data = (raw as { data?: unknown })?.data ?? raw;
    if (!Array.isArray(data)) return [];
    const out: DiscoveredModel[] = [];
    for (const item of data) {
      const modelId = str((item as RawModel).id);
      if (!modelId) continue;
      const metadata = normalizeOpenAIModel(item as RawModel);
      if (!metadata) continue;
      out.push({
        modelId,
        name: str((item as RawModel).name) ?? modelId,
        metadata,
      });
    }
    return out;
  },

  decodeSseData(payload: string): SseDecodeResult {
    if (payload === "[DONE]" || payload === "DONE") return { events: [] };

    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIChunk;
    } catch {
      // Some gateways prefix chunks with "data: " inside the payload.
      if (payload.startsWith("data:")) {
        return openAICompatibleAdapter.decodeSseData(payload.slice(5).trim());
      }
      return { events: [] };
    }

    const events: ChatStreamEvent[] = [];
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? choice;

    // A provider can fail mid-stream, after a 200 and some content. That error
    // must surface as an error rather than being dropped: a stream that ends on
    // it would otherwise look like a truncated answer with no explanation.
    const streamError = extractStreamError(chunk);
    if (streamError) {
      return {
        events: [
          {
            type: "error",
            code: "provider_error",
            message: streamError.message,
            retryable: streamError.retryable,
          },
        ],
      };
    }

    // Reasoning content is folded into the normal delta stream: the client
    // keeps a separate buffer for it, so it still renders separately.
    const reasoning =
      (delta && "reasoning_content" in delta ? delta.reasoning_content : null) ??
      (delta && "reasoning" in delta ? delta.reasoning : null);
    if (typeof reasoning === "string" && reasoning.length > 0) {
      events.push({ type: "delta", text: reasoning });
    }

    const content = delta && "content" in delta ? delta.content : (choice?.text ?? null);
    if (typeof content === "string" && content.length > 0) {
      events.push({ type: "delta", text: content });
    }

    if (chunk.usage) {
      events.push({
        type: "meta",
        usage: {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        },
      });
    }

    const finishReason = choice?.finish_reason;
    if (finishReason) {
      // Usage frequently arrives on the final chunk after the finish reason,
      // but some providers send the finish chunk empty. Treat a finish reason
      // as authoritative and stop reading.
      return { events, finishReason: toFinishReason(finishReason) };
    }
    return { events };
  },
};
