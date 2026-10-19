// I-RBAC-1 and route registration order: the admin middleware looks up the permission of the first
// matched route, so a static segment (`hosts`, `keys`, `new`, `sign-in`) must be registered before
// the `:id` route it would otherwise be taken for (src/admin/routes/index.ts).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getAllowedUpstreamHosts } from '../../src/db/settings';
import type { Role } from '../../src/db/types';
import { adminGet, adminPost, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';

beforeEach(async () => {
  await resetControlPlane();
});

async function sessionFor(app: ReturnType<typeof createTestApp>, role: Role) {
  return loginAs(app, await createUser({ email: `${role}@example.com`, role }));
}

describe('I-RBAC-1: static admin routes are registered before their :id siblings', () => {
  const order = createApp()
    .routes.filter((route) => route.method !== 'ALL')
    .map((route) => `${route.method} ${route.path}`);
  const position = (key: string) => {
    const index = order.indexOf(key);
    expect(index, key).toBeGreaterThanOrEqual(0);
    return index;
  };

  it.each([
    ['GET /admin/users/sign-in', 'POST /admin/users/:id'],
    ['POST /admin/users/sign-in/hosts', 'POST /admin/users/:id'],
    ['POST /admin/users/sign-in/policy', 'POST /admin/users/:id'],
    ['GET /admin/users/sign-in', 'GET /admin/users/:id'],
    ['GET /admin/credentials/hosts', 'GET /admin/credentials/:id'],
    ['POST /admin/credentials/hosts', 'POST /admin/credentials/:id'],
    ['GET /admin/credentials/keys', 'GET /admin/credentials/:id'],
    ['GET /admin/credentials/new', 'GET /admin/credentials/:id'],
    ['GET /admin/credential-access-rules/new', 'GET /admin/credential-access-rules/:id'],
    ['GET /admin/global-access-rules/new', 'GET /admin/global-access-rules/:id'],
  ])('%s comes before %s', (first, second) => {
    expect(position(first)).toBeLessThan(position(second));
  });

  it.each([
    ['/admin/credentials/keys', '<title>Encryption keys – Credentials – tokengate</title>'],
    ['/admin/credentials/hosts', '<title>Allowed hosts – Credentials – tokengate</title>'],
    [
      '/admin/global-access-rules/new',
      '<title>Add global access rule – Access Rules – tokengate</title>',
    ],
    [
      '/admin/credential-access-rules/new',
      '<title>Add credential access rule – Access Rules – tokengate</title>',
    ],
    ['/admin/users/sign-in', '<title>Sign-in – Users – tokengate</title>'],
  ])('GET %s renders its own page', async (path, title) => {
    const app = createTestApp();
    const res = await adminGet(app, await sessionFor(app, 'owner'), path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(title);
  });

  it('GET /admin/global-access-rules/new keeps its own permission, not the read of :id', async () => {
    const app = createTestApp();
    const res = await adminGet(
      app,
      await sessionFor(app, 'access_manager'),
      '/admin/global-access-rules/new',
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Your role does not allow this action.');
  });

  it('POST /admin/credentials/hosts is the allowlist route, not a token edit', async () => {
    const app = createTestApp();
    const fields = { mode: 'list', other_hosts: 'api.example.com' };
    const refused = await adminPost(
      app,
      await sessionFor(app, 'token_manager'),
      '/admin/credentials/hosts',
      fields,
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Your role does not allow this action.');
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();

    const saved = await adminPost(
      app,
      await sessionFor(app, 'owner'),
      '/admin/credentials/hosts',
      fields,
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/admin/credentials/hosts?notice=hosts_saved');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.example.com']);
  });
});
