/**
 * The adapter contract every provider must satisfy.
 *
 * Adding a new provider means implementing this interface; nothing about the
 * chat UI needs to change. Adapters are pure request builders plus an SSE
 * decoder, which keeps them small enough to unit test with recorded fixtures.
 */

import type { ChatRequestMessage, ChatStreamEvent, FinishReason } from "../../shared/types.ts";

export interface ProviderCredentials {
  /** The user's API key. */
  apiKey: string;
  /** Optional project/organization identifier (OpenAI-compatible gateways). */
  organizationId?: string | null;
}

/** A normalized model description produced by discovery. */
export interface DiscoveredModel {
  modelId: string;
  name: string;
  metadata: NormalizedMetadata;
}

export interface NormalizedMetadata {
  contextWindow: number | null;
  maxOutputTokens: number | null;
  description: string | null;
  capabilities: {
    vision?: boolean;
    tools?: boolean;
    structuredOutput?: boolean;
    inputModalities?: ("text" | "image" | "audio" | "video" | "file")[];
    outputModalities?: ("text" | "image" | "audio" | "video" | "file")[];
  };
  inputPricePerMTokens: number | null;
  outputPricePerMTokens: number | null;
  priceNote: string | null;
  source: "provider" | "inferred";
}

/** Everything an adapter needs to build a request. */
export interface ChatRequestInput {
  providerKind: "openai-compatible" | "anthropic";
  baseUrl: string;
  credentials: ProviderCredentials;
  modelId: string;
  messages: ChatRequestMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Bubbles up from the fetch AbortSignal. */
  signal: AbortSignal;
}

export interface ChatRequestSpec {
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  /** Serialized JSON body; empty string for GET. */
  body: string;
  signal: AbortSignal;
}

/** Result of decoding one SSE line. `null` means "no meaningful event". */
export interface SseDecodeResult {
  events: ChatStreamEvent[];
  /** Finish reason seen on the stream, if any. */
  finishReason?: FinishReason;
}

export interface ProviderAdapter {
  readonly kind: "openai-compatible" | "anthropic";
  /** Build the HTTP request for a chat completion. */
  buildChatRequest(input: ChatRequestInput): ChatRequestSpec;
  /** Build the HTTP request that lists models. */
  buildModelListRequest(
    baseUrl: string,
    credentials: ProviderCredentials,
    signal: AbortSignal,
  ): ChatRequestSpec;
  /** Parse a model-listing response body into normalized models. */
  parseModelList(raw: unknown): DiscoveredModel[];
  /** Decode one SSE data payload into normalized events. */
  decodeSseData(payload: string): SseDecodeResult;
}

/** Headers that are always allowed; user-supplied headers are never forwarded. */
export function baseHeaders(credentials: ProviderCredentials): Record<string, string> {
  return {
    authorization: `Bearer ${credentials.apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream",
  };
}

let _sseBuffer = "";
export function parseSseChunk(chunk: string): string[] {
  _sseBuffer += chunk;
  const parts = _sseBuffer.split(/\r?\n\r?\n/);
  _sseBuffer = parts.pop() ?? "";
  const events: string[] = [];
  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("data:")) {
        events.push(line.slice(5).trimStart());
      }
    }
  }
  return events;
}
