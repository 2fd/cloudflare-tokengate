import { describe, expect, it } from 'vitest';
import { FieldSet, firstChoiceId, RadioCards, Reveal } from '../../src';
import { render } from '../render';

const contexts = [
  {
    value: 'environment',
    title: 'Environment',
    description: 'Jobs that deploy to a GitHub environment',
    badge: <span class="badge accent">Most used</span>,
  },
  {
    value: 'branch',
    title: 'Branch',
    description: 'Pushes, manual runs and schedules on a branch',
  },
  {
    value: 'pr',
    title: 'Pull request into',
    risk: true,
    description: 'Risk: pull_request jobs run the proposed code.',
  },
  { value: 'release', title: 'Release', disabled: true, wide: true },
];

describe('RadioCards', () => {
  it('renders a card per option with the checked value', () => {
    const html = render(
      <RadioCards name="ctx" options={contexts.slice(0, 1)} value="environment" />,
    );
    expect(html).toBe(
      '<div class="rcs"><label class="rc" data-o="1"><input type="radio" name="ctx" value="environment" checked=""/><span class="rc-b"><span class="rc-t">Environment <span class="badge accent">Most used</span><span class="sel" aria-hidden="true">✓ Selected</span></span><span class="rc-d">Jobs that deploy to a GitHub environment</span></span></label></div>',
    );
  });

  it('marks risky options with data-risk, the warn class and a Risk tag', () => {
    const html = render(<RadioCards name="ctx" options={contexts} />);
    expect(html).toContain('<label class="rc risk" data-o="3" data-risk="true">');
    expect(html).toContain('<span class="risktag"><span aria-hidden="true">⚠</span>Risk</span>');
    expect(html.match(/data-risk/g)).toHaveLength(1);
  });

  it('renders disabled and wide cards', () => {
    const html = render(<RadioCards name="ctx" options={contexts} />);
    expect(html).toContain(
      '<label class="rc wide" data-o="4"><input type="radio" name="ctx" value="release" disabled=""/>',
    );
  });

  it('sets the columns and the class', () => {
    expect(render(<RadioCards name="a" options={[]} columns={1} />)).toBe(
      '<div class="rcs c1"></div>',
    );
    expect(render(<RadioCards name="a" options={[]} columns={3} class="x" />)).toBe(
      '<div class="rcs c3 x"></div>',
    );
    expect(render(<RadioCards name="a" options={[]} columns={2} />)).toBe(
      '<div class="rcs"></div>',
    );
  });

  it('takes input ids from the FieldSet, or its own id, and honours o and checked', () => {
    const inSet = render(
      <FieldSet id="ctx" legend="When">
        <RadioCards
          name="ctx"
          options={[{ value: 'a', title: 'A', o: 7, checked: true }]}
          value="b"
        />
      </FieldSet>,
    );
    expect(inSet).toContain(
      '<label class="rc" data-o="7"><input type="radio" id="ctx-7" name="ctx" value="a" checked=""/>',
    );
    expect(
      render(<RadioCards id="own" name="n" options={[{ value: 'a', title: 'A' }]} />),
    ).toContain('id="own-1"');
  });

  it('marks the first enabled radio invalid, the ErrorSummary link target', () => {
    const options = [
      { value: 'a', title: 'A', disabled: true },
      { value: 'b', title: 'B' },
      { value: 'c', title: 'C' },
    ];
    const html = render(
      <FieldSet id="g" legend="G" error="Choose one.">
        <RadioCards name="g" options={options} invalid />
      </FieldSet>,
    );
    expect(firstChoiceId('g', options)).toBe('g-2');
    expect(html).toContain('<input type="radio" id="g-2" name="g" value="b" aria-invalid="true"/>');
    expect(html.match(/aria-invalid/g)).toHaveLength(1);
    expect(render(<RadioCards name="g" id="g" options={options} />)).not.toContain('aria-invalid');
    expect(firstChoiceId('g', [{ value: 'x', o: 4 }])).toBe('g-4');
  });

  it('escapes titles and descriptions', () => {
    const html = render(
      <RadioCards name="x" options={[{ value: '"', title: '<b>', description: '<i>' }]} />,
    );
    expect(html).toContain('value="&quot;"');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('<span class="rc-d">&lt;i&gt;</span>');
  });

  it('refuses required inside a Reveal', () => {
    expect(() =>
      render(
        <Reveal field={1} option={1}>
          <RadioCards name="x" options={contexts} required />
        </Reveal>,
      ),
    ).toThrow(/RadioCards: no required/);
  });
});
