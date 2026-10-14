// Browser hardening for every response outside /proxy (docs/threat-model.md): script-free CSP, nosniff,
// no-referrer, HSTS on https, no-store on /admin. Host pinning (I-DEPLOY-1): with PUBLIC_URL set,
// /admin answers 404 on any other origin. /proxy sets its own headers.
import type { App } from '../app';
import { adminOriginAllowed, parseConfig } from '../config';

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const HSTS = 'max-age=31536000';

export function applySecurityMiddleware(app: App): void {
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    // Classify by the path Hono routes on (percent-decoded), not `url.pathname`: `/%61dmin` is
    // dispatched to the /admin pages and must be pinned exactly like `/admin`.
    const path = c.req.path;
    if (isUnder(path, '/proxy')) {
      await next();
      return;
    }
    const pinned = isUnder(path, '/admin');
    if (pinned && !adminOriginAllowed(parseConfig(c.get('deps').env), url)) {
      c.res = c.text('Not Found', 404);
    } else {
      await next();
    }
    // Responses passed through from fetch() have immutable headers; copy those first.
    if (!headersMutable(c.res)) c.res = new Response(c.res.body, c.res);
    const headers = c.res.headers;
    headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    if (url.protocol === 'https:') headers.set('strict-transport-security', HSTS);
    if (pinned) headers.set('cache-control', 'no-store');
  });
}

/** Probes with a header the middleware sets anyway: immutable headers throw on `set`. */
function headersMutable(response: Response): boolean {
  try {
    response.headers.set('x-content-type-options', 'nosniff');
    return true;
  } catch {
    return false;
  }
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
