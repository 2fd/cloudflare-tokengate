// "Which credential access rules can use which tokens" (A14.3): one column per token, one row group per
// consumer and one row per anchor (a repository, a workflow pin, a generic anchor value, or a
// custom condition set). A cell lists the accesses of that consumer, anchor and token, each with
// its status as words; an empty cell is a "+" that opens the access form prefilled. The ui Matrix
// sits in a labelled, focusable region that scrolls on its own; the access list is its linear form.
import {
  formatTime,
  Matrix,
  type MatrixCell,
  type MatrixColumn,
  type MatrixGroup as UiMatrixGroup,
  type MatrixRow as UiMatrixRow,
} from '@tokengate/ui';
import { labelFor } from '../../db/claim-labels';
import type { CredentialAccessRule, ClaimLabel, Service } from '../../db/types';
import { getProfile } from '../../identity/profiles';
import type { AccessEdge, Connections } from '../connections';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import {
  accessTone,
  busiestFirst,
  consumerLogo,
  leadStatus,
  tokenLogo,
  trustLine,
} from './access-visuals';
import { STATUS, statusLabel } from './status';

/** Above these the matrix asks for a filter and shows the access list instead (A14.3). */
export const MATRIX_MAX_COLUMNS = 40;
export const MATRIX_MAX_ROWS = 300;

export interface MatrixRow {
  key: string;
  /** Row header text: "acme/api (89012345)", "Workflow …", "claim=value", "Custom conditions: …". */
  header: string;
  /** The short subject for sentences ("acme/api"). */
  subject: string;
  /** The repository or project ID of the row, for the "+" prefill. */
  repositoryId: string | null;
  cells: Map<string, AccessEdge[]>;
  /** The first access of the row (evaluation order), copied by the "+" links. */
  firstAccessId: string;
}

export interface MatrixGroup {
  consumer: CredentialAccessRule;
  rows: MatrixRow[];
}

export interface MatrixModel {
  columns: Service[];
  groups: MatrixGroup[];
  rowCount: number;
}

interface Anchor {
  key: string;
  header: string;
  subject: string;
  repositoryId: string | null;
}

function exactValues(edge: AccessEdge, claim: string): string[] {
  return edge.grant.conditions
    .filter((c) => c.claim === claim && c.match === 'exact' && c.negate !== true)
    .flatMap((c) => c.values);
}

/** The matrix rows an access appears in: each repository of a rows-mode access gets its own. */
export function anchorsOf(edge: AccessEdge, labels: readonly ClaimLabel[]): Anchor[] {
  const consumer = edge.consumer;
  const profile = consumer ? getProfile(consumer.profile) : null;
  for (const claim of ['repository_id', 'project_id']) {
    const ids = [...new Set(exactValues(edge, claim))];
    if (ids.length > 0) {
      return ids.map((id) => {
        const label = labelFor(labels, claim, id);
        return {
          key: `${claim}:${id}`,
          header: label ? `${label} (${id})` : id,
          subject: label ?? id,
          repositoryId: id,
        };
      });
    }
  }
  for (const [claim, owner] of [
    ['job_workflow_ref', 'repository_owner_id'],
    ['ci_config_ref_uri', 'namespace_id'],
  ] as const) {
    const [pin] = exactValues(edge, claim);
    if (pin !== undefined) {
      const owners = exactValues(edge, owner).map((id) => labelFor(labels, owner, id) ?? id);
      return [
        {
          key: `${claim}:${pin}`,
          header: `Workflow ${pin}${owners.length > 0 ? ` (any repository of ${owners.join(', ')})` : ''}`,
          subject: `Workflow ${pin}`,
          repositoryId: null,
        },
      ];
    }
  }
  if (profile?.id === 'generic' && consumer) {
    for (const claim of consumer.anchor_claims) {
      const values = [...new Set(exactValues(edge, claim))];
      if (values.length > 0) {
        return values.map((value) => ({
          key: `${claim}:${value}`,
          header: `${claim}=${value}`,
          subject: `${claim}=${value}`,
          repositoryId: null,
        }));
      }
    }
  }
  return [
    {
      key: `custom:${edge.grant.id}`,
      header: `Custom conditions: ${edge.grant.name}`,
      subject: edge.grant.name,
      repositoryId: null,
    },
  ];
}

