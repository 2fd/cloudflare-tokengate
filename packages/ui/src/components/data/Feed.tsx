import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface FeedProps {
  /** Rail history: 24px avatars, 13px text, tighter rows (`.feed.compact`). */
  compact?: boolean;
  class?: string;
  /** `FeedItem` elements, newest first. */
  children?: Child;
}

/** Activity feed (`ol.feed`): one sentence per event, newest first. Goes in a `Panel`. */
export function Feed({ compact, class: className, children }: FeedProps) {
  return <ol class={cx('feed', compact && 'compact', className)}>{children}</ol>;
}

export interface FeedItemProps {
  /** Who did it: a decorative avatar (`.avatar`, `aria-hidden`). The sentence names the person. */
  avatar: Child;
  /** When: a `Time` (`time[datetime]`), right-aligned. */
  time: Child;
  /** Under the sentence (`.meta`): the event code, a badge, a "History" link. */
  meta?: Child;
  /** Below the meta line: a `details.disc` disclosure holding a `DiffTable` of the change. */
  details?: Child;
  class?: string;
  /** The sentence: actor, verb, object ("Maya Chen gave acme/api access"). */
  children: Child;
}

/**
 * One event of a feed (`li` > avatar + `.s` + time). Without `meta` the sentence is a single
 * line (rail history); with it, the sentence and the meta line stack (audit log).
 */
export function FeedItem(props: FeedItemProps) {
  return (
    <li class={props.class}>
      {props.avatar}
      {props.meta === undefined && props.details === undefined ? (
        <span class="s">{props.children}</span>
      ) : (
        <div class="s">
          <p>{props.children}</p>
          {props.meta !== undefined ? <p class="meta">{props.meta}</p> : null}
          {props.details}
        </div>
      )}
      {props.time}
    </li>
  );
}

export interface FeedDayProps {
  /** Heading level: 3 under a tray title (default). */
  level?: 3 | 4;
  class?: string;
  /** The day ("Today, 15 Oct"). */
  children: Child;
}

/** Day heading between feeds in one panel (`.day`): "Today, 15 Oct", "Yesterday, 14 Oct". */
export function FeedDay({ level, class: className, children }: FeedDayProps) {
  const Heading = level === 4 ? 'h4' : 'h3';
  return <Heading class={cx('day', className)}>{children}</Heading>;
}
