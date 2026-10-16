// Every docs route answers from the registry and the foundations list, with the hardened headers.
import { uiCss } from '@tokengate/ui/css';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { docsCss } from '../src/assets';
import { FOUNDATIONS } from '../src/foundations';
import { GROUPS, REGISTRY, componentHref } from '../src/registry';
import { CONTENT_SECURITY_POLICY } from '../src/security';

const app = createApp();
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
  it('redirects / to /docs', async () => {
    const res = await get('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/docs');
  });

  it.each(pages)('%s renders with the CSP and both stylesheets', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<link rel="stylesheet" href="${uiCss.href}"/>`);
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

  it('the sidebar links every foundation and group page', async () => {
    const html = await (await get('/docs')).text();
    expect(html).toContain('href="/docs/foundations/');
    for (const group of GROUPS) expect(html).toContain(`href="/docs/components/${group.key}"`);
  });

  it.each(GROUPS)('the open $label section lists every component of the group', async (group) => {
    const html = await (await get(`/docs/components/${group.key}`)).text();
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('<main'));
    for (const doc of REGISTRY[group.key]) {
      expect(nav, doc.name).toContain(`href="${componentHref(group.key, doc.slug)}"`);
      expect(nav, doc.name).toContain(`>${doc.name}<`);
    }
  });

  it.each(FOUNDATIONS)('the open Foundations section lists $title', async (topic) => {
    const html = await (await get(`/docs/foundations/${topic.slug}`)).text();
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('<main'));
    for (const other of FOUNDATIONS)
      expect(nav).toContain(`href="/docs/foundations/${other.slug}"`);
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
  it.each([uiCss, docsCss])('serves $href as immutable CSS', async (asset) => {
    const res = await get(asset.href);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toBe(asset.text);
  });

  it('serves the stable URL with revalidation and 404s an old hash', async () => {
    expect((await get('/static/ui.css')).headers.get('cache-control')).toContain('must-revalidate');
    expect((await get('/static/ui.0000000000.css')).status).toBe(404);
  });

  it('the docs stylesheet uses tokens, not hard-coded colors', () => {
    expect(docsCss.text).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
