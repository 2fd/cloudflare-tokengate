// Proxy query budget (docs/architecture.md, "Query budget"; I-AUTHZ-1, AR-10, AR-11): one D1 batch of
// 5 indexed, bounded statements per request, and at most MAX_JWKS_URIS JWKS lookups and
// MAX_VERIFY_GROUPS signature checks. The rows are written by SQL, around validation, to reach the
// caps of the triggers.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANDIDATE_RULES_SQL, GLOBAL_RULES_SQL } from '../../src/db/proxy-context';
import { MAX_JWKS_URIS, MAX_VERIFY_GROUPS } from '../../src/proxy/handler';
import { GITHUB_ISSUER } from '../helpers/jwt';
import { type ProxyFixture, setupProxy } from '../helpers/proxy-fixtures';

afterEach(() => {
  vi.restoreAllMocks();
});

const errorOf = (response: Response) => response.headers.get('x-tokengate-error');

interface DbLog {
  prepared: number;
  batches: Array<{ statements: number; rows: number[]; rowsRead: number[] }>;
}

/** Wraps the app's control-plane database and records every statement and batch it runs. */
function recordDb(fx: ProxyFixture): DbLog {
  const log: DbLog = { prepared: 0, batches: [] };
  const real = fx.app.deps.env.DB;
  fx.app.deps.env.DB = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          log.prepared++;
          return target.prepare(sql);
        };
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          log.batches.push({
            statements: statements.length,
            rows: results.map((result) => result.results.length),
            rowsRead: results.map((result) => result.meta.rows_read),
          });
          return results;
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return log;
}

/** The one batch of a request: exactly 5 statements, and nothing outside it. */
function onlyBatch(log: DbLog) {
  expect(log.batches).toHaveLength(1);
  expect(log.prepared).toBe(5);
  const [batch] = log.batches;
  expect(batch?.statements).toBe(5);
  return batch as DbLog['batches'][number];
}

const RULE_COLUMNS = `id, credential_id, name, profile, issuer, issuer_key, jwks_uri, audience, allowed_algs,
  max_token_age_seconds, tenant_pin, anchor_claims, conditions, rules, enabled, expires_at, created_at, updated_at`;

/** `count` copies of the credential access rule `sourceId` on its credential (`acr_<tag>0001`, …). */
async function copyRule(sourceId: string, count: number, tag = 'bulk'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO access_rules (${RULE_COLUMNS})
     WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     SELECT 'acr_' || ?3 || printf('%04d', i), credential_id, ?3 || ' ' || i, profile, issuer, issuer_key,
       jwks_uri, audience, allowed_algs, max_token_age_seconds, tenant_pin, anchor_claims, conditions,
       rules, enabled, expires_at, created_at + i, updated_at
     FROM n, access_rules WHERE id = ?1`,
  )
    .bind(sourceId, count, tag)
    .run();
}

/** One generic credential access rule on `credentialId` for each of `count` other issuers. */
async function otherIssuerRules(credentialId: string, count: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO access_rules (${RULE_COLUMNS})
     WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     SELECT 'acr_idp' || printf('%04d', i), ?1, 'idp ' || i, 'generic',
       'https://idp' || i || '.example', 'https://idp' || i || '.example',
       'https://idp' || i || '.example/jwks', 'tokengate:01JTESTAUD1ENCE0000000000000', '["RS256"]',
       600, '[]', '["sub"]', '[{"claim":"sub","match":"exact","values":["ci"]}]',
       '[{"methods":["GET"],"path":"/**"}]', 1, NULL, i, i
     FROM n`,
  )
    .bind(credentialId, count)
    .run();
}

