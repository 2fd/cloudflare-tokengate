// The admin stylesheets at /static/<name>.<hash>.css (immutable) and /static/<name>.css
// (revalidated), served by the Worker so the security headers apply. Never under /admin: that
// prefix forces no-store and needs an RBAC route entry. Any other /static path is a 404.
import { serveCss } from '@tokengate/ui/css';
import { ADMIN_STYLESHEETS } from '../admin/assets';
import type { App } from '../app';

export function registerStaticRoutes(app: App): void {
  // Hono answers HEAD from the GET route.
  app.get(
    '/static/:file',
    (c) => serveCss(ADMIN_STYLESHEETS, c.req.path, c.req.header('if-none-match')) ?? c.notFound(),
  );
}
