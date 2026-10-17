// Configuration export download (POST /admin/export, from the account menu). A CSRF-checked POST
// (I-CSRF-1) because the export writes an audit row (I-AUDIT-1). It has no page of its own: a GET
// is unlisted and gets the 404 page.
import { ActionForm, PageHeader } from '@tokengate/ui';
import type { App } from '../../app';
import { exportConfiguration } from '../ops/export';
import { paths } from '../paths';
import { adminActor, renderPage } from '../render';

export function registerExportRoutes(app: App): void {
  app.post('/admin/export', async (c) => {
    const deps = c.get('deps');
    const result = await exportConfiguration(deps, adminActor(c));
    if (!result.ok) {
      return renderPage(
        c,
        {
          title: 'Export failed',
          section: 'monitoring',
          subsection: '',
          errors: result.errors.map((message) => ({ field: null, message })),
          status: 409,
          // The retry is the page's one primary, top right.
          header: (view) => (
            <PageHeader
              title="Export failed"
              actions={
                <ActionForm action={paths.export()} variant="primary" hidden={view.hidden()}>
                  Try the export again
                </ActionForm>
              }
            />
          ),
        },
        () => null,
      );
    }
    const date = new Date(deps.now()).toISOString().slice(0, 10);
    return c.body(result.json, 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="tokengate-export-${date}.json"`,
    });
  });
}
