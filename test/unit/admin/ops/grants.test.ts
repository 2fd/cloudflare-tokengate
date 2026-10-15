import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createGrant,
  deleteGrant,
  duplicateGrant,
  setGrantEnabled,
  updateGrant,
} from '../../../../src/admin/ops/grants';
import { getGrant, insertGrantStatement } from '../../../../src/db/grants';
import type { CallerProvider } from '../../../../src/db/types';
import {
  ACTOR,
  anchoredConditions,
  auditCount,
  auditRows,
  OWNER_ID,
  opsDeps,
  resetControlPlane,
  seedGithubProvider,
  seedGrant,
  seedService,
} from './helpers';

const RULES = [{ methods: ['GET' as const], path: '/repos/**' }];
const BRANCH_GLOB = { claim: 'ref', match: 'glob' as const, values: ['refs/heads/*'] };

let deps: ReturnType<typeof opsDeps>;
let provider: CallerProvider;
let serviceId: string;

beforeEach(async () => {
  await resetControlPlane();
  deps = opsDeps();
  provider = await seedGithubProvider(deps);
  serviceId = await seedService(deps);
});

describe('createGrant', () => {
  it('stores a valid grant with normalized conditions and one audit row', async () => {
    const result = await createGrant(deps, ACTOR, {
      name: ' deploy ',
      caller_provider_id: provider.id,
      service_id: serviceId,
      conditions: [
        ...anchoredConditions(),
        { claim: 'event_name', match: 'exact', values: ['push'], negate: false },
      ],
      rules: [{ methods: ['GET'], path: '/repos/**', extra: 1 } as never],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await getGrant(env.DB, result.grant.id);
    expect(stored).toEqual(result.grant);
    expect(stored).toMatchObject({
      name: 'deploy',
      enabled: true,
      created_by: ACTOR.email,
      rules: [{ methods: ['GET'], path: '/repos/**' }],
    });
    expect(stored?.conditions[2]).toEqual({
      claim: 'event_name',
      match: 'exact',
      values: ['push'],
    });
    const audits = await auditRows(result.grant.id);
    expect(audits.map((a) => a.action)).toEqual(['grant.create']);
  });

  it('rejects a grant without anchor conditions (I-AUTHZ-2)', async () => {
    const before = await auditCount();
    const result = await createGrant(deps, ACTOR, {
      name: 'too broad',
      caller_provider_id: provider.id,
      service_id: serviceId,
      conditions: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
      rules: RULES,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/I-AUTHZ-2/);
    expect(await auditCount()).toBe(before);
  });

  it('rejects owner IDs outside the tenant pin', async () => {
    const result = await createGrant(deps, ACTOR, {
      name: 'other org',
      caller_provider_id: provider.id,
      service_id: serviceId,
      conditions: [
        { claim: 'repository_owner_id', match: 'exact', values: ['9999'] },
        { claim: 'repository_id', match: 'exact', values: ['1'] },
      ],
      rules: RULES,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('requires acknowledgement of warnings and records them in the audit row', async () => {
    const input = {
      name: 'branches',
      caller_provider_id: provider.id,
      service_id: serviceId,
      conditions: [...anchoredConditions(), BRANCH_GLOB],
      rules: RULES,
    };
    const first = await createGrant(deps, ACTOR, input);
    expect(first).toMatchObject({ ok: false, reason: 'acknowledgement_required' });
    if (first.ok) return;
    expect(first.warnings.join()).toMatch(/ref_protected/);

    const second = await createGrant(deps, ACTOR, { ...input, acknowledge_warnings: true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const [audit] = await auditRows(second.grant.id);
    expect(audit?.diff?.warnings).toEqual(first.warnings);
  });

  it('requires acknowledgement for methods other than POST on a path-injection service', async () => {
    const webhookId = await seedService(deps, {
      slug: 'discord-webhook',
      name: 'Discord webhook',
      base_url: 'https://discord.com/api/webhooks',
      injection: { kind: 'path' },
      forward_headers: [],
    });
    const input = {
      name: 'notify',
      caller_provider_id: provider.id,
      service_id: webhookId,
      conditions: anchoredConditions(),
    };
    for (const methods of [['GET'], ['*'], ['POST', 'PATCH']] as const) {
      const result = await createGrant(deps, ACTOR, {
        ...input,
        rules: [{ methods: [...methods], path: '/' }],
      });
      expect(result, methods.join()).toMatchObject({
        ok: false,
        reason: 'acknowledgement_required',
      });
      if (result.ok) return;
      expect(result.warnings.join()).toMatch(/URL path.*allow only POST/);
    }
    const before = await auditCount();
    const post = await createGrant(deps, ACTOR, {
      ...input,
      rules: [{ methods: ['POST'], path: '/' }],
    });
    expect(post).toMatchObject({ ok: true, warnings: [] });
    expect(await auditCount()).toBe(before + 1);

    // Bearer services are not affected.
    const bearer = await createGrant(deps, ACTOR, {
      ...input,
      service_id: serviceId,
      rules: RULES,
    });
    expect(bearer).toMatchObject({ ok: true, warnings: [] });
  });

  it('rejects unknown references, bad names and past expiry', async () => {
    const result = await createGrant(deps, ACTOR, {
      name: '',
      caller_provider_id: 'cpr_missing',
      service_id: 'svc_missing',
      conditions: anchoredConditions(),
      rules: RULES,
      expires_at: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'caller provider not found',
        'service not found',
        'name is required',
        'expiry must be in the future',
      ]),
    );
  });
});

describe('updateGrant', () => {
  it('updates content, re-validates, and audits changed fields', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId);
    const result = await updateGrant(deps, ACTOR, grant.id, {
      rules: [{ methods: ['GET', 'POST'], path: '/repos/**' }],
    });
    expect(result.ok).toBe(true);
    const audit = (await auditRows(grant.id)).at(-1);
    expect(audit?.action).toBe('grant.update');
    expect(audit?.diff).toEqual({
      before: { rules: RULES },
      after: { rules: [{ methods: ['GET', 'POST'], path: '/repos/**' }] },
      warnings: [],
    });
  });

  it('cannot move a grant to another caller provider or service', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId);
    const result = await updateGrant(deps, ACTOR, grant.id, {
      service_id: 'svc_other',
    } as never);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses a save from a form opened at an older version', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId);
    const first = await updateGrant(deps, ACTOR, grant.id, {
      name: 'first',
      expected_updated_at: grant.updated_at,
    });
    expect(first.ok).toBe(true);
    const before = await auditCount();
    const stale = await updateGrant(deps, ACTOR, grant.id, {
      name: 'second',
      expected_updated_at: grant.updated_at,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
    if (stale.ok) return;
    expect(stale.errors.join()).toContain('changed by someone else since you opened this page');
    expect((await getGrant(env.DB, grant.id))?.name).toBe('first');
    expect(await auditCount()).toBe(before);
  });

  it('refuses invalid content without writing', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId);
    const before = await auditCount();
    const result = await updateGrant(deps, ACTOR, grant.id, { conditions: [] });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await getGrant(env.DB, grant.id)).toEqual(grant);
    expect(await auditCount()).toBe(before);
  });
});

describe('setGrantEnabled', () => {
  it('always disables, even when the grant no longer validates', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId);
    // Narrow the tenant pin outside the ops (they refuse it while the grant is enabled), so the
    // existing grant's owner ID falls outside it.
    await env.DB.prepare(
      `UPDATE caller_providers SET tenant_pin = '[{"claim":"repository_owner_id","match":"exact","values":["1"]}]',
         updated_at = updated_at + 1 WHERE id = ?`,
    )
      .bind(provider.id)
      .run();

    const disabled = await updateGrant(deps, ACTOR, grant.id, { enabled: false });
    expect(disabled.ok).toBe(true);
    expect((await getGrant(env.DB, grant.id))?.enabled).toBe(false);
    expect((await auditRows(grant.id)).at(-1)?.action).toBe('grant.disable');

    const enabled = await setGrantEnabled(deps, ACTOR, grant.id, true);
    expect(enabled).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getGrant(env.DB, grant.id))?.enabled).toBe(false);
  });

  it('enables a valid grant', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId);
    await setGrantEnabled(deps, ACTOR, grant.id, false);
    const result = await setGrantEnabled(deps, ACTOR, grant.id, true);
    expect(result.ok).toBe(true);
    expect((await auditRows(grant.id)).at(-1)?.action).toBe('grant.enable');
  });
});

