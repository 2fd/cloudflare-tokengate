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
  it('no grant → 403 no_matching_grant', async () => {
    const fx = await setupProxy({ grant: false });
    const response = await fx.call('/a');
    expect(response.status).toBe(403);
    expect(errorOf(response)).toBe('no_matching_grant');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('a request outside the grant rules → 403', async () => {
    const fx = await setupProxy({ grant: { rules: [{ methods: ['GET'], path: '/read/**' }] } });
    expect((await fx.call('/read/x')).status).toBe(200);
    expect((await fx.call('/read/x', { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fx.call('/write/x')).status).toBe(403);
    expect(fx.upstreamCalls).toHaveLength(1);
  });

  it('disabling the grant denies the next request', async () => {
    const fx = await setupProxy();
    expect((await fx.call('/a')).status).toBe(200);
    await env.DB.prepare('UPDATE issuer_access_rules SET enabled = 0 WHERE id = ?')
      .bind(fx.grantId)
      .run();
    const response = await fx.call('/a');
    expect(response.status).toBe(403);
    expect(errorOf(response)).toBe('no_matching_grant');
  });

  it('an expired grant does not apply', async () => {
    const fx = await setupProxy({ grant: false });
    await fx.addIssuerAccessRule({ expiresAt: fx.clock.now() + 1000 });
    expect((await fx.call('/a')).status).toBe(200);
    fx.clock.advance(1000);
    expect((await fx.call('/a')).status).toBe(403);
  });

  it('disabling the service or the credential access rule is effective immediately', async () => {
    const fx = await setupProxy();
    expect((await fx.call('/a')).status).toBe(200);
    await env.DB.prepare('UPDATE credentials SET enabled = 0 WHERE id = ?')
      .bind(fx.serviceId)
      .run();
    expect((await fx.call('/a')).status).toBe(404);
    await env.DB.prepare('UPDATE credentials SET enabled = 1 WHERE id = ?')
      .bind(fx.serviceId)
      .run();
    await env.DB.prepare('UPDATE credential_access_rules SET enabled = 0 WHERE id = ?')
      .bind(fx.providerId)
      .run();
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('issuer_unknown');
    expect(fx.upstreamCalls).toHaveLength(1);
  });

  it('a grant for another service does not apply', async () => {
    const fx = await setupProxy({ grant: false });
    const other = await fx.addService({ slug: 'other' });
    await fx.addIssuerAccessRule({ serviceId: other.id });
    expect((await fx.call('/a', { slug: 'other' })).status).toBe(200);
    expect((await fx.call('/a')).status).toBe(403);
  });

  it('records the denial with the trace and verified caller', async () => {
    const fx = await setupProxy({ grant: { rules: [{ methods: ['GET'], path: '/read/**' }] } });
    await fx.call('/write/x');
    const [record] = await fx.records();
    expect(record).toMatchObject({
      outcome: 'denied',
      reason: 'no_matching_grant',
      status: 403,
      claims_verified: 1,
      grant_id: null,
      upstream_status: null,
    });
    expect(JSON.parse(record?.eval_trace ?? '[]')).toEqual([
      { grant_id: fx.grantId, result: 'no_rule', detail: 'no rule allows GET /write/x' },
    ]);
  });
});
