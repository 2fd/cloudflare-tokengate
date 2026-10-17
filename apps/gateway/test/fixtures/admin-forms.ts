// Admin route fixtures shared by the cross-cutting security tests: a seeded "world" (caller
// provider, service with a sealed credential and a verify check, grant, request record) on the real
// app, one successful form submission per mutating route of the RBAC table (I-AUDIT-1, I-RBAC-1),
// and concrete paths for every read route.
//
//   await resetAdminWorld();
//   const world = await seedAdminWorld(createAdminWorldApp());
//   const request = await MUTATION_FIXTURES['POST /admin/issuer-access-rules']?.(world);
//   await adminPost(world.app, ownerSession, request.path, request.fields);
import { env } from 'cloudflare:workers';
import { createCredentialAccessRule } from '../../src/admin/ops/credential-access-rules';
import { createIssuerAccessRule } from '../../src/admin/ops/issuer_access_rules';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import type { CredentialAccessRule } from '../../src/db/types';
import { newId } from '../../src/lib/ids';
import type { RequestRecord } from '../../src/telemetry/types';
import { createUser, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';
import { testCredentialId } from '../unit/admin/ops/helpers';
import {
  ACTOR,
  fakeNetwork,
  KEK_1,
  KEYRING_1_2,
  OWNER_ID,
  REPOSITORY_ID,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
} from '../unit/admin/ops/helpers';

export const WORLD_SECRET = 'ghp_worldFixtureSecret0123456789abcdef';
export const WORLD_VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };

export interface AdminWorld {
  app: TestApp;
  provider: CredentialAccessRule;
  /** Service with a sealed credential and a verify check that passes against the fake network. */
  serviceId: string;
  grantId: string;
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
    env.DB.prepare('DELETE FROM issuer_access_rules'),
    env.DB.prepare('DELETE FROM claim_labels'),
    env.DB.prepare('DELETE FROM credential_access_rules'),
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
  const provider = await seedGithubProvider(app.deps);
  const grant = await seedIssuerAccessRule(app.deps, provider.id, serviceId);
  const requestId = newId('req', Date.now(), app.deps.random);
  await env.TELEMETRY_DB.batch(
    insertRequestRecordsStatements(env.TELEMETRY_DB, [
      worldRequestRecord({ id: requestId, service_id: serviceId, provider_id: provider.id }),
    ]),
  );
  const person = await seedWorldPerson();
  return { app, provider, serviceId, grantId: grant.id, requestId, userId: person.id };
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
    credential_access_rule_id: ids.provider_id,
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