describe('duplicateGrant', () => {
  it('creates an enabled copy referencing the source', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId, 'deploy');
    const result = await duplicateGrant(deps, ACTOR, grant.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant).toMatchObject({
      name: 'deploy (copy)',
      enabled: true,
      conditions: grant.conditions,
      rules: grant.rules,
    });
    expect(result.grant.id).not.toBe(grant.id);
    const [audit] = await auditRows(result.grant.id);
    expect(audit).toMatchObject({ action: 'grant.duplicate' });
    expect(audit?.diff?.source_id).toBe(grant.id);
  });

  it('copies to another repository with its label, validated against the target', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId, 'deploy');
    const result = await duplicateGrant(deps, ACTOR, grant.id, {
      conditions: [
        { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] },
        { claim: 'repository_id', match: 'exact', values: ['111'] },
      ],
      labels: [{ claim: 'repository_id', value: '111', label: 'acme/web' }],
      name: 'GitHub for acme/web (any ref)',
    });
    expect(result.ok).toBe(true);
    const labels = await env.DB.prepare(
      "SELECT label FROM claim_labels WHERE claim = 'repository_id' AND value = '111'",
    ).all<{ label: string }>();
    expect(labels.results).toEqual([{ label: 'acme/web' }]);
  });

  it('refuses a copy whose warnings nobody accepted, writing nothing', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId, 'deploy');
    const before = (await auditRows()).length;
    const result = await duplicateGrant(deps, ACTOR, grant.id, {
      conditions: [
        ...grant.conditions,
        { claim: 'ref', match: 'glob', values: ['refs/heads/main'] },
      ],
    });
    expect(result).toMatchObject({ ok: false, reason: 'acknowledgement_required' });
    expect(await auditRows()).toHaveLength(before);
  });
});

