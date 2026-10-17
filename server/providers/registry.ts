/**
 * Adapter registry.
 *
 * New providers are added here, not in the chat UI. `getAdapter` is the only
 * lookup the API layer needs.
 */

import type { ProviderKind } from "../../shared/types.ts";
import { type ProviderAdapter, type DiscoveredModel, type NormalizedMetadata } from "./adapter.ts";
import { openAICompatibleAdapter } from "./openai-compatible.ts";
import { anthropicAdapter } from "./anthropic.ts";

const REGISTRY: Record<ProviderKind, ProviderAdapter> = {
  "openai-compatible": openAICompatibleAdapter,
  anthropic: anthropicAdapter,
};

export function getAdapter(kind: ProviderKind): ProviderAdapter {
  return REGISTRY[kind] ?? REGISTRY["openai-compatible"];
}

export function listAdapters(): Array<{ kind: ProviderKind; adapter: ProviderAdapter }> {
  return Object.entries(REGISTRY).map(([kind, adapter]) => ({
    kind: kind as ProviderKind,
    adapter,
  }));
}

export type { ProviderAdapter, DiscoveredModel, NormalizedMetadata };
