// The component docs page template. Every /docs/components/<group>/<slug> page renders one
// registry entry through it: header, when to use, live examples with their JSX, props tables,
// accessibility notes, do and don't, and the CSS classes.
import { CodeBlock, PageHeader, Panel, Tray } from '@tokengate/ui';
import { DocsLayout } from '../layout';
import type { ComponentDoc, ComponentExample, GroupInfo, PropsTable } from '../registry';
import { List } from './parts';

function Example(props: { example: ComponentExample; index: number }) {
  const { example } = props;
  const layout = example.layout ?? 'row';
  return (
    <div class="panel flush dx-example">
      <div class="dx-example-h">
        <h3 id={`dx-ex-${props.index}`}>{example.title}</h3>
        {example.description ? <p>{example.description}</p> : null}
      </div>
      <div class={`dx-canvas ${layout}`} role="group" aria-labelledby={`dx-ex-${props.index}`}>
        {example.render()}
      </div>
      <CodeBlock label={`${example.title}: JSX`} class="dx-code">
        {example.code.trim()}
      </CodeBlock>
    </div>
  );
}

function PropsPanel(props: { table: PropsTable }) {
  const id = `dx-props-${props.table.component}`;
  return (
    <Panel variant="flush">
      <div class="dx-example-h">
        <h3 id={id}>
          <code>{props.table.component}</code>
        </h3>
      </div>
      {props.table.props.length === 0 ? (
        <p class="dx-panel-note">No props besides the ones every component takes.</p>
      ) : (
        <div class="scroll" role="region" tabindex={0} aria-labelledby={id}>
          <table class="tbl stackable dx-props">
            <thead>
              <tr>
                <th scope="col">Prop</th>
                <th scope="col">Type</th>
                <th scope="col">Default</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {props.table.props.map((prop) => (
                <tr>
                  <th scope="row" class="dx-name">
                    {prop.name}
                    {prop.required ? <span class="dx-req">required</span> : null}
                  </th>
                  <td class="dx-type" data-label="Type">
                    {prop.type}
                  </td>
                  <td class="dx-type dx-def" data-label="Default">
                    {prop.default ?? '—'}
                  </td>
                  <td class="dx-cell" data-label="Description">
                    {prop.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function ComponentPage(props: { group: GroupInfo; doc: ComponentDoc }) {
  const { group, doc } = props;
  const exportsLine = [doc.name, ...(doc.related ?? [])].join(', ');
  return (
    <DocsLayout
      title={doc.name}
      description={doc.summary}
      at={{ kind: 'component', group: group.key, slug: doc.slug }}
    >
      <PageHeader
        crumbs={[
          { label: group.label, href: `/docs/components/${group.key}` },
          { label: doc.name },
        ]}
        title={doc.name}
        description={doc.summary}
      />
      <Tray id="dx-usage" title="When to use">
        <Panel variant="pad">
          <CodeBlock label="Import">{`import { ${exportsLine} } from '@tokengate/ui';`}</CodeBlock>
          <div class="dx-prose">
            <h3>Use it for</h3>
            <List items={doc.usage.when} />
            {doc.usage.whenNot && doc.usage.whenNot.length > 0 ? (
              <>
                <h3>Use something else</h3>
                <List items={doc.usage.whenNot} />
              </>
            ) : null}
          </div>
        </Panel>
      </Tray>
      <Tray
        id="dx-examples"
        title="Examples"
        count={doc.examples.length}
        description="Rendered by the real component, with the JSX that produces it."
      >
        {doc.examples.map((example, index) => (
          <Example example={example} index={index} />
        ))}
      </Tray>
      <Tray id="dx-props" title="Props">
        {doc.props.map((table) => (
          <PropsPanel table={table} />
        ))}
      </Tray>
      <Tray id="dx-a11y" title="Accessibility">
        <Panel variant="pad">
          <List items={doc.accessibility} />
        </Panel>
      </Tray>
      <Tray id="dx-rules" title="Do and don't">
        <div class="dx-dodont">
          <Panel variant="pad" class="dx-do">
            <h3>
              <span aria-hidden="true">✓</span>Do
            </h3>
            <List items={doc.do} />
          </Panel>
          <Panel variant="pad" class="dx-dont">
            <h3>
              <span aria-hidden="true">✕</span>Don't
            </h3>
            <List items={doc.dont} />
          </Panel>
        </div>
      </Tray>
      <Tray
        id="dx-classes"
        title="CSS classes"
        description="What it renders, for markup written by hand."
      >
        <Panel variant="pad">
          <ul class="dx-classes">
            {doc.classes.map((name) => (
              <li>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </Panel>
      </Tray>
    </DocsLayout>
  );
}
