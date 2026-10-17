/**
 * Credential-at-rest encryption for provider API keys.
 *
 * Threat model (stated plainly, because it matters):
 *   - We protect against a database dump being readable on its own: a stolen
 *     SQLite/D1 file yields AES-GCM ciphertext, not keys.
 *   - We do NOT protect against an attacker who can also read the server's
 *     master key from its environment. If that key leaks, stored provider keys
 *     must be treated as compromised and the user told to rotate them.
 *
 * The default configuration therefore runs in `session` mode, where the key is
 * held in memory for the current tab and never persisted at all. Persisting a
 * key is an explicit, opt-in user choice and the UI says so.
 *
 * The ciphertext format is `v1:<iv-b64url>:<ciphertext-b64url>` so we can
 * change the scheme later without guessing.
 */

const KEY_INFO = "rosa-provider-key-v1";
const IV_BYTES = 12; // AES-GCM standard nonce size

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Derive a 256-bit AES key from the master secret using HKDF. */
async function deriveKey(masterSecret: string): Promise<CryptoKey> {
  if (!masterSecret) {
    throw new CryptoError("ENCRYPTION_KEY is not configured");
  }
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(masterSecret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("rosa/credential/v1"),
      info: enc.encode(KEY_INFO),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a provider API key. Returns a self-describing string. */
export async function encryptSecret(plaintext: string, masterSecret: string): Promise<string> {
  if (!plaintext) throw new CryptoError("nothing to encrypt");
  const key = await deriveKey(masterSecret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    enc.encode(plaintext),
  );
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ct))}`;
}

/** Decrypt a value produced by {@link encryptSecret}. */
export async function decryptSecret(payload: string, masterSecret: string): Promise<string> {
  const parts = payload.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new CryptoError("stored credential is malformed");
  }
  const [, ivPart, ctPart] = parts;
  try {
    const key = await deriveKey(masterSecret);
    const iv = fromBase64Url(ivPart);
    const ct = fromBase64Url(ctPart);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      ct,
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new CryptoError(
      "Stored credential could not be decrypted — the master key may have changed.",
    );
  }
}

/** A short, non-reversible display hint such as `sk-…4f21`. */
export function previewSecret(secret: string): string {
  if (!secret) return "";
  const tail = secret.slice(-4);
  const head = secret.length > 8 ? secret.slice(0, 3) : secret.slice(0, 1);
  return `${head}…${tail}`;
}

/** Timing-safe string comparison for tokens and session ids. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare over a fixed length so the loop count does not depend on the input.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
