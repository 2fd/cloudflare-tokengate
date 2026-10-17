// Deleting a token together with its consumer access (D9): one confirm, one batch, one audit row
// whose diff holds every deleted row, and only while the accesses are exactly the confirmed set.
// It needs access:write as well (field permission with_accesses); a token manager is shown the
// blocking accesses instead.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteService } from '../../src/admin/ops/services';
import {
  type AdminWorld,
  createAdminWorldApp,
  resetAdminWorld,
  seedAdminWorld,
  TOKEN_FIXTURE_VARIANTS,
} from '../fixtures/admin-forms';
import { adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';
import { ACTOR, auditRows, racingDeps, seedGrant } from '../unit/admin/ops/helpers';

let world: AdminWorld;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  await seedGrant(world.app.deps, world.provider.id, world.serviceId, 'second access');
});

const count = async (table: string, column: string, value: string) =>
  env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first('n');

describe('I-AUDIT-1: cascade delete', () => {
  it('deletes the token and every access in one batch with one audit row holding them all', async () => {
    const admin = await loginAs(
      world.app,
      await createUser({ email: 'a@example.com', role: 'admin' }),
    );
    const page = await (
      await adminGet(world.app, admin, `/admin/tokens/${world.serviceId}`)
    ).text();
    expect(page).toContain('<h3>Delete GitHub and its 2 consumer accesses</h3>');
    expect(page).toMatch(/commandfor="dlg-delete"[^>]*>Delete GitHub…<\/button>/);
    expect(page).toContain('Delete GitHub and its 2 consumer accesses?');
    expect(page).toContain('name="confirm_slug"');
    expect(page).toContain('name="with_accesses" value="1"');
    expect(page).toContain(`href="/admin/access/${world.grantId}"`);

    const request = await TOKEN_FIXTURE_VARIANTS.deleteWithAccesses(world);
    const before = (await auditRows()).length;
    const res = await adminPost(world.app, admin, request.path, request.fields);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/tokens?notice=deleted_with_accesses');
    expect(await count('services', 'id', world.serviceId)).toBe(0);
    expect(await count('grants', 'service_id', world.serviceId)).toBe(0);
    const added = (await auditRows()).slice(before);
    expect(added.map((row) => row.action)).toEqual(['service.delete']);
    const before0 = added[0]?.diff?.before as
      | { accesses?: Array<{ id: string; name: string }> }
      | undefined;
    const accesses = before0?.accesses;
    expect(accesses?.map((grant) => grant.name).sort()).toEqual(['read repo', 'second access']);
    expect(JSON.stringify(added[0])).not.toContain('credential_sealed');
  });

  it('a changed set of accesses is a 409 that deletes nothing and lists the current set', async () => {
    const admin = await loginAs(
      world.app,
      await createUser({ email: 'a@example.com', role: 'admin' }),
    );
    const request = await TOKEN_FIXTURE_VARIANTS.deleteWithAccesses(world);
    await seedGrant(world.app.deps, world.provider.id, world.serviceId, 'added meanwhile');
    const before = (await auditRows()).length;
    const res = await adminPost(world.app, admin, request.path, request.fields);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('changed since the page was loaded; nothing was deleted');
    expect(html).toContain('<h3>Delete GitHub and its 3 consumer accesses</h3>');
    expect(await count('grants', 'service_id', world.serviceId)).toBe(3);
    expect((await auditRows()).length).toBe(before);
  });

  it('an access added between the read and the commit makes the whole batch a no-op', async () => {
    const ids = (
      await env.DB.prepare('SELECT id FROM grants WHERE service_id = ?')
        .bind(world.serviceId)
        .all<{ id: string }>()
    ).results.map((row) => row.id);
    const before = (await auditRows()).length;
    const racing = racingDeps(world.app.deps, () =>
      seedGrant(world.app.deps, world.provider.id, world.serviceId, 'racing access'),
    );
    const result = await deleteService(racing, ACTOR, world.serviceId, {
      withAccesses: true,
      accessIds: ids,
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await count('services', 'id', world.serviceId)).toBe(1);
    expect(await count('grants', 'service_id', world.serviceId)).toBe(3);
    // The racing grant's own audit row is the only new one.
    expect((await auditRows()).slice(before).map((row) => row.action)).toEqual(['grant.create']);
  });

  it('the confirmed accesses deleted between the read and the commit: the token stays, no row is lost unaudited', async () => {
    const ids = (
      await env.DB.prepare('SELECT id FROM grants WHERE service_id = ?')
        .bind(world.serviceId)
        .all<{ id: string }>()
    ).results.map((row) => row.id);
    const before = (await auditRows()).length;
    // An access manager deletes them (straight in D1 here) after the op read the set.
    const racing = racingDeps(world.app.deps, () =>
      env.DB.prepare('DELETE FROM grants WHERE service_id = ?').bind(world.serviceId).run(),
    );
    const result = await deleteService(racing, ACTOR, world.serviceId, {
      withAccesses: true,
      accessIds: ids,
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    // Without an audit row of this batch the token is not deleted (I-AUDIT-1).
    expect(await count('services', 'id', world.serviceId)).toBe(1);
    expect((await auditRows()).slice(before)).toEqual([]);
    // A fresh confirmation of the (now empty) set deletes it, audited.
    const again = await deleteService(world.app.deps, ACTOR, world.serviceId, {});
    expect(again).toMatchObject({ ok: true, deletedAccesses: 0 });
    expect((await auditRows()).slice(before).map((row) => row.action)).toEqual(['service.delete']);
  });

  it('a token manager sees the blocking accesses and no delete trigger', async () => {
    const manager = await loginAs(
      world.app,
      await createUser({ email: 't@example.com', role: 'token_manager' }),
    );
    await createUser({ email: 'am@example.com', role: 'access_manager' });
    const html = await (
      await adminGet(world.app, manager, `/admin/tokens/${world.serviceId}`)
    ).text();
    expect(html).toContain('cannot be deleted while consumer access uses it');
    expect(html).toContain(`href="/admin/access/${world.grantId}"`);
    expect(html).toContain('mailto:am@example.com');
    expect(html).not.toContain('commandfor="dlg-delete"');
    expect(html).toContain('Disable token');
    const refused = await adminPost(world.app, manager, `/admin/tokens/${world.serviceId}/delete`, {
      confirm: '1',
      with_accesses: '1',
      access_ids: world.grantId,
    });
    expect(refused.status).toBe(403);
    expect(await count('services', 'id', world.serviceId)).toBe(1);
  });

  it('an op caller without access:write in its authority is refused', async () => {
    const ids = (
      await env.DB.prepare('SELECT id FROM grants WHERE service_id = ?')
        .bind(world.serviceId)
        .all<{ id: string }>()
    ).results.map((row) => row.id);
    const actor = {
      ...ACTOR,
      authority: {
        userId: ACTOR.id ?? '',
        loginProvider: 'access' as const,
        subject: 'team|x',
        permissions: ['tokens:write' as const],
      },
    };
    const result = await deleteService(world.app.deps, actor, world.serviceId, {
      withAccesses: true,
      accessIds: ids,
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await count('services', 'id', world.serviceId)).toBe(1);
  });
});
