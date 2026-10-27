// Global access rule pages through the real app (§A7.3-A7.5, I-AUTHZ-5): every signed-in role reads
// them (AR-16) and only Admins and Owners change them (AR-15); the list with its filters (Stable
// filter layout) and the issuers without a global access rule; the form with each limit box and its
// errors; the confirmations of AR-21 and AR-4 (first ceiling, widening, last disable, last delete)
// with their fixed texts; the rule page and its edit form at ?open=edit; and escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getGlobalAccessRule, listGlobalAccessRules } from '../../src/db/access-rules';
import type { GlobalAccessRule } from '../../src/db/types';
import { issuerKey } from '../../src/policy/limits';
import { WORLD_SECRET } from '../fixtures/admin-forms';
import {
  auditActions,
  checkedValues,
  selectedValue,
  formFields,
  GITLAB_ISSUER,
  idFromLocation,
  inputValue,
  locationOf,
  type RulesWorld,
  rulesWorld,
} from '../helpers/access-rules';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  GITHUB_ISSUER,
  OWNER_ID,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
} from '../unit/admin/ops/helpers';

let world: RulesWorld;
let serviceId: string;

beforeEach(async () => {
  world = await rulesWorld();
  serviceId = await seedService(world.app.deps, { secret: WORLD_SECRET });
});

const GLOBALS = '/admin/global-access-rules';
const GITHUB_KEY = issuerKey(GITHUB_ISSUER);
const GITLAB_KEY = issuerKey(GITLAB_ISSUER);
const admin = () => world.sessions.admin;

const FIRST_CEILING = `This is the first global access rule of ${GITHUB_ISSUER}. From the next request on, its credential access rules admit only what this rule allows.`;
const WIDENING = `This lets more requests in. Every credential access rule of ${GITHUB_ISSUER} may again allow what this change no longer limits, on every credential.`;
const LAST_DISABLE = `While no global access rule of ${GITHUB_ISSUER} is enabled, its credential access rules admit nothing.`;
const LAST_DELETE = `This is the last global access rule of ${GITHUB_ISSUER}. After you delete it, its credential access rules are no longer limited by a global access rule.`;

/** A GitHub Actions global access rule that limits the organizations to acme. */
function acmeOnly(overrides: Record<string, string | string[]> = {}) {
  return {
    type: 'github-actions',
    issuer: '',
    name: 'acme only',
    enabled: '1',
    'limit.tenant_pin': '1',
    'tenants.github': `acme (${OWNER_ID})`,
    ...overrides,
  };
}

async function html(path: string, session = admin()): Promise<string> {
  return (await adminGet(world.app, session, path)).text();
}

async function globals(): Promise<GlobalAccessRule[]> {
  return listGlobalAccessRules(env.DB);
}

const globalAudit = async () =>
  (await auditActions()).filter((action) => action.startsWith('global_access_rule.'));

/** The text of the open confirmation dialog of the global rule form, or null. */
function confirmation(page: string): { text: string; field: string } | null {
  const dialog = /<dialog[^>]*id="dlg-gr-confirm"[^>]*>(.*?)<\/dialog>/s.exec(page)?.[1];
  if (!dialog) return null;
  const button = /<button[^>]*form="gr-form"[^>]*>/.exec(dialog)?.[0] ?? '';
  return {
    text: /<p[^>]*>(.*?)<\/p>/s.exec(dialog)?.[1] ?? '',
    field: /name="([^"]+)"/.exec(button)?.[1] ?? '',
  };
}

