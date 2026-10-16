import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface SplitItem {
  /** The detail URL of the item (`?req=req_01JB…`): the list is plain links, no JS. */
  href: string;
  /** Main line, mono ("POST /chat.postMessage"). */
  title: Child;
  /** Outcome with its word and HTTP code. */
  outcome?: { tone: 'ok' | 'bad' | 'warn'; word: string; code?: string };
  /** Time on the right of the first line ("14:03:22"). */
  time?: string;
  /** Machine-readable time for `time`. */
  datetime?: string;
  /** Second fact ("acme/web → slack"). */
  meta?: Child;
  /** The item shown in the pane: highlighted, `aria-current="page"`. */
  current?: boolean;
}

export interface SplitViewProps {
  /** Prefix of the ids inside (`${id}-h`). Unique on the page. */
  id: string;
  /** Accessible name of the list ("Requests, newest first"). */
  label: string;
  items: readonly SplitItem[];
  /** Pane heading: the current item ("POST /chat.postMessage"). */
  title: Child;
  /** Facts under the pane heading (ID chip, time). */
  meta?: Child;
  /** Pane actions on the right of the heading (secondary buttons, one primary at most). */
  actions?: Child;
  /** Heading level of the pane title: 2 (default) on a page, 3 under another h2. */
  level?: 2 | 3;
  /** Under the list: a pager or "Showing 1–25". */
  listFooter?: Child;
  /** The detail: trace, key-value list, next step. */
  children?: Child;
  class?: string;
}

/**
 * Split view (`.split`): a list of requests on the left and the selected one's detail on the
 * right. Each list item is a link to its own URL, so the server renders the pane; the selected
 * item carries `aria-current="page"`. Below 64rem the list sits above the detail and scrolls on
 * its own. Goes directly in a tray or a page.
 */
export function SplitView(props: SplitViewProps) {
  const headingId = `${props.id}-h`;
  const Heading = props.level === 3 ? 'h3' : 'h2';
  return (
    <div class={cx('split', props.class)} id={props.id}>
      <nav class="split-list" aria-label={props.label}>
        <ol class="split-items">
          {props.items.map((item) => (
            <li>
              <a
                class="split-item"
                href={item.href}
                aria-current={item.current ? 'page' : undefined}
              >
                {item.outcome || item.time ? (
                  <span class="split-top">
                    {item.outcome ? (
                      <span class={`res ${item.outcome.tone}`}>
                        <span
                          class={cx('dot', item.outcome.tone !== 'ok' && item.outcome.tone)}
                          aria-hidden="true"
                        />
                        {item.outcome.word}
                        {item.outcome.code ? (
                          <>
                            {' '}
                            <span class="code">{item.outcome.code}</span>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                    {item.time ? (
                      <time class="time" datetime={item.datetime}>
                        {item.time}
                      </time>
                    ) : null}
                  </span>
                ) : null}
                <span class="split-t mono">{item.title}</span>
                {item.meta !== undefined ? <span class="meta">{item.meta}</span> : null}
              </a>
            </li>
          ))}
        </ol>
        {props.listFooter !== undefined ? <div class="split-f">{props.listFooter}</div> : null}
      </nav>
      <section class="split-pane" aria-labelledby={headingId}>
        <div class="split-h">
          <div class="t">
            <Heading id={headingId}>{props.title}</Heading>
            {props.meta !== undefined ? <p class="meta">{props.meta}</p> : null}
          </div>
          {props.actions !== undefined ? <div class="end">{props.actions}</div> : null}
        </div>
        <div class="split-b">{props.children}</div>
      </section>
    </div>
  );
}
