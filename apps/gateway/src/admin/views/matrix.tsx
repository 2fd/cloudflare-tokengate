// "Which issuers can use which credentials" (A14.3): one column per credential, one row group per issuer
// and one row per anchor (a repository, a workflow pin, a generic anchor value, or a custom
// condition set). A cell lists the credential access rules of that issuer, anchor and credential,
// each with its status as words; an empty cell is a "+" that opens the rule form prefilled. The ui
// Matrix sits in a labelled, focusable region that scrolls on its own; the rule list is its linear
// form. WP-R3 redraws it for credential and global access rules (§A7.10).
import {
  formatTime,
  Matrix,
  type MatrixCell,
  type MatrixColumn,
  type MatrixGroup as UiMatrixGroup,
  type MatrixRow as UiMatrixRow,
} from '@tokengate/ui';
import { labelFor } from '../../db/claim-labels';
import type { ClaimLabel, CredentialAccessRule, Service } from '../../db/types';
import { getProfile } from '../../identity/profiles';
import type { Connections, RuleEdge } from '../connections';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import {
  accessTone,
  busiestFirst,
  issuerHost,
  issuerLogo,
  leadStatus,
  tokenLogo,
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
  cells: Map<string, RuleEdge[]>;
  /** The first rule of the row (evaluation order), copied by the "+" links. */
  firstAccessId: string;
}

/** The rules of one issuer key: the matrix row group (and a map node). */
export interface IssuerNode {
  id: string;
  name: string;
  /** The oldest rule of the issuer: its issuer, profile and logo stand for the group. */
  first: CredentialAccessRule;
}

