// Parses and validates environment configuration per feature (docs/configuration.md). A malformed feature is
// disabled and reported by variable name; it never runs half-configured (I-CFG-1). Also decides
// on which hostnames /admin answers (I-DEPLOY-1). Error messages name variables only and never
// echo values.
import type { AppEnv } from './env';

export type ConfigFeature = 'login.access' | 'login.dev';

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

/** Local development login: every admin request to a loopback host is this user. */
export interface DevLogin {
  /** Lowercased. */
  email: string;
}

export interface Config {
  errors: ConfigError[];
  login: { access: AccessLogin | null; dev: DevLogin | null };
}

export const LOCAL_DEV_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCESS_TEAM_SUFFIX = '.cloudflareaccess.com';
const ACCESS_AUD_RE = /^[A-Za-z0-9._:-]{1,256}$/;
/** Same shape as invited emails (admin/ops/users.ts normalizeEmail), so the dev user can be invited. */
const DEV_EMAIL_RE = /^[^\s@,;<>"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function parseConfig(env: AppEnv): Config {
  const errors: ConfigError[] = [];
  const accessSet =
    readVar(env.AUTH_ACCESS_TEAM_DOMAIN) !== null || readVar(env.AUTH_ACCESS_AUD) !== null;
  const devSet = readVar(env.AUTH_ACCESS_DEVELOPMENT) !== null;
  // A production login and the proof-less development login never run together: both turn off.
  if (accessSet && devSet) {
    const message =
      'AUTH_ACCESS_DEVELOPMENT cannot be set together with AUTH_ACCESS_TEAM_DOMAIN or AUTH_ACCESS_AUD. Remove AUTH_ACCESS_DEVELOPMENT in production.';
    errors.push(
      { feature: 'login.access', variable: 'AUTH_ACCESS_DEVELOPMENT', message },
      { feature: 'login.dev', variable: 'AUTH_ACCESS_DEVELOPMENT', message },
    );
    return { errors, login: { access: null, dev: null } };
  }
  return {
    errors,
    login: {
      access: parseAccessLogin(env, errors),
      dev: parseDevLogin(env, errors),
    },
  };
}

/**
 * Hostnames /admin answers on (I-DEPLOY-1): never workers.dev, and only over https unless the
 * hostname is a loopback host. Every other hostname routed to the Worker is served: the operator
 * picks them with Worker routes and puts each behind the Access application.
 */
export function adminHostAllowed(requestUrl: URL): boolean {
  const host = requestUrl.hostname;
  if (isWorkersDev(host)) return false;
  return requestUrl.protocol === 'https:' || LOCAL_DEV_HOSTS.has(host);
}

/**
 * Exact hostname match, or `*.suffix` matching any hostname strictly below the suffix
 * (`*.example.com` matches `a.example.com` and `a.b.example.com`, not `example.com`).
 * Entries must be lowercase. Pass `URL.hostname`.
 */
export function hostListed(host: string, entries: readonly string[]): boolean {
  const candidate = host.toLowerCase();
  return entries.some((entry) =>
    entry.startsWith('*.') ? candidate.endsWith(entry.slice(1)) : candidate === entry,
  );
}

/**
 * `hostListed` for the upstream host allowlist; `null` means no restriction. A host with a port,
 * a trailing dot or an empty label never matches.
 */
export function upstreamHostAllowed(host: string, allowed: string[] | null): boolean {
  if (allowed === null) return true;
  return isDomainName(host.toLowerCase()) && hostListed(host, allowed);
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

function parseAccessLogin(env: AppEnv, errors: ConfigError[]): AccessLogin | null {
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
  return { teamDomain, aud };
}

/**
 * AUTH_ACCESS_DEVELOPMENT signs admin requests in as that email, with no proof at all. `requestIdentity`
 * accepts it only on a request to localhost, 127.0.0.1 or [::1], which no request through
 * Cloudflare's edge can be.
 */
function parseDevLogin(env: AppEnv, errors: ConfigError[]): DevLogin | null {
  const raw = readVar(env.AUTH_ACCESS_DEVELOPMENT);
  if (raw === null) return null;
  const fail = (variable: string, message: string): null => {
    errors.push({ feature: 'login.dev', variable, message });
    return null;
  };
  const email = raw.toLowerCase();
  if (!DEV_EMAIL_RE.test(email)) {
    return fail('AUTH_ACCESS_DEVELOPMENT', 'AUTH_ACCESS_DEVELOPMENT is not a valid email address.');
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
