/**
 * Provider and model endpoints, plus the key-resolution rules.
 *
 * The three credential modes in one place:
 *
 *   session      the key lives in `provider_session_keys`, tied to the session
 *                cookie. It dies with the session and is never written to a log.
 *   encrypted    the key is encrypted at rest with the server master key and is
 *                decrypted only for the duration of one provider call.
 *   per-request  the browser sends the key on each request; the server never
 *                stores it at all. This is the mode used for local servers that
 *                must be reached from the user's machine rather than ours.
 */

import type {
  ProviderConfig,
  ProviderKind,
  CreateProviderRequest,
  UpdateProviderRequest,
} from "../../shared/types.ts";
import {
  decryptSecret,
  encryptSecret,
  previewSecret,
} from "../security/crypto.ts";
import { validateBaseUrl } from "../security/url.ts";
import { HttpError, json, jsonError, readJson, withErrors } from "./router.ts";
import type { AppContext, ResolvedProvider } from "./context.ts";
import * as repo from "../db/repositories/providers.ts";
import type { ProviderRow } from "../db/repositories/providers.ts";

/** Where the master key comes from; empty means encrypted mode is unavailable. */
function masterKey(): string {
  return process.env.ROSA_ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY ?? "";
}

/**
 * Resolve the key that will be used for the next call.
 *
 * Order matters: an explicitly per-request key always wins, because the browser
 * is the only thing that can reach a local provider. Otherwise we fall back to
 * the session key, then to the encrypted copy.
 */
export async function resolveProvider(
  ctx: AppContext,
  providerId: string,
  perRequestKey?: string,
): Promise<ResolvedProvider> {
  if (!ctx.user) throw new HttpError(401, "unauthenticated", "Sign in first.");

  const row = repo.getProviderRow(ctx.db, ctx.user.id, providerId);
  if (!row) throw new HttpError(404, "provider_not_found", "That provider does not exist.");

  const orgId = row.organization_id;
  const normalized = normalizeProvider(row, modelCount(ctx, providerId));

  if (perRequestKey && typeof perRequestKey === "string" && perRequestKey.length > 0) {
    return {
      config: normalized,
      apiKey: perRequestKey,
      keySource: "per-request",
      organizationId: orgId,
    };
  }

  if (row.credential_mode === "encrypted") {
    if (!row.key_ciphertext) {
      return { config: normalized, apiKey: null, keySource: "none", organizationId: orgId };
    }
    if (!masterKey()) {
      throw new HttpError(
        500,
        "encryption_key_missing",
        "The server has no encryption key configured, so this provider's stored key cannot be used.",
      );
    }
    const key = await decryptSecret(row.key_ciphertext, masterKey());
    return { config: normalized, apiKey: key, keySource: "encrypted", organizationId: orgId };
  }

  if (row.credential_mode === "session") {
    const key = ctx.sessionId ? repo.getSessionKey(ctx.db, ctx.sessionId, providerId) : null;
    return { config: normalized, apiKey: key, keySource: key ? "session" : "none", organizationId: orgId };
  }

  if (row.credential_mode === "per-request") {
    return { config: normalized, apiKey: null, keySource: "none", organizationId: orgId };
  }

  return { config: normalized, apiKey: null, keySource: "none", organizationId: orgId };
}

/** Model count is a separate query, so resolving a provider avoids an extra read per call. */
function modelCount(ctx: AppContext, providerId: string): number {
  if (!ctx.user) return 0;
  return (
    ctx.db.scalar<number>("SELECT COUNT(*) FROM models WHERE user_id = ? AND provider_id = ?", [
      ctx.user.id,
      providerId,
    ]) ?? 0
  );
}

function normalizeProvider(row: ProviderRow, discoveredModelCount: number): ProviderConfig {
  return repo.toProviderConfig(row, discoveredModelCount);
}

