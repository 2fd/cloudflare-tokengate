import { describe, expect, it } from 'vitest';
import {
  can,
  type Permission,
  ROUTE_PERMISSIONS,
  rolesWith,
  routePermission,
} from '../../../../src/admin/auth/rbac';
import type { Role } from '../../../../src/db/types';

/** Every admin route of docs/architecture.md, as Hono route strings. */
const DOCUMENTED_ADMIN_ROUTES = [
  'GET /admin',
  'GET /admin/services',
  'GET /admin/services/new',
  'POST /admin/services',
  'GET /admin/services/:id',
  'POST /admin/services/:id',
  'POST /admin/services/:id/credential',
  'POST /admin/services/:id/test',
  'POST /admin/services/:id/delete',
  'POST /admin/services/:id/toggle',
  'GET /admin/caller-providers',
  'GET /admin/caller-providers/new',
  'GET /admin/caller-providers/:id',
  'POST /admin/caller-providers',
  'POST /admin/caller-providers/:id',
  'POST /admin/caller-providers/:id/delete',
  'POST /admin/caller-providers/:id/toggle',
  'GET /admin/grants',
  'GET /admin/grants/new',
  'GET /admin/grants/:id',
  'POST /admin/grants',
  'POST /admin/grants/:id',
  'POST /admin/grants/:id/delete',
  'POST /admin/grants/:id/toggle',
  'GET /admin/requests',
  'GET /admin/requests/:id',
  'GET /admin/audit',
  'GET /admin/users',
  'POST /admin/users',
  'POST /admin/users/defaults',
  'POST /admin/users/:id',
  'POST /admin/users/:id/approve',
  'POST /admin/users/:id/reject',
  'POST /admin/users/:id/reset-login',
  'POST /admin/users/:id/resend-invite',
  'GET /admin/settings',
  'POST /admin/settings',
  'POST /admin/settings/rewrap',
  'POST /admin/settings/upstream-hosts',
  'POST /admin/export',
];

const MATRIX: Record<Permission, Record<Role, boolean>> = {
  read: { viewer: true, admin: true, owner: true },
  'config:write': { viewer: false, admin: true, owner: true },
  'users:write': { viewer: false, admin: false, owner: true },
  'settings:write': { viewer: false, admin: false, owner: true },
  'keyring:rewrap': { viewer: false, admin: false, owner: true },
};

describe('I-RBAC-1: permission matrix and route table', () => {
  for (const [permission, roles] of Object.entries(MATRIX)) {
    for (const [role, allowed] of Object.entries(roles)) {
      it(`${role} ${allowed ? 'has' : 'lacks'} ${permission}`, () => {
        expect(can(role as Role, permission as Permission)).toBe(allowed);
      });
    }
  }

  it('unknown roles have no permission', () => {
    expect(can('root' as Role, 'read')).toBe(false);
  });

  it('lists exactly the documented admin routes', () => {
    expect(Object.keys(ROUTE_PERMISSIONS).sort()).toEqual([...DOCUMENTED_ADMIN_ROUTES].sort());
  });

  it('marks every POST (and only POSTs) as mutating', () => {
    for (const [key, rule] of Object.entries(ROUTE_PERMISSIONS)) {
      expect(rule.mutates, key).toBe(key.startsWith('POST '));
    }
  });

  it('only read routes are open to viewers', () => {
    for (const [key, rule] of Object.entries(ROUTE_PERMISSIONS)) {
      if (rule.mutates) expect(can('viewer', rule.permission), key).toBe(false);
    }
  });

  it('owner-only operations', () => {
    expect(routePermission('POST', '/admin/users')?.permission).toBe('users:write');
    expect(routePermission('POST', '/admin/users/:id/revoke-sessions')).toBeNull();
    expect(routePermission('POST', '/admin/settings')?.permission).toBe('settings:write');
    expect(routePermission('POST', '/admin/settings/rewrap')?.permission).toBe('keyring:rewrap');
  });

  it('denies unknown routes, other methods and prototype keys', () => {
    expect(routePermission('GET', '/admin/nope')).toBeNull();
    expect(routePermission('DELETE', '/admin/services/:id')).toBeNull();
    expect(routePermission('ALL', '/admin/*')).toBeNull();
    expect(routePermission('GET', '/admin/services/abc')).toBeNull();
    expect(routePermission('constructor', '')).toBeNull();
    expect(routePermission('__proto__', '')).toBeNull();
  });

  it('method lookup is case-insensitive', () => {
    expect(routePermission('get', '/admin')).toEqual({ permission: 'read', mutates: false });
  });
});

describe('rolesWith', () => {
  it('lists exactly the roles for which can() holds', () => {
    expect(rolesWith('read').sort()).toEqual(['admin', 'owner', 'viewer']);
    expect(rolesWith('config:write').sort()).toEqual(['admin', 'owner']);
    expect(rolesWith('users:write')).toEqual(['owner']);
  });
});
