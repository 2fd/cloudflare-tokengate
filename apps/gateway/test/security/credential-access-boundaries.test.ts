import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { parseBoundaryFilters } from '../../src/admin/boundary-filters';
import { formatConditions } from '../../src/admin/grant-text';
import { updateCredentialAccessRule } from '../../src/admin/ops/credential-access-rules';
import {
  createIssuerAccessRule,
  setIssuerAccessRuleEnabled,
  updateIssuerAccessRule,
} from '../../src/admin/ops/issuer_access_rules';
import { conditionsWithin } from '../../src/policy/boundaries';
import type { Condition } from '../../src/policy/types';
import { setupProxy } from '../helpers/proxy-fixtures';
import { ACTOR, racingDeps } from '../unit/admin/ops/helpers';

const production: Condition = { claim: 'environment', match: 'exact', values: ['production'] };
const staging: Condition = { claim: 'environment', match: 'exact', values: ['staging'] };

describe('credential access boundaries', () => {
  it('round-trips boundary filters, including quoted claims and comma-containing values', () => {
    const conditions: Condition[] = [
      production,
      { claim: 'custom claim', match: 'exact', values: ['a,b', ' spaced '] },
      { claim: 'not', match: 'glob', values: ['sandbox*'], negate: true },
    ];
    expect(parseBoundaryFilters(formatConditions(conditions))).toEqual({ ok: true, conditions });
    expect(parseBoundaryFilters('environment regex production').ok).toBe(false);
  });
  it('requires every limit and refuses broader, missing, negated and ambiguous glob filters', () => {
    expect(conditionsWithin([production], [production])).toBe(true);
    for (const child of [
      [],
      [staging],
      [{ ...production, values: ['production', 'staging'] }],
      [{ ...production, negate: true }],
      [{ ...production, match: 'glob' as const, values: ['prod*'] }],
    ]) {
      expect(conditionsWithin(child, [production])).toBe(false);
    }
    expect(
      conditionsWithin([production], [{ ...production, match: 'glob', values: ['prod*'] }]),
    ).toBe(true);
    expect(conditionsWithin([production], [null as never])).toBe(false);
    expect(
      conditionsWithin(
        [{ ...production, negate: true, values: ['staging', 'staging'] }],
        [{ ...production, negate: true, values: ['staging', 'sandbox'] }],
      ),
    ).toBe(false);
  });

  it('rejects creation, editing and enabling outside the credential limits without an audit write', async () => {
    const fx = await setupProxy();
    await env.DB.prepare('UPDATE credential_access_rules SET conditions = ? WHERE id = ?')
      .bind(JSON.stringify([production]), fx.providerId)
      .run();
    const saved = await env.DB.prepare(
      'SELECT conditions, rules FROM issuer_access_rules WHERE id = ?',
    )
      .bind(fx.grantId)
      .first<{ conditions: string; rules: string }>();
    const conditions = JSON.parse(saved!.conditions) as Condition[];
    const count = async () =>
      (await env.DB.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>())!.n;
    const before = await count();
    const input = {
      name: 'Production',
      credential_access_rule_id: fx.providerId,
      service_id: fx.serviceId,
      conditions: [...conditions, staging],
      rules: JSON.parse(saved!.rules),
      acknowledge_warnings: true,
    };
    expect(await createIssuerAccessRule(fx.app.deps, ACTOR, input)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(
      await updateIssuerAccessRule(fx.app.deps, ACTOR, fx.grantId!, {
        conditions: input.conditions,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await setIssuerAccessRuleEnabled(fx.app.deps, ACTOR, fx.grantId!, true)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await count()).toBe(before);
    expect(
      await createIssuerAccessRule(fx.app.deps, ACTOR, {
        ...input,
        conditions: [...conditions, production],
      }),
    ).toMatchObject({ ok: true });
  });

  it('tightening a boundary revokes existing access on the next request, including direct database writes', async () => {
    const fx = await setupProxy();
    expect((await fx.call('/repos/acme/app')).status).toBe(200);
    const changed = await updateCredentialAccessRule(fx.app.deps, ACTOR, fx.providerId, {
      conditions: [production],
    });
    expect(changed.ok).toBe(true);
    expect(
      (await fx.call('/repos/acme/app', { token: await fx.token({ environment: 'production' }) }))
        .status,
    ).toBe(403);
    const stored = await env.DB.prepare('SELECT conditions FROM issuer_access_rules WHERE id = ?')
      .bind(fx.grantId)
      .first<{ conditions: string }>();
    await env.DB.prepare('UPDATE issuer_access_rules SET conditions = ? WHERE id = ?')
      .bind(JSON.stringify([...JSON.parse(stored!.conditions), production]), fx.grantId)
      .run();
    expect(
      (await fx.call('/repos/acme/app', { token: await fx.token({ environment: 'production' }) }))
        .status,
    ).toBe(200);
    expect(
      (await fx.call('/repos/acme/app', { token: await fx.token({ environment: 'staging' }) }))
        .status,
    ).toBe(403);
    expect((await fx.call('/repos/acme/app')).status).toBe(403);
    await env.DB.prepare('UPDATE credential_access_rules SET conditions = ? WHERE id = ?')
      .bind('null', fx.providerId)
      .run();
    expect(
      (await fx.call('/repos/acme/app', { token: await fx.token({ environment: 'production' }) }))
        .status,
    ).toBe(403);
  });

  it('does not let a boundary grant access by itself or authorize a different credential', async () => {
    const fx = await setupProxy({ grant: false });
    expect((await fx.call('/repos/acme/app')).status).toBe(403);
    const other = await fx.addService({ slug: 'other' });
    await expect(
      env.DB.prepare(`INSERT INTO issuer_access_rules
      (id, name, credential_access_rule_id, service_id, conditions, rules, created_at, updated_at)
      VALUES ('grt_cross', 'cross', ?, ?, '[]', '[]', 0, 0)`)
        .bind(fx.providerId, other.id)
        .run(),
    ).rejects.toThrow();
  });
  it('tries independent boundaries for the same issuer and never borrows another credential’s access', async () => {
    const fx = await setupProxy();
    await env.DB.prepare(`INSERT INTO credential_access_rules
      (id, credential_id, name, profile, issuer, jwks_uri, audience, allowed_algs,
       max_token_age_seconds, tenant_pin, anchor_claims, conditions, enabled, created_at, updated_at)
      SELECT 'cpr_second', credential_id, 'Production alternative', profile, issuer, jwks_uri, audience,
       allowed_algs, max_token_age_seconds, tenant_pin, anchor_claims, ?, 1, created_at + 1, updated_at
      FROM credential_access_rules WHERE id = ?`)
      .bind(JSON.stringify([production]), fx.providerId)
      .run();
    await env.DB.prepare('UPDATE credential_access_rules SET audience = ? WHERE id = ?')
      .bind('tokengate:another-audience', fx.providerId)
      .run();
    const saved = await env.DB.prepare('SELECT conditions FROM issuer_access_rules WHERE id = ?')
      .bind(fx.grantId)
      .first<{ conditions: string }>();
    await fx.addIssuerAccessRule({
      credentialAccessRuleId: 'cpr_second',
      conditions: [...JSON.parse(saved!.conditions), production],
    });
    expect(
      (await fx.call('/repos/acme/app', { token: await fx.token({ environment: 'production' }) }))
        .status,
    ).toBe(200);
    expect(
      (await fx.call('/repos/acme/app', { token: await fx.token({ environment: 'staging' }) }))
        .status,
    ).not.toBe(200);
    const other = await fx.addService({ slug: 'isolated' });
    expect(
      (
        await fx.call('/repos/acme/app', {
          slug: other.slug,
          token: await fx.token({ environment: 'production' }),
        })
      ).status,
    ).not.toBe(200);
  });

  it('refuses an access save if the boundary changes after validation', async () => {
    const fx = await setupProxy();
    const stored = await env.DB.prepare(
      'SELECT conditions, rules FROM issuer_access_rules WHERE id = ?',
    )
      .bind(fx.grantId)
      .first<{ conditions: string; rules: string }>();
    const racing = racingDeps(fx.app.deps, async () => {
      const updated = await updateCredentialAccessRule(fx.app.deps, ACTOR, fx.providerId, {
        conditions: [production],
      });
      expect(updated.ok).toBe(true);
    });
    const result = await createIssuerAccessRule(racing, ACTOR, {
      name: 'Raced access',
      credential_access_rule_id: fx.providerId,
      service_id: fx.serviceId,
      conditions: JSON.parse(stored!.conditions),
      rules: JSON.parse(stored!.rules),
      acknowledge_warnings: true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(
      await env.DB.prepare(
        "SELECT id FROM issuer_access_rules WHERE name = 'Raced access'",
      ).first(),
    ).toBeNull();
  });
});
