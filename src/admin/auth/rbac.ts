// Admin RBAC (I-RBAC-1): one static table maps every registered admin route (method + Hono path
// pattern) to the permission it needs; unlisted routes are denied. `read` covers every page, since
// no page shows secret material. Token and access duties are separate roles (ADR 0018): token
// managers decide which credentials and destinations exist, access managers decide who may use
// them, and neither can do the other's job.
import type { Role } from '../../db/types';

export type Permission =
  | 'read'
  /** Services (service tokens): create, edit, enter and test credentials, toggle, delete. */
  | 'tokens:write'
  /** Caller providers (service consumers) and grants (consumer access). */
  | 'access:write'
  /** The configuration export: every user's email and both halves of the policy. */
  | 'config:export'
  | 'users:write'
  | 'settings:write'
  | 'keyring:rewrap';

export interface RoutePermission {
  permission: Permission;
  /** The route changes state; it must be an unsafe method and pass the CSRF check (I-CSRF-1). */
  mutates: boolean;
  /**
   * Form fields that need a further permission when submitted non-empty. The middleware refuses
   * the request before the handler runs, and the actor check re-checks them at commit (I-SESS-1).
   */
  fieldPermissions?: Readonly<Record<string, Permission>>;
}

/** In privilege order (the order the UI lists roles in). */
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(['read']),
  token_manager: new Set(['read', 'tokens:write']),
  access_manager: new Set(['read', 'access:write']),
  admin: new Set(['read', 'tokens:write', 'access:write', 'config:export']),
  owner: new Set([
    'read',
    'tokens:write',
    'access:write',
    'config:export',
    'users:write',
    'settings:write',
    'keyring:rewrap',
  ]),
};

/** Every role, in privilege order. */
export const ALL_ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Roles that hold `permission`, for SQL re-checks of the acting user's role. */
export function rolesWith(permission: Permission): Role[] {
  return ALL_ROLES.filter((role) => can(role, permission));
}

/**
 * Roles that hold every one of `permissions` (the intersection of their rolesWith sets). An empty
 * list matches no role (fail closed), never every role.
 */
export function rolesWithAll(permissions: readonly Permission[]): Role[] {
  if (permissions.length === 0) return [];
  return ALL_ROLES.filter((role) => permissions.every((permission) => can(role, permission)));
}

const read: RoutePermission = { permission: 'read', mutates: false };
/** GET pages that only make sense for someone who can submit them (create forms). */
const tokensForm: RoutePermission = { permission: 'tokens:write', mutates: false };
const tokensWrite: RoutePermission = { permission: 'tokens:write', mutates: true };
const accessForm: RoutePermission = { permission: 'access:write', mutates: false };
const accessWrite: RoutePermission = { permission: 'access:write', mutates: true };
const usersWrite: RoutePermission = { permission: 'users:write', mutates: true };
const settingsWrite: RoutePermission = { permission: 'settings:write', mutates: true };
const exportWrite: RoutePermission = { permission: 'config:export', mutates: true };
const rewrap: RoutePermission = { permission: 'keyring:rewrap', mutates: true };

/**
 * Keys are `"<METHOD> <route pattern>"`, exactly as the route is registered. Each admin section
 * owns one block; add or remove keys only inside your own block.
 */
export const ROUTE_PERMISSIONS: Readonly<Record<string, RoutePermission>> = Object.freeze({
  // == monitoring ==
  'GET /admin': read,
  'GET /admin/requests': read,
  'GET /admin/requests/:id': read,
  'GET /admin/audit': read,
  'GET /admin/retention': read,
  'POST /admin/retention': settingsWrite,

  // == users ==
  'GET /admin/users/sign-in': read,
  'POST /admin/users/sign-in/policy': usersWrite,
  // Admin hosts are a deployment setting (I-DEPLOY-1), shown here because they decide where people
  // sign in.
  'POST /admin/users/sign-in/hosts': settingsWrite,
  'GET /admin/users': read,
  'POST /admin/users': usersWrite,
  'GET /admin/users/:id': read,
  'POST /admin/users/:id': usersWrite,
  'POST /admin/users/:id/approve': usersWrite,
  'POST /admin/users/:id/reject': usersWrite,
  'POST /admin/users/:id/reset-login': usersWrite,
  'POST /admin/users/:id/resend-invite': usersWrite,
  'POST /admin/users/:id/delete': usersWrite,
  'POST /admin/users/:id/dismiss-attempt': usersWrite,

  // == tokens ==
  'GET /admin/tokens/hosts': read,
  'POST /admin/tokens/hosts': settingsWrite,
  'GET /admin/tokens/keys': read,
  'POST /admin/tokens/keys/rewrap': rewrap,
  'GET /admin/tokens': read,
  'GET /admin/tokens/new': tokensForm,
  // Allowing the destination host on the way edits the upstream host allowlist (owners only).
  'POST /admin/tokens': { ...tokensWrite, fieldPermissions: { allow_host: 'settings:write' } },
  'GET /admin/tokens/:id': read,
  'POST /admin/tokens/:id': tokensWrite,
  'POST /admin/tokens/:id/credential': tokensWrite,
  'POST /admin/tokens/:id/test': tokensWrite,
  'POST /admin/tokens/:id/toggle': tokensWrite,
  // Deleting the consumer access of the token with it is an access change.
  'POST /admin/tokens/:id/delete': {
    ...tokensWrite,
    fieldPermissions: { with_accesses: 'access:write' },
  },

  // == consumers ==
  'GET /admin/consumers': read,
  'GET /admin/consumers/new': accessForm,
  'POST /admin/consumers': accessWrite,
  'GET /admin/consumers/:id': read,
  'POST /admin/consumers/:id': accessWrite,
  'POST /admin/consumers/:id/toggle': accessWrite,
  'POST /admin/consumers/:id/delete': accessWrite,
  'GET /admin/access': read,
  'GET /admin/access/new': accessForm,
  'POST /admin/access': accessWrite,
  'GET /admin/access/:id': read,
  'POST /admin/access/:id': accessWrite,
  'POST /admin/access/:id/toggle': accessWrite,
  'POST /admin/access/:id/delete': accessWrite,

  // == global ==
  // No secrets (I-CRED-1), but every user's email and the full policy: admins and owners only.
  // POST (I-CSRF-1) because it writes an audit row (I-AUDIT-1); a GET could be forged cross-site.
  'POST /admin/export': exportWrite,
});

/** Permission for a registered route, or null when the route is not in the table (deny). */
export function routePermission(method: string, routePath: string): RoutePermission | null {
  const key = `${method.toUpperCase()} ${routePath}`;
  return Object.hasOwn(ROUTE_PERMISSIONS, key) ? (ROUTE_PERMISSIONS[key] ?? null) : null;
}

/**
 * The permissions a request needs: the route's, plus the field permission of every listed field
 * that the form submits non-empty. Sorted and without duplicates.
 */
export function requestPermissions(
  rule: RoutePermission,
  fields: Readonly<Record<string, string | string[] | undefined>>,
): Permission[] {
  const needed = new Set<Permission>([rule.permission]);
  for (const [field, permission] of Object.entries(rule.fieldPermissions ?? {})) {
    if (submitted(fields[field])) needed.add(permission);
  }
  return [...needed].sort();
}

function submitted(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  return (Array.isArray(value) ? value : [value]).some((item) => item !== '');
}
