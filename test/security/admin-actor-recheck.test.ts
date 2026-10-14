import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Permission } from '../../src/admin/auth/rbac';
import type { AdminActor } from '../../src/admin/auth/types';
import { testServiceCredential } from '../../src/admin/ops/services';
import { updateSettings } from '../../src/admin/ops/settings';
import { inviteUser } from '../../src/admin/ops/users';
import { CONTEXT, fakeNetwork } from '../../test/unit/admin/ops/helpers';
import {
  createAdminWorldApp,
  resetAdminWorld,
  seedAdminWorld,
  WORLD_SECRET,
} from '../fixtures/admin-forms';
import { type AdminSession, adminPost, createUser, loginAs } from '../helpers/admin-auth';

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
  return adminPost(app, session, `/admin/services/${id}/credential`, {
    base_url: `https://${ATTACKER_HOST}`,
    injection_kind: 'bearer',
    credential: 'attacker-token-0123456789',
  });
}

async function serviceState(serviceId: string, actorId: string) {
  const baseUrl = await env.DB.prepare('SELECT base_url FROM services WHERE id = ?')
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
    ['resets the user’s login', (id: string) => [`/admin/users/${id}/reset-login`, {}] as const],
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
          permission,
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
          permission: 'users:write',
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
      const { w, deps, actor } = await revokedOwner('config:write');
      const calls = w.network.calls.length;
      const result = await testServiceCredential(deps, actor, w.serviceId, CONTEXT);
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(w.network.calls.slice(calls)).toEqual([]);
      expect(await credentialTests(w.owner.id)).toBe(0);
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
      const res = await adminPost(w.app, w.adminSession, `/admin/services/${w.serviceId}/test`, {});
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
