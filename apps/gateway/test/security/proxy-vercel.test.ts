// Vercel tokens at the proxy, as @vercel/oidc returns them (no jti): the team pin on the shared
// global issuer (I-TEN-1), the team and project anchor (I-AUTHZ-2), and environments other than
// production and preview only by explicit opt-in (I-AUTHZ-3).
import { describe, expect, it } from 'vitest';
import type { Condition } from '../../src/policy/types';
import {
  createTestIssuer,
  TEST_VERCEL_PROJECT_ID,
  TEST_VERCEL_TEAM_ID,
  type TestIssuer,
  vercelClaims,
} from '../helpers/jwt';
import { type ProxyFixture, setupProxy } from '../helpers/proxy-fixtures';

const errorOf = (response: Response) => response.headers.get('x-tokengate-error');

const ANCHOR: Condition[] = [
  { claim: 'owner_id', match: 'exact', values: [TEST_VERCEL_TEAM_ID] },
  { claim: 'project_id', match: 'exact', values: [TEST_VERCEL_PROJECT_ID] },
];

async function vercelProxy(conditions: Condition[] = ANCHOR): Promise<{
  fx: ProxyFixture;
  vercel: TestIssuer;
  call(claims?: Record<string, unknown>): Promise<Response>;
}> {
  let fx: ProxyFixture | null = null;
  const vercel = await createTestIssuer({
    issuer: 'https://oidc.vercel.com',
    now: () => fx?.clock.now() ?? Date.now(),
  });
  fx = await setupProxy({ rule: false, issuers: [vercel] });
  await fx.addRule({
    profile: 'vercel',
    issuer: vercel.issuer,
    jwksUri: vercel.jwksUri,
    maxTokenAgeSeconds: 7200,
    tenantPin: [{ claim: 'owner_id', match: 'exact', values: [TEST_VERCEL_TEAM_ID] }],
    conditions,
  });
  const ready = fx;
  return {
    fx: ready,
    vercel,
    call: async (claims = {}) =>
      ready.call('/a', { token: await vercel.sign(vercelClaims(claims)) }),
  };
}

describe('Vercel tokens (I-TEN-1, I-AUTHZ-2, I-AUTHZ-3)', () => {
  it('admits production and preview tokens of the pinned team and project, without a jti', async () => {
    const { fx, call } = await vercelProxy();
    expect((await call()).status).toBe(200);
    expect((await call({ environment: 'preview' })).status).toBe(200);
    expect(fx.upstreamCalls).toHaveLength(2);
  });

  it('refuses another team on the shared global issuer at the tenant gate', async () => {
    const { fx, call } = await vercelProxy();
    const response = await call({ owner_id: 'team_other0000000000000000000' });
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('tenant_mismatch');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('refuses another project of the same team', async () => {
    const { fx, call } = await vercelProxy();
    const response = await call({ project_id: 'prj_other00000000000000000000' });
    expect(response.status).toBe(403);
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('refuses development and Custom Environment tokens unless the rule opts in', async () => {
    const { fx, call } = await vercelProxy();
    for (const environment of ['development', 'staging']) {
      const response = await call({ environment });
      expect(response.status, environment).toBe(403);
      expect(errorOf(response), environment).toBe('event_not_trusted');
    }
    expect(fx.upstreamCalls).toHaveLength(0);
    const optIn = await vercelProxy([
      ...ANCHOR,
      { claim: 'environment', match: 'exact', values: ['development'] },
    ]);
    expect((await optIn.call({ environment: 'development' })).status).toBe(200);
  });

  it('refuses a token without project_id or environment (required claims)', async () => {
    const { fx, call } = await vercelProxy();
    for (const missing of ['project_id', 'environment']) {
      const response = await call({ [missing]: undefined });
      expect(response.status, missing).toBe(401);
    }
    expect(fx.upstreamCalls).toHaveLength(0);
  });
});
