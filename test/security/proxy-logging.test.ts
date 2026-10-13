import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveRecord, RequestRecord } from '../../src/telemetry/types';
import { setupProxy, TEST_SECRET } from '../helpers/proxy-fixtures';

const CANARY_CLAIM = 'canary-claim-value-7f3a';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Captures console output so tests can assert nothing sensitive is logged. */
function captureConsole(): () => string {
  const lines: unknown[][] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
  }
  return () => JSON.stringify(lines);
}

describe('I-LOG-1: no token or credential reaches any sink; only allowlisted claims are stored', () => {
  it('records, archive records and console output never contain the token or the credential', async () => {
    const archived: ArchiveRecord[] = [];
    const queued: RequestRecord[] = [];
    const fx = await setupProxy({
      service: { injection: { kind: 'query', param: 'key' } },
      env: {
        REQUEST_ARCHIVE: {
          send: async (records: ArchiveRecord[]) => void archived.push(...records),
        },
        REQUEST_LOG_QUEUE: {
          send: async (record: RequestRecord) => {
            queued.push(record);
            throw new Error(`queue down ${TEST_SECRET}`);
          },
        },
      } as never,
    });
    const logs = captureConsole();
    const token = await fx.token({ secret_claim: CANARY_CLAIM, user_email: 'dev@example.com' });
    const tokens = [token];

    expect((await fx.call('/ok?key=caller', { token })).status).toBe(200);
    fx.setUpstream(() => {
      throw new TypeError(`connect https://api.upstream.test/?key=${TEST_SECRET}`);
    });
    expect((await fx.call('/fail', { token })).status).toBe(502);
    const denied = await fx.token({
      event_name: 'pull_request_target',
      secret_claim: CANARY_CLAIM,
    });
    tokens.push(denied);
    expect((await fx.call('/denied', { token: denied })).status).toBe(403);

    const records = await fx.records();
    expect(records).toHaveLength(3);
    expect(archived).toHaveLength(3);
    const everything = JSON.stringify({ records, archived, queued, logs: logs() });
    for (const value of [...tokens, ...tokens.map((t) => t.split('.')[2]), TEST_SECRET]) {
      expect(everything).not.toContain(value);
    }
    expect(everything).not.toContain(CANARY_CLAIM);
    expect(everything).not.toContain('dev@example.com');
  });

  it('caller_claims holds only the profile allowlist', async () => {
    const fx = await setupProxy();
    const token = await fx.token({ secret_claim: CANARY_CLAIM, repository_visibility: 'private' });
    await fx.call('/a', { token });
    const [record] = await fx.records();
    const claims = JSON.parse(record?.caller_claims ?? '{}') as Record<string, unknown>;
    expect(claims).not.toHaveProperty('secret_claim');
    expect(claims).not.toHaveProperty('repository_visibility');
    expect(claims).not.toHaveProperty('aud');
    expect(claims).toMatchObject({
      sub: 'repo:acme/app:ref:refs/heads/main',
      ref: 'refs/heads/main',
    });
  });

  it('the policy trace does not reveal values of non-allowlisted claims', async () => {
    const fx = await setupProxy({
      grant: {
        conditions: [
          { claim: 'repository_owner_id', match: 'exact', values: ['4242'] },
          { claim: 'repository_id', match: 'exact', values: ['987654321'] },
          { claim: 'secret_claim', match: 'exact', values: ['expected'] },
        ],
      },
    });
    const response = await fx.call('/a', { token: await fx.token({ secret_claim: CANARY_CLAIM }) });
    expect(response.status).toBe(403);
    const [record] = await fx.records();
    expect(record?.eval_trace).toContain('secret_claim');
    expect(record?.eval_trace).not.toContain(CANARY_CLAIM);
    expect(JSON.stringify(await response.json())).not.toContain('secret_claim');
  });
});

describe('I-LOG-2: unverified claims are never stored', () => {
  it.each([
    [
      'bad signature',
      async (fx: Awaited<ReturnType<typeof setupProxy>>) => {
        const [h, p] = (await fx.token({ secret_claim: CANARY_CLAIM })).split('.');
        return `${h}.${p}.AAAA`;
      },
    ],
    [
      'expired token',
      (fx: Awaited<ReturnType<typeof setupProxy>>) =>
        fx.issuer.sign({ sub: CANARY_CLAIM, aud: 'x' }, { iat: 1, exp: 2 }),
    ],
    [
      'tenant mismatch',
      (fx: Awaited<ReturnType<typeof setupProxy>>) =>
        fx.token({ repository_owner_id: '1', secret_claim: CANARY_CLAIM, sub: CANARY_CLAIM }),
    ],
  ])('%s: claims_verified=0 and no caller fields', async (_label, makeToken) => {
    const fx = await setupProxy();
    const response = await fx.call('/a', { token: await makeToken(fx) });
    expect(response.status).toBe(401);
    const [record] = await fx.records();
    expect(record).toMatchObject({
      outcome: 'denied',
      claims_verified: 0,
      caller_subject: null,
      caller_repository: null,
      caller_claims: null,
      jti: null,
      grant_id: null,
      untrusted_iss: 'https://token.actions.githubusercontent.com',
    });
    expect(JSON.stringify(record)).not.toContain(CANARY_CLAIM);
  });
});
