import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Permission } from '../../src/admin/auth/rbac';
import type { AdminActor } from '../../src/admin/auth/types';
import { destinationFingerprint, testServiceCredential } from '../../src/admin/ops/credentials';
import { createIssuerAccessRule } from '../../src/admin/ops/issuer_access_rules';
import { updateSettings } from '../../src/admin/ops/settings';
import { inviteUser, updateUser } from '../../src/admin/ops/users';
import { getService } from '../../src/db/credentials';
import {
  anchoredConditions,
  CONTEXT,
  fakeNetwork,
  racingDeps,
} from '../../test/unit/admin/ops/helpers';
import {
  createAdminWorldApp,
  resetAdminWorld,
  seedAdminWorld,
  TOKEN_FIXTURE_VARIANTS,
  WORLD_SECRET,
} from '../fixtures/admin-forms';
import { type AdminSession, adminPost, createUser, loginAs } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';
import { KEK_1 } from '../unit/admin/ops/helpers';

beforeEach(resetAdminWorld);

const ATTACKER_HOST = 'attacker.example';

/**
 * The real app with a seeded service (credential check: api.github.com). `whileInFlight` runs once
 * while a request to `host` (default `attacker.example`) is in flight, i.e. after the admin
 * middleware passed the request.
 */
async function world() {
  let during: (() => Promise<void>) | null = null;
  let duringHost = ATTACKER_HOST;
  const network = fakeNetwork(async (url) => {
    if (url.hostname === duringHost && during) {
      const run = during;
      during = null;
      await run();
    }
    return new Response('{"ok":true}', { status: 200 });
  });
  const app = createAdminWorldApp(network.fetch);
  const seeded = await seedAdminWorld(app);
  const owner = await createUser({ email: 'owner@example.com', role: 'owner' });
  const admin = await createUser({ email: 'admin@example.com', role: 'admin' });
  const ownerSession = await loginAs(app, owner);
  const adminSession = await loginAs(app, admin);
  return {
    app,
    serviceId: seeded.serviceId,
    providerId: seeded.provider.id,
    owner,
    admin,
    ownerSession,
    adminSession,
    network,
    whileInFlight(run: () => Promise<void>, host = ATTACKER_HOST) {
      during = run;
      duringHost = host;
    },
  };
}

async function repoint(app: Parameters<typeof adminPost>[0], session: AdminSession, id: string) {
  return adminPost(app, session, `/admin/credentials/${id}/destination`, {
    base_url: `https://${ATTACKER_HOST}`,
    injection_kind: 'bearer',
    credential: 'attacker-token-0123456789',
  });
}

async function serviceState(serviceId: string, actorId: string) {
  const baseUrl = await env.DB.prepare('SELECT base_url FROM credentials WHERE id = ?')
    .bind(serviceId)
    .first('base_url');
  const audits = await env.DB.prepare(
    "SELECT count(*) AS n FROM audit_log WHERE action = 'service.credential.set' AND actor_id = ?",
  )
    .bind(actorId)
    .first('n');
  return { baseUrl, audits };
}

async function credentialTests(actorId: string) {
  return env.DB.prepare(
    "SELECT count(*) AS n FROM audit_log WHERE action = 'service.credential.test' AND actor_id = ?",
  )
    .bind(actorId)
    .first('n');
}

