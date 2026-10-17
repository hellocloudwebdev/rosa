/**
 * Authentication: password login for local development and OAuth for production.
 *
 * The rules this module keeps:
 *   - no credentials in logs. Only the user id and the outcome are logged;
 *   - sessions are opaque, server-side revocable rows. The cookie holds the id
 *     and nothing else;
 *   - OAuth state is single-use and expires in ten minutes, so a captured
 *     redirect cannot be replayed;
 *   - rate limits wrap every endpoint that can be used to guess or probe.
 */

import { HttpError, json } from "./router.ts";
import type { AppContext } from "./context.ts";
import { log } from "../security/redact.ts";
import {
  SESSION_COOKIE,
  type UserRow,
  consumeOAuthState,
  consumeRateLimit,
  createOAuthState,
  createSession,
  createUser,
  dummyPasswordHash as repositoryDummyPasswordHash,
  findUserByOAuthIdentity,
  getUserByEmail,
  getUserById,
  hashPassword,
  isEmail,
  linkOAuthIdentity,
  normalizeEmail,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  verifyPassword,
} from "../db/repositories/auth.ts";

/** Cookie lifetime matches the session row TTL. */
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** Dev-only password login is deliberately slow to hammer into. */
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 60_000;

/** OAuth start is tighter: it is the endpoint a bug would loop on. */
const OAUTH_START_LIMIT = 20;
const OAUTH_START_WINDOW_MS = 60_000;

export function isRequestSecure(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

/**
 * Build the Set-Cookie value for a session.
 *
 * Secure is set whenever the deployment is HTTPS (including behind a proxy that
 * reports it via x-forwarded-proto). On http://localhost the flag is omitted or
 * the browser would drop the cookie and local dev would break.
 */
function sessionCookie(sessionId: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE && rest.length > 0) return rest.join("=");
  }
  return null;
}

/** Establish a session and return the response with the cookie attached. */
function signedIn(ctx: AppContext, userId: string, req: Request): Response {
  const session = createSession(ctx.db, userId, {
    ipHint: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  });
  const user = getUserById(ctx.db, userId);
  if (!user) throw new HttpError(500, "user_missing", "The account could not be read back.");
  const body = json({ user: publicUser(user) });
  body.headers.set("set-cookie", sessionCookie(session.id, isRequestSecure(req)));
  log.info("session established", { userId });
  return body;
}

/**
 * The user shape the browser is allowed to see.
 *
 * `password_hash` is server-side only: it must never leave in a response body,
 * not even as an opaque string, because a hash is still a credential.
 */
export function publicUser(user: UserRow) {
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.email,
    avatarUrl: user.avatar_url,
    authProvider: user.auth_provider,
  };
}

/* ------------------------------------------------------------------ */
/* Current-user resolution                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve the session's user from the cookie.
 *
 * `ctx.db` carries the connection, so this takes the context rather than a
 * module-level handle — that keeps the function testable and means there is no
 * global to reset between requests.
 */
export function resolveUser(
  ctx: AppContext,
  req: Request,
): { user: UserRow | null; sessionId: string | null } {
  const sessionId = readSessionCookie(req);
  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId)) {
    return { user: null, sessionId: null };
  }
  // resolveSession revokes expired rows as it rejects them, so a stolen cookie
  // does not leave a valid-looking row behind it.
  return { user: resolveSession(ctx.db, sessionId), sessionId };
}

/* ------------------------------------------------------------------ */
/* OAuth providers                                                     */
/* ------------------------------------------------------------------ */

