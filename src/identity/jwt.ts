// Caller token verification: compact-JWS shape (I-TOK-2), unverified alg/kid/iss peek used only to
// pick a caller provider, jose signature and claims check (I-JWT-1), JWKS refetch gate per jwks_uri
// (I-JWT-2), tenant pin (I-TEN-1) and the resulting caller identity.
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  type FlattenedJWSInput,
  type JWSHeaderParameters,
  jwtVerify,
  type RemoteJWKSet,
} from 'jose';
import type { CallerProvider } from '../db/types';
import type { Deps } from '../deps';
import { claimText, conditionShapeError } from '../policy/conditions';
import { isSharedIssuer } from './profiles';
import type { CallerIdentity, Claims, IssuerProfile } from './types';

/**
 * Asymmetric algorithms the verifier will ever accept, whatever a caller provider row says.
 * Never `none`, never HS* (a public key must not double as an HMAC secret).
 */
export const VERIFIABLE_ALGS: readonly string[] = Object.freeze([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'EdDSA',
]);

/** Seconds of clock skew tolerated on exp/nbf/iat. */
export const CLOCK_TOLERANCE_SECONDS = 30;
/** Upper bound for a caller token; real CI tokens are 1–3 KiB. Bounds parsing work. */
export const MAX_TOKEN_LENGTH = 16 * 1024;
/** No JWKS fetch for a jwks_uri within this many ms of the previous attempt, failed or not. */
export const JWKS_REFETCH_GATE_MS = 30_000;
const JWKS_TIMEOUT_MS = 3_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MAX_AGE_MS = 600_000;

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KID = /^[A-Za-z0-9._-]{1,128}$/;

export type VerifyFailureCode =
  | 'token_malformed'
  | 'token_expired'
  | 'token_too_old'
  | 'audience_mismatch'
  | 'signature_invalid'
  | 'claims_invalid'
  | 'jwks_unavailable';

export type VerifyResult = { ok: true; claims: Claims } | { ok: false; code: VerifyFailureCode };

export interface UnverifiedToken {
  alg: string;
  kid: string | null;
  iss: string | null;
}

/** Three non-empty base64url segments (so no unsigned `x.y.` tokens), bounded length (I-TOK-2). */
export function isCompactJws(token: string): boolean {
  return token.length <= MAX_TOKEN_LENGTH && COMPACT_JWS.test(token);
}

/**
 * Reads `alg`, `kid` and `iss` WITHOUT verifying anything. The result only selects a caller
 * provider and pre-filters headers; it is never trusted. Returns null for anything malformed.
 */
export function decodeUnverified(token: string): UnverifiedToken | null {
  if (!isCompactJws(token)) return null;
  try {
    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);
    if (typeof header.alg !== 'string') return null;
    return {
      alg: header.alg,
      kid: typeof header.kid === 'string' ? header.kid : null,
      iss: typeof payload.iss === 'string' ? payload.iss : null,
    };
  } catch {
    return null;
  }
}

/** Pre-verify header check: alg allowed for this provider (and asymmetric); kid present and tame. */
export function headerAcceptable(
  decoded: Pick<UnverifiedToken, 'alg' | 'kid'>,
  provider: Pick<CallerProvider, 'allowed_algs'>,
): boolean {
  return (
    VERIFIABLE_ALGS.includes(decoded.alg) &&
    provider.allowed_algs.includes(decoded.alg) &&
    decoded.kid !== null &&
    KID.test(decoded.kid)
  );
}

// ---------------------------------------------------------------------------------------------
// JWKS registry (I-JWT-2): one jose RemoteJWKSet per jwks_uri for the isolate's lifetime. jose
// refetches when its key set is older than JWKS_CACHE_MAX_AGE_MS, or for an unknown kid once
// JWKS_COOLDOWN_MS has passed since its last successful fetch. The gate adds (injected clock):
// - At most one fetch per jwks_uri per JWKS_REFETCH_GATE_MS, failed or not. A gated request
//   verifies against the keys already held, unless they are stale and the last fetch failed
//   (then jwks_unavailable, as jose does when a refresh fails).
// - Exception: while no key set has ever loaded and no fetch has ever failed (cold isolate),
//   concurrent requests fetch too: refusing them would fail the first burst of CI jobs, and an
//   in-flight fetch cannot be shared between requests on Workers (jose does not share it there
//   either: https://github.com/panva/jose/blob/main/src/jwks/remote.ts). Each request still causes
//   at most one fetch. The first failure ends the exception for good (`coldFetchFailed` is
//   sticky), so requests concurrent with a later retry are gated.
// ---------------------------------------------------------------------------------------------

interface JwksEntry {
  resolver: RemoteJWKSet;
  /** Fetch and clock of the latest request using this entry; the same functions in production. */
  deps: Pick<Deps, 'fetch' | 'now'>;
  lastAttemptAt: number | null;
  /** The most recent fetch (or the JWKS it returned) was unusable. */
  lastAttemptFailed: boolean;
  /** Some fetch has failed; never cleared (ends the cold-isolate exception, I-JWT-2). */
  coldFetchFailed: boolean;
}

