// Markup rules of the consumer and access forms (WCAG 2.2 AA, A7.6, A16), checked on the real
// pages with HTMLRewriter: labelled controls, grouped radios, rendered describedby ids, one name
// per branch, no native validation where a control can be hidden, and patterns that browsers
// compile (`v` flag) and that accept their own placeholder.
import { beforeEach, describe, expect, it } from 'vitest';
import { createCallerProvider } from '../../src/admin/ops/caller-providers';
import { adminGet, adminPost } from '../helpers/admin-auth';
import { type ConsumersWorld, consumersWorld } from '../helpers/consumers';
import { ACTOR, seedGithubProvider, seedService } from '../unit/admin/ops/helpers';

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source', 'wbr', 'area', 'col']);

interface Node {
  tag: string;
  attrs: Map<string, string>;
  /** Open ancestors, outermost first. */
  ancestors: Array<{ tag: string; attrs: Map<string, string>; key: number }>;
}

async function parse(html: string): Promise<Node[]> {
  const nodes: Node[] = [];
  const stack: Node['ancestors'] = [];
  let counter = 0;
  await new HTMLRewriter()
    .on('*', {
      element(element) {
        const attrs = new Map<string, string>(
          [...element.attributes].map((pair) => [pair[0] ?? '', pair[1] ?? ''] as [string, string]),
        );
        const tag = element.tagName;
        nodes.push({ tag, attrs, ancestors: [...stack] });
        if (VOID.has(tag)) return;
        const entry = { tag, attrs, key: counter++ };
        stack.push(entry);
        element.onEndTag(() => {
          const index = stack.lastIndexOf(entry);
          if (index >= 0) stack.splice(index);
        });
      },
    })
    .transform(new Response(html))
    .text();
  return nodes;
}

const controls = (nodes: Node[]) =>
  nodes.filter(
    (node) =>
      (node.tag === 'input' && node.attrs.get('type') !== 'hidden') ||
      node.tag === 'select' ||
      node.tag === 'textarea',
  );

const hidden = (node: Node) =>
  node.ancestors.some(
    (ancestor) =>
      ancestor.attrs.get('class')?.split(' ').includes('reveal') ||
      (ancestor.tag === 'details' && !ancestor.attrs.has('open')) ||
      ancestor.tag === 'dialog',
  );

/** The innermost reveal a node sits in: its branch. */
const branchOf = (node: Node) =>
  [...node.ancestors].reverse().find((a) => a.attrs.get('class')?.split(' ').includes('reveal'))
    ?.key ?? -1;

async function checkPage(html: string, label: string) {
  const nodes = await parse(html);
  const ids = new Set(nodes.map((node) => node.attrs.get('id')).filter((id): id is string => !!id));
  const labelled = new Set(nodes.filter((n) => n.tag === 'label').map((n) => n.attrs.get('for')));
  expect(html, label).not.toContain('<script');
  expect(html, label).not.toMatch(/\sstyle=/);
  // Ids are unique.
  const allIds = nodes.map((node) => node.attrs.get('id')).filter((id): id is string => !!id);
  expect(allIds.length, `${label}: duplicate ids`).toBe(new Set(allIds).size);
  for (const node of controls(nodes)) {
    const id = node.attrs.get('id') ?? '';
    const name = node.attrs.get('name') ?? '';
    expect(labelled.has(id) || node.attrs.has('aria-label'), `${label}: label for ${name}`).toBe(
      true,
    );
    for (const ref of (node.attrs.get('aria-describedby') ?? '').split(' ').filter(Boolean)) {
      expect(ids.has(ref), `${label}: ${name} describedby ${ref}`).toBe(true);
    }
    if (hidden(node)) {
      for (const attribute of ['required', 'pattern', 'min', 'max', 'minlength']) {
        expect(node.attrs.has(attribute), `${label}: ${name} has ${attribute} while hidden`).toBe(
          false,
        );
      }
      expect(
        ['url', 'email'].includes(node.attrs.get('type') ?? ''),
        `${label}: ${name} type`,
      ).toBe(false);
    }
    if (node.attrs.get('type') === 'radio') {
      expect(
        node.ancestors.some((a) => a.tag === 'fieldset'),
        `${label}: ${name} in a fieldset`,
      ).toBe(true);
    }
    const pattern = node.attrs.get('pattern');
    if (pattern !== undefined) {
      const compiled = new RegExp(`^(?:${pattern})$`, 'v');
      const example = node.attrs.get('placeholder');
      if (example)
        expect(compiled.test(example), `${label}: ${name} placeholder ${example}`).toBe(true);
    }
  }
  // A name belongs to one branch: hidden inputs of other branches are submitted too.
  const branches = new Map<string, Set<number>>();
  for (const node of nodes.filter((n) => ['input', 'select', 'textarea'].includes(n.tag))) {
    const name = node.attrs.get('name');
    if (!name || name === '_csrf') continue;
    const set = branches.get(name) ?? new Set<number>();
    set.add(branchOf(node));
    branches.set(name, set);
  }
  for (const [name, set] of branches) {
    const forms = nodes.filter((n) => n.tag === 'form').length;
    if (
      forms > 2 &&
      ['expected_updated_at', 'intent', 'enabled', '_return', 'confirm'].includes(name)
    )
      continue;
    expect(set.size, `${label}: ${name} in ${set.size} branches`).toBe(1);
  }
  return nodes;
}

