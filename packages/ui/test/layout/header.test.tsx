import { describe, expect, it } from 'vitest';
import { Identity, PageHeader, RelationLine, Segmented, TabRow, Tabs } from '../../src';
import { render } from '../render';

describe('PageHeader (detail)', () => {
  const html = render(
    <PageHeader
      crumbs={[{ label: 'Service tokens', href: '/admin/tokens' }, { label: 'Slack' }]}
      identity={<Identity title="Slack" />}
      actions={<a href="#">Give access</a>}
    >
      <RelationLine>rel</RelationLine>
    </PageHeader>,
  );

  it('renders the identity in place of the list title', () => {
    expect(html).toContain(
      '<div class="ph-row"><div class="ident"><div><h1>Slack</h1></div></div>',
    );
    expect(html).not.toContain('ph-title');
  });

  it('keeps crumbs first, actions in the title row, extra rows last', () => {
    expect(html.indexOf('crumbs')).toBeLessThan(html.indexOf('ph-row'));
    expect(html).toContain(
      '<div class="ph-actions"><a href="#">Give access</a></div></div><p class="relline">rel</p></header>',
    );
  });

  it('passes classes through and escapes the title', () => {
    expect(render(<PageHeader title="<x>" class="k" />)).toBe(
      '<header class="ph k"><div class="ph-row"><div class="ph-title"><h1>&lt;x&gt;</h1></div></div></header>',
    );
  });

  it('renders a count of 0', () => {
    expect(render(<PageHeader title="Consumer access" count={0} />)).toContain(
      '<h1>Consumer access<span class="count">0</span></h1>',
    );
  });
});

describe('Identity', () => {
  const html = render(
    <Identity
      logo={
        <span class="logo lg lg-slack" aria-hidden="true">
          S
        </span>
      }
      title="Slack"
      status={<span class="badge ok">✓ Active</span>}
      type="Slack Web API"
      slug="slack"
      entityId={{ value: 'svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C', label: 'Token ID' }}
      facts={['Created 3 Oct 2026']}
      class="x"
    />,
  );

  it('puts the status inside the h1', () => {
    expect(html).toContain('<h1>Slack <span class="badge ok">✓ Active</span></h1>');
  });

  it('orders the meta line type, slug, ID chip, facts', () => {
    expect(html).toContain(
      '<div class="ident-meta"><span>Slack Web API</span><span class="slug">slack</span><span class="vh">Token ID</span><span class="idchip" title="Token ID">svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C</span><span>Created 3 Oct 2026</span></div>',
    );
  });

  it('keeps the ID label outside the copyable chip', () => {
    expect(html).not.toMatch(/class="idchip"[^>]*><span/);
  });

  it('starts with the logo and passes classes through', () => {
    expect(html).toMatch(
      /^<div class="ident x"><span class="logo lg lg-slack" aria-hidden="true">S<\/span><div>/,
    );
  });

  it('drops the meta line when there are no facts', () => {
    expect(render(<Identity title="Maya Chen" />)).toBe(
      '<div class="ident"><div><h1>Maya Chen</h1></div></div>',
    );
  });
});

describe('Tabs', () => {
  const html = render(
    <Tabs
      label="Token views"
      class="x"
      items={[
        { label: 'Overview', href: '/o', current: true },
        { label: 'Access', href: '/a', count: 3 },
        { label: 'Requests', href: '/r', count: 0 },
      ]}
    />,
  );

  it('is a named nav with the current tab marked', () => {
    expect(html).toMatch(/^<nav class="tabs x" aria-label="Token views">/);
    expect(html).toContain('<a href="/o" aria-current="page">Overview</a>');
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it('renders counts, including 0', () => {
    expect(html).toContain('<a href="/a">Access <span class="n">3</span></a>');
    expect(html).toContain('<a href="/r">Requests <span class="n">0</span></a>');
  });
});

describe('Segmented', () => {
  it('renders links with the current one marked, small size', () => {
    expect(
      render(
        <Segmented
          label="Range"
          size="sm"
          items={[
            { label: '24 hours', href: '?r=24h', current: true },
            { label: '7 days', href: '?r=7d' },
          ]}
        />,
      ),
    ).toBe(
      '<nav class="seg sm" aria-label="Range"><a href="?r=24h" aria-current="page">24 hours</a><a href="?r=7d">7 days</a></nav>',
    );
  });

  it('defaults to the 40px size and passes classes through', () => {
    expect(render(<Segmented label="View" class="y" items={[{ label: 'Map', href: '#' }]} />)).toBe(
      '<nav class="seg y" aria-label="View"><a href="#">Map</a></nav>',
    );
  });
});

describe('TabRow and RelationLine', () => {
  it('wrap their children', () => {
    expect(render(<TabRow class="x">t</TabRow>)).toBe('<div class="tabrow x">t</div>');
    expect(render(<RelationLine class="y">r</RelationLine>)).toBe('<p class="relline y">r</p>');
  });
});