class JwksRefetchGated extends Error {
  override name = 'JwksRefetchGated';
}

const jwksRegistry = new Map<string, JwksEntry>();

function jwksEntry(jwksUri: string, deps: Pick<Deps, 'fetch' | 'now'>): JwksEntry {
  const existing = jwksRegistry.get(jwksUri);
  if (existing) {
    existing.deps = deps;
    return existing;
  }
  const entry: JwksEntry = {
    deps,
    lastAttemptAt: null,
    lastAttemptFailed: false,
    coldFetchFailed: false,
    resolver: createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: JWKS_TIMEOUT_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      [customFetch]: (url, init) => {
        const now = entry.deps.now();
        if (!fetchAllowed(entry, now)) return Promise.reject(new JwksRefetchGated());
        entry.lastAttemptAt = now;
        entry.lastAttemptFailed = false;
        return entry.deps.fetch(url, init);
      },
    }),
  };
  jwksRegistry.set(jwksUri, entry);
  return entry;
}

function fetchAllowed(entry: JwksEntry, now: number): boolean {
  if (entry.lastAttemptAt === null || now - entry.lastAttemptAt >= JWKS_REFETCH_GATE_MS) {
    return true;
  }
  const coldIsolate = entry.resolver.jwks() === undefined;
  return coldIsolate && !entry.coldFetchFailed;
}

/** Resolves the verification key; while a fetch is gated, falls back to the held key set. */
async function resolveKey(
  entry: JwksEntry,
  header: JWSHeaderParameters,
  input: FlattenedJWSInput,
): Promise<CryptoKey> {
  try {
    return await entry.resolver(header, input);
  } catch (error) {
    if (error instanceof JwksRefetchGated) {
      const held = entry.resolver.jwks();
      if (held !== undefined && (entry.resolver.fresh || !entry.lastAttemptFailed)) {
        return await createLocalJWKSet(held)(header, input);
      }
    } else if (!isKeySelectionError(error)) {
      // Anything else came from this request's own fetch or from parsing what it returned.
      entry.lastAttemptFailed = true;
      entry.coldFetchFailed = true;
    }
    throw error;
  }
}

/** The key set loaded fine but has no single key for this kid/alg. */
function isKeySelectionError(error: unknown): boolean {
  return (
    error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys
  );
}

/** Drops all cached JWKS and gate state. Tests only. */
export function resetJwksCacheForTests(): void {
  jwksRegistry.clear();
}

/** Marks errors raised while resolving the key, so they are not confused with token errors. */
class KeyResolutionFailed extends Error {
  constructor(readonly reason: unknown) {
    super('key resolution failed');
  }
}

/**
 * Verifies signature, issuer, audience, algorithm, age and required claims (I-JWT-1). Never throws.
 * Fails closed on a provider/profile mismatch, an empty issuer or audience (an empty expected value
 * would match a token carrying the same empty value), a non-positive max token age or a jwks_uri
 * that is not https.
 */
export async function verifyCallerToken(
  token: string,
  provider: CallerProvider,
  profile: IssuerProfile,
  deps: Pick<Deps, 'fetch' | 'now'>,
): Promise<VerifyResult> {
  if (profile.id !== provider.profile) return { ok: false, code: 'claims_invalid' };
  if (provider.audience.trim() === '') return { ok: false, code: 'audience_mismatch' };
  if (provider.issuer.trim() === '') return { ok: false, code: 'claims_invalid' };
  const maxAge = provider.max_token_age_seconds;
  if (!(Number.isSafeInteger(maxAge) && maxAge > 0)) return { ok: false, code: 'token_too_old' };

  const decoded = decodeUnverified(token);
  if (decoded === null || !headerAcceptable(decoded, provider)) {
    return { ok: false, code: 'token_malformed' };
  }

  if (!isJwksUri(provider.jwks_uri)) return { ok: false, code: 'jwks_unavailable' };
  const entry = jwksEntry(provider.jwks_uri, deps);
  const key = (header: JWSHeaderParameters, input: FlattenedJWSInput) =>
    resolveKey(entry, header, input).catch((reason: unknown) => {
      throw new KeyResolutionFailed(reason);
    });

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: provider.issuer,
      audience: provider.audience,
      algorithms: provider.allowed_algs.filter((alg) => VERIFIABLE_ALGS.includes(alg)),
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      maxTokenAge: maxAge,
      requiredClaims: profile.verifyRequiredClaims(provider),
      currentDate: new Date(deps.now()),
    });
    return { ok: true, claims: payload };
  } catch (error) {
    return { ok: false, code: failureCode(error) };
  }
}

