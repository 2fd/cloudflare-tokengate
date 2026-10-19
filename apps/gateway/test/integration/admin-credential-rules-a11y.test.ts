// Markup rules of the credential access rule pages and form (WCAG 2.2 AA, §A7.6-A7.8), checked on the real
// pages with HTMLRewriter: labelled controls, grouped radios, rendered describedby ids, one name
// per branch, no native validation where a control can be hidden, and patterns that browsers
// compile (`v` flag) and that accept their own placeholder.
import { beforeEach, describe, expect, it } from 'vitest';
import { type RulesWorld, rulesWorld } from '../helpers/access-rules';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  OWNER_ID,
  REPOSITORY_ID,
  seedCredentialRule,
  seedService,
} from '../unit/admin/ops/helpers';

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
 * reveals (`.rv1` … `.rv8`), and the page-local scoped branches of the rule form (issuer
 * type branches, credential branches, scoped reveals, the copy form's "Another…").
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

let world: RulesWorld;

beforeEach(async () => {
  world = await rulesWorld();
});

const session = () => world.sessions.access_manager;
const RULES = '/admin/credential-access-rules';
const J = 'new.github-actions.';

function rows(token: string, extra: Record<string, string> = {}) {
  return {
    token_id: token,
    token_view: 'fixed',
    'new.type': 'github-actions',
    'new.github_org': `acme (${OWNER_ID})`,
    [`${J}editor`]: 'rows',
    [`${J}cond.0.claim`]: 'repository_owner_id',
    [`${J}cond.0.values`]: OWNER_ID,
    [`${J}cond.1.claim`]: 'repository_id',
    [`${J}cond.1.values`]: '5',
    ops: '1',
    op: 'custom',
    'rule.0.m': 'GET',
    'rule.0.path': '/x',
    expires: 'never',
    ...extra,
  };
}

describe('credential access rule markup (WCAG 2.2 AA)', () => {
  it('the form with every issuer type and several credentials to choose from', async () => {
    const token = await seedService(world.app.deps);
    await seedCredentialRule(world.app.deps, { credential_id: token });
    await seedService(world.app.deps, {
      slug: 'other',
      name: 'Other',
      base_url: 'https://api.openai.com/v1',
    });
    const html = await (await adminGet(world.app, session(), `${RULES}/new`)).text();
    const nodes = await checkPage(html, 'rule form');
    // The checks ran on real branches: prefixed fields, several of them hidden in reveals.
    expect(controls(nodes).length).toBeGreaterThan(40);
    expect(controls(nodes).filter(hidden).length).toBeGreaterThan(20);
    expect(new Set(controls(nodes).map(branchOf)).size).toBeGreaterThan(5);
  });

  it('the fixed form, its error re-render and the rows editor', async () => {
    const token = await seedService(world.app.deps);
    await checkPage(
      await (await adminGet(world.app, session(), `${RULES}/new`)).text(),
      'fixed form',
    );
    const error = await adminPost(world.app, session(), RULES, {
      token_id: token,
      'new.type': 'github-actions',
      'new.github_org': `acme (${OWNER_ID})`,
      [`${J}repository`]: 'acme/api',
      [`${J}context`]: 'environment',
      [`${J}environment`]: '',
      ops: '1',
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
    const editor = await adminPost(world.app, session(), RULES, {
      ...rows(token),
      _action: `add:${J}cond`,
    });
    expect(editor.status).toBe(200);
    const rowsHtml = await editor.text();
    expect(rowsHtml).toContain(`name="${J}cond.3.claim"`);
    await checkPage(rowsHtml, 'rows editor');
  });

  it('a risk to accept: the summary link lands on the invalid box', async () => {
    const token = await seedService(world.app.deps);
    const res = await adminPost(world.app, session(), RULES, rows(token));
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

  it('the list, the add form, the rule page and its edit form', async () => {
    const token = await seedService(world.app.deps);
    const res = await adminPost(world.app, session(), RULES, {
      token_id: token,
      'new.type': 'github-actions',
      'new.github_org': `acme (${OWNER_ID})`,
      [`${J}repository`]: `acme/api (${REPOSITORY_ID})`,
      [`${J}context`]: 'branch',
      [`${J}branch`]: 'main',
      [`${J}ref_protection`]: 'protected',
      ops: '1',
      op: 'read-repo',
      expires: 'never',
    });
    expect(res.status).toBe(303);
    const location = (res.headers.get('location') ?? '').split('?')[0] ?? '';
    // A rows-mode rule with warnings: its edit form shows the risks up front.
    const risky = rows(token, {
      [`${J}cond.2.claim`]: 'ref',
      [`${J}cond.2.match`]: 'glob',
      [`${J}cond.2.values`]: 'refs/heads/*',
      [`${J}cond.3.claim`]: 'actor',
      [`${J}cond.3.values`]: 'octocat',
      name: 'risky',
    });
    const first = await adminPost(world.app, session(), RULES, risky);
    const digest = /name="warnings_digest" value="([0-9a-f]+)"/.exec(await first.text())?.[1] ?? '';
    const saved = await adminPost(world.app, session(), RULES, {
      ...risky,
      warnings_digest: digest,
      acknowledge_warnings: '1',
    });
    expect(saved.status).toBe(303);
    const riskyPath = (saved.headers.get('location') ?? '').split('?')[0] ?? '';
    for (const path of [
      RULES,
      `${RULES}?status=disabled`,
      `${RULES}?credential=${token}`,
      `${RULES}/new?credential=${token}`,
      location,
      `${location}?open=edit`,
      riskyPath,
      `${riskyPath}?open=edit`,
    ]) {
      await checkPage(await (await adminGet(world.app, session(), path)).text(), path);
    }
  });
});
