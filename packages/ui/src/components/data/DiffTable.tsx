import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface DiffRow {
  /** The changed field, as the form names it ("Expires"). */
  field: Child;
  /** Value before the change. Leave it out when the field was not set. */
  before?: Child;
  /** Value after the change. Leave it out when the field was cleared. */
  after?: Child;
}

export interface DiffTableProps {
  rows: readonly DiffRow[];
  /** Screen reader caption, required: the table's name ("Changes to acme/infra → GitHub at 11:47"). */
  caption: Child;
  /** Column headers. */
  labels?: { field?: string; before?: string; after?: string };
  /** Text for a missing before or after value. */
  emptyText?: string;
  class?: string;
}

function Value(props: { tag: 'del' | 'ins'; value: Child | undefined; emptyText: string }) {
  if (props.value === undefined || props.value === null || props.value === '') {
    return <span class="faint">{props.emptyText}</span>;
  }
  return props.tag === 'del' ? <del>{props.value}</del> : <ins>{props.value}</ins>;
}

/**
 * Before/after table of one audit event (`table.diff`): a row per changed field, the old value
 * struck in `del`, the new one in `ins`. The column headers say which is which, so color is
 * never the only cue.
 */
export function DiffTable(props: DiffTableProps) {
  const emptyText = props.emptyText ?? 'Not set';
  return (
    <table class={cx('diff', props.class)}>
      <caption class="vh">{props.caption}</caption>
      <thead>
        <tr>
          <th scope="col">{props.labels?.field ?? 'Field'}</th>
          <th scope="col">{props.labels?.before ?? 'Before'}</th>
          <th scope="col">{props.labels?.after ?? 'After'}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr>
            <th scope="row">{row.field}</th>
            <td>
              <Value tag="del" value={row.before} emptyText={emptyText} />
            </td>
            <td>
              <Value tag="ins" value={row.after} emptyText={emptyText} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
