/**
 * Shared domain types used by both the client and the server.
 *
 * This file is imported by the browser bundle and by Node/Workers, so it must
 * not import anything platform-specific.
 */

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

/**
 * A provider adapter kind. `openai-compatible` covers the large family of
 * services that speak the OpenAI API (including OpenAI itself, OpenRouter,
 * Groq, Together, vLLM, Ollama, LM Studio, new-api/one-api gateways...).
 * `anthropic` uses its own auth, streaming and model-listing formats.
 */
export type ProviderKind = "openai-compatible" | "anthropic";

/** Built-in provider presets offered in the add-provider dialog. */
export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Default base URL the user starts from. */
  baseUrl: string;
  /** Whether the provider exposes a model-listing endpoint. */
  supportsModelDiscovery: boolean;
  docsUrl?: string;
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    supportsModelDiscovery: true,
    docsUrl: "https://platform.openai.com/docs/api-reference/models",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    supportsModelDiscovery: true,
    docsUrl: "https://openrouter.ai/docs/api-reference/list-available-models",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    supportsModelDiscovery: true,
    docsUrl: "https://console.groq.com/docs/models",
  },
  {
    id: "together",
    name: "Together AI",
    kind: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    supportsModelDiscovery: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    supportsModelDiscovery: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    supportsModelDiscovery: true,
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    supportsModelDiscovery: true,
    hint: "Local server. Only usable when this app is served from the same machine.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    supportsModelDiscovery: true,
    hint: "Local server. Only usable when this app is served from the same machine.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    supportsModelDiscovery: true,
    docsUrl: "https://docs.anthropic.com/en/api/models-list",
  },
];

/** Where a stored API key lives. */
export type CredentialMode =
  /** Held in memory for the current tab/session only; never persisted. */
  | "session"
  /** Encrypted at rest with the server master key. */
  | "encrypted"
  /** Sent per-request from the browser; never stored server-side. */
  | "per-request";

/** A provider configuration as returned to the client. */
export interface ProviderConfig {
  id: string;
  displayName: string;
  kind: ProviderKind;
  baseUrl: string;
  /**
   * Never the key itself. Tells the client whether a key exists and how it is
   * stored so it can render the right affordances.
   */
  credentialMode: CredentialMode;
  hasKey: boolean;
  keyPreview: string | null;
  organizationId: string | null;
  /** Result of the last connection test. */
  connectionStatus: ConnectionStatus;
  /** Number of models fetched from the provider's listing endpoint. */
  discoveredModelCount: number;
  /** ISO timestamp of the last successful connection, or null. */
  lastConnectedAt: string | null;
  createdAt: string;
}

export type ConnectionStatus =
  | "untested"
  | "testing"
  | "ok"
  | "error"
  | "rate-limited"
  | "unreachable";

/** Model-discovery lifecycle for a provider. */
export type DiscoveryStatus = "never" | "running" | "ok" | "error";

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export type Modality = "text" | "image" | "audio" | "video" | "file";

/**
 * Model capabilities. Each field is optional so we can distinguish "the
 * provider said yes" from "the provider never told us".
 */
export interface Capabilities {
  vision?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  inputModalities?: Modality[];
  outputModalities?: Modality[];
}

/**
 * Where a piece of model metadata came from. The model library separates
 * `provider` facts from `inferred` or `manual` ones and labels them.
 */
export type MetadataSource = "provider" | "inferred" | "manual";

export interface ModelMetadata {
  /** Context window in tokens. */
  contextWindow?: number | null;
  /** Maximum output tokens, when the provider publishes one. */
  maxOutputTokens?: number | null;
  capabilities?: Capabilities;
  /** Provider-supplied description, trimmed by us. */
  description?: string | null;
  /** Price in USD per 1M tokens, when published by the provider. */
  inputPricePerMTokens?: number | null;
  outputPricePerMTokens?: number | null;
  /** Provider-reported pricing note text, when not parseable into numbers. */
  priceNote?: string | null;
  /** How the fields above were obtained. */
  source: MetadataSource;
  /** ISO timestamp when this metadata was captured. */
  fetchedAt: string;
}

