import { describe, expect, it } from 'vitest';
import { Pager } from '../../src';
import { render } from '../render';

describe('Pager', () => {
  it('is a navigation landmark with the summary and both links', () => {
    expect(render(<Pager summary="Showing 26–50 of 80" newer="?page=1" older="?page=3" />)).toBe(
      '<nav class="pager" aria-label="Pages"><span>Showing 26–50 of 80</span><span class="end">' +
        '<a href="?page=1" rel="prev">Newer</a><a href="?page=3" rel="next">Older</a></span></nav>',
    );
  });

  it('shows a missing end as faint text, never a dead link', () => {
    const html = render(<Pager summary="Showing 1–25 of 8,214" older="?before=req_1" />);
    expect(html).toContain(
      '<span class="faint">Newer</span><a href="?before=req_1" rel="next">Older</a>',
    );
    const only = render(<Pager summary="Showing 1–3 of 3" />);
    expect(only).toContain('<span class="faint">Newer</span><span class="faint">Older</span>');
    expect(only).not.toContain('<a');
  });

  it('renders buttons with decorative arrows, custom labels and a class', () => {
    const html = render(
      <Pager
        summary="s"
        buttons
        newer="?after=e1"
        older="?before=e9"
        newerLabel="Newer events"
        olderLabel="Older events"
        label="Audit pages"
        class="x"
      />,
    );
    expect(html).toContain('<nav class="pager x" aria-label="Audit pages">');
    expect(html).toContain(
      '<a class="btn sm secondary" href="?after=e1" rel="prev"><span aria-hidden="true">← </span>Newer events</a>',
    );
    expect(html).toContain(
      '<a class="btn sm secondary" href="?before=e9" rel="next">Older events<span aria-hidden="true"> →</span></a>',
    );
  });

  it('links the newest page first, only when set, without rel', () => {
    expect(
      render(<Pager summary="s" newest="/admin/requests" newer="?after=r1" older="?before=r9" />),
    ).toContain(
      '<span class="end"><a href="/admin/requests">Newest</a><a href="?after=r1" rel="prev">Newer</a>',
    );
    const buttons = render(
      <Pager summary="s" buttons newest="/admin/audit" newestLabel="Newest entries" newer="?a=1" />,
    );
    expect(buttons).toContain(
      '<span class="end"><a class="btn sm secondary" href="/admin/audit">Newest entries</a><a class="btn sm secondary" href="?a=1" rel="prev">',
    );
    // no faint placeholder when there is no newest link
    expect(render(<Pager summary="s" older="?b=1" />)).not.toContain('Newest');
  });

  it('escapes the cursor in the href', () => {
    expect(render(<Pager summary="s" older={'?before="x"&a=1'} />)).toContain(
      'href="?before=&quot;x&quot;&amp;a=1"',
    );
  });
});