  // == consumers ==
  'POST /admin/credential-access-rules': async (w) => {
    const issuer = `https://${unique('idp')}.acme.example`;
    return {
      path: '/admin/credential-access-rules',
      action: 'credential_access_rule.create',
      app: discoveringApp(issuer),
      fields: {
        credential_id: w.serviceId,
        type: 'generic',
        generic_issuer: issuer,
        generic_anchor_claims: 'sub',
        generic_pin_claim: 'org_id',
        generic_pin_value: '77',
      },
    };
  },
  'POST /admin/credential-access-rules/:id': async (w) => ({
    path: `/admin/credential-access-rules/${w.provider.id}`,
    action: 'credential_access_rule.update',
    fields: {
      intent: 'rename',
      name: unique('GitHub Actions renamed'),
      expected_updated_at: String(w.provider.updated_at),
    },
  }),
  'POST /admin/credential-access-rules/:id/tenants': async (w) => ({
    path: `/admin/credential-access-rules/${w.provider.id}/tenants`,
    action: 'credential_access_rule.update',
    fields: { intent: 'add', tenant: 'acme-labs (7654321)' },
  }),
  'POST /admin/credential-access-rules/:id/toggle': async (w) => ({
    path: `/admin/credential-access-rules/${w.provider.id}/toggle`,
    action: 'credential_access_rule.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/credential-access-rules/:id/delete': async (w) => {
    const created = await createCredentialAccessRule(w.app.deps, ACTOR, {
      credential_id: await testCredentialId(w.app.deps),
      name: unique('doomed'),
      profile: 'generic',
      issuer: `https://${unique('doomed')}.example.org`,
      jwks_uri: 'https://doomed.example.org/jwks',
      anchor_claims: ['sub'],
    });
    if (!created.ok) throw new Error(`fixture: ${created.errors.join('; ')}`);
    const grant = await createIssuerAccessRule(w.app.deps, ACTOR, {
      name: unique('doomed access'),
      credential_access_rule_id: created.credentialAccessRule.id,
      service_id: w.serviceId,
      conditions: [{ claim: 'sub', match: 'exact', values: ['job-1'] }],
      rules: [{ methods: ['GET'], path: '/repos/**' }],
    });
    if (!grant.ok) throw new Error(`fixture: ${grant.errors.join('; ')}`);
    return {
      path: `/admin/credential-access-rules/${created.credentialAccessRule.id}/delete`,
      action: 'credential_access_rule.delete',
      fields: { confirm: '1', with_accesses: '1', access_ids: grant.grant.id },
    };
  },
  'POST /admin/issuer-access-rules': async (w) => ({
    path: '/admin/issuer-access-rules',
    action: 'grant.create',
    fields: {
      consumer_id: w.provider.id,
      token_id: w.serviceId,
      repository: 'acme/api (987654321)',
      context: 'branch',
      branch: 'main',
      ref_protection: 'protected',
      op: 'read-repo',
      expires: 'never',
    },
  }),
  'POST /admin/issuer-access-rules/:id': async (w) => ({
    path: `/admin/issuer-access-rules/${w.grantId}`,
    action: 'grant.update',
    fields: {
      intent: 'save',
      repository: `acme/api (${REPOSITORY_ID})`,
      context: 'branch',
      branch: 'main',
      ref_protection: 'protected',
      op: 'read-repo',
      expires: 'keep',
    },
  }),
  'POST /admin/issuer-access-rules/:id/copy': async (w) => {
    // A source with a stored repository name: without one, its literal operations (which may name
    // the repository) are reviewed in the form first instead of copied in one submit.
    await env.DB.prepare(
      `INSERT INTO claim_labels (credential_access_rule_id, claim, value, label, updated_at, updated_by)
       VALUES (?, 'repository_id', ?, 'acme/api', 1, NULL) ON CONFLICT DO NOTHING`,
    )
      .bind(w.provider.id, REPOSITORY_ID)
      .run();
    return {
      path: `/admin/issuer-access-rules/${w.grantId}/copy`,
      action: 'grant.duplicate',
      fields: { repository: 'acme/web (987654322)', token_id: w.serviceId },
    };
  },
  'POST /admin/issuer-access-rules/:id/toggle': async (w) => ({
    path: `/admin/issuer-access-rules/${w.grantId}/toggle`,
    action: 'grant.disable',
    fields: { enabled: '0' },
  }),
  'POST /admin/issuer-access-rules/:id/delete': async (w) => ({
    path: `/admin/issuer-access-rules/${w.grantId}/delete`,
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
 * token together with its issuer access rules.
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
  /** One service.delete row whose diff holds every deleted access. */
  deleteWithAccesses: async (w: AdminWorld): Promise<MutationRequest> => {
    const { results } = await env.DB.prepare(
      'SELECT id FROM issuer_access_rules WHERE service_id = ? ORDER BY id',
    )
      .bind(w.serviceId)
      .all<{ id: string }>();
    return {
      path: `/admin/credentials/${w.serviceId}/delete`,
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
    users: { '/admin/users/:id': (w) => w.userId },
    tokens: { '/admin/credentials/:id': (w) => w.serviceId },
    consumers: {
      '/admin/credential-access-rules/:id': (w) => w.provider.id,
      '/admin/issuer-access-rules/:id': (w) => w.grantId,
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

// == consumers ==
/** The world app with OIDC discovery for one more issuer (same databases). */
function discoveringApp(issuer: string): TestApp {
  return createAdminWorldApp(
    fakeNetwork(undefined, {
      'https://token.actions.githubusercontent.com':
        'https://token.actions.githubusercontent.com/.well-known/jwks',
      [issuer]: `${issuer}/.well-known/jwks`,
    }).fetch,
  );
}
