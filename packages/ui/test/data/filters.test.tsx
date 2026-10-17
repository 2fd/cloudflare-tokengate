import { describe, expect, it } from 'vitest';
import { ActiveFilters, AddFilter, FilterSearch, Filters, QuickLinks } from '../../src';
import { render } from '../render';

describe('Filters', () => {
  it('is a labelled GET search form that keeps applied filters and can submit', () => {
    const html = render(
      <Filters
        label="Filter requests"
        action="/admin/requests"
        hidden={{ token: 'slack' }}
        submitLabel="Apply"
      >
        x
      </Filters>,
    );
    expect(html).toBe(
      '<form class="filters" role="search" method="get" action="/admin/requests" aria-label="Filter requests">' +
        '<input type="hidden" name="token" value="slack"/>x' +
        '<button class="btn secondary" type="submit">Apply</button></form>',
    );
  });

  it('renders a labelled group of menus at the end of the tray header', () => {
    expect(
      render(
        <Filters as="group" end label="Filter audit events" class="x">
          m
        </Filters>,
      ),
    ).toBe('<div class="filters end x" role="group" aria-label="Filter audit events">m</div>');
  });

  it('escapes hidden values', () => {
    const html = render(<Filters label="f" hidden={{ q: '"><script>' }} />);
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;"');
  });
});

describe('FilterSearch', () => {
  it('labels the input and wires the suggestion list', () => {
    const html = render(
      <FilterSearch
        id="rq-q"
        label="Search requests"
        value="acme/api"
        placeholder="Path, repository or request ID"
        suggestions={['acme/api', 'acme/web']}
      />,
    );
    expect(html).toContain(
      '<label class="search" for="rq-q"><span class="vh">Search requests</span>',
    );
    expect(html).toContain('<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">');
    expect(html).toContain(
      '<input class="input" id="rq-q" type="search" name="q" value="acme/api" placeholder="Path, repository or request ID" list="rq-q-list" autocomplete="off" spellcheck="false" autocapitalize="none"/>',
    );
    expect(html).toContain(
      '<datalist id="rq-q-list"><option value="acme/api"></option><option value="acme/web"></option></datalist>',
    );
  });

  it('has no list without suggestions and passes the class', () => {
    const html = render(<FilterSearch id="s" label="Find a token" name="token" class="x" />);
    expect(html).toContain('<label class="search x" for="s">');
    expect(html).toContain('name="token"');
    expect(html).not.toContain('list=');
    expect(html).not.toContain('datalist');
  });

  it('puts the validation attributes on the input', () => {
    const html = render(
      <FilterSearch
        id="rq-repo"
        label="Filter by repository"
        name="repo"
        value="acme/"
        pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
        maxlength={256}
        invalid
        describedBy="rq-repo-error"
      />,
    );
    expect(html).toContain(
      '<input class="input" id="rq-repo" type="search" name="repo" value="acme/" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" maxlength="256" aria-invalid="true" aria-describedby="rq-repo-error" autocomplete="off"',
    );
    // no error line of its own: the page renders the FieldError
    expect(html).not.toContain('field-error');
  });

  it('leaves the validation attributes out by default', () => {
    const html = render(<FilterSearch id="s" label="Search" invalid={false} />);
    expect(html).not.toMatch(/pattern=|maxlength=|aria-invalid|aria-describedby/);
  });
});

