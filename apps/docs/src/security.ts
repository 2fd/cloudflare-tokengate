// Browser hardening for every docs response, in the spirit of the gateway's (apps/gateway/src/http/
// security.ts): no script-src at all, styles only from this origin (the hashed stylesheets), no
// framing, nosniff, no referrer. Component examples are inert markup: forms post nowhere useful.
import type { Hono } from 'hono';

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function applySecurityHeaders(app: Hono): void {
  app.use('*', async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    if (new URL(c.req.url).protocol === 'https:') {
      headers.set('strict-transport-security', 'max-age=31536000');
    }
  });
}
