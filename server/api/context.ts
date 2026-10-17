/**
 * Application context: request-scoped state carried through the API layer.
 */
import type { DbDatabase } from "../db/node-driver.ts";
import type { UserRow } from "../db/repositories/auth.ts";
import type { ProviderConfig } from "../../shared/types.ts";

export interface AppContext {
  db: DbDatabase;
  /** The authenticated user, or null on unauthenticated routes. */
  user: UserRow | null;
  /** Session id from the cookie, used for session-only provider keys. */
  sessionId: string | null;
  /** Base URL of this deployment, used to build OAuth redirects. */
  origin: string;
  requestId: string;
}

/** Provider plus the key that will actually be used for the next call. */
export interface ResolvedProvider {
  config: ProviderConfig;
  apiKey: string | null;
  /** How the key was obtained — surfaces in the UI as the connection mode. */
  keySource: "session" | "encrypted" | "per-request" | "none";
  organizationId: string | null;
}
