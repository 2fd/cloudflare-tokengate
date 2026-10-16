import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface MenuProps {
  /** Id of the popover; the opening button points at it with `popovertarget`. Unique on the page. */
  id: string;
  class?: string;
  /** `MenuItem`s and `MenuSeparator`s. */
  children: Child;
}

/**
 * Popover menu (`div.menu[popover]`): a light-dismiss list of links and POST buttons, opened by
 * a `<button popovertarget={id}>` with no JavaScript. Esc and a click outside close it, and the
 * browser wires `aria-expanded` on the button. It is a list of ordinary links and buttons (Tab
 * moves through them), not an ARIA `menu`, which would need scripted arrow keys.
 */
export function Menu({ id, class: className, children }: MenuProps) {
  return (
    <div class={cx('menu', className)} id={id} popover="auto">
      {children}
    </div>
  );
}

interface MenuItemBase {
  /** The label: the outcome ("Export configuration", "Sign out"). */
  children: Child;
  class?: string;
}

export interface MenuLinkItemProps extends MenuItemBase {
  /** A link item (`a.menu-item`). */
  href: string;
}

export interface MenuActionItemProps extends MenuItemBase {
  /** A POST item: the item is the submit button of its own `form method="post"`. */
  action: string;
  /** Name and value sent with the button. */
  name?: string;
  value?: string;
  /** Hidden inputs of the form (a CSRF token). */
  fields?: Child;
}

export type MenuItemProps = MenuLinkItemProps | MenuActionItemProps;

/** One row of a `Menu`: a link, or a submit button in its own POST form (Sign out). */
export function MenuItem(props: MenuItemProps) {
  if ('href' in props) {
    return (
      <a class={cx('menu-item', props.class)} href={props.href}>
        {props.children}
      </a>
    );
  }
  return (
    <form method="post" action={props.action}>
      {props.fields}
      <button
        class={cx('menu-item', props.class)}
        type="submit"
        name={props.name}
        value={props.value}
      >
        {props.children}
      </button>
    </form>
  );
}

/** A divider between groups of menu items (`hr`, a native separator). */
export function MenuSeparator() {
  return <hr />;
}
