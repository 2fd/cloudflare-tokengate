// Issuer access rules pages through the real app: RBAC, the structured form with preselected consumer
// and token, field errors, rows editor and anchors (I-AUTHZ-2), edit, toggle and delete, list
// filters, prefill from a verified request (I-LOG-2), statuses and escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getIssuerAccessRule, listIssuerAccessRules } from '../../src/db/issuer_access_rules';
import type { CredentialAccessRule } from '../../src/db/types';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  auditActions,
  type ConsumersWorld,
  consumersWorld,
  idFromLocation,
  inputValue,
  labels,
  lastAudit,
  locationOf,
  requestRecord,
  seedLabel,
  seedRequests,
} from '../helpers/consumers';
import {
  OWNER_ID,
  REPOSITORY_ID,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
} from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let provider: CredentialAccessRule;
let serviceId: string;

beforeEach(async () => {
  world = await consumersWorld();
  serviceId = await seedService(world.app.deps);
  provider = await seedGithubProvider(world.app.deps);
});

const admin = () => world.sessions.admin;

function structured(overrides: Record<string, string | string[]> = {}) {
  return {
    consumer_id: provider.id,
    token_id: serviceId,
    repository: `acme/api (${REPOSITORY_ID})`,
    context: 'branch',
    branch: 'main',
    ref_protection: 'protected',
    op: 'read-repo',
    expires: 'never',
    ...overrides,
  };
}

async function grantAudit(): Promise<string[]> {
  return (await auditActions()).filter((action) => action.startsWith('grant.'));
}

describe('issuer access rules: viewer and credential manager', () => {
  it('can read the matrix, the list and an access but change nothing', async () => {
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'deploy');
    for (const session of [world.sessions.viewer, world.sessions.token_manager]) {
      const matrix = await (
        await adminGet(world.app, session, '/admin/issuer-access-rules')
      ).text();
      expect(matrix).toContain('Which credential access rule jobs can use which credential');
      expect(matrix).not.toContain('Add issuer access rule');
      const page = await (
        await adminGet(world.app, session, `/admin/issuer-access-rules/${grant.id}`)
      ).text();
      expect(page).toContain('deploy');
      expect(page).not.toContain('Change this access');
      expect(page).not.toContain('Create copy');
      expect((await adminGet(world.app, session, '/admin/issuer-access-rules/new')).status).toBe(
        403,
      );
      for (const path of [
        '/admin/issuer-access-rules',
        `/admin/issuer-access-rules/${grant.id}`,
        `/admin/issuer-access-rules/${grant.id}/copy`,
        `/admin/issuer-access-rules/${grant.id}/toggle`,
        `/admin/issuer-access-rules/${grant.id}/delete`,
      ]) {
        const res = await adminPost(world.app, session, path, {
          ...structured(),
          confirm: '1',
          enabled: '0',
        });
        expect(res.status, path).toBe(403);
      }
    }
    expect(await grantAudit()).toEqual(['grant.create']);
    expect((await getIssuerAccessRule(env.DB, grant.id))?.enabled).toBe(true);
  });
});

