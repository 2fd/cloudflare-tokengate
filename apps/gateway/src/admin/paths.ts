// Admin URL contract (ADR 0019). Every admin href and redirect target is built here, so a section
// never writes another section's URL by hand. Query values are encoded with URLSearchParams, empty
// values are left out, and the fragment always comes last. Pages validate their own parameters
// against closed sets; these builders only spell them.
import type { Role } from '../db/types';
import type { ProfileId } from '../identity/types';
import { docsUrl } from './views/docs';

export type Range = '24h' | '7d' | '30d';
export type AuditCategory =
  | 'tokens'
  | 'access_rules'
  | 'global_rules'
  | 'users'
  | 'signins'
  | 'system';
/** Quick links of the credential access rules list. */
export type RuleStatusFilter = 'active' | 'disabled' | 'expired' | 'blocked';

type Params = Record<string, string | undefined>;

function build(path: string, params?: Params, hash?: string): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const query = search.toString();
  return `${path}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
}

function id(value: string): string {
  return encodeURIComponent(value);
}

export const paths = {
  appearance: () => '/admin/users/appearance' as const,
  overview: (o?: { range?: Range; hash?: 'health' | 'attention' | 'get-started' }) =>
    build('/admin', { range: o?.range }, o?.hash),
  requests: (f?: {
    range?: '1h' | Range;
    outcome?: 'allowed' | 'denied' | 'error';
    /** A token id, or `none` for requests refused before the token was looked up. */
    token?: string;
    /** A credential access rule id, or `none` for requests that no credential access rule verified. */
    rule?: string;
    repo?: string;
    reason?: string;
    slug?: string;
    before?: string;
    after?: string;
  }) => build('/admin/requests', f),
  request: (requestId: string) => `/admin/requests/${id(requestId)}`,
  audit: (f?: {
    range?: Range | '90d';
    category?: AuditCategory;
    target?: string;
    actor?: string;
  }) => build('/admin/audit', f),
  retention: () => '/admin/retention' as const,
  /** The configuration export (POST only, from the account menu; a GET is the 404 page). */
  export: () => '/admin/export' as const,

  users: (f?: {
    role?: Role;
    status?: 'active' | 'invited' | 'expired' | 'suspended';
    q?: string;
    hash?: 'decide' | 'invite' | `user-${string}`;
  }) => build('/admin/users', { role: f?.role, status: f?.status, q: f?.q }, f?.hash),
  user: (userId: string) => `/admin/users/${id(userId)}`,
  signIn: (hash?: 'policy' | 'hosts' | 'login') => build('/admin/users/sign-in', undefined, hash),

  tokens: (f?: {
    status?: 'credential_unreadable' | 'expiring' | 'no_credential' | 'outside_hosts' | 'disabled';
    key?: string;
    /** Name or slug search. */
    q?: string;
    hash?: 'add';
  }) => build('/admin/credentials', { status: f?.status, key: f?.key, q: f?.q }, f?.hash),
  /** `template`: a service template id, or `custom`. */
  tokenNew: (o?: { template?: string }) => build('/admin/credentials/new', o),
  token: (
    tokenId: string,
    o?: {
      open?: 'destination' | 'details';
      hash?: 'rules' | 'secret' | 'use' | 'destination' | 'details' | 'danger';
    },
  ) => build(`/admin/credentials/${id(tokenId)}`, { open: o?.open }, o?.hash),
  tokenHosts: () => '/admin/credentials/hosts',
  tokenKeys: (hash?: 'rewrap') => build('/admin/credentials/keys', undefined, hash),

  accessRules: (f?: {
    credential?: string;
    /** An issuer key. */
    issuer?: string;
    status?: RuleStatusFilter;
    /** List (default), map or matrix (WP-R3; until then both render the list). */
    view?: 'list' | 'map' | 'matrix';
    /** A credential access rule id the map focuses on. */
    focus?: string;
  }) => build('/admin/credential-access-rules', f),
  accessRuleNew: (p?: {
    credential?: string;
    type?: ProfileId;
    /** A credential access rule id whose fields prefill the form. */
    copy?: string;
    /** A verified request record whose caller and call prefill the form (I-LOG-2). */
    from_request?: string;
  }) => build('/admin/credential-access-rules/new', p),
  accessRule: (
    ruleId: string,
    o?: {
      open?: 'edit';
      hash?:
        | 'jobs'
        | 'operations'
        | 'tenants'
        | 'trust'
        | 'global'
        | 'snippet'
        | 'history'
        | 'danger';
    },
  ) =>
    build(
      `/admin/credential-access-rules/${id(ruleId)}`,
      { open: o?.open },
      o?.hash ?? (o?.open === 'edit' ? 'edit' : undefined),
    ),

  globalRules: (f?: { issuer?: string; status?: 'enabled' | 'disabled' | 'expired' }) =>
    build('/admin/global-access-rules', f),
  globalRuleNew: (p?: { issuer?: string; type?: ProfileId }) =>
    build('/admin/global-access-rules/new', p),
  globalRule: (
    ruleId: string,
    o?: { open?: 'edit'; hash?: 'limits' | 'affected' | 'history' | 'danger' },
  ) =>
    build(
      `/admin/global-access-rules/${id(ruleId)}`,
      { open: o?.open },
      o?.hash ?? (o?.open === 'edit' ? 'edit' : undefined),
    ),

  docs: (path: string) => docsUrl(path),
};

/**
 * Where a row action posted from more than one page returns to (`_return`, a closed set per
 * route). The value is never a URL: it picks one of the fixed paths below, and anything unknown
 * falls back to the route's default (the first entry). No open redirect.
 */
export const RETURN_PATHS = {
  'POST /admin/credentials/keys/rewrap': {
    detail: () => paths.tokenKeys(),
    overview: () => paths.overview(),
  },
  'POST /admin/users/:id/approve': { list: () => paths.users(), overview: () => paths.overview() },
  'POST /admin/users/:id/reject': { list: () => paths.users(), overview: () => paths.overview() },
  'POST /admin/credentials/:id/toggle': {
    detail: (p: { id: string }) => paths.token(p.id),
    list: () => paths.tokens(),
  },
  'POST /admin/credential-access-rules/:id/toggle': {
    detail: (p: { id: string }) => paths.accessRule(p.id),
    list: () => paths.accessRules(),
  },
  'POST /admin/global-access-rules/:id/toggle': {
    detail: (p: { id: string }) => paths.globalRule(p.id),
    list: () => paths.globalRules(),
  },
} as const;

export type ReturnRoute = keyof typeof RETURN_PATHS;

export function returnPath(route: ReturnRoute, raw: unknown, params: { id?: string } = {}): string {
  const targets: Record<string, (p: { id: string }) => string> = RETURN_PATHS[route];
  const fallback = Object.values(targets)[0] as (p: { id: string }) => string;
  const target = typeof raw === 'string' && Object.hasOwn(targets, raw) ? targets[raw] : fallback;
  return (target ?? fallback)({ id: params.id ?? '' });
}
