import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface TableColumn {
  /** Header text, sentence case ("Requests 24 h"). For an `act` column it is screen reader only. */
  label: Child;
  /** Numbers: right-aligned, tabular figures (`th.num`). Match it with `Cell num`. */
  num?: boolean;
  /** The row-actions column (`th.act`): narrow, right-aligned, label visually hidden. */
  act?: boolean;
  /** Extra classes on this header cell. */
  class?: string;
}

/**
 * How the table is named. In its scroll region (default): by the id of a visible heading, or by a
 * label. Without the region (`scroll={false}`) the table names itself: `caption` is required.
 */
type TableName =
  | { labelledBy: string; label?: undefined; scroll?: true; caption?: Child }
  | { label: string; labelledBy?: undefined; scroll?: true; caption?: Child }
  | { scroll: false; label?: undefined; labelledBy?: undefined; caption: Child };

export type TableProps = TableName & {
  /**
   * Id of the `table` element, not of the scroll region: a fragment target (`#requests`), and the
   * start of the table for checkers that read from it to its `caption`. Unique on the page.
   */
  id?: string;
  /** Header cells, left to right. Kept for an empty table, so the empty state shows the shape. */
  columns: readonly TableColumn[];
  /**
   * Show the caption instead of hiding it (`.vh`). Usually the tray title is the visible name and
   * the caption (`caption`, required with `scroll={false}`) stays for screen readers.
   */
  captionVisible?: boolean;
  /** 36px rows, for logs and number tables. */
  dense?: boolean;
  /** Below 48rem each row becomes a card: one fact per line, under its `Cell label`. */
  stackable?: boolean;
  /** Extra classes on the `table` element (for example a page-only `log`). */
  class?: string;
  /** `Row` elements. Leave empty for an empty table, then put an `EmptyState` after it. */
  children?: Child;
};

/**
 * Data table (`table.tbl`) inside a keyboard-scrollable region (`.scroll[role=region]`): the
 * region is focusable and named, so a wide table scrolls with the arrow keys. Put it in a
 * `Panel variant="flush"`. Rows are `Row` > `RowHeader` + `Cell`.
 */
export function Table(props: TableProps) {
  const rows = props.children;
  const hasRows =
    rows !== undefined &&
    rows !== null &&
    rows !== false &&
    !(Array.isArray(rows) && rows.length === 0);
  const table = (
    <table
      class={cx('tbl', props.dense && 'dense', props.stackable && 'stackable', props.class)}
      id={props.id}
    >
      {props.caption !== undefined ? (
        <caption class={props.captionVisible ? undefined : 'vh'}>{props.caption}</caption>
      ) : null}
      <thead>
        <tr>
          {props.columns.map((column) => (
            <th scope="col" class={cx(column.num && 'num', column.act && 'act', column.class)}>
              {column.act ? <span class="vh">{column.label}</span> : column.label}
            </th>
          ))}
        </tr>
      </thead>
      {hasRows ? <tbody>{props.children}</tbody> : null}
    </table>
  );
  if (props.scroll === false) return table;
  return (
    <div
      class="scroll"
      role="region"
      tabindex={0}
      aria-labelledby={props.labelledBy}
      aria-label={props.labelledBy ? undefined : props.label}
    >
      {table}
    </div>
  );
}

export interface RowProps {
  /** Id of the `tr`: the fragment target of a redirect back to this row (`#user-usr_1`). Unique on the page. */
  id?: string;
  /** Highlighted row (`tr.hl`, neutral surface-3): the row just changed or arrived from. Decorative: say why in the row too. */
  highlight?: boolean;
  class?: string;
  /** One `RowHeader`, then `Cell`s. */
  children?: Child;
}

/** A body row (`tr`). */
export function Row({ id, highlight, class: className, children }: RowProps) {
  return (
    <tr class={cx(highlight && 'hl', className)} id={id}>
      {children}
    </tr>
  );
}

export interface RowHeaderProps {
  class?: string;
  /** What the row is about: usually an `Entity` (logo + name link + meta line). */
  children?: Child;
}

/** The cell that names the row (`th scope="row"`): screen readers announce it with each cell. */
export function RowHeader({ class: className, children }: RowHeaderProps) {
  return (
    <th scope="row" class={className}>
      {children}
    </th>
  );
}

export interface CellProps {
  /** Column name repeated above the value when a stackable table becomes cards (`data-label`). */
  label?: string;
  /** Numbers: right-aligned tabular figures (`.num`). */
  num?: boolean;
  /** A zero or empty value, in the faint color (`.zero`). */
  zero?: boolean;
  /** Row actions (`.act`): small secondary buttons, each with a screen reader suffix. */
  act?: boolean;
  /** Keep the value on one line on wide screens (`.nowrap`); it wraps again when stacked. */
  nowrap?: boolean;
  class?: string;
  children?: Child;
}

/** A data cell (`td`). */
export function Cell(props: CellProps) {
  return (
    <td
      class={cx(
        props.num && 'num',
        props.zero && 'zero',
        props.act && 'act',
        props.nowrap && 'nowrap',
        props.class,
      )}
      data-label={props.label}
    >
      {props.children}
    </td>
  );
}

export interface GroupRowProps {
  /** How many columns the group header spans: the table's column count. */
  colspan: number;
  /** One action at the right (`.btn.ghost.sm`): "+ Give acme/api access to another token". */
  actions?: Child;
  class?: string;
  /** What the rows under it share: an `Entity`, a mono repository and its ID. */
  children: Child;
}

/**
 * A group header inside a table (`tr.grp` > `th[scope=rowgroup]` > `.grp-in`): the consumer or
 * repository the following rows belong to, on the panel-sub band, with one optional action.
 */
export function GroupRow(props: GroupRowProps) {
  return (
    <tr class={cx('grp', props.class)}>
      <th colspan={props.colspan} scope="rowgroup">
        <span class="grp-in">
          <span>{props.children}</span>
          {props.actions ?? null}
        </span>
      </th>
    </tr>
  );
}
