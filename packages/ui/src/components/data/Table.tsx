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

/** How the scroll region is named: by the id of a visible heading, or by a label. */
type TableName =
  | { labelledBy: string; label?: undefined; scroll?: true }
  | { label: string; labelledBy?: undefined; scroll?: true }
  | { scroll: false; label?: undefined; labelledBy?: undefined };

export type TableProps = TableName & {
  /** Header cells, left to right. Kept for an empty table, so the empty state shows the shape. */
  columns: readonly TableColumn[];
  /** Table caption. Visually hidden unless `captionVisible`: the tray title is the visible name. */
  caption?: Child;
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
    <table class={cx('tbl', props.dense && 'dense', props.stackable && 'stackable', props.class)}>
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
  /** Highlighted row (`tr.hl`, accent-soft): the row just changed or arrived from. Decorative: say why in the row too. */
  highlight?: boolean;
  class?: string;
  /** One `RowHeader`, then `Cell`s. */
  children?: Child;
}

/** A body row (`tr`). */
export function Row({ highlight, class: className, children }: RowProps) {
  return <tr class={cx(highlight && 'hl', className)}>{children}</tr>;
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
