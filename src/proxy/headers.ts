// Header policy for proxied requests and responses (I-TOK-1, I-RESP-1).
// Outbound headers are built from an allowlist, never by deleting from the caller's headers,
// so headers nobody anticipated are dropped by default.

/** Request headers forwarded when present. Services may add more via `forward_headers`. */
export const REQUEST_ALLOWLIST: readonly string[] = [
  'accept',
  'accept-encoding',
  'accept-language',
  'content-encoding',
  'content-language',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'range',
  'user-agent',
];

/**
 * Request headers that are never forwarded, even if a service lists them.
 * Entries ending in "*" are prefixes. Includes hop-by-hop headers (RFC 9110 §7.6.1),
 * caller credentials, client-address headers, and method and URL overrides (which would bypass
 * rules). Applied at request time, so `forward_headers` saved before an entry was added are
 * filtered too.
 */
export const NEVER_FORWARD: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'forwarded',
  'x-forwarded-*',
  'x-real-ip',
  'true-client-ip',
  'cf-*',
  'cdn-loop',
  'x-tokengate-*',
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
  'x-original-method',
  'x-original-url',
  'x-rewrite-url',
  'x-override-url',
];

/** Upstream response headers removed before returning to the caller. Prefix entries end in "*". */
export const RESPONSE_DROP: readonly string[] = [
  'set-cookie',
  'set-cookie2',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'www-authenticate',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'alt-svc',
  'x-tokengate-*',
];

/** True when `name` (any case) matches an entry of a list above. */
export function headerListed(list: readonly string[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some((entry) =>
    entry.endsWith('*') ? lower.startsWith(entry.slice(0, -1)) : lower === entry,
  );
}
