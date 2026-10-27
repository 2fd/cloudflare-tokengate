// The Overview alert catalogue × the five roles: every alert links to its objects for everyone,
// the fix only for holders of its permission (others are told whom to ask), the inline approve
// and rewrap forms only with users:write and keyring:rewrap, no role=alert, same-code grouping
// and the overflow details. Values shown are names and counts, never secrets.
import { env } from 'cloudflare:workers';
import type { Child } from 'hono/jsx';
import { beforeEach, describe, expect, it } from 'vitest';
import { can, type Permission } from '../../src/admin/auth/rbac';
import type { ViewContext } from '../../src/admin/render';
import type { AlertCode } from '../../src/admin/views/alerts';
import { AttentionCards, toAttentionItems } from '../../src/admin/views/monitoring';
import type { Role } from '../../src/db/types';
import { type AlertData, overviewAlerts } from '../../src/telemetry/dashboard';
import { adminGet, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';
import { TEST_EPOCH_MS } from '../helpers/jwt';

const NOW = Date.UTC(2026, 9, 14, 9);
const DAY = 86_400_000;
const ROLES: readonly Role[] = ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'];
const ALL_CODES: readonly AlertCode[] = [
  'keyring_unavailable',
  'key_missing',
  'key_changed',
  'credential_malformed',
  'key_not_active',
  'credential_missing_used',
  'upstream_auth',
  'outside_hosts',
  'schema_behind',
  'schema_ahead',
  'schema_unknown',
  'config_problem',
  'cron_failing',
  'cron_stale',
  'cron_never',
  'access_expiring',
  'users_need_decision',
  'single_owner',
];

function base(): AlertData {
  return {
    now: NOW,
    credentials: [],
    access_rules: [],
    sealedKids: [],
    keyring: {
      ok: true,
      error: null,
      activeKid: 'k1',
      activeKids: ['k1'],
      missingKids: [],
      changedKids: [],
      notActiveCount: 0,
      malformedCount: 0,
    },
    keyCount: 1,
    schema: { DB: 'ok', TELEMETRY_DB: 'ok' },
    cron: {
      lastSuccessAt: NOW - 60_000,
      lastErrorAt: null,
      lastError: null,
      stale: false,
      failing: false,
    },
    config: [],
    activeOwners: 2,
    needsDecision: 0,
    pendingUsers: [],
    upstreamAuthFailures: [],
    allowedHosts: null,
    sampleRate: 1,
  };
}

const service = (
  id: string,
  name: string,
  extra: Partial<AlertData['credentials'][number]> = {},
) => ({
  id,
  slug: name.toLowerCase(),
  name,
  enabled: true,
  base_url: `https://${name.toLowerCase()}.example.com`,
  has_credential: true,
  ...extra,
});

/** Three deployments that together raise every code of the catalogue. */
function catalogue(): AlertData[] {
  const broken: AlertData = {
    ...base(),
    keyring: { ...base().keyring, ok: false, error: 'keyring_absent', activeKid: null },
    schema: { DB: 'behind', TELEMETRY_DB: 'ahead' },
    cron: {
      lastSuccessAt: null,
      lastErrorAt: NOW - 600_000,
      lastError: 'purge: Error: D1 overloaded',
      stale: true,
      failing: true,
    },
    config: [
      {
        variable: 'AUTH_ACCESS_AUD',
        message: 'must be set',
        anchor: 'cloudflare-access-login-auth_access_',
      },
    ],
    activeOwners: 1,
  };
  const keys: AlertData = {
    ...base(),
    credentials: [
      service('svc_A', 'Alpha'),
      service('svc_B', 'Beta'),
      service('svc_C', 'Gamma', { has_credential: false }),
      service('svc_D', 'Delta', { base_url: 'https://evil.example.net' }),
    ],
    access_rules: [
      {
        id: 'acr_01JAAAAAAAAAAAAAAAAAAAAAAA',
        name: 'Gamma for acme/api',
        credential_id: 'svc_C',
        enabled: true,
        expires_at: NOW + 2 * DAY,
      },
    ],
    sealedKids: [
      { id: 'svc_A', slug: 'alpha', name: 'Alpha', kid: 'k0' },
      { id: 'svc_B', slug: 'beta', name: 'Beta', kid: 'k1' },
      { id: 'svc_D', slug: 'delta', name: 'Delta', kid: null },
    ],
    keyring: {
      ok: false,
      error: null,
      activeKid: 'k1',
      activeKids: ['k1'],
      missingKids: ['k0'],
      changedKids: ['k1'],
      notActiveCount: 1,
      malformedCount: 1,
    },
    schema: { DB: 'ok', TELEMETRY_DB: 'unknown' },
    cron: {
      lastSuccessAt: NOW - 3 * 3_600_000,
      lastErrorAt: null,
      lastError: null,
      stale: true,
      failing: false,
    },
    upstreamAuthFailures: [
      { service_id: 'svc_B', service_slug: 'beta', forwarded: 14, auth_failures: 12 },
    ],
    allowedHosts: ['*.example.com'],
    needsDecision: 2,
    pendingUsers: [
      { id: 'usr_01JAAAAAAAAAAAAAAAAAAAAAAA', email: 'new@example.com', updated_at: NOW - 1000 },
    ],
  };
  const fresh: AlertData = {
    ...base(),
    cron: { ...base().cron, lastSuccessAt: null, stale: true },
  };
  return [broken, keys, fresh];
}

function view(role: Role): ViewContext {
  return {
    csrf: 'csrf-token',
    userId: 'usr_viewer',
    role,
    host: 'gw.test',
    now: NOW,
    can: (permission: Permission) => can(role, permission),
    askers: () => [{ email: 'owner@example.com' }],
    askersMore: () => 0,
    hidden: (extra) => ({ _csrf: 'csrf-token', ...extra }),
  };
}

const html = (node: Child) => String(node);

describe('the alert catalogue', () => {
  it('raises every code across the three deployments, each code once per deployment', () => {
    const codes = catalogue().flatMap((data) => {
      const list = overviewAlerts(data).map((alert) => alert.code);
      expect(new Set(list).size).toBe(list.length);
      return list;
    });
    expect(new Set(codes)).toEqual(new Set(ALL_CODES));
  });

  it('links schema and hourly-job alerts to their row of "All checks"', () => {
    const [broken, keys] = catalogue();
    const href = (data: AlertData | undefined, code: string) =>
      data ? overviewAlerts(data).find((alert) => alert.code === code)?.objects[0]?.href : null;
    expect(href(broken, 'schema_behind')).toBe('/admin#check-schema');
    expect(href(broken, 'schema_ahead')).toBe('/admin#check-telemetry-schema');
    expect(href(keys, 'schema_unknown')).toBe('/admin#check-telemetry-schema');
    expect(href(broken, 'cron_failing')).toBe('/admin#check-maintenance');
    expect(href(keys, 'cron_stale')).toBe('/admin#check-maintenance');
  });

  it('links an expiring credential access rule to its page and its edit form', () => {
    const [, keys] = catalogue();
    const alert = keys ? overviewAlerts(keys).find((a) => a.code === 'access_expiring') : null;
    expect(alert?.title).toMatch(/^Credential access rule "Gamma for acme\/api" expires on /);
    expect(alert?.objects[0]?.href).toBe(
      '/admin/credential-access-rules/acr_01JAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(alert?.fix?.href).toBe(
      '/admin/credential-access-rules/acr_01JAAAAAAAAAAAAAAAAAAAAAAA?open=edit#edit',
    );
    expect(alert?.fix?.permission).toBe('access:write');
  });

  it('orders errors, then warnings, then notes', () => {
    for (const data of catalogue()) {
      const levels = overviewAlerts(data).map(
        (alert) => ({ error: 0, warning: 1, info: 2 })[alert.level],
      );
      expect(levels).toEqual([...levels].sort((a, b) => a - b));
    }
  });

  for (const role of ROLES) {
    it(`renders each alert for ${role}: objects always, the fix only with its permission`, () => {
      const ctx = view(role);
      for (const data of catalogue()) {
        for (const alert of overviewAlerts(data)) {
          const out = html(<AttentionCards items={toAttentionItems([alert], ctx)} layout="list" />);
          expect(out, alert.code).toContain('<ul class="att');
          expect(out, alert.code).not.toContain('role="alert"');
          // An approver gets one item per waiting person (name + approve buttons) instead of the
          // link to the list; everyone else gets the link.
          const perPerson = alert.form?.kind === 'approve-pending' && can(role, 'users:write');
          if (perPerson && alert.form?.kind === 'approve-pending') {
            for (const user of alert.form.users) {
              expect(out, alert.code).toContain(`action="/admin/users/${user.id}/approve"`);
            }
          }
          for (const object of perPerson ? [] : alert.objects) {
            expect(out, `${alert.code} ${object.href}`).toContain(
              `href="${object.href.replaceAll('&', '&amp;')}"`,
            );
          }
          if (alert.fix) {
            // A narrow card shows the short label; the rest of it is read by screen readers.
            const label = alert.fix.short?.label ?? alert.fix.label;
            const fixLink = `href="${alert.fix.href.replaceAll('&', '&amp;')}">${label.replaceAll('"', '&quot;')}`;
            if (can(role, alert.fix.permission)) expect(out, alert.code).toContain(fixLink);
            else {
              expect(out, alert.code).not.toContain(fixLink);
              expect(out, alert.code).toContain('class="ask"');
            }
          }
          const rewrap = out.includes('action="/admin/credentials/keys/rewrap"');
          expect(rewrap, alert.code).toBe(
            alert.form?.kind === 'rewrap' && can(role, 'keyring:rewrap'),
          );
          const approve = out.includes('/approve"');
          expect(approve, alert.code).toBe(
            alert.form?.kind === 'approve-pending' && can(role, 'users:write'),
          );
          if (alert.form?.kind === 'approve-pending' && !can(role, 'users:write')) {
            expect(out).not.toContain('new@example.com');
          }
        }
      }
    });
  }

  it('groups same-code alerts into one item and puts items after the eighth in a details', () => {
    const many: AlertData = {
      ...base(),
      credentials: Array.from({ length: 7 }, (_, i) =>
        service(`svc_${i}`, `Token${i}`, { base_url: 'https://elsewhere.example.org' }),
      ),
      allowedHosts: ['*.example.com'],
    };
    const alerts = overviewAlerts(many);
    expect(alerts.map((a) => a.code)).toEqual(['outside_hosts']);
    expect(alerts[0]?.objects.map((o) => o.label)).toEqual([
      'Token0',
      'Token1',
      'Token2',
      'Token3',
      'Token4',
      '+2 more',
      'Tokens outside the allowed hosts',
    ]);
    const all = catalogue().flatMap(overviewAlerts);
    const items = toAttentionItems(all, view('owner'));
    expect(items.length).toBeGreaterThan(8);
    const out = html(<AttentionCards items={items} layout="cols" />);
    expect(out).toContain(`<summary>${items.length - 8} more problems</summary>`);
  });

  it('never shows a secret value: the KEK and sealed values do not reach an alert', () => {
    const text = JSON.stringify(catalogue().flatMap(overviewAlerts));
    expect(text).not.toMatch(/TOKENGATE_KEK=|"ct"|wdek/);
  });
});

describe('alerts on the Overview page', () => {
  beforeEach(async () => {
    await resetControlPlane();
  });

  it('offers the inline approve form to owners only, and never as role=alert', async () => {
    const app = createTestApp({ now: () => TEST_EPOCH_MS });
    const owner = await createUser({ email: 'owner@example.com', role: 'owner' }, TEST_EPOCH_MS);
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, TEST_EPOCH_MS);
    const pending = await createUser(
      { email: 'pending@example.com', role: 'viewer', status: 'pending' },
      TEST_EPOCH_MS,
    );
    const ownerHtml = await (await adminGet(app, await loginAs(app, owner), '/admin')).text();
    expect(ownerHtml).toContain('1 person needs a decision.');
    expect(ownerHtml).toContain(`action="/admin/users/${pending.id}/approve"`);
    expect(ownerHtml).not.toContain('role="alert"');
    const adminHtml = await (await adminGet(app, await loginAs(app, admin), '/admin')).text();
    expect(adminHtml).toContain('1 person needs a decision.');
    expect(adminHtml).not.toContain('/approve"');
    expect(adminHtml).not.toContain('pending@example.com');
    await env.DB.prepare('DELETE FROM audit_log').run();
  });
});
