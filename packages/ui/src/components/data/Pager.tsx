import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface PagerProps {
  /** What is shown: "Showing 1–25 of 8,214 · times in UTC". */
  summary: Child;
  /** Link to the newer page; without it "Newer" shows as faint text (there is nothing newer). */
  newer?: string;
  /** Link to the older page; without it "Older" shows as faint text. */
  older?: string;
  newerLabel?: string;
  olderLabel?: string;
  /** Render the links as small secondary buttons with an arrow (long logs: Requests, Audit log). */
  buttons?: boolean;
  /** Accessible name of the navigation landmark. Unique on the page. */
  label?: string;
  class?: string;
}

function PagerLink(props: {
  href: string | undefined;
  label: string;
  rel: 'prev' | 'next';
  buttons: boolean | undefined;
}) {
  if (!props.href) return <span class="faint">{props.label}</span>;
  if (!props.buttons) {
    return (
      <a href={props.href} rel={props.rel}>
        {props.label}
      </a>
    );
  }
  return (
    <a class="btn sm secondary" href={props.href} rel={props.rel}>
      {props.rel === 'prev' ? <span aria-hidden="true">← </span> : null}
      {props.label}
      {props.rel === 'next' ? <span aria-hidden="true"> →</span> : null}
    </a>
  );
}

/**
 * Pager under a table (`nav.pager`): what is shown, then Newer and Older. Cursor links (GET),
 * newest first; an end that does not exist is plain faint text, never a dead link.
 */
export function Pager(props: PagerProps) {
  return (
    <nav class={cx('pager', props.class)} aria-label={props.label ?? 'Pages'}>
      <span>{props.summary}</span>
      <span class="end">
        <PagerLink
          href={props.newer}
          label={props.newerLabel ?? 'Newer'}
          rel="prev"
          buttons={props.buttons}
        />
        <PagerLink
          href={props.older}
          label={props.olderLabel ?? 'Older'}
          rel="next"
          buttons={props.buttons}
        />
      </span>
    </nav>
  );
}
