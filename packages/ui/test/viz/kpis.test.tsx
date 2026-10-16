import { describe, expect, it } from 'vitest';
import { Delta, Kpis } from '../../src';
import { render } from '../render';

describe('Delta', () => {
  it('reads the direction as a word and hides the glyph', () => {
    expect(render(<Delta direction="up">6 %</Delta>)).toBe(
      '<span class="delta"><span aria-hidden="true">▲ </span><span class="vh">up </span>6 %</span>',
    );
    expect(
      render(
        <Delta direction="down" tone="bad" class="x">
          3 %
        </Delta>,
      ),
    ).toBe(
      '<span class="delta bad x"><span aria-hidden="true">▼ </span><span class="vh">down </span>3 %</span>',
    );
  });

  it('has a no-change form and the warn tone', () => {
    expect(
      render(
        <Delta direction="none" tone="warn">
          0 %
        </Delta>,
      ),
    ).toBe('<span class="delta warn"><span class="vh">no change, </span>0 %</span>');
  });
});

describe('Kpis', () => {
  const html = render(
    <Kpis
      class="extra"
      items={[
        {
          label: 'Requests',
          value: 8214,
          delta: { direction: 'up', children: '6 %' },
          meta: 'vs previous 24 h',
          link: { href: '/admin/requests', label: 'See requests →' },
        },
        {
          label: 'Denied',
          swatch: 'denied',
          value: 241,
          unit: '2.9 %',
          delta: { direction: 'up', tone: 'warn', children: '41 %' },
          meta: 'vs previous 24 h',
          link: { href: '/admin/requests?outcome=denied', label: 'See denied →' },
          worst: true,
        },
        {
          label: 'Errors',
          swatch: 'error',
          value: 12,
          unit: '0.15 %',
          meta: 'OpenAI 11 · Anthropic 1',
          worst: true,
        },
        { label: 'Latency', value: '212', unit: 'ms p95', extra: <span class="spark">x</span> },
      ]}
    />,
  );

  it('renders a definition list of tiles', () => {
    expect(
      html.startsWith(
        '<dl class="kpis extra"><div class="kpi"><dt>Requests</dt><dd class="kpi-n">8,214</dd>',
      ),
    ).toBe(true);
    expect(html).toContain(
      '<dd class="kpi-m"><span class="delta"><span aria-hidden="true">▲ </span><span class="vh">up </span>6 %</span>vs previous 24 h</dd><dd class="kpi-l"><a href="/admin/requests">See requests →</a></dd>',
    );
  });

  it('tones only the first worst tile', () => {
    expect(html.match(/kpi tone-warn/g)).toHaveLength(1);
    expect(html).toContain(
      '<div class="kpi tone-warn"><dt><i class="sw denied" aria-hidden="true"></i>Denied</dt><dd class="kpi-n">241<small>2.9 %</small></dd>',
    );
  });

  it('leaves out empty lines and keeps strings as given', () => {
    expect(html).toContain(
      '<dd class="kpi-n">212<small>ms p95</small></dd><dd><span class="spark">x</span></dd></div>',
    );
    expect(html).not.toContain('<dd class="kpi-m"></dd>');
  });
});
