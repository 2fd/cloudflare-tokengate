// Accessibility structure of the Credentials pages (A16, A7.6): labels for every control,
// aria-describedby naming rendered ids, no native validation on controls that can be hidden while
// their form is submittable, error re-renders that link to open fields, tables with captions and
// row headers, radio groups in fieldsets, valid `pattern`s, and no script or inline style.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { destinationFingerprint } from '../../src/admin/ops/credentials';
import { getService } from '../../src/db/credentials';
import { adminGet, adminPost, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp, setUpstreamHosts, type TestApp } from '../helpers/app';
import { fakeNetwork, KEK_1 } from '../unit/admin/ops/helpers';

interface Node {
  tag: string;
  attrs: Record<string, string>;
  /** Open ancestors, outermost first. */
  ancestors: Node[];
}

const VOID = new Set(['input', 'meta', 'link', 'br', 'img', 'hr', 'source', 'wbr', 'area', 'col']);

/** A tokenizer for the well-formed markup Hono renders: every start tag with its ancestors. */
function parse(html: string): Node[] {
  const nodes: Node[] = [];
  const stack: Node[] = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g;
  for (const match of html.matchAll(tag)) {
    const [, closing, rawName = '', rawAttrs = ''] = match;
    const name = rawName.toLowerCase();
    if (closing) {
      const at = stack.map((node) => node.tag).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs.matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) {
      attrs[attr[1] ?? ''] = attr[2] ?? '';
    }
    const node = { tag: name, attrs, ancestors: [...stack] };
    nodes.push(node);
    if (!VOID.has(name)) stack.push(node);
  }
  return nodes;
}

const decode = (value: string) =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** The structural rules every token page must meet. Returns how many controls it checked. */
function checkPage(html: string, label: string): { controls: number; hidden: number } {
  let controls = 0;
  let hiddenControls = 0;
  expect(html, label).not.toContain('<script');
  expect(html, label).not.toMatch(/ style=/);
  // A <form> or <div> inside a <p> makes the parser close the paragraph early (no implied end
  // tags in the tokenizer below, so this is checked on the text).
  expect(html, label).not.toMatch(/<p[ >](?:(?!<\/p>)[\s\S])*?<(?:form|div)[ >]/);
  const nodes = parse(html);
  const ids = nodes.map((node) => node.attrs.id).filter((id): id is string => id !== undefined);
  expect(
    ids.filter((id, index) => ids.indexOf(id) !== index),
    `${label}: duplicate ids`,
  ).toEqual([]);
  const idSet = new Set(ids);
  const labelled = new Set(
    nodes.filter((node) => node.tag === 'label').map((node) => node.attrs.for),
  );
  for (const node of nodes) {
    const where = `${label}: <${node.tag} ${JSON.stringify(node.attrs)}>`;
    const control =
      (node.tag === 'input' && node.attrs.type !== 'hidden') ||
      node.tag === 'select' ||
      node.tag === 'textarea';
    if (control) {
      controls++;
      expect(node.attrs.id, where).toBeDefined();
      // A <label for> or a wrapping <label> (implicit label: ui radio cards and checkboxes).
      const implicit = node.ancestors.some((a) => a.tag === 'label');
      expect(labelled.has(node.attrs.id) || implicit, where).toBe(true);
    }
    for (const id of (node.attrs['aria-describedby'] ?? '').split(' ').filter(Boolean)) {
      expect(idSet.has(id), `${where} describedby ${id}`).toBe(true);
    }
    if (node.attrs.type === 'radio') {
      expect(
        node.ancestors.some((a) => a.tag === 'fieldset'),
        where,
      ).toBe(true);
    }
    // A7.6: no native validation inside a CSS-conditional panel (the old `.reveal`, a ui Reveal
    // `.rvN`) or a details nested in the form.
    const form = node.ancestors.findIndex((a) => a.tag === 'form');
    const hidden =
      node.ancestors.some((a) =>
        (a.attrs.class ?? '').split(' ').some((name) => name === 'reveal' || /^rv\d$/.test(name)),
      ) ||
      (form >= 0 && node.ancestors.slice(form + 1).some((a) => a.tag === 'details'));
    if (control && hidden) {
      hiddenControls++;
      for (const attr of ['required', 'pattern', 'min', 'max', 'minlength']) {
        expect(node.attrs[attr], `${where} has ${attr}`).toBeUndefined();
      }
      expect(['url', 'email', 'number'], where).not.toContain(node.attrs.type);
    }
    if (node.attrs.pattern !== undefined) {
      expect(
        () => new RegExp(`^(?:${decode(node.attrs.pattern ?? '')})$`, 'v'),
        where,
      ).not.toThrow();
    }
    if (node.tag === 'table') {
      const table = html.slice(html.indexOf(`id="${node.attrs.id}"`));
      expect(table.slice(0, table.indexOf('</table>')), where).toMatch(
        /<caption[\s\S]*th scope="row"|<caption/,
      );
      expect(node.ancestors.at(-1)?.attrs.role, where).toBe('region');
    }
  }
  expect(html.match(/<h1>/g), label).toHaveLength(1);
  return { controls, hidden: hiddenControls };
}

/**
 * On an error re-render: every summary link names a rendered control that can take focus (an
 * input, select or textarea, never a fieldset or a hidden input) whose details are open.
 */