describe('global access rules: who may see and change them (AR-15, AR-16)', () => {
  it('every signed-in role reads the list and the rule page', async () => {
    const rule = await seedGlobalRule(world.app.deps, {
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    for (const role of ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'] as const) {
      const session = world.sessions[role];
      const list = await adminGet(world.app, session, GLOBALS);
      expect(list.status, role).toBe(200);
      expect(await list.text(), role).toContain(`href="${GLOBALS}/${rule.id}">acme only</a>`);
      const detail = await adminGet(world.app, session, `${GLOBALS}/${rule.id}`);
      expect(detail.status, role).toBe(200);
      const page = await detail.text();
      const writer = role === 'admin' || role === 'owner';
      expect(page.includes('Change this rule'), role).toBe(writer);
      expect(page.includes('Delete this rule…'), role).toBe(writer);
      expect(page.includes(`action="${GLOBALS}/${rule.id}/toggle"`), role).toBe(writer);
    }
  });

  it('an Access manager reads the edit link as plain detail and changes nothing', async () => {
    const rule = await seedGlobalRule(world.app.deps);
    const manager = world.sessions.access_manager;
    const before = await globalAudit();
    const page = await html(`${GLOBALS}/${rule.id}?open=edit`, manager);
    expect(page).not.toContain('id="gr-form"');
    expect(page).toContain('id="limits"');
    expect((await adminGet(world.app, manager, `${GLOBALS}/new`)).status).toBe(403);
    for (const [path, fields] of [
      [GLOBALS, acmeOnly({ confirm_new_ceiling: '1' })],
      [`${GLOBALS}/${rule.id}`, { name: 'renamed', confirm_widening: '1' }],
      [`${GLOBALS}/${rule.id}/toggle`, { enabled: '0', confirm_last_disable: '1' }],
      [`${GLOBALS}/${rule.id}/delete`, { confirm: '1', confirm_widening: '1' }],
    ] as const) {
      const res = await adminPost(world.app, manager, path, fields);
      expect(res.status, path).toBe(403);
    }
    expect(await globals()).toEqual([rule]);
    expect(await globalAudit()).toEqual(before);
  });

  it('a credential manager and a viewer see no add button', async () => {
    for (const session of [world.sessions.viewer, world.sessions.token_manager]) {
      const page = await html(GLOBALS, session);
      expect(page).toContain('No global access rules. Each credential access rule is limited');
      expect(page).not.toContain(`href="${GLOBALS}/new"`);
    }
  });

  it('refuses a change without a CSRF token (I-CSRF-1)', async () => {
    const rule = await seedGlobalRule(world.app.deps);
    const before = await globalAudit();
    for (const path of [
      GLOBALS,
      `${GLOBALS}/${rule.id}`,
      `${GLOBALS}/${rule.id}/toggle`,
      `${GLOBALS}/${rule.id}/delete`,
    ]) {
      const res = await adminPost(
        world.app,
        admin(),
        path,
        {
          ...acmeOnly({ name: 'other' }),
          enabled: '0',
          confirm: '1',
          confirm_new_ceiling: '1',
          confirm_widening: '1',
          confirm_last_disable: '1',
        },
        { csrf: null },
      );
      expect(res.status, path).toBe(403);
    }
    expect(await globals()).toEqual([rule]);
    expect(await globalAudit()).toEqual(before);
  });
});

describe('global access rules list (§A7.3)', () => {
  it('is empty with an add action, the unlimited issuers and the explanation last', async () => {
    await seedCredentialRule(world.app.deps, { credential_id: serviceId });
    const page = await html(GLOBALS);
    expect(page).toContain(
      'No global access rules. Each credential access rule is limited only by itself.',
    );
    expect(page).toContain(`href="${GLOBALS}/new"`);
    // The one issuer of a credential access rule, not limited yet, with its add link.
    const unlimited = page.slice(page.indexOf('id="unlimited"'));
    expect(unlimited).toContain('Not limited · 1 credential access rule');
    expect(unlimited).toContain(
      `href="${GLOBALS}/new?issuer=${encodeURIComponent(GITHUB_ISSUER)}&amp;type=github-actions"`,
    );
    expect(page.indexOf('id="unlimited"')).toBeLessThan(
      page.indexOf('How global access rules work'),
    );
  });

  it('groups the rules by issuer with their limits, what they affect and their state', async () => {
    await seedCredentialRule(world.app.deps, { credential_id: serviceId });
    const acme = await seedGlobalRule(world.app.deps, {
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
      max_token_age_seconds: 300,
    });
    const other = await seedGlobalRule(world.app.deps, {
      name: 'other org',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['999'] }],
      enabled: false,
    });
    const gitlab = await seedGlobalRule(world.app.deps, {
      name: 'GitLab ceiling',
      profile: 'gitlab-ci',
      issuer: GITLAB_ISSUER,
    });
    const page = await html(GLOBALS);
    expect(page).toContain('<title>Global access rules – Credentials – tokengate</title>');
    // One group row per issuer key, then its rules; the GitHub key sorts after gitlab.com.
    const table = page.slice(page.indexOf('id="global-list"'));
    const order = [GITLAB_KEY, gitlab.id, GITHUB_KEY, acme.id, other.id].map((needle) =>
      table.indexOf(needle),
    );
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(table.match(/<tr class="grp"/g)).toHaveLength(2);
    const row = (id: string) => {
      const start = table.indexOf(`href="${GLOBALS}/${id}"`);
      return table.slice(start, table.indexOf('</tr>', start));
    };
    expect(row(acme.id)).toContain('Organizations');
    expect(row(acme.id)).toContain('Token age ≤ 300 s');
    expect(row(acme.id)).toContain('1 credential access rule');
    expect(row(acme.id)).not.toContain('blocked');
    expect(row(acme.id)).toContain('Enabled');
    expect(row(other.id)).toContain('· 1 blocked');
    expect(row(other.id)).toContain('Disabled');
    expect(row(gitlab.id)).toContain('No limits');
    expect(row(gitlab.id)).toContain('0 credential access rules');
    // Every issuer of a credential access rule has a global access rule now.
    expect(page).not.toContain('id="unlimited"');
  });

  it('filters by issuer and state with the controls in place (Stable filter layout)', async () => {
    const acme = await seedGlobalRule(world.app.deps);
    const off = await seedGlobalRule(world.app.deps, { name: 'off', enabled: false });
    const gitlab = await seedGlobalRule(world.app.deps, {
      name: 'GitLab ceiling',
      profile: 'gitlab-ci',
      issuer: GITLAB_ISSUER,
    });
    const controls = (page: string) => {
      const quick = page.indexOf('aria-label="Filter global access rules by state"');
      const filters = page.indexOf('aria-label="Filter global access rules"');
      return { quick, filters, chips: page.indexOf('Clear filters') };
    };

    const unfiltered = await html(GLOBALS);
    expect(controls(unfiltered).quick).toBeGreaterThan(-1);
    expect(controls(unfiltered).quick).toBeLessThan(controls(unfiltered).filters);
    expect(unfiltered).not.toContain('Status: ');

    const byIssuer = await html(`${GLOBALS}?issuer=${encodeURIComponent(GITHUB_KEY)}`);
    expect(byIssuer).toContain(`href="${GLOBALS}/${acme.id}"`);
    expect(byIssuer).toContain(`href="${GLOBALS}/${off.id}"`);
    expect(byIssuer).not.toContain(`href="${GLOBALS}/${gitlab.id}"`);
    expect(byIssuer).toContain(`Issuer: ${GITHUB_KEY}`);
    // Counts and options come from the unfiltered collection; the menu stays to replace the value.
    expect(byIssuer).toContain('2 of 3');
    expect(byIssuer).toContain(`?issuer=${encodeURIComponent(GITLAB_KEY)}`);
    // A state link keeps the issuer.
    expect(byIssuer).toContain(
      `href="${GLOBALS}?issuer=${encodeURIComponent(GITHUB_KEY)}&amp;status=disabled"`,
    );
    // The chips come after the controls, which keep their order.
    const selected = controls(byIssuer);
    expect(selected.quick).toBeLessThan(selected.filters);
    expect(selected.filters).toBeLessThan(selected.chips);

    const both = await html(`${GLOBALS}?issuer=${encodeURIComponent(GITHUB_KEY)}&status=disabled`);
    expect(both).toContain(`href="${GLOBALS}/${off.id}"`);
    expect(both).not.toContain(`href="${GLOBALS}/${acme.id}"`);
    expect(both).toContain('Status: Disabled');
    expect(both).toContain(`href="${GLOBALS}?status=disabled"`);

    const none = await html(`${GLOBALS}?status=expired`);
    expect(none).toContain('No global access rule matches these filters.');
    expect(controls(none).quick).toBeLessThan(controls(none).filters);

    const unknown = await html(`${GLOBALS}?issuer=https%3A%2F%2Fnope.example&status=bogus`);
    expect(unknown).toContain('No global access rule has that issuer.');
    expect(unknown).toContain(`href="${GLOBALS}/${gitlab.id}"`);
    expect(unknown).not.toContain('nope.example');
  });
});

