// Admin route fixtures shared by the cross-cutting security tests: a seeded "world" (caller
// provider, service with a sealed credential and a verify check, grant, request record) on the real
// app, one successful form submission per mutating route of the RBAC table (I-AUDIT-1, I-RBAC-1),
// and concrete paths for every read route.
//
//   await resetAdminWorld();
//   const world = await seedAdminWorld(createAdminWorldApp());
//   const request = await MUTATION_FIXTURES['POST /admin/grants']?.(world);
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
  /** The audit action the mutation must write. */
  action: string;
  /** Statuses that mean "succeeded" (default: a 303 POST-redirect-GET). */
  successStatus?: number[];
  /** App serving the request when the mutation needs another environment (same databases). */
  app?: TestApp;
}

export type MutationFixture = (world: AdminWorld) => Promise<MutationRequest>;

/** Empties both databases' admin-visible tables. */
export async function resetAdminWorld(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants'),
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
  'POST /admin/services': async () => ({
    path: '/admin/services',
    action: 'service.create',
    fields: {
      slug: unique('svc'),
      name: 'Fixture service',
      description: '',
      base_url: 'https://api.openai.com/v1',
      injection_kind: 'bearer',
      forward_headers: '',
      timeout_ms: '60000',
      verify_method: '',
      credential: 'sk-fixture-create-0123456789abcdef',
    },
  }),
  'POST /admin/services/:id': async (w) => ({
    path: `/admin/services/${w.serviceId}`,
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
  'POST /admin/services/:id/credential': async (w) => ({
    path: `/admin/services/${w.serviceId}/credential`,
    action: 'service.credential.set',
    fields: {
      base_url: 'https://api.github.com',
      injection_kind: 'bearer',
      credential: 'ghp_fixtureRotated0123456789abcdef',
    },
  }),
  'POST /admin/services/:id/test': async (w) => ({
    path: `/admin/services/${w.serviceId}/test`,
    action: 'service.credential.test',
    fields: {},
    // The result is rendered once, not redirected to.
    successStatus: [200],
  }),
  'POST /admin/services/:id/toggle': async (w) => ({
    path: `/admin/services/${w.serviceId}/toggle`,
    action: 'service.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/services/:id/delete': async (w) => {
    const id = await seedService(w.app.deps, { slug: unique('doomed') });
    return {
      path: `/admin/services/${id}/delete`,
      action: 'service.delete',
      fields: { confirm: '1' },
    };
  },

  'POST /admin/caller-providers': async () => ({
    path: '/admin/caller-providers',
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
  'POST /admin/caller-providers/:id': async (w) => ({
    path: `/admin/caller-providers/${w.provider.id}`,
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
  'POST /admin/caller-providers/:id/toggle': async (w) => ({
    path: `/admin/caller-providers/${w.provider.id}/toggle`,
    action: 'caller_provider.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/caller-providers/:id/delete': async (w) => {
    const created = await createCallerProvider(w.app.deps, ACTOR, {
      name: unique('doomed'),
      profile: 'generic',
      issuer: `https://${unique('doomed')}.example.org`,
      jwks_uri: 'https://doomed.example.org/jwks',
      anchor_claims: ['sub'],
    });
    if (!created.ok) throw new Error(`fixture: ${created.errors.join('; ')}`);
    return {
      path: `/admin/caller-providers/${created.callerProvider.id}/delete`,
      action: 'caller_provider.delete',
      fields: { confirm: '1' },
    };
  },

  'POST /admin/grants': async (w) => ({
    path: '/admin/grants',
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
  'POST /admin/grants/:id': async (w) => ({
    path: `/admin/grants/${w.grantId}`,
    action: 'grant.update',
    fields: {
      name: 'renamed grant',
      conditions_text: `repository_owner_id exact ${OWNER_ID}\nrepository_id exact ${REPOSITORY_ID}`,
      rules_text: 'GET,HEAD /repos/acme/**',
    },
  }),
  'POST /admin/grants/:id/toggle': async (w) => ({
    path: `/admin/grants/${w.grantId}/toggle`,
    action: 'grant.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/grants/:id/delete': async (w) => ({
    path: `/admin/grants/${w.grantId}/delete`,
    action: 'grant.delete',
    fields: { confirm: '1' },
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

  'POST /admin/export': async () => ({
    path: '/admin/export',
    action: 'config.export',
    fields: {},
    // The export is the response body (a download), not a redirect.
    successStatus: [200],
  }),
  'POST /admin/settings': async () => ({
    path: '/admin/settings',
    action: 'settings.update',
    fields: { request_log_retention_days: '30' },
  }),
  // A rewrap with nothing to re-encrypt changes nothing and is not audited, so this request is
  // served with a rotated keyring: the world credential, sealed under k1, moves to k2.
  'POST /admin/settings/rewrap': async () => ({
    path: '/admin/settings/rewrap',
    action: 'keyring.rewrap',
    fields: {},
    app: createTestApp({
      fetch: fakeNetwork().fetch,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 },
    }),
  }),
};

/** Concrete URL for a GET route of the RBAC table, with `:id` bound to a seeded row. */
export function readPath(routeKey: string, world: AdminWorld): string {
  const [method, pattern = ''] = routeKey.split(' ');
  if (method !== 'GET') throw new Error(`readPath: not a GET route: ${routeKey}`);
  const ids: Record<string, string> = {
    '/admin/services/:id': world.serviceId,
    '/admin/caller-providers/:id': world.provider.id,
    '/admin/grants/:id': world.grantId,
    '/admin/requests/:id': world.requestId,
  };
  const id = ids[pattern];
  if (id !== undefined) return pattern.replace(':id', id);
  if (pattern.includes(':')) throw new Error(`readPath: no id for ${routeKey}`);
  return pattern;
}
