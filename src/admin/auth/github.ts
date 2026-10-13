// GitHub OAuth App login (code + PKCE via oauth4webapi, static metadata: GitHub has no discovery).
// Identity is the numeric user id; emails are the verified /user/emails entries (I-LINK-1); the
// GitHub access token never leaves completeGithubLogin.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
import * as oauth from 'oauth4webapi';
import type { GithubLogin } from '../../config';
import type { Deps } from '../../deps';
import { authoritativeEmails } from './email';
import { type LoginResult, loginFailure, oauthClient, oauthHttp } from './oidc';

const GITHUB_SERVER: oauth.AuthorizationServer = {
  issuer: 'https://github.com',
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
};
export const GITHUB_API = 'https://api.github.com';
const OUTBOUND_TIMEOUT_MS = 10_000;

export function githubScope(github: GithubLogin): string {
  return github.allowedOrgs.length > 0 ? 'read:user user:email read:org' : 'read:user user:email';
}

export function githubAuthorizationUrl(
  github: GithubLogin,
  input: { redirectUri: string; state: string; codeChallenge: string },
): URL {
  const url = new URL(GITHUB_SERVER.authorization_endpoint as string);
  url.searchParams.set('client_id', github.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', githubScope(github));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'false');
  return url;
}

export async function completeGithubLogin(
  deps: Pick<Deps, 'fetch' | 'now'>,
  github: GithubLogin,
  input: { callbackUrl: URL; expectedState: string; redirectUri: string; codeVerifier: string },
): Promise<LoginResult> {
  try {
    const client = oauthClient(github.clientId, deps);
    const params = oauth.validateAuthResponse(
      GITHUB_SERVER,
      client,
      input.callbackUrl,
      input.expectedState,
    );
    const response = await oauth.authorizationCodeGrantRequest(
      GITHUB_SERVER,
      client,
      oauth.ClientSecretPost(github.clientSecret),
      params,
      input.redirectUri,
      input.codeVerifier,
      oauthHttp(deps),
    );
    // GitHub reports some errors as HTTP 200 with an `error` body; this throws because the body
    // has no access_token.
    const { access_token: token } = await oauth.processAuthorizationCodeResponse(
      GITHUB_SERVER,
      client,
      response,
    );

    const user = asObject(await githubGet(deps, token, '/user'));
    const id = user?.id;
    if (user === null || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      return { ok: false, error: 'provider_error' };
    }
    const emailEntries = await githubGet(deps, token, '/user/emails');
    if (!Array.isArray(emailEntries)) return { ok: false, error: 'provider_error' };
    if (github.allowedOrgs.length > 0 && !(await activeInAnyOrg(deps, token, github.allowedOrgs))) {
      return { ok: false, error: 'org_not_allowed' };
    }
    const displayName = [user.name, user.login].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    return {
      ok: true,
      identity: {
        loginProvider: 'github',
        subject: String(id),
        emails: authoritativeEmails('github', {
          emails: emailEntries.map(asObject).filter((entry) => entry !== null),
        }),
        name: displayName ?? null,
      },
    };
  } catch (error) {
    return { ok: false, error: loginFailure('github', error) };
  }
}

/** GET on the REST API: parsed JSON, null for 404; other non-2xx throw so the login fails closed. */
async function githubGet(deps: Pick<Deps, 'fetch'>, token: string, path: string): Promise<unknown> {
  const response = await deps.fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'cloudflare-tokengate',
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new GithubApiError(response.status);
  return response.json();
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * True when the user is an `active` member of at least one allowed org. Orgs with OAuth App access
 * restrictions hide membership until the app is approved; that reads as "not a member".
 * https://docs.github.com/en/rest/orgs/members#get-an-organization-membership-for-the-authenticated-user
 */
async function activeInAnyOrg(
  deps: Pick<Deps, 'fetch'>,
  token: string,
  orgs: string[],
): Promise<boolean> {
  for (const org of orgs) {
    // Org logins are validated by config.ts to [a-z0-9-], so they are safe in a path segment.
    const membership = await githubGet(deps, token, `/user/memberships/orgs/${org}`).catch(
      (error: unknown) => {
        if (error instanceof GithubApiError && error.status === 403) return null;
        throw error;
      },
    );
    if (asObject(membership)?.state === 'active') return true;
  }
  return false;
}

class GithubApiError extends Error {
  override name = 'GithubApiError';
  readonly status: number;
  constructor(status: number) {
    super(`GitHub API responded ${status}`);
    this.status = status;
  }
}