let world: ConsumersWorld;

beforeEach(async () => {
  world = await consumersWorld();
});

const session = () => world.sessions.access_manager;

describe('consumer access markup (WCAG 2.2 AA)', () => {
  it('the form with nested consumers, tokens and the new-consumer branch', async () => {
    const created = await createCallerProvider(world.app.deps, ACTOR, {
      profile: 'gitlab-ci',
      issuer: 'https://gitlab.com',
      tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['9'] }],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    await seedGithubProvider(world.app.deps);
    await createCallerProvider(world.app.deps, ACTOR, {
      profile: 'generic',
      issuer: 'https://idp.example.org',
      jwks_uri: 'https://idp.example.org/keys',
      anchor_claims: ['sub'],
    });
    await seedService(world.app.deps);
    await seedService(world.app.deps, {
      slug: 'other',
      name: 'Other',
      base_url: 'https://api.openai.com/v1',
    });
    const html = await (await adminGet(world.app, session(), '/admin/access/new')).text();
    const nodes = await checkPage(html, 'access form');
    // The checks ran on real branches: prefixed fields, several of them hidden in reveals.
    expect(controls(nodes).length).toBeGreaterThan(40);
    expect(controls(nodes).filter(hidden).length).toBeGreaterThan(20);
    expect(new Set(controls(nodes).map(branchOf)).size).toBeGreaterThan(5);
  });

  it('the fixed form, its error re-render and the rows editor', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const token = await seedService(world.app.deps);
    await checkPage(
      await (await adminGet(world.app, session(), '/admin/access/new')).text(),
      'fixed form',
    );
    const error = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: provider.id,
      token_id: token,
      repository: 'acme/api',
      context: 'environment',
      environment: '',
      expires: 'date',
      expires_on: 'soon',
    });
    expect(error.status).toBe(422);
    const html = await error.text();
    expect(html).toContain('<title>Error: ');
    expect(html).toMatch(/<div class="error-summary"[^>]*tabindex="-1"[^>]*autofocus/);
    expect(html).not.toContain('role="alert"');
    const nodes = await checkPage(html, 'error re-render');
    const ids = new Set(nodes.map((node) => node.attrs.get('id')));
    for (const match of html.matchAll(/<li><a href="#([^"]+)"/g)) {
      expect(ids.has(match[1]), `summary link #${match[1]}`).toBe(true);
    }
    expect(html).toMatch(/aria-invalid="true"/);
    // One page-level autofocus outside dialogs.
    const focused = nodes.filter(
      (n) => n.attrs.has('autofocus') && !n.ancestors.some((a) => a.tag === 'dialog'),
    );
    expect(focused).toHaveLength(1);
    const rows = await adminGet(
      world.app,
      session(),
      `/admin/access/new?consumer=${provider.id}&mode=rows`,
    );
    await checkPage(await rows.text(), 'rows editor');
  });

  it('the consumer list, add form and consumer page', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    await seedService(world.app.deps);
    for (const path of [
      '/admin/consumers',
      '/admin/consumers/new',
      `/admin/consumers/${provider.id}`,
    ]) {
      await checkPage(await (await adminGet(world.app, session(), path)).text(), path);
    }
  });

  it('the matrix, the list and the access page', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const token = await seedService(world.app.deps);
    const res = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: provider.id,
      token_id: token,
      repository: 'acme/api (5)',
      context: 'branch',
      branch: 'main',
      ref_protection: 'protected',
      op: 'read-repo',
      expires: 'never',
    });
    const location = res.headers.get('location') ?? '';
    for (const path of [
      '/admin/access',
      '/admin/access?view=list',
      location.split('?')[0] ?? '',
      `${location.split('?')[0]}?open=edit`,
    ]) {
      await checkPage(await (await adminGet(world.app, session(), path)).text(), path);
    }
  });
});
