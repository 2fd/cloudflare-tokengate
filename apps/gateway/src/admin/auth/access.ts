// Cloudflare Access login: verifies the `Cf-Access-Jwt-Assertion` header against the team's certs,
// exact issuer (team domain) and audience (AUD tag); service-token JWTs (no email) are rejected.
// Emails come only from authoritativeEmails (I-LINK-1).
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type RemoteJWKSet } from 'jose';
import type { AccessLogin } from '../../config';
import type { Deps } from '../../deps';
import { authoritativeEmails } from './email';
import type { LoginIdentity } from './resolve-login';

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

const ACCESS_ALGS = ['RS256'];
const CLOCK_TOLERANCE_SECONDS = 30;
const MAX_ASSERTION_LENGTH = 16 * 1024;
const CERTS_TIMEOUT_MS = 3_000;
const CERTS_COOLDOWN_MS = 30_000;

export type AccessVerifyError = 'missing' | 'invalid' | 'no_email' | 'certs_unavailable';

interface CertsEntry {
  resolver: RemoteJWKSet;
  /** Fetch of the latest caller; read at call time so an injected `deps.fetch` is honoured. */
  fetch: typeof fetch;
}

// One key set per team for the isolate's lifetime; jose caches keys and refetches on unknown kid
// after its cooldown (Access rotates keys every 6 weeks and never pins one).
const certsRegistry = new Map<string, CertsEntry>();

function certsFor(teamDomain: string, fetchFn: typeof fetch): RemoteJWKSet {
  const existing = certsRegistry.get(teamDomain);
  if (existing) {
    existing.fetch = fetchFn;
    return existing.resolver;
  }
  const entry: CertsEntry = {
    fetch: fetchFn,
    resolver: createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`), {
      timeoutDuration: CERTS_TIMEOUT_MS,
      cooldownDuration: CERTS_COOLDOWN_MS,
      [customFetch]: (url, init) => entry.fetch(url, init),
    }),
  };
  certsRegistry.set(teamDomain, entry);
  return entry.resolver;
}

/** Access subjects are namespaced by team, so a team change never reuses an old identity. */
export function accessSubject(teamDomain: string, sub: string): string {
  return `${teamDomain}|${sub}`;
}

export async function verifyAccessAssertion(
  assertion: string | null | undefined,
  access: AccessLogin,
  deps: Pick<Deps, 'fetch' | 'now'>,
): Promise<{ ok: true; identity: LoginIdentity } | { ok: false; error: AccessVerifyError }> {
  if (!assertion) return { ok: false, error: 'missing' };
  if (assertion.length > MAX_ASSERTION_LENGTH) return { ok: false, error: 'invalid' };
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(assertion, certsFor(access.teamDomain, deps.fetch), {
      issuer: access.teamDomain,
      audience: access.aud,
      algorithms: ACCESS_ALGS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(deps.now()),
      requiredClaims: ['sub', 'exp', 'iat'],
    }));
  } catch (error) {
    // A certs timeout or a non-jose (network) error means unavailable; any other is a bad assertion.
    const unavailable = error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError);
    return { ok: false, error: unavailable ? 'certs_unavailable' : 'invalid' };
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const emails = authoritativeEmails('access', { email: payload.email });
  // Service tokens carry `common_name` and an empty `sub`, never an email.
  if (sub === '' || emails.length === 0) return { ok: false, error: 'no_email' };
  return {
    ok: true,
    identity: {
      loginProvider: 'access',
      subject: accessSubject(access.teamDomain, sub),
      emails,
      name: typeof payload.name === 'string' ? payload.name : null,
    },
  };
}

/** Drops cached Access key sets. Tests only. */
export function resetAccessCertsCacheForTests(): void {
  certsRegistry.clear();
}
