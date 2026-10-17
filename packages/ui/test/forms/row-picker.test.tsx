import { describe, expect, it } from 'vitest';
import { FieldSet, Or, RowPicker } from '../../src';
import { render } from '../render';

describe('RowPicker', () => {
  it('renders logo rows and nologo rows with a meta column', () => {
    const html = render(
      <FieldSet id="consumer" legend="Consumer">
        <RowPicker
          name="consumer"
          value="gh"
          options={[
            {
              value: 'gh',
              title: 'GitHub Actions (acme)',
              meta: 'most used · 6 accesses',
              logo: 'github',
            },
            { value: 'new', title: 'Another consumer' },
          ]}
        />
      </FieldSet>,
    );
    expect(html).toContain(
      '<div class="rlist"><label class="row-pick" data-o="1"><input type="radio" id="consumer-1" name="consumer" value="gh" checked=""/><span class="logo sm lg-github" aria-hidden="true">GH</span><span class="t">GitHub Actions (acme)</span><span class="meta">most used · 6 accesses</span></label>',
    );
    expect(html).toContain(
      '<label class="row-pick nologo" data-o="2"><input type="radio" id="consumer-2" name="consumer" value="new"/><span class="t">Another consumer</span><span></span></label></div>',
    );
  });

  it('renders a mono title with a muted detail', () => {
    expect(
      render(
        <RowPicker
          name="repo"
          options={[{ value: '89012345', title: 'acme/api', mono: true, detail: '(89012345)' }]}
        />,
      ),
    ).toContain('<span class="t mono">acme/api <span class="muted">(89012345)</span></span>');
  });

  it('renders disabled and risky rows and appends the class', () => {
    const html = render(
      <RowPicker
        name="r"
        class="x"
        options={[{ value: 'a', title: 'A', disabled: true, risk: true }]}
      />,
    );
    expect(html).toMatch(
      /^<div class="rlist x"><label class="row-pick nologo" data-o="1" data-risk="true"><input type="radio" name="r" value="a" disabled=""\/>/,
    );
  });

  it('marks the first enabled row invalid, the ErrorSummary link target', () => {
    const options = [
      { value: 'a', title: 'A', disabled: true },
      { value: 'b', title: 'B' },
    ];
    const html = render(<RowPicker id="r" name="r" options={options} invalid />);
    expect(html).toContain('<input type="radio" id="r-2" name="r" value="b" aria-invalid="true"/>');
    expect(html.match(/aria-invalid/g)).toHaveLength(1);
    expect(render(<RowPicker id="r" name="r" options={options} />)).not.toContain('aria-invalid');
  });

  it('escapes titles', () => {
    expect(
      render(<RowPicker name="r" options={[{ value: 'a', title: '<b>', meta: '<i>' }]} />),
    ).not.toMatch(/<b>|<i>/);
  });
});

describe('Or', () => {
  it('is a decorative divider', () => {
    expect(render(<Or />)).toBe('<p class="or" aria-hidden="true">OR</p>');
    expect(render(<Or label="O" class="x" />)).toBe('<p class="or x" aria-hidden="true">O</p>');
  });
});
