import { describe, expect, it } from 'vitest';
import { Reveal, Select } from '../../src';
import { render } from '../render';

const regions = [
  { value: 'us-east-1', label: 'us-east-1' },
  { value: 'eu-west-1', label: 'eu-west-1' },
  { value: 'ap-south-1', label: 'ap-south-1', disabled: true },
];

describe('Select', () => {
  it('selects the value and disables options', () => {
    expect(render(<Select id="r" name="region" options={regions} value="eu-west-1" />)).toBe(
      '<select class="select" id="r" name="region"><option value="us-east-1">us-east-1</option><option value="eu-west-1" selected="">eu-west-1</option><option value="ap-south-1" disabled="">ap-south-1</option></select>',
    );
  });

  it('shows the placeholder selected until there is a value', () => {
    expect(render(<Select id="a" options={regions} placeholder="Choose a region" />)).toContain(
      '<option value="" selected="">Choose a region</option>',
    );
    expect(
      render(<Select id="b" options={regions} placeholder="Choose a region" value="us-east-1" />),
    ).toContain('<option value="" disabled="">Choose a region</option>');
  });

  it('renders invalid, required and the class', () => {
    expect(
      render(<Select id="c" options={regions} invalid required describedBy="c-error" class="x" />),
    ).toMatch(
      /^<select class="select x" id="c" required="" aria-invalid="true" aria-describedby="c-error">/,
    );
  });

  it('escapes option labels', () => {
    expect(render(<Select id="d" options={[{ value: '"', label: '<b>' }]} />)).toContain(
      '<option value="&quot;">&lt;b&gt;</option>',
    );
  });

  it('refuses required inside a Reveal', () => {
    expect(() =>
      render(
        <Reveal field={1} option={2}>
          <Select id="e" options={regions} required />
        </Reveal>,
      ),
    ).toThrow(/Select: no required/);
  });
});
