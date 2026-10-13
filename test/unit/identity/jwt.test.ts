import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCallerIdentity,
  decodeUnverified,
  discoverJwksUri,
  headerAcceptable,
  isCompactJws,
  MAX_TOKEN_LENGTH,
  resetJwksCacheForTests,
  tenantPinHolds,
  verifyCallerToken,
} from '../../../src/identity/jwt';
import { PROFILES } from '../../../src/identity/profiles';
import {
  createClock,
  createTestIssuer,
  GITHUB_ISSUER,
  GITLAB_ISSUER,
  githubClaims,
  gitlabClaims,
  testCallerProvider,
} from '../../helpers/jwt';

beforeEach(() => resetJwksCacheForTests());
afterEach(() => {
  resetJwksCacheForTests();
  vi.useRealTimers();
});

describe('isCompactJws', () => {
  it.each([
    ['three base64url parts', 'eyJh.eyJi.c2ln', true],
    ['empty signature', 'eyJh.eyJi.', false],
    ['two parts', 'eyJh.eyJi', false],
    ['four parts', 'a.b.c.d', false],
    ['padding', 'eyJh.eyJi.c2ln==', false],
    ['standard base64', 'ey+h.eyJi.c2ln', false],
    ['whitespace', 'eyJh.eyJi.c2ln ', false],
    ['empty', '', false],
  ])('%s', (_label, token, expected) => {
    expect(isCompactJws(token)).toBe(expected);
  });

  it('rejects tokens over the length cap', () => {
    expect(isCompactJws(`a.b.${'c'.repeat(MAX_TOKEN_LENGTH)}`)).toBe(false);
  });
});

describe('decodeUnverified', () => {
  it('reads alg, kid and iss without verifying', async () => {
    const issuer = await createTestIssuer();
    const token = await issuer.sign(githubClaims());
    expect(decodeUnverified(token)).toEqual({
      alg: 'RS256',
      kid: 'test-key-1',
      iss: GITHUB_ISSUER,
    });
  });

  it('returns null kid/iss when absent or not strings', async () => {
    const issuer = await createTestIssuer();
    const token = await issuer.sign({ iss: 42 }, { header: { kid: 7 } });
    expect(decodeUnverified(token)).toEqual({ alg: 'RS256', kid: null, iss: null });
  });

  it.each([
    'not-a-jwt',
    'eyJh.eyJi.c2ln',
    `${btoa('{"alg":"RS256"}')}.${btoa('[1]')}.c2ln`.replace(/=/g, ''),
    `${btoa('{"kid":"k"}')}.${btoa('{}')}.c2ln`.replace(/=/g, ''),
  ])('returns null for malformed input %#', (token) => {
    expect(decodeUnverified(token)).toBeNull();
  });
});

describe('headerAcceptable', () => {
  const provider = { allowed_algs: ['RS256', 'ES256'] };

  it.each([
    [{ alg: 'RS256', kid: 'abc-DEF_1.2' }, true],
    [{ alg: 'ES256', kid: 'k' }, true],
    [{ alg: 'RS384', kid: 'k' }, false],
    [{ alg: 'none', kid: 'k' }, false],
    [{ alg: 'HS256', kid: 'k' }, false],
    [{ alg: 'RS256', kid: null }, false],
    [{ alg: 'RS256', kid: '' }, false],
    [{ alg: 'RS256', kid: 'a b' }, false],
    [{ alg: 'RS256', kid: 'k'.repeat(128) }, true],
    [{ alg: 'RS256', kid: 'k'.repeat(129) }, false],
  ])('%j → %s', (decoded, expected) => {
    expect(headerAcceptable(decoded, provider)).toBe(expected);
  });

  it('never accepts HS256 even if a provider row lists it', () => {
    expect(headerAcceptable({ alg: 'HS256', kid: 'k' }, { allowed_algs: ['HS256'] })).toBe(false);
  });
});

