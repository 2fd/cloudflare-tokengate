import { posix } from 'node:path';
// The design system docs (@tokengate/docs) exist in local development only: src/dev.ts serves them
// on loopback hostnames, and the production entry (src/index.ts) has no /docs and cannot reach the
// package. scripts/check-bundle.sh checks the same on the real wrangler bundles.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import dev from '../../src/dev';
import worker from '../../src/index';
import wranglerJsonc from '../../wrangler.jsonc?raw';

type Handler = { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };

async function call(handler: Handler, url: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await handler.fetch(new Request(url, { redirect: 'manual' }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const prod = worker as unknown as Handler;
const devEntry = dev as unknown as Handler;

const DOCS_PATHS = ['/docs', '/docs/', '/docs/components/layout/app-shell', '/docs/foundations'];
const LOOPBACK_ORIGINS = ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'];

describe('I-DEPLOY-2: docs are dev-only (production entry)', () => {
  it.each(DOCS_PATHS)('src/index.ts answers 404 for %s on localhost', async (path) => {
    const res = await call(prod, `http://localhost:8787${path}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('design system');
  });

  it('src/index.ts answers 404 for the docs stylesheet path', async () => {
    const res = await call(prod, 'http://localhost:8787/docs/static/docs.css');
    expect(res.status).toBe(404);
  });
});

describe('I-DEPLOY-2: docs are dev-only (dev entry)', () => {
  it.each(LOOPBACK_ORIGINS)('src/dev.ts serves /docs on %s, with no script', async (origin) => {
    const res = await call(devEntry, `${origin}/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).not.toContain('script-src');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Design system');
    expect(html).not.toMatch(/<script/i);
  });

  it('src/dev.ts serves component pages and the stylesheets under /docs/static/', async () => {
    const page = await call(devEntry, 'http://localhost:8787/docs/components/layout/app-shell');
    expect(page.status).toBe(200);
    const html = await page.text();
    const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/docs\/static\/[a-z]+\.[0-9a-f]+\.css$/);
      const css = await call(devEntry, `http://localhost:8787${href}`);
      expect(css.status, href).toBe(200);
      expect(css.headers.get('content-type'), href).toBe('text/css; charset=utf-8');
      expect((await css.text()).length, href).toBeGreaterThan(1000);
    }
  });

  it.each(['gate.example.com', 'tokengate.example.workers.dev', 'localhost.example.com'])(
    'src/dev.ts falls through to the production 404 for /docs on %s',
    async (host) => {
      for (const path of DOCS_PATHS) {
        const res = await call(devEntry, `https://${host}${path}`);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).not.toContain('design system');
      }
    },
  );

  it('src/dev.ts leaves every other path to the production handler', async () => {
    for (const path of ['/', '/healthz', '/docsx', '/static/app.css', '/admin/docs']) {
      const a = await call(devEntry, `http://localhost:8787${path}`);
      const b = await call(prod, `http://localhost:8787${path}`);
      expect(a.status, path).toBe(b.status);
    }
    expect(dev.scheduled).toBe(worker.scheduled);
    expect(dev.queue).toBe(worker.queue);
  });
});

describe('I-DEPLOY-2: docs are dev-only (the production entry cannot import them)', () => {
  const sources = import.meta.glob<string>(['../../src/**/*.ts', '../../src/**/*.tsx'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const DEV_ENTRY = '../../src/dev.ts';
  const specifiers = (text: string) =>
    [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);

  it('finds the sources', () => {
    expect(Object.keys(sources)).toContain('../../src/index.ts');
    expect(Object.keys(sources)).toContain(DEV_ENTRY);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it('only src/dev.ts imports @tokengate/docs or packages/docs', () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => file !== DEV_ENTRY)
      .flatMap(([file, text]) =>
        specifiers(text)
          .filter((spec) => /^@tokengate\/docs(\/|$)|(^|\/)packages\/docs(\/|$)/.test(spec))
          .map((spec) => `${file}: ${spec}`),
      );
    expect(offenders).toEqual([]);
  });

  it('no source imports src/dev.ts, so nothing reachable from src/index.ts reaches the docs', () => {
    const offenders = Object.entries(sources).flatMap(([file, text]) =>
      specifiers(text)
        .filter((spec) => spec.startsWith('.'))
        .map((spec) => posix.join(posix.dirname(file), spec).replace(/\.tsx?$/, ''))
        .filter((target) => target === '../../src/dev')
        .map((target) => `${file}: ${target}`),
    );
    expect(offenders).toEqual([]);
  });

  it('wrangler.jsonc main is src/index.ts and only `pnpm dev` runs src/dev.ts', () => {
    // Comment lines dropped, as in scripts/check-config.sh; no setting may name the dev entry.
    const config = wranglerJsonc
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    expect(config).toMatch(/^\s*"main": "src\/index\.ts",$/m);
    expect(config).not.toContain('dev.ts');
    expect(packageJson.scripts.dev).toBe('wrangler dev src/dev.ts');
    for (const [name, script] of Object.entries(packageJson.scripts)) {
      if (name !== 'dev') expect(script, name).not.toContain('dev.ts');
    }
  });

  it('@tokengate/docs is a devDependency of the gateway, never a dependency', () => {
    expect(Object.keys(packageJson.dependencies)).not.toContain('@tokengate/docs');
    expect(packageJson.devDependencies).toHaveProperty('@tokengate/docs');
  });
});
