// HTTP surface of the docs Worker: /docs pages generated from the registry and the foundations
// list, the hashed stylesheets, and a redirect from /.
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

export function createApp(): Hono {
  const app = new Hono({ strict: false });
  applySecurityHeaders(app);

  app.get('/', (c) => c.redirect('/docs', 302));

  app.get('/static/:file', (c) => {
    const res = serveCss(STYLESHEETS, c.req.path, c.req.header('if-none-match'));
    return res ?? c.text('Not Found', 404);
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
