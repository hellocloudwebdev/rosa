/**
 * Model library endpoints.
 *
 * Discovery streams progress as it happens, because the request to a slow
 * provider can take tens of seconds and a bare spinner is worse than a live
 * count. Metadata is stored exactly as the provider reported it: models that
 * already exist keep their favourite/pinned flags and get a new `fetchedAt`,
 * and anything the provider stopped offering is marked unavailable rather than
 * deleted, so history of a conversation still names the right model.
 */

import type { MetadataSource, ModelMetadata, ModelRecord } from "../../shared/types.ts";
import { HttpError, json, jsonError, readJson, sseEvent, sseResponse, withErrors } from "./router.ts";
import { getAdapter } from "../providers/registry.ts";
import { validateBaseUrl } from "../security/url.ts";
import { truncate } from "../security/redact.ts";
import type { AppContext } from "./context.ts";
import { resolveProvider } from "./providers.ts";
import * as modelRepo from "../db/repositories/providers.ts";

/** Cap the stored model count so a provider cannot exhaust our storage. */
const MAX_MODELS_PER_PROVIDER = 500;

/** How long a provider listing may take before we give up. */
const DISCOVERY_TIMEOUT_MS = 45_000;

/** A recent-enough model list we are willing to show as fresh. */
const STALE_AFTER_MS = 1000 * 60 * 60 * 6;