describe('issuer access rules: the form', () => {
  it('fixes the only credential access rule and credential, and shows the template operations', async () => {
    const res = await adminGet(world.app, admin(), '/admin/issuer-access-rules/new');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(inputValue(html, 'consumer_id')).toBe(provider.id);
    expect(inputValue(html, 'token_id')).toBe(serviceId);
    expect(html).not.toContain('type="radio" id="f-consumer_id"');
    expect(html).not.toContain('name="owner_id"');
    expect(html).toContain('Read repository contents');
    expect(html).toContain('<code>GET /repos/‹repository›/**</code>');
    expect(html).toMatch(/name="op" value="read-repo" checked/);
    expect(html).toMatch(/name="context" value="environment" checked/);
    expect(html).toMatch(/name="ref_protection" value="protected" checked/);
    // The only credential access rule and credential are fixed and visible: the repository carries the A7.8 pattern,
    // but not required: a workflow pin under More constraints may stand in for it.
    expect(html).toMatch(/name="repository"[^>]*pattern="/);
    expect(html).not.toMatch(/name="repository"[^>]*required/);
    expect(html).toContain('placeholder="acme/api (89012345)"');
    expect(html).not.toContain('name="name"');
    expect(html).not.toContain('<script');
  });

  it('shows the repository label in the operation once the repository is known', async () => {
    await seedLabel(provider.id, 'repository_id', REPOSITORY_ID, 'acme/api');
    const html = await (
      await adminGet(world.app, admin(), '/admin/issuer-access-rules/new')
    ).text();
    // The credential access rule's only repository is prefilled.
    expect(inputValue(html, 'repository')).toBe(`acme/api (${REPOSITORY_ID})`);
    expect(html).toContain(`<option value="acme/api (${REPOSITORY_ID})">`);
  });

  it('creates an access in one submit: derived name, label, literal rule, one audit row', async () => {
    const res = await adminPost(world.app, admin(), '/admin/issuer-access-rules', structured());
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(
      /^\/admin\/issuer-access-rules\/grt_[0-9A-Z]{26}\?notice=created$/,
    );
    const grant = await getIssuerAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(grant).toMatchObject({
      name: 'GitHub for acme/api (branch main)',
      enabled: true,
      expires_at: null,
      rules: [{ methods: ['GET'], path: '/repos/acme/api/**' }],
    });
    expect(grant?.conditions).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] },
      { claim: 'repository_id', match: 'exact', values: [REPOSITORY_ID] },
      { claim: 'ref_type', match: 'exact', values: ['branch'] },
      { claim: 'ref', match: 'glob', values: ['refs/heads/main'] },
      { claim: 'event_name', match: 'exact', values: ['push', 'workflow_dispatch', 'schedule'] },
      { claim: 'ref_protected', match: 'exact', values: ['true'] },
    ]);
    expect(await labels(provider.id)).toEqual([
      { claim: 'repository_id', value: REPOSITORY_ID, label: 'acme/api' },
    ]);
    expect(await grantAudit()).toEqual(['grant.create']);
    const page = await (await adminGet(world.app, admin(), locationOf(res))).text();
    expect(page).toContain('Access created.');
    expect(page).toContain(
      'Typical subject</dt><dd class="mono copyable">repo:acme/api:ref:refs/heads/main',
    );
    expect(page).toContain('outputs.proxy-base }}/github/&lt;path&gt;');
  });

  it('re-renders field errors with the typed values, linking the summary to each field', async () => {
    const res = await adminPost(
      world.app,
      admin(),
      '/admin/issuer-access-rules',
      structured({ repository: 'acme/api', branch: '*', op: [] }),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('<title>Error: Add issuer access rule');
    expect(html).toContain('href="#f-repository"');
    expect(html).toContain('Add the numeric ID after the name, like acme/api (987654321).');
    expect(html).toContain('gh api repos/acme/api --jq');
    expect(html).toContain('href="#f-branch"');
    expect(html).toContain('id="f-branch-error"');
    expect(html).toContain('value="acme/api"');
    expect(await grantAudit()).toEqual([]);
  });

  it('asks to choose an operation when none is chosen', async () => {
    const res = await adminPost(
      world.app,
      admin(),
      '/admin/issuer-access-rules',
      structured({ op: [] }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Choose at least one operation.');
  });

  it('refuses to widen an organization boundary while granting access', async () => {
    await seedLabel(provider.id, 'repository_owner_id', OWNER_ID, 'acme');
    const first = await adminPost(
      world.app,
      admin(),
      '/admin/issuer-access-rules',
      structured({ repository: 'acme-x/api (5)' }),
    );
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('acme-x is not an organization of this credential access rule yet.');
    expect(html).toContain('Ask a credential administrator');
    expect(html).toContain('href="#f-repository"');
    const second = await adminPost(
      world.app,
      admin(),
      '/admin/issuer-access-rules',
      structured({ repository: 'acme-x/api (5)', new_owner: 'acme-x (7654321)' }),
    );
    expect(second.status).toBe(422);
    expect((await auditActions()).slice(-1)).not.toContain('grant.create');
    const consumer = await env.DB.prepare(
      'SELECT tenant_pin FROM credential_access_rules WHERE id = ?',
    )
      .bind(provider.id)
      .first<{ tenant_pin: string }>();
    expect(JSON.parse(consumer?.tenant_pin ?? '[]')[0].values).toEqual([OWNER_ID]);
  });

  it('expires on a chosen day at the next 00:00 UTC, and refuses a past day', async () => {
    const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const res = await adminPost(
      world.app,
      admin(),
      '/admin/issuer-access-rules',
      structured({ expires: 'date', expires_on: day }),
    );
    expect(res.status).toBe(303);
    const grant = await getIssuerAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(grant?.expires_at).toBe(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
    const past = await adminPost(
      world.app,
      admin(),
      '/admin/issuer-access-rules',
      structured({ expires: 'date', expires_on: '2001-01-01' }),
    );
    expect(past.status).toBe(422);
    expect(await past.text()).toContain('Choose a day from tomorrow to 5 years ahead.');
  });

  it('converts the structured input to rows without losing it, then saves rows', async () => {
    const rows = await adminPost(world.app, admin(), '/admin/issuer-access-rules', {
      ...structured({ context: 'environment', environment: 'production' }),
      _action: 'rows',
    });
    expect(rows.status).toBe(200);
    const html = await rows.text();
    expect(html).toContain('name="editor" value="rows"');
    expect(html).toContain('value="production"');
    expect(html).toContain(`value="${REPOSITORY_ID}"`);
    expect(await grantAudit()).toEqual([]);

    const unanchored = await adminPost(world.app, admin(), '/admin/issuer-access-rules', {
      consumer_id: provider.id,
      token_id: serviceId,
      editor: 'rows',
      'cond.0.claim': 'repository_id',
      'cond.0.match': 'exact',
      'cond.0.values': REPOSITORY_ID,
      'rule.0.m': 'GET',
      'rule.0.path': '/repos/acme/api',
      expires: 'never',
    });
    expect(unanchored.status).toBe(422);
    const body = await unanchored.text();
    expect(body).toContain('I-AUTHZ-2');
    expect(body).toContain('href="#f-cond-0-values"');
    // Read repository contents needs a repository label; rows mode has none.
    const saved = await adminPost(world.app, admin(), '/admin/issuer-access-rules', {
      consumer_id: provider.id,
      token_id: serviceId,
      editor: 'rows',
      'cond.0.claim': 'repository_owner_id',
      'cond.0.values': OWNER_ID,
      'cond.1.claim': 'repository_id',
      'cond.1.values': `${REPOSITORY_ID}, 5`,
      'cond.2.claim': 'ref_protected',
      'cond.2.values': 'true',
      'rule.0.m': ['GET', 'HEAD'],
      'rule.0.path': '/repos/acme/**',
      expires: 'never',
    });
    expect(saved.status).toBe(303);
    const grant = await getIssuerAccessRule(env.DB, idFromLocation(locationOf(saved)));
    expect(grant?.conditions[1]).toEqual({
      claim: 'repository_id',
      match: 'exact',
      values: [REPOSITORY_ID, '5'],
    });
    expect(grant?.rules).toEqual([{ methods: ['GET', 'HEAD'], path: '/repos/acme/**' }]);
  });

  it('saves a workflow pin without a repository: every repository of the organization', async () => {
    const workflow = 'acme/infra/.github/workflows/deploy.yml@refs/heads/main';
    const res = await adminPost(world.app, admin(), '/admin/issuer-access-rules', {
      ...structured({ repository: '', workflow_ref: workflow, op: [] }),
      'rule.0.m': 'GET',
      'rule.0.path': '/repos/acme/**',
    });
    expect(res.status).toBe(303);
    const grant = await getIssuerAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(grant?.conditions).toContainEqual({
      claim: 'repository_owner_id',
      match: 'exact',
      values: [OWNER_ID],
    });
    expect(grant?.conditions).toContainEqual({
      claim: 'job_workflow_ref',
      match: 'exact',
      values: [workflow],
    });
    expect(grant?.conditions.some((c) => c.claim === 'repository_id')).toBe(false);
  });

  it('adds two more rows on request without writing anything', async () => {
    const res = await adminPost(world.app, admin(), '/admin/issuer-access-rules', {
      ...structured(),
      _action: 'add:rule',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="rule.3.path"');
    expect(html).toMatch(/id="row-rule-2"[^>]*autofocus/);
    expect(await grantAudit()).toEqual([]);
  });

  it('points to the missing token when none exists', async () => {
    await env.DB.prepare('DELETE FROM credentials').run();
    const html = await (
      await adminGet(world.app, admin(), '/admin/issuer-access-rules/new')
    ).text();
    expect(html).toContain('A credential manager must add a credential first.');
  });
});

describe('issuer access rules: the page', () => {
  it('shows the summary, the event line, the exact conditions and the status', async () => {
    await seedLabel(provider.id, 'repository_id', REPOSITORY_ID, 'acme/api');
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'read repo');
    const html = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules/${grant.id}`)
    ).text();
    expect(html).toContain('<h1>read repo <span class="badge');
    expect(html).toContain(`href="/admin/credential-access-rules/${provider.id}"`);
    expect(html).toContain(`href="/admin/issuer-access-rules?repository=${REPOSITORY_ID}"`);
    expect(html).toContain('any ref');
    expect(html).toContain('Events accepted (event_name)');
    expect(html).toContain('repository_owner_id exact 4242');
    expect(html).toContain('Inactive: token has no credential');
    expect(html).toContain(`href="/admin/requests?access=${grant.id}"`);
    expect(html).toContain(`href="/admin/audit?target=${grant.id}"`);
  });

  it('edits the context, re-deriving a derived name; an unchanged save writes nothing', async () => {
    const created = await adminPost(world.app, admin(), '/admin/issuer-access-rules', structured());
    const id = idFromLocation(locationOf(created));
    const grant = await getIssuerAccessRule(env.DB, id);
    if (!grant) throw new Error('missing');
    const page = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules/${id}?open=edit`)
    ).text();
    expect(page).toMatch(/<details class="disc" id="edit" open/);
    expect(page).toMatch(/name="context" value="branch" checked/);
    // Never expires: no "Keep" card repeating "Never"; Never is preselected.
    expect(page).toMatch(/name="expires" value="never" checked/);
    expect(page).not.toContain('value="keep"');
    const same = await adminPost(world.app, admin(), `/admin/issuer-access-rules/${id}`, {
      ...structured({ expires: 'keep' }),
      intent: 'save',
      expected_updated_at: String(grant.updated_at),
    });
    expect(same.status).toBe(303);
    expect(locationOf(same)).toBe(`/admin/issuer-access-rules/${id}?notice=unchanged`);
    const changed = await adminPost(world.app, admin(), `/admin/issuer-access-rules/${id}`, {
      ...structured({ context: 'environment', environment: 'production', expires: 'keep' }),
      intent: 'save',
      expected_updated_at: String(grant.updated_at),
    });
    expect(changed.status).toBe(303);
    expect(locationOf(changed)).toBe(`/admin/issuer-access-rules/${id}?notice=updated`);
    expect((await getIssuerAccessRule(env.DB, id))?.name).toBe(
      'GitHub for acme/api (environment production)',
    );
    expect(await grantAudit()).toEqual(['grant.create', 'grant.update']);
    const stale = await adminPost(world.app, admin(), `/admin/issuer-access-rules/${id}`, {
      ...structured({ expires: 'keep' }),
      intent: 'save',
      expected_updated_at: String(grant.updated_at),
    });
    expect(stale.status).toBe(409);
  });

  it('a renamed access keeps its name on edit; rename is its own form', async () => {
    const created = await adminPost(world.app, admin(), '/admin/issuer-access-rules', structured());
    const id = idFromLocation(locationOf(created));
    const renamed = await adminPost(world.app, admin(), `/admin/issuer-access-rules/${id}`, {
      intent: 'rename',
      name: 'Deploys <b>bold</b>',
      description: 'ticket 42',
    });
    expect(locationOf(renamed)).toBe(`/admin/issuer-access-rules/${id}?notice=renamed`);
    await adminPost(world.app, admin(), `/admin/issuer-access-rules/${id}`, {
      ...structured({ branch: 'release/*', expires: 'keep' }),
      intent: 'save',
    });
    expect((await getIssuerAccessRule(env.DB, id))?.name).toBe('Deploys <b>bold</b>');
    const html = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules/${id}`)
    ).text();
    expect(html).toContain('Deploys &lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('Deploys <b>bold</b>');
  });

  it('a label change through a save is audited and named in the notice', async () => {
    const created = await adminPost(world.app, admin(), '/admin/issuer-access-rules', structured());
    const id = idFromLocation(locationOf(created));
    const res = await adminPost(world.app, admin(), `/admin/issuer-access-rules/${id}`, {
      ...structured({ repository: `acme/api-renamed (${REPOSITORY_ID})`, expires: 'keep' }),
      intent: 'save',
    });
    expect(locationOf(res)).toBe(`/admin/issuer-access-rules/${id}?notice=label_changed`);
    expect(await lastAudit('grant.update')).toMatchObject({
      labels: {
        before: { [`repository_id:${REPOSITORY_ID}`]: 'acme/api' },
        after: { [`repository_id:${REPOSITORY_ID}`]: 'acme/api-renamed' },
      },
    });
  });

  it('disables with an Undo from the list, and deletes only through the dialog', async () => {
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, serviceId);
    const off = await adminPost(
      world.app,
      admin(),
      `/admin/issuer-access-rules/${grant.id}/toggle`,
      {
        enabled: '0',
        _return: 'list',
      },
    );
    expect(locationOf(off)).toBe('/admin/issuer-access-rules?view=list&notice=disabled');
    const back = await adminPost(
      world.app,
      admin(),
      `/admin/issuer-access-rules/${grant.id}/toggle`,
      {
        enabled: '1',
        _return: 'detail',
      },
    );
    expect(locationOf(back)).toBe(`/admin/issuer-access-rules/${grant.id}?notice=enabled`);
    const unconfirmed = await adminPost(
      world.app,
      admin(),
      `/admin/issuer-access-rules/${grant.id}/delete`,
    );
    expect(unconfirmed.status).toBe(400);
    const deleted = await adminPost(
      world.app,
      admin(),
      `/admin/issuer-access-rules/${grant.id}/delete`,
      {
        confirm: '1',
      },
    );
    expect(locationOf(deleted)).toBe('/admin/issuer-access-rules?notice=deleted');
    expect(await getIssuerAccessRule(env.DB, grant.id)).toBeNull();
    expect(await grantAudit()).toEqual([
      'grant.create',
      'grant.disable',
      'grant.enable',
      'grant.delete',
    ]);
  });

  it('shows Expired and the inactive cause as words', async () => {
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, serviceId);
    await env.DB.prepare('UPDATE issuer_access_rules SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1000, grant.id)
      .run();
    expect(
      await (await adminGet(world.app, admin(), `/admin/issuer-access-rules/${grant.id}`)).text(),
    ).toContain('Expired');
    await env.DB.prepare('UPDATE issuer_access_rules SET expires_at = NULL WHERE id = ?')
      .bind(grant.id)
      .run();
    await env.DB.prepare('UPDATE credential_access_rules SET enabled = 0 WHERE id = ?')
      .bind(provider.id)
      .run();
    const html = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules/${grant.id}`)
    ).text();
    expect(html).toContain('Inactive: credential access rule disabled');
    expect(html).toContain('Inactive because the credential access rule is disabled');
  });

  it('answers 404 for unknown ids', async () => {
    expect(
      (await adminGet(world.app, admin(), '/admin/issuer-access-rules/grt_missing')).status,
    ).toBe(404);
    expect(
      (
        await adminPost(world.app, admin(), '/admin/issuer-access-rules/grt_missing', {
          intent: 'save',
        })
      ).status,
    ).toBe(404);
  });
});