export interface MatrixGroup {
  issuer: IssuerNode;
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

function exactValues(edge: RuleEdge, claim: string): string[] {
  return edge.rule.conditions
    .filter((c) => c?.claim === claim && c.match === 'exact' && c.negate !== true)
    .flatMap((c) => c.values);
}

/** The issuers of the rules, by issuer key, oldest rule first. */
export function issuerNodes(connections: Pick<Connections, 'rules'>): IssuerNode[] {
  const nodes = new Map<string, IssuerNode>();
  for (const edge of connections.rules) {
    if (nodes.has(edge.rule.issuer_key)) continue;
    nodes.set(edge.rule.issuer_key, {
      id: edge.rule.issuer_key,
      name: issuerHost(edge.rule.issuer),
      first: edge.rule,
    });
  }
  return [...nodes.values()];
}

/** The matrix rows a rule appears in: each repository of a rows-mode rule gets its own. */
export function anchorsOf(edge: RuleEdge, labels: readonly ClaimLabel[]): Anchor[] {
  const rule = edge.rule;
  const profile = getProfile(rule.profile);
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
  if (profile?.id === 'generic') {
    for (const claim of rule.anchor_claims) {
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
      key: `custom:${edge.rule.id}`,
      header: `Custom conditions: ${edge.rule.name}`,
      subject: edge.rule.name,
      repositoryId: null,
    },
  ];
}

/**
 * The matrix model. Columns: the busiest credentials first (`tokenWeight`, the 24-hour requests the
 * map also sorts by; else their number of rules), disabled ones last. Rows: the busiest issuers
 * first, as on the map and in the lists.
 */
export function buildMatrix(
  connections: Connections,
  tokenWeight?: (tokenId: string) => number,
): MatrixModel {
  const ruleCount = (key: 'issuer_key' | 'credential_id', id: string) =>
    connections.rules.filter((edge) => edge.rule[key] === id).length;
  const weight = tokenWeight ?? ((id: string) => ruleCount('credential_id', id));
  const columns = [...connections.credentials].sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      weight(b.id) - weight(a.id) ||
      a.name.localeCompare(b.name),
  );
  const groups: MatrixGroup[] = [];
  let rowCount = 0;
  const issuers = busiestFirst(issuerNodes(connections), (id) => ruleCount('issuer_key', id));
  for (const issuer of issuers) {
    const rows = new Map<string, MatrixRow>();
    for (const edge of connections.rules) {
      if (edge.rule.issuer_key !== issuer.id) continue;
      const labels = connections.labels.filter((label) => label.access_rule_id === edge.rule.id);
      for (const anchor of anchorsOf(edge, labels)) {
        const row = rows.get(anchor.key) ?? {
          ...anchor,
          cells: new Map<string, RuleEdge[]>(),
          firstAccessId: edge.rule.id,
        };
        const cell = row.cells.get(edge.rule.credential_id) ?? [];
        cell.push(edge);
        row.cells.set(edge.rule.credential_id, cell);
        rows.set(anchor.key, row);
      }
    }
    const size = (row: MatrixRow) =>
      [...row.cells.values()].reduce((n, list) => n + list.length, 0);
    const sorted = [...rows.values()].sort(
      (a, b) => size(b) - size(a) || a.header.localeCompare(b.header),
    );
    rowCount += sorted.length;
    groups.push({ issuer, rows: sorted });
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
  token: Pick<Service, 'id' | 'credential_sealed'>,
  unreadable: ReadonlySet<string>,
): string {
  if (token.credential_sealed === null) return 'No secret yet';
  if (unreadable.has(token.id)) return 'Secret unreadable';
  return 'Secret set';
}

/** A column's second line: ⏸ Disabled, ✓ Secret set, or the secret problem. */
function ColumnState(props: { token: Service; connections: Connections }) {
  const { token } = props;
  if (!token.enabled) return <>⏸ Disabled</>;
  const text = credentialText(token, props.connections.unreadableTokenIds);
  if (text !== 'Secret set') return <span class="t-bad">✕ {text}</span>;
  return <>✓ Secret set</>;
}

/** One matrix cell per rule: the status in words, the constraint and the operations. */
function cellOf(edge: RuleEdge, subject: string, now: number): MatrixCell {
  const unused = edge.flags.some((flag) => flag.status === 'unused');
  const expires = edge.rule.expires_at;
  const operations = [
    operationsText(edge.operations.length),
    ...(expires !== null && expires > now
      ? [`until ${formatTime(new Date(expires), 'date')}`]
      : []),
    ...(unused ? ['unused 30 days'] : []),
  ].join(' · ');
  const lead = leadStatus(edge);
  const tone = accessTone(lead.status);
  return {
    href: paths.accessRule(edge.rule.id),
    srPrefix: `${subject} can use ${edge.credential?.name ?? 'a deleted credential'}:`,
    tone,
    status: statusLabel(lead.status, lead.detail),
    // The legend's glyphs: an access that cannot work reads ⏸ like the dashed cell it sits in.
    glyph: tone === 'off' ? '⏸' : STATUS[lead.status].glyph,
    constraint: shortContext(edge.context),
    operations,
  };
}

/**
 * The rule matrix (ui Matrix): credentials across, each issuer's repositories down, one cell per
 * rule (overlapping rules stack in one cell). Access managers get "+" in an empty cell, which
 * opens the form prefilled with the row's values and the column's credential; others get "—".
 */
export function AccessMatrix(props: {
  model: MatrixModel;
  connections: Connections;
  ctx: ViewContext;
}) {
  const { model, connections, ctx } = props;
  const canWrite = ctx.can('access:write');
  const source = new Map<UiMatrixRow, { issuer: IssuerNode; row: MatrixRow | null }>();
  const groups: UiMatrixGroup[] = model.groups.map((group) => {
    const { issuer } = group;
    const count = connections.rules.filter((edge) => edge.rule.issuer_key === issuer.id).length;
    const rows: UiMatrixRow[] =
      group.rows.length === 0
        ? [{ label: 'No access rule yet', mono: false, cells: {} }]
        : group.rows.map((row) => ({
            label: row.subject,
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
      source.set(ui, { issuer, row: group.rows[index] ?? null });
    });
    return {
      name: issuer.name,
      logo: issuerLogo({ ...issuer.first, enabled: true }),
      href: paths.accessRules({ issuer: issuer.id }),
      meta: `${issuer.id} · ${count === 1 ? '1 access rule' : `${count} access rules`}`,
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
        <ColumnState token={token} connections={connections} />
      </>
    ),
  }));
  return (
    <Matrix
      label="Which issuers can use which credentials"
      caption="Which issuers can use which credentials"
      corner="Issuer › repository"
      columns={columns}
      groups={groups}
      addHref={
        canWrite
          ? (row, column) => {
              const from = source.get(row);
              if (!from) return paths.accessRuleNew({ credential: column.id });
              return paths.accessRuleNew({
                credential: column.id,
                type: from.issuer.first.profile,
                copy: from.row?.firstAccessId,
              });
            }
          : undefined
      }
      addLabel={(row, column) => {
        const from = source.get(row);
        const subject = from && from.row === null ? from.issuer.name : row.label;
        return `Give ${subject} access to ${column.name}`;
      }}
    />
  );
}
