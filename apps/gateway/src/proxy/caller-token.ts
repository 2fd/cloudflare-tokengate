// Extracts the caller's workload identity token from request headers (I-TOK-2).
// Only compact JWS values are accepted, and different tokens in different places are rejected
// instead of picking one. The headers read here are never forwarded upstream (I-TOK-1).
import type { Injection } from '../policy/types';

export type CallerTokenSource = 'x-tokengate-token' | 'authorization' | 'injection-header';

export type CallerTokenResult =
  | { ok: true; token: string; source: CallerTokenSource }
  | { ok: false; code: 'token_missing' | 'token_ambiguous' | 'token_malformed' };

export const CALLER_TOKEN_HEADER = 'x-tokengate-token';

/** Upper bound on token length; real CI tokens are 1-3 KB. */
export const MAX_CALLER_TOKEN_LENGTH = 16 * 1024;

/** Three non-empty base64url parts: header.payload.signature (RFC 7515 §7.1). */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** `<scheme> <credentials>`; schemes are case-insensitive (RFC 9110 §11.1). */
const AUTHORIZATION = /^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)(?: +(.*))?$/;

const AUTHORIZATION_SCHEMES = new Set(['bearer', 'token']);

interface Candidate {
  token: string;
  source: CallerTokenSource;
}

/**
 * Sources, in order: `x-tokengate-token`; `Authorization: Bearer|token <jwt>`; and, only when
 * both are absent, the service's injection header for `header` injection (its prefix is
 * stripped), so SDKs that send an API key header can send the caller token there instead.
 * Repeated headers are combined by `Headers` with ", " and are split again here.
 */
export function extractCallerToken(
  headers: Headers,
  injection: Injection | null,
): CallerTokenResult {
  let candidates = [...fromGatewayHeader(headers), ...fromAuthorization(headers)];
  if (candidates.length === 0 && injection?.kind === 'header') {
    candidates = fromInjectionHeader(headers, injection.name, injection.prefix ?? '');
  }

  const first = candidates[0];
  if (first === undefined) return { ok: false, code: 'token_missing' };
  if (candidates.some((candidate) => candidate.token !== first.token)) {
    return { ok: false, code: 'token_ambiguous' };
  }
  if (first.token.length > MAX_CALLER_TOKEN_LENGTH || !COMPACT_JWS.test(first.token)) {
    return { ok: false, code: 'token_malformed' };
  }
  return { ok: true, token: first.token, source: first.source };
}

function headerValues(headers: Headers, name: string): string[] {
  const combined = headers.get(name);
  if (combined === null) return [];
  return combined.split(',').map((value) => value.trim());
}

function fromGatewayHeader(headers: Headers): Candidate[] {
  return headerValues(headers, CALLER_TOKEN_HEADER).map((token) => ({
    token,
    source: 'x-tokengate-token',
  }));
}

/** Authorization values with another scheme (e.g. Basic) are not caller tokens and are ignored. */
function fromAuthorization(headers: Headers): Candidate[] {
  const candidates: Candidate[] = [];
  for (const value of headerValues(headers, 'authorization')) {
    const match = AUTHORIZATION.exec(value);
    const scheme = match?.[1]?.toLowerCase();
    if (scheme === undefined || !AUTHORIZATION_SCHEMES.has(scheme)) continue;
    candidates.push({ token: (match?.[2] ?? '').trim(), source: 'authorization' });
  }
  return candidates;
}

function fromInjectionHeader(headers: Headers, name: string, prefix: string): Candidate[] {
  const lower = name.toLowerCase();
  if (lower === 'authorization' || lower === CALLER_TOKEN_HEADER) return [];
  const trimmedPrefix = prefix.trim().toLowerCase();
  return headerValues(headers, lower).map((value) => {
    const hasPrefix = trimmedPrefix !== '' && value.toLowerCase().startsWith(trimmedPrefix);
    const token = hasPrefix ? value.slice(trimmedPrefix.length).trim() : value;
    return { token, source: 'injection-header' };
  });
}
