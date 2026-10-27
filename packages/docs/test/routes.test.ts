// Every docs route answers from the registry and the foundations list, with the hardened headers.
import { describe, expect, it } from 'vitest';
import { createDocsApp, isDocsPath } from '../src/app';
import { docsCss, docsUiCss } from '../src/assets';
import { FOUNDATIONS } from '../src/foundations';
import { GROUPS, REGISTRY, componentHref } from '../src/registry';
import { CONTENT_SECURITY_POLICY } from '../src/security';

const app = createDocsApp();
const get = (path: string, init?: RequestInit) => app.request(`https://docs.test${path}`, init);

const pages = [
  '/docs',
  ...FOUNDATIONS.map((topic) => `/docs/foundations/${topic.slug}`),
  ...GROUPS.map((group) => `/docs/components/${group.key}`),
  ...GROUPS.flatMap((group) =>
    REGISTRY[group.key].map((doc) => componentHref(group.key, doc.slug)),
  ),
];

describe('docs pages', () => {
  it('isDocsPath matches /docs and the paths below it only', () => {
    for (const path of ['/docs', '/docs/', '/docs/components/layout/app-shell', '/docs/static/x'])
      expect(isDocsPath(path), path).toBe(true);
    for (const path of ['/', '/doc', '/docsx', '/docs.css', '/static/ui.css', '/admin/docs'])
      expect(isDocsPath(path), path).toBe(false);
  });

  it('answers nothing outside /docs (the gateway owns /, /static/* and every other path)', async () => {
    for (const path of ['/', '/static/ui.css', `/static/${docsUiCss.href.split('/').pop()}`]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it.each(pages)('%s renders with the CSP and both stylesheets', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<link rel="stylesheet" href="${docsUiCss.href}"/>`);
    expect(html).toContain(`<link rel="stylesheet" href="${docsCss.href}"/>`);
    // No client JS and nothing the CSP would block.
    expect(html).not.toMatch(/<script|\son[a-z]+=|style="|javascript:/i);
    // One main landmark and one h1 outside the examples.
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toContain('aria-current="page"');
    // Ids are unique, so every label, describedby and fragment link points at one element (the
    // chart patterns render once, from the layout).
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('the sidebar is the admin one: labeled groups with every page visible', async () => {
    const html = await (await get('/docs')).text();
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('<main'));
    expect(nav).not.toContain('nav-sub');
    const labels = [...nav.matchAll(/<div class="nav-label">([^<]+)<\/div>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Introduction', 'Foundations', ...GROUPS.map((group) => group.label)]);
    for (const topic of FOUNDATIONS)
      expect(nav).toContain(`href="/docs/foundations/${topic.slug}"`);
    for (const group of GROUPS) {
      expect(nav).toContain(`href="/docs/components/${group.key}"`);
      for (const doc of REGISTRY[group.key]) {
        expect(nav, doc.name).toContain(`href="${componentHref(group.key, doc.slug)}"`);
        expect(nav, doc.name).toContain(`>${doc.name}<`);
      }
    }
  });

  it.each(GROUPS)('the $label index is the current "All components" item', async (group) => {
    const html = await (await get(`/docs/components/${group.key}`)).text();
    expect(html).toMatch(
      new RegExp(
        `href="/docs/components/${group.key}"[^>]*aria-current="page"[^>]*>(?:(?!</a>).)*All components`,
        's',
      ),
    );
  });

  it.each(FOUNDATIONS)('$title is the current Foundations item', async (topic) => {
    const html = await (await get(`/docs/foundations/${topic.slug}`)).text();
    expect(html).toMatch(
      new RegExp(`href="/docs/foundations/${topic.slug}"[^>]*aria-current="page"`),
    );
  });

  it.each(
    GROUPS.flatMap((group) =>
      REGISTRY[group.key].map((doc) => [componentHref(group.key, doc.slug), doc] as const),
    ),
  )('%s is the current nav item and documents every export it covers', async (path, doc) => {
    const html = await (await get(path)).text();
    expect(html).toMatch(new RegExp(`href="${path}"[^>]*aria-current="page"`));
    for (const name of [doc.name, ...(doc.related ?? [])]) expect(html, name).toContain(name);
  });

  it('answers 404 with the docs chrome for unknown pages', async () => {
    for (const path of [
      '/docs/nope',
      '/docs/foundations/nope',
      '/docs/components/nope',
      '/docs/components/base/nope',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain('Page not found');
    }
  });

  it('the CSP has no script-src and only same-origin styles', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('script-src');
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self'");
  });
});

describe('stylesheets', () => {
  it.each([docsUiCss, docsCss])('serves $href as immutable CSS', async (asset) => {
    expect(asset.href.startsWith('/docs/static/')).toBe(true);
    const res = await get(asset.href);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toBe(asset.text);
  });

  it('serves the stable URL with revalidation and 404s an old hash', async () => {
    expect((await get('/docs/static/ui.css')).headers.get('cache-control')).toContain(
      'must-revalidate',
    );
    expect((await get('/docs/static/ui.0000000000.css')).status).toBe(404);
  });

  it('the docs stylesheet uses tokens, not hard-coded colors', () => {
    expect(docsCss.text).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
