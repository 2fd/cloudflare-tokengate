// Admin host edits (Users › Sign-in): one host added or removed per change, never locking out the
// host in use, guarded on the stored list (I-DEPLOY-1), one audit row per change (I-AUDIT-1).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeHostInput, updateAdminHosts } from '../../../../src/admin/ops/admin-hosts';
import {
  ADMIN_HOSTS_KEY,
  getAdminHosts,
  putSettingGuardedStatement,
  putSettingStatement,
  settingValueGuard,
} from '../../../../src/db/settings';
import { ACTOR, auditRows, opsDeps, racingDeps } from './helpers';

const HOST = 'admin.example.com';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM audit_log'),
  ]);
});

async function store(hosts: string[]): Promise<void> {
  await env.DB.batch([putSettingStatement(env.DB, ADMIN_HOSTS_KEY, hosts, 1, null)]);
}

describe('normalizeHostInput', () => {
  it.each([
    ['https://Admin.Acme.com:8443/x/', 'admin.acme.com'],
    ['  admin.acme.com.  ', 'admin.acme.com'],
    ['http://admin.acme.com?x=1#y', 'admin.acme.com'],
    ['*.Acme.com', '*.acme.com'],
    ['localhost:8787', 'localhost'],
    ['[::1]:8787', '[::1]'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeHostInput(raw)).toBe(expected);
  });
});

describe('I-DEPLOY-1: admin host changes', () => {
  it('adds a pasted URL as its hostname, with one audit row', async () => {
    const result = await updateAdminHosts(
      opsDeps(),
      ACTOR,
      { add: 'https://Ops.Example.com:8443/x/' },
      HOST,
    );
    expect(result).toMatchObject({ ok: true, outcome: 'saved' });
    expect(await getAdminHosts(env.DB)).toEqual([HOST, 'ops.example.com']);
    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(['settings.admin_hosts']);
    expect(rows[0]?.diff).toEqual({ before: null, after: [HOST, 'ops.example.com'] });
  });

  it('pins the console to the host in use when nothing is stored', async () => {
    const result = await updateAdminHosts(opsDeps(), ACTOR, { add: HOST }, HOST);
    expect(result).toMatchObject({ ok: true, outcome: 'saved' });
    expect(await getAdminHosts(env.DB)).toEqual([HOST]);
  });

  it('refuses workers.dev and a non-hostname, writing nothing', async () => {
    for (const add of ['tokengate.acme.workers.dev', '*.workers.dev', 'not a host', '*.dev']) {
      const result = await updateAdminHosts(opsDeps(), ACTOR, { add }, HOST);
      expect(result, add).toMatchObject({ ok: false, reason: 'invalid' });
      if (!result.ok) expect(result.fieldErrors?.[0]?.field).toBe('add');
    }
    expect(await getAdminHosts(env.DB)).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('reports an already listed host as unchanged, without an audit row', async () => {
    await store([HOST, 'ops.example.com']);
    const result = await updateAdminHosts(opsDeps(), ACTOR, { add: 'OPS.example.com' }, HOST);
    expect(result).toMatchObject({ ok: true, outcome: 'host_present', auditId: null });
    const absent = await updateAdminHosts(opsDeps(), ACTOR, { remove: 'x.example.com' }, HOST);
    expect(absent).toMatchObject({ ok: true, outcome: 'host_absent', auditId: null });
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a removal that leaves the host in use uncovered, or the list empty', async () => {
    await store([HOST, 'ops.example.com']);
    const current = await updateAdminHosts(opsDeps(), ACTOR, { remove: HOST }, HOST);
    expect(current).toMatchObject({ ok: false, reason: 'invalid' });
    await store([HOST]);
    const last = await updateAdminHosts(opsDeps(), ACTOR, { remove: HOST }, HOST);
    expect(last).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await getAdminHosts(env.DB)).toEqual([HOST]);
    expect(await auditRows()).toEqual([]);
  });

  it('allows removing the explicit host in use while a wildcard still covers it', async () => {
    await store([HOST, '*.example.com']);
    const result = await updateAdminHosts(opsDeps(), ACTOR, { remove: HOST }, HOST);
    expect(result).toMatchObject({ ok: true, outcome: 'saved' });
    expect(await getAdminHosts(env.DB)).toEqual(['*.example.com']);
  });

  it('refuses both or neither of add and remove', async () => {
    await store([HOST, 'ops.example.com']);
    for (const change of [{}, { add: ' ' }, { add: 'a.example.com', remove: 'ops.example.com' }]) {
      const result = await updateAdminHosts(opsDeps(), ACTOR, change, HOST);
      expect(result, JSON.stringify(change)).toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(await getAdminHosts(env.DB)).toEqual([HOST, 'ops.example.com']);
  });

  it('a concurrent change of the stored list is a conflict, and nothing is written', async () => {
    await store([HOST, 'old.example.com']);
    // Another owner removes old.example.com between this op's read and its write.
    const racing = racingDeps(opsDeps(), () => store([HOST]));
    const result = await updateAdminHosts(racing, ACTOR, { add: 'new.example.com' }, HOST);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    if (!result.ok) expect(result.errors.join()).toContain('changed meanwhile');
    expect(await getAdminHosts(env.DB)).toEqual([HOST]);
    expect(await auditRows()).toEqual([]);
  });

  it('the guarded write applies only while the stored value is the one read', async () => {
    const guard = settingValueGuard(ADMIN_HOSTS_KEY, null);
    const write = (hosts: string[]) =>
      putSettingGuardedStatement(env.DB, ADMIN_HOSTS_KEY, hosts, 1, null, guard).run();
    expect((await write([HOST])).meta.changes).toBe(1);
    // The key now exists, so a second write guarded on "absent" changes nothing.
    expect((await write([HOST, 'other.example.com'])).meta.changes).toBe(0);
    expect(await getAdminHosts(env.DB)).toEqual([HOST]);
  });
});