describe('issuer access rules: list and filters', () => {
  it('filters by credential access rule and credential, ignores unknown ids with a note, and says when nothing matches', async () => {
    const otherService = await seedService(world.app.deps, { slug: 'other', name: 'Other' });
    await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'one');
    await seedIssuerAccessRule(world.app.deps, provider.id, otherService, 'two');
    const list = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules?view=list&token=${serviceId}`)
    ).text();
    expect(list).toContain('Disable<span class="vh"> one</span>');
    expect(list).not.toContain('Disable<span class="vh"> two</span>');
    const unknown = await (
      await adminGet(world.app, admin(), '/admin/issuer-access-rules?consumer=cpr_gone')
    ).text();
    expect(unknown).toContain('That consumer no longer exists.');
    const none = await (
      await adminGet(
        world.app,
        admin(),
        '/admin/issuer-access-rules?view=list&repository=nothing-here',
      )
    ).text();
    expect(none).toContain('No issuer access rules matches these filters.');
    expect(none).toContain('Clear filters');
    expect(
      (await adminGet(world.app, admin(), '/admin/issuer-access-rules?status=bogus&view=x')).status,
    ).toBe(200);
  });
});

describe('I-LOG-2: give access from a request, verified records only', () => {
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

  async function record(id: string, overrides: Parameters<typeof requestRecord>[0] | object = {}) {
    await seedRequests([
      requestRecord({
        id,
        service_id: serviceId,
        credential_access_rule_id: provider.id,
        caller_claims: JSON.stringify(claims),
        ...overrides,
      }),
    ]);
  }

  it('prefills the structured fields and the call as an operation', async () => {
    await record('req_01JTESTREQUEST00000000000A', { path: '/repos/acme/app/**x', method: 'GET' });
    await record('req_01JTESTREQUEST00000000000B', {
      path: '/repos/acme/app/contents',
      method: 'GET',
    });
    const html = await (
      await adminGet(
        world.app,
        admin(),
        '/admin/issuer-access-rules/new?from_request=req_01JTESTREQUEST00000000000B',
      )
    ).text();
    expect(html).toContain('Prefilled from request');
    expect(inputValue(html, 'repository')).toBe(`acme/app (${REPOSITORY_ID})`);
    expect(html).toMatch(/name="context" value="branch" checked/);
    expect(inputValue(html, 'branch')).toBe('main');
    expect(html).toMatch(/name="ref_protection" value="protected" checked/);
    expect(inputValue(html, 'rule.0.path')).toBe('/repos/acme/app/contents');
    // Nothing is written by the prefill; the label is stored only on save.
    expect(await labels()).toEqual([]);
  });

  it.each(['/repos/acme/app/**', '/repos/acme/app/contents/a%2Fb'])(
    'does not prefill a rule for the path %s',
    async (path) => {
      await record('req_01JTESTREQUEST00000000000C', { path });
      const html = await (
        await adminGet(
          world.app,
          admin(),
          '/admin/issuer-access-rules/new?from_request=req_01JTESTREQUEST00000000000C',
        )
      ).text();
      expect(html).toContain('No operation was prefilled');
      expect(html).not.toContain(`value="${path}"`);
    },
  );

  it('opens the rows editor with the warnings and their acknowledgement for an untrusted event', async () => {
    await record('req_01JTESTREQUEST00000000000D', {
      reason: 'event_not_trusted',
      caller_claims: JSON.stringify({ ...claims, event_name: 'workflow_run' }),
    });
    const html = await (
      await adminGet(
        world.app,
        admin(),
        '/admin/issuer-access-rules/new?from_request=req_01JTESTREQUEST00000000000D',
      )
    ).text();
    expect(html).toContain('name="editor" value="rows"');
    expect(html).toContain('value="workflow_run"');
    expect(html).toContain('name="warnings_digest"');
    expect(html).toMatch(/name="acknowledge_warnings"[^>]*required/);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unverified record', { claims_verified: 0 }],
    ['another reason', { reason: 'service_disabled' }],
    ['a deleted credential access rule', { credential_access_rule_id: 'cpr_gone' }],
  ])('refuses %s with 400', async (_name, overrides) => {
    await record('req_01JTESTREQUEST00000000000E', overrides);
    const res = await adminGet(
      world.app,
      admin(),
      '/admin/issuer-access-rules/new?from_request=req_01JTESTREQUEST00000000000E',
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<title>Error: Cannot give access from this request');
    expect(html).toContain('This request cannot prefill the form.');
  });
});

describe('issuer access rules: design D pages', () => {
  it('draws the connections map and the access list, with the view switch and quick links', async () => {
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'one');
    const html = await (await adminGet(world.app, admin(), '/admin/issuer-access-rules')).text();
    expect(html).toContain('<h1>Issuer access rules<span class="count">1</span></h1>');
    expect(html).toContain('<div class="cmap" id="cmap" role="group"');
    expect(html).toContain('<section class="tray" id="al" aria-labelledby="al-h">');
    expect(html).toMatch(/<a href="\/admin\/issuer-access-rules" aria-current="page">Map<\/a>/);
    expect(html).toContain('<nav class="qlinks" aria-label="Accesses that need attention">');
    expect(html).toContain(`href="/admin/issuer-access-rules/${grant.id}"`);
    // The header has the one primary; the access list rows have the one-click Disable.
    expect(html.match(/class="btn primary/g)).toHaveLength(1);
    expect(html).toContain('Disable<span class="vh"> one</span>');
  });

  it('names the token in the header when filtered by it, and follows a focused consumer', async () => {
    await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'one');
    const byToken = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules?token=${serviceId}`)
    ).text();
    expect(byToken).toContain('<b>1 consumer</b> can use');
    expect(byToken).toContain(`href="/admin/issuer-access-rules/new?token=${serviceId}"`);
    expect(byToken).toContain('Add issuer access rule to GitHub');
    expect(byToken).toContain('id="al-h">Accesses to GitHub');
    const focused = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules?focus=${provider.id}`)
    ).text();
    expect(focused).toContain(`id="al-h">Accesses of ${provider.name}`);
    expect(focused).toContain('Everything else is dimmed.');
    const gone = await (
      await adminGet(world.app, admin(), '/admin/issuer-access-rules?focus=cpr_gone')
    ).text();
    expect(gone).toContain('That consumer no longer exists.');
  });

  it('filters expired accesses (a status of its own)', async () => {
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'old');
    const html = await (
      await adminGet(world.app, admin(), '/admin/issuer-access-rules?status=expired')
    ).text();
    expect(html).toContain('No issuer access rules matches these filters.');
    await env.DB.prepare('UPDATE issuer_access_rules SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1000, grant.id)
      .run();
    const expired = await (
      await adminGet(world.app, admin(), '/admin/issuer-access-rules?status=expired')
    ).text();
    expect(expired).toContain(`href="/admin/issuer-access-rules/${grant.id}"`);
    expect(expired).toMatch(
      /aria-current="true"><span class="g" aria-hidden="true">✕<\/span>Expired/,
    );
  });

  it('opens from a token page with the token fixed in the header and the bar', async () => {
    await seedService(world.app.deps, { slug: 'other', name: 'Other' });
    const html = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules/new?token=${serviceId}`)
    ).text();
    expect(html).toContain('<h1>Add issuer access rule to GitHub</h1>');
    expect(html).toContain(`<li><a href="/admin/credentials/${serviceId}">GitHub</a></li>`);
    expect(html).toContain('<div class="fixedbar"><span class="lbl">Credential</span>');
    expect(html).toContain(
      `<a class="btn secondary" href="/admin/credentials/${serviceId}">Cancel</a>`,
    );
    expect(html).toContain('<aside class="rail" id="ga-sum" aria-labelledby="ga-sum-h">');
  });

  it('picks a known repository, or saves the one typed under "Another repository"', async () => {
    await seedLabel(provider.id, 'repository_id', REPOSITORY_ID, 'acme/api');
    await seedLabel(provider.id, 'repository_id', '5', 'acme/web');
    const form = await (
      await adminGet(world.app, admin(), '/admin/issuer-access-rules/new')
    ).text();
    // Two known repositories: rows to pick, none checked, plus "Another repository".
    expect(form).toContain('<fieldset class="field sf3" id="f-repository-pick"');
    expect(form).toContain('name="repository" value=""');
    expect(form).toContain('name="repository_other"');
    expect(form).not.toMatch(/name="repository" value="[^"]+" checked/);
    const res = await adminPost(
      world.app,
      admin(),
      '/admin/issuer-access-rules',
      structured({ repository: '', repository_other: 'acme/infra (6)' }),
    );
    expect(res.status).toBe(303);
    const grant = await getIssuerAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(grant?.conditions).toContainEqual({
      claim: 'repository_id',
      match: 'exact',
      values: ['6'],
    });
  });

  it('shows the denied request in the rail of a form prefilled from it', async () => {
    await seedRequests([
      requestRecord({
        id: 'req_01JTESTREQUEST00000000000F',
        service_id: serviceId,
        credential_access_rule_id: provider.id,
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
    const html = await (
      await adminGet(
        world.app,
        admin(),
        '/admin/issuer-access-rules/new?from_request=req_01JTESTREQUEST00000000000F',
      )
    ).text();
    expect(html).toContain('<h1>Allow this call from acme/app</h1>');
    expect(html).toContain('id="ga-sum-h">The denied request</h2>');
    expect(html).toContain('GET /repos/acme/app/contents');
    expect(html).toContain(
      '<a class="btn secondary" href="/admin/requests/req_01JTESTREQUEST00000000000F">Back to the request</a>',
    );
  });

  it('copies to a repository typed under "Another…"', async () => {
    await seedLabel(provider.id, 'repository_id', REPOSITORY_ID, 'acme/api');
    const created = await adminPost(world.app, admin(), '/admin/issuer-access-rules', structured());
    const id = idFromLocation(locationOf(created));
    const page = await (
      await adminGet(world.app, admin(), `/admin/issuer-access-rules/${id}`)
    ).text();
    expect(page).toMatch(/name="repository" value="acme\/api \(987654321\)" checked/);
    expect(page).toContain('<div class="ga-copy-other subbox">');
    const res = await adminPost(world.app, admin(), `/admin/issuer-access-rules/${id}/copy`, {
      repository: '',
      repository_other: 'acme/web (987654322)',
      token_id: serviceId,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(/\?notice=copied$/);
  });
});

describe('issuer access rules: escaping', () => {
  it('escapes labels and names in the matrix, the list, the form and the page', async () => {
    await seedLabel(provider.id, 'repository_id', REPOSITORY_ID, '<script>x</script>');
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, '<img src=x>');
    for (const path of [
      '/admin/issuer-access-rules',
      '/admin/issuer-access-rules?view=list',
      '/admin/issuer-access-rules/new',
      `/admin/issuer-access-rules/${grant.id}`,
      `/admin/credential-access-rules/${provider.id}`,
    ]) {
      const html = await (await adminGet(world.app, admin(), path)).text();
      expect(html, path).not.toContain('<script>x</script>');
      expect(html, path).not.toContain('<img src=x>');
    }
    expect(await listIssuerAccessRules(env.DB)).toHaveLength(1);
  });
});
