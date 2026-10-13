// OpenID Connect login (generic issuer or Google) via oauth4webapi: cached discovery, code + PKCE +
// state + nonce, ID token claim checks; emails per I-LINK-1. The ID token comes directly from the
// token endpoint over TLS, which replaces signature validation (OIDC Core §3.1.3.7 step 6).
// https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
import * as oauth from 'oauth4webapi';
import type { OidcLogin } from '../../config';
import type { Deps } from '../../deps';
import { authoritativeEmails } from './email';
import type { LoginIdentity } from './resolve-login';

export const OIDC_SCOPE = 'openid email profile';
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const OUTBOUND_TIMEOUT_MS = 10_000;

export type LoginFailure =
  /** The provider rejected the request or returned something invalid (incl. user denial). */
  | 'provider_error'
  /** Network failure or timeout talking to the provider. */
  | 'provider_unavailable'
  /** GitHub: not an active member of any AUTH_GITHUB_ALLOWED_ORGS organization. */
  | 'org_not_allowed'
  /** OIDC with AUTH_OIDC_ALLOWED_DOMAINS: no verified email in an allowed domain (Google: `hd`). */
  | 'domain_not_allowed';

export type LoginResult =
  | { ok: true; identity: LoginIdentity }
  | { ok: false; error: LoginFailure };

/** Transport options for oauth4webapi: injected fetch (no global fetch) and a timeout. */
export function oauthHttp(
  deps: Pick<Deps, 'fetch'>,
): oauth.HttpRequestOptions<'GET' | 'POST', URLSearchParams | undefined> {
  return {
    signal: () => AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    [oauth.customFetch]: (url, init) => deps.fetch(url, init as RequestInit),
  };
}

/**
 * Client metadata. oauth4webapi checks JWT timestamps against the system clock; `clockSkew`
 * shifts that to `deps.now()` so validation follows the injected clock (zero in production).
 */
export function oauthClient(clientId: string, deps: Pick<Deps, 'now'>): oauth.Client {
  return { client_id: clientId, [oauth.clockSkew]: Math.round((deps.now() - Date.now()) / 1000) };
}

/** Maps a thrown oauth4webapi/fetch error to a coarse failure, logging only its name/code. */
export function loginFailure(provider: string, error: unknown): LoginFailure {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  const name = error instanceof Error ? error.name : typeof error;
  console.warn(JSON.stringify({ type: 'auth.login_failed', provider, error: name, code }));
  const network =
    (error instanceof TypeError && code === undefined) ||
    name === 'TimeoutError' ||
    name === 'AbortError';
  return network ? 'provider_unavailable' : 'provider_error';
}

/**
 * A failed discovery is rethrown from cache for this long, so an IdP outage cannot turn anonymous
 * /auth/oidc/start traffic into one outbound fetch per request.
 */
export const DISCOVERY_FAILURE_TTL_MS = 30 * 1000;

const discoveryCache = new Map<string, { server: oauth.AuthorizationServer; fetchedAt: number }>();
const discoveryFailures = new Map<string, { error: unknown; failedAt: number }>();

