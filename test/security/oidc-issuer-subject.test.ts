import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalIssuer,
  legacyOidcSubjects,
  oidcSubject,
  resetOidcDiscoveryCacheForTests,
} from '../../src/admin/auth/oidc';
import { SESSION_COOKIE } from '../../src/admin/auth/session';
import {
  createAdminTestApp,
  createUser,
  resetControlPlane,
  setCookies,
  stubAdminPages,
} from '../helpers/admin-auth';
import {
  callback,
  combineFetch,
  type FakeOidc,
  fakeOidc,
  startLogin,
} from '../helpers/login-providers';

beforeEach(async () => {
  await resetControlPlane();
  resetOidcDiscoveryCacheForTests();
});

const GOOGLE = 'https://accounts.google.com';
const GOOGLE_ENV = { AUTH_GOOGLE_CLIENT_ID: 'gid', AUTH_GOOGLE_CLIENT_SECRET: 'secret' };
const oidcEnv = (issuer: string) => ({
  AUTH_OIDC_ISSUER: issuer,
  AUTH_OIDC_CLIENT_ID: 'gid',
  AUTH_OIDC_CLIENT_SECRET: 'secret',
});

/** Signs in `sub` through the app configured with `loginEnv`; returns the callback response. */
async function signIn(idp: FakeOidc, loginEnv: Record<string, string>, sub = 'g-1') {
  const app = createAdminTestApp({
    env: loginEnv,
    fetch: combineFetch(idp.handler),
    routes: stubAdminPages,
  });
  const started = await startLogin(app.request, 'oidc');
  const code = idp.issueCode({
    sub,
    nonce: started.nonce,
    email: 'dev@gmail.com',
    email_verified: true,
  });
  const res = await callback(
    app.request,
    'oidc',
    { code, state: started.state },
    started.oauthCookie,
  );
  const session = setCookies(res).get(SESSION_COOKIE);
  const admin = session
    ? await app.request('/admin', { headers: { cookie: `${SESSION_COOKIE}=${session.value}` } })
    : null;
  return { status: res.status, adminStatus: admin?.status ?? null };
}

async function identities() {
  const { results } = await env.DB.prepare(
    "SELECT subject FROM user_identities WHERE login_provider = 'oidc' ORDER BY subject",
  ).all<{ subject: string }>();
  return results.map((row) => row.subject);
}

async function sessionSubjects() {
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT identity_subject FROM sessions ORDER BY identity_subject',
  ).all<{ identity_subject: string }>();
  return results.map((row) => row.identity_subject);
}

describe('I-LINK-1: a linked OIDC identity signs in under every spelling of its issuer', () => {
  it.each([
    ['https://accounts.google.com', GOOGLE],
    ['https://accounts.google.com/', GOOGLE],
    ['https://ACCOUNTS.google.com', GOOGLE],
    ['https://accounts.google.com:443/', GOOGLE],
    ['https://idp.example.com/realms/acme', 'https://idp.example.com/realms/acme'],
    ['https://IDP.example.com/realms/acme/', 'https://idp.example.com/realms/acme/'],
  ])('canonicalIssuer(%s) = %s', (issuer, canonical) => {
    expect(canonicalIssuer(issuer)).toBe(canonical);
    expect(oidcSubject(issuer, 's')).toBe(`${canonical}|s`);
  });

  it('switching from AUTH_GOOGLE_* to an equivalent AUTH_OIDC_ISSUER spelling keeps the user', async () => {
    await createUser({ email: 'dev@gmail.com', status: 'invited' });
    const idp = await fakeOidc({ issuer: GOOGLE, clientId: 'gid' });
    expect(await signIn(idp, GOOGLE_ENV)).toEqual({ status: 302, adminStatus: 200 });
    for (const spelling of [
      'https://accounts.google.com/',
      'https://ACCOUNTS.google.com',
      GOOGLE,
    ]) {
      resetOidcDiscoveryCacheForTests();
      expect(await signIn(idp, oidcEnv(spelling))).toEqual({ status: 302, adminStatus: 200 });
    }
    expect(await identities()).toEqual([`${GOOGLE}|g-1`]);
    expect(await sessionSubjects()).toEqual([`${GOOGLE}|g-1`]);
  });

  it.each([
    ['https://accounts.google.com/', 'https://accounts.google.com/'],
    ['https://ACCOUNTS.google.com', 'https://ACCOUNTS.google.com'],
    ['https://accounts.google.com/', GOOGLE],
  ])(
    'an identity stored under the configured spelling %s (now %s) still signs in',
    async (stored, configured) => {
      await createUser({
        email: 'dev@gmail.com',
        identity: { loginProvider: 'oidc', subject: `${stored}|g-1` },
      });
      const idp = await fakeOidc({ issuer: GOOGLE, clientId: 'gid' });
      expect(await signIn(idp, oidcEnv(configured))).toEqual({ status: 302, adminStatus: 200 });
      // The session binds to the stored identity, so its liveness check keeps holding.
      expect(await sessionSubjects()).toEqual([`${stored}|g-1`]);
      expect(await identities()).toEqual([`${stored}|g-1`]);
    },
  );

  it('legacy spellings never match another subject', () => {
    expect(legacyOidcSubjects(GOOGLE, 'g-1')).toEqual(['https://accounts.google.com/|g-1']);
    expect(legacyOidcSubjects('https://ACCOUNTS.google.com', 'g-1')).toEqual([
      'https://ACCOUNTS.google.com|g-1',
      'https://accounts.google.com/|g-1',
    ]);
    expect(legacyOidcSubjects('https://idp.example.com/realms/acme', 'g-1')).toEqual([]);
  });
});
