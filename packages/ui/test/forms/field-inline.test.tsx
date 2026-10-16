import { describe, expect, it } from 'vitest';
import { FieldInline } from '../../src';
import { render } from '../render';

describe('FieldInline', () => {
  it('renders a search form labelled by the visible title', () => {
    expect(
      render(
        <FieldInline
          id="find"
          label="Request ID"
          name="q"
          submit="Find"
          labelledBy="find-l"
          action="/admin/requests"
          placeholder="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X"
        />,
      ),
    ).toBe(
      '<form class="field-inline" role="search" method="get" action="/admin/requests" aria-labelledby="find-l"><label for="find">Request ID</label><input id="find" name="q" placeholder="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X" autocomplete="off" spellcheck="false" autocapitalize="none"/><button class="btn secondary" type="submit">Find</button></form>',
    );
  });

  it('falls back to an aria-label, keeps the value escaped and appends the class', () => {
    const html = render(
      <FieldInline
        id="f"
        label="ID"
        name="q"
        submit="Find"
        searchLabel="Find a request"
        value={'"x'}
        class="y"
        method="post"
      />,
    );
    expect(html).toMatch(
      /^<form class="field-inline y" role="search" method="post" aria-label="Find a request">/,
    );
    expect(html).toContain('value="&quot;x"');
  });
});
