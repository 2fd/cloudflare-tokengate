import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { LogoTile, type VizLogo } from './parts';

export interface MatrixColumn {
  /** Key of the column in each row's `cells`. */
  id: string;
  name: string;
  logo?: VizLogo;
  /** The token page or its access list. */
  href: string;
  /** "3 accesses · 2,140 req". */
  meta?: Child;
}

export interface MatrixCell {
  /** The access. */
  href: string;
  /** `ok` (default) active, `warn` expiring or risk, `bad` expired, `off` inactive (dashed). */
  tone?: 'ok' | 'warn' | 'bad' | 'off';
  /** Status word ("Active", "Secret expires", "Expired", "Inactive"). */
  status: string;
  /** Glyph before the status; defaults by tone (✓ ⌛ ✕ ⏸). `''` for none. */
  glyph?: string;
  /** The constraint in short, mono ("env production", "branch main"). */
  constraint?: Child;
  /** The operations ("1 operation"). */
  operations?: Child;
}

export interface MatrixRow {
  /** Row label, for the empty cells' accessible names ("acme/api"). */
  label: string;
  /** The repository's access list. Without it the label is text. */
  href?: string;
  /** "3 accesses". */
  meta?: Child;
  /** Mono label (repositories, pipelines). Default true. */
  mono?: boolean;
  /** Cells by column id. A missing column is an empty cell that offers "+". */
  cells: Readonly<Record<string, MatrixCell>>;
}

export interface MatrixGroup {
  /** Group header (the consumer). Leave out for a matrix without groups. */
  name?: string;
  logo?: VizLogo;
  href?: string;
  /** "org acme (1234567) · 6 accesses". */
  meta?: Child;
  rows: readonly MatrixRow[];
}

export interface MatrixProps {
  /** Accessible name of the scroll region ("Access matrix"). */
  label: string;
  /** Header of the row-label column ("Consumer › repository"). */
  corner: string;
  columns: readonly MatrixColumn[];
  groups: readonly MatrixGroup[];
  /** Link of an empty cell: the create form, prefilled with the row and the column. */
  addHref: (row: MatrixRow, column: MatrixColumn, group: MatrixGroup) => string;
  /** Accessible name of an empty cell. Default "Give {row} access to {column}". */
  addLabel?: (row: MatrixRow, column: MatrixColumn) => string;
  class?: string;
}

const GLYPH = { ok: '✓', warn: '⌛', bad: '✕', off: '⏸' } as const;

function Cell(props: { cell: MatrixCell }) {
  const { cell } = props;
  const tone = cell.tone ?? 'ok';
  const glyph = cell.glyph ?? GLYPH[tone];
  return (
    <a class={cx('mcell', tone !== 'ok' && tone)} href={cell.href}>
      <span class="s">
        {glyph ? <span aria-hidden="true">{glyph}</span> : null}
        {cell.status}
      </span>
      {cell.constraint !== undefined ? <span class="c">{cell.constraint}</span> : null}
      {cell.operations !== undefined ? <span class="o">{cell.operations}</span> : null}
    </a>
  );
}

/**
 * The access matrix (`.matrix > table.mx`): consumers' repositories down, tokens across, one cell
 * per access. Headers stay in view while the focusable region scrolls; empty cells offer "+" to
 * the prefilled create form. The "Matrix" view of Consumer access and the target of the map's
 * group nodes.
 */
export function Matrix(props: MatrixProps) {
  const { columns } = props;
  const addLabel =
    props.addLabel ??
    ((row: MatrixRow, column: MatrixColumn) => `Give ${row.label} access to ${column.name}`);
  return (
    <div class={cx('matrix', props.class)} role="region" tabindex={0} aria-label={props.label}>
      <table class="mx">
        <thead>
          <tr>
            <th scope="col">{props.corner}</th>
            {columns.map((column) => (
              <th scope="col">
                <div class="colh">
                  <span class="top">
                    {column.logo ? <LogoTile logo={column.logo} size="xs" /> : null}
                    <a href={column.href}>{column.name}</a>
                  </span>
                  {column.meta !== undefined ? <span class="meta">{column.meta}</span> : null}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        {props.groups.map((group) => (
          <tbody>
            {group.name !== undefined ? (
              <tr class="grp">
                <th colspan={columns.length + 1} scope="rowgroup">
                  <span class="gin">
                    {group.logo ? <LogoTile logo={group.logo} size="xs" /> : null}
                    {group.href ? (
                      <a class="ent-n" href={group.href}>
                        {group.name}
                      </a>
                    ) : (
                      <span class="ent-n">{group.name}</span>
                    )}
                    {group.meta !== undefined ? <span class="meta">{group.meta}</span> : null}
                  </span>
                </th>
              </tr>
            ) : null}
            {group.rows.map((row) => (
              <tr>
                <th scope="row">
                  {row.href ? (
                    <a class={cx(row.mono !== false && 'mono')} href={row.href}>
                      {row.label}
                    </a>
                  ) : (
                    <span class={cx(row.mono !== false && 'mono')}>{row.label}</span>
                  )}
                  {row.meta !== undefined ? <span class="meta">{row.meta}</span> : null}
                </th>
                {columns.map((column) => {
                  const cell = row.cells[column.id];
                  return (
                    <td>
                      {cell ? (
                        <Cell cell={cell} />
                      ) : (
                        <a class="madd" href={props.addHref(row, column, group)}>
                          <span aria-hidden="true">+</span>
                          <span class="vh">{addLabel(row, column)}</span>
                        </a>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