/**
 * The matrix model. Columns: the busiest tokens first (`tokenWeight`, the 24-hour requests the map
 * also sorts by; else their number of accesses), disabled ones last. Rows: the busiest consumers
 * first, as on the map and in the lists.
 */
export function buildMatrix(
  connections: Connections,
  tokenWeight?: (tokenId: string) => number,
): MatrixModel {
  const accessCount = (key: 'credential_access_rule_id' | 'service_id', id: string) =>
    connections.accesses.filter((edge) => edge.grant[key] === id).length;
  const weight = tokenWeight ?? ((id: string) => accessCount('service_id', id));
  const columns = [...connections.tokens].sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      weight(b.id) - weight(a.id) ||
      a.name.localeCompare(b.name),
  );
  const groups: MatrixGroup[] = [];
  let rowCount = 0;
  const consumers = busiestFirst(connections.consumers, (id) =>
    accessCount('credential_access_rule_id', id),
  );
  for (const consumer of consumers) {
    const labels = connections.labels.filter(
      (label) => label.credential_access_rule_id === consumer.id,
    );
    const rows = new Map<string, MatrixRow>();
    for (const edge of connections.accesses) {
      if (edge.grant.credential_access_rule_id !== consumer.id) continue;
      for (const anchor of anchorsOf(edge, labels)) {
        const row = rows.get(anchor.key) ?? {
          ...anchor,
          cells: new Map<string, AccessEdge[]>(),
          firstAccessId: edge.grant.id,
        };
        const cell = row.cells.get(edge.grant.service_id) ?? [];
        cell.push(edge);
        row.cells.set(edge.grant.service_id, cell);
        rows.set(anchor.key, row);
      }
    }
    const size = (row: MatrixRow) =>
      [...row.cells.values()].reduce((n, list) => n + list.length, 0);
    const sorted = [...rows.values()].sort(
      (a, b) => size(b) - size(a) || a.header.localeCompare(b.header),
    );
    rowCount += sorted.length;
    groups.push({ consumer, rows: sorted });
  }
  return { columns, groups, rowCount };
}

/** "env production" for "environment production"; the rest as accessSummary words them. */
export function shortContext(context: string): string {
  return context.startsWith('environment ') ? `env ${context.slice(12)}` : context;
}

function operationsText(count: number): string {
  return count === 1 ? '1 operation' : `${count} operations`;
}

/** The secret state of a token as words, for column headers, token cards and the fixed bar. */
export function credentialText(
  token: Pick<Service, 'id' | 'credential_sealed' | 'credential_expires_at'>,
  unreadable: ReadonlySet<string>,
  now: number,
): string {
  if (token.credential_sealed === null) return 'No secret yet';
  if (unreadable.has(token.id)) return 'Secret unreadable';
  if (token.credential_expires_at !== null && token.credential_expires_at <= now) {
    return `Secret expired ${new Date(token.credential_expires_at).toISOString().slice(0, 10)}`;
  }
  return 'Secret set';
}

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_MS = 14 * DAY_MS;

/** A column's second line: ⏸ Disabled, ⌛ Expires in N days, ✓ Secret set, or the secret problem. */
function ColumnState(props: { token: Service; connections: Connections; now: number }) {
  const { token, now } = props;
  if (!token.enabled) return <>⏸ Disabled</>;
  const text = credentialText(token, props.connections.unreadableTokenIds, now);
  if (text !== 'Secret set') return <span class="t-bad">✕ {text}</span>;
  const expires = token.credential_expires_at;
  if (expires !== null && expires - now <= EXPIRY_WARNING_MS) {
    const days = Math.max(1, Math.ceil((expires - now) / DAY_MS));
    return <span class="t-warn">⌛ Expires in {days === 1 ? '1 day' : `${days} days`}</span>;
  }
  return <>✓ Secret set</>;
}

