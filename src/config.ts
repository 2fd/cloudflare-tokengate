// Parses and validates environment configuration per feature (docs/configuration.md). A malformed feature is
// disabled and reported by variable name; it never runs half-configured (I-CFG-1). Also decides
// admin host pinning (I-DEPLOY-1). Error messages name variables only and never echo values.
import type { AppEnv } from './env';

export type ConfigFeature = 'public_url' | 'login.access' | 'login.dev';

export interface ConfigError {
  feature: ConfigFeature;
  variable: string;
  message: string;
}

export interface AccessLogin {
  /** Always `https://<team>.cloudflareaccess.com` (no trailing slash). */
  teamDomain: string;
  aud: string;
}

/** Local development login: every admin request is this user. Only on a loopback PUBLIC_URL. */
export interface DevLogin {
  /** Lowercased. */
  email: string;
}

export interface Config {
  /** Canonical origin; null when unset or malformed (malformed also adds a `public_url` error). */
  publicUrl: URL | null;
  errors: ConfigError[];
  login: { access: AccessLogin | null; dev: DevLogin | null };
  /** Lowercased, trimmed. */
  bootstrapOwnerEmails: string[];
}

export const LOCAL_DEV_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCESS_TEAM_SUFFIX = '.cloudflareaccess.com';
const ACCESS_AUD_RE = /^[A-Za-z0-9._:-]{1,256}$/;
/** Same shape as invited emails (admin/ops/users.ts normalizeEmail), so the dev user can be invited. */
const DEV_EMAIL_RE = /^[^\s@,;<>"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function parseConfig(env: AppEnv): Config {
  const errors: ConfigError[] = [];
  const publicUrl = parsePublicUrl(env, errors);
  return {
    publicUrl,
    errors,
    login: {
      access: parseAccessLogin(env, publicUrl, errors),
      dev: parseDevLogin(env, publicUrl, errors),
    },
    bootstrapOwnerEmails: splitList(env.BOOTSTRAP_OWNER_EMAILS).map((email) => email.toLowerCase()),
  };
}

/**
 * PUBLIC_URL origin when configured, otherwise the origin of the current request.
 * A malformed PUBLIC_URL also falls back to the request origin, so admin routes must be
 * gated by `adminOriginAllowed` first.
 */
export function canonicalOrigin(config: Config, requestUrl: URL): string {
  return config.publicUrl?.origin ?? requestUrl.origin;
}

/**
 * Host pinning for /admin (I-DEPLOY-1). With PUBLIC_URL set, only its exact origin
 * (scheme, host and port) is served. A malformed PUBLIC_URL denies every request: the operator
 * asked for pinning, so a typo must not turn it off.
 */
export function adminOriginAllowed(config: Config, requestUrl: URL): boolean {
  if (config.errors.some((error) => error.feature === 'public_url')) return false;
  return config.publicUrl === null || config.publicUrl.origin === requestUrl.origin;
}

/**
 * Exact hostname match, or `*.suffix` matching any hostname strictly below the suffix
 * (`*.example.com` matches `a.example.com` and `a.b.example.com`, not `example.com`).
 * `null` means no restriction. Pass `URL.hostname`: a host with a port, a trailing dot or an empty
 * label never matches. Entries must be lowercase, as produced by `parseConfig`.
 */
export function upstreamHostAllowed(host: string, allowed: string[] | null): boolean {
  if (allowed === null) return true;
  const candidate = host.toLowerCase();
  if (!isDomainName(candidate)) return false;
  return allowed.some((entry) =>
    entry.startsWith('*.') ? candidate.endsWith(entry.slice(1)) : candidate === entry,
  );
}

/** Splits a comma-separated variable, trimming entries and dropping empty ones. */
export function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function readVar(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function parsePublicUrl(env: AppEnv, errors: ConfigError[]): URL | null {
  const raw = readVar(env.PUBLIC_URL);
  if (raw === null) return null;
  const fail = (message: string): null => {
    errors.push({ feature: 'public_url', variable: 'PUBLIC_URL', message });
    return null;
  };
  if (!URL.canParse(raw)) return fail('PUBLIC_URL is not a valid absolute URL.');
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOCAL_DEV_HOSTS.has(url.hostname))
  ) {
    return fail(
      'PUBLIC_URL must use https (http is accepted only for localhost, 127.0.0.1, [::1]).',
    );
  }
  if (url.username !== '' || url.password !== '') {
    return fail('PUBLIC_URL must not contain credentials.');
  }
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    raw.includes('?') ||
    raw.includes('#')
  ) {
    return fail('PUBLIC_URL must be an origin only (no path, query or fragment).');
  }
  if (url.hostname.endsWith('.')) return fail('PUBLIC_URL host must not end with a dot.');
  return new URL(url.origin);
}

