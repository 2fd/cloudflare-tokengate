// Who is making this admin request. There are no gateway sessions: every request carries its own
// proof, the Cloudflare Access JWT (I-SESS-1). The dev login only applies to loopback hosts.
import { type Config, LOCAL_DEV_HOSTS } from '../../config';
import type { Deps } from '../../deps';
import { ACCESS_JWT_HEADER, type AccessVerifyError, verifyAccessAssertion } from './access';
import { authoritativeEmails } from './email';
import type { LoginIdentity, LoginProviderId } from './resolve-login';

const USER_AGENT_MAX = 256;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMeta(headers: Headers): RequestMeta {
  return {
    ip: headers.get('cf-connecting-ip'),
    userAgent: headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
  };
}

export type IdentityError = 'not_configured' | AccessVerifyError;

/**
 * The verified login identity of a request. When Access is configured it is the only accepted
 * proof, even if AUTH_DEV_EMAIL is also set. The dev login also re-checks the request host itself,
 * independent of host pinning.
 */
export async function requestIdentity(
  request: Request,
  config: Config,
  deps: Pick<Deps, 'fetch' | 'now'>,
): Promise<{ ok: true; identity: LoginIdentity } | { ok: false; error: IdentityError }> {
  const { access, dev } = config.login;
  if (access) {
    return verifyAccessAssertion(request.headers.get(ACCESS_JWT_HEADER), access, deps);
  }
  if (dev && LOCAL_DEV_HOSTS.has(new URL(request.url).hostname)) {
    return {
      ok: true,
      identity: {
        loginProvider: 'dev',
        subject: dev.email,
        emails: authoritativeEmails('dev', { email: dev.email }),
        name: null,
      },
    };
  }
  return { ok: false, error: 'not_configured' };
}

/** Cloudflare Access ends the Access session for the application's hostname here. */
export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';

/** Where "Sign out" goes; null when the login has no sign-out (dev). */
export function signOutUrl(loginProvider: LoginProviderId): string | null {
  return loginProvider === 'access' ? ACCESS_LOGOUT_PATH : null;
}
