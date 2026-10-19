// Credential access rule pages through the real app (§A7.6-A7.8): RBAC, the list with its filters
// (Stable filter layout), the merged form per issuer type, field errors, the rule page and its
// edit form at ?open=edit, enable and disable, tenants, copy, prefill from a verified request
// (I-LOG-2), delete, the global access rule status (AR-8) and escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCredentialAccessRule, listCredentialAccessRules } from '../../src/db/access-rules';
import type { CredentialAccessRule } from '../../src/db/types';
import { WORLD_SECRET } from '../fixtures/admin-forms';
import {
  auditActions,
  BUILDKITE_ISSUER,
  checkedValues,
  formFields,
  idFromLocation,
  inputValue,
  labels,
  locationOf,
  requestRecord,
  type RulesWorld,
  rulesWorld,
  seedLabel,
  seedRequests,
} from '../helpers/access-rules';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  OWNER_ID,
  REPOSITORY_ID,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
} from '../unit/admin/ops/helpers';

let world: RulesWorld;
let serviceId: string;

beforeEach(async () => {
  world = await rulesWorld(
    {},
    { id_token_signing_alg_values_supported: ['ES256', 'none', 'RS256', 'HS256'] },
  );
  // A credential with a secret: its rules are active, not inactive.
  serviceId = await seedService(world.app.deps, { secret: WORLD_SECRET });
});

const RULES = '/admin/credential-access-rules';
const J = 'new.github-actions.';
const admin = () => world.sessions.admin;
const viewer = () => world.sessions.viewer;

/** The structured GitHub form: organization acme, repository acme/api, branch main. */
function github(overrides: Record<string, string | string[]> = {}) {
  return {
    token_id: serviceId,
    token_view: 'fixed',
    'new.type': 'github-actions',
    'new.github_org': `acme (${OWNER_ID})`,
    [`${J}editor`]: 'structured',
    [`${J}repository`]: `acme/api (${REPOSITORY_ID})`,
    [`${J}context`]: 'branch',
    [`${J}branch`]: 'main',
    [`${J}ref_protection`]: 'protected',
    ops: '1',
    op: 'read-repo',
    expires: 'never',
    ...overrides,
  };
}

async function create(overrides: Record<string, string | string[]> = {}) {
  const res = await adminPost(world.app, admin(), RULES, github(overrides));
  expect(res.status).toBe(303);
  return (await getCredentialAccessRule(
    env.DB,
    idFromLocation(locationOf(res)),
  )) as CredentialAccessRule;
}

async function html(path: string, session = admin()): Promise<string> {
  return (await adminGet(world.app, session, path)).text();
}

const ruleAudit = async () =>
  (await auditActions()).filter((action) => action.startsWith('credential_access_rule.'));

describe('credential access rules: who may change them', () => {
  it('a viewer and a credential manager read the list and the page but change nothing', async () => {
    const rule = await seedCredentialRule(world.app.deps, { credential_id: serviceId });
    const before = await auditActions();
    for (const session of [viewer(), world.sessions.token_manager]) {
      const list = await html(RULES, session);
      expect(list).toContain(rule.name);
      expect(list).not.toContain('Add credential access rule</a>');
      const page = await html(`${RULES}/${rule.id}`, session);
      expect(page).toContain(rule.audience);
      expect(page).not.toContain('Copy to another credential…');
      expect(page).not.toContain('commandfor="dlg-delete-rule"');
      expect((await adminGet(world.app, session, `${RULES}/new`)).status).toBe(403);
      for (const path of [
        RULES,
        `${RULES}/${rule.id}`,
        `${RULES}/${rule.id}/tenants`,
        `${RULES}/${rule.id}/copy`,
        `${RULES}/${rule.id}/toggle`,
        `${RULES}/${rule.id}/delete`,
      ]) {
        const res = await adminPost(world.app, session, path, {
          ...github(),
          intent: 'add',
          tenant: 'x (1)',
          enabled: '0',
          confirm: '1',
          credential_id: '',
        });
        expect(res.status, path).toBe(403);
      }
    }
    expect(await auditActions()).toEqual(before);
  });

  it('an access manager adds a rule; the empty state names who to ask', async () => {
    const empty = await html(RULES, viewer());
    expect(empty).toContain(
      'No credential access rules. A workload can use a credential only through one.',
    );
    expect(empty).toContain('Only access managers');
    expect(await html(RULES, world.sessions.access_manager)).toContain(`href="${RULES}/new">`);
    const res = await adminPost(world.app, world.sessions.access_manager, RULES, github());
    expect(res.status).toBe(303);
  });

  it('asks for a credential first when there is none', async () => {
    await env.DB.prepare('DELETE FROM credentials').run();
    const page = await html(RULES);
    expect(page).toContain('A credential manager must add a credential first.');
    expect(page).toContain('href="/admin/credentials/new"');
  });

  it('refuses mutations without the CSRF token (I-CSRF-1)', async () => {
    const rule = await seedCredentialRule(world.app.deps, { credential_id: serviceId });
    const before = await auditActions();
    for (const path of [
      RULES,
      `${RULES}/${rule.id}`,
      `${RULES}/${rule.id}/tenants`,
      `${RULES}/${rule.id}/copy`,
      `${RULES}/${rule.id}/toggle`,
      `${RULES}/${rule.id}/delete`,
    ]) {
      const res = await adminPost(
        world.app,
        admin(),
        path,
        { ...github(), intent: 'add', tenant: 'x (1)', enabled: '0', confirm: '1' },
        { csrf: null },
      );
      expect(res.status, path).toBe(403);
    }
    expect(await auditActions()).toEqual(before);
    expect((await getCredentialAccessRule(env.DB, rule.id))?.enabled).toBe(true);
  });
});