describe('verifyCallerToken', () => {
  it('returns the raw verified claims of a GitHub token', async () => {
    const clock = createClock();
    const issuer = await createTestIssuer({ now: clock.now });
    const claims = githubClaims();
    const provider = testCallerProvider(issuer);
    const result = await verifyCallerToken(
      await issuer.sign(claims),
      provider,
      PROFILES['github-actions'],
      { fetch: issuer.fetch, now: clock.now },
    );
    expect(result).toEqual({
      ok: true,
      claims: {
        ...claims,
        iss: GITHUB_ISSUER,
        iat: clock.now() / 1000,
        exp: clock.now() / 1000 + 300,
      },
    });
    expect(issuer.requests).toEqual([issuer.jwksUri]);
  });

  it('verifies a GitLab token', async () => {
    const clock = createClock();
    const issuer = await createTestIssuer({ issuer: GITLAB_ISSUER, now: clock.now });
    const result = await verifyCallerToken(
      await issuer.sign(gitlabClaims()),
      testCallerProvider(issuer),
      PROFILES['gitlab-ci'],
      { fetch: issuer.fetch, now: clock.now },
    );
    expect(result.ok).toBe(true);
  });

  it('verifies ES256 tokens from a generic issuer', async () => {
    const clock = createClock();
    const issuer = await createTestIssuer({
      issuer: 'https://agent.buildkite.com',
      alg: 'ES256',
      now: clock.now,
    });
    const provider = testCallerProvider(issuer, { anchor_claims: ['organization_id'] });
    const token = await issuer.sign({
      sub: 'org:acme',
      organization_id: 'o1',
      aud: provider.audience,
    });
    const result = await verifyCallerToken(token, provider, PROFILES.generic, {
      fetch: issuer.fetch,
      now: clock.now,
    });
    expect(result.ok).toBe(true);
  });

  it('uses the injected clock, not the system clock', async () => {
    const clock = createClock(Date.UTC(2030, 0, 1));
    const issuer = await createTestIssuer({ now: clock.now });
    const token = await issuer.sign(githubClaims());
    const deps = { fetch: issuer.fetch, now: clock.now };
    const provider = testCallerProvider(issuer);
    expect((await verifyCallerToken(token, provider, PROFILES['github-actions'], deps)).ok).toBe(
      true,
    );
    clock.advance(601_000 + 30_000);
    expect(await verifyCallerToken(token, provider, PROFILES['github-actions'], deps)).toEqual({
      ok: false,
      code: 'token_expired',
    });
  });

  it('picks up a rotated key once jose cooldown has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 13, 12));
    const clock = createClock();
    const issuer = await createTestIssuer({ now: clock.now });
    const provider = testCallerProvider(issuer);
    const deps = { fetch: issuer.fetch, now: clock.now };
    const profile = PROFILES['github-actions'];

    expect(
      (await verifyCallerToken(await issuer.sign(githubClaims()), provider, profile, deps)).ok,
    ).toBe(true);
    await issuer.rotateKey('test-key-2');

    vi.setSystemTime(Date.UTC(2026, 9, 13, 12, 0, 31));
    clock.advance(31_000);
    const rotated = await issuer.sign(githubClaims());
    expect((await verifyCallerToken(rotated, provider, profile, deps)).ok).toBe(true);
    expect(issuer.jwksFetchCount()).toBe(2);
  });

  it('reports jwks_unavailable for an unusable jwks_uri', async () => {
    const clock = createClock();
    const issuer = await createTestIssuer({ now: clock.now });
    const provider = testCallerProvider(issuer, { jwks_uri: 'not a url' });
    const result = await verifyCallerToken(
      await issuer.sign(githubClaims()),
      provider,
      PROFILES['github-actions'],
      { fetch: issuer.fetch, now: clock.now },
    );
    expect(result).toEqual({ ok: false, code: 'jwks_unavailable' });
  });

  it('reports jwks_unavailable for a JWKS that is not JSON', async () => {
    const clock = createClock();
    const issuer = await createTestIssuer({ now: clock.now });
    const result = await verifyCallerToken(
      await issuer.sign(githubClaims()),
      testCallerProvider(issuer),
      PROFILES['github-actions'],
      { fetch: async () => new Response('<html>'), now: clock.now },
    );
    expect(result).toEqual({ ok: false, code: 'jwks_unavailable' });
  });

  it('never throws on garbage input', async () => {
    const clock = createClock();
    const issuer = await createTestIssuer({ now: clock.now });
    for (const token of ['', 'a.b.c', 'x'.repeat(100_000), '\u0000.\u0000.\u0000']) {
      const result = await verifyCallerToken(
        token,
        testCallerProvider(issuer),
        PROFILES['github-actions'],
        { fetch: issuer.fetch, now: clock.now },
      );
      expect(result).toEqual({ ok: false, code: 'token_malformed' });
    }
    expect(issuer.jwksFetchCount()).toBe(0);
  });
});

