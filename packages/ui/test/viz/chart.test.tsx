import { describe, expect, it } from 'vitest';
import { Chart, ChartPatterns, Legend, ReasonBar, type ChartBar } from '../../src';
import { niceStep } from '../../src/components/viz/Chart';
import { render } from '../render';

const hours = (n: number): ChartBar[] =>
  Array.from({ length: n }, (_, i) => ({
    label: `${String(i).padStart(2, '0')}:00`,
    range: `${String(i).padStart(2, '0')}:00–${String(i + 1).padStart(2, '0')}:00`,
    allowed: 100 + i * 20,
    denied: i === 12 ? 48 : 2,
    errors: i === 5 ? 2 : 0,
    partial: i === n - 1,
  }));

describe('Chart', () => {
  const html = render(
    <Chart
      id="ov-c"
      title="Requests per hour, last 24 hours"
      description="8,214 requests: 7,961 allowed, 241 denied, 12 errors."
      bars={hours(24)}
    />,
  );

  it('is an image named by its title and description', () => {
    expect(html).toContain(
      '<svg class="chart" viewBox="0 0 960 300" role="img" aria-labelledby="ov-c-t ov-c-d" focusable="false"><title id="ov-c-t">Requests per hour, last 24 hours</title><desc id="ov-c-d">8,214 requests: 7,961 allowed, 241 denied, 12 errors.</desc>',
    );
  });

  it('draws 24 bars of width 24 in 37.8 slots, stacked allowed, error, denied', () => {
    expect(html.match(/<g class="bar/g)).toHaveLength(24);
    expect(html).toContain('<rect class="b-allowed" x="50.9" ');
    expect(html.match(/width="24"/g)?.length).toBeGreaterThanOrEqual(24);
    const bar5 = html.match(/<g class="bar"><title>05:00–06:00[^]*?<\/g>/)?.[0] ?? '';
    expect(bar5.indexOf('b-allowed')).toBeLessThan(bar5.indexOf('b-error'));
    expect(bar5.indexOf('b-error')).toBeLessThan(bar5.indexOf('b-denied'));
    // a count of 2 errors stays visible: at least 2.5 units tall
    expect(bar5).toMatch(/class="b-error" x="[\d.]+" y="[\d.]+" width="24" height="2.5"/);
  });

  it('gives every bar a tooltip with the numbers and marks the running period', () => {
    expect(html).toContain(
      '<title>00:00–01:00: 102 requests, 100 allowed, 2 denied, 0 errors</title>',
    );
    expect(html).toContain('<g class="bar so-far"><title>23:00–24:00 (so far):');
    expect(html).toContain(
      '<title>05:00–06:00: 204 requests, 200 allowed, 2 denied, 2 errors</title>',
    );
  });

  it('labels every third hour, the end and a nice y grid', () => {
    expect(html.match(/text-anchor="middle"/g)).toHaveLength(8);
    expect(html).toContain('text-anchor="end">now</text>');
    expect(html).toContain('<line class="gridl" x1="44" x2="952" y1="268" y2="268"></line>');
    expect(html).toContain('text-anchor="end">200</text>');
  });

  it('has the numbers table in a disclosure, as a focusable named region with a caption', () => {
    expect(html).toContain('<details class="numbers"><summary>Show the numbers</summary>');
    expect(html).toContain(
      '<div class="scroll" role="region" aria-label="Requests per hour, last 24 hours, numbers" tabindex="0"><table class="tbl dense"><caption class="vh">Requests per hour, last 24 hours, numbers</caption><thead>',
    );
    expect(html).toContain('<th scope="col">Hour (UTC)</th>');
    expect(html).toContain('<tr><th scope="row">00:00</th><td class="num">102</td>');
    expect(html).toContain('<th scope="row">23:00<span class="meta"> (so far)</span></th>');
  });

  it('takes the axis options, caps wide bars and escapes text', () => {
    const week = render(
      <Chart
        id="w"
        title="<x>"
        description="d"
        bars={hours(7)}
        tickEvery={1}
        endLabel=""
        columnLabel="Day"
        numbersLabel="Numbers"
        class="extra"
      />,
    );
    expect(week).toContain('<div class="panel pad chart-panel extra">');
    expect(week).toContain('width="48"');
    expect(week.match(/text-anchor="middle"/g)).toHaveLength(7);
    expect(week).not.toContain('>now<');
    expect(week).toContain('<th scope="col">Day</th>');
    expect(week).toContain('<summary>Numbers</summary>');
    expect(week).toContain('&lt;x&gt;');
  });

  it('niceStep picks 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(213)).toBe(200);
    expect(niceStep(60)).toBe(50);
    expect(niceStep(1.4)).toBe(1);
    expect(niceStep(0)).toBe(1);
  });
});

describe('ChartPatterns', () => {
  it('defines #hatch and #dots once, hidden', () => {
    const html = render(<ChartPatterns />);
    expect(html).toMatch(/^<svg class="vh" aria-hidden="true" focusable="false"><defs>/);
    expect(html).toContain('<pattern id="hatch"');
    expect(html).toContain('<pattern id="dots"');
    expect(html).toContain('patternTransform="rotate(45)"');
  });
});

describe('ReasonBar', () => {
  const reasons = [
    {
      count: 182,
      label: 'Unknown issuer: no credential access rule trusts it',
      short: 'unknown issuer',
      meta: '1 caller',
    },
    {
      count: 59,
      label: 'No issuer access rules allows this call',
      short: 'no access',
      meta: '2 callers',
    },
  ];

  it('splits the bar with 2px gaps and names it', () => {
    const html = render(<ReasonBar title="Denied by reason" reasons={reasons} />);
    expect(html).toContain(
      '<h3 class="sm"><b>Denied by reason</b> <span class="muted">241 in 2 reasons</span></h3>',
    );
    expect(html).toContain(
      '<svg class="rbar" viewBox="0 0 1000 12" preserveAspectRatio="none" role="img" aria-label="Denied by reason: 182 unknown issuer, 59 no access" focusable="false"><rect class="r-bad" x="0" width="753" height="12"></rect><rect class="r-hatch" x="755" width="245" height="12"></rect></svg>',
    );
    expect(html).toContain(
      '<li><span class="sw bad" aria-hidden="true"></span><span class="n">182</span><span>Unknown issuer: no credential access rule trusts it<span class="meta"> · 1 caller</span></span><span class="pct">75.5\u00a0%</span></li>',
    );
    expect(html).toContain('<span class="sw denied" aria-hidden="true"></span>');
  });

  it('takes explicit kinds, hides the heading and passes the class', () => {
    const html = render(
      <ReasonBar
        title="Errors"
        heading={false}
        class="x"
        reasons={[{ count: 12, label: 'Upstream 502', short: 'upstream 502', kind: 'error' }]}
      />,
    );
    expect(html).not.toContain('<h3');
    expect(html).toContain('<svg class="rbar x"');
    expect(html).toContain('<rect class="r-err" x="0" width="1000" height="12">');
    expect(html).toContain('<span class="pct">100\u00a0%</span>');
  });

  it('draws nothing in the bar when every count is zero', () => {
    const html = render(
      <ReasonBar title="Denied" reasons={[{ count: 0, label: 'None', short: 'none' }]} />,
    );
    expect(html).not.toContain('<rect');
    expect(html).toContain('<span class="pct">0\u00a0%</span>');
  });
});

describe('Legend', () => {
  it('renders swatches, wires and cells with hidden marks', () => {
    const html = render(
      <Legend
        items={[
          { mark: 'denied', label: 'Denied' },
          { mark: 'wire-off', label: 'Inactive' },
          { mark: 'wire', label: 'Active' },
          { mark: 'cell-bad', label: 'Expired' },
          { mark: 'cell', label: 'Active' },
        ]}
      />,
    );
    expect(html).toBe(
      '<span class="legend"><span><i class="sw denied" aria-hidden="true"></i>Denied</span><span><svg width="20" height="8" aria-hidden="true" focusable="false"><line x1="0" y1="4" x2="20" y2="4" class="wire off"></line></svg>Inactive</span><span><svg width="20" height="8" aria-hidden="true" focusable="false"><line x1="0" y1="4" x2="20" y2="4" class="wire"></line></svg>Active</span><span><i class="lg-sw bad" aria-hidden="true"></i>Expired</span><span><i class="lg-sw" aria-hidden="true"></i>Active</span></span>',
    );
  });

  it('can be decorative, a paragraph and take a class', () => {
    expect(
      render(
        <Legend as="p" decorative class="end" items={[{ mark: 'allowed', label: 'Allowed' }]} />,
      ),
    ).toBe(
      '<p class="legend end" aria-hidden="true"><span><i class="sw allowed" aria-hidden="true"></i>Allowed</span></p>',
    );
  });
});