async function discover(
  oidc: OidcLogin,
  deps: Pick<Deps, 'fetch' | 'now'>,
): Promise<oauth.AuthorizationServer> {
  const cached = discoveryCache.get(oidc.issuer);
  if (cached && deps.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.server;
  const failed = discoveryFailures.get(oidc.issuer);
  if (failed && deps.now() - failed.failedAt < DISCOVERY_FAILURE_TTL_MS) throw failed.error;
  const issuer = new URL(oidc.issuer);
  let server: oauth.AuthorizationServer;
  try {
    const response = await oauth.discoveryRequest(issuer, {
      algorithm: 'oidc',
      ...oauthHttp(deps),
    });
    // Rejects a document whose `issuer` differs from the configured one.
    server = await oauth.processDiscoveryResponse(issuer, response);
  } catch (error) {
    discoveryFailures.set(oidc.issuer, { error, failedAt: deps.now() });
    throw error;
  }
  discoveryFailures.delete(oidc.issuer);
  discoveryCache.set(oidc.issuer, { server, fetchedAt: deps.now() });
  return server;
}

export async function oidcAuthorizationUrl(
  deps: Pick<Deps, 'fetch' | 'now'>,
  oidc: OidcLogin,
  input: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
): Promise<URL> {
  const server = await discover(oidc, deps);
  if (!server.authorization_endpoint)
    throw new Error('OIDC discovery has no authorization_endpoint');
  const url = new URL(server.authorization_endpoint);
  url.searchParams.set('client_id', oidc.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OIDC_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Google account chooser hint only; `hd` is enforced on the ID token (see email.ts).
  if (oidc.kind === 'google' && oidc.allowedDomains.length === 1) {
    url.searchParams.set('hd', oidc.allowedDomains[0] as string);
  }
  return url;
}

export async function completeOidcLogin(
  deps: Pick<Deps, 'fetch' | 'now'>,
  oidc: OidcLogin,
  input: {
    callbackUrl: URL;
    expectedState: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  },
): Promise<LoginResult> {
  let claims: oauth.IDToken;
  try {
    const server = await discover(oidc, deps);
    const client = oauthClient(oidc.clientId, deps);
    // Checks `state` and, when the server advertises it, the RFC 9207 `iss` parameter.
    const params = oauth.validateAuthResponse(
      server,
      client,
      input.callbackUrl,
      input.expectedState,
    );
    const response = await oauth.authorizationCodeGrantRequest(
      server,
      client,
      clientAuthentication(server, oidc.clientSecret),
      params,
      input.redirectUri,
      input.codeVerifier,
      oauthHttp(deps),
    );
    const tokens = await oauth.processAuthorizationCodeResponse(server, client, response, {
      expectedNonce: input.nonce,
      requireIdToken: true,
    });
    const validated = oauth.getValidatedIdTokenClaims(tokens);
    if (!validated) return { ok: false, error: 'provider_error' };
    claims = validated;
  } catch (error) {
    return { ok: false, error: loginFailure('oidc', error) };
  }
  const emails = authoritativeEmails('oidc', { claims, config: oidc });
  // The domain restriction gates every sign-in, like AUTH_GITHUB_ALLOWED_ORGS, so narrowing it
  // also locks out identities that were linked before.
  if (oidc.allowedDomains.length > 0 && emails.length === 0) {
    return { ok: false, error: 'domain_not_allowed' };
  }
  const name = typeof claims.name === 'string' ? claims.name : null;
  return {
    ok: true,
    identity: {
      loginProvider: 'oidc',
      subject: oidcSubject(oidc.issuer, claims.sub),
      legacySubjects: legacyOidcSubjects(oidc.issuer, claims.sub),
      emails,
      name,
    },
  };
}

/**
 * OIDC subjects are namespaced by issuer: `sub` is only unique per issuer (OIDC Core §2). The
 * namespace is the canonical issuer, so every spelling discovery accepts for one issuer (compared
 * as parsed URLs) yields the same subject.
 */
export function oidcSubject(issuer: string, sub: string): string {
  return `${canonicalIssuer(issuer)}|${sub}`;
}

/**
 * Subjects an identity linked by an earlier version may carry: the issuer was then used as
 * configured, so `https://idp.example/` or an upper-case host gave a different namespace.
 */
export function legacyOidcSubjects(issuer: string, sub: string): string[] {
  const current = oidcSubject(issuer, sub);
  const spellings = [issuer, new URL(issuer).href];
  return [...new Set(spellings.map((spelling) => `${spelling}|${sub}`))].filter(
    (subject) => subject !== current,
  );
}

/**
 * Issuer as a parsed URL (lower-case host, no default port) without the `/` that URL
 * serialization adds after a bare host: `https://ACCOUNTS.google.com/` → `https://accounts.google.com`.
 */
export function canonicalIssuer(issuer: string): string {
  const url = new URL(issuer);
  return url.pathname === '/' ? url.href.slice(0, -1) : url.href;
}

/** client_secret_basic unless the server only advertises client_secret_post. */
function clientAuthentication(server: oauth.AuthorizationServer, secret: string): oauth.ClientAuth {
  const methods = server.token_endpoint_auth_methods_supported;
  if (
    methods &&
    !methods.includes('client_secret_basic') &&
    methods.includes('client_secret_post')
  ) {
    return oauth.ClientSecretPost(secret);
  }
  return oauth.ClientSecretBasic(secret);
}

/** Drops cached discovery documents and failures. Tests only. */
export function resetOidcDiscoveryCacheForTests(): void {
  discoveryCache.clear();
  discoveryFailures.clear();
}
