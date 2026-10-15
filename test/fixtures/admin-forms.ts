// Admin route fixtures shared by the cross-cutting security tests: a seeded "world" (caller
// provider, service with a sealed credential and a verify check, grant, request record) on the real
// app, one successful form submission per mutating route of the RBAC table (I-AUDIT-1, I-RBAC-1),
// and concrete paths for every read route.
//
//   await resetAdminWorld();
//   const world = await seedAdminWorld(createAdminWorldApp());
//   const request = await MUTATION_FIXTURES['POST /admin/access']?.(world);
//   await adminPost(world.app, ownerSession, request.path, request.fields);
import { env } from 'cloudflare:workers';
import { createCallerProvider } from '../../src/admin/ops/caller-providers';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import type { CallerProvider } from '../../src/db/types';
import { newId } from '../../src/lib/ids';
import type { RequestRecord } from '../../src/telemetry/types';
import { createUser, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  ACTOR,
  fakeNetwork,
  KEK_1,
  KEYRING_1_2,
  OWNER_ID,
  REPOSITORY_ID,
  seedGithubProvider,
  seedGrant,
  seedService,
} from '../unit/admin/ops/helpers';

export const WORLD_SECRET = 'ghp_worldFixtureSecret0123456789abcdef';
export const WORLD_VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };

export interface AdminWorld {
  app: TestApp;
  provider: CallerProvider;
  /** Service with a sealed credential and a verify check that passes against the fake network. */
  serviceId: string;
  grantId: string;
  requestId: string;
}

export interface MutationRequest {
  path: string;
  fields: Record<string, string | string[]>;
  /**
   * The audit action the mutation must write, or the ordered actions when one submit makes several
   * mutations (each its own batch with its own row).
   */
  action: string | readonly string[];
  /** Statuses that mean "succeeded" (default: a 303 POST-redirect-GET). */
  successStatus?: number[];
  /** App serving the request when the mutation needs another environment (same databases). */
  app?: TestApp;
}

export type MutationFixture = (world: AdminWorld) => Promise<MutationRequest>;

/** The audit actions a mutation request must write, in order. */
export function expectedActions(request: MutationRequest): readonly string[] {
  return typeof request.action === 'string' ? [request.action] : request.action;
}

/** Empties both databases' admin-visible tables. */
export async function resetAdminWorld(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants'),
    env.DB.prepare('DELETE FROM claim_labels'),
    env.DB.prepare('DELETE FROM services'),
    env.DB.prepare('DELETE FROM caller_providers'),
  ]);
  await resetControlPlane();
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
}

/** The real app over a fake network: OIDC discovery for GitHub, every upstream answers 200. */
export function createAdminWorldApp(fetchImpl: typeof fetch = fakeNetwork().fetch): TestApp {
  return createTestApp({ fetch: fetchImpl, env: { TOKENGATE_KEK: KEK_1 } });
}

export async function seedAdminWorld(app: TestApp): Promise<AdminWorld> {
  const provider = await seedGithubProvider(app.deps);
  const serviceId = await seedService(app.deps, { secret: WORLD_SECRET, verify: WORLD_VERIFY });
  const grant = await seedGrant(app.deps, provider.id, serviceId);
  const requestId = newId('req', Date.now(), app.deps.random);
  await env.TELEMETRY_DB.batch(
    insertRequestRecordsStatements(env.TELEMETRY_DB, [
      worldRequestRecord({ id: requestId, service_id: serviceId, provider_id: provider.id }),
    ]),
  );
  return { app, provider, serviceId, grantId: grant.id, requestId };
}

