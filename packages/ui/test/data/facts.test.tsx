import { describe, expect, it } from 'vitest';
import { DiffTable, KeyValue, RailKeyValue, Secret } from '../../src';
import { render } from '../render';

describe('DiffTable', () => {
  it('renders field rows with del and ins under Before and After', () => {
    expect(
      render(
        <DiffTable
          caption="Changes to acme/infra → GitHub"
          rows={[{ field: 'Expires', before: '16 Oct 2026', after: '14 Nov 2026' }]}
        />,
      ),
    ).toBe(
      '<table class="diff"><caption class="vh">Changes to acme/infra → GitHub</caption>' +
        '<thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>' +
        '<tbody><tr><th scope="row">Expires</th><td><del>16 Oct 2026</del></td><td><ins>14 Nov 2026</ins></td></tr></tbody></table>',
    );
  });

  it('shows missing values as faint text, with custom labels and a class', () => {
    const html = render(
      <DiffTable
        class="x"
        caption="Changes"
        labels={{ field: 'Setting', before: 'Was', after: 'Now' }}
        emptyText="None"
        rows={[
          { field: 'Note', after: 'Rotated' },
          { field: 'Branch', before: 'main', after: '' },
        ]}
      />,
    );
    expect(html).toContain(
      '<table class="diff x"><caption class="vh">Changes</caption><thead><tr><th scope="col">Setting</th><th scope="col">Was</th><th scope="col">Now</th>',
    );
    expect(html).toContain(
      '<th scope="row">Note</th><td><span class="faint">None</span></td><td><ins>Rotated</ins></td>',
    );
    expect(html).toContain('<td><del>main</del></td><td><span class="faint">None</span></td>');
  });

  it('escapes values', () => {
    expect(render(<DiffTable caption="c" rows={[{ field: 'x', before: '<i>' }]} />)).toContain(
      '<del>&lt;i&gt;</del>',
    );
  });
});

describe('KeyValue', () => {
  it('renders dt/dd pairs with mono, copyable and line values', () => {
    expect(
      render(
        <KeyValue
          class="x"
          items={[
            { label: 'Upstream', value: 'https://slack.com/api', mono: true },
            {
              label: 'Proxy URL',
              value: 'https://gate.acme.dev/proxy/slack',
              mono: true,
              copyable: true,
            },
            { label: 'Allowed hosts', value: 'chips', line: true },
            { label: 'Plain', value: 'v' },
          ]}
        />,
      ),
    ).toBe(
      '<dl class="kv x">' +
        '<div><dt>Upstream</dt><dd class="mono">https://slack.com/api</dd></div>' +
        '<div><dt>Proxy URL</dt><dd class="mono copyable">https://gate.acme.dev/proxy/slack</dd></div>' +
        '<div><dt>Allowed hosts</dt><dd><div class="line">chips</div></dd></div>' +
        '<div><dt>Plain</dt><dd>v</dd></div></dl>',
    );
  });
});

describe('RailKeyValue', () => {
  it('renders label over value with a note line', () => {
    expect(
      render(
        <RailKeyValue
          items={[
            {
              label: 'Credential ID',
              value: 'svc_01JB8Z5K2Q7W3N4M6P8R9T7Q2M',
              mono: true,
              copyable: true,
            },
            { label: 'Created', value: '3 Oct 2026', note: 'by Priya Natarajan' },
          ]}
        />,
      ),
    ).toBe(
      '<dl class="rkv">' +
        '<div><dt>Credential ID</dt><dd class="mono copyable">svc_01JB8Z5K2Q7W3N4M6P8R9T7Q2M</dd></div>' +
        '<div><dt>Created</dt><dd>3 Oct 2026<small>by Priya Natarajan</small></dd></div></dl>',
    );
  });

  it('passes the class and escapes', () => {
    expect(render(<RailKeyValue class="x" items={[{ label: 'a', value: '<b>' }]} />)).toBe(
      '<dl class="rkv x"><div><dt>a</dt><dd>&lt;b&gt;</dd></div></dl>',
    );
  });
});

describe('Secret', () => {
  it('masks the value and reads "Secret ending in 9fQa"', () => {
    expect(
      render(
        <Secret
          last4="9fQa"
          facts="Bot token · 51 characters"
          meta="Set 3 Oct 2026 by Priya Natarajan"
          actions={
            <button class="btn secondary" type="button">
              Replace secret
            </button>
          }
        />,
      ),
    ).toBe(
      '<div class="secret"><span class="mask lg"><span aria-hidden="true">••••\u00a0</span><span class="vh">Secret ending in </span>9fQa</span>' +
        '<span class="facts"><span>Bot token · 51 characters</span><span class="meta">Set 3 Oct 2026 by Priya Natarajan</span></span>' +
        '<span class="acts"><button class="btn secondary" type="button">Replace secret</button></span></div>',
    );
  });

  it('renders the mask alone, with a custom label and a class', () => {
    expect(render(<Secret last4="<x>" srPrefix="Key ending in" class="x" />)).toBe(
      '<div class="secret x"><span class="mask lg"><span aria-hidden="true">••••\u00a0</span><span class="vh">Key ending in </span>&lt;x&gt;</span></div>',
    );
  });

  it('never renders more than the last 4 characters, whatever is passed', () => {
    const html = render(<Secret last4="xoxb-1234567890-secret-9fQa" />);
    expect(html).toMatch(/<\/span>9fQa<\/span><\/div>$/);
    expect(html).not.toContain('xoxb');
    expect(html).not.toContain('secret-');
  });

  it('says the last characters are not stored when last4 is missing', () => {
    const html = render(<Secret />);
    expect(html).toContain('<span class="vh">Secret, last characters not stored</span>');
    expect(html).not.toContain('ending in');
  });
});