interface OAuthProviderConfig {
  id: "google" | "github";
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export function oauthProvider(id: "google" | "github"): OAuthProviderConfig | null {
  if (id === "google") {
    const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
    if (!clientId || !clientSecret) return null;
    return {
      id,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: ["openid", "email", "profile"],
      clientId,
      clientSecret,
    };
  }
  const clientId = process.env.GITHUB_CLIENT_ID ?? "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) return null;
  return {
    id,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userUrl: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
    clientId,
    clientSecret,
  };
}

export function enabledOAuthProviders(): Array<"google" | "github"> {
  const out: Array<"google" | "github"> = [];
  if (oauthProvider("google")) out.push("google");
  if (oauthProvider("github")) out.push("github");
  return out;
}

/** PKCE verifier, so a stolen authorization code is useless alone. */
function pkceVerifier(): { verifier: string; challenge: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(bytes);
  return { verifier, challenge: verifier };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** GET /api/auth/oauth/:provider — redirect the browser to the provider. */
export function handleOAuthStart(
  ctx: AppContext,
  providerId: "google" | "github",
  req: Request,
): Response {
  const config = oauthProvider(providerId);
  if (!config) {
    throw new HttpError(
      503,
      "oauth_not_configured",
      `${providerId} sign-in is not configured on this deployment.`,
    );
  }

  const db = ctx.db;
  const subject =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    new URL(req.url).host ??
    "unknown";
  const gate = consumeRateLimit(db, "oauth_start", subject, OAUTH_START_LIMIT, OAUTH_START_WINDOW_MS);
  if (!gate.allowed) {
    throw new HttpError(429, "rate_limited", `Too many sign-in attempts. Try again in ${gate.retryAfterSeconds}s.`, true);
  }

  const { verifier, challenge } = pkceVerifier();
  const returnTo = safeReturnPath(new URL(req.url).searchParams.get("returnTo"));
  const { state } = createOAuthState(db, providerId, returnTo, verifier);

  const redirectUri = `${ctx.origin}/api/auth/oauth/${providerId}/callback`;
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "plain");

  const response = new Response(null, { status: 302, headers: { location: url.toString() } });
  return response;
}

/** Only allow same-site relative paths so the redirect cannot be abused. */
function safeReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

interface OAuthProfile {
  providerUserId: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

async function fetchProviderProfile(
  config: OAuthProviderConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthProfile> {
  const tokenResponse = await fetch(config.tokenUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      grant_type: "authorization_code",
    }),
  });

  if (tokenResponse.status >= 300 && tokenResponse.status < 400) {
    throw new HttpError(502, "redirect_blocked", "The provider attempted a redirect, which is refused.");
  }
  if (!tokenResponse.ok) {
    throw new HttpError(502, "token_exchange_failed", "Could not complete sign-in with the provider.");
  }

  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) {
    throw new HttpError(502, "token_exchange_failed", "The provider did not return an access token.");
  }

  const userResponse = await fetch(config.userUrl, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
  });
  if (!userResponse.ok) {
    throw new HttpError(502, "profile_fetch_failed", "Signed in, but the provider profile could not be read.");
  }
  const raw = (await userResponse.json()) as Record<string, unknown>;

  if (config.id === "google") {
    return {
      providerUserId: String(raw.sub ?? ""),
      email: typeof raw.email === "string" ? raw.email : null,
      displayName: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : String(raw.email ?? "Account"),
      avatarUrl: typeof raw.picture === "string" ? raw.picture : null,
    };
  }

  const emails = await fetch("https://api.github.com/user/emails", {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
  }).then((r) => (r.ok ? (r.json() as Promise<Array<{ email: string; primary: boolean }>>) : []));

  return {
    providerUserId: String(raw.id ?? ""),
    email: emails.find((e) => e.primary)?.email ?? emails[0]?.email ?? null,
    displayName:
      typeof raw.login === "string" && raw.login.trim() ? raw.login.trim() : "Account",
    avatarUrl: typeof raw.avatar_url === "string" ? raw.avatar_url : null,
  };
}

/** GET /api/auth/oauth/:provider/callback — exchange the code for a session. */
export async function handleOAuthCallback(
  ctx: AppContext,
  providerId: "google" | "github",
  req: Request,
): Promise<Response> {
  const config = oauthProvider(providerId);
  if (!config) {
    throw new HttpError(503, "oauth_not_configured", `${providerId} sign-in is not configured.`);
  }
  const db = ctx.db;
  const url = new URL(req.url);

  const providerError = url.searchParams.get("error");
  if (providerError) {
    throw new HttpError(400, "oauth_denied", "Sign-in was cancelled at the provider.");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new HttpError(400, "oauth_invalid_callback", "The sign-in response was incomplete.");
  }

  const consumed = consumeOAuthState(db, state);
  if (!consumed || consumed.provider !== providerId) {
    throw new HttpError(400, "oauth_state_invalid", "This sign-in link is no longer valid. Start again.");
  }

  const redirectUri = `${ctx.origin}/api/auth/oauth/${providerId}/callback`;
  const profile = await fetchProviderProfile(config, code, consumed.codeVerifier ?? "", redirectUri);

  let user = findUserByOAuthIdentity(db, providerId, profile.providerUserId);

  if (!user && profile.email) {
    // A verified email at the same address links the accounts, which is the
    // behavior users expect from "continue with Google" on an existing account.
    const byEmail = getUserByEmail(db, profile.email);
    if (byEmail) {
      linkOAuthIdentity(db, byEmail.id, providerId, profile.providerUserId, profile.email, {
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      });
      user = byEmail;
    }
  }

  if (!user) {
    user = createUser(db, {
      email: profile.email ?? `${providerId}-${profile.providerUserId}@oauth.local`,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      authProvider: providerId,
    });
    linkOAuthIdentity(db, user.id, providerId, profile.providerUserId, profile.email);
  }

  return signedIn(ctx, user.id, req);
}

