// "Which consumers can use which tokens" (A14.3): one column per token, one row group per
// consumer and one row per anchor (a repository, a workflow pin, a generic anchor value, or a
// custom condition set). A cell lists the accesses of that consumer, anchor and token, each with
// its status as words; an empty cell is a "+" that opens the access form prefilled. The table sits
// in a labelled, focusable region that scrolls on its own; the list view is its linear form.
import { labelFor } from '../../db/claim-labels';
import type { CallerProvider, ClaimLabel, Service } from '../../db/types';
import { getProfile } from '../../identity/profiles';
import type { AccessEdge, Connections } from '../connections';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { STATUS, statusLabel } from './status';

/** Above these the page defaults to the list view (A14.3). */
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
  consumer: CallerProvider;
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

export function buildMatrix(connections: Connections): MatrixModel {
  const columns = [...connections.tokens].sort((a, b) => a.name.localeCompare(b.name));
  const groups: MatrixGroup[] = [];
  let rowCount = 0;
  const consumers = [...connections.consumers].sort((a, b) => a.name.localeCompare(b.name));
  for (const consumer of consumers) {
    const labels = connections.labels.filter((label) => label.caller_provider_id === consumer.id);
    const rows = new Map<string, MatrixRow>();
    for (const edge of connections.accesses) {
      if (edge.grant.caller_provider_id !== consumer.id) continue;
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
    const sorted = [...rows.values()].sort((a, b) => a.header.localeCompare(b.header));
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

/** The credential state of a token as text, for column headers and token cards. */
export function credentialText(
  token: Pick<Service, 'id' | 'credential_sealed' | 'credential_expires_at'>,
  unreadable: ReadonlySet<string>,
  now: number,
): string {
  if (token.credential_sealed === null) return 'No credential yet';
  if (unreadable.has(token.id)) return 'Credential unreadable';
  if (token.credential_expires_at !== null && token.credential_expires_at <= now) {
    return `Credential expired ${new Date(token.credential_expires_at).toISOString().slice(0, 10)}`;
  }
  return 'Credential loaded';
}

function AccessLine(props: { edge: AccessEdge; subject: string }) {
  const { edge } = props;
  const status = STATUS[edge.status];
  const words = statusLabel(edge.status, edge.statusDetail);
  const unused = edge.flags.some((flag) => flag.status === 'unused');
  const credentialExpired = edge.flags.some((flag) => flag.status === 'credential_expired_warning');
  const parts = [
    shortContext(edge.context),
    operationsText(edge.operations.length),
    ...(credentialExpired ? ['credential expired'] : []),
    ...(unused ? ['unused 30 d'] : []),
  ];
  const tokenName = edge.token?.name ?? 'a deleted token';
  return (
    <a class="access-line" href={paths.accessItem(edge.grant.id)}>
      <span aria-hidden="true">
        <span class={`badge ${status.tone}`}>
          {status.glyph ? `${status.glyph} ` : ''}
          {words}
        </span>{' '}
        {parts.join(' · ')}
      </span>
      <span class="vh">
        {props.subject} can use {tokenName}: {words}, {edge.context},{' '}
        {operationsText(edge.operations.length)}
        {credentialExpired ? ', credential expired' : ''}
        {unused ? ', unused for 30 days' : ''}. Open access.
      </span>
    </a>
  );
}

export function Matrix(props: { model: MatrixModel; connections: Connections; ctx: ViewContext }) {
  const { model, ctx } = props;
  const canWrite = ctx.can('access:write');
  const span = model.columns.length + 1;
  return (
    <div class="matrix" role="region" tabindex={0} aria-labelledby="matrix-cap">
      <table>
        <caption id="matrix-cap">Which consumers can use which tokens</caption>
        <thead>
          <tr>
            <td class="corner" />
            {model.columns.map((token) => (
              <th scope="col">
                <a href={paths.token(token.id)}>{token.name}</a>
                <span class="secondary-text"> /proxy/{token.slug}</span>
                <span class="column-status">
                  {' '}
                  {credentialText(token, props.connections.unreadableTokenIds, ctx.now)}
                  {token.enabled ? '' : ', disabled'}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {model.groups.map((group) => (
          <tbody>
            <tr class="consumer-row">
              <th scope="rowgroup" colspan={span}>
                <a href={paths.consumer(group.consumer.id)}>{group.consumer.name}</a>
                {group.consumer.enabled ? null : <span class="secondary-text"> (disabled)</span>}
              </th>
            </tr>
            {group.rows.length === 0 ? (
              <tr>
                <th scope="row" class="anchor">
                  <span class="secondary-text">No access yet</span>
                </th>
                {model.columns.map((token) => (
                  <td>
                    <EmptyCell
                      canWrite={canWrite}
                      subject={group.consumer.name}
                      token={token}
                      href={paths.accessNew({ consumer: group.consumer.id, token: token.id })}
                    />
                  </td>
                ))}
              </tr>
            ) : (
              group.rows.map((row) => (
                <tr>
                  <th scope="row" class="anchor">
                    {row.header}
                  </th>
                  {model.columns.map((token) => {
                    const cell = row.cells.get(token.id) ?? [];
                    return (
                      <td>
                        {cell.length > 0 ? (
                          <ul class="cell-accesses">
                            {cell.map((edge) => (
                              <li>
                                <AccessLine edge={edge} subject={row.subject} />
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <EmptyCell
                            canWrite={canWrite}
                            subject={row.subject}
                            token={token}
                            href={paths.accessNew({
                              consumer: group.consumer.id,
                              token: token.id,
                              repository: row.repositoryId ?? undefined,
                              copy: row.firstAccessId,
                            })}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function EmptyCell(props: {
  canWrite: boolean;
  subject: string;
  token: Pick<Service, 'name'>;
  href: string;
}) {
  if (!props.canWrite) {
    return (
      <span class="no-access">
        <span aria-hidden="true">—</span>
        <span class="vh">No access</span>
      </span>
    );
  }
  return (
    <a class="add-access" href={props.href}>
      <span aria-hidden="true">+</span>
      <span class="vh">
        Give {props.subject} access to {props.token.name}
      </span>
    </a>
  );
}
