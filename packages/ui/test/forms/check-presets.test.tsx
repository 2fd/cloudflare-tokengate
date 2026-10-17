import { describe, expect, it } from 'vitest';
import { CheckPresets, FieldSet, SelectedCount } from '../../src';
import { render } from '../render';

const ops = [
  { value: 'post', title: 'Post messages', note: '(default)', code: 'POST /chat.postMessage' },
  {
    value: 'upload',
    title: 'Upload files',
    code: 'POST /files.getUploadURLExternal',
    tag: <span class="risktag">⚠ Risk</span>,
  },
  { value: 'list', title: 'Read channel list', disabled: true },
];

describe('CheckPresets', () => {
  it('renders one checkbox row per preset with its calls', () => {
    const html = render(<CheckPresets name="operations" options={ops} value={['post', 'list']} />);
    expect(html).toContain(
      '<label class="op" data-o="1"><input type="checkbox" name="operations" value="post" checked=""/><span><span class="t">Post messages <span class="muted">(default)</span></span><code>POST /chat.postMessage</code></span><span></span></label>',
    );
    expect(html).toContain('<span><span class="risktag">⚠ Risk</span></span></label>');
    expect(html).toContain('value="list" checked="" disabled=""/>');
    expect(html).toMatch(/^<div class="ops">/);
  });

  it('takes ids from the FieldSet or its own id and appends the class', () => {
    const html = render(
      <FieldSet id="ops" legend="Allowed operations">
        <CheckPresets name="operations" options={ops.slice(0, 1)} class="x" />
      </FieldSet>,
    );
    expect(html).toContain(
      '<div class="ops x"><label class="op" data-o="1"><input type="checkbox" id="ops-1"',
    );
    expect(render(<CheckPresets id="own" name="o" options={ops.slice(0, 1)} />)).toContain(
      'id="own-1"',
    );
  });

  it('marks the first enabled preset invalid, the ErrorSummary link target', () => {
    const options = [
      { value: 'a', title: 'A', disabled: true },
      { value: 'b', title: 'B' },
      { value: 'c', title: 'C' },
    ];
    const html = render(<CheckPresets id="g" name="g" options={options} invalid />);
    expect(html).toContain(
      '<input type="checkbox" id="g-2" name="g" value="b" aria-invalid="true"/>',
    );
    expect(html.match(/aria-invalid/g)).toHaveLength(1);
    expect(render(<CheckPresets id="g" name="g" options={options} />)).not.toContain(
      'aria-invalid',
    );
  });

  it('escapes the calls', () => {
    expect(
      render(<CheckPresets name="o" options={[{ value: 'a', title: 'A', code: '<x>' }]} />),
    ).toContain('<code>&lt;x&gt;</code>');
  });
});

describe('SelectedCount', () => {
  it('is a CSS counter line hidden from assistive tech', () => {
    expect(render(<SelectedCount total={4} />)).toBe(
      '<p class="hint" aria-hidden="true"><span class="opsn"></span> of 4 selected</p>',
    );
    expect(render(<SelectedCount total={2} class="x" />)).toMatch(/^<p class="hint x"/);
  });
});
