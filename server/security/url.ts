/**
 * SSRF hardening for user-supplied provider Base URLs.
 *
 * A custom Base URL is the main privilege boundary in this app: a user can
 * point it anywhere, and the server-side adapter will happily attach the user's
 * own API key to whatever it calls. Without checks, a user could aim a provider
 * at an internal address (cloud metadata endpoints, loopback admin ports,
 * private ranges) and have the server fetch it on their behalf.
 *
 * This module rejects:
 *   - non-http(s) schemes (file:, ftp:, gopher:, data:, javascript:, ...)
 *   - credentials embedded in the URL (user:pass@host)
 *   - hosts that are not a syntactically valid DNS name or a literal IP
 *   - IP literals in private, loopback, link-local, CGNAT and reserved ranges
 *   - IPv4/IPv6 notations that resolve into those ranges after normalization
 *
 * It does NOT do DNS resolution (that needs the platform's resolver and would
 * add a lookup per request). Instead it sets `redirect: "manual"` on every
 * outbound provider call, so a DNS name that answers publicly but redirects to
 * a private host is refused rather than followed. Callers must treat a 30x
 * response from a redirect policy of "manual" as an error.
 */

/** Hostnames we refuse outright, independent of IP parsing. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

/** hostname forms that are explicitly allowed even though they look local. */
const ALLOWED_LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);

export type UrlValidation =
  | { ok: true; url: URL }
  | { ok: false; code: string; message: string };

/**
 * Parse one IPv4 component the way `inet_aton` does: `0x` is hex, a leading
 * `0` is octal, anything else decimal. This matters because `0177.0.0.1` is
 * 127.0.0.1 in octal, and blocking rules that miss octal spellings miss an
 * easy bypass.
 */
function parseIpv4Part(part: string): number | null {
  if (!/^[0-9a-fA-Fx]+$/.test(part)) return null;
  let n: number;
  if (/^0[xX]/.test(part)) n = Number.parseInt(part.slice(2), 16);
  else if (/^0[0-7]+$/.test(part)) n = Number.parseInt(part, 8);
  else if (/^\d+$/.test(part)) n = Number.parseInt(part, 10);
  else return null;
  return Number.isInteger(n) ? n : null;
}

/** Convert an IPv4-in-other-notation (decimal, hex, octal) to dotted quad. */
export function normalizeIpv4(host: string): string | null {
  const parts = host.split(".");
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIpv4Part(p);
    if (n === null) return null;
    nums.push(n);
  }
  if (nums.length === 4) {
    if (nums.some((n) => n < 0 || n > 255)) return null;
    return nums.join(".");
  }
  if (nums.length === 1) {
    // Single 32-bit integer form: 2130706433 == 127.0.0.1
    const n = nums[0];
    if (n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
  }
  // 3-part shorthand (a.b.c interpreted as a.b.(c>>8).c)
  if (nums.length === 3) {
    const [a, b, c] = nums;
    if (![a, b, c].every((n) => n >= 0 && n <= 255)) return null;
    return [a, b, (c >> 8) & 0xff, c & 0xff].join(".");
  }
  // 2-part shorthand (a.b interpreted as a.(b>>16).(b>>8).b)
  if (nums.length === 2) {
    const [a, b] = nums;
    if (a < 0 || a > 255 || b < 0 || b > 0xffff) return null;
    return [a, (b >> 16) & 0xff, (b >> 8) & 0xff, b & 0xff].join(".");
  }
  return null;
}

/** True when the dotted-quad IPv4 falls in a non-routable/blocked range. */
export function isBlockedIpv4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = o;

  if (a === 0) return true; // "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && o[2] === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && o[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * True when an (already bracket-stripped) IPv6 address is loopback,
 * link-local, unique-local, or otherwise non-global.
 */
export function isBlockedIpv6(addr: string): boolean {
  const a = addr.toLowerCase();

  // ::  and anything ending in :: is not a global unicast we will call
  if (a === "::" || a === "::1") return true;

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible (::127.0.0.1)
  const mapped = a.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);

  // Parse the groups so we can test prefixes.
  let groups: number[] = [];
  const doubleColon = a.split("::");
  if (a.includes("::")) {
    const head = doubleColon[0] ? doubleColon[0].split(":") : [];
    const tail = doubleColon[1] ? doubleColon[1].split(":") : [];
    groups = [...hexGroups(head), ...new Array(8 - head.length - tail.length).fill(0), ...hexGroups(tail)];
  } else {
    groups = hexGroups(a.split(":"));
  }
  if (groups.length !== 8) return true; // malformed — refuse

  const [g0, g1] = groups;

  if (g0 === 0x0000) {
    // ::/8  — matches ::1 and ::ffff:x but also unspecified
    return true;
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function hexGroups(parts: string[]): number[] {
  const out: number[] = [];
  for (const p of parts) {
    const n = p.includes(".") ? undefined : Number.parseInt(p || "0", 16);
    if (n === undefined || !Number.isInteger(n)) return [];
    out.push(n);
  }
  return out;
}

/** True when the hostname is a bare IP literal (v4 or v6). */
export function isIpLiteral(host: string): boolean {
  if (host.startsWith("[")) return true; // [::1]
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^\d+$/.test(host)) return true;
  return false;
}

