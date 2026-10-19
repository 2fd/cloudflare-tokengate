// Global access rule ops (ADR 0026, I-AUTHZ-5): every change that can widen a ceiling needs
// `confirm_widening`, the first ceiling of an issuer needs `confirm_new_ceiling` (AR-21), and the
// last enabled rule needs `confirm_last_disable` (AR-4). Without the confirmation nothing is
// written, and the guards keep the classification true at commit.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createGlobalAccessRule,
  deleteGlobalAccessRule,
  type GlobalRuleInput,
  setGlobalAccessRuleEnabled,
  updateGlobalAccessRule,
} from '../../../../src/admin/ops/global-access-rules';
import { getGlobalAccessRule, listGlobalAccessRules } from '../../../../src/db/access-rules';
import type { GlobalAccessRule } from '../../../../src/db/types';
import {
  ACTOR,
  auditCount,
  auditRows,
  GITHUB_ISSUER,
  OWNER_ID,
  opsDeps,
  racingDeps,
  resetControlPlane,
  seedCredentialRule,
  seedGlobalRule,
} from './helpers';

const ACME_PIN = [{ claim: 'repository_owner_id', match: 'exact' as const, values: [OWNER_ID] }];
const READ_ONLY = [{ methods: ['GET' as const], path: '/repos/**' }];
const DAY = 86_400_000;

let deps: ReturnType<typeof opsDeps>;

beforeEach(async () => {
  await resetControlPlane();
  deps = opsDeps();
});

/** The stored state that every refused change must leave as it was. */
async function snapshot() {
  return { rules: await listGlobalAccessRules(env.DB), audits: await auditCount() };
}

function input(overrides: Partial<GlobalRuleInput> = {}): GlobalRuleInput {
  return { name: 'acme only', profile: 'github-actions', tenant_pin: ACME_PIN, ...overrides };
}