describe('global access rule form (§A7.4)', () => {
  it('shows a box per limit, the token settings closed, and the issuer of the add link', async () => {
    const page = await html(
      `${GLOBALS}/new?issuer=${encodeURIComponent('https://gitlab.acme.example')}&type=gitlab-ci`,
    );
    for (const column of [
      'tenant_pin',
      'conditions',
      'rules',
      'anchor_claims',
      'audience',
      'jwks_uri',
      'allowed_algs',
      'max_token_age_seconds',
    ]) {
      expect(page, column).toContain(`name="limit.${column}"`);
    }
    expect(selectedValue(page, 'type')).toBe('gitlab-ci');
    expect(inputValue(page, 'issuer')).toBe('https://gitlab.acme.example');
    expect(/<details[^>]*id="gr-token"[^>]*\sopen/.test(page)).toBe(false);
    expect(page).toContain('Save global access rule');
    // No impact preview until WP-R3.
    expect(page).not.toContain('value="preview"');
    expect(page).not.toContain('Preview the impact');
  });

  it('limits the Vercel global issuer to teams', async () => {
    const team = 'team_7Gw5ZMzpQA8h90F832KGp7nwbuh3';
    const res = await adminPost(world.app, admin(), GLOBALS, {
      type: 'vercel',
      issuer: '',
      name: 'acme teams only',
      enabled: '1',
      'limit.tenant_pin': '1',
      'tenants.vercel': `acme (${team})`,
      confirm_new_ceiling: '1',
    });
    expect(res.status).toBe(303);
    expect(await getGlobalAccessRule(env.DB, idFromLocation(locationOf(res)))).toMatchObject({
      profile: 'vercel',
      issuer: 'https://oidc.vercel.com',
      tenant_pin: [{ claim: 'owner_id', match: 'exact', values: [team] }],
    });
  });

  it('asks to confirm the first ceiling of an issuer, writes nothing, then saves', async () => {
    const res = await adminPost(world.app, admin(), GLOBALS, acmeOnly());
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(confirmation(page)).toEqual({ text: FIRST_CEILING, field: 'confirm_new_ceiling' });
    expect(await globals()).toEqual([]);
    expect(await globalAudit()).toEqual([]);

    // The dialog resubmits the rendered form with its confirmation.
    const fields = await formFields(page, 'gr-form');
    expect(fields['tenants.github']).toBe(`acme (${OWNER_ID})`);
    const saved = await adminPost(world.app, admin(), GLOBALS, {
      ...fields,
      confirm_new_ceiling: '1',
    });
    expect(saved.status).toBe(303);
    const id = idFromLocation(locationOf(saved));
    expect(locationOf(saved)).toBe(`${GLOBALS}/${id}?notice=created`);
    const rule = (await getGlobalAccessRule(env.DB, id)) as GlobalAccessRule;
    expect(rule).toMatchObject({
      name: 'acme only',
      profile: 'github-actions',
      issuer: GITHUB_ISSUER,
      issuer_key: GITHUB_KEY,
      enabled: true,
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
      conditions: null,
      rules: null,
      audience: null,
    });
    expect(await globalAudit()).toEqual(['global_access_rule.create']);
    expect(await html(locationOf(saved))).toContain('Global access rule saved.');
  });

  it('asks to confirm a sibling that widens the ceiling (AR-21)', async () => {
    await seedGlobalRule(world.app.deps, {
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    const sibling = acmeOnly({ name: 'any org', 'limit.tenant_pin': '' });
    const res = await adminPost(world.app, admin(), GLOBALS, sibling);
    expect(res.status).toBe(422);
    expect(confirmation(await res.text())).toEqual({ text: WIDENING, field: 'confirm_widening' });
    expect(await globals()).toHaveLength(1);

    const saved = await adminPost(world.app, admin(), GLOBALS, {
      ...sibling,
      confirm_widening: '1',
    });
    expect(saved.status).toBe(303);
    expect(await globals()).toHaveLength(2);
  });

  it('stores each ticked limit and leaves unticked ones unlimited', async () => {
    const res = await adminPost(
      world.app,
      admin(),
      GLOBALS,
      acmeOnly({
        'limit.conditions': '1',
        'cond.0.claim': 'ref',
        'cond.0.match': 'glob',
        'cond.0.values': 'refs/heads/main, refs/heads/release/*',
        'limit.rules': '1',
        'rule.0.m': ['GET', 'POST'],
        'rule.0.path': '/repos/**',
        'limit.anchor_claims': '1',
        anchor_claims: 'repository_id, repository_owner_id',
        'limit.allowed_algs': '1',
        allowed_algs: 'RS256',
        'limit.max_token_age_seconds': '1',
        max_token_age_seconds: '600',
        // Typed but unticked: no limit.
        audience: 'https://github.com/acme',
        confirm_new_ceiling: '1',
      }),
    );
    expect(res.status).toBe(303);
    const [rule] = await globals();
    expect(rule).toMatchObject({
      conditions: [
        { claim: 'ref', match: 'glob', values: ['refs/heads/main', 'refs/heads/release/*'] },
      ],
      rules: [{ methods: ['GET', 'POST'], path: '/repos/**' }],
      anchor_claims: ['repository_id', 'repository_owner_id'],
      allowed_algs: ['RS256'],
      max_token_age_seconds: 600,
      audience: null,
      jwks_uri: null,
    });
    const page = await html(`${GLOBALS}/${rule?.id}`);
    const limits = page.slice(page.indexOf('id="limits"'), page.indexOf('id="affected"'));
    expect(limits).toContain('600 s');
    expect(limits).toContain('Not limited');
    expect(limits).toContain('audience, JWKS URI');
  });

  it('shows the field errors of ticked limits and opens the token settings', async () => {
    const res = await adminPost(
      world.app,
      admin(),
      GLOBALS,
      acmeOnly({
        'tenants.github': '',
        'limit.conditions': '1',
        'limit.rules': '1',
        'rule.0.path': '/repos/**',
        'limit.max_token_age_seconds': '1',
        max_token_age_seconds: 'soon',
        expires_on: '2020-13-40',
        confirm_new_ceiling: '1',
      }),
    );
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).toContain('The global access rule was not saved');
    expect(page).toContain('Enter at least one condition, or untick Limit workloads.');
    expect(page).toContain('Tick at least one method.');
    expect(page).toContain('Enter the maximum token age in whole seconds, like 300.');
    expect(page).toContain('Use a date like 2027-01-31.');
    expect(/<details[^>]*id="gr-token"[^>]*\sopen/.test(page)).toBe(true);
    expect(confirmation(page)).toBeNull();
    expect(await globals()).toEqual([]);
  });

  it('refuses an issuer that a CI host forces to another type', async () => {
    const res = await adminPost(
      world.app,
      admin(),
      GLOBALS,
      acmeOnly({ type: 'generic', issuer: GITHUB_ISSUER, 'limit.tenant_pin': '' }),
    );
    expect(res.status).toBe(422);
    expect(await globals()).toEqual([]);
  });
});

describe('global access rule page (§A7.5)', () => {
  it('lists the limits, the affected credential access rules and the history', async () => {
    const credentialRule = await seedCredentialRule(world.app.deps, { credential_id: serviceId });
    const rule = await seedGlobalRule(world.app.deps, {
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['999'] }],
    });
    const page = await html(`${GLOBALS}/${rule.id}`);
    expect(page).toContain('<title>acme only – Credentials – tokengate</title>');
    const affected = page.slice(page.indexOf('id="affected"'), page.indexOf('id="history"'));
    expect(affected).toContain(`href="/admin/credential-access-rules/${credentialRule.id}"`);
    expect(affected).toContain('Blocked');
    expect(page.slice(page.indexOf('id="history"'))).toContain('acme only');
    // The only rule of the issuer: delete and disable are the last ones.
    expect(page).toContain(LAST_DELETE);
    expect(page).toContain(LAST_DISABLE);
    expect(page).toContain('This is the last enabled global access rule of');
  });

  it('opens the edit form at ?open=edit with the issuer read-only', async () => {
    const rule = await seedGlobalRule(world.app.deps, { max_token_age_seconds: 300 });
    const page = await html(`${GLOBALS}/${rule.id}?open=edit`);
    expect(page).toContain('id="gr-form"');
    expect(page).toContain(
      'To move this ceiling to another issuer, add a new global access rule and delete this one.',
    );
    expect(/<input[^>]*name="issuer"[^>]*readonly/.test(page)).toBe(true);
    expect(checkedValues(page, 'limit.max_token_age_seconds')).toEqual(['1']);
    expect(inputValue(page, 'max_token_age_seconds')).toBe('300');
    expect(/<details[^>]*id="gr-token"[^>]*\sopen/.test(page)).toBe(true);
    expect(page).not.toContain('Change this rule</a>');
  });

  it('saves a tightening edit at once and asks to confirm a relaxing one', async () => {
    const rule = await seedGlobalRule(world.app.deps, { max_token_age_seconds: 300 });
    const form = await formFields(await html(`${GLOBALS}/${rule.id}?open=edit`), 'gr-form');

    const tighter = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}`, {
      ...form,
      max_token_age_seconds: '120',
    });
    expect(tighter.status).toBe(303);
    expect(locationOf(tighter)).toBe(`${GLOBALS}/${rule.id}?notice=updated`);
    const tightened = (await getGlobalAccessRule(env.DB, rule.id)) as GlobalAccessRule;
    expect(tightened.max_token_age_seconds).toBe(120);

    const relaxed = {
      ...form,
      'limit.max_token_age_seconds': '',
      expected_updated_at: String(tightened.updated_at),
    };
    const res = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}`, relaxed);
    expect(res.status).toBe(422);
    expect(confirmation(await res.text())).toEqual({ text: WIDENING, field: 'confirm_widening' });
    expect(await getGlobalAccessRule(env.DB, rule.id)).toEqual(tightened);

    const saved = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}`, {
      ...relaxed,
      confirm_widening: '1',
    });
    expect(saved.status).toBe(303);
    expect((await getGlobalAccessRule(env.DB, rule.id))?.max_token_age_seconds).toBeNull();
  });

  it('says nothing changed for an unchanged save and refuses a stale one', async () => {
    const rule = await seedGlobalRule(world.app.deps);
    const form = await formFields(await html(`${GLOBALS}/${rule.id}?open=edit`), 'gr-form');
    const same = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}`, form);
    expect(locationOf(same)).toBe(`${GLOBALS}/${rule.id}?notice=unchanged`);
    expect(await globalAudit()).toEqual(['global_access_rule.create']);

    await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}`, { ...form, name: 'renamed' });
    const stale = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}`, {
      ...form,
      name: 'renamed again',
    });
    expect(stale.status).toBe(409);
    expect((await getGlobalAccessRule(env.DB, rule.id))?.name).toBe('renamed');
  });

  it('disables the last enabled rule only with its confirmation (AR-4)', async () => {
    const rule = await seedGlobalRule(world.app.deps);
    const toggle = `${GLOBALS}/${rule.id}/toggle`;
    const refused = await adminPost(world.app, admin(), toggle, { enabled: '0' });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain(LAST_DISABLE);
    expect((await getGlobalAccessRule(env.DB, rule.id))?.enabled).toBe(true);

    const done = await adminPost(world.app, admin(), toggle, {
      enabled: '0',
      confirm_last_disable: '1',
    });
    expect(locationOf(done)).toBe(`${GLOBALS}/${rule.id}?notice=disabled`);
    expect((await getGlobalAccessRule(env.DB, rule.id))?.enabled).toBe(false);
  });

  it('disables a rule with an enabled sibling at once', async () => {
    const rule = await seedGlobalRule(world.app.deps);
    await seedGlobalRule(world.app.deps, { name: 'sibling' });
    const page = await html(`${GLOBALS}/${rule.id}`);
    expect(page).not.toContain(LAST_DISABLE);
    const done = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}/toggle`, {
      enabled: '0',
    });
    expect(done.status).toBe(303);
    expect((await getGlobalAccessRule(env.DB, rule.id))?.enabled).toBe(false);
  });

  it('enables a rule only with the widening confirmation (AR-21)', async () => {
    const rule = await seedGlobalRule(world.app.deps, { enabled: false });
    const page = await html(`${GLOBALS}/${rule.id}`);
    const dialog = page.slice(page.indexOf('id="dlg-enable-global"'));
    expect(dialog).toContain(WIDENING);
    expect(dialog).toContain('name="confirm_widening" value="1"');

    const refused = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}/toggle`, {
      enabled: '1',
    });
    expect(refused.status).toBe(422);
    expect((await getGlobalAccessRule(env.DB, rule.id))?.enabled).toBe(false);
    const done = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}/toggle`, {
      enabled: '1',
      confirm_widening: '1',
    });
    expect(locationOf(done)).toBe(`${GLOBALS}/${rule.id}?notice=enabled`);
    expect((await getGlobalAccessRule(env.DB, rule.id))?.enabled).toBe(true);
  });

  it('deletes the last rule of an issuer only with the widening confirmation', async () => {
    const rule = await seedGlobalRule(world.app.deps);
    const remove = `${GLOBALS}/${rule.id}/delete`;
    const page = await html(`${GLOBALS}/${rule.id}`);
    const dialog = page.slice(page.indexOf('id="dlg-delete-global"'));
    expect(dialog).toContain(LAST_DELETE);
    expect(dialog).toContain('name="confirm_widening" value="1"');

    expect((await adminPost(world.app, admin(), remove, {})).status).toBe(400);
    const refused = await adminPost(world.app, admin(), remove, { confirm: '1' });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain(LAST_DELETE);
    expect(await globals()).toHaveLength(1);

    const done = await adminPost(world.app, admin(), remove, {
      confirm: '1',
      confirm_widening: '1',
    });
    expect(locationOf(done)).toBe(`${GLOBALS}?notice=deleted_last`);
    expect(await globals()).toEqual([]);
    expect(await html(locationOf(done))).toContain('Its issuer has no global access rule now');
  });

  it('deletes a rule with a sibling without the widening confirmation', async () => {
    const rule = await seedGlobalRule(world.app.deps);
    await seedGlobalRule(world.app.deps, { name: 'sibling' });
    const page = await html(`${GLOBALS}/${rule.id}`);
    expect(page).not.toContain(LAST_DELETE);
    const done = await adminPost(world.app, admin(), `${GLOBALS}/${rule.id}/delete`, {
      confirm: '1',
    });
    expect(locationOf(done)).toBe(`${GLOBALS}?notice=deleted`);
    expect(await globals()).toHaveLength(1);
  });

  it('is a 404 for an unknown id, on every route', async () => {
    const missing = `${GLOBALS}/gar_00000000000000000000000000`;
    expect((await adminGet(world.app, admin(), missing)).status).toBe(404);
    for (const path of [missing, `${missing}/toggle`]) {
      const res = await adminPost(world.app, admin(), path, { enabled: '0', name: 'x' });
      expect(res.status, path).toBe(404);
    }
    const res = await adminPost(world.app, admin(), `${missing}/delete`, {
      confirm: '1',
      confirm_widening: '1',
    });
    expect(res.status).toBe(404);
  });

  it('escapes names and descriptions', async () => {
    const rule = await seedGlobalRule(world.app.deps, {
      name: '<script>alert(1)</script>',
      description: '"><img src=x onerror=alert(1)>',
    });
    for (const path of [GLOBALS, `${GLOBALS}/${rule.id}`, `${GLOBALS}/${rule.id}?open=edit`]) {
      const page = await html(path);
      expect(page, path).not.toContain('<script>alert(1)');
      expect(page, path).not.toContain('<img src=x');
      expect(page, path).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });
});
