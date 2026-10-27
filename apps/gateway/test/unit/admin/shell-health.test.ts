// The shell's health line and strip from the alert catalogue: errors before warnings before notes,
// wording that never claims more than was checked, one strip problem per configuration error, and
// only the problems that stop calls in the strip (a short title, then the detail), each with its
// fix link, and a health line that says when the checks did not run.
import { describe, expect, it } from 'vitest';
import type { Permission } from '../../../src/admin/auth/rbac';
import {
  healthSummary,
  navAttention,
  type StripInput,
  stripProblems,
  uncheckedHealth,
} from '../../../src/admin/shell-health';
import type { Alert, AlertCode } from '../../../src/admin/views/alerts';
import { SCHEMA_HEAD } from '../../../src/generated/schema-head';
import type { CronHealth } from '../../../src/health';

function alert(code: AlertCode, level: Alert['level'], title: string = code): Alert {
  return { code, level, title, detail: '', objects: [] };
}

describe('healthSummary', () => {
  it('counts errors first and links them to Needs attention, which lists every alert', () => {
    expect(
      healthSummary([alert('keyring_unavailable', 'error'), alert('cron_stale', 'warning')]),
    ).toEqual({
      tone: 'bad',
      text: '1 problem to fix',
      href: '/admin#attention',
      srSuffix: '. Open Overview, Needs attention',
    });
    expect(
      healthSummary([alert('schema_behind', 'error'), alert('config_problem', 'error')]).text,
    ).toBe('2 problems to fix');
  });

  it('then warnings, linked to Needs attention', () => {
    expect(healthSummary([alert('cron_stale', 'warning'), alert('single_owner', 'info')])).toEqual({
      tone: 'warn',
      text: '1 warning to review',
      href: '/admin#attention',
      srSuffix: '. Open Overview, Needs attention',
    });
  });

  it('says Healthy without counting notes, linked to the Overview', () => {
    expect(healthSummary([alert('single_owner', 'info'), alert('cron_never', 'info')])).toEqual({
      tone: 'ok',
      text: 'Healthy',
      href: '/admin',
      srSuffix: '. Open Overview',
    });
    expect(healthSummary([]).text).toBe('Healthy');
  });
});

describe('stripProblems', () => {
  const healthy: StripInput = {
    keyring: { error: null },
    schema: { DB: 'ok', TELEMETRY_DB: 'ok' },
    config: [],
    cron: { lastSuccessAt: 1, lastErrorAt: null, lastError: null, stale: false, failing: false },
  };

  it('is empty when nothing stops calls', () => {
    expect(stripProblems(healthy)).toEqual([]);
    // A stale job or a newer schema is a warning: the health line, not the strip.
    expect(
      stripProblems({
        ...healthy,
        schema: { DB: 'ahead', TELEMETRY_DB: 'unknown' },
        cron: { ...(healthy.cron as CronHealth), stale: true },
      }),
    ).toEqual([]);
  });

  it('keeps only the problems that stop calls, a short title then the detail, each with its fix', () => {
    const problems = stripProblems({
      keyring: { error: 'keyring_absent' },
      schema: { DB: 'behind', TELEMETRY_DB: 'ok' },
      config: [],
      cron: {
        lastSuccessAt: 1,
        lastErrorAt: 1_791_000_000_000,
        lastError: 'purge: Error: D1 overloaded',
        stale: false,
        failing: true,
      },
    });
    expect(problems).toEqual([
      {
        title: 'Encryption keys are not loaded.',
        detail:
          'Requests through credentials fail with 503 and secrets cannot change (keyring_absent).',
        fix: { href: '/admin/credentials/keys', label: 'Open rotate encryption' },
      },
      {
        title: 'Database DB is missing migrations.',
        detail: `The newest is ${SCHEMA_HEAD.DB}.`,
        fix: {
          href: 'https://github.com/2fd/cloudflare-tokengate/blob/main/docs/operations/upgrades.md',
          label: 'How to apply migrations',
        },
      },
      {
        title: 'The hourly job failed.',
        detail: 'purge: Error: D1 overloaded.',
        at: 1_791_000_000_000,
        fix: { href: '/admin#check-maintenance', label: 'Hourly job check' },
      },
    ]);
  });

  it('lists each configuration error on its own, by variable name only', () => {
    const problems = stripProblems({
      ...healthy,
      config: [
        { variable: 'AUTH_ACCESS_AUD', message: 'must be 64 hex characters', anchor: 'a' },
        { variable: 'TOKENGATE_KEYRING', message: 'Is not valid JSON.', anchor: 'b' },
      ],
    });
    expect(problems.map((p) => [p.title, p.detail])).toEqual([
      ['Configuration error in AUTH_ACCESS_AUD.', 'must be 64 hex characters.'],
      ['Configuration error in TOKENGATE_KEYRING.', 'Is not valid JSON.'],
    ]);
    expect(problems[0]?.fix.label).toBe('Configuration reference');
  });

  it('leaves out the hourly job when its state was not read (the fallback)', () => {
    expect(stripProblems({ ...healthy, cron: null })).toEqual([]);
  });
});

describe('uncheckedHealth', () => {
  it('counts the problems found without the alert data, and never says Healthy', () => {
    expect(uncheckedHealth(2)).toEqual({
      tone: 'bad',
      text: '2 problems to fix',
      href: '/admin#health',
      srSuffix: '. Open Overview, Health',
    });
    expect(uncheckedHealth(0)).toEqual({
      tone: 'warn',
      text: 'Health not checked',
      href: '/admin#health',
      srSuffix: '. The checks could not read the database. Open Overview, Health',
    });
  });
});

describe('navAttention', () => {
  const all = () => true;
  const withFix = (code: AlertCode, level: Alert['level'], permission: Permission): Alert => ({
    ...alert(code, level),
    fix: { href: '/admin/x', label: 'Fix', permission },
  });

  it('marks the page that shows each alert with its worst level', () => {
    expect(
      navAttention(
        [
          alert('key_not_active', 'info'),
          alert('key_missing', 'error'),
          alert('credential_missing_used', 'warning'),
          withFix('single_owner', 'info', 'users:write'),
        ],
        all,
      ),
    ).toEqual({
      keys: { tone: 'bad', srSuffix: ': 1 problem, 1 note' },
      tokens: { tone: 'warn', srSuffix: ': 1 warning' },
      members: { tone: 'info', srSuffix: ': 1 note' },
    });
  });

  it('leaves the Overview checks to the health line and pending people to the pill', () => {
    expect(
      navAttention(
        [
          alert('cron_stale', 'warning'),
          alert('schema_behind', 'error'),
          alert('users_need_decision', 'warning'),
        ],
        all,
      ),
    ).toEqual({});
  });

  it('skips an alert whose fix the viewer may not make', () => {
    const single = withFix('single_owner', 'info', 'users:write');
    expect(navAttention([single], (permission) => permission !== 'users:write')).toEqual({});
  });
});