describe('deleteGrant', () => {
  it('deletes with the full grant in the audit row', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId);
    expect(await deleteGrant(deps, ACTOR, grant.id)).toEqual({ ok: true });
    expect(await getGrant(env.DB, grant.id)).toBeNull();
    expect((await auditRows(grant.id)).at(-1)?.diff?.before).toEqual(grant);
    expect(await deleteGrant(deps, ACTOR, grant.id)).toMatchObject({ reason: 'not_found' });
  });
});

describe('guarded insert', () => {
  it('writes nothing when the guard does not hold', async () => {
    const statement = insertGrantStatement(
      env.DB,
      {
        id: 'grt_guarded',
        name: 'n',
        description: '',
        caller_provider_id: provider.id,
        service_id: serviceId,
        conditions: anchoredConditions(),
        rules: RULES,
        enabled: true,
        expires_at: null,
        created_by: null,
        created_at: 1,
      },
      {
        sql: 'EXISTS (SELECT 1 FROM caller_providers WHERE id = ? AND updated_at = ?)',
        binds: [provider.id, -1],
      },
    );
    const result = await statement.run();
    expect(result.meta.changes).toBe(0);
    expect(await getGrant(env.DB, 'grt_guarded')).toBeNull();
  });
});

describe('labels, accepted risks and in-memory consumers', () => {
  const labelRows = async () =>
    (
      await env.DB.prepare(
        'SELECT claim, value, label, updated_by FROM claim_labels ORDER BY claim, value',
      ).all()
    ).results;

  it('writes the typed labels in the create batch and records them and the risks in the audit', async () => {
    const result = await createGrant(deps, ACTOR, {
      name: 'labelled',
      caller_provider_id: provider.id,
      service_id: serviceId,
      conditions: anchoredConditions(),
      rules: RULES,
      labels: [{ claim: 'repository_id', value: '987654321', label: 'acme/api' }],
      accepted_risks: ['unprotected_ref'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await labelRows()).toEqual([
      { claim: 'repository_id', value: '987654321', label: 'acme/api', updated_by: ACTOR.id },
    ]);
    const [audit] = await auditRows(result.grant.id);
    expect(audit?.diff).toMatchObject({
      accepted_risks: ['unprotected_ref'],
      labels: {
        before: { 'repository_id:987654321': null },
        after: { 'repository_id:987654321': 'acme/api' },
      },
    });
  });

  it('a save that only changes a label is one grant.update with the label diff', async () => {
    const grant = await seedGrant(deps, provider.id, serviceId);
    const label = { claim: 'repository_id' as const, value: '987654321', label: 'acme/api' };
    expect((await updateGrant(deps, ACTOR, grant.id, { labels: [label] })).ok).toBe(true);
    const renamed = await updateGrant(deps, ACTOR, grant.id, {
      labels: [{ ...label, label: 'acme/api-renamed' }],
    });
    expect(renamed).toMatchObject({ ok: true, changed: true, labelsChanged: true });
    const unchanged = await updateGrant(deps, ACTOR, grant.id, {
      labels: [{ ...label, label: 'acme/api-renamed' }],
    });
    expect(unchanged).toMatchObject({ ok: true, changed: false });
    const rows = (await auditRows(grant.id)).map((row) => row.action);
    expect(rows).toEqual(['grant.create', 'grant.update', 'grant.update']);
  });

  it('refuses labels that are not numeric IDs of a labelled claim', async () => {
    const result = await createGrant(deps, ACTOR, {
      name: 'bad label',
      caller_provider_id: provider.id,
      service_id: serviceId,
      conditions: anchoredConditions(),
      rules: RULES,
      labels: [{ claim: 'repository_id', value: 'acme', label: 'acme/api' }],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await labelRows()).toEqual([]);
  });

  it('checkGrant validates against an in-memory consumer without reading or writing it', async () => {
    const { checkGrant } = await import('../../../../src/admin/ops/grants');
    const pending: CallerProvider = {
      ...provider,
      id: 'cpr_new',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['555'] }],
    };
    const values = {
      name: 'x',
      description: '',
      conditions: [
        { claim: 'repository_owner_id', match: 'exact' as const, values: ['555'] },
        { claim: 'repository_id', match: 'exact' as const, values: ['1'] },
      ],
      rules: RULES,
      enabled: true,
      expires_at: null,
    };
    const ok = await checkGrant(deps, 'cpr_new', serviceId, values, {
      expiryChanged: false,
      acknowledged: true,
      provider: pending,
    });
    expect(ok.ok).toBe(true);
    // The stored consumer pins another organization, so the same values fail against it.
    const stored = await checkGrant(deps, provider.id, serviceId, values, {
      expiryChanged: false,
      acknowledged: true,
    });
    expect(stored.ok).toBe(false);
  });
});
