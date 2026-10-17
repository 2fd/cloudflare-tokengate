// Grid, Column and Stack; RowMenu and two-line menu items.
import { describe, expect, it } from 'vitest';
import { Column, Grid, MenuHeader, MenuItem, RowMenu, Stack } from '../../src';
import { render } from '../render';

describe('Grid', () => {
  it('lays columns on the 12-column grid, with a rail', () => {
    expect(
      render(
        <Grid class="g">
          <Column span={8}>main</Column>
          <Column span={4} rail as="aside" label="Activity">
            side
          </Column>
        </Grid>,
      ),
    ).toBe(
      '<div class="grid g"><div class="span-8">main</div><aside class="span-4 rail" aria-label="Activity">side</aside></div>',
    );
  });
});

describe('Stack', () => {
  it('stacks 32px apart by default, 16px with sm', () => {
    expect(render(<Stack>a</Stack>)).toBe('<div class="stack">a</div>');
    expect(
      render(
        <Stack gap="sm" class="x">
          a
        </Stack>,
      ),
    ).toBe('<div class="stack-sm x">a</div>');
  });
});

describe('RowMenu', () => {
  const html = render(
    <RowMenu name="person-actions" srSuffix="diego@acme.dev">
      <MenuHeader end="now Admin">
        Change the role of <b>diego@acme.dev</b>
      </MenuHeader>
      <MenuItem
        action="/admin/users/usr_diego"
        name="role"
        value="viewer"
        hidden={{ _csrf: 't' }}
        srPrefix="Make diego@acme.dev"
        keyFact="Reads only"
        detail="− credentials"
      >
        Viewer
      </MenuItem>
      <MenuItem dialog="dlg-owner" keyFact="Everything" detail="You confirm in a dialog.">
        Owner…
      </MenuItem>
      <MenuItem action="/s" tone="bad" srSuffix="diego@acme.dev" detail="Undo appears right after.">
        Suspend
      </MenuItem>
    </RowMenu>,
  );

  it('is an exclusive disclosure with a Change button that names the row', () => {
    expect(html).toMatch(
      /^<details class="rowmenu" name="person-actions"><summary class="btn sm secondary">Change<span class="vh"> diego@acme.dev<\/span><span class="chev" aria-hidden="true">▾<\/span><\/summary><div class="menu"><p class="menu-h"><span>Change the role of <b>diego@acme.dev<\/b><\/span><span>now Admin<\/span><\/p>/,
    );
  });

  it('renders two-line items with a key fact and a detail line', () => {
    expect(html).toContain(
      '<form method="post" action="/admin/users/usr_diego"><input type="hidden" name="_csrf" value="t"/><button class="menu-item two" type="submit" name="role" value="viewer"><b><span class="vh">Make diego@acme.dev </span>Viewer</b><span class="k">Reads only</span><span class="s">− credentials</span></button></form>',
    );
  });

  it('opens a dialog from an item, and marks a destructive item', () => {
    expect(html).toContain(
      '<button class="menu-item two" type="button" command="show-modal" commandfor="dlg-owner" popovertarget="dlg-owner"><b>Owner…</b>',
    );
    expect(html).toContain(
      '<button class="menu-item two bad" type="submit"><b>Suspend<span class="vh"> diego@acme.dev</span></b>',
    );
  });
});
