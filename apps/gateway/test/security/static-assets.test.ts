// The admin stylesheets are served by the Worker at hashed /static URLs (src/http/static.ts):
// immutable when hashed, revalidated at the stable URL, with the same browser headers as every
// other response and without the /admin no-store. Every admin page links exactly these two, in
// order. pages.css takes its colors from the ui.css tokens only.
import { uiCss } from '@tokengate/ui/css';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ADMIN_STYLESHEETS, pagesCss } from '../../src/admin/assets';
import { CONTENT_SECURITY_POLICY } from '../../src/http/security';
import { adminGet, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';

describe('admin stylesheets', () => {
  it('serves ui.css at its hashed URL, immutable, with the browser headers', async () => {
    const res = await createTestApp().request(uiCss.href);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // The wrangler Text rule bundles the real stylesheet, not an empty module.
    expect(await res.text()).toContain('.hstrip');
  });

  it('revalidates the stable URL and answers 304 to a matching ETag', async () => {
    const app = createTestApp();
    const res = await app.request(uiCss.stablePath);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    const etag = res.headers.get('etag') ?? '';
    expect(etag).toBe(`"${uiCss.hash}"`);
    const again = await app.request(uiCss.stablePath, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });

  it('serves pages.css and nothing else under /static', async () => {
    const app = createTestApp();
    expect((await app.request(pagesCss.href)).status).toBe(200);
    for (const path of ['/static/nope.css', '/static/app.css', '/static/ui.0000000000.css']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control'), path).toBeNull();
    }
  });

  it('links exactly ui.css then pages.css on an admin page', async () => {
    onTestFinished(() => resetControlPlane());
    const app = createTestApp();
    const owner = await createUser({ email: 'o@example.com', role: 'owner' });
    const html = await (
      await adminGet(app, await loginAs(app, owner), '/admin/credentials')
    ).text();
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual(ADMIN_STYLESHEETS.map((asset) => asset.href));
    expect(links).toEqual([uiCss.href, pagesCss.href]);
  });

  it('pages.css uses the ui.css tokens only: no color literal and no new light-dark()', () => {
    const text = pagesCss.text.replace(/\/\*[\s\S]*?\*\//g, '');
    // Declarations only (the innermost blocks): an id selector such as #add is not a color.
    const declarations = [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).join('\n');
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(text).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch|light-dark)\(/);
    expect(pagesCss.name).not.toMatch(/docs$/);
  });
});