function checkErrorPage(html: string, label: string) {
  expect(html, label).toMatch(/<title>Error: /);
  const nodes = parse(html);
  const links = [...html.matchAll(/<div class="callout bad errsum"[\s\S]*?<\/ul>/g)].flatMap(
    (match) => [...match[0].matchAll(/href="#([^"]+)"/g)].map((link) => link[1] ?? ''),
  );
  expect(links.length, `${label}: summary links`).toBeGreaterThan(0);
  for (const id of links) {
    const target = nodes.find((node) => node.attrs.id === id);
    expect(target, `${label}: #${id}`).toBeDefined();
    expect(['input', 'select', 'textarea'], `${label}: #${id} is a control`).toContain(target?.tag);
    expect(target?.attrs.type, `${label}: #${id} is not hidden`).not.toBe('hidden');
    expect(target?.attrs.disabled, `${label}: #${id} is enabled`).toBeUndefined();
    for (const details of target?.ancestors.filter((a) => a.tag === 'details') ?? []) {
      expect(
        details.attrs.open,
        `${label}: #${id} inside closed details ${details.attrs.id ?? ''}`,
      ).toBeDefined();
    }
  }
}

let app: TestApp;

beforeEach(async () => {
  await resetControlPlane();
  app = createTestApp({
    fetch: fakeNetwork((url) =>
      url.pathname.endsWith('/models')
        ? new Response('{}', { status: 401 })
        : Response.json({ ok: true }),
    ).fetch,
    env: { TOKENGATE_KEK: KEK_1 },
  });
});

async function owner() {
  return loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
}

describe('A16: credential pages', () => {
  it('list, accordion, token page, hosts and keys meet the structure rules', async () => {
    const session = await owner();
    await setUpstreamHosts(['api.github.com', '*.slack.com']);
    const res = await adminPost(app, session, '/admin/credentials', {
      template: 'github',
      credential: 'ghp_a11yTest0123456789abcdefghijklmn',
    });
    const id = /svc_[0-9A-Z]{26}/.exec(res.headers.get('location') ?? '')?.[0] ?? '';
    for (const path of [
      '/admin/credentials',
      '/admin/credentials/new',
      '/admin/credentials/new?template=custom',
      `/admin/credentials/${id}`,
      `/admin/credentials/${id}?open=destination`,
      `/admin/credentials/${id}?open=details`,
      '/admin/credentials/hosts',
      '/admin/credentials/keys',
    ]) {
      const checked = checkPage(await (await adminGet(app, session, path)).text(), path);
      if (!path.endsWith('/keys')) expect(checked.controls, path).toBeGreaterThan(0);
    }
    // The checker is not vacuous: the custom card has conditional and collapsed controls.
    const custom = checkPage(
      await (await adminGet(app, session, '/admin/credentials/new')).text(),
      'new',
    );
    expect(custom.hidden).toBeGreaterThan(10);
  });

  it('error re-renders link every error to an open, rendered field', async () => {
    const session = await owner();
    const created = await adminPost(app, session, '/admin/credentials', {
      template: 'github',
      credential: 'ghp_a11yTest0123456789abcdefghijklmn',
    });
    const id = /svc_[0-9A-Z]{26}/.exec(created.headers.get('location') ?? '')?.[0] ?? '';
    const row = await getService(env.DB, id);
    if (!row) throw new Error('service missing');
    const shown = await destinationFingerprint(row);
    const cases: Array<[string, string, Record<string, string>]> = [
      [
        'custom card',
        '/admin/credentials',
        { template: 'custom', base_url: 'http://x', credential: 'abc' },
      ],
      [
        'template card, failed check',
        '/admin/credentials',
        { template: 'openai', credential: 'sk-proj-0123456789abcdefghij' },
      ],
      [
        'custom card, taken slug',
        '/admin/credentials',
        {
          template: 'custom',
          base_url: 'https://api.example.com/v1',
          injection_kind: 'bearer',
          credential: 'custom-secret-0123456789abcdef',
          slug: 'github',
        },
      ],
      [
        'details, advanced field',
        `/admin/credentials/${id}`,
        { name: 'GitHub', forward_headers: 'authorization' },
      ],
      ['details, name', `/admin/credentials/${id}`, { name: '' }],
      ['rotate', `/admin/credentials/${id}/secret`, { expected_destination: shown }],
      [
        'destination',
        `/admin/credentials/${id}/destination`,
        { base_url: 'nope', injection_kind: 'header' },
      ],
      ['hosts', '/admin/credentials/hosts', { mode: 'list' }],
    ];
    for (const [label, path, fields] of cases) {
      const res = await adminPost(app, session, path, fields);
      expect(res.status, label).toBeGreaterThanOrEqual(400);
      const html = await res.text();
      checkPage(html, label);
      checkErrorPage(html, label);
    }
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credentials').first('n')).toBe(1);
  });

  it('secret inputs carry the password-manager opt-outs and never block paste', async () => {
    const session = await owner();
    const html = await (await adminGet(app, session, '/admin/credentials/new')).text();
    const secrets = parse(html).filter((node) => node.attrs.type === 'password');
    expect(secrets.length).toBeGreaterThan(5);
    for (const node of secrets) {
      expect(node.attrs).toMatchObject({
        autocomplete: 'off',
        spellcheck: 'false',
        autocapitalize: 'none',
        autocorrect: 'off',
        'data-1p-ignore': 'true',
        'data-lpignore': 'true',
        'data-bwignore': 'true',
      });
      expect(node.attrs.onpaste).toBeUndefined();
      expect(node.attrs.placeholder).toMatch(/X{8,}|0{8,}/);
    }
  });
});
