// Credential types (ADR 0031): /proxy/<slug> names a type, every credential with that slug is a candidate,
// and the most specific credential access rule that matches decides which secret is injected. The SQL
// triggers keep one destination per type, so a secret never reaches another API.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Condition } from '../../src/policy/types';
import {
  DEFAULT_CONDITIONS,
  setupProxy,
  TEST_BASE_URL,
  TEST_SECRET,
} from '../helpers/proxy-fixtures';

const OTHER_SECRET = 'sk-test-OTHER-0123456789abcdefXYZ';
const MAIN_ONLY: Condition = { claim: 'ref', match: 'exact', values: ['refs/heads/main'] };
const RELEASE_ONLY: Condition = { claim: 'ref', match: 'exact', values: ['refs/heads/release'] };

const errorOf = (response: Response) => response.headers.get('x-tokengate-error');

/** A type `echo` with the fixture's credential (TEST_SECRET) and a second one (OTHER_SECRET). */
async function twoCredentials(options: { secondEnabled?: boolean } = {}) {
  const fx = await setupProxy({ rule: false });
  const second = await fx.addService({
    slug: fx.slug,
    secret: OTHER_SECRET,
    enabled: options.secondEnabled,
  });
  const injected = () => fx.upstreamCalls.at(-1)?.headers.get('authorization');
  return { fx, first: fx.serviceId, second: second.id, injected };
}

describe('ADR 0031: the most specific matching rule decides the credential of a type', () => {
  it('uses the credential of the rule with more identity conditions, whatever their age', async () => {
    const { fx, second, injected } = await twoCredentials();
    const start = fx.clock.now();
    await fx.addRule({ createdAt: start + 1 });
    const narrow = await fx.addRule({
      serviceId: second,
      conditions: [...DEFAULT_CONDITIONS, MAIN_ONLY],
      createdAt: start + 2,
    });
    expect((await fx.call('/a')).status).toBe(200);
    expect(injected()).toBe(`Bearer ${OTHER_SECRET}`);
    const [record] = await fx.records();
    expect(record).toMatchObject({ service_id: second, credential_access_rule_id: narrow });
  });

  it('falls back to a less specific rule of another credential when the narrow one does not match', async () => {
    const { fx, first, second, injected } = await twoCredentials();
    const broad = await fx.addRule({});
    await fx.addRule({ serviceId: second, conditions: [...DEFAULT_CONDITIONS, RELEASE_ONLY] });
    expect((await fx.call('/a')).status).toBe(200);
    expect(injected()).toBe(`Bearer ${TEST_SECRET}`);
    const [record] = await fx.records();
    expect(record).toMatchObject({ service_id: first, credential_access_rule_id: broad });
  });

  it('breaks a tie of specificity with the oldest rule, even when several match', async () => {
    const { fx, second, injected } = await twoCredentials();
    const start = fx.clock.now();
    await fx.addRule({ createdAt: start + 2 });
    const oldest = await fx.addRule({ serviceId: second, createdAt: start + 1 });
    expect((await fx.call('/a')).status).toBe(200);
    expect(injected()).toBe(`Bearer ${OTHER_SECRET}`);
    const [record] = await fx.records();
    expect(record?.credential_access_rule_id).toBe(oldest);
  });

  it('a rule whose operations refuse the request is skipped for the next one', async () => {
    const { fx, second, injected } = await twoCredentials();
    await fx.addRule({});
    await fx.addRule({
      serviceId: second,
      conditions: [...DEFAULT_CONDITIONS, MAIN_ONLY],
      rules: [{ methods: ['GET'], path: '/read/**' }],
    });
    expect((await fx.call('/write/x', { method: 'POST' })).status).toBe(200);
    expect(injected()).toBe(`Bearer ${TEST_SECRET}`);
    expect((await fx.call('/read/x')).status).toBe(200);
    expect(injected()).toBe(`Bearer ${OTHER_SECRET}`);
  });

  it('never uses a disabled credential of the type', async () => {
    const { fx, second, injected } = await twoCredentials({ secondEnabled: false });
    await fx.addRule({});
    await fx.addRule({ serviceId: second, conditions: [...DEFAULT_CONDITIONS, MAIN_ONLY] });
    expect((await fx.call('/a')).status).toBe(200);
    expect(injected()).toBe(`Bearer ${TEST_SECRET}`);
  });

  it('a caller whose only rule is on a disabled credential of an enabled type is refused', async () => {
    const { fx, second } = await twoCredentials({ secondEnabled: false });
    await fx.addRule({ serviceId: second });
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('issuer_unknown');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('a type whose credentials are all disabled answers 404 service_disabled after the pin', async () => {
    const fx = await setupProxy({ rule: false, service: { enabled: false } });
    const second = await fx.addService({ slug: fx.slug, enabled: false });
    await fx.addRule({ serviceId: second.id });
    const response = await fx.call('/a');
    expect(response.status).toBe(404);
    expect(errorOf(response)).toBe('service_not_found');
    const [record] = await fx.records();
    expect(record?.reason).toBe('service_disabled');
  });
});

describe('ADR 0031: one destination per credential type', () => {
  it('refuses a credential of the type with another base URL or injection', async () => {
    const fx = await setupProxy();
    await expect(
      fx.addService({ slug: fx.slug, baseUrl: 'https://elsewhere.test/v1' }),
    ).rejects.toThrow(/credential_type_mismatch/);
    await expect(
      fx.addService({ slug: fx.slug, injection: { kind: 'header', name: 'x-api-key' } }),
    ).rejects.toThrow(/credential_type_mismatch/);
    await fx.addService({ slug: fx.slug });
    await expect(
      env.DB.prepare("UPDATE credentials SET base_url = 'https://elsewhere.test/v1' WHERE id = ?")
        .bind(fx.serviceId)
        .run(),
    ).rejects.toThrow(/credential_type_mismatch/);
  });

  it('refuses a second slug for the destination of a type', async () => {
    const fx = await setupProxy();
    await expect(fx.addService({ slug: 'other', baseUrl: TEST_BASE_URL })).rejects.toThrow(
      /credential_type_mismatch/,
    );
    const other = await fx.addService({ slug: 'other', baseUrl: 'https://elsewhere.test/v1' });
    await expect(
      env.DB.prepare('UPDATE credentials SET base_url = ? WHERE id = ?')
        .bind(TEST_BASE_URL, other.id)
        .run(),
    ).rejects.toThrow(/credential_type_mismatch/);
  });

  it('keeps the slug of a credential fixed and caps a type at 8 credentials', async () => {
    const fx = await setupProxy();
    await expect(
      env.DB.prepare("UPDATE credentials SET slug = 'other' WHERE id = ?").bind(fx.serviceId).run(),
    ).rejects.toThrow(/immutable_row/);
    for (let i = 0; i < 7; i++) await fx.addService({ slug: fx.slug });
    await expect(fx.addService({ slug: fx.slug })).rejects.toThrow(/too_many_type_credentials/);
  });

  it('a credential alone in its type can still move to another destination', async () => {
    const fx = await setupProxy();
    await env.DB.prepare(
      "UPDATE credentials SET base_url = 'https://elsewhere.test/v1' WHERE id = ?",
    )
      .bind(fx.serviceId)
      .run();
  });
});
