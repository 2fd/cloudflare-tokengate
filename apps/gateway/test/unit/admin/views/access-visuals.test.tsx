// Pure display helpers of the credential access rule and issuer access rules pages: the hour-based "last used" time,
// the status a row leads with, the busiest-first order and the operation names.
import { describe, expect, it } from 'vitest';
import type { AccessEdge } from '../../../../src/admin/connections';
import {
  busiestFirst,
  leadStatus,
  operationsText,
} from '../../../../src/admin/views/access-visuals';
import { lastUsedTime } from '../../../../src/admin/views/format';

const HOUR = 3_600_000;

describe('lastUsedTime', () => {
  it('never reads as the future for the current hour', () => {
    const hour = 10 * HOUR;
    // 7 minutes into the hour: the middle of what has passed, not of the whole hour.
    expect(lastUsedTime(hour, hour + 7 * 60_000)).toBe('3 min ago');
    expect(lastUsedTime(hour, hour + 30_000)).toBe('just now');
  });

  it('takes the middle of a closed hour', () => {
    const hour = 10 * HOUR;
    expect(lastUsedTime(hour, hour + 3 * HOUR)).toBe('2 h ago');
    expect(lastUsedTime(hour, hour + HOUR + 10 * 60_000)).toBe('40 min ago');
  });
});

describe('leadStatus', () => {
  it('leads an active access with an accepted risk with "Risk accepted"', () => {
    const lead = leadStatus({
      status: 'active',
      flags: [{ status: 'risk_accepted' }, { status: 'unused' }],
    });
    expect(lead.status).toBe('risk_accepted');
    expect(lead.rest).toEqual([{ status: 'unused' }]);
  });

  it('keeps any other status first and every flag after it', () => {
    const lead = leadStatus({
      status: 'expired',
      flags: [{ status: 'risk_accepted' }],
    });
    expect(lead.status).toBe('expired');
    expect(lead.rest).toEqual([{ status: 'risk_accepted' }]);
    expect(
      leadStatus({ status: 'inactive', statusDetail: 'credential disabled', flags: [] }),
    ).toEqual({
      status: 'inactive',
      detail: 'credential disabled',
      rest: [],
    });
  });
});

describe('busiestFirst', () => {
  it('orders by count, then by name', () => {
    const counts: Record<string, number> = { a: 1, b: 6, c: 1 };
    const items = [
      { id: 'c', name: 'Buildkite' },
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'GitHub' },
    ];
    expect(busiestFirst(items, (id) => counts[id] ?? 0).map((item) => item.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });
});

describe('operationsText', () => {
  const edge = (rules: AccessEdge['grant']['rules'], template: string | null) =>
    ({
      grant: { rules },
      token: { template_id: template },
      subject: 'acme/api',
    }) as unknown as Pick<AccessEdge, 'grant' | 'token' | 'subject'>;

  it('names a whole preset by its label', () => {
    expect(operationsText(edge([{ methods: ['POST'], path: '/chat.postMessage' }], 'slack'))).toBe(
      'Post messages',
    );
  });

  it('keeps rules outside the presets as METHOD /path', () => {
    expect(
      operationsText(
        edge(
          [
            { methods: ['POST'], path: '/chat.postMessage' },
            { methods: ['GET'], path: '/team.info' },
          ],
          'slack',
        ),
      ),
    ).toBe('Post messages, GET /team.info');
    expect(operationsText(edge([{ methods: ['GET'], path: '/v1/x' }], null))).toBe('GET /v1/x');
  });
});
