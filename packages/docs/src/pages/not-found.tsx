import { PageHeader, Panel, Tray } from '@tokengate/ui';
import { DocsLayout } from '../layout';

export function NotFoundPage(props: { path: string }) {
  return (
    <DocsLayout title="Page not found" at={{ kind: 'none' }}>
      <PageHeader title="Page not found" description="There is no docs page at this address." />
      <Tray id="dx-nf" title="Where to go">
        <Panel variant="pad">
          <p>
            <code>{props.path}</code> does not exist. Start from the <a href="/docs">overview</a>.
          </p>
        </Panel>
      </Tray>
    </DocsLayout>
  );
}
