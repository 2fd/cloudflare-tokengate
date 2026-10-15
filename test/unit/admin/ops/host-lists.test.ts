import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { updateAdminHosts } from '../../../../src/admin/ops/admin-hosts';
import { updateUpstreamHosts } from '../../../../src/admin/ops/upstream-hosts';
import {
  ADMIN_HOSTS_KEY,
  getAdminHosts,
  getAllowedUpstreamHosts,
  putSettingGuardedStatement,
  settingValueGuard,
} from '../../../../src/db/settings';
import { ACTOR, auditRows, opsDeps } from './helpers';

const HOST = 'admin.example.com';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM audit_log'),
  ]);
});

describe('I-DEPLOY-1: admin host edits are guarded on the list they were built from', () => {
  it('saves a list built from the stored value, including the first save (nothing stored)', async () => {
    const first = await updateAdminHosts(opsDeps(), ACTOR, HOST, HOST, null);
    expect(first).toMatchObject({ ok: true, changed: true });
    const second = await updateAdminHosts(opsDeps(), ACTOR, `${HOST}\nops.example.com`, HOST, [
      HOST,
    ]);
    expect(second).toMatchObject({ ok: true, changed: true });
    expect(await getAdminHosts(env.DB)).toEqual([HOST, 'ops.example.com']);
    expect(await auditRows()).toHaveLength(2);
  });

  it('refuses a delta applied to a list that changed since, so a removed host never comes back', async () => {
    await updateAdminHosts(opsDeps(), ACTOR, `${HOST}\nold.example.com`, HOST);
    // Owner A removes old.example.com.
    await updateAdminHosts(opsDeps(), ACTOR, HOST, HOST, [HOST, 'old.example.com']);
    // Owner B added a host to the list read before A's removal.
    const stale = await updateAdminHosts(
      opsDeps(),
      ACTOR,
      `${HOST}\nold.example.com\nnew.example.com`,
      HOST,
      [HOST, 'old.example.com'],
    );
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getAdminHosts(env.DB)).toEqual([HOST]);
    expect(await auditRows()).toHaveLength(2);
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

describe('I-SSRF-1: upstream host edits are guarded on the stored value', () => {
  it('saves and clears the allowlist through the guarded write', async () => {
    expect(await updateUpstreamHosts(opsDeps(), ACTOR, 'api.github.com')).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com']);
    expect(await updateUpstreamHosts(opsDeps(), ACTOR, '')).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
    expect(await auditRows()).toHaveLength(2);
  });
});