function failureCode(error: unknown): VerifyFailureCode {
  if (error instanceof KeyResolutionFailed) {
    // The issuer's current key set has no single key for this kid: not signed by the issuer.
    if (isKeySelectionError(error.reason)) return 'signature_invalid';
    // Timeout, network error, non-200, invalid JSON/JWKS, or gated with no usable key set.
    return 'jwks_unavailable';
  }
  if (error instanceof errors.JWTExpired) {
    // jose reports maxTokenAge violations as JWTExpired on the `iat` claim:
    // https://github.com/panva/jose/blob/main/src/lib/jwt_claims_set.ts
    return error.claim === 'iat' ? 'token_too_old' : 'token_expired';
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    return error.claim === 'aud' ? 'audience_mismatch' : 'claims_invalid';
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'signature_invalid';
  if (
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JOSENotSupported
  ) {
    return 'token_malformed';
  }
  // Anything unexpected (e.g. an RSA key under 2048 bits) rejects the token.
  return 'signature_invalid';
}

/**
 * Every tenant pin condition must hold on the verified claims (I-TEN-1). Pins are exact and
 * non-negated by construction; anything else in a pin (wrong match, negate, malformed shape) fails
 * closed. An empty pin fails closed on a shared issuer (GitHub's, gitlab.com) whatever the
 * provider's profile, so a `generic` provider cannot bypass the requirement.
 */
export function tenantPinHolds(
  provider: Pick<CallerProvider, 'issuer' | 'tenant_pin'>,
  claims: Claims,
): boolean {
  if (!Array.isArray(provider.tenant_pin)) return false;
  if (provider.tenant_pin.length === 0) return !isSharedIssuer(provider.issuer);
  return provider.tenant_pin.every((condition) => {
    if (conditionShapeError(condition) !== null) return false;
    if (condition.match !== 'exact' || condition.negate === true) return false;
    const value = claimText(claims, condition.claim);
    return value !== null && condition.values.includes(value);
  });
}

/**
 * The verified caller handed to authorization and telemetry. `claims` are the raw verified claims
 * that conditions evaluate; `display` is derived for UI/logs and is never used for authorization.
 */
export function buildCallerIdentity(
  provider: Pick<CallerProvider, 'id'>,
  profile: IssuerProfile,
  claims: Claims,
): CallerIdentity {
  const identity: CallerIdentity = {
    callerProviderId: provider.id,
    profile: profile.id,
    claims,
    display: profile.display(claims),
  };
  if (typeof claims.jti === 'string') identity.jti = claims.jti;
  return identity;
}

/**
 * Resolves `jwks_uri` from `<issuer>/.well-known/openid-configuration` at save time. The document's
 * `issuer` must equal the configured issuer exactly (OIDC Discovery 1.0 §4.3), and `jwks_uri` must
 * be https without userinfo, query or fragment. https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigurationValidation
 */
export async function discoverJwksUri(
  issuer: string,
  fetchFn: typeof fetch,
): Promise<{ ok: true; jwksUri: string } | { ok: false; error: string }> {
  const discovered = await discoverIssuer(issuer, fetchFn);
  return discovered.ok ? { ok: true, jwksUri: discovered.jwksUri } : discovered;
}

/**
 * discoverJwksUri plus the document's `id_token_signing_alg_values_supported` (null when absent
 * or not a list of strings). The algorithms are a default for the admin to keep, never trusted
 * without the I-JWT-1 check of validateCallerProvider.
 */
export async function discoverIssuer(
  issuer: string,
  fetchFn: typeof fetch,
): Promise<
  { ok: true; jwksUri: string; signingAlgs: string[] | null } | { ok: false; error: string }
> {
  if (!isHttpsUrl(issuer)) return { ok: false, error: 'issuer must be an https URL' };
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: `could not reach ${url}` };
  }
  if (response.status !== 200) {
    return { ok: false, error: `${url} answered HTTP ${response.status}` };
  }
  let document: unknown;
  try {
    document = await response.json();
  } catch {
    return { ok: false, error: `${url} did not return JSON` };
  }
  if (typeof document !== 'object' || document === null) {
    return { ok: false, error: `${url} did not return a JSON object` };
  }
  const { issuer: documentIssuer, jwks_uri: jwksUri } = document as Record<string, unknown>;
  if (documentIssuer !== issuer) {
    return { ok: false, error: 'the discovery document names a different issuer' };
  }
  if (typeof jwksUri !== 'string' || !isJwksUri(jwksUri)) {
    return { ok: false, error: 'the discovery document has no https jwks_uri without query' };
  }
  const algs = (document as Record<string, unknown>).id_token_signing_alg_values_supported;
  const signingAlgs =
    Array.isArray(algs) && algs.every((alg) => typeof alg === 'string') ? (algs as string[]) : null;
  return { ok: true, jwksUri, signingAlgs };
}

/** https, no userinfo, no fragment. */
function isHttpsUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && !url.hash;
  } catch {
    return false;
  }
}

/** A jwks_uri the gateway may fetch keys from: https, no userinfo, fragment or query. */
function isJwksUri(text: string): boolean {
  return isHttpsUrl(text) && new URL(text).search === '';
}
