import { describe, expect, it } from 'vitest';
import { Cell, CountLink, Entity, Result, Row, RowHeader, Table } from '../../src';
import { render } from '../render';

const columns = [
  { label: 'Token' },
  { label: 'Requests 24 h', num: true },
  { label: 'Actions', act: true },
];

describe('Table', () => {
  it('wraps the table in a focusable region named by the tray heading', () => {
    const html = render(<Table labelledBy="tokens-h" columns={columns} />);
    expect(html).toBe(
      '<div class="scroll" role="region" tabindex="0" aria-labelledby="tokens-h">' +
        '<table class="tbl"><thead><tr>' +
        '<th scope="col">Token</th>' +
        '<th scope="col" class="num">Requests 24 h</th>' +
        '<th scope="col" class="act"><span class="vh">Actions</span></th>' +
        '</tr></thead></table></div>',
    );
  });

  it('names the region with a label when there is no heading', () => {
    const html = render(<Table label="Requests, newest first" columns={columns} />);
    expect(html).toContain(
      '<div class="scroll" role="region" tabindex="0" aria-label="Requests, newest first">',
    );
    expect(html).not.toContain('aria-labelledby');
  });

  it('renders without the region, and without a tbody when there are no rows', () => {
    const html = render(
      <Table scroll={false} caption="Tokens" columns={columns}>
        {[]}
      </Table>,
    );
    // without the region the table names itself: the caption is required
    expect(html.startsWith('<table class="tbl"><caption class="vh">Tokens</caption>')).toBe(true);
    expect(html).not.toContain('scroll');
    expect(html).not.toContain('<tbody>');
  });

  it('adds the modifiers and passes classes to the table', () => {
    const html = render(
      <Table label="Log" dense stackable class="log" columns={[{ label: 'When', class: 'w' }]}>
        <Row>
          <Cell>1</Cell>
        </Row>
      </Table>,
    );
    expect(html).toContain('<table class="tbl dense stackable log">');
    expect(html).toContain('<th scope="col" class="w">When</th>');
    expect(html).toContain('<tbody><tr><td>1</td></tr></tbody>');
  });

  it('hides the caption by default and shows it on request', () => {
    expect(render(<Table label="x" caption="Top denied callers" columns={columns} />)).toContain(
      '<caption class="vh">Top denied callers</caption>',
    );
    expect(
      render(<Table label="x" caption="Top denied callers" captionVisible columns={columns} />),
    ).toContain('<caption>Top denied callers</caption>');
  });
});

describe('Row, RowHeader, Cell', () => {
  it('highlights a row and scopes the row header', () => {
    expect(
      render(
        <Row highlight class="x">
          <RowHeader class="y">Slack</RowHeader>
        </Row>,
      ),
    ).toBe('<tr class="hl x"><th scope="row" class="y">Slack</th></tr>');
    expect(render(<Row>{''}</Row>)).toBe('<tr></tr>');
  });

  it('renders the cell helpers and the stacked label', () => {
    expect(
      render(
        <Cell label="Requests" num zero>
          0
        </Cell>,
      ),
    ).toBe('<td class="num zero" data-label="Requests">0</td>');
    expect(render(<Cell act>a</Cell>)).toBe('<td class="act">a</td>');
    expect(
      render(
        <Cell nowrap class="x" label="Secret">
          s
        </Cell>,
      ),
    ).toBe('<td class="nowrap x" data-label="Secret">s</td>');
  });
});

describe('Entity', () => {
  it('renders logo, name link and a mono meta line', () => {
    const html = render(
      <Entity logo="slack" name="Slack" href="/admin/tokens/slack" meta="/proxy/slack" metaMono />,
    );
    expect(html).toBe(
      '<span class="ent"><span class="logo lg-slack" aria-hidden="true">S</span>' +
        '<span class="ent-t"><a class="ent-n" href="/admin/tokens/slack">Slack</a>' +
        '<span class="meta mono">/proxy/slack</span></span></span>',
    );
  });

  it('renders a plain name, the after slot and class passthrough', () => {
    const html = render(
      <Entity
        name="Slack"
        after={<span class="slug">slack</span>}
        meta="Slack Web API"
        class="x"
      />,
    );
    expect(html).toBe(
      '<span class="ent x"><span class="ent-t"><span><span class="ent-n">Slack</span> ' +
        '<span class="slug">slack</span></span><span class="meta">Slack Web API</span></span></span>',
    );
  });

  it('escapes names and meta', () => {
    const html = render(<Entity name="<script>x</script>" meta={'a & "b"'} />);
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a &amp; &quot;b&quot;');
    expect(html).not.toContain('<script>');
  });
});

describe('CountLink', () => {
  it('links the count with a tone and a screen reader suffix', () => {
    expect(
      render(
        <CountLink href="/admin/requests?outcome=denied&token=slack" tone="bad" srSuffix="denied">
          38
        </CountLink>,
      ),
    ).toBe(
      '<a class="nlink bad" href="/admin/requests?outcome=denied&amp;token=slack">38<span class="vh"> denied</span></a>',
    );
    expect(
      render(
        <CountLink href="/a" class="x">
          2
        </CountLink>,
      ),
    ).toBe('<a class="nlink x" href="/a">2</a>');
  });
});

describe('Result', () => {
  it('renders the dot, the word and the code per tone', () => {
    expect(
      render(
        <Result tone="ok" code={200}>
          Allowed
        </Result>,
      ),
    ).toBe(
      '<span class="res ok"><span class="dot" aria-hidden="true"></span>Allowed <span class="code">200</span></span>',
    );
    expect(
      render(
        <Result tone="bad" code="403">
          Denied
        </Result>,
      ),
    ).toContain('<span class="dot bad" aria-hidden="true"></span>Denied');
    expect(
      render(
        <Result tone="warn" class="x">
          Error
        </Result>,
      ),
    ).toBe(
      '<span class="res warn x"><span class="dot warn" aria-hidden="true"></span>Error</span>',
    );
  });
});