function worldRequestRecord(ids: {
  id: string;
  service_id: string;
  provider_id: string;
}): RequestRecord {
  return {
    id: ids.id,
    ts: Date.now(),
    outcome: 'denied',
    reason: 'no_matching_grant',
    status: 403,
    upstream_status: null,
    method: 'GET',
    path: '/repos/acme/app',
    service_slug: 'github',
    service_id: ids.service_id,
    caller_provider_id: ids.provider_id,
    grant_id: null,
    claims_verified: 1,
    caller_subject: 'repo:acme/app:ref:refs/heads/main',
    caller_repository: 'acme/app',
    caller_claims: JSON.stringify({
      sub: 'repo:acme/app:ref:refs/heads/main',
      repository: 'acme/app',
      repository_id: REPOSITORY_ID,
      repository_owner_id: OWNER_ID,
      ref: 'refs/heads/main',
      event_name: 'push',
    }),
    jti: null,
    untrusted_iss: null,
    eval_trace: null,
    duration_ms: 5,
    upstream_ms: null,
    weight: 1,
    ip: null,
    user_agent: null,
    colo: null,
  };
}

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * One successful submission per mutating route of ROUTE_PERMISSIONS, keyed exactly like the table.
 * A mutating route without an entry here fails test/security/audit-coverage-routes.test.ts.
 * Fixtures assume an owner session (owners hold every permission).
 */
