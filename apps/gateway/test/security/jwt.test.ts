import { base64url, exportJWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallerProvider } from '../../src/db/types';
import {
  isCompactJws,
  JWKS_REFETCH_GATE_MS,
  resetJwksCacheForTests,
  tenantPinHolds,
  verifyCallerToken,
} from '../../src/identity/jwt';
import { PROFILES } from '../../src/identity/profiles';
import type { Condition } from '../../src/policy/types';
import {
  createClock,
  createTestIssuer,
  GITHUB_ISSUER,
  GITLAB_ISSUER,
  githubClaims,
  gitlabClaims,
  hmacToken,
  TEST_AUDIENCE,
  TEST_EPOCH_MS,
  type TestIssuer,
  testCallerProvider,
  unsecuredToken,
} from '../helpers/jwt';

let clock: ReturnType<typeof createClock>;
let github: TestIssuer;
let provider: CallerProvider;
const nowSeconds = () => Math.floor(clock.now() / 1000);

function verify(token: string, target: CallerProvider = provider, issuer: TestIssuer = github) {
  return verifyCallerToken(token, target, PROFILES[target.profile], {
    fetch: issuer.fetch,
    now: clock.now,
  });
}

/** Sign options that drop `claim` when it is one of the time claims the helper adds by default. */
function omitting(claim: string) {
  if (claim === 'iat') return { iat: null, exp: nowSeconds() + 300 };
  if (claim === 'exp') return { exp: null };
  return {};
}

beforeEach(async () => {
  resetJwksCacheForTests();
  clock = createClock();
  github = await createTestIssuer({ issuer: GITHUB_ISSUER, now: clock.now });
  provider = testCallerProvider(github);
});

afterEach(() => {
  resetJwksCacheForTests();
  vi.useRealTimers();
});

