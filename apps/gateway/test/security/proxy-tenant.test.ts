import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { setupProxy } from '../helpers/proxy-fixtures';

const errorOf = (response: Response) => response.headers.get('x-tokengate-error');

describe('I-TEN-1: tenant pin is enforced before the service is looked up', () => {
  it('a token from another GitHub owner gets 401 tenant_mismatch, for real and unknown slugs alike', async () => {
    const fx = await setupProxy();
    const outsider = await fx.token({ repository_owner_id: '999', repository_id: '1' });
    const real = await fx.call('/a', { token: outsider });
    const unknown = await fx.call('/a', { token: outsider, slug: 'does-not-exist' });
    for (const response of [real, unknown]) {
      expect(response.status).toBe(401);
      expect(errorOf(response)).toBe('tenant_mismatch');
    }
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('an empty tenant pin on the shared GitHub issuer fails closed', async () => {
    const fx = await setupProxy({ tenantPin: [] });
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('tenant_mismatch');
  });

  it('unknown and disabled slugs answer 401 to unverified callers and 404 only after verify + pin', async () => {
    const fx = await setupProxy();
    await fx.addService({ slug: 'disabled', enabled: false });
    for (const slug of ['does-not-exist', 'disabled']) {
      const noToken = await fx.call('/a', { slug, token: null });
      expect(noToken.status).toBe(401);
      const forged = await fx.call('/a', { slug, token: `${(await fx.token()).slice(0, -4)}AAAA` });
      expect(forged.status).toBe(401);
      const verified = await fx.call('/a', { slug });
      expect(verified.status).toBe(404);
      expect(errorOf(verified)).toBe('service_not_found');
    }
    const reasons = (await fx.records())
      .filter((r) => r.status === 404)
      .map((r) => r.reason)
      .sort();
    expect(reasons).toEqual(['service_disabled', 'service_not_found']);
  });
});

describe('I-AUTHZ-1: deny by default; revocation is effective on the next request', () => {
  it('no credential access rule for the issuer → 401 issuer_unknown', async () => {
    const fx = await setupProxy({ rule: false });
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('issuer_unknown');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('a request outside the rule operations → 403 no_matching_rule', async () => {
    const fx = await setupProxy({ rule: { rules: [{ methods: ['GET'], path: '/read/**' }] } });
    expect((await fx.call('/read/x')).status).toBe(200);
    const post = await fx.call('/read/x', { method: 'POST', body: '{}' });
    expect(post.status).toBe(403);
    expect(errorOf(post)).toBe('no_matching_rule');
    expect((await fx.call('/write/x')).status).toBe(403);
    expect(fx.upstreamCalls).toHaveLength(1);
  });

  it('disabling the credential access rule denies the next request', async () => {
    const fx = await setupProxy();
    expect((await fx.call('/a')).status).toBe(200);
    await env.DB.prepare('UPDATE access_rules SET enabled = 0 WHERE id = ?').bind(fx.ruleId).run();
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('issuer_unknown');
    expect(fx.upstreamCalls).toHaveLength(1);
  });

  it('an expired credential access rule does not apply', async () => {
    const fx = await setupProxy({ rule: false });
    await fx.addRule({ expiresAt: fx.clock.now() + 1000 });
    expect((await fx.call('/a')).status).toBe(200);
    fx.clock.advance(1000);
    expect((await fx.call('/a')).status).toBe(401);
    expect(fx.upstreamCalls).toHaveLength(1);
  });

  it('disabling the credential is effective immediately', async () => {
    const fx = await setupProxy();
    expect((await fx.call('/a')).status).toBe(200);
    await env.DB.prepare('UPDATE credentials SET enabled = 0 WHERE id = ?')
      .bind(fx.serviceId)
      .run();
    const response = await fx.call('/a');
    expect(response.status).toBe(404);
    expect(errorOf(response)).toBe('service_not_found');
    expect(fx.upstreamCalls).toHaveLength(1);
  });

  it('a credential access rule of another credential does not apply', async () => {
    const fx = await setupProxy({ rule: false });
    const other = await fx.addService({ slug: 'other' });
    await fx.addRule({ serviceId: other.id });
    expect((await fx.call('/a', { slug: 'other' })).status).toBe(200);
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('issuer_unknown');
  });

  it('records the denial with the trace and verified caller', async () => {
    const fx = await setupProxy({ rule: { rules: [{ methods: ['GET'], path: '/read/**' }] } });
    await fx.call('/write/x');
    const [record] = await fx.records();
    expect(record).toMatchObject({
      outcome: 'denied',
      reason: 'no_matching_rule',
      status: 403,
      claims_verified: 1,
      credential_access_rule_id: fx.ruleId,
      global_access_rule_id: null,
      upstream_status: null,
    });
    expect(JSON.parse(record?.eval_trace ?? '[]')).toEqual([
      { rule_id: fx.ruleId, result: 'no_rule', detail: 'no rule allows GET /write/x' },
    ]);
  });
});

describe('AR-14: the most advanced refusal stage wins across candidates', () => {
  const otherAudience = 'tokengate:01JTOTHERAUD1ENCE00000000000';

  it('a policy refusal of an older rule beats the audience refusal of a newer rule', async () => {
    const fx = await setupProxy({ rule: { rules: [{ methods: ['GET'], path: '/read/**' }] } });
    await fx.addRule({ audience: otherAudience });
    const response = await fx.call('/write/x');
    expect(response.status).toBe(403);
    expect(errorOf(response)).toBe('no_matching_rule');
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain(otherAudience);
  });

  it('a tenant refusal beats a verification refusal, whatever the order', async () => {
    const fx = await setupProxy({ rule: { audience: otherAudience } });
    await fx.addRule({
      tenantPin: [{ claim: 'repository_owner_id', match: 'exact', values: ['1'] }],
    });
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('tenant_mismatch');
  });

  it('within one stage the first candidate in (created_at, id) order gives the refusal', async () => {
    const fx = await setupProxy({ rule: { audience: otherAudience } });
    await fx.addRule({ audience: 'tokengate:01JTTHIRDAUD1ENCE00000000000' });
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('audience_mismatch');
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain(otherAudience);
  });

  it('a later rule that allows the request wins over earlier refusals', async () => {
    const fx = await setupProxy({ rule: { audience: otherAudience } });
    await fx.addRule({ rules: [{ methods: ['GET'], path: '/read/**' }] });
    const allowedId = await fx.addRule({});
    expect((await fx.call('/write/x')).status).toBe(200);
    const [record] = await fx.records();
    expect(record?.credential_access_rule_id).toBe(allowedId);
  });
});

describe('AR-11: bounded candidates for unknown and disabled slugs (I-TEN-1)', () => {
  const outsiderPin = [{ claim: 'repository_owner_id', match: 'exact' as const, values: ['1'] }];

  /** 70 rules of another credential that trust the issuer but whose own pin excludes the caller. */
  async function seedOtherRules(
    fx: Awaited<ReturnType<typeof setupProxy>>,
    start: number,
  ): Promise<string> {
    const other = await fx.addService({ slug: 'other' });
    for (let i = 0; i < 70; i++) {
      await fx.addRule({ serviceId: other.id, tenantPin: outsiderPin, createdAt: start + i });
    }
    return other.id;
  }

  it('an unknown slug reads at most 64 rules of other credentials, oldest first', async () => {
    const fx = await setupProxy({ rule: false });
    const start = fx.clock.now();
    const otherId = await seedOtherRules(fx, start);
    // Row 71: the only rule whose own pin admits the caller is past the bound.
    await fx.addRule({ serviceId: otherId, createdAt: start + 100 });
    const late = await fx.call('/a', { slug: 'does-not-exist' });
    expect(late.status).toBe(401);
    expect(errorOf(late)).toBe('tenant_mismatch');
    // An admitting rule within the bound gives 404, as for every insider.
    const third = await fx.addService({ slug: 'third' });
    await fx.addRule({ serviceId: third.id, createdAt: start - 1 });
    const early = await fx.call('/a', { slug: 'does-not-exist' });
    expect(early.status).toBe(404);
    expect(errorOf(early)).toBe('service_not_found');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('a disabled slug still finds its own rule when that rule is the newest', async () => {
    const fx = await setupProxy({ rule: false });
    const start = fx.clock.now();
    await seedOtherRules(fx, start);
    const disabled = await fx.addService({ slug: 'disabled', enabled: false });
    await fx.addRule({ serviceId: disabled.id, createdAt: start + 1000 });
    const response = await fx.call('/a', { slug: 'disabled' });
    expect(response.status).toBe(404);
    expect(errorOf(response)).toBe('service_not_found');
    const [record] = await fx.records();
    expect(record?.reason).toBe('service_disabled');
  });
});
