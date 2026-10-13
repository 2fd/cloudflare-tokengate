import { beforeEach, describe, expect, it } from 'vitest';
import { resetOidcDiscoveryCacheForTests } from '../../src/admin/auth/oidc';
import { parseConfig } from '../../src/config';
import { createAdminTestApp, createUser, resetControlPlane } from '../helpers/admin-auth';
import { callback, combineFetch, fakeOidc, startLogin } from '../helpers/login-providers';

beforeEach(async () => {
  await resetControlPlane();
  resetOidcDiscoveryCacheForTests();
});

const VARIANTS = ['https://accounts.google.com/', 'https://ACCOUNTS.google.com'];

describe('I-LINK-1: Google issuer spellings keep the hd rules', () => {
  it.each(VARIANTS)('classifies AUTH_OIDC_ISSUER=%s as Google', (issuer) => {
    const config = parseConfig({
      AUTH_OIDC_ISSUER: issuer,
      AUTH_OIDC_CLIENT_ID: 'gid',
      AUTH_OIDC_CLIENT_SECRET: 'secret',
      AUTH_OIDC_ALLOWED_DOMAINS: 'acme.com',
      DB: {} as D1Database,
      TELEMETRY_DB: {} as D1Database,
    });
    expect(config.login.oidc?.kind).toBe('google');
    // Discovery uses the configured spelling; subjects use the canonical issuer.
    expect(config.login.oidc?.issuer).toBe(issuer);
  });

  it.each(VARIANTS)(
    'refuses a consumer account with a company address (issuer %s)',
    async (configured) => {
      await createUser({
        email: 'dev@acme.com',
        status: 'invited',
        inviteExpiresAt: Date.now() + 60_000,
      });
      const idp = await fakeOidc({ issuer: 'https://accounts.google.com', clientId: 'gid' });
      const app = createAdminTestApp({
        env: {
          AUTH_OIDC_ISSUER: configured,
          AUTH_OIDC_CLIENT_ID: 'gid',
          AUTH_OIDC_CLIENT_SECRET: 'secret',
          AUTH_OIDC_ALLOWED_DOMAINS: 'acme.com',
        },
        fetch: combineFetch(idp.handler),
      });
      const login = async (claims: Record<string, unknown>) => {
        const started = await startLogin(app.request, 'oidc');
        const code = idp.issueCode({
          sub: 'g-1',
          nonce: started.nonce,
          email_verified: true,
          ...claims,
        });
        return callback(app.request, 'oidc', { code, state: started.state }, started.oauthCookie);
      };
      expect((await login({ email: 'dev@acme.com' })).status).toBe(403);
      expect((await login({ email: 'dev@acme.com', hd: 'acme.com' })).status).toBe(302);
    },
  );
});
