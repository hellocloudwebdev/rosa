/**
 * Security boundary tests for Base URL validation.
 *
 * These assert the boundary the brief calls the most important one: a custom
 * Base URL must not turn the server into a proxy for the internal network.
 * Every case below is a real value a user could paste.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  isBlockedIpv4,
  isPublicHostname,
  normalizeIpv4,
  validateBaseUrl,
} from "../server/security/url.ts";

test("accepts ordinary provider endpoints", () => {
  for (const url of [
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://api.groq.com/openai/v1",
  ]) {
    const result = validateBaseUrl(url);
    assert.equal(result.ok, true, `${url} should be accepted`);
  }
});

test("rejects a missing URL", () => {
  const r1 = validateBaseUrl("");
  assert.equal(!r1.ok && r1.code, "missing_base_url");
  const r2 = validateBaseUrl("   ");
  assert.equal(!r2.ok && r2.code, "missing_base_url");
});

test("rejects everything except http and https", () => {
  for (const scheme of ["ftp", "file", "gopher", "ws", "javascript", "data"]) {
    const result = validateBaseUrl(`${scheme}://example.com`);
    assert.equal(result.ok, false, `${scheme} must be rejected`);
    assert.equal(!result.ok && result.code, "unsupported_scheme");
  }
});

test("rejects credentials embedded in the URL", () => {
  // The Authorization header is built from the API key; a URL that also carries
  // basic-auth credentials would silently override it.
  const result = validateBaseUrl("https://user:pass@api.openai.com/v1");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "credentials_in_url");
});

test("blocks loopback and this-machine targets", () => {
  for (const host of ["localhost", "127.0.0.1", "127.1", "0.0.0.0", "[::1]"]) {
    const result = validateBaseUrl(`http://${host}/v1`);
    assert.equal(result.ok, false, `${host} must be blocked`);
    assert.equal(!result.ok && result.code, "local_url_blocked");
  }
});

test("blocks private and link-local ranges", () => {
  for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254"]) {
    const result = validateBaseUrl(`http://${host}`);
    assert.equal(result.ok, false, `${host} must be blocked`);
    assert.equal(!result.ok && result.code, "local_url_blocked");
  }
});

test("blocks the carrier-grade NAT and reserved ranges", () => {
  for (const host of ["100.64.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "240.0.0.1"]) {
    const ip = normalizeIpv4(host);
    assert.ok(ip);
    assert.equal(isBlockedIpv4(ip), true, `${host} must be blocked`);
  }
});

test("allows ordinary public addresses", () => {
  for (const host of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
    const ip = normalizeIpv4(host);
    assert.ok(ip);
    assert.equal(isBlockedIpv4(ip), false, `${host} must be allowed`);
  }
});

test("blocks internal-only hostname suffixes", () => {
  for (const host of ["api.internal", "db.local", "service.localhost", "metadata.local"]) {
    assert.equal(isPublicHostname(host), false, `${host} must be blocked`);
  }
});

test("accepts ordinary public hostnames", () => {
  for (const host of ["api.openai.com", "openrouter.ai", "my-proxy.example.co.uk"]) {
    assert.equal(isPublicHostname(host), true, `${host} must be accepted`);
  }
});

test("normalizes the odd IPv4 spellings a URL can contain", () => {
  // Each of these is a well-known way to write 127.0.0.1.
  assert.equal(normalizeIpv4("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIpv4("127.1"), "127.0.0.1");
  assert.equal(normalizeIpv4("127.0.1"), "127.0.0.1");
  assert.equal(normalizeIpv4("2130706433"), "127.0.0.1");
  assert.equal(normalizeIpv4("0x7f000001"), "127.0.0.1");
  assert.equal(normalizeIpv4("017700000001"), "127.0.0.1");
  assert.equal(normalizeIpv4("0177.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIpv4("8.8.8.8"), "8.8.8.8");
});

test("keeps a real path and normalizes the root to a bare origin", () => {
  // Callers join `{baseUrl}/chat/completions`, so the stored form has to end in
  // exactly what the provider published — no added or dropped segments.
  const root = validateBaseUrl("https://api.openai.com/");
  assert.equal(root.ok, true);
  if (root.ok) assert.equal(root.url.toString(), "https://api.openai.com/");

  const versioned = validateBaseUrl("https://api.openai.com/v1/");
  assert.equal(versioned.ok, true);
  if (versioned.ok) assert.equal(versioned.url.toString(), "https://api.openai.com/v1/");

  const noSlash = validateBaseUrl("https://api.openai.com/v1");
  assert.equal(noSlash.ok, true);
  if (noSlash.ok) assert.equal(noSlash.url.toString(), "https://api.openai.com/v1");
});
