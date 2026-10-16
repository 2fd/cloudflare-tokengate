import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';

export interface PageHeaderProps {
  /** The page H1 (the only h1 on the page). */
  title: Child;
  /** Count after the title on list pages ("Service tokens 6"). */
  count?: number | string;
  /** One or two sentences under the title (`.desc`, max 70ch). */
  description?: Child;
  /** Breadcrumb above the title; omit on top-level pages. */
  crumbs?: readonly Crumb[];
  /** Header actions (`.ph-actions`): at most one primary button, top right. */
  actions?: Child;
  class?: string;
  /** Rows under the title row: relation line, tab row. */
  children?: Child;
}

/**
 * Page header (`header.ph`): breadcrumb, title row with actions, then optional rows. Minimal list
 * page version from the docs scaffold; the layout group adds the detail identity row (`.ident`).
 */
export function PageHeader(props: PageHeaderProps) {
  return (
    <header class={cx('ph', props.class)}>
      {props.crumbs && props.crumbs.length > 0 ? <Breadcrumbs items={props.crumbs} /> : null}
      <div class="ph-row">
        <div class="ph-title">
          <h1>
            {props.title}
            {props.count !== undefined ? <span class="count">{props.count}</span> : null}
          </h1>
          {props.description ? <p class="desc">{props.description}</p> : null}
        </div>
        {props.actions ? <div class="ph-actions">{props.actions}</div> : null}
      </div>
      {props.children}
    </header>
  );
}