describe('credential access rules: add', () => {
  it('renders the merged form: credential, issuer cards, jobs, operations, name, token settings', async () => {
    const page = await html(`${RULES}/new?credential=${serviceId}&type=gitlab-ci`);
    // form-layout is the page grid of the form column and the summary rail.
    expect(page).toContain(
      '<form class="lform form-layout ga-form" method="post" action="/admin/credential-access-rules" id="rule-form">',
    );
    for (const type of ['github-actions', 'gitlab-ci', 'generic']) {
      expect(page).toContain(`name="new.type" value="${type}"`);
    }
    expect(page).toMatch(/name="new\.type" value="gitlab-ci" checked/);
    expect(page).toContain('name="name"');
    expect(page).toContain('name="audience"');
    expect(page).toContain('name="jwks_uri"');
    // Token settings is a closed disclosure while nothing in it has an error.
    expect(page).toMatch(/<details[^>]*id="ga-settings"(?![^>]*open)/);
    expect(page).toContain(`gh api orgs/acme --jq &#39;&quot;\\(.login) (\\(.id))&quot;&#39;`);
  });

  it('creates a GitHub rule: derived name, labels, one audit row, the snippet on its page', async () => {
    const res = await adminPost(world.app, admin(), RULES, github());
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(
      /^\/admin\/credential-access-rules\/acr_[0-9A-Z]{26}\?notice=created$/,
    );
    const rule = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(rule).toMatchObject({
      credential_id: serviceId,
      name: 'GitHub for acme/api (branch main)',
      profile: 'github-actions',
      issuer: 'https://token.actions.githubusercontent.com',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
      enabled: true,
      expires_at: null,
      rules: [{ methods: ['GET'], path: '/repos/acme/api/**' }],
    });
    expect(rule?.conditions).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] },
      { claim: 'repository_id', match: 'exact', values: [REPOSITORY_ID] },
      { claim: 'ref_type', match: 'exact', values: ['branch'] },
      { claim: 'ref', match: 'glob', values: ['refs/heads/main'] },
      { claim: 'event_name', match: 'exact', values: ['push', 'workflow_dispatch', 'schedule'] },
      { claim: 'ref_protected', match: 'exact', values: ['true'] },
    ]);
    expect(await labels(rule?.id)).toEqual(
      expect.arrayContaining([
        { claim: 'repository_id', value: REPOSITORY_ID, label: 'acme/api' },
        { claim: 'repository_owner_id', value: OWNER_ID, label: 'acme' },
      ]),
    );
    expect(await ruleAudit()).toEqual(['credential_access_rule.create']);
    const page = await html(locationOf(res));
    expect(page).toContain('Access rule created.');
    expect(page).toContain('id="snippet"');
    expect(page).toContain('outputs.proxy-base }}/github/&lt;path&gt;');
    expect(page).toContain('Not limited: github.com has no global access rule.');
  });

  it('re-renders field errors with the typed values, writing nothing', async () => {
    const res = await adminPost(
      world.app,
      admin(),
      RULES,
      github({ [`${J}repository`]: 'not a repository', [`${J}branch`]: 'release/<b>' }),
    );
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).toContain('<title>Error: ');
    expect(inputValue(page, `${J}repository`)).toBe('not a repository');
    expect(page).toContain('href="#f-new-github-actions-repository"');
    expect(inputValue(page, `${J}branch`)).toBe('release/&lt;b&gt;');
    expect(page).not.toContain('release/<b>');
    expect(await listCredentialAccessRules(env.DB)).toEqual([]);
    expect(await ruleAudit()).toEqual([]);
  });

  it('asks to choose an operation when none is chosen', async () => {
    const res = await adminPost(world.app, admin(), RULES, github({ op: '' }));
    expect(res.status).toBe(422);
    expect(await listCredentialAccessRules(env.DB)).toEqual([]);
  });

  it('creates a GitLab rule for gitlab.com; a self-managed issuer without discovery writes nothing', async () => {
    const G = 'new.gitlab-ci.';
    const gitlab = (extra: Record<string, string>) => ({
      token_id: serviceId,
      'new.type': 'gitlab-ci',
      'new.gitlab_group': 'acme-group (5678901)',
      [`${G}editor`]: 'structured',
      [`${G}repository`]: 'acme-group/api (77)',
      [`${G}context`]: 'branch',
      [`${G}branch`]: 'main',
      [`${G}ref_protection`]: 'protected',
      ops: '1',
      op: 'custom',
      'rule.0.m': 'GET',
      'rule.0.path': '/rate_limit',
      expires: 'never',
      ...extra,
    });
    const com = await adminPost(world.app, admin(), RULES, gitlab({}));
    expect(com.status).toBe(303);
    expect(await getCredentialAccessRule(env.DB, idFromLocation(locationOf(com)))).toMatchObject({
      profile: 'gitlab-ci',
      issuer: 'https://gitlab.com',
      tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['5678901'] }],
    });
    const selfManaged = await adminPost(
      world.app,
      admin(),
      RULES,
      gitlab({ 'new.gitlab_url': 'https://gitlab.example.com/', name: 'self-managed' }),
    );
    expect(selfManaged.status).toBe(422);
    expect(await selfManaged.text()).toContain('href="#f-');
    expect(await ruleAudit()).toEqual(['credential_access_rule.create']);
  });

  it('creates a generic rule: the issuer preset gives the anchor, discovery the algorithms', async () => {
    const res = await adminPost(world.app, admin(), RULES, {
      token_id: serviceId,
      'new.type': 'generic',
      'new.generic_issuer': BUILDKITE_ISSUER,
      'new.generic_pin_value': 'org-uuid',
      'new.generic.editor': 'rows',
      'new.generic.cond.0.claim': 'pipeline_id',
      'new.generic.cond.0.match': 'exact',
      'new.generic.cond.0.values': 'pipe-1',
      ops: '1',
      op: 'custom',
      'rule.0.m': 'GET',
      'rule.0.path': '/rate_limit',
      expires: 'never',
      acknowledge_warnings: '1',
    });
    if (res.status === 422) {
      // The rows editor asks for the risk acceptance first: accept it like a browser does.
      const page = await res.text();
      const retry = await adminPost(world.app, admin(), RULES, {
        ...(await formFields(page, 'rule-form')),
        acknowledge_warnings: '1',
      });
      expect(retry.status).toBe(303);
    } else {
      expect(res.status).toBe(303);
    }
    const [rule] = await listCredentialAccessRules(env.DB);
    expect(rule).toMatchObject({
      profile: 'generic',
      issuer: BUILDKITE_ISSUER,
      anchor_claims: ['pipeline_id'],
      tenant_pin: [{ claim: 'organization_id', match: 'exact', values: ['org-uuid'] }],
      // Discovery listed ES256, none, RS256 and HS256: only the I-JWT-1 algorithms are kept.
      allowed_algs: ['RS256', 'ES256'],
      jwks_uri: `${BUILDKITE_ISSUER}/.well-known/jwks`,
    });
  });

  it('asks for the pin value next to its field when only the claim is given', async () => {
    const res = await adminPost(world.app, admin(), RULES, {
      token_id: serviceId,
      'new.type': 'generic',
      'new.generic_issuer': BUILDKITE_ISSUER,
      'new.generic_pin_claim': 'organization_id',
      ops: '1',
      op: 'custom',
      'rule.0.m': 'GET',
      'rule.0.path': '/rate_limit',
      expires: 'never',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Enter the value of organization_id.');
  });

  it('expires on a chosen day at the next 00:00 UTC, and refuses a past day', async () => {
    const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const rule = await create({ expires: 'date', expires_on: day });
    expect(rule.expires_at).toBe(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
    const past = await adminPost(
      world.app,
      admin(),
      RULES,
      github({ expires: 'date', expires_on: '2001-01-01', name: 'past' }),
    );
    expect(past.status).toBe(422);
    expect(await past.text()).toContain('Choose a day from tomorrow to 5 years ahead.');
    expect(await listCredentialAccessRules(env.DB)).toHaveLength(1);
  });

  it('keeps the audience of the newest rule of the same credential and issuer (AR-10)', async () => {
    const first = await create();
    const second = await create({ [`${J}branch`]: 'dev', name: 'dev branch' });
    expect(second.audience).toBe(first.audience);
    expect(second.jwks_uri).toBe(first.jwks_uri);
  });
});

describe('credential access rules: list and filters', () => {
  it('lists every rule with its credential, issuer, jobs, operations, global status and status', async () => {
    const rule = await create();
    const page = await html(RULES);
    expect(page).toContain('id="rule-list"');
    for (const column of [
      'Rule',
      'Credential',
      'Issuer',
      'Jobs',
      'Operations',
      'Global',
      'Status',
    ]) {
      expect(page).toContain(`>${column}</th>`);
    }
    expect(page).toContain(`href="${RULES}/${rule.id}"`);
    expect(page).toContain('Read repository contents');
    expect(page).toContain('<span class="meta">Not limited</span>');
  });

  it('filters by credential, issuer and status; chips follow the controls, which stay in place', async () => {
    const other = await seedService(world.app.deps, { slug: 'other', name: 'Other' });
    const first = await create();
    const second = await create({ token_id: other, name: 'other rule' });
    const all = await html(RULES);
    const filtered = await html(`${RULES}?credential=${other}`);
    expect(filtered).toContain(`href="${RULES}/${second.id}"`);
    expect(filtered).not.toContain(`href="${RULES}/${first.id}"`);
    expect(filtered).toContain('Credential: Other');
    // The quick links, the menus and their counts are the same as without the filter.
    const controls = (page: string) =>
      page.slice(
        page.indexOf('aria-label="Filter credential access rules by status"'),
        page.indexOf('Credential: Other') > 0 ? page.indexOf('Credential: Other') : undefined,
      );
    expect(controls(filtered).indexOf('Filter by')).toBeGreaterThan(0);
    expect(controls(all)).toContain('All');
    expect(filtered.indexOf('Credential: Other')).toBeGreaterThan(
      filtered.indexOf('aria-label="Filter credential access rules"'),
    );
    expect(filtered).toContain('>Clear filters<');
    const byIssuer = await html(
      `${RULES}?issuer=https%3A%2F%2Ftoken.actions.githubusercontent.com`,
    );
    expect(byIssuer).toContain(`href="${RULES}/${first.id}"`);
    expect(byIssuer).toContain(`href="${RULES}/${second.id}"`);
    const disabled = await html(`${RULES}?status=disabled&credential=${other}`);
    expect(disabled).toContain('No credential access rule matches these filters.');
    expect(disabled).toContain('Status: Disabled');
  });

  it('ignores unknown ids with a note', async () => {
    await create();
    const page = await html(`${RULES}?credential=svc_gone&issuer=https%3A%2F%2Fnowhere.example`);
    expect(page).toContain('That credential no longer exists.');
    expect(page).toContain('No credential access rule uses that issuer.');
    expect(page).not.toContain('Credential: svc_gone');
  });

  it('?view=map and ?view=matrix render the list until WP-R3', async () => {
    const rule = await create();
    for (const view of ['map', 'matrix']) {
      const page = await html(`${RULES}?view=${view}`);
      expect(page).toContain('id="rule-list"');
      expect(page).toContain(`href="${RULES}/${rule.id}"`);
    }
  });
});

describe('credential access rules: global access rules (AR-8)', () => {
  it('saves a rule that a global rule blocks, with the warning, and shows Blocked everywhere', async () => {
    const global = await seedGlobalRule(world.app.deps, {
      name: 'other owner only',
      issuer: 'https://token.actions.githubusercontent.com',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['999'] }],
    });
    // A failed save (the risk is not accepted yet) shows the global status in the rail.
    const failed = await adminPost(world.app, admin(), RULES, {
      ...github(),
      [`${J}editor`]: 'rows',
      [`${J}cond.0.claim`]: 'repository_owner_id',
      [`${J}cond.0.values`]: OWNER_ID,
      [`${J}cond.1.claim`]: 'repository_id',
      [`${J}cond.1.values`]: REPOSITORY_ID,
      op: 'custom',
      'rule.0.m': 'GET',
      'rule.0.path': '/repos/acme/api',
    });
    expect(failed.status).toBe(422);
    expect(await failed.text()).toContain('Global access rules</a>: blocked.</span>');
    const rule = await create();
    const page = await html(`${RULES}/${rule.id}`);
    expect(page).toContain('Blocked by the global access rules of its issuer:');
    expect(page).toContain(`href="/admin/global-access-rules/${global.id}"`);
    const list = await html(RULES);
    expect(list).toContain('Blocked<span class="vh"> by global access rules</span></a>');
    expect(await html(`${RULES}?status=blocked`)).toContain(`href="${RULES}/${rule.id}"`);
    expect(await html(`${RULES}?status=active`)).not.toContain(`href="${RULES}/${rule.id}"`);
  });

  it('shows Within when a global rule holds for the rule', async () => {
    await seedGlobalRule(world.app.deps, {
      name: 'acme only',
      issuer: 'https://token.actions.githubusercontent.com',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    const rule = await create();
    expect(await html(RULES)).toContain('Within<span class="vh"> global access rules</span></a>');
    expect(await html(`${RULES}/${rule.id}`)).toContain('id="global"');
  });
});

describe('credential access rules: the rule page', () => {
  it('has the sections of §A7.8 and one rail', async () => {
    const rule = await create();
    const page = await html(`${RULES}/${rule.id}`);
    for (const id of [
      'tenants',
      'jobs',
      'operations',
      'snippet',
      'requests',
      'history',
      'danger',
    ]) {
      expect(page, id).toContain(`id="${id}"`);
    }
    for (const id of ['status', 'global', 'trust']) expect(page, id).toContain(`id="${id}"`);
    expect(page).toContain(`href="/admin/credentials/${serviceId}"`);
    expect(page).toContain('Exact conditions');
    expect(page).toContain('Copy to another credential…');
    expect(page).not.toContain('form-layout');
  });

  it('opens the merged edit form at ?open=edit and saves a change, audited once', async () => {
    const rule = await create();
    const page = await html(`${RULES}/${rule.id}?open=edit`);
    expect(page).toMatch(/<form[^>]*id="rule-edit"/);
    expect(page).not.toContain('form-layout');
    const fields = await formFields(page, 'rule-edit');
    expect(fields.expected_updated_at).toBe(String(rule.updated_at));
    // An unchanged save writes nothing.
    const same = await adminPost(world.app, admin(), `${RULES}/${rule.id}`, {
      ...fields,
      intent: 'save',
    });
    expect(same.status).toBe(303);
    expect(await ruleAudit()).toEqual(['credential_access_rule.create']);
    const changed = await adminPost(world.app, admin(), `${RULES}/${rule.id}`, {
      ...fields,
      intent: 'save',
      [`${J}branch`]: 'release',
      name: 'release branch',
    });
    expect(changed.status).toBe(303);
    const stored = await getCredentialAccessRule(env.DB, rule.id);
    expect(stored?.name).toBe('release branch');
    expect(stored?.conditions).toContainEqual({
      claim: 'ref',
      match: 'glob',
      values: ['refs/heads/release'],
    });
    expect(await ruleAudit()).toEqual([
      'credential_access_rule.create',
      'credential_access_rule.update',
    ]);
    // A save from the page opened before that change is refused and writes nothing.
    const stale = await adminPost(world.app, admin(), `${RULES}/${rule.id}`, {
      ...fields,
      intent: 'save',
      name: 'stale',
    });
    expect(stale.status).toBe(409);
    expect((await getCredentialAccessRule(env.DB, rule.id))?.name).toBe('release branch');
  });

  it('disables and enables again, audited', async () => {
    const rule = await create();
    const off = await adminPost(world.app, admin(), `${RULES}/${rule.id}/toggle`, { enabled: '0' });
    expect(off.status).toBe(303);
    expect(locationOf(off)).toContain('notice=disabled');
    expect((await getCredentialAccessRule(env.DB, rule.id))?.enabled).toBe(false);
    expect(await html(`${RULES}?status=disabled`)).toContain(`href="${RULES}/${rule.id}"`);
    const on = await adminPost(world.app, admin(), `${RULES}/${rule.id}/toggle`, { enabled: '1' });
    expect(locationOf(on)).toContain('notice=enabled');
    expect((await getCredentialAccessRule(env.DB, rule.id))?.enabled).toBe(true);
    expect(await ruleAudit()).toEqual([
      'credential_access_rule.create',
      'credential_access_rule.disable',
      'credential_access_rule.enable',
    ]);
  });

  it('adds and removes organizations, keeping at least one', async () => {
    const rule = await create();
    const add = await adminPost(world.app, admin(), `${RULES}/${rule.id}/tenants`, {
      intent: 'add',
      tenant: 'acme-labs (7654321)',
      expected_updated_at: String(rule.updated_at),
    });
    expect(add.status).toBe(303);
    const added = await getCredentialAccessRule(env.DB, rule.id);
    expect(added?.tenant_pin[0]?.values).toEqual([OWNER_ID, '7654321']);
    const remove = await adminPost(world.app, admin(), `${RULES}/${rule.id}/tenants`, {
      intent: 'remove',
      remove: '7654321',
      expected_updated_at: String(added?.updated_at),
    });
    expect(remove.status).toBe(303);
    expect((await getCredentialAccessRule(env.DB, rule.id))?.tenant_pin[0]?.values).toEqual([
      OWNER_ID,
    ]);
  });

  it('copies a rule to another credential or to the same one', async () => {
    const other = await seedService(world.app.deps, { slug: 'other', name: 'Other' });
    const rule = await create();
    const page = await html(`${RULES}/${rule.id}`);
    expect(page).toContain('id="dlg-copy-rule"');
    const res = await adminPost(world.app, admin(), `${RULES}/${rule.id}/copy`, {
      credential_id: other,
    });
    expect(res.status).toBe(303);
    const copy = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(copy).toMatchObject({
      credential_id: other,
      issuer: rule.issuer,
      tenant_pin: rule.tenant_pin,
      conditions: rule.conditions,
      enabled: true,
    });
    const same = await adminPost(world.app, admin(), `${RULES}/${rule.id}/copy`, {
      credential_id: '',
    });
    expect(same.status).toBe(303);
    expect(await listCredentialAccessRules(env.DB, { credential_id: serviceId })).toHaveLength(2);
    expect(await ruleAudit()).toEqual([
      'credential_access_rule.create',
      'credential_access_rule.duplicate',
      'credential_access_rule.duplicate',
    ]);
  });

  it('deletes only with the confirmation; unknown ids are 404', async () => {
    const rule = await create();
    const unconfirmed = await adminPost(world.app, admin(), `${RULES}/${rule.id}/delete`, {});
    expect(unconfirmed.status).toBe(400);
    expect(await getCredentialAccessRule(env.DB, rule.id)).not.toBeNull();
    const res = await adminPost(world.app, admin(), `${RULES}/${rule.id}/delete`, { confirm: '1' });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`${RULES}?notice=deleted`);
    expect(await getCredentialAccessRule(env.DB, rule.id)).toBeNull();
    expect(await labels(rule.id)).toEqual([]);
    for (const path of [`${RULES}/acr_01JUNKNOWN0000000000000000`, `${RULES}/${rule.id}`]) {
      expect((await adminGet(world.app, admin(), path)).status, path).toBe(404);
      expect((await adminPost(world.app, admin(), `${path}/toggle`, { enabled: '0' })).status).toBe(
        404,
      );
    }
  });

  it('escapes names and labels on the list, the page and the form', async () => {
    const rule = await create({ name: '<script>alert(1)</script>' });
    await seedLabel(rule.id, 'repository_id', REPOSITORY_ID, '<img src=x>');
    for (const path of [RULES, `${RULES}/${rule.id}`, `${RULES}/${rule.id}?open=edit`]) {
      const page = await html(path);
      expect(page, path).not.toContain('<script>alert(1)');
      expect(page, path).not.toContain('<img src=x>');
      expect(page, path).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });
});

describe('I-LOG-2: a rule from a request, verified records only', () => {
  const claims = {
    sub: 'repo:acme/app:ref:refs/heads/main',
    repository: 'acme/app',
    repository_id: REPOSITORY_ID,
    repository_owner_id: OWNER_ID,
    ref: 'refs/heads/main',
    ref_type: 'branch',
    ref_protected: 'true',
    event_name: 'push',
  };
  let source: CredentialAccessRule;

  beforeEach(async () => {
    source = await seedCredentialRule(world.app.deps, { credential_id: serviceId });
  });

  async function record(id: string, overrides: object = {}) {
    await seedRequests([
      requestRecord({
        id,
        service_id: serviceId,
        credential_access_rule_id: source.id,
        caller_claims: JSON.stringify(claims),
        ...overrides,
      }),
    ]);
  }

  it('prefills the structured fields and the call as an operation, writing nothing', async () => {
    await record('req_01JTESTREQUEST00000000000B', {
      path: '/repos/acme/app/contents',
      method: 'GET',
    });
    const page = await html(`${RULES}/new?from_request=req_01JTESTREQUEST00000000000B`);
    expect(page).toContain('Prefilled from request');
    expect(inputValue(page, `${J}repository`)).toBe(`acme/app (${REPOSITORY_ID})`);
    expect(checkedValues(page, `${J}context`)).toEqual(['branch']);
    expect(inputValue(page, `${J}branch`)).toBe('main');
    expect(inputValue(page, 'rule.0.path')).toBe('/repos/acme/app/contents');
    expect(await labels()).toEqual([]);
    expect(await listCredentialAccessRules(env.DB)).toHaveLength(1);
  });

  it.each(['/repos/acme/app/**', '/repos/acme/app/contents/a%2Fb'])(
    'does not prefill an operation for the path %s',
    async (path) => {
      await record('req_01JTESTREQUEST00000000000C', { path });
      const page = await html(`${RULES}/new?from_request=req_01JTESTREQUEST00000000000C`);
      expect(page).toContain('No operation was prefilled');
      expect(page).not.toContain(`value="${path}"`);
    },
  );

  it('opens the rows editor with the risk acceptance for an untrusted event', async () => {
    await record('req_01JTESTREQUEST00000000000D', {
      reason: 'event_not_trusted',
      caller_claims: JSON.stringify({ ...claims, event_name: 'workflow_run' }),
    });
    const page = await html(`${RULES}/new?from_request=req_01JTESTREQUEST00000000000D`);
    expect(page).toContain(`name="${J}editor" value="rows"`);
    expect(page).toContain('value="workflow_run"');
    expect(page).toContain('name="warnings_digest"');
    expect(page).toMatch(/name="acknowledge_warnings"[^>]*required/);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unverified record', { claims_verified: 0 }],
    ['another reason', { reason: 'service_disabled' }],
    ['a deleted credential access rule', { credential_access_rule_id: 'acr_gone' }],
  ])('refuses %s with 400', async (_name, overrides) => {
    await record('req_01JTESTREQUEST00000000000E', overrides);
    const res = await adminGet(
      world.app,
      admin(),
      `${RULES}/new?from_request=req_01JTESTREQUEST00000000000E`,
    );
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain('<title>Error: Cannot give access from this request');
    expect(page).toContain('This request cannot prefill the form.');
  });
});

describe('credential access rules: the jobs editors', () => {
  it('converts the structured input to rows without losing it, then saves rows (I-AUTHZ-2)', async () => {
    const rows = await adminPost(world.app, admin(), RULES, {
      ...github({ [`${J}context`]: 'environment', [`${J}environment`]: 'production' }),
      _action: 'rows',
    });
    expect(rows.status).toBe(200);
    const page = await rows.text();
    expect(page).toContain(`name="${J}editor" value="rows"`);
    expect(page).toContain('value="production"');
    expect(page).toContain(`value="${REPOSITORY_ID}"`);
    expect(await ruleAudit()).toEqual([]);

    const base = {
      ...github(),
      [`${J}editor`]: 'rows',
      op: 'custom',
      'rule.0.m': ['GET', 'HEAD'],
      'rule.0.path': '/repos/acme/**',
      acknowledge_warnings: '1',
    };
    const unanchored = await adminPost(world.app, admin(), RULES, {
      ...base,
      [`${J}cond.0.claim`]: 'repository_id',
      [`${J}cond.0.values`]: REPOSITORY_ID,
    });
    expect(unanchored.status).toBe(422);
    const body = await unanchored.text();
    expect(body).toContain('I-AUTHZ-2');
    expect(body).toContain('href="#f-new-github-actions-cond-0-values"');
    const fields = {
      ...base,
      [`${J}cond.0.claim`]: 'repository_owner_id',
      [`${J}cond.0.values`]: OWNER_ID,
      [`${J}cond.1.claim`]: 'repository_id',
      [`${J}cond.1.values`]: `${REPOSITORY_ID}, 5`,
      [`${J}cond.2.claim`]: 'ref_protected',
      [`${J}cond.2.values`]: 'true',
    };
    const first = await adminPost(world.app, admin(), RULES, fields);
    const digest = inputValue(await first.text(), 'warnings_digest') ?? '';
    const saved = await adminPost(world.app, admin(), RULES, {
      ...fields,
      warnings_digest: digest,
    });
    expect(saved.status).toBe(303);
    const rule = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(saved)));
    expect(rule?.conditions[1]).toEqual({
      claim: 'repository_id',
      match: 'exact',
      values: [REPOSITORY_ID, '5'],
    });
    expect(rule?.rules).toEqual([{ methods: ['GET', 'HEAD'], path: '/repos/acme/**' }]);
  });

  it('saves a workflow pin without a repository: every repository of the organization', async () => {
    const workflow = 'acme/infra/.github/workflows/deploy.yml@refs/heads/main';
    const res = await adminPost(world.app, admin(), RULES, {
      ...github({ [`${J}repository`]: '', [`${J}workflow_ref`]: workflow }),
      op: 'custom',
      'rule.0.m': 'GET',
      'rule.0.path': '/repos/acme/**',
    });
    expect(res.status).toBe(303);
    const rule = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(rule?.conditions).toContainEqual({
      claim: 'repository_owner_id',
      match: 'exact',
      values: [OWNER_ID],
    });
    expect(rule?.conditions).toContainEqual({
      claim: 'job_workflow_ref',
      match: 'exact',
      values: [workflow],
    });
    expect(rule?.conditions.some((c) => c.claim === 'repository_id')).toBe(false);
  });

  it('shows Expired and the inactive cause as words', async () => {
    const rule = await create();
    await env.DB.prepare('UPDATE access_rules SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1000, rule.id)
      .run();
    expect(await html(`${RULES}/${rule.id}`)).toContain('Expired');
    await env.DB.prepare('UPDATE access_rules SET expires_at = NULL WHERE id = ?')
      .bind(rule.id)
      .run();
    await env.DB.prepare('UPDATE credentials SET enabled = 0 WHERE id = ?').bind(serviceId).run();
    const page = await html(`${RULES}/${rule.id}`);
    expect(page).toContain('Inactive: credential disabled');
    expect(page).toContain('Inactive because the credential is disabled:');
  });

  it('shows the denied request in the rail of a form prefilled from it', async () => {
    const source = await seedCredentialRule(world.app.deps, { credential_id: serviceId });
    await seedRequests([
      requestRecord({
        id: 'req_01JTESTREQUEST00000000000F',
        service_id: serviceId,
        credential_access_rule_id: source.id,
        path: '/repos/acme/app/contents',
        caller_claims: JSON.stringify({
          repository: 'acme/app',
          repository_id: REPOSITORY_ID,
          repository_owner_id: OWNER_ID,
          ref: 'refs/heads/main',
          ref_type: 'branch',
          ref_protected: 'true',
          event_name: 'push',
        }),
      }),
    ]);
    const page = await html(`${RULES}/new?from_request=req_01JTESTREQUEST00000000000F`);
    expect(page).toContain('<h1>Allow this call from acme/app</h1>');
    expect(page).toContain('id="ga-sum-h">The denied request</h2>');
    expect(page).toContain('GET /repos/acme/app/contents');
    expect(page).toContain('href="/admin/requests/req_01JTESTREQUEST00000000000F"');
  });
});
