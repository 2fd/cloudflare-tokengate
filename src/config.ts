// Parses and validates environment configuration per feature (docs/configuration.md). A malformed feature is
// disabled and reported by variable name; it never runs half-configured (I-CFG-1). Also decides
// admin host pinning (I-DEPLOY-1). Error messages name variables only and never echo values.
import type { AppEnv } from './env';

export type ConfigFeature =
  | 'public_url'
  | 'login.github'
  | 'login.oidc'
  | 'login.access'
  | 'upstream_hosts';

export interface ConfigError {
  feature: ConfigFeature;
  variable: string;
  message: string;
}

export interface GithubLogin {
  clientId: string;
  clientSecret: string;
  /** Lowercased org logins; empty = any GitHub user may attempt login. */
  allowedOrgs: string[];
}

export interface OidcLogin {
  kind: 'oidc' | 'google';
  /**
   * Issuer as configured. Discovery compares its parsed URL with the document's `issuer`; subjects
   * are namespaced by canonicalIssuer (src/admin/auth/oidc.ts).
   */
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  /** Lowercased email domains; empty = any domain. */
  allowedDomains: string[];
}

export interface AccessLogin {
  /** Always `https://<team>.cloudflareaccess.com` (no trailing slash). */
  teamDomain: string;
  aud: string;
}

export interface Config {
  /** Canonical origin; null when unset or malformed (malformed also adds a `public_url` error). */
  publicUrl: URL | null;
  errors: ConfigError[];
  login: { github: GithubLogin | null; oidc: OidcLogin | null; access: AccessLogin | null };
  /** Lowercased, trimmed. */
  bootstrapOwnerEmails: string[];
  /** null = unrestricted. Malformed configuration yields [] (deny every host). */
  allowedUpstreamHosts: string[] | null;
}

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const DEFAULT_OIDC_LABEL = 'Single sign-on';
export const GOOGLE_LABEL = 'Google';

const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// GitHub org logins: alphanumerics and single inner hyphens, at most 39 characters. Also keeps the
// value safe to interpolate into /user/memberships/orgs/{org}.
// https://docs.github.com/en/organizations
const GITHUB_ORG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCESS_TEAM_SUFFIX = '.cloudflareaccess.com';
const ACCESS_AUD_RE = /^[A-Za-z0-9._:-]{1,256}$/;

export function parseConfig(env: AppEnv): Config {
  const errors: ConfigError[] = [];
  const publicUrl = parsePublicUrl(env, errors);
  return {
    publicUrl,
    errors,
    login: {
      github: parseGithubLogin(env, errors),
      oidc: parseOidcLogin(env, errors),
      access: parseAccessLogin(env, publicUrl, errors),
    },
    bootstrapOwnerEmails: splitList(env.BOOTSTRAP_OWNER_EMAILS).map((email) => email.toLowerCase()),
    allowedUpstreamHosts: parseUpstreamHosts(env.ALLOWED_UPSTREAM_HOSTS, errors),
  };
}

/**
 * PUBLIC_URL origin when configured, otherwise the origin of the current request.
 * A malformed PUBLIC_URL also falls back to the request origin, so admin and auth routes must be
 * gated by `adminOriginAllowed` first.
 */
export function canonicalOrigin(config: Config, requestUrl: URL): string {
  return config.publicUrl?.origin ?? requestUrl.origin;
}