describe('I-JWT-1: only correctly signed, fresh, audience-bound tokens of the exact issuer verify', () => {
  it('accepts the baseline token (sanity check for the negative cases)', async () => {
    const result = await verify(await github.sign(githubClaims()));
    expect(result.ok).toBe(true);
  });

  it('rejects alg "none"', async () => {
    const token = unsecuredToken({ kid: github.kid }, { ...githubClaims(), iss: GITHUB_ISSUER });
    expect(await verify(token)).toEqual({ ok: false, code: 'token_malformed' });
  });

  it('rejects alg "none" even with a non-empty signature segment', async () => {
    const token = `${unsecuredToken({ kid: github.kid }, { ...githubClaims(), iss: GITHUB_ISSUER })}c2ln`;
    expect(await verify(token)).toEqual({ ok: false, code: 'token_malformed' });
  });

  it('rejects HS256 signed with the issuer public key bytes (key confusion)', async () => {
    const claims = {
      ...githubClaims(),
      iss: GITHUB_ISSUER,
      iat: nowSeconds(),
      exp: nowSeconds() + 300,
    };
    const pemBytes = new TextEncoder().encode(github.publicKeyPem);
    const token = await hmacToken(pemBytes, { kid: github.kid }, claims);
    expect(await verify(token)).toEqual({ ok: false, code: 'token_malformed' });
  });

  it('rejects HS256 even when a corrupted provider row lists it as allowed', async () => {
    const corrupted = { ...provider, allowed_algs: ['RS256', 'HS256'] };
    const claims = {
      ...githubClaims(),
      iss: GITHUB_ISSUER,
      iat: nowSeconds(),
      exp: nowSeconds() + 300,
    };
    const token = await hmacToken(
      new TextEncoder().encode(github.publicKeyPem),
      { kid: github.kid },
      claims,
    );
    expect(await verify(token, corrupted)).toEqual({ ok: false, code: 'token_malformed' });
  });

  it('rejects an algorithm the provider does not allow, even when the signature is valid', async () => {
    const token = await github.sign(githubClaims());
    expect(await verify(token, { ...provider, allowed_algs: ['ES256'] })).toEqual({
      ok: false,
      code: 'token_malformed',
    });
  });

  it('rejects a token without kid', async () => {
    const token = await github.sign(githubClaims(), { kid: null });
    expect(await verify(token)).toEqual({ ok: false, code: 'token_malformed' });
  });

  it.each([
    ['too long', 'k'.repeat(129)],
    ['path characters', '../../keys'],
    ['empty', ''],
  ])('rejects a kid that is %s', async (_label, kid) => {
    const token = await github.sign(githubClaims(), { kid });
    expect(await verify(token)).toEqual({ ok: false, code: 'token_malformed' });
  });

  it('rejects an unknown kid as an invalid signature', async () => {
    const token = await github.sign(githubClaims(), { kid: 'attacker-key' });
    expect(await verify(token)).toEqual({ ok: false, code: 'signature_invalid' });
  });

  it('rejects a token signed by another key that reuses the published kid', async () => {
    const impostor = await createTestIssuer({
      issuer: GITHUB_ISSUER,
      kid: github.kid,
      now: clock.now,
    });
    const token = await impostor.sign(githubClaims());
    expect(await verify(token)).toEqual({ ok: false, code: 'signature_invalid' });
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await github.sign(githubClaims())).split('.');
    const forged = (await github.sign(githubClaims({ repository_id: '1' }))).split('.')[1];
    expect(await verify(`${header}.${forged}.${signature}`)).toEqual({
      ok: false,
      code: 'signature_invalid',
    });
  });

  it('rejects an aud array that does not contain our audience', async () => {
    const token = await github.sign(
      githubClaims({ aud: ['https://github.com/acme', 'sts.amazonaws.com'] }),
    );
    expect(await verify(token)).toEqual({ ok: false, code: 'audience_mismatch' });
  });

  it('accepts an aud array that contains our audience', async () => {
    const token = await github.sign(
      githubClaims({ aud: ['sts.amazonaws.com', provider.audience] }),
    );
    expect((await verify(token)).ok).toBe(true);
  });

  it('rejects the default GitHub audience (repository owner URL)', async () => {
    const token = await github.sign(githubClaims({ aud: 'https://github.com/acme' }));
    expect(await verify(token)).toEqual({ ok: false, code: 'audience_mismatch' });
  });

  it('rejects a token without aud', async () => {
    const token = await github.sign(githubClaims({ aud: undefined }));
    expect(await verify(token)).toEqual({ ok: false, code: 'audience_mismatch' });
  });

  it('fails closed when the provider audience is empty, even for a token with aud ""', async () => {
    const token = await github.sign(githubClaims({ aud: '' }));
    for (const audience of ['', '   ']) {
      expect(await verify(token, { ...provider, audience })).toEqual({
        ok: false,
        code: 'audience_mismatch',
      });
    }
  });

  it('fails closed when the provider issuer is empty', async () => {
    const token = await github.sign(githubClaims({ iss: '' }));
    expect(await verify(token, { ...provider, issuer: '' })).toEqual({
      ok: false,
      code: 'claims_invalid',
    });
  });

  it('fails closed when the profile does not match the provider row', async () => {
    const token = await github.sign(githubClaims());
    const result = await verifyCallerToken(token, provider, PROFILES.generic, {
      fetch: github.fetch,
      now: clock.now,
    });
    expect(result).toEqual({ ok: false, code: 'claims_invalid' });
  });

  it('rejects a token without iat', async () => {
    const token = await github.sign(githubClaims(), { iat: null, exp: nowSeconds() + 300 });
    expect(await verify(token)).toEqual({ ok: false, code: 'claims_invalid' });
  });

  it('accepts iat in the future within the 30 s clock tolerance', async () => {
    const token = await github.sign(githubClaims(), { iat: nowSeconds() + 30 });
    expect((await verify(token)).ok).toBe(true);
  });

  it('rejects iat in the future beyond the clock tolerance', async () => {
    const token = await github.sign(githubClaims(), { iat: nowSeconds() + 31 });
    expect(await verify(token)).toEqual({ ok: false, code: 'claims_invalid' });
  });

  it('rejects iss with a trailing slash (exact match only)', async () => {
    const token = await github.sign(githubClaims({ iss: `${GITHUB_ISSUER}/` }));
    expect(await verify(token)).toEqual({ ok: false, code: 'claims_invalid' });
  });

  it('rejects iss of a GitHub enterprise-slug issuer against the shared-issuer provider', async () => {
    const token = await github.sign(githubClaims({ iss: `${GITHUB_ISSUER}/acme` }));
    expect(await verify(token)).toEqual({ ok: false, code: 'claims_invalid' });
  });

  it('rejects a token from issuer A verified against caller provider B', async () => {
    const gitlab = await createTestIssuer({ issuer: GITLAB_ISSUER, now: clock.now });
    const gitlabProvider = testCallerProvider(gitlab);
    // Both issuers publish kid "test-key-1"; only B's key is trusted for B.
    expect(github.kid).toBe(gitlab.kid);
    const fromGithub = await github.sign(githubClaims());
    expect(await verify(fromGithub, gitlabProvider, gitlab)).toEqual({
      ok: false,
      code: 'signature_invalid',
    });
    // A forging B's iss and claims is still not signed by B's key.
    const forgedIss = await github.sign(gitlabClaims({ iss: GITLAB_ISSUER }));
    expect(await verify(forgedIss, gitlabProvider, gitlab)).toEqual({
      ok: false,
      code: 'signature_invalid',
    });
    // B's row misconfigured with A's keys: the exact issuer check still rejects A's token.
    expect(await verify(fromGithub, { ...gitlabProvider, jwks_uri: github.jwksUri })).toEqual({
      ok: false,
      code: 'claims_invalid',
    });
  });

  it('rejects an expired token', async () => {
    const token = await github.sign(githubClaims(), {
      iat: nowSeconds() - 400,
      exp: nowSeconds() - 31,
    });
    expect(await verify(token)).toEqual({ ok: false, code: 'token_expired' });
  });

  it('rejects a token older than max_token_age_seconds even when exp is far away', async () => {
    const token = await github.sign(githubClaims(), {
      iat: nowSeconds() - 600 - 31,
      exp: nowSeconds() + 3600,
    });
    expect(await verify(token)).toEqual({ ok: false, code: 'token_too_old' });
  });

  it('accepts a token at max_token_age_seconds plus tolerance', async () => {
    const token = await github.sign(githubClaims(), {
      iat: nowSeconds() - 600 - 30,
      exp: nowSeconds() + 3600,
    });
    expect((await verify(token)).ok).toBe(true);
  });

  it('fails closed on a non-positive max_token_age_seconds', async () => {
    const token = await github.sign(githubClaims());
    for (const age of [0, -1, Number.NaN]) {
      expect(await verify(token, { ...provider, max_token_age_seconds: age })).toEqual({
        ok: false,
        code: 'token_too_old',
      });
    }
  });

  it.each(PROFILES['github-actions'].verifyRequiredClaims({ anchor_claims: [], tenant_pin: [] }))(
    'rejects a GitHub token missing required claim %s',
    async (claim) => {
      const token = await github.sign(githubClaims({ [claim]: undefined }), omitting(claim));
      expect(await verify(token)).toEqual({ ok: false, code: 'claims_invalid' });
    },
  );

  it.each(PROFILES['gitlab-ci'].verifyRequiredClaims({ anchor_claims: [], tenant_pin: [] }))(
    'rejects a GitLab token missing required claim %s',
    async (claim) => {
      const gitlab = await createTestIssuer({ issuer: GITLAB_ISSUER, now: clock.now });
      const token = await gitlab.sign(gitlabClaims({ [claim]: undefined }), omitting(claim));
      expect(await verify(token, testCallerProvider(gitlab), gitlab)).toEqual({
        ok: false,
        code: 'claims_invalid',
      });
    },
  );

  it('rejects a generic-profile token missing an anchor claim', async () => {
    const issuer = await createTestIssuer({ issuer: 'https://ci.example.com', now: clock.now });
    const generic = testCallerProvider(issuer, { anchor_claims: ['sub', 'pipeline_id'] });
    const token = await issuer.sign({ sub: 'pipeline:1', aud: generic.audience });
    expect(await verify(token, generic, issuer)).toEqual({ ok: false, code: 'claims_invalid' });
  });

  it('ignores keys embedded in the header (jwk, jku, x5u) and never fetches them', async () => {
    const attacker = await createTestIssuer({ issuer: GITHUB_ISSUER, kid: 'evil', now: clock.now });
    const [embedded] = attacker.jwks.keys;
    const token = await attacker.sign(githubClaims(), {
      kid: github.kid,
      header: { jwk: embedded, jku: 'https://evil.example/jwks', x5u: 'https://evil.example/x5u' },
    });
    expect(await verify(token)).toEqual({ ok: false, code: 'signature_invalid' });
    expect(github.requests).toEqual([github.jwksUri]);
  });

  it('rejects unknown critical header parameters', async () => {
    const [, payload, signature] = (await github.sign(githubClaims())).split('.');
    const header = b64url({ alg: 'RS256', kid: github.kid, crit: ['exp-policy'], 'exp-policy': 1 });
    expect(await verify(`${header}.${payload}.${signature}`)).toEqual({
      ok: false,
      code: 'token_malformed',
    });
  });

  it('rejects a token that is not valid yet (nbf beyond tolerance)', async () => {
    const token = await github.sign(githubClaims({ nbf: nowSeconds() + 31 }));
    expect(await verify(token)).toEqual({ ok: false, code: 'claims_invalid' });
  });

  it.each([
    ['exp as a string', { exp: '9999999999' }, 'claims_invalid'],
    ['iat as a string', { iat: String(TEST_EPOCH_MS / 1000) }, 'claims_invalid'],
    ['iss as an array', { iss: [GITHUB_ISSUER] }, 'claims_invalid'],
    ['aud as an object', { aud: { value: TEST_AUDIENCE } }, 'audience_mismatch'],
  ])('rejects %s', async (_label, overrides, code) => {
    const token = await github.sign(githubClaims(overrides));
    expect(await verify(token)).toEqual({ ok: false, code });
  });

  it('rejects RSA keys under 2048 bits', async () => {
    // jose refuses to create or sign with such keys, so sign with WebCrypto directly.
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    const weak = (await crypto.subtle.generateKey(
      { ...algorithm, modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const jwk = { ...(await exportJWK(weak.publicKey)), kid: 'weak', alg: 'RS256' };
    const claims = {
      ...githubClaims(),
      iss: GITHUB_ISSUER,
      iat: nowSeconds(),
      exp: nowSeconds() + 300,
    };
    const signingInput = `${b64url({ alg: 'RS256', kid: 'weak' })}.${b64url(claims)}`;
    const signature = await crypto.subtle.sign(
      algorithm,
      weak.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const token = `${signingInput}.${base64url.encode(new Uint8Array(signature))}`;
    const result = await verifyCallerToken(token, provider, PROFILES['github-actions'], {
      fetch: async () => Response.json({ keys: [jwk] }),
      now: clock.now,
    });
    expect(result).toEqual({ ok: false, code: 'signature_invalid' });
  });

  it('rejects a kid published twice in the JWKS (ambiguous key)', async () => {
    const [key] = github.jwks.keys;
    const twice: typeof fetch = async () => Response.json({ keys: [key, key] });
    const result = await verifyCallerToken(
      await github.sign(githubClaims()),
      provider,
      PROFILES['github-actions'],
      { fetch: twice, now: clock.now },
    );
    expect(result).toEqual({ ok: false, code: 'signature_invalid' });
  });

  it.each([
    ['http', `http://token.actions.githubusercontent.com/.well-known/jwks`],
    ['query', `${GITHUB_ISSUER}/.well-known/jwks?x=1`],
    ['userinfo', 'https://user:pass@token.actions.githubusercontent.com/.well-known/jwks'],
  ])('refuses a jwks_uri with %s without fetching', async (_label, jwksUri) => {
    const token = await github.sign(githubClaims());
    expect(await verify(token, { ...provider, jwks_uri: jwksUri })).toEqual({
      ok: false,
      code: 'jwks_unavailable',
    });
    expect(github.requests).toEqual([]);
  });
});

describe('I-TOK-2: only compact JWS tokens reach verification', () => {
  it.each([
    ['JWE (5 parts)', 'eyJh.eyJi.eyJj.eyJk.eyJl'],
    ['JWS JSON serialization', '{"payload":"eyJi","signatures":[]}'],
    ['padded base64', 'eyJh.eyJi.c2ln=='],
    ['unsigned (empty signature)', 'eyJh.eyJi.'],
    ['leading Bearer scheme', 'Bearer eyJh.eyJi.c2ln'],
  ])('rejects %s before any JWKS fetch', async (_label, token) => {
    expect(isCompactJws(token)).toBe(false);
    expect(await verify(token)).toEqual({ ok: false, code: 'token_malformed' });
    expect(github.jwksFetchCount()).toBe(0);
  });
});

describe('I-JWT-2: JWKS refetch is gated per jwks_uri', () => {
  it('fetches the JWKS once and serves later verifications from cache', async () => {
    for (let i = 0; i < 3; i++)
      expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
    expect(github.jwksFetchCount()).toBe(1);
  });

  it('does not refetch for repeated unknown kids within the cooldown', async () => {
    expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
    for (let i = 0; i < 20; i++) {
      clock.advance(1_000);
      const token = await github.sign(githubClaims(), { kid: `unknown-${i}` });
      expect(await verify(token)).toEqual({ ok: false, code: 'signature_invalid' });
    }
    expect(github.jwksFetchCount()).toBe(1);
  });

  it('does not refetch for repeated unknown kids when the first fetch is for an unknown kid', async () => {
    for (let i = 0; i < 10; i++) {
      const token = await github.sign(githubClaims(), { kid: `unknown-${i}` });
      expect(await verify(token)).toEqual({ ok: false, code: 'signature_invalid' });
    }
    expect(github.jwksFetchCount()).toBe(1);
  });

  it.each([
    ['HTTP 500', 500],
    ['network error', 'network'],
  ] as const)(
    'a failing JWKS endpoint (%s) is retried at most once per gate window',
    async (_label, failure) => {
      github.failJwks(failure);
      for (let i = 0; i < 10; i++) {
        expect(await verify(await github.sign(githubClaims()))).toEqual({
          ok: false,
          code: 'jwks_unavailable',
        });
      }
      expect(github.jwksFetchCount()).toBe(1);

      clock.advance(JWKS_REFETCH_GATE_MS - 1);
      expect((await verify(await github.sign(githubClaims()))).ok).toBe(false);
      expect(github.jwksFetchCount()).toBe(1);

      github.failJwks(null);
      clock.advance(1);
      expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
      expect(github.jwksFetchCount()).toBe(2);
    },
  );

  it('gates unknown-kid refetches on the injected clock even when jose cooldown has elapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(clock.now());
      expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
      // System clock jumps past jose's 30 s cooldown; the gate clock has only moved 1 s.
      vi.setSystemTime(clock.now() + 60_000);
      clock.advance(1_000);
      for (let i = 0; i < 5; i++) {
        const token = await github.sign(githubClaims(), { kid: `unknown-${i}` });
        expect(await verify(token)).toEqual({ ok: false, code: 'signature_invalid' });
      }
      expect(github.jwksFetchCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps separate gates per jwks_uri', async () => {
    const gitlab = await createTestIssuer({ issuer: GITLAB_ISSUER, now: clock.now });
    github.failJwks(500);
    expect((await verify(await github.sign(githubClaims()))).ok).toBe(false);
    const gitlabToken = await gitlab.sign(gitlabClaims());
    expect((await verify(gitlabToken, testCallerProvider(gitlab), gitlab)).ok).toBe(true);
  });

  it('a concurrent flood of unknown kids on a warm isolate causes one fetch', async () => {
    useSystemClock();
    expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
    advance(JWKS_REFETCH_GATE_MS + 1_000);
    const tokens = await Promise.all(
      Array.from({ length: 20 }, (_, i) => github.sign(githubClaims(), { kid: `unknown-${i}` })),
    );
    const results = await Promise.all(tokens.map((token) => verify(token)));
    expect(results.every((r) => !r.ok && r.code === 'signature_invalid')).toBe(true);
    expect(github.jwksFetchCount()).toBe(2);
  });

  it('requests during a stale-key refresh verify against the held keys', async () => {
    useSystemClock();
    const paused = pausable(github.fetch);
    const deps = { fetch: paused.fetch, now: clock.now };
    const profile = PROFILES['github-actions'];
    const first = await github.sign(githubClaims());
    expect((await verifyCallerToken(first, provider, profile, deps)).ok).toBe(true);

    advance(600_000 + 1_000); // past jose's 10 min cache age: the next request refreshes
    paused.pause();
    const refreshing = verifyCallerToken(
      await github.sign(githubClaims()),
      provider,
      profile,
      deps,
    );
    await paused.untilCalls(2);
    const during = await verifyCallerToken(
      await github.sign(githubClaims()),
      provider,
      profile,
      deps,
    );
    paused.resume();

    expect(during.ok).toBe(true);
    expect((await refreshing).ok).toBe(true);
    expect(github.jwksFetchCount()).toBe(2);
  });

  it('concurrent requests on a cold isolate all verify (at most one fetch each)', async () => {
    const tokens = await Promise.all(Array.from({ length: 5 }, () => github.sign(githubClaims())));
    const results = await Promise.all(tokens.map((token) => verify(token)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(github.jwksFetchCount()).toBeGreaterThanOrEqual(1);
    expect(github.jwksFetchCount()).toBeLessThanOrEqual(5);
    // Once keys are held, later requests are served from cache.
    expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
    expect(github.jwksFetchCount()).toBeLessThanOrEqual(5);
  });

  it('a cold isolate stops fetching once a fetch has failed', async () => {
    github.failJwks('network');
    const tokens = await Promise.all(Array.from({ length: 5 }, () => github.sign(githubClaims())));
    for (const token of tokens) expect((await verify(token)).ok).toBe(false);
    expect(github.jwksFetchCount()).toBe(1);
  });

  it.each([
    ['fails at once', false],
    ['is held in flight', true],
  ] as const)(
    'a cold isolate whose fetch failed makes one fetch per retry window under concurrency (retry %s)',
    async (_label, hold) => {
      const paused = pausable(github.fetch);
      const deps = { fetch: paused.fetch, now: clock.now };
      const profile = PROFILES['github-actions'];
      github.failJwks('network');
      expect(
        (await verifyCallerToken(await github.sign(githubClaims()), provider, profile, deps)).ok,
      ).toBe(false);
      expect(github.jwksFetchCount()).toBe(1);

      clock.advance(JWKS_REFETCH_GATE_MS + 1);
      const tokens = await Promise.all(
        Array.from({ length: 20 }, () => github.sign(githubClaims())),
      );
      if (hold) paused.pause();
      const pending = tokens.map((token) => verifyCallerToken(token, provider, profile, deps));
      if (hold) {
        await paused.untilCalls(2);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(paused.calls()).toBe(2);
        paused.resume();
      }
      const results = await Promise.all(pending);
      expect(results.every((r) => !r.ok && r.code === 'jwks_unavailable')).toBe(true);
      expect(github.jwksFetchCount()).toBe(2);
    },
  );

  it('stale keys are not used after their refresh failed', async () => {
    useSystemClock();
    expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
    advance(600_000 + 1_000);
    github.failJwks(500);
    for (let i = 0; i < 3; i++) {
      expect(await verify(await github.sign(githubClaims()))).toEqual({
        ok: false,
        code: 'jwks_unavailable',
      });
    }
    expect(github.jwksFetchCount()).toBe(2);
    github.failJwks(null);
    advance(JWKS_REFETCH_GATE_MS);
    expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
    expect(github.jwksFetchCount()).toBe(3);
  });

  it('fresh keys keep verifying after an unknown-kid refetch failed', async () => {
    useSystemClock();
    expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
    advance(JWKS_REFETCH_GATE_MS + 1_000);
    github.failJwks(500);
    const unknown = await github.sign(githubClaims(), { kid: 'unknown' });
    expect(await verify(unknown)).toEqual({ ok: false, code: 'jwks_unavailable' });
    expect((await verify(await github.sign(githubClaims()))).ok).toBe(true);
    expect(await verify(unknown)).toEqual({ ok: false, code: 'signature_invalid' });
    expect(github.jwksFetchCount()).toBe(2);
  });
});

/** Fakes the system clock (used by jose for cache age and cooldown) in step with `clock`. */
function useSystemClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock.now());
}

function advance(ms: number): void {
  clock.advance(ms);
  vi.setSystemTime(clock.now());
}

/** Wraps a fetch so calls can be held until `resume()`, to observe concurrent requests. */
function pausable(inner: typeof fetch) {
  let calls = 0;
  let waiting: Array<() => void> | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    if (waiting !== null) {
      const queue = waiting;
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    return inner(input, init);
  };
  return {
    fetch: fetchImpl,
    calls: () => calls,
    pause() {
      waiting = [];
    },
    resume() {
      for (const release of waiting ?? []) release();
      waiting = null;
    },
    async untilCalls(count: number) {
      for (let i = 0; i < 1_000 && calls < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(calls).toBe(count);
    },
  };
}

describe('I-TEN-1: tenant pin is exact and fails closed', () => {
  const claims = githubClaims();

  it('holds when every pin condition matches the raw claim', () => {
    expect(tenantPinHolds(provider, claims)).toBe(true);
    const twoConditions = {
      ...provider,
      tenant_pin: [
        { claim: 'repository_owner_id', match: 'exact' as const, values: ['1', '4242'] },
        { claim: 'enterprise_id', match: 'exact' as const, values: ['77'] },
      ],
    };
    expect(tenantPinHolds(twoConditions, { ...claims, enterprise_id: '77' })).toBe(true);
    expect(tenantPinHolds(twoConditions, claims)).toBe(false);
  });

  it('fails for a different owner even when names look right', () => {
    expect(
      tenantPinHolds(provider, {
        ...claims,
        repository_owner_id: '9999',
        repository_owner: 'acme',
      }),
    ).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['array', ['4242']],
    ['object', { id: '4242' }],
    ['unsafe number', 2 ** 60],
  ])('fails when the pinned claim is %s', (_label, value) => {
    const tampered: Record<string, unknown> = { ...claims, repository_owner_id: value };
    if (value === undefined) delete tampered.repository_owner_id;
    expect(tenantPinHolds(provider, tampered)).toBe(false);
  });

  it('matches numeric claims by their decimal text', () => {
    expect(tenantPinHolds(provider, { ...claims, repository_owner_id: 4242 })).toBe(true);
  });

  it('fails closed on glob or negated pin conditions', () => {
    for (const condition of [
      { claim: 'repository_owner_id', match: 'glob' as const, values: ['*'] },
      { claim: 'repository_owner_id', match: 'exact' as const, values: ['1'], negate: true },
    ]) {
      expect(tenantPinHolds({ ...provider, tenant_pin: [condition] }, claims)).toBe(false);
    }
  });

  it('fails closed on a shared issuer with an empty pin, whatever the profile', () => {
    for (const issuer of [GITHUB_ISSUER, GITLAB_ISSUER]) {
      for (const profile of ['github-actions', 'gitlab-ci', 'generic'] as const) {
        const row = testCallerProvider({ issuer, jwksUri: `${issuer}/jwks` }, { profile });
        expect(tenantPinHolds({ ...row, tenant_pin: [] }, claims)).toBe(false);
      }
    }
  });

  it('holds with an empty pin on a non-shared issuer (single-tenant)', () => {
    expect(tenantPinHolds({ issuer: 'https://ci.example.com', tenant_pin: [] }, {})).toBe(true);
    expect(tenantPinHolds({ issuer: `${GITHUB_ISSUER}/acme`, tenant_pin: [] }, claims)).toBe(true);
  });

  it('fails closed on malformed pin conditions instead of throwing', () => {
    const malformed = [
      { claim: 'repository_owner_id', match: 'exact' },
      { claim: 'repository_owner_id', match: 'exact', values: '4242' },
      { claim: 'repository_owner_id', match: 'exact', values: [] },
      { claim: 'repository_owner_id', match: 'exact', values: [4242] },
      { match: 'exact', values: ['4242'] },
      { claim: 'repository_owner_id', match: 'EXACT', values: ['4242'] },
    ];
    for (const condition of malformed) {
      const tenant_pin = [condition] as unknown as Condition[];
      expect(tenantPinHolds({ ...provider, tenant_pin }, claims)).toBe(false);
    }
    const notAList = 'repository_owner_id=4242' as unknown as Condition[];
    expect(tenantPinHolds({ ...provider, tenant_pin: notAList }, claims)).toBe(false);
  });

  it('reads only own claims, never the prototype chain', () => {
    const pin = (claim: string): Condition[] => [
      { claim, match: 'exact', values: ['[object Object]'] },
    ];
    for (const claim of ['constructor', '__proto__', 'toString']) {
      expect(tenantPinHolds({ ...provider, tenant_pin: pin(claim) }, claims)).toBe(false);
    }
  });
});
// Profile data is what the policy engine trusts about each issuer; policy tests use their own
// fixtures, so the shipped profiles are pinned here.
describe('I-AUTHZ-2: profile anchor rules pin immutable numeric IDs', () => {
  const none = { anchor_claims: [], tenant_pin: [] };

  it('every GitHub/GitLab anchor rule contains the tenant ID and an immutable project/workflow claim', () => {
    expect(PROFILES['github-actions'].anchorRules(none)).toEqual([
      ['repository_owner_id', 'repository_id'],
      ['repository_owner_id', 'job_workflow_ref'],
    ]);
    expect(PROFILES['gitlab-ci'].anchorRules(none)).toEqual([
      ['namespace_id', 'project_id'],
      ['namespace_id', 'ci_config_ref_uri'],
    ]);
  });

  it('the tenant and primary anchor IDs are required claims, so tokens cannot omit them', () => {
    expect(PROFILES['github-actions'].verifyRequiredClaims(none)).toEqual(
      expect.arrayContaining(['repository_owner_id', 'repository_id']),
    );
    expect(PROFILES['gitlab-ci'].verifyRequiredClaims(none)).toEqual(
      expect.arrayContaining(['namespace_id', 'project_id']),
    );
  });

  it('tenant pins accept only numeric IDs, never renameable names', () => {
    expect(PROFILES['github-actions'].tenantClaims).not.toContain('repository_owner');
    expect(PROFILES['gitlab-ci'].tenantClaims).not.toContain('namespace_path');
  });

  it('profiles cannot be changed at runtime', () => {
    const github = PROFILES['github-actions'];
    expect(() => {
      (github as { sharedIssuers: readonly string[] }).sharedIssuers = [];
    }).toThrow(TypeError);
    expect(() => github.defaults.allowedAlgs.push('HS256')).toThrow(TypeError);
    expect(github.sharedIssuers).toEqual([GITHUB_ISSUER]);
  });
});

describe('I-AUTHZ-3: profiles trust only events started from the repository itself', () => {
  it.each([
    ['github-actions', ['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment']],
    [
      'gitlab-ci',
      ['merge_request_event', 'external_pull_request_event', 'chat', 'parent_pipeline', 'pipeline'],
    ],
  ] as const)('%s never trusts untrusted-code events by default', (id, events) => {
    for (const event of events) expect(PROFILES[id].trustedEvents).not.toContain(event);
  });

  it('generic has no event claim, so no event is implicitly trusted', () => {
    expect(PROFILES.generic.eventClaim).toBeUndefined();
    expect(PROFILES.generic.trustedEvents).toEqual([]);
  });
});

describe('I-LOG-1: profiles allowlist only non-secret, non-personal claims for the request log', () => {
  const none = { anchor_claims: [], tenant_pin: [] };

  it.each(['github-actions', 'gitlab-ci'] as const)('%s never logs aud or personal email', (id) => {
    const allowlist = PROFILES[id].logClaimAllowlist(none);
    for (const claim of ['aud', 'user_email', 'email']) expect(allowlist).not.toContain(claim);
  });

  it('generic logs only sub, anchor claims and tenant pin claims', () => {
    const allowlist = PROFILES.generic.logClaimAllowlist({
      anchor_claims: ['project_id'],
      tenant_pin: [{ claim: 'org_id', match: 'exact', values: ['1'] }],
    });
    expect(allowlist).toEqual(['sub', 'project_id', 'org_id']);
  });
});

function b64url(value: unknown): string {
  return base64url.encode(JSON.stringify(value));
}
