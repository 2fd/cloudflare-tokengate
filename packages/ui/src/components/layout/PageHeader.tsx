import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel } from '../../lib/heading';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';

interface PageHeaderBase {
  /** Breadcrumb above the title; omit on top-level pages. The first crumb is the list page. */
  crumbs?: readonly Crumb[];
  /** Name of the breadcrumb landmark. Default "Breadcrumb"; only for a second trail on the page. */
  crumbsLabel?: string;
  /** Header actions (`.ph-actions`): at most one primary button, last (top right). */
  actions?: Child;
  class?: string;
  /** Rows under the title row, in order: `RelationLine`, then `TabRow` or `Tabs`. */
  children?: Child;
}

/** List page: H1 with an optional count and a description. */
export interface ListPageHeaderProps extends PageHeaderBase {
  /**
   * The page H1: the only h1 on the page. Inside a `HeadingOffset` (a docs example) it renders
   * that many levels deeper, styled the same.
   */
  title: Child;
  /** Count after the title ("Service tokens 6"). */
  count?: number | string;
  /** One or two sentences under the title (`.desc`, max 70ch). */
  description?: Child;
  identity?: never;
}

/** Detail page: the identity row (logo, H1 with status, meta line) instead of the title. */
export interface DetailPageHeaderProps extends PageHeaderBase {
  /** An `Identity`: it renders the page H1. */
  identity: Child;
  title?: never;
  count?: never;
  description?: never;
}

export type PageHeaderProps = ListPageHeaderProps | DetailPageHeaderProps;

/**
 * Page header (`header.ph`): breadcrumb, the title row (list title or detail identity, then the
 * actions), then optional rows (relation line, tab row), 16px apart.
 */
export function PageHeader(props: PageHeaderProps) {
  const level = useHeadingLevel(1);
  return (
    <header class={cx('ph', props.class)}>
      {props.crumbs && props.crumbs.length > 0 ? (
        <Breadcrumbs items={props.crumbs} label={props.crumbsLabel} />
      ) : null}
      <div class="ph-row">
        {props.identity !== undefined ? (
          props.identity
        ) : (
          <div class="ph-title">
            <H level={level} class={level !== 1 ? 'h1' : undefined}>
              {props.title}
              {props.count !== undefined ? <span class="count">{props.count}</span> : null}
            </H>
            {props.description ? <p class="desc">{props.description}</p> : null}
          </div>
        )}
        {props.actions ? <div class="ph-actions">{props.actions}</div> : null}
      </div>
      {props.children}
    </header>
  );
}
