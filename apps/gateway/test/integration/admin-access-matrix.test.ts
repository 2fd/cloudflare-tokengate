// The issuer access rules matrix: one column per token, one row group per consumer, one row per
// repository, statuses as words, "+" cells that open the prefilled form, and its table semantics.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCredentialAccessRule } from '../../src/admin/ops/credential-access-rules';
import { createIssuerAccessRule } from '../../src/admin/ops/issuer_access_rules';
import type { CredentialAccessRule } from '../../src/db/types';
import { WORLD_SECRET } from '../fixtures/admin-forms';
import { adminGet } from '../helpers/admin-auth';
import { type ConsumersWorld, consumersWorld, seedLabel } from '../helpers/consumers';
import { testCredentialId } from '../unit/admin/ops/helpers';
import {
  ACTOR,
  anchoredConditions,
  REPOSITORY_ID,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
} from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let provider: CredentialAccessRule;
let slack: string;
let openai: string;

beforeEach(async () => {
  world = await consumersWorld();
  slack = await seedService(world.app.deps, { slug: 'slack', name: 'Slack', secret: WORLD_SECRET });
  provider = await seedGithubProvider(world.app.deps);
  openai = await seedService(world.app.deps, { slug: 'openai', name: 'OpenAI' });
  await seedLabel(provider.id, 'repository_id', REPOSITORY_ID, 'acme/api');
});

/** The Matrix view of Issuer access rules (the Map is the default view). */
const matrix = async (role: keyof ConsumersWorld['sessions'] = 'access_manager', query = '') =>
  (
    await adminGet(
      world.app,
      world.sessions[role],
      `/admin/issuer-access-rules?view=matrix${query ? `&${query.replace(/^\?/, '')}` : ''}`,
    )
  ).text();

