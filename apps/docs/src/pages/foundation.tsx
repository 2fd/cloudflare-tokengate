// A foundations page: /docs/foundations/<topic>.
import { PageHeader } from '@tokengate/ui';
import type { Foundation } from '../foundations';
import { DocsLayout } from '../layout';

export function FoundationPage(props: { topic: Foundation }) {
  const { topic } = props;
  return (
    <DocsLayout
      title={topic.title}
      description={topic.summary}
      at={{ kind: 'foundation', slug: topic.slug }}
    >
      <PageHeader
        crumbs={[{ label: 'Foundations', href: '/docs#foundations' }, { label: topic.title }]}
        title={topic.title}
        description={topic.summary}
      />
      {topic.render()}
    </DocsLayout>
  );
}
