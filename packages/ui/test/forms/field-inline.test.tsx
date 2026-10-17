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

  it('a POST form is not a search landmark: it takes an aria-label, hidden fields and a hint', () => {
    const html = render(
      <FieldInline
        id="f"
        label="ID"
        name="q"
        submit="Find"
        formLabel="Add an organization"
        value={'"x'}
        class="y"
        method="post"
        hidden={{ _csrf: 't<k>' }}
        describedBy="f-hint"
      />,
    );
    expect(html).toMatch(
      /^<form class="field-inline y" method="post" aria-label="Add an organization"><input type="hidden" name="_csrf" value="t&lt;k&gt;"\/><label for="f">ID<\/label>/,
    );
    expect(html).toContain('aria-describedby="f-hint"');
    expect(html).not.toContain('role="search"');
    expect(html).toContain('value="&quot;x"');
  });
});