describe('issuer access rules matrix', () => {
  it('has a caption, column, row and row group headers in a focusable region', async () => {
    await seedIssuerAccessRule(world.app.deps, provider.id, slack);
    const html = await matrix();
    expect(html).toContain(
      '<div class="matrix" role="region" tabindex="0" aria-label="Which credential access rules can use which tokens">',
    );
    expect(html).toContain(
      '<caption class="vh">Which credential access rules can use which tokens</caption>',
    );
    expect(html).toMatch(
      /<th scope="col"><div class="colh"><span class="top">[^]*?<a href="\/admin\/credentials\//,
    );
    expect(html).toContain('<th colspan="3" scope="rowgroup">');
    expect(html).toContain(
      `<th scope="row"><a class="mono" href="/admin/issuer-access-rules?repository=${REPOSITORY_ID}">acme/api</a><span class="meta">${REPOSITORY_ID}</span></th>`,
    );
    // Columns sorted by name.
    expect(html.indexOf('>OpenAI<')).toBeLessThan(html.indexOf('>Slack<'));
    // The view switch: Matrix is current, the Map is a link.
    expect(html).toContain('<nav class="seg sm" aria-label="View">');
    expect(html).toMatch(
      /<a href="\/admin\/issuer-access-rules\?view=matrix" aria-current="page">Matrix<\/a>/,
    );
  });

  it('words every status and adds a full sentence for screen readers', async () => {
    const active = await seedIssuerAccessRule(world.app.deps, provider.id, slack, 'active');
    const disabled = await seedIssuerAccessRule(world.app.deps, provider.id, slack, 'disabled');
    await env.DB.prepare('UPDATE issuer_access_rules SET enabled = 0 WHERE id = ?')
      .bind(disabled.id)
      .run();
    const expired = await seedIssuerAccessRule(world.app.deps, provider.id, slack, 'expired');
    await env.DB.prepare('UPDATE issuer_access_rules SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, expired.id)
      .run();
    await seedIssuerAccessRule(world.app.deps, provider.id, openai, 'no credential');
    const html = await matrix();
    // The "active" access matches any ref: it leads with its accepted risk (brief A9, A5).
    expect(html).toContain('<span class="s"><span aria-hidden="true">⚠</span>Risk accepted</span>');
    expect(html).toContain('<span class="s"><span aria-hidden="true">⏸</span>Disabled</span>');
    expect(html).toContain('<span class="s"><span aria-hidden="true">✕</span>Expired</span>');
    expect(html).toContain('Inactive: token has no credential');
    // WCAG 2.5.3: the visible words are the accessible name, in order, after the hidden context.
    expect(html).toContain(
      `<a class="mcell warn" href="/admin/issuer-access-rules/${active.id}"><span class="vh">acme/api can use Slack: </span><span class="s"><span aria-hidden="true">⚠</span>Risk accepted</span><span class="c">any ref</span><span class="o">1 operation</span></a>`,
    );
    // Created just now: never "unused 30 days".
    expect(html).not.toContain('unused 30 days');
  });

  it('offers "+" with a prefilled copy to access managers and "—" to viewers', async () => {
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, slack);
    const html = await matrix();
    expect(html).toContain(
      `href="/admin/issuer-access-rules/new?consumer=${provider.id}&amp;token=${openai}&amp;repository=${REPOSITORY_ID}&amp;copy=${grant.id}"`,
    );
    expect(html).toContain('<span class="vh">Give acme/api access to OpenAI</span>');
    const viewer = await matrix('viewer');
    expect(viewer).not.toContain('class="madd"');
    expect(viewer).toContain('<span class="vh">No access</span>');
  });

  it('lists both overlapping accesses in one cell and explains it on the access page', async () => {
    const first = await seedIssuerAccessRule(world.app.deps, provider.id, slack, 'first');
    const second = await createIssuerAccessRule(world.app.deps, ACTOR, {
      name: 'second',
      credential_access_rule_id: provider.id,
      service_id: slack,
      conditions: [
        ...anchoredConditions(),
        { claim: 'ref_protected', match: 'exact', values: ['true'] },
      ],
      rules: [{ methods: ['POST'], path: '/chat.postMessage' }],
    });
    if (!second.ok) throw new Error(second.errors.join('; '));
    const html = await matrix();
    const cell = html.slice(html.indexOf(`href="/admin/issuer-access-rules/${first.id}"`));
    expect(cell.slice(0, cell.indexOf('</td>'))).toContain(
      `href="/admin/issuer-access-rules/${second.grant.id}"`,
    );
    const page = await (
      await adminGet(world.app, world.sessions.viewer, `/admin/issuer-access-rules/${first.id}`)
    ).text();
    expect(page).toContain('Also matched by');
    expect(page).toContain('the request record names the oldest');
    expect(page).not.toContain('first match wins');
  });

  it('filters, counts the quick links, and shows the empty states', async () => {
    expect(await matrix()).toContain('No workload can use any token yet.');
    await seedIssuerAccessRule(world.app.deps, provider.id, slack);
    const filtered = await matrix('access_manager', `token=${slack}`);
    expect(filtered).not.toContain(`<a href="/admin/credentials/${openai}">OpenAI</a>`);
    expect(filtered).toContain(`<a href="/admin/credentials/${slack}">Slack</a>`);
    expect(await matrix('access_manager', `token=${openai}`)).toContain(
      'No issuer access rules matches these filters.',
    );
    expect(await matrix()).toMatch(/Inactive <span class="n">0<\/span><\/a>/);
    const status = await matrix('access_manager', 'status=inactive');
    expect(status).toContain('No issuer access rules matches these filters.');
    await env.DB.prepare('DELETE FROM issuer_access_rules').run();
    await env.DB.prepare('DELETE FROM claim_labels').run();
    await env.DB.prepare('DELETE FROM credential_access_rules').run();
    expect(await matrix()).toContain('No consumer yet.');
  });

  it('shows the access list instead of a matrix too large to read', async () => {
    for (let i = 0; i < 41; i++)
      await seedService(world.app.deps, { slug: `t${i}`, name: `T${i}` });
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, slack);
    const html = await matrix();
    expect(html).toContain('Too many to show as a matrix; filter by consumer or token.');
    expect(html).not.toContain('<div class="matrix"');
    expect(html).toContain('<table class="tbl stackable" id="access-list">');
    expect(html).toContain(`href="/admin/issuer-access-rules/${grant.id}"`);
  });

  it('opens the matrix filtered to the credential access rules the map groups', async () => {
    // Eight consumers with one access each: the map draws 6 and groups 2 into "+ 2 more".
    const ids: string[] = [provider.id];
    await seedIssuerAccessRule(world.app.deps, provider.id, slack, 'busiest');
    await seedIssuerAccessRule(world.app.deps, provider.id, openai, 'busiest 2');
    for (let i = 0; i < 7; i++) {
      const created = await createCredentialAccessRule(world.app.deps, ACTOR, {
        credential_id: await testCredentialId(world.app.deps),
        profile: 'generic',
        issuer: `https://idp${i}.example.org`,
        jwks_uri: `https://idp${i}.example.org/keys`,
        anchor_claims: ['sub'],
      });
      if (!created.ok) throw new Error(created.errors.join('; '));
      ids.push(created.credentialAccessRule.id);
    }
    const map = await (
      await adminGet(world.app, world.sessions.access_manager, '/admin/issuer-access-rules')
    ).text();
    expect(map).toContain('href="/admin/issuer-access-rules?view=matrix&amp;consumers=rest"');
    const rest = await matrix('access_manager', 'consumers=rest');
    expect(rest).toContain('Connections of the other consumers');
    // The busiest consumer is drawn on the map, so it is not in the rest.
    expect(rest).not.toContain(
      `<a class="ent-n" href="/admin/credential-access-rules/${provider.id}">`,
    );
  });
});