describe('AddFilter', () => {
  const html = render(
    <AddFilter
      label="Credential"
      srSuffix="requests"
      open
      options={[
        {
          href: '?token=slack',
          label: 'Slack',
          logo: 'slack',
          slug: 'slack',
          count: '2,140',
        },
      ]}
      extra={[{ href: '?token=none', label: 'Refused before a token was chosen', count: 182 }]}
    />,
  );

  it('is a disclosure whose summary reads "Filter by Credential"', () => {
    expect(html).toContain(
      '<details class="fadd" open=""><summary><span aria-hidden="true">+</span><span class="vh">Filter by </span>Credential</summary>',
    );
  });

  it('renders one link per value with logo, slug and count', () => {
    expect(html).toContain(
      '<a href="?token=slack"><span class="logo xs lg-slack" aria-hidden="true">S</span>Slack <span class="slug">slack</span><span class="n">2,140<span class="vh"> requests</span></span></a>',
    );
  });

  it('puts the extra values after a divider', () => {
    expect(html).toContain(
      '<hr/><a href="?token=none">Refused before a token was chosen<span class="n">182',
    );
  });

  it('is closed by default, without a divider when there are no extras', () => {
    const closed = render(
      <AddFilter
        label="Credential access rule"
        options={[{ href: '?c=1', label: 'GitHub Actions (acme)' }]}
        class="x"
      />,
    );
    expect(closed).toContain('<details class="fadd x"><summary>');
    expect(closed).not.toContain('<hr');
    expect(closed).toContain('<a href="?c=1">GitHub Actions (acme)</a>');
    expect(closed).not.toContain('id=');
    expect(closed).not.toContain('role="group"');
  });

  it('takes an id on the details, the target of an error summary link', () => {
    expect(
      render(
        <AddFilter id="f-reason" open label="Reason" options={[{ href: '?r=1', label: 'x' }]} />,
      ),
    ).toContain('<details class="fadd" id="f-reason" open=""><summary>');
  });

  it('renders titled option groups, mixed with plain values in order', () => {
    const grouped = render(
      <AddFilter
        label="Reason"
        srSuffix="requests"
        options={[
          { href: '?reason=any', label: 'Any denial' },
          {
            group: 'Caller',
            options: [
              { href: '?reason=issuer_unknown', label: 'Unknown issuer', count: 182 },
              { href: '?reason=no_matching_grant', label: 'No issuer access rules' },
            ],
          },
          {
            group: 'Upstream',
            options: [{ href: '?reason=upstream_5xx', label: 'Upstream error' }],
          },
        ]}
      />,
    );
    expect(grouped).toContain(
      '<div class="fpop"><a href="?reason=any">Any denial</a>' +
        '<div role="group" aria-label="Caller"><p class="fpop-h" aria-hidden="true">Caller</p>' +
        '<a href="?reason=issuer_unknown">Unknown issuer<span class="n">182<span class="vh"> requests</span></span></a>' +
        '<a href="?reason=no_matching_grant">No issuer access rules</a></div>' +
        '<div role="group" aria-label="Upstream"><p class="fpop-h" aria-hidden="true">Upstream</p>' +
        '<a href="?reason=upstream_5xx">Upstream error</a></div></div>',
    );
  });

  it('escapes the group title', () => {
    const html = render(
      <AddFilter label="R" options={[{ group: '<b>"x"', options: [{ href: '?', label: 'y' }] }]} />,
    );
    expect(html).toContain('aria-label="&lt;b&gt;&quot;x&quot;"');
    expect(html).toContain('<p class="fpop-h" aria-hidden="true">&lt;b&gt;&quot;x&quot;</p>');
  });
});

describe('ActiveFilters', () => {
  it('renders remove links with screen reader text and Clear all', () => {
    const html = render(
      <ActiveFilters
        lead="Active filters"
        filters={[{ label: 'Credential: Slack', href: '?outcome=denied' }]}
        clearHref="/admin/requests"
      />,
    );
    expect(html).toBe(
      '<div class="achips" role="group" aria-label="Active filters"><span class="hint">Active filters</span>' +
        '<a class="achip" href="?outcome=denied"><span class="vh">Remove filter </span>Credential: Slack<span class="x" aria-hidden="true">✕</span></a>' +
        '<a class="sm" href="/admin/requests">Clear all</a></div>',
    );
  });

  it('renders nothing without filters', () => {
    expect(render(<ActiveFilters filters={[]} clearHref="/x" />)).toBe('');
  });

  it('takes a group label, a clear label and a class', () => {
    const html = render(
      <ActiveFilters
        label="Filters on the map"
        class="x"
        clearLabel="Show all"
        clearHref="/a"
        filters={[{ label: '<b>', href: '/b' }]}
      />,
    );
    expect(html).toContain('<div class="achips x" role="group" aria-label="Filters on the map">');
    expect(html).toContain('>Show all</a>');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('QuickLinks', () => {
  it('marks the current link and hides glyphs', () => {
    const html = render(
      <QuickLinks
        label="Outcome"
        lead="Needs attention"
        links={[
          { href: '?', label: 'All', count: '8,214', current: true },
          { href: '?outcome=denied', label: 'Denied', count: 241, tone: 'bad', glyph: '✕' },
        ]}
      />,
    );
    expect(html).toBe(
      '<nav class="qlinks" aria-label="Outcome"><span class="meta">Needs attention</span>' +
        '<a class="ql" href="?" aria-current="true">All <span class="n">8,214</span></a>' +
        '<a class="ql bad" href="?outcome=denied"><span class="g" aria-hidden="true">✕</span>Denied <span class="n">241</span></a></nav>',
    );
  });

  it('renders a link without a count and passes the class', () => {
    expect(
      render(
        <QuickLinks
          label="Focus"
          class="x"
          links={[{ href: '/a', label: 'All credential access rules', tone: 'warn' }]}
        />,
      ),
    ).toBe(
      '<nav class="qlinks x" aria-label="Focus"><a class="ql warn" href="/a">All credential access rules</a></nav>',
    );
  });
});
