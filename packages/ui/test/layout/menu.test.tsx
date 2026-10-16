import { describe, expect, it } from 'vitest';
import { Menu, MenuItem, MenuSeparator } from '../../src';
import { render } from '../render';

describe('Menu', () => {
  it('is an auto popover with the given id and classes', () => {
    expect(
      render(
        <Menu id="m" class="x">
          items
        </Menu>,
      ),
    ).toBe('<div class="menu x" id="m" popover="auto">items</div>');
  });

  it('holds links, a separator and a POST item', () => {
    const html = render(
      <Menu id="m">
        <MenuItem href="/admin/export">Export configuration</MenuItem>
        <MenuSeparator />
        <MenuItem action="/admin/logout">Sign out</MenuItem>
      </Menu>,
    );
    expect(html).toContain(
      '<a class="menu-item" href="/admin/export">Export configuration</a><hr/>',
    );
    expect(html).toContain(
      '<form method="post" action="/admin/logout"><button class="menu-item" type="submit">Sign out</button></form>',
    );
  });
});

describe('MenuItem', () => {
  it('sends name, value and hidden fields with a POST item', () => {
    const html = render(
      <MenuItem
        action="/admin/users/usr_1/role"
        name="role"
        value="viewer"
        class="y"
        fields={<input type="hidden" name="csrf" value="t" />}
      >
        Viewer
      </MenuItem>,
    );
    expect(html).toBe(
      '<form method="post" action="/admin/users/usr_1/role"><input type="hidden" name="csrf" value="t"/><button class="menu-item y" type="submit" name="role" value="viewer">Viewer</button></form>',
    );
  });

  it('escapes labels and urls', () => {
    expect(render(<MenuItem href={'/a?x="1"'}>{'<b>'}</MenuItem>)).toBe(
      '<a class="menu-item" href="/a?x=&quot;1&quot;">&lt;b&gt;</a>',
    );
  });
});