/** True when a hostname is a valid public DNS name. */
export function isPublicHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.includes(":") && !host.startsWith("[")) return false;
  const lower = host.toLowerCase();
  if (BLOCKED_HOST_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  if (lower === "localhost") return false;
  // Labels: alphanumeric plus hyphens, no leading/trailing hyphen.
  const labels = lower.split(".");
  return labels.every(
    (l) => l.length > 0 && l.length <= 63 && /^[a-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-"),
  );
}

/**
 * Validate and normalize a user-supplied provider Base URL.
 *
 * Returns the parsed URL (with a trailing slash stripped from the origin path)
 * on success, or a coded error on failure.
 */
export function validateBaseUrl(
  input: string,
  options: { allowLocal?: boolean } = {},
): UrlValidation {
  const raw = (input ?? "").trim();
  if (!raw) {
    return { ok: false, code: "missing_base_url", message: "Enter a Base URL." };
  }
  if (/\s/.test(raw)) {
    return {
      ok: false,
      code: "invalid_base_url",
      message: "Base URL must not contain spaces.",
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      code: "invalid_base_url",
      message: "Base URL is not a valid URL. Include the scheme, e.g. https://api.example.com/v1.",
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      code: "unsupported_scheme",
      message: `Unsupported URL scheme "${url.protocol.replace(":", "")}". Use http or https.`,
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      code: "credentials_in_url",
      message: "Remove the username/password from the Base URL. Provide the API key in the API key field instead.",
    };
  }

  const allowLocal = options.allowLocal ?? false;
  let host = url.hostname;

  // Strip IPv6 brackets for range checks.
  const isV6 = host.startsWith("[") && host.endsWith("]");
  const bareHost = isV6 ? host.slice(1, -1) : host;

  if (!allowLocal) {
    if (ALLOWED_LOCAL_HOSTS.has(host) || bareHost === "::1") {
      return {
        ok: false,
        code: "local_url_blocked",
        message:
          "Server-side provider calls cannot target this machine. If you run a local model server, use the browser-direct connection mode (which talks to it from your own machine) instead.",
      };
    }

    if (isV6) {
      if (isBlockedIpv6(bareHost)) {
        return {
          ok: false,
          code: "local_url_blocked",
          message: "Base URL resolves to a blocked (private, loopback or link-local) address.",
        };
      }
    } else if (isIpLiteral(host)) {
      const dotted = normalizeIpv4(host);
      if (!dotted) {
        return {
          ok: false,
          code: "invalid_base_url",
          message: "Base URL uses an IP address that could not be parsed.",
        };
      }
      if (isBlockedIpv4(dotted)) {
        return {
          ok: false,
          code: "local_url_blocked",
          message: "Base URL is a private, loopback or link-local IP address.",
        };
      }
    } else {
      if (!isPublicHostname(host)) {
        // Name the actual reason. A blocked local name and a malformed hostname
        // both fail `isPublicHostname`, and telling a user their DNS name is
        // "not valid" when the real problem is that it points at this machine
        // sends them debugging the wrong thing.
        const lower = host.toLowerCase();
        const isLocalName =
          lower === "localhost" ||
          lower.endsWith(".localhost") ||
          lower.endsWith(".local") ||
          lower.endsWith(".internal");
        return {
          ok: false,
          code: isLocalName ? "local_url_blocked" : "invalid_base_url",
          message: isLocalName
            ? "Server-side provider calls cannot target this machine. If you run a local model server, use the browser-direct connection mode (which talks to it from your own machine) instead."
            : "Base URL hostname is not a valid public domain name.",
        };
      }
      const lowerDotted = normalizeIpv4(host);
      if (lowerDotted && isBlockedIpv4(lowerDotted)) {
        return {
          ok: false,
          code: "local_url_blocked",
          message: "Base URL points at a private IP address.",
        };
      }
      // Bare integer host, e.g. http://2130706433/
      if (/^\d+$/.test(host)) {
        const dotted2 = normalizeIpv4(host);
        if (dotted2 && isBlockedIpv4(dotted2)) {
          return {
            ok: false,
            code: "local_url_blocked",
            message: "Base URL points at a private IP address.",
          };
        }
      }
    }
  }

  // Normalize: never keep a trailing slash on the root path so joins are stable.
  if (url.pathname === "/") url.pathname = "";

  return { ok: true, url };
}

/** Validate a URL meant to be called from the browser (per-request mode). */
export function isBrowserCallableBaseUrl(input: string): boolean {
  const v = validateBaseUrl(input, { allowLocal: true });
  if (!v.ok) return false;
  return v.url.protocol === "https:" || v.url.protocol === "http:";
}

/** Strip anything that could carry a secret from text before we log it. */
export function redactUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.username = "";
    u.password = "";
    if (u.searchParams.has("key")) u.searchParams.set("key", "[redacted]");
    if (u.searchParams.has("api_key")) u.searchParams.set("api_key", "[redacted]");
    if (u.searchParams.has("token")) u.searchParams.set("token", "[redacted]");
    return u.toString();
  } catch {
    return "[unparseable-url]";
  }
}
