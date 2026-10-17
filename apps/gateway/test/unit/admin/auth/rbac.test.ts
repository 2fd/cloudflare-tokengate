import { describe, expect, it } from 'vitest';
import {
  ALL_ROLES,
  can,
  type Permission,
  ROUTE_PERMISSIONS,
  requestPermissions,
  rolesWith,
  rolesWithAll,
  routePermission,
} from '../../../../src/admin/auth/rbac';
import type { Role } from '../../../../src/db/types';

/**
 * Every admin route of docs/architecture.md, as Hono route strings, in the same section blocks as
 * ROUTE_PERMISSIONS. Add or remove keys only inside your own block.
 */
const DOCUMENTED_ADMIN_ROUTES = [
  // == monitoring ==
  'GET /admin',
  'GET /admin/requests',
  'GET /admin/requests/:id',
  'GET /admin/audit',
  'GET /admin/retention',
  'POST /admin/retention',

  // == users ==
  'GET /admin/users/sign-in',
  'POST /admin/users/sign-in/policy',
  'POST /admin/users/sign-in/hosts',
  'GET /admin/users',
  'POST /admin/users',
  'GET /admin/users/:id',
  'POST /admin/users/:id',
  'POST /admin/users/:id/approve',
  'POST /admin/users/:id/reject',
  'POST /admin/users/:id/reset-login',
  'POST /admin/users/:id/resend-invite',
  'POST /admin/users/:id/delete',
  'POST /admin/users/:id/dismiss-attempt',

  // == tokens ==
  'GET /admin/credentials/hosts',
  'POST /admin/credentials/hosts',
  'GET /admin/credentials/keys',
  'POST /admin/credentials/keys/rewrap',
  'GET /admin/credentials',
  'GET /admin/credentials/new',
  'POST /admin/credentials',
  'GET /admin/credentials/:id',
  'POST /admin/credentials/:id',
  'POST /admin/credentials/:id/secret',
  'POST /admin/credentials/:id/destination',
  'POST /admin/credentials/:id/test',
  'POST /admin/credentials/:id/delete',
  'POST /admin/credentials/:id/toggle',

  // == consumers ==
  'GET /admin/credential-access-rules',
  'GET /admin/credential-access-rules/new',
  'GET /admin/credential-access-rules/:id',
  'POST /admin/credential-access-rules',
  'POST /admin/credential-access-rules/:id',
  'POST /admin/credential-access-rules/:id/delete',
  'POST /admin/credential-access-rules/:id/tenants',
  'POST /admin/credential-access-rules/:id/toggle',
  'GET /admin/issuer-access-rules',
  'GET /admin/issuer-access-rules/new',
  'GET /admin/issuer-access-rules/:id',
  'POST /admin/issuer-access-rules',
  'POST /admin/issuer-access-rules/:id',
  'POST /admin/issuer-access-rules/:id/copy',
  'POST /admin/issuer-access-rules/:id/delete',
  'POST /admin/issuer-access-rules/:id/toggle',

  // == global ==
  'POST /admin/export',
];

/** Field permissions per route, in the same section blocks. */
const FIELD_PERMISSIONS: Record<string, Record<string, Permission>> = {
  // == tokens ==
  'POST /admin/credentials': { allow_host: 'settings:write' },
  'POST /admin/credentials/:id/destination': { allow_host: 'settings:write' },
  'POST /admin/credentials/:id/delete': { with_accesses: 'access:write' },
};

const ROLES: Role[] = ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'];

// Columns: viewer, token_manager, access_manager, admin, owner (ADR 0018).
const MATRIX: Record<Permission, [boolean, boolean, boolean, boolean, boolean]> = {
  read: [true, true, true, true, true],
  'tokens:write': [false, true, false, true, true],
  'access:write': [false, false, true, true, true],
  'config:export': [false, false, false, true, true],
  'users:write': [false, false, false, false, true],
  'settings:write': [false, false, false, false, true],
  'keyring:rewrap': [false, false, false, false, true],
};

