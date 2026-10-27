// The admin stylesheets at /static/<name>.<hash>.css (immutable) and /static/<name>.css
// (revalidated), and the favicon at /static/favicon.<hash>.svg, both served by the Worker so the
// security headers apply. Never under /admin: that prefix forces no-store and needs an RBAC route
// entry. Any other /static path is a 404.
import { IMMUTABLE_CACHE, REVALIDATE_CACHE, serveCss } from '@tokengate/ui/css';
import { FAVICON_CONTENT_TYPE, favicon } from '@tokengate/ui/favicon';
import { ADMIN_STYLESHEETS } from '../admin/assets';
import type { App } from '../app';
import { adminHostAllowed } from '../config';
import { getAdminBranding } from '../db/settings';

export function registerStaticRoutes(app: App): void {
  // Hono answers HEAD from the GET route.
  app.get('/static/:file', async (c) => {
    const css = serveCss(ADMIN_STYLESHEETS, c.req.path, c.req.header('if-none-match'));
    if (css) return css;
    // The favicon carries the uploaded brand image: only on hosts that serve the admin.
    const match = /^favicon(?:\.([0-9a-f]+))?\.svg$/.exec(c.req.param('file'));
    if (!match || !adminHostAllowed(new URL(c.req.url))) return c.notFound();
    const icon = favicon((await getAdminBranding(c.get('deps').env.DB)).image);
    // An old hash is a replaced image: 404, so the page's current link is fetched instead.
    if (match[1] !== undefined && match[1] !== icon.hash) return c.notFound();
    const etag = `"${icon.hash}"`;
    const headers = {
      'content-type': FAVICON_CONTENT_TYPE,
      'cache-control': match[1] ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
      etag,
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(icon.svg, { headers });
  });
}
