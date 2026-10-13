// Test workload-identity issuer: real key pairs, a fake JWKS/discovery endpoint served through an
// injectable `fetch`, and realistic GitHub/GitLab claim sets. No network, no global mocks.
//
//   const clock = createClock();
//   const issuer = await createTestIssuer({ now: clock.now });          // GitHub issuer by default
//   const provider = testCallerProvider(issuer);                         // matching caller provider row
//   const token = await issuer.sign(githubClaims({ ref: 'refs/heads/dev' }));
//   await verifyCallerToken(token, provider, PROFILES[provider.profile], { fetch: issuer.fetch, now: clock.now });
import {
  CompactSign,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWK,
  type KeyObject,
} from 'jose';
import type { CallerProvider } from '../../src/db/types';
import type { ProfileId } from '../../src/identity/types';
import type { Condition } from '../../src/policy/types';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITLAB_ISSUER = 'https://gitlab.com';
/** Audience shared by test tokens and `testCallerProvider` rows (≥ 16 chars like real ones). */
export const TEST_AUDIENCE = 'tokengate:01JTESTAUD1ENCE0000000000000';
/** Owner/namespace IDs used by the claim factories and the default tenant pins. */
export const TEST_GITHUB_OWNER_ID = '4242';
export const TEST_GITHUB_REPOSITORY_ID = '987654321';
export const TEST_GITLAB_NAMESPACE_ID = '72';
export const TEST_GITLAB_PROJECT_ID = '20';
/** 2026-10-13T12:00:00Z. Default start of `createClock`. */
export const TEST_EPOCH_MS = Date.UTC(2026, 9, 13, 12, 0, 0);

type SigningAlg = 'RS256' | 'ES256';
type PrivateKey = CryptoKey | KeyObject;

export interface TestIssuerOptions {
  /** `iss` of signed tokens; JWKS is served at `<issuer>/.well-known/jwks`. Default: GitHub's. */
  issuer?: string;
  alg?: SigningAlg;
  kid?: string;
  /** Clock (ms) for default `iat`/`exp`. Pass the same clock as the verifier's `deps.now`. */
  now?: () => number;
}

export interface SignOptions {
  /** Header `kid`; `null` omits it. Default: the current signing key's kid. */
  kid?: string | null;
  /** Seconds since epoch; `null` omits the claim. Default: `now()`, unless `claims.iat` is set. */
  iat?: number | null;
  /** Seconds since epoch; `null` omits the claim. Default: `iat + 300`, unless `claims.exp` is set. */
  exp?: number | null;
  /** Extra or overriding protected-header parameters (`alg` must stay the key's algorithm). */
  header?: Record<string, unknown>;
}

export interface TestIssuer {
  issuer: string;
  jwksUri: string;
  alg: SigningAlg;
  /** Kid of the key `sign` uses. Changes after `rotateKey`. */
  readonly kid: string;
  /** Public JWKS currently served. */
  readonly jwks: { keys: JWK[] };
  /** SPKI PEM of the current public key (for key-confusion tests). */
  readonly publicKeyPem: string;
  /** Signs `{ iss: issuer, ...claims }` plus default iat/exp. */
  sign(claims: Record<string, unknown>, options?: SignOptions): Promise<string>;
  /**
   * Serves the JWKS at any URL ending in `/jwks` or `/.well-known/jwks`, and the discovery
   * document at `<issuer>/.well-known/openid-configuration`. Everything else is 404.
   */
  fetch: typeof fetch;
  /** Every URL `fetch` was called with, in order. */
  requests: string[];
  /** Number of JWKS fetches (discovery excluded). */
  jwksFetchCount(): number;
  /** Makes JWKS fetches fail with an HTTP status or a network error; `null` restores them. */
  failJwks(failure: number | 'network' | null): void;
  /** Adds a new signing key; the JWKS then publishes old and new keys. */
  rotateKey(kid: string): Promise<void>;
}

interface KeyMaterial {
  kid: string;
  privateKey: PrivateKey;
  publicJwk: JWK;
  publicKeyPem: string;
}

