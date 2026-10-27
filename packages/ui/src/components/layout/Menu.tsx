import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Hidden, type HiddenFields } from '../../lib/hidden';
import { SrPrefix, SrSuffix } from '../../lib/sr';

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

export interface RowMenuProps {
  /**
   * Exclusive group (`details[name]`): every row menu of one table shares it, so opening one
   * closes the others.
   */
  name?: string;
  /** The button label. Default "Change". */
  label?: Child;
  /** Screen-reader suffix naming the row ("diego@acme.dev"). The space is added. */
  srSuffix?: string;
  /** Render it open (server state, or docs). */
  open?: boolean;
  class?: string;
  /** A `MenuHeader`, then `MenuItem`s (two-line ones with `detail`) and `MenuSeparator`s. */
  children: Child;
}

/**
 * Row menu (`details.rowmenu`): the "Change ▾" button of a table row and the panel of choices
 * under it, a disclosure with no JavaScript. The panel holds the same items as a `Menu`, usually
 * two-line ones that say what each choice changes. Below 48rem it opens in the flow of the row.
 */
export function RowMenu(props: RowMenuProps) {
  return (
    <details class={cx('rowmenu', props.class)} name={props.name} open={props.open}>
      <summary class="btn sm secondary">
        {props.label ?? 'Change'}
        <SrSuffix text={props.srSuffix} />
        <span class="chev" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div class="menu">{props.children}</div>
    </details>
  );
}

export interface MenuHeaderProps {
  /** Facts on the right ("now Admin"). */
  end?: Child;
  class?: string;
  /** What the menu changes ("Change the role of <b>diego@acme.dev</b>"). */
  children: Child;
}

/** Header line of a menu panel (`p.menu-h`): what the choices change, and the current value. */
export function MenuHeader(props: MenuHeaderProps) {
  return (
    <p class={cx('menu-h', props.class)}>
      <span>{props.children}</span>
      {props.end !== undefined ? <span>{props.end}</span> : null}
    </p>
  );
}

interface MenuItemBase {
  /** The label: the outcome ("Export configuration", "Viewer", "Suspend"). */
  children: Child;
  /**
   * Second line (`.s`): what the choice changes ("− credentials, export"). With it, or with
   * `keyFact`, the item is a two-line item (`.menu-item.two`).
   */
  detail?: Child;
  /** Short fact at the right of the label (`.k`): "Reads only". */
  keyFact?: Child;
  /** `bad`: a destructive choice (Suspend, Reset sign-in…), the label in the bad color. */
  tone?: 'bad';
  /** Screen-reader text before the label ("Make diego@acme.dev"). The space is added. */
  srPrefix?: string;
  /** Screen-reader text after the label ("diego@acme.dev"). The space is added. */
  srSuffix?: string;
  class?: string;
}

export interface MenuLinkItemProps extends MenuItemBase {
  /** A link item (`a.menu-item`). */
  href: string;
  action?: undefined;
  dialog?: undefined;
}

export interface MenuActionItemProps extends MenuItemBase {
  /** A POST item: the item is the submit button of its own `form method="post"`. */
  action: string;
  /** Name and value sent with the button. */
  name?: string;
  value?: string;
  /** Hidden fields of the form (`_csrf`, ids), one `input type="hidden"` each. */
  hidden?: HiddenFields;
  href?: undefined;
  dialog?: undefined;
}

export interface MenuDialogItemProps extends MenuItemBase {
  /** Opens this `Dialog` (`command="show-modal"`): a choice that needs a confirm ("Owner…"). */
  dialog: string;
  href?: undefined;
  action?: undefined;
}

export type MenuItemProps = MenuLinkItemProps | MenuActionItemProps | MenuDialogItemProps;

/**
 * One row of a `Menu` or `RowMenu`: a link, a submit button in its own POST form (Sign out, a
 * role), or a button that opens a confirm dialog.
 */
export function MenuItem(props: MenuItemProps) {
  const two = props.detail !== undefined || props.keyFact !== undefined;
  const className = cx('menu-item', two && 'two', props.tone, props.class);
  const label = (
    <>
      <SrPrefix text={props.srPrefix} />
      {props.children}
      <SrSuffix text={props.srSuffix} />
    </>
  );
  const content = two ? (
    <>
      <b>{label}</b>
      {props.keyFact !== undefined ? <span class="k">{props.keyFact}</span> : null}
      {props.detail !== undefined ? <span class="s">{props.detail}</span> : null}
    </>
  ) : (
    label
  );
  if (props.href !== undefined) {
    return (
      <a class={className} href={props.href}>
        {content}
      </a>
    );
  }
  if (props.dialog !== undefined) {
    return (
      <button
        class={className}
        type="button"
        command="show-modal"
        commandfor={props.dialog}
        popovertarget={props.dialog}
      >
        {content}
      </button>
    );
  }
  return (
    <form method="post" action={props.action}>
      <Hidden fields={props.hidden} />
      <button class={className} type="submit" name={props.name} value={props.value}>
        {content}
      </button>
    </form>
  );
}

export interface MenuChoiceOption {
  value: string;
  label: Child;
  /** The current value (`aria-pressed="true"`). Exactly one. */
  current?: boolean;
}

export interface MenuChoiceProps {
  /** What the row sets ("Theme"): the visible label and the name of the button group. */
  label: string;
  /** POST target of the row's form. */
  action: string;
  /** Field name sent with the pressed option's value. */
  name: string;
  /** 2–4 options, each a submit button. */
  options: readonly MenuChoiceOption[];
  /** Hidden fields of the form (`_csrf`, a return path), one `input type="hidden"` each. */
  hidden?: HiddenFields;
  class?: string;
}

/**
 * A menu row that sets one preference (`form.menu-choice`): the label, then a small segmented
 * control (`.seg.sm`) whose options are submit buttons of one POST form. The current option is
 * `aria-pressed="true"`.
 */
export function MenuChoice(props: MenuChoiceProps) {
  return (
    <form class={cx('menu-choice', props.class)} method="post" action={props.action}>
      <Hidden fields={props.hidden} />
      <span aria-hidden="true">{props.label}</span>
      <span class="seg sm" role="group" aria-label={props.label}>
        {props.options.map((option) => (
          <button
            type="submit"
            name={props.name}
            value={option.value}
            aria-pressed={option.current ? 'true' : 'false'}
          >
            {option.label}
          </button>
        ))}
      </span>
    </form>
  );
}

/** A divider between groups of menu items (`hr`, a native separator). */
export function MenuSeparator() {
  return <hr />;
}