/**
 * Host pinning for /admin and /auth (I-DEPLOY-1). With PUBLIC_URL set, only its exact origin
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

function parseGithubLogin(env: AppEnv, errors: ConfigError[]): GithubLogin | null {
  const fail = (variable: string, message: string): null => {
    errors.push({ feature: 'login.github', variable, message });
    return null;
  };
  const clientId = readVar(env.AUTH_GITHUB_CLIENT_ID);
  const clientSecret = readVar(env.AUTH_GITHUB_CLIENT_SECRET);
  const orgs = splitList(env.AUTH_GITHUB_ALLOWED_ORGS).map((org) => org.toLowerCase());

  if (clientId === null && clientSecret === null) {
    if (orgs.length > 0) {
      return fail(
        'AUTH_GITHUB_ALLOWED_ORGS',
        'AUTH_GITHUB_ALLOWED_ORGS is set but AUTH_GITHUB_CLIENT_ID and AUTH_GITHUB_CLIENT_SECRET are not.',
      );
    }
    return null;
  }
  if (clientId === null) {
    return fail(
      'AUTH_GITHUB_CLIENT_ID',
      'AUTH_GITHUB_CLIENT_SECRET is set but AUTH_GITHUB_CLIENT_ID is not.',
    );
  }
  if (clientSecret === null) {
    return fail(
      'AUTH_GITHUB_CLIENT_SECRET',
      'AUTH_GITHUB_CLIENT_ID is set but AUTH_GITHUB_CLIENT_SECRET is not.',
    );
  }
  if (!orgs.every((org) => GITHUB_ORG_RE.test(org))) {
    return fail(
      'AUTH_GITHUB_ALLOWED_ORGS',
      'AUTH_GITHUB_ALLOWED_ORGS contains an invalid organization login.',
    );
  }
  return { clientId, clientSecret, allowedOrgs: orgs };
}

function parseOidcLogin(env: AppEnv, errors: ConfigError[]): OidcLogin | null {
  const fail = (variable: string, message: string): null => {
    errors.push({ feature: 'login.oidc', variable, message });
    return null;
  };
  const issuer = readVar(env.AUTH_OIDC_ISSUER);
  const oidcId = readVar(env.AUTH_OIDC_CLIENT_ID);
  const oidcSecret = readVar(env.AUTH_OIDC_CLIENT_SECRET);
  const googleId = readVar(env.AUTH_GOOGLE_CLIENT_ID);
  const googleSecret = readVar(env.AUTH_GOOGLE_CLIENT_SECRET);
  const anyOidc = issuer !== null || oidcId !== null || oidcSecret !== null;
  const anyGoogle = googleId !== null || googleSecret !== null;
  const name = readVar(env.AUTH_OIDC_NAME);
  const domains = splitList(env.AUTH_OIDC_ALLOWED_DOMAINS).map((domain) => domain.toLowerCase());

  if (anyOidc && anyGoogle) {
    return fail(
      'AUTH_GOOGLE_CLIENT_ID',
      'AUTH_GOOGLE_* and AUTH_OIDC_ISSUER/AUTH_OIDC_CLIENT_* are mutually exclusive; both are disabled.',
    );
  }
  if (!anyOidc && !anyGoogle) {
    if (domains.length > 0) {
      return fail(
        'AUTH_OIDC_ALLOWED_DOMAINS',
        'AUTH_OIDC_ALLOWED_DOMAINS is set but no OIDC or Google login is configured.',
      );
    }
    return null;
  }
  if (!domains.every(isDomainName)) {
    return fail(
      'AUTH_OIDC_ALLOWED_DOMAINS',
      'AUTH_OIDC_ALLOWED_DOMAINS contains an invalid domain.',
    );
  }

  if (anyGoogle) {
    if (googleId === null) {
      return fail(
        'AUTH_GOOGLE_CLIENT_ID',
        'AUTH_GOOGLE_CLIENT_SECRET is set but AUTH_GOOGLE_CLIENT_ID is not.',
      );
    }
    if (googleSecret === null) {
      return fail(
        'AUTH_GOOGLE_CLIENT_SECRET',
        'AUTH_GOOGLE_CLIENT_ID is set but AUTH_GOOGLE_CLIENT_SECRET is not.',
      );
    }
    return {
      kind: 'google',
      issuer: GOOGLE_ISSUER,
      clientId: googleId,
      clientSecret: googleSecret,
      label: name ?? GOOGLE_LABEL,
      allowedDomains: domains,
    };
  }

  if (issuer === null || oidcId === null || oidcSecret === null) {
    const missing = [
      issuer === null ? 'AUTH_OIDC_ISSUER' : null,
      oidcId === null ? 'AUTH_OIDC_CLIENT_ID' : null,
      oidcSecret === null ? 'AUTH_OIDC_CLIENT_SECRET' : null,
    ].filter((variable) => variable !== null);
    return fail(
      missing[0] ?? 'AUTH_OIDC_ISSUER',
      `OIDC login is partially configured; missing ${missing.join(', ')}.`,
    );
  }
  if (!isHttpsIssuer(issuer)) {
    return fail(
      'AUTH_OIDC_ISSUER',
      'AUTH_OIDC_ISSUER must be an https URL without credentials, query or fragment.',
    );
  }
  // Google's issuer configured through AUTH_OIDC_* still gets the Google preset, so the `hd`
  // check applies to AUTH_OIDC_ALLOWED_DOMAINS (an email domain alone does not prove Workspace
  // membership). Compared as parsed URLs, like discovery does, so `https://accounts.google.com/`
  // and an upper-case host also get it. `issuer` stays as configured for discovery; subjects are
  // namespaced by its canonical form (oidcSubject in src/admin/auth/oidc.ts).
  const google = new URL(issuer).href === new URL(GOOGLE_ISSUER).href;
  return {
    kind: google ? 'google' : 'oidc',
    issuer,
    clientId: oidcId,
    clientSecret: oidcSecret,
    label: name ?? (google ? GOOGLE_LABEL : DEFAULT_OIDC_LABEL),
    allowedDomains: domains,
  };
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

function parseUpstreamHosts(raw: string | undefined, errors: ConfigError[]): string[] | null {
  if (readVar(raw) === null) return null;
  const entries = splitList(raw).map((entry) => entry.toLowerCase());
  const fail = (message: string): string[] => {
    errors.push({ feature: 'upstream_hosts', variable: 'ALLOWED_UPSTREAM_HOSTS', message });
    return [];
  };
  if (entries.length === 0) return fail('ALLOWED_UPSTREAM_HOSTS is set but lists no hosts.');
  for (const entry of entries) {
    const valid = entry.startsWith('*.')
      ? isDomainName(entry.slice(2)) && entry.slice(2).includes('.')
      : isDomainName(entry);
    if (!valid) {
      return fail(
        'ALLOWED_UPSTREAM_HOSTS entries must be hostnames or "*.<domain>" with at least two labels.',
      );
    }
  }
  return entries;
}

function isDomainName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  return name.split('.').every((label) => DNS_LABEL_RE.test(label));
}

function isWorkersDev(hostname: string): boolean {
  return hostname === 'workers.dev' || hostname.endsWith('.workers.dev');
}

function isHttpsIssuer(raw: string): boolean {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    !raw.includes('?') &&
    !raw.includes('#')
  );
}