/** `perIssuer` global access rules with no limit for every issuer key that a rule of the credential trusts. */
async function globalsForEveryIssuer(credentialId: string, perIssuer: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO access_rules (${RULE_COLUMNS})
     WITH RECURSIVE m(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM m WHERE j < ?2),
       issuers AS (SELECT DISTINCT profile, issuer, issuer_key FROM access_rules WHERE credential_id = ?1)
     SELECT 'gar_' || hex(randomblob(8)), NULL, issuer_key || ' ' || j, profile, issuer, issuer_key,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, j, j
     FROM issuers, m`,
  )
    .bind(credentialId, perIssuer)
    .run();
}

async function count(where: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM access_rules WHERE ${where}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe('I-AUTHZ-1: one batch of 5 bounded statements per request', () => {
  it('100 credential access rules on the credential', async () => {
    const fx = await setupProxy();
    await copyRule(fx.ruleId as string, 99);
    expect(await count('credential_id IS NOT NULL')).toBe(100);
    const log = recordDb(fx);
    expect((await fx.call('/a')).status).toBe(200);
    await fx.records();
    const batch = onlyBatch(log);
    // (2a): the credential's rules through access_rules_credential; (3a): no global row.
    expect(batch.rows[1]).toBe(100);
    expect(batch.rowsRead[1]).toBeLessThanOrEqual(2 * 100 + 10);
    expect(batch.rows[2]).toBe(0);
    expect(batch.rowsRead[2]).toBeLessThanOrEqual(5);
  });

  it('a credential whose rules trust 100 issuers, each with 20 global access rules', async () => {
    const fx = await setupProxy({
      service: { injection: { kind: 'header', name: 'x-api-key' } },
    });
    await otherIssuerRules(fx.serviceId, 99);
    await globalsForEveryIssuer(fx.serviceId, 20);
    expect(await count('credential_id IS NULL')).toBe(2000);

    // Standard-header token: (3a) reads the 20 rows of the token's issuer key only.
    const standard = recordDb(fx);
    expect((await fx.call('/a')).status).toBe(200);
    await fx.records();
    const first = onlyBatch(standard);
    expect(first.rows[2]).toBe(20);
    expect(first.rowsRead[2]).toBeLessThanOrEqual(2 * 20 + 5);

    // Injection-header token: (3b) reads every key that the credential's rules trust.
    const injected = recordDb(fx);
    const response = await fx.call('/a', {
      token: null,
      headers: { 'x-api-key': await fx.token() },
    });
    expect(response.status).toBe(200);
    await fx.records();
    const second = onlyBatch(injected);
    expect(second.rows[2]).toBe(2000);
    // The 2,000 global rows plus the key lookups over the credential's 100 rules.
    expect(second.rowsRead[2]).toBeLessThanOrEqual(2000 + 4 * 100);
  });

  it('an unknown slug with 200 rules of other credentials reads at most 64 of them', async () => {
    const fx = await setupProxy({ rule: false });
    const first = await fx.addService({ slug: 'first' });
    const second = await fx.addService({ slug: 'second' });
    const outsiderPin = [{ claim: 'repository_owner_id', match: 'exact' as const, values: ['1'] }];
    const a = await fx.addRule({ serviceId: first.id, tenantPin: outsiderPin });
    const b = await fx.addRule({ serviceId: second.id, tenantPin: outsiderPin });
    await copyRule(a, 99, 'bulka');
    await copyRule(b, 99, 'bulkb');
    expect(await count('credential_id IS NOT NULL')).toBe(200);
    const log = recordDb(fx);
    const response = await fx.call('/a', { slug: 'does-not-exist' });
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('tenant_mismatch');
    await fx.records();
    const batch = onlyBatch(log);
    expect(batch.rows[1]).toBe(64);
    expect(batch.rowsRead[1]).toBeLessThanOrEqual(64 + 10);
  });
});

describe('I-AUTHZ-1: query plans use the access rule indexes', () => {
  async function plan(sql: string, binds: unknown[]): Promise<string[]> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<{ detail: string }>();
    return results.map((row) => row.detail);
  }

  /** Every step that reads access_rules uses an index; none scans the table. */
  function expectIndexed(details: string[]): void {
    for (const detail of details) {
      expect(detail, detail).not.toMatch(/^SCAN (r|g|access_rules)$/);
      expect(detail, detail).not.toMatch(/^SCAN (r|g|access_rules) USING (?!.*INDEX)/);
    }
  }

  it('(2) candidate credential access rules', async () => {
    const details = await plan(CANDIDATE_RULES_SQL, ['echo', 0, GITHUB_ISSUER]);
    expectIndexed(details);
    const text = details.join('\n');
    expect(text).toContain('access_rules_credential (credential_id=?)');
    expect(text).toContain('access_rules_issuer');
  });

  it('(3) global access rules', async () => {
    const details = await plan(GLOBAL_RULES_SQL, ['echo', 0, GITHUB_ISSUER, 1]);
    expectIndexed(details);
    expect(details.join('\n')).toContain(
      'access_rules_credential (credential_id=? AND issuer_key=?)',
    );
  });
});

describe('AR-10: JWKS lookups and signature checks per request are bounded', () => {
  /**
   * An unknown slug whose candidates span 10 credentials: 10 verification groups over 5 JWKS URIs
   * (rule i: URI k(i mod 5), its own audience). Rows like these exist only around validation.
   */
  async function spread(fx: ProxyFixture, audienceOf: (i: number) => string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const credential = await fx.addService({ slug: `spread-${i}` });
      await fx.addRule({
        serviceId: credential.id,
        jwksUri: `${fx.issuer.issuer}/k${i % 5}/jwks`,
        audience: audienceOf(i),
      });
    }
  }

  const jwksUrls = (fx: ProxyFixture) =>
    new Set(fx.issuer.requests.filter((url) => url.endsWith('/jwks')));

  it(`a token with an unknown kid fetches no more than ${MAX_JWKS_URIS} JWKS URIs`, async () => {
    const fx = await setupProxy({ rule: false });
    await spread(fx, (i) => `tokengate:01JTESTAUD1ENCE00000000000${String(i).padStart(2, '0')}`);
    const token = await fx.issuer.sign({ sub: 'x', aud: 'x' }, { kid: 'unknown-kid' });
    const response = await fx.call('/a', { slug: 'does-not-exist', token });
    expect(response.status).toBe(401);
    expect(jwksUrls(fx).size).toBe(MAX_JWKS_URIS);
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it(`at most ${MAX_VERIFY_GROUPS} groups are verified; a candidate past the bound is refused`, async () => {
    const fx = await setupProxy({ rule: false });
    // Rule 9 (URI k4, the fifth URI) is the only one whose audience the token has: without the
    // bound it would verify, pass its own tenant pin and answer 404 service_not_found.
    const token = await fx.token();
    const audience = JSON.parse(atob(token.split('.')[1] as string)).aud as string;
    await spread(fx, (i) =>
      i === 9 ? audience : `tokengate:01JTOTHERAUD1ENCE000000000${String(i).padStart(2, '0')}`,
    );
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const response = await fx.call('/a', { slug: 'does-not-exist', token });
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('audience_mismatch');
    expect(verify.mock.calls).toHaveLength(MAX_VERIFY_GROUPS);
    expect(jwksUrls(fx).size).toBe(MAX_JWKS_URIS);
  });
});
