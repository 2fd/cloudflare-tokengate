// Admin route fixtures shared by the cross-cutting security tests: a seeded "world" (a service with a
// sealed credential and a verify check, a credential access rule, a global access rule of another
// issuer, a request record) on the real app, one successful form submission per mutating route of
// the RBAC table (I-AUDIT-1, I-RBAC-1), and concrete paths for every read route.
//
//   await resetAdminWorld();
//   const world = await seedAdminWorld(createAdminWorldApp());
//   const request = await MUTATION_FIXTURES['POST /admin/credential-access-rules']?.(world);
//   await adminPost(world.app, ownerSession, request.path, request.fields);
import { env } from 'cloudflare:workers';
import { createGlobalAccessRule } from '../../src/admin/ops/global-access-rules';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import type { CredentialAccessRule, GlobalAccessRule } from '../../src/db/types';
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
  seedCredentialRule,
  seedGlobalRule,
  seedService,
} from '../unit/admin/ops/helpers';

export const WORLD_SECRET = 'ghp_worldFixtureSecret0123456789abcdef';
export const WORLD_VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };

export interface AdminWorld {
  app: TestApp;
  /** A GitHub Actions credential access rule of the world service. */
  rule: CredentialAccessRule;
  /** A global access rule of GitLab.com, with no limits: it caps no rule of the world. */
  global: GlobalAccessRule;
  /** Service with a sealed credential and a verify check that passes against the fake network. */
  serviceId: string;
  requestId: string;
  /** A person (an invitation) for the Users read routes. */
  userId: string;
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
    env.DB.prepare('DELETE FROM claim_labels'),
    env.DB.prepare('DELETE FROM access_rules'),
    env.DB.prepare('DELETE FROM credentials'),
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
  const serviceId = await seedService(app.deps, { secret: WORLD_SECRET, verify: WORLD_VERIFY });
  const rule = await seedCredentialRule(app.deps, { credential_id: serviceId });
  const global = await seedGlobalRule(app.deps, {
    name: 'GitLab ceiling',
    profile: 'gitlab-ci',
    issuer: 'https://gitlab.com',
  });
  const requestId = newId('req', Date.now(), app.deps.random);
  await env.TELEMETRY_DB.batch(
    insertRequestRecordsStatements(env.TELEMETRY_DB, [
      worldRequestRecord({ id: requestId, service_id: serviceId, provider_id: rule.id }),
    ]),
  );
  const person = await seedWorldPerson();
  return { app, rule, global, serviceId, requestId, userId: person.id };
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
    reason: 'no_matching_rule',
    status: 403,
    upstream_status: null,
    method: 'GET',
    path: '/repos/acme/app',
    service_slug: 'github',
    service_id: ids.service_id,
    credential_access_rule_id: ids.provider_id,
    global_access_rule_id: null,
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

// == users == seeds

/** A person waiting for approval (a pending row with a linked identity). */
function seedPendingUser() {
  return createUser({
    email: `${unique('pending')}@example.com`,
    role: 'viewer',
    status: 'pending',
    identity: { loginProvider: 'access', subject: unique('subject') },
  });
}

/** The person every read of `/admin/users/:id` shows: an invitation, so no session is affected. */
export function seedWorldPerson(): Promise<{ id: string }> {
  return createUser({
    email: `${unique('person')}@example.com`,
    role: 'viewer',
    status: 'invited',
  });
}

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
  'POST /admin/users/appearance': async () => ({
    path: '/admin/users/appearance',
    action: 'settings.update',
    fields: { title: 'Acme Gateway' },
  }),
  'POST /admin/users/sign-in/policy': async () => ({
    path: '/admin/users/sign-in/policy',
    action: 'user.join_defaults',
    fields: { join_policy: 'pending' },
  }),
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
  'POST /admin/users/:id/approve': async () => {
    const target = await seedPendingUser();
    return {
      path: `/admin/users/${target.id}/approve`,
      action: 'user.approve',
      fields: { role: 'access_manager' },
    };
  },
  'POST /admin/users/:id/reject': async () => {
    const target = await seedPendingUser();
    return { path: `/admin/users/${target.id}/reject`, action: 'user.reject', fields: {} };
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
      fields: { confirm: '1' },
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
  'POST /admin/users/:id/delete': async () => {
    const target = await createUser({
      email: `${unique('cancelled')}@example.com`,
      role: 'viewer',
      status: 'invited',
    });
    return {
      path: `/admin/users/${target.id}/delete`,
      action: 'user.delete',
      fields: { confirm: '1' },
    };
  },
  'POST /admin/users/:id/dismiss-attempt': async () => {
    const target = await createUser({
      email: `${unique('refused')}@example.com`,
      role: 'viewer',
      status: 'invited',
      inviteExpiresAt: 1,
    });
    const at = Date.now();
    await env.DB.prepare(
      'UPDATE users SET last_refused_at = ?, last_refused_subject = ? WHERE id = ?',
    )
      .bind(at, unique('subject'), target.id)
      .run();
    return {
      path: `/admin/users/${target.id}/dismiss-attempt`,
      action: 'user.dismiss_attempt',
      fields: { expected_refused_at: String(at) },
    };
  },

  // == tokens ==
  'POST /admin/credentials/hosts': async () => ({
    path: '/admin/credentials/hosts',
    action: 'settings.upstream_hosts',
    fields: { mode: 'list', host: [`${unique('host')}.example.com`] },
  }),
  // A rewrap with nothing to re-encrypt changes nothing and is not audited, so this request is
  // served with a rotated keyring: the world credential, sealed under k1, moves to k2.
  'POST /admin/credentials/keys/rewrap': async () => ({
    path: '/admin/credentials/keys/rewrap',
    action: 'keyring.rewrap',
    fields: {},
    app: createTestApp({
      fetch: fakeNetwork().fetch,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 },
    }),
  }),
  // A template card: the destination, headers and check come from the template; slug and name
  // are derived (openai, openai-2, …).
  'POST /admin/credentials': async () => ({
    path: '/admin/credentials',
    action: 'service.create',
    fields: { template: 'openai', credential: 'sk-proj-fixtureCreate0123456789abcdef' },
  }),
  'POST /admin/credentials/:id': async (w) => ({
    path: `/admin/credentials/${w.serviceId}`,
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
  // Rotate: only the secret; the destination is the stored one, named by the digest the form
  // carries (imported here so the shared import list stays untouched).
  'POST /admin/credentials/:id/secret': async (w) => {
    const { destinationFingerprint } = await import('../../src/admin/ops/credentials');
    const row = await env.DB.prepare('SELECT base_url, injection FROM credentials WHERE id = ?')
      .bind(w.serviceId)
      .first<{ base_url: string; injection: string }>();
    if (!row) throw new Error('world service missing');
    return {
      path: `/admin/credentials/${w.serviceId}/secret`,
      action: 'service.credential.set',
      fields: {
        expected_destination: await destinationFingerprint({
          base_url: row.base_url,
          injection_json: row.injection,
        }),
        credential: 'ghp_fixtureRotated0123456789abcdef',
      },
    };
  },
  'POST /admin/credentials/:id/destination': async (w) => ({
    path: `/admin/credentials/${w.serviceId}/destination`,
    action: 'service.credential.set',
    fields: {
      base_url: 'https://api.github.com',
      injection_kind: 'bearer',
      credential: 'ghp_fixtureRepointed0123456789abcdef',
      confirm_destination: 'api.github.com',
    },
  }),
  'POST /admin/credentials/:id/test': async (w) => ({
    path: `/admin/credentials/${w.serviceId}/test`,
    action: 'service.credential.test',
    fields: {},
    // The result is rendered once, not redirected to.
    successStatus: [200],
  }),
  'POST /admin/credentials/:id/toggle': async (w) => ({
    path: `/admin/credentials/${w.serviceId}/toggle`,
    action: 'service.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/credentials/:id/delete': async (w) => {
    const id = await seedService(w.app.deps, { slug: unique('doomed') });
    return {
      path: `/admin/credentials/${id}/delete`,
      action: 'service.delete',
      fields: { confirm: '1' },
    };
  },

  // == access rules ==
  'POST /admin/credential-access-rules': async (w) => ({
    path: '/admin/credential-access-rules',
    action: 'credential_access_rule.create',
    fields: worldRuleFields(w, { token_id: w.serviceId, token_view: 'fixed' }),
  }),
  'POST /admin/credential-access-rules/:id': async (w) => ({
    path: `/admin/credential-access-rules/${w.rule.id}`,
    action: 'credential_access_rule.update',
    fields: worldRuleFields(w, {
      intent: 'save',
      name: unique('read repo renamed'),
      expected_updated_at: String(w.rule.updated_at),
      expires: 'keep',
    }),
  }),
  'POST /admin/credential-access-rules/:id/tenants': async (w) => ({
    path: `/admin/credential-access-rules/${w.rule.id}/tenants`,
    action: 'credential_access_rule.update',
    fields: { intent: 'add', tenant: 'acme-labs (7654321)' },
  }),
  'POST /admin/credential-access-rules/:id/copy': async (w) => ({
    path: `/admin/credential-access-rules/${w.rule.id}/copy`,
    action: 'credential_access_rule.duplicate',
    fields: { credential_id: '' },
  }),
  'POST /admin/credential-access-rules/:id/toggle': async (w) => ({
    path: `/admin/credential-access-rules/${w.rule.id}/toggle`,
    action: 'credential_access_rule.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/credential-access-rules/:id/delete': async (w) => {
    const doomed = await seedCredentialRule(w.app.deps, {
      credential_id: w.serviceId,
      name: unique('doomed'),
    });
    return {
      path: `/admin/credential-access-rules/${doomed.id}/delete`,
      action: 'credential_access_rule.delete',
      fields: { confirm: '1' },
    };
  },
  // A generic issuer of its own: the first ceiling of that issuer, confirmed.
  'POST /admin/global-access-rules': async () => ({
    path: '/admin/global-access-rules',
    action: 'global_access_rule.create',
    fields: {
      type: 'generic',
      issuer: `https://${unique('idp')}.acme.example`,
      name: unique('ceiling'),
      enabled: '1',
      confirm_new_ceiling: '1',
    },
  }),
  'POST /admin/global-access-rules/:id': async (w) => ({
    path: `/admin/global-access-rules/${w.global.id}`,
    action: 'global_access_rule.update',
    fields: {
      name: unique('GitLab ceiling renamed'),
      expected_updated_at: String(w.global.updated_at),
    },
  }),
  // The only global access rule of GitLab.com: disabling it is the last disable, confirmed.
  'POST /admin/global-access-rules/:id/toggle': async (w) => ({
    path: `/admin/global-access-rules/${w.global.id}/toggle`,
    action: 'global_access_rule.disable',
    fields: { enabled: '0', confirm_last_disable: '1' },
  }),
  'POST /admin/global-access-rules/:id/delete': async (w) => {
    const created = await createGlobalAccessRule(w.app.deps, ACTOR, {
      name: unique('doomed ceiling'),
      profile: 'generic',
      issuer: `https://${unique('doomed')}.example.org`,
      confirm_new_ceiling: true,
    });
    if (!created.ok) throw new Error(`fixture: ${created.errors.join('; ')}`);
    return {
      path: `/admin/global-access-rules/${created.rule.id}/delete`,
      action: 'global_access_rule.delete',
      fields: { confirm: '1', confirm_widening: '1' },
    };
  },

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
 * credential together with its credential access rules.
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
      path: '/admin/credentials',
      action: ['settings.upstream_hosts', 'service.create'],
      fields: {
        template: 'openai',
        credential: 'sk-proj-fixtureAllowHost0123456789abcdef',
        allow_host: 'api.openai.com',
      },
    };
  },
  /** One service.delete row whose diff lists every deleted credential access rule. */
  deleteWithRules: async (w: AdminWorld): Promise<MutationRequest> => {
    const { results } = await env.DB.prepare(
      'SELECT id FROM access_rules WHERE credential_id = ? ORDER BY id',
    )
      .bind(w.serviceId)
      .all<{ id: string }>();
    return {
      path: `/admin/credentials/${w.serviceId}/delete`,
      action: 'service.delete',
      fields: {
        confirm: '1',
        with_rules: '1',
        rule_ids: results.map((row) => row.id).join(','),
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
    users: { '/admin/users/:id': (w) => w.userId },
    tokens: { '/admin/credentials/:id': (w) => w.serviceId },
    'access rules': {
      '/admin/credential-access-rules/:id': (w) => w.rule.id,
      '/admin/global-access-rules/:id': (w) => w.global.id,
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

// == access rules ==
/**
 * The fields of the credential access rule form for the world's GitHub rule: its organization, its
 * repository on main (protected refs), the "read repo" preset, no expiry.
 */
function worldRuleFields(
  _w: AdminWorld,
  extra: Record<string, string>,
): Record<string, string | string[]> {
  const jobs = 'new.github-actions.';
  return {
    'new.type': 'github-actions',
    'new.github_org': `acme (${OWNER_ID})`,
    [`${jobs}editor`]: 'structured',
    [`${jobs}repository`]: `acme/api (${REPOSITORY_ID})`,
    [`${jobs}context`]: 'branch',
    [`${jobs}branch`]: 'main',
    [`${jobs}ref_protection`]: 'protected',
    ops: '1',
    op: 'read-repo',
    expires: 'never',
    ...extra,
  };
}
