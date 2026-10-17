// A component group page: /docs/components/<group>, the group's components as link cards.
import { PageHeader, Panel, Tray } from '@tokengate/ui';
import { DocsLayout } from '../layout';
import { REGISTRY, componentHref, type GroupInfo } from '../registry';
import { LinkCards } from './parts';

export function GroupPage(props: { group: GroupInfo }) {
  const { group } = props;
  const docs = REGISTRY[group.key];
  return (
    <DocsLayout
      title={group.label}
      description={group.description}
      at={{ kind: 'group', group: group.key }}
    >
      <PageHeader
        crumbs={[{ label: 'Components', href: '/docs#components' }, { label: group.label }]}
        title={group.label}
        count={docs.length}
        description={group.description}
      />
      <Tray id="dx-components" title="Components" count={docs.length}>
        {docs.length > 0 ? (
          <Panel variant="pad">
            <LinkCards
              label={`${group.label} components`}
              cards={docs.map((doc) => ({
                href: componentHref(group.key, doc.slug),
                title: doc.name,
                description: doc.summary,
              }))}
            />
          </Panel>
        ) : (
          <Panel variant="pad">
            <div class="empty">
              <span class="glyph" aria-hidden="true">
                ◇
              </span>
              <h3>No components documented yet</h3>
              <p>
                Components of this group appear here when their entry is added to{' '}
                <code>packages/docs/src/registry/{group.key}.tsx</code>.
              </p>
            </div>
          </Panel>
        )}
      </Tray>
    </DocsLayout>
  );
}