describe('I-RBAC-1: permission matrix and route table', () => {
  for (const [permission, row] of Object.entries(MATRIX)) {
    ROLES.forEach((role, i) => {
      const allowed = row[i];
      it(`${role} ${allowed ? 'has' : 'lacks'} ${permission}`, () => {
        expect(can(role, permission as Permission)).toBe(allowed);
      });
    });
  }

  it('lists the five roles in privilege order', () => {
    expect(ALL_ROLES).toEqual(ROLES);
  });

  it('unknown roles have no permission', () => {
    expect(can('root' as Role, 'read')).toBe(false);
    expect(can('superuser' as Role, 'tokens:write')).toBe(false);
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

  it('token routes need tokens:write, consumer and access routes need access:write', () => {
    for (const [key, rule] of Object.entries(ROUTE_PERMISSIONS)) {
      if (key.startsWith('GET ') && rule.permission === 'read') continue;
      if (/^\w+ \/admin\/credentials(?!\/(hosts|keys))/.test(key))
        expect(rule.permission, key).toBe('tokens:write');
      if (/^\w+ \/admin\/(consumers|access)/.test(key)) {
        expect(rule.permission, key).toBe('access:write');
      }
    }
    expect(routePermission('GET', '/admin/credentials/new')?.permission).toBe('tokens:write');
    expect(routePermission('GET', '/admin/issuer-access-rules/new')?.permission).toBe(
      'access:write',
    );
    expect(routePermission('GET', '/admin/credential-access-rules/new')?.permission).toBe(
      'tokens:write',
    );
  });

  it('owner-only operations', () => {
    expect(routePermission('POST', '/admin/users')?.permission).toBe('users:write');
    expect(routePermission('POST', '/admin/users/:id/revoke-sessions')).toBeNull();
    expect(routePermission('POST', '/admin/retention')?.permission).toBe('settings:write');
    expect(routePermission('POST', '/admin/credentials/hosts')?.permission).toBe('settings:write');
    expect(routePermission('POST', '/admin/users/sign-in/hosts')?.permission).toBe(
      'settings:write',
    );
    expect(routePermission('POST', '/admin/credentials/keys/rewrap')?.permission).toBe(
      'keyring:rewrap',
    );
    for (const [key, rule] of Object.entries(ROUTE_PERMISSIONS)) {
      const ownerOnly = rolesWith(rule.permission).join() === 'owner';
      const expected = /^POST \/admin\/(users|retention|credentials\/hosts|credentials\/keys)/.test(
        key,
      );
      expect(ownerOnly, key).toBe(expected);
    }
  });

  it('the export needs config:export (admins and owners)', () => {
    expect(routePermission('POST', '/admin/export')?.permission).toBe('config:export');
    expect(rolesWith('config:export')).toEqual(['admin', 'owner']);
  });

  it('pins the field permissions', () => {
    const declared = Object.fromEntries(
      Object.entries(ROUTE_PERMISSIONS)
        .filter(([, rule]) => rule.fieldPermissions !== undefined)
        .map(([key, rule]) => [key, rule.fieldPermissions]),
    );
    expect(declared).toEqual(FIELD_PERMISSIONS);
    for (const key of Object.keys(declared)) {
      expect(ROUTE_PERMISSIONS[key]?.mutates, key).toBe(true);
    }
  });

  it('denies unknown routes, other methods and prototype keys', () => {
    expect(routePermission('GET', '/admin/nope')).toBeNull();
    expect(routePermission('DELETE', '/admin/credentials/:id')).toBeNull();
    expect(routePermission('ALL', '/admin/*')).toBeNull();
    expect(routePermission('GET', '/admin/credentials/abc')).toBeNull();
    expect(routePermission('constructor', '')).toBeNull();
    expect(routePermission('__proto__', '')).toBeNull();
  });

  it('method lookup is case-insensitive', () => {
    expect(routePermission('get', '/admin')).toEqual({ permission: 'read', mutates: false });
  });
});

describe('rolesWith and rolesWithAll', () => {
  it('rolesWith lists exactly the roles for which can() holds', () => {
    expect(rolesWith('read')).toEqual(ROLES);
    expect(rolesWith('tokens:write')).toEqual(['token_manager', 'admin', 'owner']);
    expect(rolesWith('access:write')).toEqual(['access_manager', 'admin', 'owner']);
    expect(rolesWith('users:write')).toEqual(['owner']);
  });

  it('rolesWithAll is the intersection of the rolesWith sets', () => {
    expect(rolesWithAll(['read'])).toEqual(ROLES);
    expect(rolesWithAll(['tokens:write', 'access:write'])).toEqual(['admin', 'owner']);
    expect(rolesWithAll(['tokens:write', 'settings:write'])).toEqual(['owner']);
    expect(rolesWithAll(['tokens:write', 'tokens:write'])).toEqual(rolesWith('tokens:write'));
    // An empty list fails closed: Array.every would otherwise match every role.
    expect(rolesWithAll([])).toEqual([]);
    for (const a of Object.keys(MATRIX) as Permission[]) {
      for (const b of Object.keys(MATRIX) as Permission[]) {
        const both = rolesWith(a).filter((role) => rolesWith(b).includes(role));
        expect(rolesWithAll([a, b]), `${a} + ${b}`).toEqual(both);
      }
    }
  });
});

describe('I-RBAC-1: requestPermissions adds the field permissions of submitted fields', () => {
  const create = ROUTE_PERMISSIONS['POST /admin/credentials'];
  const remove = ROUTE_PERMISSIONS['POST /admin/credentials/:id/delete'];
  if (!create || !remove) throw new Error('routes missing');

  it('is only the route permission when no listed field is submitted', () => {
    expect(requestPermissions(create, {})).toEqual(['tokens:write']);
    expect(requestPermissions(create, { name: 'x' })).toEqual(['tokens:write']);
    expect(requestPermissions(create, { allow_host: '' })).toEqual(['tokens:write']);
    expect(requestPermissions(create, { allow_host: ['', ''] })).toEqual(['tokens:write']);
  });

  it('adds the field permission for a non-empty value, a repeated field included', () => {
    expect(requestPermissions(create, { allow_host: '1' })).toEqual([
      'settings:write',
      'tokens:write',
    ]);
    expect(requestPermissions(create, { allow_host: ['', '0'] })).toEqual([
      'settings:write',
      'tokens:write',
    ]);
    expect(requestPermissions(remove, { with_accesses: '1' })).toEqual([
      'access:write',
      'tokens:write',
    ]);
  });

  it('ignores fields another route lists', () => {
    expect(requestPermissions(remove, { allow_host: '1' })).toEqual(['tokens:write']);
  });
});
