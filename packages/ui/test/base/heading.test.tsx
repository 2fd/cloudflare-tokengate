// Heading levels: one `headingLevel` prop, shifted by HeadingOffset and by the containers.
import { describe, expect, it } from 'vitest';
import {
  Checklist,
  DangerRow,
  DangerZone,
  EmptyState,
  HeadingOffset,
  Identity,
  PageHeader,
  Panel,
  Tray,
} from '../../src';
import { render } from '../render';

describe('HeadingOffset', () => {
  it('pushes a page header H1 down, styled as an H1', () => {
    expect(render(<PageHeader title="Credentials" />)).toContain('<h1>Credentials</h1>');
    const html = render(
      <HeadingOffset by={3}>
        <PageHeader title="Credentials" />
      </HeadingOffset>,
    );
    expect(html).toContain('<h4 class="h1">Credentials</h4>');
    expect(html).not.toContain('<h1');
  });

  it('pushes an identity H1 down too', () => {
    const html = render(
      <HeadingOffset by={2}>
        <Identity title="Slack" />
      </HeadingOffset>,
    );
    expect(html).toContain('<h3 class="h1">Slack</h3>');
  });

  it('clamps at h6', () => {
    const html = render(
      <HeadingOffset by={5}>
        <EmptyState title="Nothing" />
      </HeadingOffset>,
    );
    expect(html).toContain('<h6>Nothing</h6>');
  });
});

describe('containers forward the level', () => {
  it('a tray at h3 puts its empty state at h4', () => {
    const html = render(
      <Tray id="t" title="Credentials" headingLevel={3}>
        <Panel>
          <EmptyState title="No tokens" />
        </Panel>
      </Tray>,
    );
    expect(html).toContain('<h3 id="t-h">Credentials</h3>');
    expect(html).toContain('<h4>No tokens</h4>');
  });

  it('a danger zone under an h2 takes h3 and its rows h4', () => {
    const html = render(
      <DangerZone id="dz" headingLevel={3}>
        <DangerRow title="Delete Slack" action="x" />
      </DangerZone>,
    );
    expect(html).toContain('<h3 id="dz-h">Danger zone</h3>');
    expect(html).toContain('<div class="dz-row"><div><h4>Delete Slack</h4>');
  });

  it('a checklist in a tray in an offset follows both', () => {
    const html = render(
      <HeadingOffset by={2}>
        <Tray id="g" title="Get started">
          <Panel>
            <Checklist steps={[{ state: 'todo', title: 'Add a credential', why: 'w' }]} />
          </Panel>
        </Tray>
      </HeadingOffset>,
    );
    expect(html).toContain('<h4 id="g-h">Get started</h4>');
    expect(html).toContain('<h5>Add a credential');
  });
});
