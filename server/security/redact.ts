/**
 * Log hygiene. Anything that could be a secret, a prompt, or a whole model
 * response must not reach logs or error reports, so this module both redacts
 * known shapes and offers truncating helpers.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Basic auth values
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\bgsk_[A-Za-z0-9]{16,}/g, "[redacted-key]"],
  // Common api-key query parameters
  [/([?&](?:api[-_]?key|key|token|secret|password)=)[^&\s"']+/gi, "$1[redacted]"],
  // OpenAI-style project / org identifiers and long hex ids
  [/\b(?:org|orgId)[=:]\s*["']?[A-Za-z0-9_-]{8,}/gi, "org=[redacted]"],
];

/** Redact anything that looks like a credential from a block of text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Redact an object of headers for safe logging. Drops everything sensitive
 * and keeps only the allowlisted, non-identifying names.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const safe = new Set(["content-type", "accept", "content-length", "user-agent"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (safe.has(k.toLowerCase())) out[k] = v;
    else out[k] = "[redacted]";
  }
  return out;
}

/** Truncate to a maximum number of characters, appending an ellipsis. */
export function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

/**
 * Reduced logger. Never pass prompts, responses or credentials here; pass the
 * facts you want to be able to see in production.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

let levelThreshold: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  levelThreshold = level;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const log = {
  debug: (msg: string, ctx?: unknown) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: unknown) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: unknown) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: unknown) => emit("error", msg, ctx),
};

function emit(level: LogLevel, msg: string, ctx?: unknown): void {
  if (ORDER[level] < ORDER[levelThreshold]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  if (ctx === undefined) sink(line);
  else sink(line, safeStringify(ctx));
}

function safeStringify(ctx: unknown): string {
  try {
    return JSON.stringify(ctx, (_k, v) => (typeof v === "string" ? redactSecrets(v) : v));
  } catch {
    return "[unserializable]";
  }
}
