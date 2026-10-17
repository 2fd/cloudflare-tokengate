import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { LogoTile, type LogoSpec } from '../base/Logo';

export interface EntityProps {
  /** The object's name. A link (`a.ent-n`) when `href` is set. */
  name: Child;
  /** Detail page of the object. */
  href?: string;
  /** Brand tile before the name, decorative. */
  logo?: LogoSpec;
  /** Tile size: `md` (32px, default) on list pages, `sm` (24px) in denser rows. */
  logoSize?: 'sm' | 'md';
  /** A custom decorative node instead of `logo`: an `Avatar` for a person. */
  logoSlot?: Child;
  /** Inline after the name on the same line: a slug, a "You" badge. */
  after?: Child;
  /** Muted second line (`.meta`): the second fact, instead of another column. */
  meta?: Child;
  /** The meta line is a path, URL or ID: mono at 12px (`.meta.mono`). */
  metaMono?: boolean;
  class?: string;
}

/**
 * Entity cell content (`.ent`): logo, name link and a muted meta line. The first column of a
 * table, inside `RowHeader`; also used for "Used by" cells.
 */
export function Entity(props: EntityProps) {
  const name = props.href ? (
    <a class="ent-n" href={props.href}>
      {props.name}
    </a>
  ) : (
    <span class="ent-n">{props.name}</span>
  );
  const text = (
    <span class="ent-t">
      {props.after !== undefined ? (
        <span>
          {name} {props.after}
        </span>
      ) : (
        name
      )}
      {props.meta !== undefined ? (
        <span class={cx('meta', props.metaMono && 'mono')}>{props.meta}</span>
      ) : null}
    </span>
  );
  return (
    <span class={cx('ent', props.class)}>
      {props.logo !== undefined ? (
        <LogoTile logo={props.logo} size={props.logoSize === 'sm' ? 'sm' : 'md'} />
      ) : (
        props.logoSlot
      )}
      {text}
    </span>
  );
}
