import { describe, expect, it } from 'vitest';
import { Matrix, type MatrixColumn, type MatrixGroup } from '../../src';
import { render } from '../render';

const columns: MatrixColumn[] = [
  {
    id: 'slack',
    name: 'Slack',
    logo: { brand: 'slack' },
    href: '/admin/access?token=slack',
    meta: '3 accesses · 2,140 req',
  },
  { id: 'openai', name: 'OpenAI', logo: { brand: 'openai' }, href: '/admin/access?token=openai' },
];

const groups: MatrixGroup[] = [
  {
    name: 'GitHub Actions (acme)',
    logo: { brand: 'github' },
    href: '/admin/consumers/github-acme',
    meta: 'org acme (1234567) · 2 accesses',
    rows: [
      {
        label: 'acme/api',
        href: '/admin/access?repo=acme/api',
        meta: '2 accesses',
        cells: {
          slack: {
            href: '/admin/access/a1',
            status: 'Active',
            constraint: 'env production',
            operations: '1 operation',
          },
          openai: {
            href: '/admin/access/a2',
            tone: 'warn',
            status: 'Secret expires',
            constraint: 'branch main',
            operations: '2 operations',
          },
        },
      },
      { label: 'acme/web', cells: {} },
    ],
  },
  {
    rows: [
      {
        label: 'pipeline deploy',
        mono: false,
        cells: {
          slack: {
            href: '/admin/access/a9',
            tone: 'off',
            status: 'Inactive',
            glyph: '',
            constraint: 'Slack (legacy)',
            operations: 'token disabled',
          },
          openai: { href: '/admin/access/a10', tone: 'bad', status: 'Expired' },
        },
      },
    ],
  },
];

describe('Matrix', () => {
  const html = render(
    <Matrix
      label="Access matrix"
      corner="Consumer › repository"
      columns={columns}
      groups={groups}
      addHref={(row, column) =>
        `/admin/access/new?repo=${encodeURIComponent(row.label)}&token=${column.id}`
      }
      class="x"
    />,
  );

  it('is a focusable, named scroll region around the table', () => {
    expect(
      html.startsWith(
        '<div class="matrix x" role="region" tabindex="0" aria-label="Access matrix"><table class="mx"><thead><tr><th scope="col">Consumer › repository</th>',
      ),
    ).toBe(true);
  });

  it('renders column headers with logo, link and meta', () => {
    expect(html).toContain(
      '<th scope="col"><div class="colh"><span class="top"><span class="logo xs lg-slack" aria-hidden="true">S</span><a href="/admin/access?token=slack">Slack</a></span><span class="meta">3 accesses · 2,140 req</span></div></th>',
    );
    expect(html).toContain('<a href="/admin/access?token=openai">OpenAI</a></span></div></th>');
  });

  it('groups rows per consumer in their own tbody with a row-group header', () => {
    expect(html.match(/<tbody>/g)).toHaveLength(2);
    expect(html).toContain(
      '<tr class="grp"><th colspan="3" scope="rowgroup"><span class="gin"><span class="logo xs lg-github" aria-hidden="true">GH</span><a class="ent-n" href="/admin/consumers/github-acme">GitHub Actions (acme)</a><span class="meta">org acme (1234567) · 2 accesses</span></span></th></tr>',
    );
    expect(html.match(/class="grp"/g)).toHaveLength(1);
  });

  it('renders row headers, mono by default', () => {
    expect(html).toContain(
      '<th scope="row"><a class="mono" href="/admin/access?repo=acme/api">acme/api</a><span class="meta">2 accesses</span></th>',
    );
    expect(html).toContain('<th scope="row"><span class="mono">acme/web</span></th>');
    expect(html).toContain('<th scope="row"><span>pipeline deploy</span></th>');
  });

  it('renders cells by tone with the status word', () => {
    expect(html).toContain(
      '<a class="mcell" href="/admin/access/a1"><span class="s"><span aria-hidden="true">✓</span>Active</span><span class="c">env production</span><span class="o">1 operation</span></a>',
    );
    expect(html).toContain(
      '<a class="mcell warn" href="/admin/access/a2"><span class="s"><span aria-hidden="true">⌛</span>Secret expires</span>',
    );
    expect(html).toContain(
      '<a class="mcell off" href="/admin/access/a9"><span class="s">Inactive</span>',
    );
    expect(html).toContain(
      '<a class="mcell bad" href="/admin/access/a10"><span class="s"><span aria-hidden="true">✕</span>Expired</span></a>',
    );
  });

  it('offers + in empty cells, linking to the prefilled form with a spoken name', () => {
    expect(html).toContain(
      '<td><a class="madd" href="/admin/access/new?repo=acme%2Fweb&amp;token=slack"><span aria-hidden="true">+</span><span class="vh">Give acme/web access to Slack</span></a></td>',
    );
    expect(html.match(/class="madd"/g)).toHaveLength(2);
  });

  it('takes a custom label for empty cells and escapes text', () => {
    const custom = render(
      <Matrix
        label="m"
        corner="<c>"
        columns={columns.slice(0, 1)}
        groups={[{ rows: [{ label: 'r', cells: {} }] }]}
        addHref={() => '/new'}
        addLabel={(row, column) => `Add ${column.name} for ${row.label}`}
      />,
    );
    expect(custom).toContain('<th scope="col">&lt;c&gt;</th>');
    expect(custom).toContain('<span class="vh">Add Slack for r</span>');
  });
});
