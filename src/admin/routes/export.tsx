// Configuration export download (POST /admin/export, from the shell footer). A CSRF-checked POST
// (I-CSRF-1) because the export writes an audit row (I-AUDIT-1). It has no page of its own: a GET
// is unlisted and gets the 404 page.
import type { App } from '../../app';
import { exportConfiguration } from '../ops/export';
import { adminActor, renderPage } from '../render';
import { Csrf, Messages } from '../views/components';

export function registerExportRoutes(app: App): void {
  app.post('/admin/export', async (c) => {
    const deps = c.get('deps');
    const result = await exportConfiguration(deps, adminActor(c));
    if (!result.ok) {
      return renderPage(
        c,
        { title: 'Export failed', status: 409 },
        <>
          <Messages errors={result.errors} />
          <form method="post" action="/admin/export">
            <Csrf token={c.get('viewer').csrfToken} />
            <button type="submit">Try the export again</button>
          </form>
        </>,
      );
    }
    const date = new Date(deps.now()).toISOString().slice(0, 10);
    return c.body(result.json, 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="tokengate-export-${date}.json"`,
    });
  });
}
