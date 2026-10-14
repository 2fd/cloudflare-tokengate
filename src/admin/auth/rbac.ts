// Admin RBAC (I-RBAC-1): one static table maps every registered admin route (method + Hono path
// pattern) to the permission it needs; unlisted routes are denied. `read` covers every page, since
// no page shows secret material.
import type { Role } from '../../db/types';

export type Permission =
  | 'read'
  | 'config:write'
  | 'users:write'
  | 'settings:write'
  | 'keyring:rewrap';

export interface RoutePermission {
  permission: Permission;
  /** The route changes state; it must be an unsafe method and pass the CSRF check (I-CSRF-1). */
  mutates: boolean;
}

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(['read']),
  admin: new Set(['read', 'config:write']),
  owner: new Set(['read', 'config:write', 'users:write', 'settings:write', 'keyring:rewrap']),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Roles that hold `permission`, for SQL re-checks of the acting user's role. */
export function rolesWith(permission: Permission): Role[] {
  return (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((role) => can(role, permission));
}

const read: RoutePermission = { permission: 'read', mutates: false };
/** GET pages that only make sense for someone who can submit them (create forms). */
const configForm: RoutePermission = { permission: 'config:write', mutates: false };
const configWrite: RoutePermission = { permission: 'config:write', mutates: true };
const usersWrite: RoutePermission = { permission: 'users:write', mutates: true };

/** Keys are `"<METHOD> <route pattern>"`, exactly as the route is registered. */
export const ROUTE_PERMISSIONS: Readonly<Record<string, RoutePermission>> = Object.freeze({
  'GET /admin': read,

  'GET /admin/services': read,
  'GET /admin/services/new': configForm,
  'POST /admin/services': configWrite,
  'GET /admin/services/:id': read,
  'POST /admin/services/:id': configWrite,
  'POST /admin/services/:id/credential': configWrite,
  'POST /admin/services/:id/test': configWrite,
  'POST /admin/services/:id/delete': configWrite,
  'POST /admin/services/:id/toggle': configWrite,

  'GET /admin/caller-providers': read,
  'GET /admin/caller-providers/new': configForm,
  'POST /admin/caller-providers': configWrite,
  'GET /admin/caller-providers/:id': read,
  'POST /admin/caller-providers/:id': configWrite,
  'POST /admin/caller-providers/:id/delete': configWrite,
  'POST /admin/caller-providers/:id/toggle': configWrite,

  'GET /admin/grants': read,
  'GET /admin/grants/new': configForm,
  'POST /admin/grants': configWrite,
  'GET /admin/grants/:id': read,
  'POST /admin/grants/:id': configWrite,
  'POST /admin/grants/:id/delete': configWrite,
  'POST /admin/grants/:id/toggle': configWrite,

  'GET /admin/requests': read,
  'GET /admin/requests/:id': read,
  'GET /admin/audit': read,

  'GET /admin/users': read,
  'POST /admin/users': usersWrite,
  'POST /admin/users/defaults': usersWrite,
  'POST /admin/users/:id': usersWrite,
  'POST /admin/users/:id/approve': usersWrite,
  'POST /admin/users/:id/reject': usersWrite,
  'POST /admin/users/:id/reset-login': usersWrite,
  'POST /admin/users/:id/resend-invite': usersWrite,

  'GET /admin/settings': read,
  'POST /admin/settings': { permission: 'settings:write', mutates: true },
  'POST /admin/settings/rewrap': { permission: 'keyring:rewrap', mutates: true },
  'POST /admin/settings/upstream-hosts': { permission: 'settings:write', mutates: true },
  // No secrets (I-CRED-1), but every user's email and the full policy: admins and owners only.
  // POST (I-CSRF-1) because it writes an audit row (I-AUDIT-1); a GET could be forged cross-site.
  'POST /admin/export': configWrite,
});

/** Permission for a registered route, or null when the route is not in the table (deny). */
export function routePermission(method: string, routePath: string): RoutePermission | null {
  const key = `${method.toUpperCase()} ${routePath}`;
  return Object.hasOwn(ROUTE_PERMISSIONS, key) ? (ROUTE_PERMISSIONS[key] ?? null) : null;
}
