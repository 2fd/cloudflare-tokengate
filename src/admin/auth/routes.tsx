// /auth routes: login (or setup) page, OAuth/OIDC start and callback, Access login, logout. Mounts
// the /admin middleware, which must precede every admin page. Pending logins live in a `__Host-`
// cookie keyed by `state`; each is consumed by its own callback, with a sanitized return_to
// (I-OAUTH-1).
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Child } from 'hono/jsx';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import * as oauth from 'oauth4webapi';
import type { App } from '../../app';
import {
  type Config,
  canonicalOrigin,
  type GithubLogin,
  type OidcLogin,
  parseConfig,
} from '../../config';
import { randomToken } from '../../crypto/hash';
import { type AdminContext, formData } from '../render';
import { Layout } from '../views/layout';
import { ACCESS_JWT_HEADER, verifyAccessAssertion } from './access';
import { CSRF_FIELD, csrfTokenMatches, requestFromSameSite } from './csrf';
import { completeGithubLogin, githubAuthorizationUrl } from './github';
import { registerAdminMiddleware } from './middleware';
import {
  addPendingLogin,
  decodePendingLogins,
  encodePendingLogins,
  OAUTH_COOKIE,
  OAUTH_STATE_TTL_MS,
  type PendingLogin,
  takePendingLogin,
} from './oauth-state';
import { completeOidcLogin, type LoginFailure, loginFailure, oidcAuthorizationUrl } from './oidc';
import { type LoginIdentity, resolveLogin } from './resolve-login';
import {
  clearSessionCookie,
  issueSession,
  loadSession,
  readSessionCookie,
  requestMeta,
  revokeSession,
  sanitizeReturnTo,
  setSessionCookie,
} from './session';

export { OAUTH_COOKIE, OAUTH_STATE_TTL_MS };

const OAUTH_COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
} as const;

/** User-facing messages. Keys only ever come from this module, never from the query string. */
const MESSAGES = {
  state_invalid:
    'This sign-in attempt expired or was started in another browser. Start again from this page.',
  provider_error: 'The login provider did not complete the sign-in. Try again.',
  provider_unavailable: 'The login provider could not be reached. Try again later.',
  org_not_allowed: 'Your GitHub account is not an active member of an allowed organization.',
  domain_not_allowed: 'This account has no verified email address in an allowed domain.',
  not_invited:
    'This account has not been invited. Ask an owner to invite your email address, then sign in again.',
  disabled: 'This account is disabled or must be re-invited by an owner.',
  access_invalid: 'Cloudflare Access did not present a valid user identity for this request.',
  signed_out: 'You have signed out.',
} as const;
type MessageKey = keyof typeof MESSAGES;

const FAILURE_STATUS: Record<LoginFailure, ContentfulStatusCode> = {
  provider_error: 400,
  provider_unavailable: 502,
  org_not_allowed: 403,
  domain_not_allowed: 403,
};

