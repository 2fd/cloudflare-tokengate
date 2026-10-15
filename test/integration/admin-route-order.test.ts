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
    ['POST /admin/users/defaults', 'POST /admin/users/:id'],
    ['GET /admin/tokens/hosts', 'GET /admin/tokens/:id'],
    ['POST /admin/tokens/hosts', 'POST /admin/tokens/:id'],
    ['GET /admin/tokens/keys', 'GET /admin/tokens/:id'],
    ['GET /admin/tokens/new', 'GET /admin/tokens/:id'],
    ['GET /admin/consumers/new', 'GET /admin/consumers/:id'],
    ['GET /admin/access/new', 'GET /admin/access/:id'],
  ])('%s comes before %s', (first, second) => {
    expect(position(first)).toBeLessThan(position(second));
  });

  it.each([
    ['/admin/tokens/keys', '<title>Encryption keys · tokengate</title>'],
    ['/admin/tokens/hosts', '<title>Allowed hosts · tokengate</title>'],
    ['/admin/access/new', '<title>Create a grant · tokengate</title>'],
    ['/admin/consumers/new', '<title>Add a caller provider · tokengate</title>'],
    ['/admin/users/sign-in', '<title>Sign-in · tokengate</title>'],
  ])('GET %s renders its own page', async (path, title) => {
    const app = createTestApp();
    const res = await adminGet(app, await sessionFor(app, 'owner'), path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(title);
  });

  it('POST /admin/tokens/hosts is the allowlist route, not a token edit', async () => {
    const app = createTestApp();
    const fields = { allowed_upstream_hosts: 'api.example.com' };
    const refused = await adminPost(
      app,
      await sessionFor(app, 'token_manager'),
      '/admin/tokens/hosts',
      fields,
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Your role does not allow this action.');
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();

    const saved = await adminPost(
      app,
      await sessionFor(app, 'owner'),
      '/admin/tokens/hosts',
      fields,
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/admin/tokens/hosts?notice=hosts_saved');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.example.com']);
  });
});