describe('I-SESS-1: an admin write commits only while the acting identity and role still allow it', () => {
  it('commits when nothing changes while the request is in flight (control)', async () => {
    const w = await world();
    const res = await repoint(w.app, w.adminSession, w.serviceId);
    expect(res.status).toBe(303);
    expect(await serviceState(w.serviceId, w.admin.id)).toEqual({
      baseUrl: `https://${ATTACKER_HOST}`,
      audits: 1,
    });
  });

  it.each([
    ['disables the user', (id: string) => [`/admin/users/${id}`, { status: 'suspended' }] as const],
    [
      'demotes the user to viewer',
      (id: string) => [`/admin/users/${id}`, { role: 'viewer' }] as const,
    ],
    [
      'resets the user’s login',
      (id: string) => [`/admin/users/${id}/reset-login`, { confirm: '1' }] as const,
    ],
  ])('writes nothing when an owner %s mid-request', async (_label, ownerAction) => {
    const w = await world();
    const before = await serviceState(w.serviceId, w.admin.id);
    w.whileInFlight(async () => {
      const [path, fields] = ownerAction(w.admin.id);
      expect((await adminPost(w.app, w.ownerSession, path, fields)).status).toBe(303);
    });
    const res = await repoint(w.app, w.adminSession, w.serviceId);
    expect(res.status).toBe(409);
    expect(await serviceState(w.serviceId, w.admin.id)).toEqual(before);
  });

  describe('ops without a row guard return a 409 conflict once the acting identity is unlinked', () => {
    async function revokedOwner(permission: Permission) {
      const w = await world();
      const actor: AdminActor = {
        type: 'user',
        id: w.owner.id,
        email: w.owner.email,
        ip: null,
        userAgent: null,
        authority: {
          userId: w.owner.id,
          loginProvider: 'access',
          subject: w.ownerSession.subject,
          permissions: [permission],
        },
      };
      await env.DB.prepare('DELETE FROM user_identities WHERE user_id = ?').bind(w.owner.id).run();
      return { w, deps: w.app.deps, actor };
    }

    it('control: the same actor commits while its identity is linked', async () => {
      const w = await world();
      const actor: AdminActor = {
        type: 'user',
        id: w.owner.id,
        email: w.owner.email,
        ip: null,
        userAgent: null,
        authority: {
          userId: w.owner.id,
          loginProvider: 'access',
          subject: w.ownerSession.subject,
          permissions: ['users:write'],
        },
      };
      const result = await inviteUser(w.app.deps, actor, { email: 'ok@acme.test', role: 'viewer' });
      expect(result).toMatchObject({ ok: true });
    });

    it('cannot invite', async () => {
      const { deps, actor } = await revokedOwner('users:write');
      const result = await inviteUser(deps, actor, { email: 'evil@attacker.test', role: 'owner' });
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(
        await env.DB.prepare('SELECT count(*) AS n FROM users WHERE email = ?')
          .bind('evil@attacker.test')
          .first('n'),
      ).toBe(0);
    });

    it('cannot change settings', async () => {
      const { deps, actor } = await revokedOwner('settings:write');
      const result = await updateSettings(deps, actor, { request_log_retention_days: 3 });
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM settings WHERE key = 'request_log_retention_days'",
        ).first('n'),
      ).toBe(0);
    });

    it('cannot send the stored credential in a credential test', async () => {
      const { w, deps, actor } = await revokedOwner('tokens:write');
      const calls = w.network.calls.length;
      const result = await testServiceCredential(deps, actor, w.serviceId, CONTEXT);
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(w.network.calls.slice(calls)).toEqual([]);
      expect(await credentialTests(w.owner.id)).toBe(0);
    });
  });

  describe('a demotion to the other half of the role split stops the write (ADR 0018)', () => {
    /** The admin's actor as the middleware builds it for a route needing `permissions`. */
    function adminActor(w: Awaited<ReturnType<typeof world>>, permissions: Permission[]) {
      const actor: AdminActor = {
        type: 'user',
        id: w.admin.id,
        email: w.admin.email,
        ip: null,
        userAgent: null,
        authority: {
          userId: w.admin.id,
          loginProvider: 'access',
          subject: w.adminSession.subject,
          permissions,
        },
      };
      return actor;
    }

    /** Deps that demote the admin to `role` right before the op's first write. */
    function demotedMidRequest(w: Awaited<ReturnType<typeof world>>, role: string) {
      return racingDeps(w.app.deps, () =>
        env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, w.admin.id).run(),
      );
    }

    const grantCount = async () =>
      env.DB.prepare('SELECT count(*) AS n FROM issuer_access_rules').first<number>('n');

    it('an admin demoted to token_manager cannot create a grant (POST /admin/issuer-access-rules)', async () => {
      const w = await world();
      const before = await grantCount();
      const result = await createIssuerAccessRule(
        demotedMidRequest(w, 'token_manager'),
        adminActor(w, ['access:write']),
        {
          name: 'demoted',
          credential_access_rule_id: w.providerId,
          service_id: w.serviceId,
          conditions: anchoredConditions(),
          rules: [{ methods: ['GET'], path: '/repos/**' }],
        },
      );
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(await grantCount()).toBe(before);
    });

    it('an admin demoted to access_manager cannot send the stored credential (POST /admin/credentials/:id/test)', async () => {
      const w = await world();
      const calls = w.network.calls.length;
      const result = await testServiceCredential(
        demotedMidRequest(w, 'access_manager'),
        adminActor(w, ['tokens:write']),
        w.serviceId,
        CONTEXT,
      );
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(w.network.calls.slice(calls)).toEqual([]);
      expect(await credentialTests(w.admin.id)).toBe(0);
    });

    it('a field permission is re-checked at commit: tokens:write plus access:write needs admin or owner', async () => {
      const w = await world();
      const before = await grantCount();
      const result = await createIssuerAccessRule(
        demotedMidRequest(w, 'access_manager'),
        adminActor(w, ['access:write', 'tokens:write']),
        {
          name: 'needs both',
          credential_access_rule_id: w.providerId,
          service_id: w.serviceId,
          conditions: anchoredConditions(),
          rules: [{ methods: ['GET'], path: '/repos/**' }],
        },
      );
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(await grantCount()).toBe(before);
    });

    it('an owner demoted to token_manager mid-request cannot change people (users:write)', async () => {
      const w = await world();
      const target = await createUser({ email: 'target@example.com', role: 'viewer' });
      const actor: AdminActor = {
        type: 'user',
        id: w.owner.id,
        email: w.owner.email,
        ip: null,
        userAgent: null,
        authority: {
          userId: w.owner.id,
          loginProvider: 'access',
          subject: w.ownerSession.subject,
          permissions: ['users:write'],
        },
      };
      // Another owner exists, so the demotion itself passes the last-owner trigger.
      await createUser({ email: 'owner2@example.com', role: 'owner' });
      const demoted = racingDeps(w.app.deps, () =>
        env.DB.prepare("UPDATE users SET role = 'token_manager' WHERE id = ?")
          .bind(w.owner.id)
          .run(),
      );
      const result = await updateUser(demoted, actor, target.id, { role: 'admin' });
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(
        await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(target.id).first('role'),
      ).toBe('viewer');
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_log WHERE action = 'user.update'",
        ).first('n'),
      ).toBe(0);
    });

    it('an authority without permissions never commits (fail closed)', async () => {
      const w = await world();
      const before = await grantCount();
      const result = await createIssuerAccessRule(w.app.deps, adminActor(w, []), {
        name: 'no permissions',
        credential_access_rule_id: w.providerId,
        service_id: w.serviceId,
        conditions: anchoredConditions(),
        rules: [{ methods: ['GET'], path: '/repos/**' }],
      });
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(await grantCount()).toBe(before);
    });

    it('control: the admin commits with both permissions while still an admin', async () => {
      const w = await world();
      const result = await createIssuerAccessRule(
        w.app.deps,
        adminActor(w, ['access:write', 'tokens:write']),
        {
          name: 'still admin',
          credential_access_rule_id: w.providerId,
          service_id: w.serviceId,
          conditions: anchoredConditions(),
          rules: [{ methods: ['GET'], path: '/repos/**' }],
        },
      );
      expect(result).toMatchObject({ ok: true });
    });
  });

  describe('a credential test commits its audit row before the stored credential is sent', () => {
    it('keeps the audit row when the user is disabled while the check is in flight', async () => {
      const w = await world();
      let auditedAtSend: unknown = null;
      let disableStatus = 0;
      w.whileInFlight(async () => {
        auditedAtSend = await credentialTests(w.admin.id);
        const res = await adminPost(w.app, w.ownerSession, `/admin/users/${w.admin.id}`, {
          status: 'suspended',
        });
        disableStatus = res.status;
      }, 'api.github.com');
      const calls = w.network.calls.length;
      const res = await adminPost(
        w.app,
        w.adminSession,
        `/admin/credentials/${w.serviceId}/test`,
        {},
      );
      expect({ auditedAtSend, disableStatus, status: res.status }).toEqual({
        auditedAtSend: 1,
        disableStatus: 303,
        status: 200,
      });
      const sent = w.network.calls.slice(calls);
      expect(sent.map((call) => call.headers.get('authorization'))).toEqual([
        `Bearer ${WORLD_SECRET}`,
      ]);
      expect(await credentialTests(w.admin.id)).toBe(1);
    });
  });
});

