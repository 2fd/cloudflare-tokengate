import { describe, expect, it } from 'vitest';
import { Breadcrumbs, Page, PageHeader, Panel, Tray } from '../../src';
import { render } from '../render';

describe('Page', () => {
  it('is the centered column', () => {
    expect(render(<Page class="x">c</Page>)).toBe('<div class="page x">c</div>');
  });
});

describe('Breadcrumbs', () => {
  it('links all but the last crumb, which is the current page', () => {
    expect(
      render(<Breadcrumbs items={[{ label: 'Requests', href: '/r' }, { label: 'req_1' }]} />),
    ).toBe(
      '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/r">Requests</a></li><li aria-current="page">req_1</li></ol></nav>',
    );
  });
});

describe('PageHeader', () => {
  it('renders title, count, description and actions', () => {
    const html = render(
      <PageHeader
        title="Service tokens"
        count={6}
        description="Secrets."
        actions={<a href="#">Add</a>}
      />,
    );
    expect(html).toContain('<h1>Service tokens<span class="count">6</span></h1>');
    expect(html).toContain('<p class="desc">Secrets.</p>');
    expect(html).toContain('<div class="ph-actions"><a href="#">Add</a></div>');
    expect(html).not.toContain('crumbs');
  });
});

describe('Tray', () => {
  it('is a section labelled by its heading', () => {
    const html = render(
      <Tray id="t" title="All tokens" count={6} tone="warn">
        <Panel variant="flush">x</Panel>
      </Tray>,
    );
    expect(html).toMatch(/^<section class="tray tone-warn" id="t" aria-labelledby="t-h">/);
    expect(html).toContain('<h2 id="t-h">All tokens<span class="count">6</span></h2>');
    expect(html).toContain('<div class="panel flush">x</div>');
  });

  it('uses an h3 styled as a tray title at level 3', () => {
    expect(render(<Tray id="a" title="T" level={3} />)).toContain('<h3 class="h2" id="a-h">T</h3>');
  });
});
