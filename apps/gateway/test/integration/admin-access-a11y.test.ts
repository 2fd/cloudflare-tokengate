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

/**
 * Classes of a branch that CSS hides until its choice is checked: the old `.reveal`, the ui live
 * reveals (`.rv1` … `.rv8`), and the page-local scoped branches of the access forms (consumer and
 * type branches, token branches, scoped reveals, the copy form's "Another…").
 */
const BRANCH_CLASSES = new Set([
  'reveal',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `rv${n}`),
  ...[3, 4, 5, 6].map((n) => `ga-r${n}`),
  'ga-branch',
  'ga-tbranch',
  'ga-tok',
  'ga-copy-other',
]);

const isBranch = (attrs: Map<string, string>) =>
  (attrs.get('class') ?? '').split(' ').some((name) => BRANCH_CLASSES.has(name));

const hidden = (node: Node) =>
  node.ancestors.some(
    (ancestor) =>
      isBranch(ancestor.attrs) ||
      (ancestor.tag === 'details' && !ancestor.attrs.has('open')) ||
      ancestor.tag === 'dialog',
  );

/** The innermost hidden branch a node sits in. */
const branchOf = (node: Node) =>
  [...node.ancestors].reverse().find((a) => isBranch(a.attrs))?.key ?? -1;

/** The form a node belongs to. */
const formOf = (node: Node) =>
  [...node.ancestors].reverse().find((a) => a.tag === 'form')?.key ?? -1;

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
    // A <label for> or a wrapping <label> (implicit label: ui radio cards and checkboxes).
    const implicit = node.ancestors.some((a) => a.tag === 'label');
    expect(
      labelled.has(id) || implicit || node.attrs.has('aria-label'),
      `${label}: label for ${name}`,
    ).toBe(true);
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
  // A name belongs to one branch of its form: hidden inputs of other branches are submitted too.
  // Another form of the page (the copy form next to the edit form) is submitted on its own.
  const branches = new Map<string, Set<number>>();
  for (const node of nodes.filter((n) => ['input', 'select', 'textarea'].includes(n.tag))) {
    const name = node.attrs.get('name');
    if (!name || name === '_csrf') continue;
    const key = `${formOf(node)} ${name}`;
    const set = branches.get(key) ?? new Set<number>();
    set.add(branchOf(node));
    branches.set(key, set);
  }
  for (const [key, set] of branches) {
    const name = key.slice(key.indexOf(' ') + 1);
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
    expect(html).toMatch(/<div class="callout bad errsum"[^>]*tabindex="-1"[^>]*autofocus/);
    expect(html).not.toContain('role="alert"');
    const nodes = await checkPage(html, 'error re-render');
    // Every summary link lands on a control that can take focus (never a group's fieldset), and
    // that control is aria-invalid.
    const links = [...html.matchAll(/<li><a href="#([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(links.length).toBeGreaterThan(0);
    for (const id of links) {
      const target = nodes.find((node) => node.attrs.get('id') === id);
      expect(target, `summary link #${id}`).toBeDefined();
      expect(['input', 'select', 'textarea'], `summary link #${id} is a control`).toContain(
        target?.tag,
      );
      expect(target?.attrs.get('type'), `summary link #${id}`).not.toBe('hidden');
      expect(target?.attrs.get('aria-invalid'), `summary link #${id} is invalid`).toBe('true');
    }
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

  it('a risk to accept: the summary link lands on the invalid box', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const token = await seedService(world.app.deps);
    const res = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: provider.id,
      token_id: token,
      editor: 'rows',
      'cond.0.claim': 'repository_owner_id',
      'cond.0.values': '4242',
      'cond.1.claim': 'repository_id',
      'cond.1.values': '5',
      'rule.0.m': 'GET',
      'rule.0.path': '/x',
      expires: 'never',
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    const nodes = await checkPage(html, 'risk re-render');
    expect(html).toContain('<li><a href="#ga-risk-ack">');
    const box = nodes.find((node) => node.attrs.get('id') === 'ga-risk-ack');
    expect(box?.tag).toBe('input');
    expect(box?.attrs.get('aria-invalid')).toBe('true');
    expect(box?.attrs.has('required')).toBe(true);
    // Shown without a risky choice in the form (a server-computed risk).
    expect(html).toContain('<div class="riskacc always" id="ga-risk"');
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
    // A rows-mode access with warnings: its edit form (closed details) shows the risks up front.
    const rows = {
      consumer_id: provider.id,
      token_id: token,
      editor: 'rows',
      'cond.0.claim': 'repository_owner_id',
      'cond.0.values': '4242',
      'cond.1.claim': 'repository_id',
      'cond.1.values': '5',
      'cond.2.claim': 'ref',
      'cond.2.match': 'glob',
      'cond.2.values': 'refs/heads/*',
      'cond.3.claim': 'actor',
      'cond.3.values': 'octocat',
      'rule.0.m': 'GET',
      'rule.0.path': '/x',
      expires: 'never',
    };
    const first = await adminPost(world.app, session(), '/admin/access', rows);
    const digest = /name="warnings_digest" value="([0-9a-f]+)"/.exec(await first.text())?.[1] ?? '';
    const risky = await adminPost(world.app, session(), '/admin/access', {
      ...rows,
      warnings_digest: digest,
      acknowledge_warnings: '1',
    });
    const riskyPath = (risky.headers.get('location') ?? '').split('?')[0] ?? '';
    const riskyPage = await (await adminGet(world.app, session(), riskyPath)).text();
    expect(riskyPage).toContain('<div class="riskacc always" id="ga-risk"');
    for (const path of [
      '/admin/access',
      '/admin/access?view=list',
      '/admin/access?view=matrix',
      `/admin/access?token=${token}`,
      `/admin/access/new?token=${token}`,
      location.split('?')[0] ?? '',
      `${location.split('?')[0]}?open=edit`,
      riskyPath,
    ]) {
      await checkPage(await (await adminGet(world.app, session(), path)).text(), path);
    }
  });
});