export const MUTATION_FIXTURES: Readonly<Record<string, MutationFixture>> = {
  // == monitoring ==
  'POST /admin/retention': async () => ({
    path: '/admin/retention',
    action: 'settings.update',
    fields: { request_log_retention_days: '30' },
  }),

  // == users ==
  'POST /admin/users/sign-in/hosts': async () => ({
    path: '/admin/users/sign-in/hosts',
    action: 'settings.admin_hosts',
    fields: { add: `${unique('host')}.example.com` },
  }),
  'POST /admin/users': async () => ({
    path: '/admin/users',
    action: 'user.invite',
    fields: { email: `${unique('invitee')}@example.com`, role: 'viewer' },
  }),
  'POST /admin/users/:id': async () => {
    const target = await createUser({ email: `${unique('target')}@example.com`, role: 'admin' });
    return { path: `/admin/users/${target.id}`, action: 'user.update', fields: { role: 'viewer' } };
  },
  'POST /admin/users/defaults': async () => ({
    path: '/admin/users/defaults',
    action: 'user.join_defaults',
    fields: { role: 'admin', status: 'pending' },
  }),
  'POST /admin/users/:id/approve': async () => {
    const target = await createUser({
      email: `${unique('pending')}@example.com`,
      role: 'viewer',
      status: 'pending',
      identity: { loginProvider: 'access', subject: unique('subject') },
    });
    return { path: `/admin/users/${target.id}/approve`, action: 'user.update', fields: {} };
  },
  'POST /admin/users/:id/reject': async () => {
    const target = await createUser({
      email: `${unique('pending')}@example.com`,
      role: 'viewer',
      status: 'pending',
      identity: { loginProvider: 'access', subject: unique('subject') },
    });
    return { path: `/admin/users/${target.id}/reject`, action: 'user.update', fields: {} };
  },
  'POST /admin/users/:id/reset-login': async () => {
    const target = await createUser({
      email: `${unique('reset')}@example.com`,
      role: 'admin',
      identity: { loginProvider: 'access', subject: unique('subject') },
    });
    return {
      path: `/admin/users/${target.id}/reset-login`,
      action: 'user.reset_login',
      fields: {},
    };
  },
  'POST /admin/users/:id/resend-invite': async () => {
    const target = await createUser({
      email: `${unique('invited')}@example.com`,
      role: 'viewer',
      status: 'invited',
    });
    return {
      path: `/admin/users/${target.id}/resend-invite`,
      action: 'user.resend_invite',
      fields: {},
    };
  },

  // == tokens ==
  'POST /admin/tokens/hosts': async () => ({
    path: '/admin/tokens/hosts',
    action: 'settings.upstream_hosts',
    fields: { mode: 'list', host: [`${unique('host')}.example.com`] },
  }),
  // A rewrap with nothing to re-encrypt changes nothing and is not audited, so this request is
  // served with a rotated keyring: the world credential, sealed under k1, moves to k2.
  'POST /admin/tokens/keys/rewrap': async () => ({
    path: '/admin/tokens/keys/rewrap',
    action: 'keyring.rewrap',
    fields: {},
    app: createTestApp({
      fetch: fakeNetwork().fetch,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 },
    }),
  }),
  // A template card: the destination, headers and check come from the template; slug and name
  // are derived (openai, openai-2, …).
  'POST /admin/tokens': async () => ({
    path: '/admin/tokens',
    action: 'service.create',
    fields: { template: 'openai', credential: 'sk-proj-fixtureCreate0123456789abcdef' },
  }),
  'POST /admin/tokens/:id': async (w) => ({
    path: `/admin/tokens/${w.serviceId}`,
    action: 'service.update',
    fields: {
      name: 'Renamed service',
      description: 'changed',
      forward_headers: 'x-github-api-version',
      timeout_ms: '60000',
      verify_method: WORLD_VERIFY.method,
      verify_path: WORLD_VERIFY.path,
      verify_expect_status: String(WORLD_VERIFY.expect_status),
    },
  }),
  // Rotate: only the secret; the destination is the stored one.
  'POST /admin/tokens/:id/secret': async (w) => ({
    path: `/admin/tokens/${w.serviceId}/secret`,
    action: 'service.credential.set',
    fields: { credential: 'ghp_fixtureRotated0123456789abcdef' },
  }),
  'POST /admin/tokens/:id/destination': async (w) => ({
    path: `/admin/tokens/${w.serviceId}/destination`,
    action: 'service.credential.set',
    fields: {
      base_url: 'https://api.github.com',
      injection_kind: 'bearer',
      credential: 'ghp_fixtureRepointed0123456789abcdef',
      confirm_destination: 'api.github.com',
    },
  }),
  'POST /admin/tokens/:id/test': async (w) => ({
    path: `/admin/tokens/${w.serviceId}/test`,
    action: 'service.credential.test',
    fields: {},
    // The result is rendered once, not redirected to.
    successStatus: [200],
  }),
  'POST /admin/tokens/:id/toggle': async (w) => ({
    path: `/admin/tokens/${w.serviceId}/toggle`,
    action: 'service.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/tokens/:id/delete': async (w) => {
    const id = await seedService(w.app.deps, { slug: unique('doomed') });
    return {
      path: `/admin/tokens/${id}/delete`,
      action: 'service.delete',
      fields: { confirm: '1' },
    };
  },

  // == consumers ==
  'POST /admin/consumers': async () => ({
    path: '/admin/consumers',
    action: 'caller_provider.create',
    fields: {
      profile: 'generic',
      name: unique('Acme IdP'),
      issuer: `https://${unique('idp')}.acme.example`,
      jwks_uri: 'https://idp.acme.example/keys',
      audience: 'tokengate:abcdefghijklmnopqrstuvwxyz',
      allowed_algs: 'RS256',
      max_token_age_seconds: '300',
      pin_mode: 'text',
      tenant_pin_text: 'org_id exact 77',
      anchor_claims: 'sub',
    },
  }),
  'POST /admin/consumers/:id': async (w) => ({
    path: `/admin/consumers/${w.provider.id}`,
    action: 'caller_provider.update',
    fields: {
      profile: w.provider.profile,
      name: 'GitHub Actions (renamed)',
      issuer: w.provider.issuer,
      audience: w.provider.audience,
      allowed_algs: w.provider.allowed_algs,
      max_token_age_seconds: '300',
      pin_mode: 'fields',
      owner_ids: OWNER_ID,
      enterprise_id: '',
    },
  }),
  'POST /admin/consumers/:id/toggle': async (w) => ({
    path: `/admin/consumers/${w.provider.id}/toggle`,
    action: 'caller_provider.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/consumers/:id/delete': async (w) => {
    const created = await createCallerProvider(w.app.deps, ACTOR, {
      name: unique('doomed'),
      profile: 'generic',
      issuer: `https://${unique('doomed')}.example.org`,
      jwks_uri: 'https://doomed.example.org/jwks',
      anchor_claims: ['sub'],
    });
    if (!created.ok) throw new Error(`fixture: ${created.errors.join('; ')}`);
    return {
      path: `/admin/consumers/${created.callerProvider.id}/delete`,
      action: 'caller_provider.delete',
      fields: { confirm: '1' },
    };
  },
  'POST /admin/access': async (w) => ({
    path: '/admin/access',
    action: 'grant.create',
    fields: {
      caller_provider_id: w.provider.id,
      service_id: w.serviceId,
      mode: 'preset',
      name: unique('main deploys'),
      owner_id: OWNER_ID,
      repository_ids: REPOSITORY_ID,
      context: 'branch',
      pattern: 'main',
      require_protected_ref: '1',
      rules_text: 'GET /repos/**',
      enabled: '1',
    },
  }),
  'POST /admin/access/:id': async (w) => ({
    path: `/admin/access/${w.grantId}`,
    action: 'grant.update',
    fields: {
      name: 'renamed grant',
      conditions_text: `repository_owner_id exact ${OWNER_ID}\nrepository_id exact ${REPOSITORY_ID}`,
      rules_text: 'GET,HEAD /repos/acme/**',
    },
  }),
  'POST /admin/access/:id/toggle': async (w) => ({
    path: `/admin/access/${w.grantId}/toggle`,
    action: 'grant.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/access/:id/delete': async (w) => ({
    path: `/admin/access/${w.grantId}/delete`,
    action: 'grant.delete',
    fields: { confirm: '1' },
  }),

  // == global ==
  'POST /admin/export': async () => ({
    path: '/admin/export',
    action: 'config.export',
    fields: {},
    // The export is the response body (a download), not a redirect.
    successStatus: [200],
  }),
};

// == tokens ==
/**
 * Token submissions that use a field permission, for the token tests (each is a second form of a
 * route above): an owner allowing a blocked template host on the way, and an admin deleting a
 * token together with its consumer access.
 */
export const TOKEN_FIXTURE_VARIANTS = {
  /** settings.upstream_hosts, then service.create (two batches, the allowlist first). */
  createWithAllowHost: async (): Promise<MutationRequest> => {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES ('allowed_upstream_hosts', '["api.github.com"]', 0, NULL)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run();
    return {
      path: '/admin/tokens',
      action: ['settings.upstream_hosts', 'service.create'],
      fields: {
        template: 'openai',
        credential: 'sk-proj-fixtureAllowHost0123456789abcdef',
        allow_host: 'api.openai.com',
      },
    };
  },
  /** One service.delete row whose diff holds every deleted access. */
  deleteWithAccesses: async (w: AdminWorld): Promise<MutationRequest> => {
    const { results } = await env.DB.prepare(
      'SELECT id FROM grants WHERE service_id = ? ORDER BY id',
    )
      .bind(w.serviceId)
      .all<{ id: string }>();
    return {
      path: `/admin/tokens/${w.serviceId}/delete`,
      action: 'service.delete',
      fields: {
        confirm: '1',
        with_accesses: '1',
        access_ids: results.map((row) => row.id).join(','),
      },
    };
  },
} as const;

/**
 * Seeded ids for the `:id` GET routes of the RBAC table, one block per admin section (add or
 * remove entries only inside your own block).
 */
const READ_IDS: Readonly<Record<string, Readonly<Record<string, (world: AdminWorld) => string>>>> =
  {
    monitoring: { '/admin/requests/:id': (w) => w.requestId },
    users: {},
    tokens: { '/admin/tokens/:id': (w) => w.serviceId },
    consumers: {
      '/admin/consumers/:id': (w) => w.provider.id,
      '/admin/access/:id': (w) => w.grantId,
    },
    global: {},
  };

/** Concrete URL for a GET route of the RBAC table, with `:id` bound to a seeded row. */
export function readPath(routeKey: string, world: AdminWorld): string {
  const [method, pattern = ''] = routeKey.split(' ');
  if (method !== 'GET') throw new Error(`readPath: not a GET route: ${routeKey}`);
  const id = Object.values(READ_IDS)
    .find((section) => Object.hasOwn(section, pattern))
    ?.[pattern]?.(world);
  if (id !== undefined) return pattern.replace(':id', id);
  if (pattern.includes(':')) throw new Error(`readPath: no id for ${routeKey}`);
  return pattern;
}