/**
 * A DB whose next audited write (the batch that starts with the actor check) first runs `run`:
 * a change that lands after the middleware passed the request but before its first commit.
 */
function armedDb() {
  const db = env.DB;
  let pending: (() => Promise<unknown>) | null = null;
  let armed = false;
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (pending && sql.startsWith("SELECT json_extract('{}'")) armed = true;
          return target.prepare(sql);
        };
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (armed && pending) {
            const run = pending;
            pending = null;
            armed = false;
            await run();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    db: proxy,
    beforeNextAuditedWrite(run: () => Promise<unknown>) {
      pending = run;
    },
  };
}

describe('I-SESS-1: token writes stop when the role changes mid-request', () => {
  it('an admin demoted to access_manager while the rotate check is in flight writes nothing (POST /admin/credentials/:id/secret)', async () => {
    const w = await world();
    const before = await serviceState(w.serviceId, w.admin.id);
    w.whileInFlight(async () => {
      const res = await adminPost(w.app, w.ownerSession, `/admin/users/${w.admin.id}`, {
        role: 'access_manager',
      });
      expect(res.status).toBe(303);
    }, 'api.github.com');
    const row = await getService(env.DB, w.serviceId);
    if (!row) throw new Error('service missing');
    const res = await adminPost(w.app, w.adminSession, `/admin/credentials/${w.serviceId}/secret`, {
      expected_destination: await destinationFingerprint(row),
      credential: 'ghp_rotatedWhileDemoted0123456789',
    });
    expect(res.status).toBe(409);
    expect(await serviceState(w.serviceId, w.admin.id)).toEqual(before);
  });

  it('an owner demoted to admin before the allowlist commit: neither row is written and nothing is sent (POST /admin/credentials with allow_host)', async () => {
    const armed = armedDb();
    const network = fakeNetwork();
    const app = createTestApp({
      fetch: network.fetch,
      env: { TOKENGATE_KEK: KEK_1, DB: armed.db },
    });
    await seedAdminWorld(app);
    const owner = await createUser({ email: 'owner@example.com', role: 'owner' });
    await createUser({ email: 'owner2@example.com', role: 'owner' });
    const session = await loginAs(app, owner);
    const request = await TOKEN_FIXTURE_VARIANTS.createWithAllowHost();
    armed.beforeNextAuditedWrite(() =>
      env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(owner.id).run(),
    );
    const calls = network.calls.length;
    const res = await adminPost(app, session, request.path, request.fields);
    expect(res.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT value FROM settings WHERE key = 'allowed_upstream_hosts'").first(
        'value',
      ),
    ).toBe('["api.github.com"]');
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM credentials WHERE base_url = 'https://api.openai.com/v1'",
      ).first('n'),
    ).toBe(0);
    expect(network.calls.slice(calls)).toEqual([]);
  });

  it('an admin demoted to token_manager before a cascade delete commits deletes nothing', async () => {
    const armed = armedDb();
    const app = createTestApp({
      fetch: fakeNetwork().fetch,
      env: { TOKENGATE_KEK: KEK_1, DB: armed.db },
    });
    const seeded = await seedAdminWorld(app);
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' });
    const session = await loginAs(app, admin);
    const request = await TOKEN_FIXTURE_VARIANTS.deleteWithAccesses(seeded);
    armed.beforeNextAuditedWrite(() =>
      env.DB.prepare("UPDATE users SET role = 'token_manager' WHERE id = ?").bind(admin.id).run(),
    );
    const res = await adminPost(app, session, request.path, request.fields);
    expect(res.status).toBe(409);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM credentials WHERE id = ?')
        .bind(seeded.serviceId)
        .first('n'),
    ).toBe(1);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM issuer_access_rules WHERE id = ?')
        .bind(seeded.grantId)
        .first('n'),
    ).toBe(1);
  });
});
