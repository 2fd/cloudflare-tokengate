// The matrix of credential access rules as it is drawn today (WP-R3 redraws it for credential and
// global access rules and puts it behind ?view=matrix): one column per credential, one row group
// per issuer, one row per repository, statuses as words, "+" cells that open the prefilled form,
// and its table semantics. Rendered from the real database through loadConnections.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { can } from '../../src/admin/auth/rbac';
import { loadConnections } from '../../src/admin/connections';
import type { ViewContext } from '../../src/admin/render';
import { AccessMatrix, buildMatrix } from '../../src/admin/views/matrix';
import type { Role } from '../../src/db/types';
import { WORLD_SECRET } from '../fixtures/admin-forms';
import { type RulesWorld, rulesWorld, seedLabel } from '../helpers/access-rules';
import { REPOSITORY_ID, seedCredentialRule, seedService } from '../unit/admin/ops/helpers';

let world: RulesWorld;
let slack: string;
let openai: string;

beforeEach(async () => {
  world = await rulesWorld();
  slack = await seedService(world.app.deps, { slug: 'slack', name: 'Slack', secret: WORLD_SECRET });
  openai = await seedService(world.app.deps, { slug: 'openai', name: 'OpenAI' });
});

function view(role: Role): ViewContext {
  return {
    csrf: 'csrf-token',
    userId: 'usr_viewer',
    role,
    host: 'gw.test',
    now: Date.now(),
    can: (permission) => can(role, permission),
    askers: () => [{ email: 'owner@example.com' }],
    askersMore: () => 0,
    hidden: (extra) => ({ _csrf: 'csrf-token', ...extra }),
  };
}

async function matrix(role: Role = 'access_manager'): Promise<string> {
  const connections = await loadConnections(world.app.deps);
  return String(
    <AccessMatrix model={buildMatrix(connections)} connections={connections} ctx={view(role)} />,
  );
}

async function rule(credential: string, name: string) {
  const created = await seedCredentialRule(world.app.deps, { credential_id: credential, name });
  await seedLabel(created.id, 'repository_id', REPOSITORY_ID, 'acme/api');
  return created;
}

describe('credential access rules matrix (current visuals)', () => {
  it('has a caption, column, row and row group headers in a focusable region', async () => {
    await rule(slack, 'read repo');
    const html = await matrix();
    expect(html).toContain(
      '<div class="matrix" role="region" tabindex="0" aria-label="Which issuers can use which credentials">',
    );
    expect(html).toContain('<caption class="vh">Which issuers can use which credentials</caption>');
    expect(html).toMatch(
      /<th scope="col"><div class="colh"><span class="top">[^]*?<a href="\/admin\/credentials\//,
    );
    expect(html).toContain('scope="rowgroup"');
    expect(html).toContain('href="/admin/credential-access-rules?issuer=');
    expect(html).toContain('<th scope="row">');
    expect(html).toContain('acme/api');
  });

  it('words every status and adds a full sentence for screen readers', async () => {
    const active = await rule(slack, 'active');
    const disabled = await rule(slack, 'disabled');
    await env.DB.prepare('UPDATE access_rules SET enabled = 0 WHERE id = ?')
      .bind(disabled.id)
      .run();
    const expired = await rule(slack, 'expired');
    await env.DB.prepare('UPDATE access_rules SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, expired.id)
      .run();
    await rule(openai, 'no secret');
    const html = await matrix();
    expect(html).toContain('<span class="s"><span aria-hidden="true">⏸</span>Disabled</span>');
    expect(html).toContain('<span class="s"><span aria-hidden="true">✕</span>Expired</span>');
    expect(html).toContain('Inactive: credential has no secret');
    // WCAG 2.5.3: the visible words are the accessible name, after the hidden context.
    expect(html).toMatch(
      new RegExp(
        `<a class="mcell[^"]*" href="/admin/credential-access-rules/${active.id}"><span class="vh">acme/api can use Slack: </span>`,
      ),
    );
    // Created just now: never "unused 30 days".
    expect(html).not.toContain('unused 30 days');
  });

  it('offers "+" with a prefilled copy to access managers and "—" to viewers', async () => {
    const source = await rule(slack, 'read repo');
    const html = await matrix();
    expect(html).toContain(
      `href="/admin/credential-access-rules/new?credential=${openai}&amp;type=github-actions&amp;copy=${source.id}"`,
    );
    expect(html).toContain('<span class="vh">Give acme/api access to OpenAI</span>');
    const viewer = await matrix('viewer');
    expect(viewer).not.toContain('class="madd"');
    expect(viewer).toContain('<span class="vh">No access</span>');
  });
});
