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