describe('buildCallerIdentity', () => {
  const issuer = { issuer: GITHUB_ISSUER, jwksUri: `${GITHUB_ISSUER}/.well-known/jwks` };
  const provider = testCallerProvider(issuer);

  it('carries the raw verified claims, profile and jti', () => {
    const claims = githubClaims({ jti: 'jti-1' });
    const identity = buildCallerIdentity(provider, PROFILES['github-actions'], claims);
    expect(identity).toEqual({
      callerProviderId: provider.id,
      profile: 'github-actions',
      claims,
      display: PROFILES['github-actions'].display(claims),
      jti: 'jti-1',
    });
    expect(identity.claims).toBe(claims);
  });

  it('omits jti when it is not a string', () => {
    const identity = buildCallerIdentity(
      provider,
      PROFILES['github-actions'],
      githubClaims({ jti: 5 }),
    );
    expect('jti' in identity).toBe(false);
  });

  it('keeps display separate from the claims used for authorization', () => {
    // A renamed/re-registered repository: the display name looks right, the immutable ID does not.
    const claims = githubClaims({ repository_owner_id: '666', repository: 'acme/app' });
    const identity = buildCallerIdentity(provider, PROFILES['github-actions'], claims);
    expect(identity.display.repository).toBe('acme/app');
    expect(tenantPinHolds(provider, identity.claims)).toBe(false);

    // Display is truncated/normalized; the claims are untouched.
    const long = `refs/heads/${'x'.repeat(400)}`;
    const longIdentity = buildCallerIdentity(
      provider,
      PROFILES['github-actions'],
      githubClaims({ ref: long }),
    );
    expect(longIdentity.claims.ref).toBe(long);
    expect(longIdentity.display.ref).not.toBe(long);

    // Mutating display cannot change what policy sees.
    identity.display.repository = 'evil/repo';
    expect(identity.claims.repository).toBe('acme/app');
  });
});

describe('discoverJwksUri', () => {
  it('returns jwks_uri when the document names the configured issuer', async () => {
    const issuer = await createTestIssuer({ issuer: GITLAB_ISSUER });
    expect(await discoverJwksUri(GITLAB_ISSUER, issuer.fetch)).toEqual({
      ok: true,
      jwksUri: `${GITLAB_ISSUER}/.well-known/jwks`,
    });
    expect(issuer.requests).toEqual([`${GITLAB_ISSUER}/.well-known/openid-configuration`]);
  });

  it('rejects a document whose issuer differs (even by a trailing slash)', async () => {
    const issuer = await createTestIssuer({ issuer: `${GITLAB_ISSUER}/` });
    const result = await discoverJwksUri(GITLAB_ISSUER, async () =>
      Response.json({ issuer: `${GITLAB_ISSUER}/`, jwks_uri: issuer.jwksUri }),
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    ['non-https jwks_uri', { issuer: GITLAB_ISSUER, jwks_uri: 'http://gitlab.com/keys' }],
    ['missing jwks_uri', { issuer: GITLAB_ISSUER }],
    ['jwks_uri with userinfo', { issuer: GITLAB_ISSUER, jwks_uri: 'https://u:p@gitlab.com/keys' }],
    ['jwks_uri with query', { issuer: GITLAB_ISSUER, jwks_uri: 'https://gitlab.com/keys?x=1' }],
    ['jwks_uri with fragment', { issuer: GITLAB_ISSUER, jwks_uri: 'https://gitlab.com/keys#x' }],
    ['an array document', [{ issuer: GITLAB_ISSUER, jwks_uri: 'https://gitlab.com/keys' }]],
  ])('rejects %s', async (_label, document) => {
    const result = await discoverJwksUri(GITLAB_ISSUER, async () => Response.json(document));
    expect(result.ok).toBe(false);
  });

  it('rejects non-200, non-JSON and network failures without following redirects', async () => {
    let seenRedirect: RequestInit['redirect'];
    const redirecting: typeof fetch = async (_input, init) => {
      seenRedirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
    };
    expect((await discoverJwksUri(GITLAB_ISSUER, redirecting)).ok).toBe(false);
    expect(seenRedirect).toBe('manual');
    expect((await discoverJwksUri(GITLAB_ISSUER, async () => new Response('<html>'))).ok).toBe(
      false,
    );
    expect(
      (
        await discoverJwksUri(GITLAB_ISSUER, async () => {
          throw new TypeError('boom');
        })
      ).ok,
    ).toBe(false);
  });

  it('rejects a non-https issuer without fetching', async () => {
    let called = false;
    const result = await discoverJwksUri('http://gitlab.com', async () => {
      called = true;
      return new Response();
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});
