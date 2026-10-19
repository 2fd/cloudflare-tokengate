// Deleting a credential together with its credential access rules (D9): one confirm, one batch, one
// audit row whose diff holds every deleted rule, and only while the rules are exactly the confirmed
// set (I-AUDIT-1). It needs access:write as well (field permission with_rules); a credential
// manager is shown the blocking rules instead. Global access rules are never part of the cascade.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteService } from '../../src/admin/ops/credentials';
import {
  type AdminWorld,
  createAdminWorldApp,
  resetAdminWorld,
  seedAdminWorld,
  TOKEN_FIXTURE_VARIANTS,
} from '../fixtures/admin-forms';
import { adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';
import { ACTOR, auditRows, racingDeps, seedCredentialRule } from '../unit/admin/ops/helpers';

let world: AdminWorld;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  await seedCredentialRule(world.app.deps, { credential_id: world.serviceId, name: 'second rule' });
});

const count = async (where: string, value: string) =>
  env.DB.prepare(`SELECT count(*) AS n FROM access_rules WHERE ${where}`).bind(value).first('n');
const credentials = async (id: string) =>
  env.DB.prepare('SELECT count(*) AS n FROM credentials WHERE id = ?').bind(id).first('n');

async function ruleIds(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM access_rules WHERE credential_id = ? ORDER BY id',
  )
    .bind(world.serviceId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

describe('I-AUDIT-1: cascade delete', () => {
  it('deletes the credential and every rule in one batch with one audit row holding them all', async () => {
    const admin = await loginAs(
      world.app,
      await createUser({ email: 'a@example.com', role: 'admin' }),
    );
    const page = await (
      await adminGet(world.app, admin, `/admin/credentials/${world.serviceId}`)
    ).text();
    expect(page).toContain('<h3>Delete GitHub and its 2 credential access rules</h3>');
    expect(page).toMatch(/commandfor="dlg-delete"[^>]*>Delete GitHub…<\/button>/);
    expect(page).toContain('Delete GitHub and its 2 credential access rules?');
    expect(page).toContain('name="confirm_slug"');
    expect(page).toContain('name="with_rules" value="1"');
    expect(page).toContain(`name="rule_ids" value="${(await ruleIds()).join(',')}"`);

    const request = await TOKEN_FIXTURE_VARIANTS.deleteWithRules(world);
    const before = (await auditRows()).length;
    const res = await adminPost(world.app, admin, request.path, request.fields);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/credentials?notice=deleted_with_rules');
    expect(await credentials(world.serviceId)).toBe(0);
    expect(await count('credential_id = ?', world.serviceId)).toBe(0);
    // The global access rule of the world stays: it belongs to no credential.
    expect(await count('id = ?', world.global.id)).toBe(1);
    const added = (await auditRows()).slice(before);
    expect(added.map((row) => row.action)).toEqual(['service.delete']);
    const deleted = (added[0]?.diff?.before as { access_rules?: Array<{ name: string }> })
      ?.access_rules;
    expect(deleted?.map((rule) => rule.name).sort()).toEqual(['read repo', 'second rule']);
    expect(JSON.stringify(added[0])).not.toContain('credential_sealed');
  });

  it('a changed set of rules is a 409 that deletes nothing and lists the current set', async () => {
    const admin = await loginAs(
      world.app,
      await createUser({ email: 'a@example.com', role: 'admin' }),
    );
    const request = await TOKEN_FIXTURE_VARIANTS.deleteWithRules(world);
    await seedCredentialRule(world.app.deps, {
      credential_id: world.serviceId,
      name: 'added meanwhile',
    });
    const before = (await auditRows()).length;
    const res = await adminPost(world.app, admin, request.path, request.fields);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('changed since the page was loaded; nothing was deleted');
    expect(html).toContain('<h3>Delete GitHub and its 3 credential access rules</h3>');
    expect(await count('credential_id = ?', world.serviceId)).toBe(3);
    expect((await auditRows()).length).toBe(before);
  });

  it('a rule added between the read and the commit makes the whole batch a no-op', async () => {
    const ids = await ruleIds();
    const before = (await auditRows()).length;
    const racing = racingDeps(world.app.deps, () =>
      seedCredentialRule(world.app.deps, { credential_id: world.serviceId, name: 'racing rule' }),
    );
    const result = await deleteService(racing, ACTOR, world.serviceId, {
      withRules: true,
      ruleIds: ids,
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await credentials(world.serviceId)).toBe(1);
    expect(await count('credential_id = ?', world.serviceId)).toBe(3);
    // The racing rule's own audit row is the only new one.
    expect((await auditRows()).slice(before).map((row) => row.action)).toEqual([
      'credential_access_rule.create',
    ]);
  });

  it('the confirmed rules deleted between the read and the commit: the credential stays, no row is lost unaudited', async () => {
    const ids = await ruleIds();
    const before = (await auditRows()).length;
    // An access manager deletes them (straight in D1 here) after the op read the set.
    const racing = racingDeps(world.app.deps, () =>
      env.DB.prepare('DELETE FROM access_rules WHERE credential_id = ?')
        .bind(world.serviceId)
        .run(),
    );
    const result = await deleteService(racing, ACTOR, world.serviceId, {
      withRules: true,
      ruleIds: ids,
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    // Without an audit row of this batch the credential is not deleted (I-AUDIT-1).
    expect(await credentials(world.serviceId)).toBe(1);
    expect((await auditRows()).slice(before)).toEqual([]);
    // A fresh confirmation of the (now empty) set deletes it, audited.
    const again = await deleteService(world.app.deps, ACTOR, world.serviceId, {});
    expect(again).toMatchObject({ ok: true, deletedRules: 0 });
    expect((await auditRows()).slice(before).map((row) => row.action)).toEqual(['service.delete']);
  });

  it('a credential manager sees the blocking rules and no delete trigger', async () => {
    const manager = await loginAs(
      world.app,
      await createUser({ email: 't@example.com', role: 'token_manager' }),
    );
    await createUser({ email: 'am@example.com', role: 'access_manager' });
    const html = await (
      await adminGet(world.app, manager, `/admin/credentials/${world.serviceId}`)
    ).text();
    expect(html).toContain('cannot be deleted while credential access rules use it');
    expect(html).toContain(`href="/admin/credential-access-rules/${world.rule.id}"`);
    expect(html).toContain('mailto:am@example.com');
    expect(html).not.toContain('commandfor="dlg-delete"');
    expect(html).toContain('Disable credential');
    const refused = await adminPost(
      world.app,
      manager,
      `/admin/credentials/${world.serviceId}/delete`,
      { confirm: '1', with_rules: '1', rule_ids: (await ruleIds()).join(',') },
    );
    expect(refused.status).toBe(403);
    expect(await credentials(world.serviceId)).toBe(1);
  });

  it('an op caller without access:write in its authority is refused', async () => {
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
      withRules: true,
      ruleIds: await ruleIds(),
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await credentials(world.serviceId)).toBe(1);
  });
});
