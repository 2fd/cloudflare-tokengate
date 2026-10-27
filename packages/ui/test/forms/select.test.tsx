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

  it('renders option groups mixed with options, in order, selecting inside groups', () => {
    expect(
      render(
        <Select
          id="t"
          value="token"
          options={[
            { value: 'all', label: 'All targets' },
            {
              group: 'Settings',
              options: [
                { value: 'retention', label: 'Data retention' },
                { value: 'upstreams', label: 'Upstream hosts', disabled: true },
              ],
            },
            { group: 'Credentials', options: [{ value: 'token', label: 'Credential' }] },
          ]}
        />,
      ),
    ).toBe(
      '<select class="select" id="t"><option value="all">All targets</option><optgroup label="Settings"><option value="retention">Data retention</option><option value="upstreams" disabled="">Upstream hosts</option></optgroup><optgroup label="Credentials"><option value="token" selected="">Credential</option></optgroup></select>',
    );
  });

  it('escapes group labels', () => {
    expect(render(<Select id="g" options={[{ group: '"<x>', options: [] }]} />)).toContain(
      '<optgroup label="&quot;&lt;x&gt;"></optgroup>',
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

describe('Select (rich)', () => {
  const issuers = [
    {
      value: 'github',
      label: 'GitHub Actions',
      logo: 'github' as const,
      description: 'Workflows',
      o: 1,
    },
    { value: 'vercel', label: 'Vercel', logo: 'vercel' as const, description: 'Functions', o: 2 },
    { value: 'oidc', label: 'Generic OIDC', logo: 'oidc' as const, o: 3 },
  ];

  it('is a customizable select: a button mirroring the chosen option, then the options', () => {
    const html = render(<Select id="t" name="type" options={issuers} value="vercel" />);
    expect(html).toMatch(
      /^<select class="select rich" id="t" name="type"><button type="button" tabindex="-1"><selectedcontent><\/selectedcontent><\/button><option value="github" data-o="1">/,
    );
    expect(html).toContain('<option value="vercel" selected="" data-o="2">');
  });

  it('keeps logo letters out of the option text and the description after a hidden separator', () => {
    const html = render(<Select id="t" options={issuers} />);
    // The letters are drawn by CSS (data-l): the option text reads "GitHub Actions: Workflows".
    expect(html).toContain(
      '<option value="github" data-o="1"><span class="logo sm lg-github" data-l="GH" aria-hidden="true"></span><span class="sel-b"><span class="sel-t">GitHub Actions</span><span class="sel-d"><span class="sel-sep">: </span>Workflows</span></span></option>',
    );
    expect(html).toContain('<span class="logo sm lg-vercel" data-l="▲" aria-hidden="true"></span>');
    // The OIDC tile is an icon, never text.
    expect(html).toMatch(/<span class="logo sm lg-oidc" aria-hidden="true"><svg/);
  });

  it('stays a plain select without logos or descriptions', () => {
    expect(render(<Select id="r" options={regions} />)).not.toContain('rich');
  });
});
