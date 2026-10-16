import { describe, expect, it } from 'vitest';
import { Picks, Reveal } from '../../src';
import { render } from '../render';

describe('Picks', () => {
  it('renders mono labels with meta, plain labels and the checked value', () => {
    expect(
      render(
        <Picks
          name="env"
          value="production"
          options={[
            { value: 'production', label: 'production', mono: true, meta: 'most used' },
            { value: 'other', label: 'Other' },
          ]}
        />,
      ),
    ).toBe(
      '<div class="picks"><label class="pick" data-o="1"><input type="radio" name="env" value="production" checked=""/><span class="mono">production</span><span class="meta">most used</span></label><label class="pick" data-o="2"><input type="radio" name="env" value="other"/>Other</label></div>',
    );
  });

  it('renders disabled picks, own ids and the class', () => {
    expect(
      render(
        <Picks
          id="exp"
          name="exp"
          class="x"
          options={[{ value: 'never', label: 'Never', disabled: true }]}
        />,
      ),
    ).toBe(
      '<div class="picks x"><label class="pick" data-o="1"><input type="radio" id="exp-1" name="exp" value="never" disabled=""/>Never</label></div>',
    );
  });

  it('escapes labels and refuses required inside a Reveal', () => {
    expect(render(<Picks name="p" options={[{ value: 'a', label: '<b>' }]} />)).toContain(
      '&lt;b&gt;',
    );
    expect(() =>
      render(
        <Reveal field={3} option={1}>
          <Picks name="p" required options={[]} />
        </Reveal>,
      ),
    ).toThrow(/Picks: no required/);
  });
});