/* ------------------------------------------------------------------ */
/* Dev-only password login                                             */
/* ------------------------------------------------------------------ */

/**
 * Email/password login exists so the app is usable on a laptop without
 * configuring OAuth first. It is explicitly a development path: it stays
 * available in production only when ROSA_ALLOW_PASSWORD_LOGIN=1, and it never
 * runs without a password set in the environment.
 */
export function passwordLoginEnabled(): boolean {
  return process.env.ROSA_ALLOW_PASSWORD_LOGIN === "1";
}

/**
 * A syntactically valid hash of a value nobody knows. Comparing against it when
 * the account does not exist keeps the response time identical to a real
 * attempt, so the endpoint does not disclose which emails are registered.
 */
function dummyPasswordHash(): string {
  return repositoryDummyPasswordHash();
}

export async function handleLogin(ctx: AppContext, req: Request): Promise<Response> {
  if (!passwordLoginEnabled()) {
    throw new HttpError(
      503,
      "login_disabled",
      "Password sign-in is disabled on this deployment. Use Google or GitHub.",
    );
  }
  const db = ctx.db;
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
  if (!isEmail(email)) {
    throw new HttpError(400, "invalid_email", "Enter a valid email address.");
  }

  const gate = consumeRateLimit(db, "login", email, LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!gate.allowed) {
    throw new HttpError(429, "rate_limited", `Too many attempts. Try again in ${gate.retryAfterSeconds}s.`, true);
  }

  const user = getUserByEmail(db, email);
  // Same shape as a real hash, so a missing account is not visible by timing.
  const stored = user?.password_hash ?? dummyPasswordHash();
  const ok = await verifyPassword(typeof body.password === "string" ? body.password : "", stored);
  if (!user || !ok) {
    // The log records only that a login failed. It must not carry the email
    // address, because that is personal data and would turn our logs into an
    // account-existence oracle for anyone who can read them.
    log.warn("login rejected");
    throw new HttpError(401, "invalid_credentials", "That email and password combination is not correct.");
  }
  return signedIn(ctx, user.id, req);
}

export async function handleRegister(ctx: AppContext, req: Request): Promise<Response> {
  if (!passwordLoginEnabled()) {
    throw new HttpError(503, "login_disabled", "Account creation is disabled on this deployment.");
  }
  const db = ctx.db;
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    displayName?: string;
  };
  const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
  const password = typeof body.password === "string" ? body.password : "";

  if (!isEmail(email)) throw new HttpError(400, "invalid_email", "Enter a valid email address.");
  if (password.length < 10) {
    throw new HttpError(400, "weak_password", "Use at least 10 characters.");
  }
  if (getUserByEmail(db, email)) {
    throw new HttpError(409, "email_taken", "An account with that email already exists.");
  }

  const user = createUser(db, {
    email,
    displayName: typeof body.displayName === "string" ? body.displayName : "",
    authProvider: "local",
    passwordHash: await hashPassword(password),
  });
  return signedIn(ctx, user.id, req);
}

export function handleLogout(ctx: AppContext, req: Request): Response {
  const db = ctx.db;
  const sessionId = readSessionCookie(req);
  if (sessionId) revokeSession(db, sessionId);
  const response = json({ ok: true });
  response.headers.set("set-cookie", clearCookie(isRequestSecure(req)));
  return response;
}

/** Revoke every session on every device. */
export function handleLogoutAll(ctx: AppContext, req: Request): Response {
  const db = ctx.db;
  const sessionId = readSessionCookie(req);
  if (sessionId) {
    const user = resolveSession(db, sessionId);
    if (user) revokeAllSessions(db, user.id);
  }
  const response = json({ ok: true });
  response.headers.set("set-cookie", clearCookie(isRequestSecure(req)));
  return response;
}