function parseAccessLogin(
  env: AppEnv,
  publicUrl: URL | null,
  errors: ConfigError[],
): AccessLogin | null {
  const fail = (variable: string, message: string): null => {
    errors.push({ feature: 'login.access', variable, message });
    return null;
  };
  const team = readVar(env.AUTH_ACCESS_TEAM_DOMAIN);
  const aud = readVar(env.AUTH_ACCESS_AUD);
  if (team === null && aud === null) return null;
  if (team === null) {
    return fail(
      'AUTH_ACCESS_TEAM_DOMAIN',
      'AUTH_ACCESS_AUD is set but AUTH_ACCESS_TEAM_DOMAIN is not.',
    );
  }
  if (aud === null) {
    return fail('AUTH_ACCESS_AUD', 'AUTH_ACCESS_TEAM_DOMAIN is set but AUTH_ACCESS_AUD is not.');
  }
  const teamDomain = normalizeAccessTeamDomain(team);
  if (teamDomain === null) {
    return fail(
      'AUTH_ACCESS_TEAM_DOMAIN',
      'AUTH_ACCESS_TEAM_DOMAIN must be "<team>", "<team>.cloudflareaccess.com" or "https://<team>.cloudflareaccess.com".',
    );
  }
  if (!ACCESS_AUD_RE.test(aud)) {
    return fail(
      'AUTH_ACCESS_AUD',
      'AUTH_ACCESS_AUD is not a valid Access application audience tag.',
    );
  }
  // docs/configuration.md: Access login is sound only when admin traffic is pinned to a custom hostname that
  // the operator places behind an Access application.
  if (publicUrl === null) {
    return fail('PUBLIC_URL', 'Access login requires a valid PUBLIC_URL.');
  }
  if (publicUrl.protocol !== 'https:') {
    return fail('PUBLIC_URL', 'Access login requires PUBLIC_URL to use https.');
  }
  if (isWorkersDev(publicUrl.hostname)) {
    return fail(
      'PUBLIC_URL',
      'Access login requires PUBLIC_URL on a custom domain, not workers.dev.',
    );
  }
  return { teamDomain, aud };
}

/**
 * AUTH_DEV_EMAIL signs every admin request in as that email, with no proof at all. It is accepted
 * only when PUBLIC_URL is a loopback origin: host pinning (I-DEPLOY-1) then refuses every admin
 * request whose URL is not that origin, which no request through Cloudflare's edge can have.
 */
function parseDevLogin(env: AppEnv, publicUrl: URL | null, errors: ConfigError[]): DevLogin | null {
  const raw = readVar(env.AUTH_DEV_EMAIL);
  if (raw === null) return null;
  const fail = (variable: string, message: string): null => {
    errors.push({ feature: 'login.dev', variable, message });
    return null;
  };
  const email = raw.toLowerCase();
  if (!DEV_EMAIL_RE.test(email)) {
    return fail('AUTH_DEV_EMAIL', 'AUTH_DEV_EMAIL is not a valid email address.');
  }
  if (publicUrl === null || !LOCAL_DEV_HOSTS.has(publicUrl.hostname)) {
    return fail(
      'PUBLIC_URL',
      'AUTH_DEV_EMAIL requires PUBLIC_URL on localhost, 127.0.0.1 or [::1]. Never set it in production.',
    );
  }
  return { email };
}

/** Accepts `team`, `team.cloudflareaccess.com` or `https://team.cloudflareaccess.com[/]`. */
export function normalizeAccessTeamDomain(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.startsWith('https://')) {
    host = host.slice('https://'.length);
    if (host.endsWith('/')) host = host.slice(0, -1);
  }
  const team = host.endsWith(ACCESS_TEAM_SUFFIX) ? host.slice(0, -ACCESS_TEAM_SUFFIX.length) : host;
  if (!DNS_LABEL_RE.test(team)) return null;
  return `https://${team}${ACCESS_TEAM_SUFFIX}`;
}

/**
 * An upstream host allowlist entry: an exact hostname, or `*.<domain>` with at least two labels.
 * Pass it lowercased.
 */
export function isUpstreamHostEntry(entry: string): boolean {
  return entry.startsWith('*.')
    ? isDomainName(entry.slice(2)) && entry.slice(2).includes('.')
    : isDomainName(entry);
}

function isDomainName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  return name.split('.').every((label) => DNS_LABEL_RE.test(label));
}

function isWorkersDev(hostname: string): boolean {
  return hostname === 'workers.dev' || hostname.endsWith('.workers.dev');
}