export function createModelApi(ctx: () => AppContext) {
  return {
    list: withErrors(async (_req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");

      const url = m.url;
      const providerId = url.searchParams.get("providerId") ?? undefined;
      const favourites = url.searchParams.get("favourites") === "1";
      const query = url.searchParams.get("q")?.trim() || undefined;
      const capability = url.searchParams.get("capability") ?? undefined;

      let items = providerId
        ? modelRepo.listModelsByProvider(c.db, c.user.id, providerId)
        : modelRepo.listModels(c.db, c.user.id);

      if (favourites) items = items.filter((m) => m.favourite);
      if (query) {
        const q = query.toLowerCase();
        items = items.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.modelId.toLowerCase().includes(q) ||
            m.providerName.toLowerCase().includes(q),
        );
      }
      if (capability) {
        items = items.filter((m) => m.metadata.capabilities?.[capability as "vision"] === true);
      }

      return json({ items });
    }),

    favourite: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ favourite: boolean }>(req);
      const updated = modelRepo.setFavourite(c.db, c.user.id, m.params.id, body.favourite === true);
      if (!updated) throw new HttpError(404, "model_not_found", "That model does not exist.");
      return json({ model: updated });
    }),

    pin: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ pinned: boolean }>(req);
      const updated = modelRepo.setPinned(c.db, c.user.id, m.params.id, body.pinned === true);
      if (!updated) throw new HttpError(404, "model_not_found", "That model does not exist.");
      return json({ model: updated });
    }),

    /**
     * Discover/refresh models for a provider, streaming progress.
     * POST /api/providers/:id/discover
     */
    discover: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ apiKey?: string }>(req);
      const providerId = m.params.id;

      const resolved = await resolveProvider(c, providerId, body.apiKey);
      if (!resolved.apiKey) {
        throw new HttpError(
          409,
          "provider_key_required",
          "Add an API key for this provider before discovering models.",
        );
      }

      const encoder = new TextEncoder();
      const discovererUserId = c.user.id;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) => {
            try {
              controller.enqueue(encoder.encode(sseEvent(event)));
            } catch {
              /* client disconnected */
            }
          };

          const adapter = getAdapter(resolved.config.kind);
          send({ type: "start", baseUrl: resolved.config.baseUrl });

          const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
          try {
            const spec = adapter.buildModelListRequest(
              resolved.config.baseUrl,
              { apiKey: resolved.apiKey as string, organizationId: resolved.organizationId },
              signal,
            );
            const response = await fetch(spec.url, {
              method: spec.method,
              headers: spec.headers,
              signal,
              redirect: "manual",
              cache: "no-store",
            });

            if (response.status >= 300 && response.status < 400) {
              send({
                type: "error",
                code: "redirect_blocked",
                message: "The provider attempted a redirect, which is refused for security.",
              });
              controller.close();
              return;
            }
            if (!response.ok) {
              const code =
                response.status === 401
                  ? "invalid_api_key"
                  : response.status === 429
                    ? "rate_limited"
                    : response.status === 404
                      ? "discovery_not_supported"
                      : "provider_error";
              const message =
                response.status === 401
                  ? "The API key was rejected (401). Check the key."
                  : response.status === 429
                    ? "The provider is rate limiting this key (429)."
                    : response.status === 404
                      ? "This provider does not expose a model-listing endpoint. Add models manually."
                      : `The provider responded with ${response.status}.`;
              send({ type: "error", code, message });
              controller.close();
              return;
            }

            const raw = (await response.json().catch(() => null)) as unknown;
            let discovered: ReturnType<typeof adapter.parseModelList> = [];
            try {
              discovered = adapter.parseModelList(raw);
            } catch {
              discovered = [];
            }

            if (discovered.length === 0) {
              send({
                type: "error",
                code: "empty_model_list",
                message: "The provider returned no models. Some gateways require an extra header or path.",
              });
              controller.close();
              return;
            }

            const capped = discovered.slice(0, MAX_MODELS_PER_PROVIDER);
            const now = new Date().toISOString();
            let added = 0;
            let updated = 0;

            for (const model of capped) {
              const metadata: ModelMetadata = {
                contextWindow: model.metadata.contextWindow,
                maxOutputTokens: model.metadata.maxOutputTokens,
                capabilities: model.metadata.capabilities,
                description: truncate(model.metadata.description ?? "", 500) || null,
                inputPricePerMTokens: model.metadata.inputPricePerMTokens,
                outputPricePerMTokens: model.metadata.outputPricePerMTokens,
                priceNote: model.metadata.priceNote,
                source: (model.metadata.source ?? "provider") as MetadataSource,
                fetchedAt: now,
              };
              const outcome = modelRepo.upsertModel(c.db, discovererUserId, providerId, {
                id: `${providerId}:${model.modelId}`,
                modelId: model.modelId,
                name: model.name,
                metadata,
              });
              if (outcome === "inserted") added += 1;
              else updated += 1;
            }

            modelRepo.markUnavailable(c.db, discovererUserId, providerId);

            modelRepo.setConnectionStatus(c.db, discovererUserId, providerId, "ok", {
              lastConnectedAt: now,
            });

            send({ type: "models", added, updated });
            send({ type: "done", total: added + updated });
            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : "Discovery failed.";
            send({ type: "error", code: "discovery_failed", message: truncate(message, 300) });
            controller.close();
          }
        },
      });

      return sseResponse(stream);
    }),

    /** Is the cached list fresh enough to show without refetching? */
    freshness: withErrors(async (_req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const items = modelRepo.listModelsByProvider(c.db, c.user.id, m.params.id);
      if (items.length === 0) {
        return json({ status: "never", count: 0, newestFetchedAt: null, staleMs: 0 });
      }
      const newest = items.reduce(
        (acc, m) => (m.metadata.fetchedAt > acc ? m.metadata.fetchedAt : acc),
        items[0].metadata.fetchedAt,
      );
      const age = Date.now() - new Date(newest).getTime();
      return json({
        status: age > STALE_AFTER_MS ? "stale" : "fresh",
        count: items.length,
        newestFetchedAt: newest,
        staleMs: Math.max(0, Math.round(age)),
      });
    }),
  };
}

/** Validate a Base URL for the settings screen, without persisting anything. */
export function validateUrlHandler(req: Request): Promise<Response> {
  return readJson<{ baseUrl: string; allowLocal?: boolean }>(req).then((body) => {
    const check = validateBaseUrl(body.baseUrl ?? "", { allowLocal: body.allowLocal === true });
    if (!check.ok) return jsonError(400, check.code, check.message);
    return json({ ok: true, normalized: check.url.toString() });
  });
}

export type { ModelRecord };
