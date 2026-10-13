// Typed view of the Worker environment.
// `wrangler types` cannot see operator vars (set in the dashboard, see wrangler.jsonc keep_vars),
// secrets or optional bindings, so this module is the single place that declares them.
import type { Pipeline } from 'cloudflare:pipelines';
import type { ArchiveRecord, RequestRecord } from './telemetry/types';

export interface AppEnv {
  DB: D1Database;
  TELEMETRY_DB: D1Database;
  ASSETS?: Fetcher;

  PUBLIC_URL?: string;
  BOOTSTRAP_OWNER_EMAILS?: string;
  ALLOWED_UPSTREAM_HOSTS?: string;

  TOKENGATE_KEK?: string;
  TOKENGATE_KEYRING?: string;

  AUTH_GITHUB_CLIENT_ID?: string;
  AUTH_GITHUB_CLIENT_SECRET?: string;
  AUTH_GITHUB_ALLOWED_ORGS?: string;
  AUTH_OIDC_ISSUER?: string;
  AUTH_OIDC_CLIENT_ID?: string;
  AUTH_OIDC_CLIENT_SECRET?: string;
  AUTH_OIDC_NAME?: string;
  AUTH_OIDC_ALLOWED_DOMAINS?: string;
  AUTH_GOOGLE_CLIENT_ID?: string;
  AUTH_GOOGLE_CLIENT_SECRET?: string;
  AUTH_ACCESS_TEAM_DOMAIN?: string;
  AUTH_ACCESS_AUD?: string;

  REQUEST_LOG_QUEUE?: Queue<RequestRecord>;
  REQUEST_ARCHIVE?: Pipeline<ArchiveRecord>;
  PROXY_RATE_LIMITER?: RateLimit;
}

export function appEnv(env: Env): AppEnv {
  return env as unknown as AppEnv;
}