/** A model available to the current user. */
export interface ModelRecord {
  /** Stable id: `${providerId}:${modelId}`. */
  id: string;
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  /** Provider-side model identifier used in requests. */
  modelId: string;
  /** Display name, defaulting to the model id. */
  name: string;
  metadata: ModelMetadata;
  favourite: boolean;
  pinned: boolean;
  /** Whether the provider still listed this model on the last fetch. */
  available: boolean;
}

/* ------------------------------------------------------------------ */
/* Conversations, messages, streaming                                  */
/* ------------------------------------------------------------------ */

export type Role = "user" | "assistant" | "system";

export type MessageStatus =
  | "complete"
  | "cancelled"
  | "rate-limited"
  | "timed-out"
  | "failed";

/**
 * Every stored assistant message belongs to exactly one conversation and one
 * provider/model, which is what makes per-pane history and regeneration work.
 */
export interface StoredMessage {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
  /** Provider used for an assistant message. */
  providerId: string | null;
  modelId: string | null;
  modelName: string | null;
  /** Measured performance of the stored run. */
  metrics: MessageMetrics | null;
  status: MessageStatus;
  /** User-visible error message when status is not `complete`. */
  error: string | null;
}

export interface MessageMetrics {
  /** Request start until the first generated content token. */
  ttftMs: number | null;
  /** Request start until the first meaningful response content arrived. */
  timeToFirstResponseMs: number | null;
  /** Total elapsed time until completion or cancellation. */
  totalMs: number;
  outputTokens: number | null;
  inputTokens: number | null;
  /** Whether the provider explicitly reported the output token count. */
  providerReportedTokens: boolean;
  /** Output tokens per second, null when the token count is unknown. */
  tokensPerSecond: number | null;
  /** True when token counts were estimated rather than provider-reported. */
  estimated: boolean;
  /** Documented context limit for the selected model, when known. */
  contextWindow: number | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  favourite: boolean;
  folderId: string | null;
  mode: ConversationMode;
  /** Number of panes (1..4) used in comparison mode. */
  paneCount: number;
  messageCount: number;
  preview: string | null;
}

export type ConversationMode = "single" | "compare";

export interface Folder {
  id: string;
  name: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

export interface UserProfile {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  authProvider: "google" | "github" | "local";
}

/* ------------------------------------------------------------------ */
/* API payloads                                                        */
/* ------------------------------------------------------------------ */

export interface CreateProviderRequest {
  displayName: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  organizationId?: string | null;
  credentialMode?: Exclude<CredentialMode, "encrypted">;
}

export interface UpdateProviderRequest {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  organizationId?: string | null;
  credentialMode?: Exclude<CredentialMode, "encrypted">;
}

export interface ChatRequestMessage {
  role: Role;
  content: string;
}

/** Body of a single-model chat request. */
export interface ChatRequestBody {
  providerId: string;
  modelId: string;
  messages: ChatRequestMessage[];
  temperature?: number;
  maxTokens?: number;
  conversationId?: string;
  /** Client-generated id used to correlate SSE events with the UI. */
  requestId?: string;
  /** Only set when the browser supplies the key per request. */
  apiKey?: string;
}

export interface ApiErrorBody {
  error: {
    message: string;
    /** Machine-readable code, e.g. `invalid_base_url`. */
    code: string;
    /** HTTP status suggested for this failure. */
    status?: number;
    /** Whether retrying this request could plausibly succeed. */
    retryable?: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* SSE protocol                                                        */
/* ------------------------------------------------------------------ */

/**
 * Server-sent events for one request. `delta` events carry content chunks,
 * `meta` carries provider-reported usage, `done` closes the stream, and
 * `error`/`cancelled` are terminal failures.
 */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "meta";
      usage?: { inputTokens?: number; outputTokens?: number };
      /** Context window the provider reports for the selected model. */
      contextWindow?: number;
    }
  | { type: "done"; finishReason: FinishReason }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "cancelled"; reason: "client-abort" | "timeout" | "server-shutdown" };

export type FinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "unknown";

/** Progress emitted by the model-discovery endpoint. */
export type DiscoverStreamEvent =
  | { type: "start"; baseUrl: string }
  | { type: "models"; added: number; updated: number }
  | { type: "done"; total: number }
  | { type: "error"; code: string; message: string };
