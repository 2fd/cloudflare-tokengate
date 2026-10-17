// Pure helpers of the Monitoring pages: the request pipeline arithmetic, the What to do text split,
// the feed day labels, the logo tiles and the Needs attention mapping.
import { describe, expect, it } from 'vitest';
import type { ViewContext } from '../../../../src/admin/render';
import { NEXT_ACTIONS, splitFirstSentence } from '../../../../src/admin/routes/requests';
import type { Alert } from '../../../../src/admin/views/alerts';
import {
  byUtcDay,
  consumerLogo,
  dayLabel,
  pipelineCounts,
  pipelineStages,
  toAttentionItems,
  tokenLogo,
} from '../../../../src/admin/views/monitoring';
import type { TokenTraffic, TrafficStats } from '../../../../src/telemetry/dashboard';

function stats(requests: number, allowed: number, denied: number, errors: number): TrafficStats {
  return {
    requests,
    allowed,
    denied,
    errors,
    errorRate: requests > 0 ? errors / requests : 0,
    upstreamAuthFailures: 0,
    p50: null,
    p95: null,
  };
}

function token(serviceId: string, s: TrafficStats): TokenTraffic {
  return { serviceId, ...s };
}

describe('pipelineCounts', () => {
  it('subtracts the calls lost at each stage once, gateway errors before a token included', () => {
    // '' bucket: 182 refused, of them 180 denied and 2 gateway errors (internal_error).
    // Resolved tokens: 59 denied after the token, 12 errors (11 upstream 5xx + 1 gateway error).
    const unresolved = stats(182, 0, 180, 2);
    const openai = stats(3902, 3880, 21, 11);
    const slack = stats(4130, 4091, 38, 1);
    const totals = stats(8214, 7971, 239, 14);
    const c = pipelineCounts(totals, [
      token('', unresolved),
      token('svc_o', openai),
      token('svc_s', slack),
    ]);
    expect(c).toEqual({
      received: 8214,
      refused: 182,
      resolved: 8032,
      deniedAfter: 59,
      matched: 7973,
      errorsAfter: 12,
      ok: 7961,
    });
    // The same number from the totals alone: allowed minus the allowed answered with 5xx.
    const allowed5xx = totals.errors - (totals.requests - totals.allowed - totals.denied);
    expect(c.ok).toBe(totals.allowed - allowed5xx);
  });

  it('is all zero without traffic and without the unresolved bucket', () => {
    expect(pipelineCounts(stats(0, 0, 0, 0), [])).toEqual({
      received: 0,
      refused: 0,
      resolved: 0,
      deniedAfter: 0,
      matched: 0,
      errorsAfter: 0,
      ok: 0,
    });
  });

  it('links every stage count to its request list, and a zero drop to none', () => {
    const totals = stats(10, 8, 2, 0);
    const stages = pipelineStages(totals, [token('svc_a', totals)], '7d', new Map());
    expect(stages.map((s) => s.href)).toEqual([
      '/admin/requests?range=7d',
      undefined,
      undefined,
      '/admin/requests?range=7d&outcome=allowed',
    ]);
    expect(stages[0]?.totals?.map((t) => t.href)).toEqual([
      '/admin/requests?range=7d&outcome=denied',
      '/admin/requests?range=7d&outcome=error',
    ]);
    expect(stages[1]?.drop?.href).toBeUndefined();
    expect(stages[2]?.drop?.href).toBe('/admin/requests?range=7d&outcome=denied');
    expect(stages[2]?.drop?.go).toBe('See 2 requests');
    expect(stages[3]?.drop?.href).toBeUndefined();
  });
});

describe('What to do', () => {
  it('splits every text into a title and the rest without losing a word', () => {
    for (const [code, entry] of Object.entries(NEXT_ACTIONS)) {
      const { title, rest } = splitFirstSentence(entry.text);
      expect(rest === '' ? title : `${title} ${rest}`, code).toBe(entry.text);
      expect(title.endsWith('.'), code).toBe(true);
    }
  });
});

