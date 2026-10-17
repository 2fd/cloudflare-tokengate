import { describe, expect, it } from 'vitest';
import { Pipeline, type PipelineStage } from '../../src';
import { render } from '../render';

const stages: PipelineStage[] = [
  {
    label: 'Received',
    value: 8214,
    meta: 'vs previous 24 h',
    href: '/admin/requests',
    totals: [
      {
        label: 'Denied',
        count: 241,
        share: '2.9 %',
        delta: { direction: 'up', tone: 'bad', children: '41 %' },
        href: '/admin/requests?outcome=denied',
      },
      {
        label: 'Errors',
        count: 12,
        share: '0.15 %',
        href: '/admin/requests?outcome=error',
        kind: 'error',
      },
    ],
  },
  {
    label: 'Caller verified',
    value: 8032,
    meta: '97.8 % of received',
    href: '/admin/requests?stage=verified',
    drop: {
      count: 182,
      unit: 'not recognized',
      why: 'Unknown issuer: no credential access rule trusts it.',
      href: '/admin/requests?reason=issuer_unknown',
    },
  },
  {
    label: 'Access matched',
    value: 7973,
    drop: {
      count: 59,
      unit: 'no access',
      why: 'Verified callers that no issuer access rules allows.',
    },
  },
  {
    label: 'Upstream OK · allowed',
    value: 7961,
    href: '/admin/requests?outcome=allowed',
    go: 'See allowed',
    drop: {
      count: 12,
      unit: 'upstream errors',
      why: 'OpenAI answered 502 (11).',
      href: '/admin/requests?reason=upstream_5xx',
      kind: 'error',
      go: 'See errors',
    },
  },
];

describe('Pipeline', () => {
  const html = render(<Pipeline stages={stages} label="Where calls went" class="x" />);

  it('is an ordered list with the first stage in and the last out', () => {
    expect(
      html.startsWith(
        '<ol class="pipe x" aria-label="Where calls went"><li class="pipe-step"><a class="stage in" href="/admin/requests">',
      ),
    ).toBe(true);
    expect(html).toContain('<a class="stage out" href="/admin/requests?outcome=allowed">');
    expect(html.match(/<li class="pipe-step">/g)).toHaveLength(4);
  });

  it('formats numbers and appends a hidden arrow to the link line', () => {
    expect(html).toContain(
      '<span class="lbl">Received</span><span class="big">8,214</span><span class="meta">vs previous 24 h</span><span class="stage-go">See requests<span aria-hidden="true"> →</span></span></a>',
    );
    expect(html).toContain(
      '<span class="stage-go">See allowed<span aria-hidden="true"> →</span></span>',
    );
  });

  it('renders a stage without href as a div, without a link line', () => {
    expect(html).toContain(
      '<div class="stage"><span class="lbl">Access matched</span><span class="big">7,973</span></div>',
    );
  });

  it('hangs drops below their stage, linked or not, with the error tone', () => {
    expect(html).toContain(
      '<a class="drop" href="/admin/requests?reason=issuer_unknown"><span class="drop-n">182 <small>not recognized</small></span><span class="drop-why">Unknown issuer: no credential access rule trusts it.</span><span class="drop-go">See 182 requests</span></a>',
    );
    expect(html).toContain(
      '<div class="drop"><span class="drop-n">59 <small>no access</small></span><span class="drop-why">Verified callers that no issuer access rules allows.</span></div>',
    );
    expect(html).toContain('<a class="drop err" href="/admin/requests?reason=upstream_5xx">');
    expect(html).toContain('<span class="drop-go">See errors</span>');
  });

  it('shows the totals under the first stage', () => {
    expect(html).toContain(
      '<div class="pipe-tot"><a href="/admin/requests?outcome=denied"><span class="tl">Denied</span><b>241</b><span>2.9 %</span><span class="delta bad">',
    );
    expect(html).toContain(
      '<a class="err" href="/admin/requests?outcome=error"><span class="tl">Errors</span><b>12</b><span>0.15 %</span></a>',
    );
  });

  it('a single stage is in, not out; labels are escaped', () => {
    const one = render(<Pipeline stages={[{ label: '<i>', value: '1' }]} />);
    expect(one).toBe(
      '<ol class="pipe"><li class="pipe-step"><div class="stage in"><span class="lbl">&lt;i&gt;</span><span class="big">1</span></div></li></ol>',
    );
  });
});
