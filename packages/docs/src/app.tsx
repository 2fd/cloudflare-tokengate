// HTTP surface of the docs: /docs pages generated from the registry and the foundations list, and
// the hashed stylesheets under /docs/static/. Every route is under /docs, so the app can be mounted
// next to the gateway's routes and its admin stylesheets (/static/*) without a collision.
import { serveCss } from '@tokengate/ui/css';
import { Hono } from 'hono';
import { STYLESHEETS } from './assets';
import { FOUNDATIONS, findFoundation } from './foundations';
import { ComponentPage } from './pages/component';
import { FoundationPage } from './pages/foundation';
import { GroupPage } from './pages/group';
import { NotFoundPage } from './pages/not-found';
import { OverviewPage } from './pages/overview';
import { findComponent, findGroup } from './registry';
import { applySecurityHeaders } from './security';

/** True for `/docs` and every path below it: the paths this app answers. */
export function isDocsPath(pathname: string): boolean {
  return pathname === '/docs' || pathname.startsWith('/docs/');
}

export function createDocsApp(): Hono {
  const app = new Hono({ strict: false });
  applySecurityHeaders(app);

  app.get('/docs/static/:file', (c) => {
    const res = serveCss(STYLESHEETS, c.req.path, c.req.header('if-none-match'));
    return res ?? c.notFound();
  });

  app.get('/docs', (c) => c.html(<OverviewPage />));
  app.get('/docs/foundations', (c) => {
    const first = FOUNDATIONS[0];
    return first ? c.redirect(`/docs/foundations/${first.slug}`, 302) : c.notFound();
  });
  app.get('/docs/foundations/:topic', (c) => {
    const topic = findFoundation(c.req.param('topic'));
    return topic ? c.html(<FoundationPage topic={topic} />) : c.notFound();
  });
  app.get('/docs/components', (c) => c.redirect('/docs#components', 302));
  app.get('/docs/components/:group', (c) => {
    const group = findGroup(c.req.param('group'));
    return group ? c.html(<GroupPage group={group} />) : c.notFound();
  });
  app.get('/docs/components/:group/:name', (c) => {
    const found = findComponent(c.req.param('group'), c.req.param('name'));
    return found ? c.html(<ComponentPage group={found.group} doc={found.doc} />) : c.notFound();
  });

  app.notFound((c) => c.html(<NotFoundPage path={c.req.path} />, 404));
  return app;
}