/** One matrix cell per access: the status in words, the constraint and the operations. */
function cellOf(edge: AccessEdge, subject: string, now: number): MatrixCell {
  const unused = edge.flags.some((flag) => flag.status === 'unused');
  const credentialExpired = edge.flags.some((flag) => flag.status === 'credential_expired_warning');
  const expires = edge.grant.expires_at;
  const operations = [
    operationsText(edge.operations.length),
    ...(expires !== null && expires > now
      ? [`until ${formatTime(new Date(expires), 'date')}`]
      : []),
    ...(credentialExpired ? ['secret expired'] : []),
    ...(unused ? ['unused 30 days'] : []),
  ].join(' · ');
  const lead = leadStatus(edge);
  const tone = accessTone(lead.status);
  return {
    href: paths.accessItem(edge.grant.id),
    srPrefix: `${subject} can use ${edge.token?.name ?? 'a deleted credential'}:`,
    tone,
    status: statusLabel(lead.status, lead.detail),
    // The legend's glyphs: an access that cannot work reads ⏸ like the dashed cell it sits in.
    glyph: tone === 'off' ? '⏸' : STATUS[lead.status].glyph,
    constraint: shortContext(edge.context),
    operations,
  };
}

/**
 * The access matrix (ui Matrix): tokens across, each credential access rule's repositories down, one cell per
 * access (overlapping accesses stack in one cell). Access managers get "+" in an empty cell, which
 * opens the form prefilled with the row's constraints and the column's token; others get "—".
 */
export function AccessMatrix(props: {
  model: MatrixModel;
  connections: Connections;
  ctx: ViewContext;
}) {
  const { model, connections, ctx } = props;
  const canWrite = ctx.can('access:write');
  const source = new Map<UiMatrixRow, { consumer: CredentialAccessRule; row: MatrixRow | null }>();
  const groups: UiMatrixGroup[] = model.groups.map((group) => {
    const { consumer } = group;
    const labels = connections.labels.filter((l) => l.credential_access_rule_id === consumer.id);
    const count = connections.accesses.filter(
      (edge) => edge.grant.credential_access_rule_id === consumer.id,
    ).length;
    const rows: UiMatrixRow[] =
      group.rows.length === 0
        ? [{ label: 'No access yet', mono: false, cells: {} }]
        : group.rows.map((row) => ({
            label: row.subject,
            href: row.repositoryId ? paths.access({ repository: row.repositoryId }) : undefined,
            meta: row.repositoryId ?? undefined,
            mono: !row.key.startsWith('custom:'),
            cells: Object.fromEntries(
              [...row.cells].map(([tokenId, edges]) => [
                tokenId,
                edges.map((edge) => cellOf(edge, row.subject, ctx.now)),
              ]),
            ),
          }));
    rows.forEach((ui, index) => {
      source.set(ui, { consumer, row: group.rows[index] ?? null });
    });
    return {
      name: `${consumer.name}${consumer.enabled ? '' : ' (disabled)'}`,
      logo: consumerLogo(consumer),
      href: paths.consumer(consumer.id),
      meta: `${trustLine(consumer, labels)} · ${count === 1 ? '1 access' : `${count} accesses`}`,
      rows,
    };
  });
  const columns: MatrixColumn[] = model.columns.map((token) => ({
    id: token.id,
    name: token.name,
    logo: tokenLogo(token),
    href: paths.token(token.id),
    meta: (
      <>
        <span class="mono d-block">{token.slug}</span>
        <ColumnState token={token} connections={connections} now={ctx.now} />
      </>
    ),
  }));
  return (
    <Matrix
      label="Which credential access rules can use which tokens"
      caption="Which credential access rules can use which tokens"
      corner="Consumer › repository"
      columns={columns}
      groups={groups}
      addHref={
        canWrite
          ? (row, column) => {
              const from = source.get(row);
              if (!from) return paths.accessNew({ token: column.id });
              return paths.accessNew({
                consumer: from.consumer.id,
                token: column.id,
                repository: from.row?.repositoryId ?? undefined,
                copy: from.row?.firstAccessId,
              });
            }
          : undefined
      }
      addLabel={(row, column) => {
        const from = source.get(row);
        const subject = from && from.row === null ? from.consumer.name : row.label;
        return `Give ${subject} access to ${column.name}`;
      }}
    />
  );
}