async function newKey(alg: SigningAlg, kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, privateKey, publicJwk, publicKeyPem: await exportSPKI(publicKey) };
}

export async function createTestIssuer(options: TestIssuerOptions = {}): Promise<TestIssuer> {
  const issuer = options.issuer ?? GITHUB_ISSUER;
  const alg = options.alg ?? 'RS256';
  const now = options.now ?? (() => Date.now());
  const jwksUri = `${issuer.replace(/\/$/, '')}/.well-known/jwks`;
  const keys: KeyMaterial[] = [await newKey(alg, options.kid ?? 'test-key-1')];
  const current = () => keys[keys.length - 1] as KeyMaterial;
  const requests: string[] = [];
  let jwksFetches = 0;
  let failure: number | 'network' | null = null;

  const fetchImpl: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    const { pathname } = new URL(url);
    if (pathname.endsWith('/jwks')) {
      jwksFetches++;
      if (failure === 'network') throw new TypeError('network error');
      if (failure !== null) return new Response('unavailable', { status: failure });
      return Response.json({ keys: keys.map((key) => key.publicJwk) });
    }
    if (url === `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        jwks_uri: jwksUri,
        id_token_signing_alg_values_supported: [alg],
      });
    }
    return new Response('not found', { status: 404 });
  };

  return {
    issuer,
    jwksUri,
    alg,
    get kid() {
      return current().kid;
    },
    get jwks() {
      return { keys: keys.map((key) => key.publicJwk) };
    },
    get publicKeyPem() {
      return current().publicKeyPem;
    },
    async sign(claims, signOptions = {}) {
      const payload: Record<string, unknown> = { iss: issuer, ...claims };
      const iat =
        signOptions.iat === undefined ? (payload.iat ?? Math.floor(now() / 1000)) : signOptions.iat;
      setOrDelete(payload, 'iat', iat);
      const exp =
        signOptions.exp === undefined
          ? (payload.exp ?? (typeof iat === 'number' ? iat + 300 : Math.floor(now() / 1000) + 300))
          : signOptions.exp;
      setOrDelete(payload, 'exp', exp);

      const header: Record<string, unknown> = {
        alg,
        typ: 'JWT',
        kid: signOptions.kid === undefined ? current().kid : signOptions.kid,
        ...signOptions.header,
      };
      if (header.kid === null) delete header.kid;
      return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
        .setProtectedHeader(header as { alg: string })
        .sign(current().privateKey);
    },
    fetch: fetchImpl,
    requests,
    jwksFetchCount: () => jwksFetches,
    failJwks(next) {
      failure = next;
    },
    async rotateKey(kid) {
      keys.push(await newKey(alg, kid));
    },
  };
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null || value === undefined) delete target[key];
  else target[key] = value;
}

/** `alg: none` token with an empty signature segment, as an attacker would send it. */
export function unsecuredToken(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  return `${b64urlJson({ alg: 'none', typ: 'JWT', ...header })}.${b64urlJson(claims)}.`;
}

/** HS256 token signed with an arbitrary secret, e.g. the issuer's public key bytes (key confusion). */
export async function hmacToken(
  secret: Uint8Array,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT', ...header })
    .sign(secret);
}

function b64urlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Merges overrides into base claims. An override of `undefined` removes the claim, so tests can
 * express "token without repository_id" as `githubClaims({ repository_id: undefined })`.
 */
function withOverrides(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const claims = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete claims[key];
  return claims;
}

/**
 * Claims of a GitHub Actions push to `main` of acme/app, shaped like real tokens (IDs are strings;
 * ref_protected is "true"). `iss`, `iat`, `exp` are added by `TestIssuer.sign`.
 */
export function githubClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return withOverrides(
    {
      jti: crypto.randomUUID(),
      sub: 'repo:acme/app:ref:refs/heads/main',
      aud: TEST_AUDIENCE,
      ref: 'refs/heads/main',
      sha: '2f1c3b0a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a',
      repository: 'acme/app',
      repository_owner: 'acme',
      repository_owner_id: TEST_GITHUB_OWNER_ID,
      repository_id: TEST_GITHUB_REPOSITORY_ID,
      repository_visibility: 'private',
      run_id: '17000000001',
      run_number: '42',
      run_attempt: '1',
      runner_environment: 'github-hosted',
      actor: 'octocat',
      actor_id: '583231',
      workflow: 'deploy',
      head_ref: '',
      base_ref: '',
      event_name: 'push',
      ref_type: 'branch',
      ref_protected: 'true',
      workflow_ref: 'acme/app/.github/workflows/deploy.yml@refs/heads/main',
      workflow_sha: '2f1c3b0a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a',
      job_workflow_ref: 'acme/app/.github/workflows/deploy.yml@refs/heads/main',
      job_workflow_sha: '2f1c3b0a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a',
    },
    overrides,
  );
}

/** Claims of a GitLab CI push pipeline on my-group/my-project, shaped like real gitlab.com tokens. */
export function gitlabClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return withOverrides(
    {
      jti: crypto.randomUUID(),
      sub: 'project_path:my-group/my-project:ref_type:branch:ref:main',
      aud: TEST_AUDIENCE,
      namespace_id: TEST_GITLAB_NAMESPACE_ID,
      namespace_path: 'my-group',
      project_id: TEST_GITLAB_PROJECT_ID,
      project_path: 'my-group/my-project',
      user_id: '1',
      user_login: 'sample-user',
      user_email: 'sample-user@example.com',
      user_access_level: 'developer',
      pipeline_id: '574',
      pipeline_source: 'push',
      job_id: '302',
      ref: 'main',
      ref_type: 'branch',
      ref_path: 'refs/heads/main',
      ref_protected: 'true',
      runner_id: 1,
      runner_environment: 'gitlab-hosted',
      sha: '714a629c0b401fdce83e847fc9589983fc6f46bc',
      project_visibility: 'private',
      ci_config_ref_uri: 'gitlab.com/my-group/my-project//.gitlab-ci.yml@refs/heads/main',
      ci_config_sha: '714a629c0b401fdce83e847fc9589983fc6f46bc',
    },
    overrides,
  );
}

function defaultProfile(issuer: string): ProfileId {
  if (issuer === GITHUB_ISSUER) return 'github-actions';
  if (issuer === GITLAB_ISSUER) return 'gitlab-ci';
  return 'generic';
}

const DEFAULT_PINS: Record<ProfileId, Condition[]> = {
  'github-actions': [
    { claim: 'repository_owner_id', match: 'exact', values: [TEST_GITHUB_OWNER_ID] },
  ],
  'gitlab-ci': [{ claim: 'namespace_id', match: 'exact', values: [TEST_GITLAB_NAMESPACE_ID] }],
  generic: [],
};

/**
 * A decoded caller provider row matching `issuer`: profile inferred from the issuer URL, audience
 * TEST_AUDIENCE, RS256/ES256 per the issuer, 600 s max age, and a tenant pin on the factories' owner.
 */
export function testCallerProvider(
  issuer: Pick<TestIssuer, 'issuer' | 'jwksUri'> & { alg?: string },
  overrides: Partial<CallerProvider> = {},
): CallerProvider {
  const profile = overrides.profile ?? defaultProfile(issuer.issuer);
  return {
    id: 'cpr_01JTESTPROVIDER0000000000',
    name: `test ${profile}`,
    profile,
    issuer: issuer.issuer,
    jwks_uri: issuer.jwksUri,
    audience: TEST_AUDIENCE,
    allowed_algs: [issuer.alg ?? 'RS256'],
    max_token_age_seconds: 600,
    tenant_pin: structuredClone(DEFAULT_PINS[profile]),
    anchor_claims: profile === 'generic' ? ['sub'] : [],
    enabled: true,
    created_at: TEST_EPOCH_MS,
    updated_at: TEST_EPOCH_MS,
    ...overrides,
  };
}

/** Manually advanced clock for `deps.now` and `TestIssuer` defaults. */
export function createClock(startMs: number = TEST_EPOCH_MS): {
  now: () => number;
  advance(ms: number): void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}