export function createProviderRoutes(ctx: () => AppContext) {
  return {
    list: withErrors(async (_req) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      return json({ items: repo.listProviders(c.db, c.user.id) });
    }),

    create: withErrors(async (req) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<CreateProviderRequest>(req);

      const displayName = (body.displayName ?? "").trim();
      if (!displayName) throw new HttpError(400, "missing_name", "Give the provider a name.");

      const kind: ProviderKind =
        body.kind === "anthropic" ? "anthropic" : "openai-compatible";

      const urlCheck = validateBaseUrl(body.baseUrl ?? "");
      if (!urlCheck.ok) {
        throw new HttpError(400, urlCheck.code, urlCheck.message);
      }

      // A form can only pick session or per-request storage. Encrypted is set
      // by the server, so the DB type (which allows all three) is narrowed here.
      const mode = (body.credentialMode ?? "session") as
        | "session"
        | "encrypted"
        | "per-request";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

      let keyCiphertext: string | null = null;
      let keyPreview: string | null = null;

      if (apiKey) {
        keyPreview = previewSecret(apiKey);
        // `CreateProviderRequest.credentialMode` deliberately excludes
        // "encrypted": that mode is a server deployment decision, not a form
        // choice. Encrypt here only if a caller with the wider DB type asks,
        // so a future internal caller still gets a real ciphertext.
        if (mode === "encrypted") {
          if (!masterKey()) {
            throw new HttpError(
              400,
              "encryption_unavailable",
              "Server-side key storage needs ROSA_ENCRYPTION_KEY. Choose the session key mode instead, or configure the key on the server.",
            );
          }
          keyCiphertext = await encryptSecret(apiKey, masterKey());
        }
      }

      const provider = repo.createProvider(c.db, c.user.id, {
        displayName,
        kind,
        baseUrl: urlCheck.url.toString().replace(/\/$/, ""),
        credentialMode: mode,
        keyCiphertext,
        keyPreview,
        organizationId: body.organizationId?.trim() || null,
      });

      // `session` mode needs the key row right away so the very next request
      // from this tab works.
      if (apiKey && mode === "session" && c.sessionId) {
        repo.setSessionKey(c.db, c.sessionId, provider.id, apiKey);
      }

      return json({ provider }, 201);
    }),

    update: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const id = m.params.id;
      const body = await readJson<UpdateProviderRequest>(req);

      const existing = repo.getProviderRow(c.db, c.user.id, id);
      if (!existing) throw new HttpError(404, "provider_not_found", "That provider does not exist.");

      let baseUrl: string | undefined;
      if (body.baseUrl !== undefined) {
        const check = validateBaseUrl(body.baseUrl);
        if (!check.ok) throw new HttpError(400, check.code, check.message);
        baseUrl = check.url.toString().replace(/\/$/, "");
      }

      const patch: repo.UpdateProviderInput = {
        displayName: body.displayName?.trim() || undefined,
        baseUrl,
        organizationId:
          body.organizationId === undefined ? undefined : body.organizationId?.trim() || null,
      };

      if (typeof body.apiKey === "string" && body.apiKey.trim().length > 0) {
        const apiKey = body.apiKey.trim();
        // `body.credentialMode` never allows "encrypted" (that is a server-side
        // deployment setting), so `mode` stays in the non-encrypted union unless
        // the stored row is already encrypted — in which case updating the key
        // must keep it encrypted.
        const mode = (body.credentialMode ?? existing.credential_mode) as
          | "session"
          | "encrypted"
          | "per-request";
        patch.credentialMode = mode;
        patch.keyPreview = previewSecret(apiKey);
        if (mode === "encrypted") {
          if (!masterKey()) {
            throw new HttpError(400, "encryption_unavailable", "Server-side key storage needs ROSA_ENCRYPTION_KEY.");
          }
          patch.keyCiphertext = await encryptSecret(apiKey, masterKey());
        } else if (mode === "session") {
          patch.keyCiphertext = null;
          if (c.sessionId) repo.setSessionKey(c.db, c.sessionId, id, apiKey);
        } else {
          patch.keyCiphertext = null;
        }
      } else if (body.credentialMode !== undefined && body.credentialMode !== existing.credential_mode) {
        // Switching mode without a new key: drop the stored copy so we never
        // leave a key in a place the user did not choose.
        patch.credentialMode = body.credentialMode;
        patch.keyCiphertext = null;
        patch.keyPreview = null;
        if (body.credentialMode === "session" && c.sessionId) {
          repo.clearSessionKey(c.db, c.sessionId, id);
        }
      }

      const provider = repo.updateProvider(c.db, c.user.id, id, patch);
      if (!provider) throw new HttpError(404, "provider_not_found", "That provider does not exist.");
      return json({ provider });
    }),

    remove: withErrors(async (_req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const id = m.params.id;
      repo.clearProviderSessionKeys(c.db, id);
      const ok = repo.deleteProvider(c.db, c.user.id, id);
      if (!ok) throw new HttpError(404, "provider_not_found", "That provider does not exist.");
      return json({ ok: true });
    }),

    /** Store a key for the current session only. */
    setSessionKey: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const id = m.params.id;
      const body = await readJson<{ apiKey: string }>(req);
      const existing = repo.getProviderRow(c.db, c.user.id, id);
      if (!existing) throw new HttpError(404, "provider_not_found", "That provider does not exist.");
      if (!c.sessionId) throw new HttpError(401, "no_session", "No active session.");
      if (!body.apiKey?.trim()) throw new HttpError(400, "missing_key", "Enter an API key.");
      repo.setSessionKey(c.db, c.sessionId, id, body.apiKey.trim());
      return json({ ok: true, preview: previewSecret(body.apiKey.trim()) });
    }),

    clearSessionKey: withErrors(async (_req, m) => {
      const c = ctx();
      if (!c.user || !c.sessionId) throw new HttpError(401, "unauthenticated", "Sign in first.");
      repo.clearSessionKey(c.db, c.sessionId, m.params.id);
      return json({ ok: true });
    }),

    /** Remove every stored credential this user has, on every provider. */
    deleteAllCredentials: withErrors(async (_req) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const providers = repo.listProviders(c.db, c.user.id);
      for (const p of providers) {
        repo.updateProvider(c.db, c.user.id, p.id, {
          credentialMode: "session",
          keyCiphertext: null,
          keyPreview: null,
        });
        if (c.sessionId) repo.clearSessionKey(c.db, c.sessionId, p.id);
      }
      return json({ ok: true, cleared: providers.length });
    }),

    test: withErrors(async (req, m) => {
      const c = ctx();
      if (!c.user) throw new HttpError(401, "unauthenticated", "Sign in first.");
      const body = await readJson<{ apiKey?: string }>(req);
      const resolved = await resolveProvider(c, m.params.id, body.apiKey);
      if (!resolved.apiKey) {
        throw new HttpError(409, "provider_key_required", "This provider has no API key configured.");
      }

      const { getAdapter } = await import("../providers/registry.ts");
      const adapter = getAdapter(resolved.config.kind);
      const signal = AbortSignal.timeout(20_000);
      const spec = adapter.buildModelListRequest(
        resolved.config.baseUrl,
        { apiKey: resolved.apiKey, organizationId: resolved.organizationId },
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
        repo.setConnectionStatus(c.db, c.user.id, m.params.id, "error");
        return jsonError(502, "redirect_blocked", "The provider attempted a redirect, which is refused.");
      }

      if (!response.ok) {
        const status = response.status === 401 ? "untested" : response.status === 429 ? "rate-limited" : "error";
        repo.setConnectionStatus(c.db, c.user.id, m.params.id, status as never);
        const message =
          response.status === 401
            ? "The API key was rejected (401). Check the key and its permissions."
            : response.status === 429
              ? "The provider is rate limiting this key (429). Try again shortly."
              : `The provider responded with ${response.status}.`;
        return jsonError(response.status === 429 ? 429 : response.status, "provider_error", message);
      }

      const raw = (await response.json().catch(() => null)) as unknown;
      let modelCount = 0;
      try {
        modelCount = adapter.parseModelList(raw).length;
      } catch {
        modelCount = 0;
      }

      repo.setConnectionStatus(c.db, c.user.id, m.params.id, "ok", {
        lastConnectedAt: new Date().toISOString(),
      });
      return json({ ok: true, modelCount });
    }),
  };
}

export { resolveProvider as resolveProviderKey };
