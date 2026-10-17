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
        title="Credentials"
        count={6}
        description="Secrets."
        actions={<a href="#">Add</a>}
      />,
    );
    expect(html).toContain('<h1>Credentials<span class="count">6</span></h1>');
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
    expect(render(<Tray id="a" title="T" headingLevel={3} />)).toContain('<h3 id="a-h">T</h3>');
  });
});

describe('Tray header bar', () => {
  it('puts the bar straight in the header row, after a screen-reader-only title', () => {
    const html = render(
      <Tray id="rq" title="Requests, newest first" hideTitle bar={<form class="filters">f</form>}>
        <Panel variant="flush">x</Panel>
      </Tray>,
    );
    expect(html).toContain(
      '<div class="tray-h"><h2 class="vh" id="rq-h">Requests, newest first</h2><form class="filters">f</form></div>',
    );
  });

  it('drops the header row when the hidden title has nothing beside it', () => {
    const html = render(
      <Tray id="adv" title="Advanced" hideTitle headingLevel={3} footer="f">
        <Panel variant="pad">x</Panel>
      </Tray>,
    );
    expect(html).toBe(
      '<section class="tray" id="adv" aria-labelledby="adv-h"><h3 class="vh" id="adv-h">Advanced</h3><div class="panel pad">x</div><div class="tray-f">f</div></section>',
    );
  });

  it('keeps the header row for a hidden title with actions only', () => {
    expect(render(<Tray id="a" title="T" hideTitle actions={<a href="#">x</a>} />)).toContain(
      '<div class="tray-h"><h2 class="vh" id="a-h">T</h2><div class="end"><a href="#">x</a></div></div>',
    );
  });

  it('keeps the visible title block when the title is shown', () => {
    expect(render(<Tray id="q" title="Credentials" bar={<nav>q</nav>} />)).toContain(
      '<div class="t"><h2 id="q-h">Credentials</h2></div><nav>q</nav>',
    );
  });
});

describe('Tray slots', () => {
  const html = render(
    <Tray
      id="tok"
      title="All tokens"
      description="One line."
      actions={<a href="#">Export</a>}
      footer="Updated 14:05"
      class="x"
    >
      <Panel variant="pad">a</Panel>
      <Panel>b</Panel>
    </Tray>,
  );

  it('renders description, actions and footer around the panels', () => {
    expect(html).toMatch(/^<section class="tray x" id="tok" aria-labelledby="tok-h">/);
    expect(html).toContain(
      '<div class="t"><h2 id="tok-h">All tokens</h2><p>One line.</p></div><div class="end"><a href="#">Export</a></div>',
    );
    expect(html).toContain(
      '<div class="panel pad">a</div><div class="panel">b</div><div class="tray-f">Updated 14:05</div></section>',
    );
  });
});

describe('Panel', () => {
  it.each(['pad', 'flush'] as const)('variant %s', (variant) => {
    expect(
      render(
        <Panel variant={variant} class="y">
          c
        </Panel>,
      ),
    ).toBe(`<div class="panel ${variant} y">c</div>`);
  });
});

describe('Breadcrumbs', () => {
  it('renders a crumb without href as text', () => {
    expect(render(<Breadcrumbs items={[{ label: 'A' }, { label: 'B' }]} class="z" />)).toBe(
      '<nav class="crumbs z" aria-label="Breadcrumb"><ol><li>A</li><li aria-current="page">B</li></ol></nav>',
    );
  });
});
