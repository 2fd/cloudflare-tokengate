// Admin URL contract (ADR 0019). Every admin href and redirect target is built here, so a section
// never writes another section's URL by hand. Query values are encoded with URLSearchParams, empty
// values are left out, and the fragment always comes last. Pages validate their own parameters
// against closed sets; these builders only spell them.
import type { Role } from '../db/types';
import type { ProfileId } from '../identity/types';
import { docsUrl } from './views/docs';

export type Range = '24h' | '7d' | '30d';
export type AuditCategory = 'tokens' | 'consumers' | 'access' | 'users' | 'signins' | 'system';

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
  overview: (o?: { range?: Range; hash?: 'health' | 'get-started' }) =>
    build('/admin', { range: o?.range }, o?.hash),
  requests: (f?: {
    range?: '1h' | Range;
    outcome?: 'allowed' | 'denied' | 'error';
    /** A token id, or `none` for requests refused before the token was looked up. */
    token?: string;
    /** A consumer id, or `none` for requests with no verified consumer. */
    consumer?: string;
    access?: string;
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

  users: (f?: {
    role?: Role;
    status?: 'active' | 'invited' | 'expired' | 'suspended';
    q?: string;
    hash?: 'decide' | 'invite' | `user-${string}`;
  }) => build('/admin/users', { role: f?.role, status: f?.status, q: f?.q }, f?.hash),
  user: (userId: string) => `/admin/users/${id(userId)}`,
  signIn: (hash?: 'policy' | 'hosts' | 'login') => build('/admin/users/sign-in', undefined, hash),

  tokens: (f?: {
    status?: 'credential_unreadable' | 'expiring' | 'no_credential' | 'outside_hosts';
    key?: string;
    hash?: 'add';
  }) => build('/admin/tokens', { status: f?.status, key: f?.key }, f?.hash),
  /** `template`: a service template id, or `custom`. */
  tokenNew: (o?: { template?: string }) => build('/admin/tokens/new', o),
  token: (
    tokenId: string,
    o?: {
      open?: 'destination' | 'details';
      hash?: 'consumers' | 'secret' | 'use' | 'destination' | 'details' | 'danger';
    },
  ) => build(`/admin/tokens/${id(tokenId)}`, { open: o?.open }, o?.hash),
  tokenHosts: () => '/admin/tokens/hosts',
  tokenKeys: (hash?: 'rewrap') => build('/admin/tokens/keys', undefined, hash),

  consumers: (o?: { hash?: 'add' }) => build('/admin/consumers', undefined, o?.hash),
  consumerNew: (o?: { type?: ProfileId }) => build('/admin/consumers/new', o),
  consumer: (
    consumerId: string,
    o?: { open?: 'trust'; hash?: 'access' | 'tenants' | 'trust' | 'snippet' | 'danger' },
  ) => build(`/admin/consumers/${id(consumerId)}`, { open: o?.open }, o?.hash),

  access: (f?: {
    view?: 'matrix' | 'list';
    consumer?: string;
    token?: string;
    repository?: string;
    status?: 'active' | 'inactive' | 'expiring' | 'unused' | 'risk';
  }) => build('/admin/access', f),
  accessNew: (p?: {
    /** A consumer id, or `new` to add the consumer inside the access form. */
    consumer?: string;
    token?: string;
    repository?: string;
    copy?: string;
    from_request?: string;
    mode?: 'rows';
  }) => build('/admin/access/new', p),
  accessItem: (
    accessId: string,
    o?: { open?: 'edit'; hash?: 'use' | 'edit' | 'copy' | 'danger' },
  ) => build(`/admin/access/${id(accessId)}`, { open: o?.open }, o?.hash),

  docs: (path: string) => docsUrl(path),
};

/**
 * Where a row action posted from more than one page returns to (`_return`, a closed set per
 * route). The value is never a URL: it picks one of the fixed paths below, and anything unknown
 * falls back to the route's default (the first entry). No open redirect.
 */
const RETURN_PATHS = {
  'POST /admin/tokens/keys/rewrap': {
    detail: () => paths.tokenKeys(),
    overview: () => paths.overview(),
  },
  'POST /admin/users/:id/approve': { list: () => paths.users(), overview: () => paths.overview() },
  'POST /admin/users/:id/reject': { list: () => paths.users(), overview: () => paths.overview() },
  'POST /admin/tokens/:id/toggle': {
    detail: (p: { id: string }) => paths.token(p.id),
    list: () => paths.tokens(),
  },
  'POST /admin/consumers/:id/toggle': {
    detail: (p: { id: string }) => paths.consumer(p.id),
    list: () => paths.consumers(),
  },
  'POST /admin/access/:id/toggle': {
    detail: (p: { id: string }) => paths.accessItem(p.id),
    list: () => paths.access({ view: 'list' }),
    matrix: () => paths.access(),
  },
} as const;

export type ReturnRoute = keyof typeof RETURN_PATHS;

export function returnPath(route: ReturnRoute, raw: unknown, params: { id?: string } = {}): string {
  const targets: Record<string, (p: { id: string }) => string> = RETURN_PATHS[route];
  const fallback = Object.values(targets)[0] as (p: { id: string }) => string;
  const target = typeof raw === 'string' && Object.hasOwn(targets, raw) ? targets[raw] : fallback;
  return (target ?? fallback)({ id: params.id ?? '' });
}