describe('createGlobalAccessRule', () => {
  it('needs confirm_new_ceiling for the first global access rule of an issuer', async () => {
    const before = await snapshot();
    const refused = await createGlobalAccessRule(deps, ACTOR, input());
    expect(refused).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
      confirm: 'new_ceiling',
      errors: [
        `This is the first global access rule of ${GITHUB_ISSUER}. From the next request on, its credential access rules admit only what this rule allows.`,
      ],
    });
    expect(await snapshot()).toEqual(before);

    const created = await createGlobalAccessRule(deps, ACTOR, {
      ...input(),
      confirm_new_ceiling: true,
    });
    expect(created).toMatchObject({ ok: true, change: 'tightening' });
    if (!created.ok) return;
    expect(created.rule).toMatchObject({
      kind: 'global',
      credential_id: null,
      issuer: GITHUB_ISSUER,
      issuer_key: GITHUB_ISSUER,
      tenant_pin: ACME_PIN,
      jwks_uri: null,
      rules: null,
      enabled: true,
    });
    expect(created.rule.id).toMatch(/^gar_/);
    expect(await getGlobalAccessRule(env.DB, created.rule.id)).toEqual(created.rule);
    const [audit] = await auditRows(created.rule.id);
    expect(audit).toMatchObject({
      action: 'global_access_rule.create',
      target_type: 'global_access_rule',
      summary: `Added global access rule acme only for ${GITHUB_ISSUER}`,
    });
    expect(audit?.diff).toMatchObject({ ceiling: 'tightening' });
  });

  it('needs confirm_widening for an enabled sibling, which can only add (AR-21)', async () => {
    await seedGlobalRule(deps, input());
    const before = await snapshot();
    const refused = await createGlobalAccessRule(deps, ACTOR, {
      ...input({ name: 'no limits', tenant_pin: null }),
      confirm_new_ceiling: true,
    });
    expect(refused).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
      confirm: 'widening',
    });
    expect(await snapshot()).toEqual(before);

    const created = await createGlobalAccessRule(deps, ACTOR, {
      ...input({ name: 'no limits', tenant_pin: null }),
      confirm_widening: true,
    });
    expect(created).toMatchObject({ ok: true, change: 'widening' });
    expect(await listGlobalAccessRules(env.DB)).toHaveLength(2);
  });

  it('adds a disabled sibling without confirmation', async () => {
    await seedGlobalRule(deps, input());
    const disabled = await createGlobalAccessRule(
      deps,
      ACTOR,
      input({ name: 'later', tenant_pin: null, enabled: false }),
    );
    expect(disabled).toMatchObject({ ok: true, change: 'none' });
  });

  it('lets an unconfirmed first create lose to a concurrent sibling create (409, nothing written)', async () => {
    let sibling: GlobalAccessRule | null = null;
    const racing = racingDeps(deps, async () => {
      sibling = await seedGlobalRule(deps, input({ name: 'concurrent' }));
    });
    const result = await createGlobalAccessRule(racing, ACTOR, {
      ...input({ tenant_pin: null }),
      confirm_new_ceiling: true,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      errors: ['Another change added a global access rule of this issuer. Reload the page.'],
    });
    const rules = await listGlobalAccessRules(env.DB);
    expect(rules.map((rule) => rule.id)).toEqual([sibling!.id]);
    expect((await auditRows()).map((row) => row.action)).toEqual(['global_access_rule.create']);
  });

  it('warns when no credential access rule uses the issuer key yet', async () => {
    const lonely = await createGlobalAccessRule(deps, ACTOR, {
      ...input(),
      confirm_new_ceiling: true,
    });
    expect(lonely.ok && lonely.warnings).toEqual([
      `No credential access rule uses this issuer yet. Check the spelling: this global access rule limits only rules whose issuer is ${GITHUB_ISSUER}.`,
    ]);
    await seedCredentialRule(deps);
    const used = await createGlobalAccessRule(deps, ACTOR, {
      ...input({ name: 'second' }),
      confirm_widening: true,
    });
    expect(used.ok && used.warnings).toEqual([]);
  });

  it('refuses an empty list, a non-canonical issuer and a taken name', async () => {
    const empty = await createGlobalAccessRule(deps, ACTOR, {
      ...input({ rules: [] }),
      confirm_new_ceiling: true,
    });
    expect(empty).toMatchObject({ ok: false, reason: 'invalid' });
    if (!empty.ok) expect(empty.errors.join()).toMatch(/Leave the box unticked for no limit/);

    const spelling = await createGlobalAccessRule(deps, ACTOR, {
      ...input({ profile: 'gitlab-ci', issuer: 'https://GitLab.com:443/', tenant_pin: null }),
      confirm_new_ceiling: true,
    });
    expect(spelling).toMatchObject({ ok: false, reason: 'invalid' });
    if (!spelling.ok)
      expect(spelling.errors.join()).toMatch(/Write the issuer as https:\/\/gitlab\.com/);

    await seedGlobalRule(deps, input());
    const before = await snapshot();
    const clash = await createGlobalAccessRule(deps, ACTOR, {
      ...input({ name: 'ACME ONLY' }),
      confirm_widening: true,
    });
    expect(clash).toMatchObject({ ok: false, reason: 'conflict', errors: ['This name is taken.'] });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a new rule past the cap of 20 per issuer key', async () => {
    const first = await seedGlobalRule(deps, input());
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 19)
       INSERT INTO access_rules (id, credential_id, profile, name, description, issuer, issuer_key, tenant_pin,
         enabled, created_by, created_at, updated_at)
       SELECT printf('gar_CAP%023d', i), NULL, profile, name || ' ' || i, '', issuer, issuer_key, tenant_pin,
         enabled, created_by, created_at, updated_at
       FROM n, access_rules WHERE id = ?`,
    )
      .bind(first.id)
      .run();
    const before = await snapshot();
    const result = await createGlobalAccessRule(deps, ACTOR, {
      ...input({ name: 'one too many' }),
      confirm_widening: true,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'invalid',
      errors: ['An issuer can have at most 20 global access rules.'],
    });
    expect(await snapshot()).toEqual(before);
  });
});

describe('updateGlobalAccessRule', () => {
  it('saves a tightening without confirmation and audits the changed fields', async () => {
    const rule = await seedGlobalRule(deps, input());
    const result = await updateGlobalAccessRule(deps, ACTOR, rule.id, { rules: READ_ONLY });
    expect(result).toMatchObject({ ok: true, change: 'tightening', changed: true });
    const audit = (await auditRows(rule.id)).at(-1);
    expect(audit).toMatchObject({
      action: 'global_access_rule.update',
      summary: 'Changed global access rule acme only: operations',
    });
    expect(audit?.diff).toMatchObject({
      before: { rules: null },
      after: { rules: READ_ONLY },
      ceiling: 'tightening',
    });
  });

  it.each<[string, Partial<GlobalRuleInput>, 'widening' | 'mixed']>([
    ['a cleared limit', { tenant_pin: null }, 'widening'],
    ['a relaxed limit', { rules: [{ methods: ['GET', 'POST'], path: '/repos/**' }] }, 'widening'],
    ['a cleared expiry', { expires_at: null }, 'widening'],
    ['an extended expiry', { expires_at: Date.now() + 30 * DAY }, 'widening'],
    [
      'one limit narrowed and another relaxed',
      { tenant_pin: null, allowed_algs: ['RS256'] },
      'mixed',
    ],
  ])('needs confirm_widening for %s (AR-21)', async (_name, change, kind) => {
    const rule = await seedGlobalRule(
      deps,
      input({ rules: READ_ONLY, expires_at: Date.now() + DAY }),
    );
    const before = await snapshot();
    const refused = await updateGlobalAccessRule(deps, ACTOR, rule.id, change);
    expect(refused).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
      confirm: 'widening',
    });
    expect(await snapshot()).toEqual(before);

    const confirmed = await updateGlobalAccessRule(deps, ACTOR, rule.id, {
      ...change,
      confirm_widening: true,
    });
    expect(confirmed).toMatchObject({ ok: true, change: kind });
    expect((await auditRows(rule.id)).at(-1)?.diff).toMatchObject({
      ceiling: kind,
      widening_confirmed: true,
    });
  });

  it('keeps the issuer and the profile immutable (AR-5)', async () => {
    const rule = await seedGlobalRule(deps, input());
    const before = await snapshot();
    for (const change of [
      { issuer: 'https://token.actions.example.com' },
      { profile: 'generic' },
    ]) {
      const result = await updateGlobalAccessRule(deps, ACTOR, rule.id, change);
      expect(result, JSON.stringify(change)).toMatchObject({
        ok: false,
        reason: 'invalid',
        errors: [
          'The issuer and the issuer type of a global access rule cannot change. Add a new global access rule and delete this one.',
        ],
      });
    }
    expect(await snapshot()).toEqual(before);
    await expect(
      env.DB.prepare('UPDATE access_rules SET issuer = ?, issuer_key = ? WHERE id = ?')
        .bind('https://other.example', 'https://other.example', rule.id)
        .run(),
    ).rejects.toThrow(/immutable_row/);
  });

  it('writes nothing for a save that changes nothing', async () => {
    const rule = await seedGlobalRule(deps, input());
    const before = await snapshot();
    const result = await updateGlobalAccessRule(deps, ACTOR, rule.id, {
      name: 'acme only',
      tenant_pin: ACME_PIN,
    });
    expect(result).toMatchObject({ ok: true, changed: false, change: 'none' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a save from a form opened at an older version', async () => {
    const rule = await seedGlobalRule(deps, input());
    await updateGlobalAccessRule(deps, ACTOR, rule.id, { name: 'first' });
    const stale = await updateGlobalAccessRule(deps, ACTOR, rule.id, {
      name: 'second',
      expected_updated_at: rule.updated_at,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await getGlobalAccessRule(env.DB, rule.id))?.name).toBe('first');
  });

  it('needs confirm_last_disable to disable the last enabled rule through an update', async () => {
    const rule = await seedGlobalRule(deps, input());
    const before = await snapshot();
    expect(await updateGlobalAccessRule(deps, ACTOR, rule.id, { enabled: false })).toMatchObject({
      ok: false,
      confirm: 'last_disable',
    });
    expect(await snapshot()).toEqual(before);
    expect(
      await updateGlobalAccessRule(deps, ACTOR, rule.id, {
        enabled: false,
        confirm_last_disable: true,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('setGlobalAccessRuleEnabled', () => {
  it('needs confirm_widening to enable a rule (AR-21)', async () => {
    await seedGlobalRule(deps, input({ name: 'other' }));
    const rule = await seedGlobalRule(deps, input({ enabled: false }));
    const before = await snapshot();
    const refused = await setGlobalAccessRuleEnabled(deps, ACTOR, rule.id, true, {});
    expect(refused).toMatchObject({ ok: false, confirm: 'widening' });
    expect(await snapshot()).toEqual(before);
    const enabled = await setGlobalAccessRuleEnabled(deps, ACTOR, rule.id, true, {
      confirm_widening: true,
    });
    expect(enabled).toMatchObject({ ok: true, change: 'widening' });
    expect((await auditRows(rule.id)).at(-1)).toMatchObject({
      action: 'global_access_rule.enable',
      summary: 'Enabled global access rule acme only',
    });
  });

  it('needs confirm_last_disable for the last enabled rule of an issuer (AR-4)', async () => {
    const rule = await seedGlobalRule(deps, input());
    const before = await snapshot();
    const refused = await setGlobalAccessRuleEnabled(deps, ACTOR, rule.id, false, {});
    expect(refused).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
      confirm: 'last_disable',
      errors: [
        `While no global access rule of ${GITHUB_ISSUER} is enabled, its credential access rules admit nothing.`,
      ],
    });
    expect(await snapshot()).toEqual(before);
    const disabled = await setGlobalAccessRuleEnabled(deps, ACTOR, rule.id, false, {
      confirm_last_disable: true,
    });
    expect(disabled).toMatchObject({ ok: true, change: 'tightening' });
    // The disabled rule still caps its issuer: it exists and admits nothing.
    expect(await getGlobalAccessRule(env.DB, rule.id)).toMatchObject({ enabled: false });
    expect((await auditRows(rule.id)).at(-1)?.action).toBe('global_access_rule.disable');
  });

  it('disables a non-last rule without confirmation, guarded on the other enabled rule', async () => {
    const other = await seedGlobalRule(deps, input({ name: 'other' }));
    const rule = await seedGlobalRule(deps, input());
    const racing = racingDeps(deps, () =>
      env.DB.prepare('UPDATE access_rules SET enabled = 0 WHERE id = ?').bind(other.id).run(),
    );
    const before = await auditCount();
    const raced = await setGlobalAccessRuleEnabled(racing, ACTOR, rule.id, false, {});
    expect(raced).toMatchObject({
      ok: false,
      reason: 'conflict',
      errors: ['Another change disabled a global access rule of this issuer. Reload the page.'],
    });
    expect((await getGlobalAccessRule(env.DB, rule.id))?.enabled).toBe(true);
    expect(await auditCount()).toBe(before);

    await env.DB.prepare('UPDATE access_rules SET enabled = 1 WHERE id = ?').bind(other.id).run();
    expect(await setGlobalAccessRuleEnabled(deps, ACTOR, rule.id, false, {})).toMatchObject({
      ok: true,
    });
  });
});

describe('deleteGlobalAccessRule', () => {
  it('needs confirm_widening for the last global rule of an issuer (AR-7)', async () => {
    const rule = await seedGlobalRule(deps, input());
    const before = await snapshot();
    const refused = await deleteGlobalAccessRule(deps, ACTOR, rule.id, {});
    expect(refused).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
      confirm: 'last_delete',
    });
    expect(await snapshot()).toEqual(before);
    expect(await deleteGlobalAccessRule(deps, ACTOR, rule.id, { confirm_widening: true })).toEqual({
      ok: true,
      last: true,
    });
    expect(await getGlobalAccessRule(env.DB, rule.id)).toBeNull();
    const audit = (await auditRows(rule.id)).at(-1);
    expect(audit).toMatchObject({
      action: 'global_access_rule.delete',
      summary: `Deleted global access rule acme only, the last one of ${GITHUB_ISSUER}: its credential access rules are no longer limited by a global access rule`,
    });
    expect(audit?.diff).toMatchObject({ ceiling: 'widening', before: { id: rule.id } });
  });

  it('deletes a non-last rule without confirmation; a concurrent delete makes it write nothing', async () => {
    const other = await seedGlobalRule(deps, input({ name: 'other' }));
    const rule = await seedGlobalRule(deps, input());
    const racing = racingDeps(deps, () =>
      env.DB.prepare('DELETE FROM access_rules WHERE id = ?').bind(other.id).run(),
    );
    const before = await auditCount();
    expect(await deleteGlobalAccessRule(racing, ACTOR, rule.id, {})).toMatchObject({
      ok: false,
      reason: 'conflict',
      errors: ['Another change removed a global access rule of this issuer. Reload the page.'],
    });
    expect(await getGlobalAccessRule(env.DB, rule.id)).not.toBeNull();
    expect(await auditCount()).toBe(before);

    const third = await seedGlobalRule(deps, input({ name: 'third' }));
    expect(await deleteGlobalAccessRule(deps, ACTOR, third.id, {})).toEqual({
      ok: true,
      last: false,
    });
    expect((await auditRows(third.id)).at(-1)).toMatchObject({
      summary: 'Deleted global access rule third',
      diff: { ceiling: 'tightening' },
    });
  });

  it('never deletes a credential access rule by its id', async () => {
    const rule = await seedCredentialRule(deps);
    expect(
      await deleteGlobalAccessRule(deps, ACTOR, rule.id, { confirm_widening: true }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('audit rows of global access rules (AR-16)', () => {
  it('never name a credential', async () => {
    const credentialRule = await seedCredentialRule(deps);
    const rule = await seedGlobalRule(deps, input());
    await updateGlobalAccessRule(deps, ACTOR, rule.id, { rules: READ_ONLY });
    await setGlobalAccessRuleEnabled(deps, ACTOR, rule.id, false, { confirm_last_disable: true });
    await deleteGlobalAccessRule(deps, ACTOR, rule.id, { confirm_widening: true });
    const rows = (await auditRows()).filter((row) => row.action.startsWith('global_access_rule.'));
    expect(rows.map((row) => row.action)).toEqual([
      'global_access_rule.create',
      'global_access_rule.update',
      'global_access_rule.disable',
      'global_access_rule.delete',
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(credentialRule.credential_id);
    expect(text).not.toContain(credentialRule.id);
    expect(text).not.toContain('credential_id');
  });
});