describe('feeds', () => {
  const now = Date.UTC(2026, 9, 15, 14, 5);
  it('labels UTC days relative to now', () => {
    expect(dayLabel(Date.UTC(2026, 9, 15, 0, 1), now)).toBe('Today');
    expect(dayLabel(Date.UTC(2026, 9, 14, 23, 59), now, true)).toBe('Yesterday, 14 Oct');
    expect(dayLabel(Date.UTC(2026, 9, 3, 12), now)).toBe('3 Oct');
    expect(dayLabel(Date.UTC(2025, 11, 31, 12), now)).toBe('31 Dec 2025');
  });

  it('groups events by UTC day in the given order', () => {
    const ts = [Date.UTC(2026, 9, 15, 9), Date.UTC(2026, 9, 15, 1), Date.UTC(2026, 9, 14, 23)];
    expect(byUtcDay(ts.map((t) => ({ ts: t }))).map((day) => day.length)).toEqual([2, 1]);
  });
});

describe('logo tiles', () => {
  it('picks the brand from the template and the profile, dimmed when disabled', () => {
    expect(tokenLogo({ template_id: 'slack-webhook', enabled: true })).toBe('slack');
    expect(tokenLogo({ template_id: null, enabled: false })).toEqual({
      brand: 'custom',
      disabled: true,
    });
    expect(tokenLogo(null)).toBe('custom');
    expect(consumerLogo({ profile: 'gitlab-ci', enabled: true })).toBe('gitlab');
    expect(consumerLogo({ profile: 'generic', enabled: true })).toBe('oidc');
  });
});

describe('toAttentionItems', () => {
  const ctx = (perms: string[]): ViewContext =>
    ({
      csrf: 'tok',
      userId: 'usr_1',
      role: 'viewer',
      host: 'gw.test',
      now: 0,
      can: (p: string) => perms.includes(p),
      askers: () => [{ email: 'owner@example.com' }],
      askersMore: () => 0,
      hidden: (extra?: Record<string, string>) => ({ _csrf: 'tok', ...extra }),
    }) as unknown as ViewContext;
  const pending: Alert = {
    code: 'users_need_decision',
    level: 'warning',
    title: '2 people need a decision.',
    detail: '',
    objects: [{ href: '/admin/users#decide', label: 'People' }],
    form: {
      kind: 'approve-pending',
      users: [
        { id: 'usr_a', email: 'a@example.com', updated_at: 0 },
        { id: 'usr_b', email: 'b@example.com', updated_at: 0 },
      ],
    },
  };

  it('gives users:write one approve item per person, posting back to the Overview', () => {
    const items = toAttentionItems([pending], ctx(['users:write']));
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('2 people need a decision.');
    expect(items[0]?.approve?.action).toBe('/admin/users/usr_a/approve');
    expect(items[0]?.approve?.hidden).toEqual({ _csrf: 'tok', _return: 'overview' });
    expect(items[0]?.approve?.reject?.hidden).toEqual({ _csrf: 'tok', _return: 'overview' });
    expect(items[0]?.approve?.roles.map((r) => r.value)).toEqual([
      'viewer',
      'token_manager',
      'access_manager',
      'admin',
      'owner',
    ]);
    expect(items[0]?.approve?.roles.at(-1)?.dialog).toBe('approve-owner-usr_a');
  });

  it('never names the pending people to anyone else', () => {
    const items = toAttentionItems([pending], ctx([]));
    expect(items).toHaveLength(1);
    expect(items[0]?.approve).toBeUndefined();
    expect(JSON.stringify(items[0]?.title)).not.toContain('a@example.com');
  });

  it('maps the levels and keeps the fix behind its permission', () => {
    const alert: Alert = {
      code: 'single_owner',
      level: 'info',
      title: 'Only one active owner.',
      detail: '',
      objects: [],
      fix: { href: '/admin/users#invite', label: 'Invite', permission: 'users:write' },
    };
    const [withFix] = toAttentionItems([alert], ctx(['users:write']));
    expect(withFix?.level).toBe('info');
    expect(withFix?.actions).toBeDefined();
    const [error] = toAttentionItems([{ ...alert, level: 'error', fix: null }], ctx([]));
    expect(error?.level).toBe('bad');
    expect(error?.actions).toBeUndefined();
  });
});