export function registerAuthRoutes(app: App): void {
  registerAdminMiddleware(app);

  app.get('/auth/login', async (c) => {
    const deps = c.get('deps');
    const returnTo = sanitizeReturnTo(c.req.query('return_to'));
    const cookie = readSessionCookie(c);
    if (cookie !== null && (await loadSession(deps, cookie))) return c.redirect(returnTo, 302);
    const notice = c.req.query('notice') === 'signed_out' ? MESSAGES.signed_out : null;
    return loginPage(c, { returnTo, notice });
  });

  app.get('/auth/:login_provider/start', async (c) => {
    const deps = c.get('deps');
    const config = parseConfig(deps.env);
    const provider = c.req.param('login_provider');
    const returnTo = sanitizeReturnTo(c.req.query('return_to'));

    if (provider === 'access') {
      const access = config.login.access;
      if (!access) return c.notFound();
      const result = await verifyAccessAssertion(c.req.header(ACCESS_JWT_HEADER), access, deps);
      if (!result.ok) {
        console.warn(JSON.stringify({ type: 'auth.login_failed', provider, error: result.error }));
        return loginPage(c, { returnTo, error: 'access_invalid', status: 401 });
      }
      return finishLogin(c, result.identity, returnTo);
    }

    const login = oauthLogin(config, provider);
    if (!login) return c.notFound();

    const state = randomToken(deps.random);
    const codeVerifier = randomToken(deps.random);
    const nonce = randomToken(deps.random);
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
    const redirectUri = callbackUrl(config, c.req.url, login.provider);
    let target: URL;
    if (login.provider === 'github') {
      target = githubAuthorizationUrl(login.config, { redirectUri, state, codeChallenge });
    } else {
      try {
        target = await oidcAuthorizationUrl(deps, login.config, {
          redirectUri,
          state,
          nonce,
          codeChallenge,
        });
      } catch (error) {
        const failure = loginFailure(provider, error);
        return loginPage(c, { returnTo, error: failure, status: FAILURE_STATUS[failure] });
      }
    }

    // Stateless on the server: anonymous /start requests must not write to D1.
    const now = deps.now();
    const entry: PendingLogin = {
      state,
      code_verifier: codeVerifier,
      nonce,
      return_to: returnTo,
      login_provider: login.provider,
      expires_at: now + OAUTH_STATE_TTL_MS,
    };
    writePendingLogins(
      c,
      addPendingLogin(decodePendingLogins(getCookie(c, OAUTH_COOKIE)), entry, now),
    );
    return c.redirect(target.href, 302);
  });

  app.get('/auth/:login_provider/callback', async (c) => {
    const deps = c.get('deps');
    const config = parseConfig(deps.env);
    const login = oauthLogin(config, c.req.param('login_provider'));
    if (!login) return c.notFound();

    const responseUrl = new URL(c.req.url);
    const state = responseUrl.searchParams.get('state');
    const now = deps.now();
    // A missing or unknown state leaves the cookie untouched: a cross-site navigation to this URL
    // must not cancel a login in progress. A matching entry is single use whatever happens next.
    const taken =
      state === null
        ? null
        : await takePendingLogin(decodePendingLogins(getCookie(c, OAUTH_COOKIE)), state, now);
    if (state === null || taken === null) {
      return loginPage(c, { returnTo: '/admin', error: 'state_invalid', status: 400 });
    }
    writePendingLogins(c, taken.rest);
    const pending = taken.match;
    if (pending.login_provider !== login.provider || pending.expires_at <= now) {
      return loginPage(c, { returnTo: '/admin', error: 'state_invalid', status: 400 });
    }

    const flow = {
      callbackUrl: responseUrl,
      expectedState: state,
      redirectUri: callbackUrl(config, c.req.url, login.provider),
      codeVerifier: pending.code_verifier,
    };
    const result =
      login.provider === 'github'
        ? await completeGithubLogin(deps, login.config, flow)
        : await completeOidcLogin(deps, login.config, { ...flow, nonce: pending.nonce });
    if (!result.ok) {
      return loginPage(c, {
        returnTo: sanitizeReturnTo(pending.return_to),
        error: result.error,
        status: FAILURE_STATUS[result.error],
      });
    }
    return finishLogin(c, result.identity, sanitizeReturnTo(pending.return_to));
  });

  app.post('/auth/logout', async (c) => {
    const deps = c.get('deps');
    const config = parseConfig(deps.env);
    if (!requestFromSameSite(c.req.raw.headers, canonicalOrigin(config, new URL(c.req.url)))) {
      return c.text('Forbidden', 403);
    }
    const cookie = readSessionCookie(c);
    const loaded = cookie === null ? null : await loadSession(deps, cookie);
    if (loaded) {
      const form = await formData(c);
      if (!(await csrfTokenMatches(form[CSRF_FIELD], loaded.session.csrf_token))) {
        return c.text('Forbidden', 403);
      }
      await revokeSession(deps, loaded.session.id_hash);
    }
    clearSessionCookie(c);
    return c.redirect('/auth/login?notice=signed_out', 303);
  });
}

/** Stores the pending logins, or deletes the cookie when none remain. */
function writePendingLogins(c: AdminContext, pending: PendingLogin[]): void {
  if (pending.length === 0) {
    deleteCookie(c, OAUTH_COOKIE, OAUTH_COOKIE_OPTIONS);
    return;
  }
  setCookie(c, OAUTH_COOKIE, encodePendingLogins(pending), {
    ...OAUTH_COOKIE_OPTIONS,
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  });
}

/** Resolves the user and starts a fresh session, revoking the browser's previous one. */
async function finishLogin(
  c: AdminContext,
  identity: LoginIdentity,
  returnTo: string,
): Promise<Response> {
  const deps = c.get('deps');
  const meta = requestMeta(c.req.raw.headers);
  const resolution = await resolveLogin(deps, { ...identity, meta });
  if (!resolution.ok) {
    console.warn(
      JSON.stringify({
        type: 'auth.login_denied',
        provider: identity.loginProvider,
        reason: resolution.reason,
      }),
    );
    return loginPage(c, { returnTo, error: resolution.reason, status: 403 });
  }
  const issued = await issueSession(deps, {
    user: resolution.user,
    loginProvider: identity.loginProvider,
    identitySubject: resolution.subject,
    previousSessionId: readSessionCookie(c),
    meta,
  });
  // The identity was removed or the user deactivated after resolveLogin (e.g. a concurrent reset).
  if (!issued) return loginPage(c, { returnTo, error: 'disabled', status: 403 });
  setSessionCookie(c, issued.sessionId);
  return c.redirect(returnTo, 302);
}

type OAuthLogin =
  | { provider: 'github'; config: GithubLogin }
  | { provider: 'oidc'; config: OidcLogin };

/** The configured redirect-based login provider named in the path, or null. */
function oauthLogin(config: Config, provider: string): OAuthLogin | null {
  const { github, oidc } = config.login;
  if (provider === 'github' && github) return { provider, config: github };
  if (provider === 'oidc' && oidc) return { provider, config: oidc };
  return null;
}

