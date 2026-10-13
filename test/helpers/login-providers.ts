// Fake login providers served through an injected `fetch`: GitHub (OAuth App + REST API), a
// generic OIDC issuer (discovery + token endpoint issuing ID tokens) and Cloudflare Access certs.
// Plus `oauthLogin`, which drives /auth/<provider>/start → callback like a browser would.
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OAUTH_COOKIE } from '../../src/admin/auth/routes';
import { setCookies } from './admin-auth';

type FetchHandler = (url: URL, init: RequestInit | undefined) => Promise<Response | null>;

/** Combines fakes; the first handler returning a Response wins, anything else throws. */
export function combineFetch(...handlers: FetchHandler[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    for (const handler of handlers) {
      const response = await handler(url, init);
      if (response) return response;
    }
    throw new Error(`unexpected outbound fetch in test: ${url.href}`);
  };
}

export interface FakeGithubOptions {
  userId?: number | string;
  login?: string;
  name?: string | null;
  emails?: Array<{ email: string; verified: boolean; primary?: boolean }>;
  /** org login → membership state; missing orgs answer 404. */
  orgs?: Record<string, 'active' | 'pending'>;
  /** Overrides the token endpoint response. */
  tokenResponse?: () => Response;
}

export interface FakeGithub {
  handler: FetchHandler;
  /** Form bodies POSTed to the token endpoint. */
  tokenRequests: URLSearchParams[];
  /** Authorization headers seen by the REST API. */
  apiAuthorizations: string[];
}

export const GITHUB_TEST_TOKEN = 'gho_TESTTOKEN0123456789';

export function fakeGithub(options: FakeGithubOptions = {}): FakeGithub {
  const tokenRequests: URLSearchParams[] = [];
  const apiAuthorizations: string[] = [];
  const handler: FetchHandler = async (url, init) => {
    if (url.href === 'https://github.com/login/oauth/access_token') {
      tokenRequests.push(new URLSearchParams(String(init?.body ?? '')));
      if (options.tokenResponse) return options.tokenResponse();
      return Response.json({ access_token: GITHUB_TEST_TOKEN, token_type: 'bearer', scope: '' });
    }
    if (url.origin !== 'https://api.github.com') return null;
    apiAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
    if (url.pathname === '/user') {
      return Response.json({
        id: options.userId ?? 583231,
        login: options.login ?? 'octocat',
        name: options.name === undefined ? 'The Octocat' : options.name,
      });
    }
    if (url.pathname === '/user/emails') {
      return Response.json(
        options.emails ?? [{ email: 'octocat@example.com', verified: true, primary: true }],
      );
    }
    const org = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname)?.[1];
    if (org !== undefined) {
      const state = options.orgs?.[org];
      return state ? Response.json({ state, role: 'member' }) : new Response('{}', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { handler, tokenRequests, apiAuthorizations };
}

export interface FakeOidc {
  issuer: string;
  handler: FetchHandler;
  /** Registers an authorization code that redeems to an ID token with these claims. */
  issueCode(claims: Record<string, unknown>): string;
  tokenRequests: URLSearchParams[];
}

export async function fakeOidc(options: { issuer: string; clientId: string }): Promise<FakeOidc> {
  const { privateKey } = await generateKeyPair('RS256');
  const codes = new Map<string, Record<string, unknown>>();
  const tokenRequests: URLSearchParams[] = [];
  const issuer = options.issuer;
  const handler: FetchHandler = async (url, init) => {
    if (url.href === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.href === `${issuer}/token`) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      tokenRequests.push(body);
      const claims = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      if (!claims) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        iss: issuer,
        aud: options.clientId,
        iat: now,
        exp: now + 300,
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'idp-key' })
        .sign(privateKey);
      return Response.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken });
    }
    return null;
  };
  return {
    issuer,
    handler,
    tokenRequests,
    issueCode(claims) {
      const code = `code-${crypto.randomUUID()}`;
      codes.set(code, claims);
      return code;
    },
  };
}

export interface FakeAccess {
  teamDomain: string;
  aud: string;
  handler: FetchHandler;
  sign(claims: Record<string, unknown>, options?: { aud?: string; iss?: string }): Promise<string>;
}

export async function fakeAccess(team = 'acme'): Promise<FakeAccess> {
  const teamDomain = `https://${team}.cloudflareaccess.com`;
  const aud = 'a'.repeat(64);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'access-key', alg: 'RS256', use: 'sig' };
  return {
    teamDomain,
    aud,
    handler: async (url) =>
      url.href === `${teamDomain}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : null,
    async sign(claims, signOptions = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ type: 'app', iat: now, exp: now + 300, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'access-key' })
        .setIssuer(signOptions.iss ?? teamDomain)
        .setAudience(signOptions.aud ?? aud)
        .sign(privateKey);
    },
  };
}

export interface StartedLogin {
  state: string;
  nonce: string | null;
  /** `Cookie` header value carrying the OAuth state cookie. */
  oauthCookie: string;
  authorizeUrl: URL;
  start: Response;
}

type RequestFn = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * GET /auth/<provider>/start and capture what the browser would keep. `cookie` is the `Cookie`
 * header the browser sends (e.g. the OAuth cookie of a login already in progress in another tab).
 */
export async function startLogin(
  request: RequestFn,
  provider: 'github' | 'oidc',
  returnTo?: string,
  cookie?: string | null,
): Promise<StartedLogin> {
  const query = returnTo === undefined ? '' : `?${new URLSearchParams({ return_to: returnTo })}`;
  const start = await request(`/auth/${provider}/start${query}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  const location = start.headers.get('location');
  if (start.status !== 302 || !location) throw new Error(`start failed: ${start.status}`);
  const authorizeUrl = new URL(location);
  const stored = setCookies(start).get(OAUTH_COOKIE);
  if (!stored) throw new Error('no oauth cookie');
  return {
    state: authorizeUrl.searchParams.get('state') ?? '',
    nonce: authorizeUrl.searchParams.get('nonce'),
    oauthCookie: `${OAUTH_COOKIE}=${stored.value}`,
    authorizeUrl,
    start,
  };
}

/** GET /auth/<provider>/callback with the given code/state and cookies. */
export function callback(
  request: RequestFn,
  provider: 'github' | 'oidc',
  params: Record<string, string>,
  cookie: string | null,
): Promise<Response> {
  return request(`/auth/${provider}/callback?${new URLSearchParams(params)}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
}