/** Exact redirect URI registered with the provider: canonical origin + fixed path. */
export function callbackUrl(
  config: Config,
  requestUrl: string,
  provider: 'github' | 'oidc',
): string {
  return `${canonicalOrigin(config, new URL(requestUrl))}/auth/${provider}/callback`;
}

function loginPage(
  c: AdminContext,
  props: {
    returnTo: string;
    error?: MessageKey;
    notice?: string | null;
    status?: ContentfulStatusCode;
  },
) {
  const config = parseConfig(c.get('deps').env);
  const origin = canonicalOrigin(config, new URL(c.req.url));
  const { github, oidc, access } = config.login;
  const loginErrors = config.errors.filter((error) => error.feature.startsWith('login.'));
  const configured = github !== null || oidc !== null || access !== null;
  const start = (provider: string) =>
    `/auth/${provider}/start?${new URLSearchParams({ return_to: props.returnTo })}`;

  return c.html(
    <Layout
      title={configured ? 'Sign in' : 'Set up sign-in'}
      notice={props.notice}
      banners={[
        ...(props.error ? [{ level: 'error' as const, text: MESSAGES[props.error] }] : []),
        ...loginErrors.map((error) => ({
          level: 'error' as const,
          text: `${error.variable}: ${error.message}`,
        })),
      ]}
    >
      {configured ? (
        <div class="login">
          {github ? (
            <a class="button" href={start('github')}>
              Sign in with GitHub
            </a>
          ) : null}
          {oidc ? (
            <a class="button" href={start('oidc')}>
              Sign in with {oidc.label}
            </a>
          ) : null}
          {access ? (
            <a class="button" href={start('access')}>
              Sign in with Cloudflare Access
            </a>
          ) : null}
        </div>
      ) : (
        <SetupInstructions origin={origin} />
      )}
    </Layout>,
    props.status ?? 200,
  );
}

/** Shown when no login provider is configured. Names variables and URLs only, never values. */
function SetupInstructions(props: { origin: string }) {
  const section = (title: string, children: Child) => (
    <>
      <h2>{title}</h2>
      {children}
    </>
  );
  return (
    <>
      <p>
        No login provider is configured. Set one of the options below as Worker variables and
        secrets (<code>wrangler secret put NAME</code> for secrets), redeploy, and reload this page.
        Also set <code>BOOTSTRAP_OWNER_EMAILS</code> to the email of the first owner; remove it
        after the first sign-in. See <code>docs/getting-started.md</code>.
      </p>
      {section(
        'GitHub',
        <ul>
          <li>
            Create an OAuth App. Authorization callback URL:{' '}
            <code>{`${props.origin}/auth/github/callback`}</code>
          </li>
          <li>
            <code>AUTH_GITHUB_CLIENT_ID</code>, secret <code>AUTH_GITHUB_CLIENT_SECRET</code>,
            optional <code>AUTH_GITHUB_ALLOWED_ORGS</code>
          </li>
        </ul>,
      )}
      {section(
        'Google',
        <ul>
          <li>
            Create an OAuth client (web application). Authorized redirect URI:{' '}
            <code>{`${props.origin}/auth/oidc/callback`}</code>
          </li>
          <li>
            <code>AUTH_GOOGLE_CLIENT_ID</code>, secret <code>AUTH_GOOGLE_CLIENT_SECRET</code>,
            optional <code>AUTH_OIDC_ALLOWED_DOMAINS</code>
          </li>
        </ul>,
      )}
      {section(
        'Other OpenID Connect provider',
        <ul>
          <li>
            Redirect URI: <code>{`${props.origin}/auth/oidc/callback`}</code>
          </li>
          <li>
            <code>AUTH_OIDC_ISSUER</code>, <code>AUTH_OIDC_CLIENT_ID</code>, secret{' '}
            <code>AUTH_OIDC_CLIENT_SECRET</code>, optional <code>AUTH_OIDC_NAME</code> and{' '}
            <code>AUTH_OIDC_ALLOWED_DOMAINS</code>
          </li>
          <li>
            Users are linked to the canonical issuer: a trailing <code>/</code> after the host or an
            upper-case host does not matter. Any other change to <code>AUTH_OIDC_ISSUER</code> is a
            new issuer, and linked users must be re-invited with Reset login.
          </li>
        </ul>,
      )}
      {section(
        'Cloudflare Access',
        <ul>
          <li>
            Requires <code>PUBLIC_URL</code> on a custom domain (not workers.dev). Protect only the{' '}
            <code>/admin</code> and <code>/auth</code> paths with the Access application.
          </li>
          <li>
            <code>AUTH_ACCESS_TEAM_DOMAIN</code>, <code>AUTH_ACCESS_AUD</code>
          </li>
        </ul>,
      )}
    </>
  );
}
