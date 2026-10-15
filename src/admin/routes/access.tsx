// Admin pages: consumer access (grants). The matrix and list show which consumers can use which
// tokens; the structured form builds the conditions and rules (consumer-access.ts) and every save
// goes through ops/grants.ts (validateGrant: anchors I-AUTHZ-2, tenant pin containment, event
// guard I-AUTHZ-3; audit I-AUDIT-1). Risks are accepted by the selection that causes them, or by
// ticking a box bound to a digest of exactly the risks shown (A7.7). Autocomplete reads only
// control-plane data; a request record prefills the form only on request, verified (I-LOG-2).
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { sha256Hex } from '../../crypto/hash';
import { labelFor } from '../../db/claim-labels';
import { getGrant } from '../../db/grants';
import { getRequest } from '../../db/requests';
import {
  consumerAccessShapes,
  consumerSuggestions,
  ruleSets as ruleSetsOf,
  rulePathSuggestions,
  tokenAccessShapes,
} from '../../db/suggestions';
import type { CallerProvider, ClaimLabel, Grant, Service } from '../../db/types';
import { getProfile, PROFILES } from '../../identity/profiles';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import { parseJson } from '../../lib/json';
import { claimText } from '../../policy/conditions';
import type { Condition, Rule } from '../../policy/types';
import {
  validateCallerProvider,
  validateGrant,
  type WarningCode,
  type WarningDetail,
} from '../../policy/validate';
import { type AccessEdge, type Connections, loadConnections } from '../connections';
import {
  accessFormFromGrant,
  anchorClaims,
  blankJobsForm,
  condRows,
  coveredRiskCodes,
  defaultOpsForm,
  deriveAccessName,
  type ExpiryForm,
  type Fields,
  flag,
  idText,
  type JobsForm,
  jobsToRows,
  mostUsedContext,
  type OpsForm,
  opsFormFromRules,
  parseExpiry,
  parseJobs,
  parseOps,
  parseRepositoryInput,
  readExpiryForm,
  readJobsForm,
  readOpsForm,
  text,
  withTypedLabels,
} from '../consumer-access';
import { type Notice, type NoticeContext, type NoticeTable, resolveNotice } from '../notice';
import {
  addTenantValue,
  type ConsumerInput,
  consumerIssuer,
  createOrMergeConsumer,
  tenantClaimOf,
} from '../ops/caller-providers';
import {
  checkGrant,
  createGrant,
  deleteGrant,
  duplicateGrant,
  type GrantLabel,
  setGrantEnabled,
  updateGrant,
} from '../ops/grants';
import type { FieldError, OpFailure } from '../ops/shared';
import { paths, returnPath } from '../paths';
import {
  type AdminContext,
  adminActor,
  formData,
  redirectWithNotice,
  renderPage,
  submittedVersion,
  type ViewContext,
} from '../render';
import { templateForService } from '../service-templates';
import {
  AccessForm,
  type AccessFormModel,
  type ConsumerBranch,
  type ConsumerChoice,
  type NewConsumerBranch,
  type TokenBranch,
  type TokenChoice,
} from '../views/access-form';
import { AccessPage, type AccessPageModel } from '../views/access-page';
import {
  blankConsumerForm,
  CONSUMER_TYPES,
  type ConsumerForm,
  parseConsumerForm,
  readConsumerForm,
} from '../views/add-consumer-fields';
import {
  ActionButton,
  AskSomeone,
  DataTable,
  EmptyState,
  Field,
  FilterChips,
  NotFound,
  Select,
  StatusBadge,
  type Suggestion,
  Tabs,
  Time,
} from '../views/components';
import { relativeTime } from '../views/format';
import {
  anchorsOf,
  buildMatrix,
  credentialText,
  Matrix,
  MATRIX_MAX_COLUMNS,
  MATRIX_MAX_ROWS,
} from '../views/matrix';
import { accessFixable } from '../views/reasons';
import { consumerFailureErrors } from './consumers';

const HOUR_MS = 3_600_000;
const STATUS_FILTERS = ['active', 'inactive', 'expiring', 'unused', 'risk'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
/** At most this many cards; more choices become a select (A7.1, Choice). */
const MAX_CARDS = 6;

export function registerAccessRoutes(app: App): void {
  app.get('/admin/access', listPage);
  app.get('/admin/access/new', newPage);
  app.post('/admin/access', create);
  app.get('/admin/access/:id', detailPage);
  app.post('/admin/access/:id', update);
  app.post('/admin/access/:id/copy', copy);
  app.post('/admin/access/:id/toggle', toggle);
  app.post('/admin/access/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Notices

interface AccessNoticeData {
  grant: Grant | null;
  consumer: CallerProvider | null;
}

const NOTICES: NoticeTable<NoticeContext & AccessNoticeData> = {
  created: () => ({
    text: 'Access created. Add the snippet below to the job; it can use the token from the next request on.',
  }),
  copied: () => ({ text: 'Copy created and enabled. Add the snippet below to the job.' }),
  updated: () => ({ text: 'Access saved.' }),
  label_changed: () => ({
    text: 'Access saved. A display name of an ID changed everywhere it is shown.',
  }),
  renamed: () => ({ text: 'Access renamed.' }),
  unchanged: () => ({ text: 'Nothing changed: the submitted values are the current ones.' }),
  enabled: () => ({ text: 'Access enabled.' }),
  disabled: ({ grant }) => ({
    text: 'Access disabled. It stops matching from the next request on.',
    ...(grant && !grant.enabled
      ? {
          undo: {
            action: `${paths.accessItem(grant.id)}/toggle`,
            fields: { enabled: '1', _return: 'detail' },
            label: 'Enable again',
          },
        }
      : {}),
  }),
  deleted: () => ({ text: 'Access deleted.' }),
  copy_review: () => ({
    text: 'This token has other operations: review them, then save the copy.',
  }),
  consumer_created: ({ consumer }) => ({
    text: `Consumer ${consumer?.name ?? ''} created. Now give it access to a token.${consumerRisks(consumer)}`,
  }),
  tenant_added: ({ consumer }) => ({
    text: `Added to ${consumer?.name ?? 'the consumer'}. Now give it access to a token.`,
  }),
};

/** " Risk: …" for each standing warning of a consumer (a generic one without a pin), or "". */
function consumerRisks(consumer: CallerProvider | null): string {
  const profile = consumer ? getProfile(consumer.profile) : null;
  if (!consumer || !profile) return '';
  return validateCallerProvider(consumer, profile, consumer)
    .warnings.map((warning) => ` Risk: ${warning}.`)
    .join('');
}

function notice(c: AdminContext, data: AccessNoticeData) {
  return resolveNotice(NOTICES, c.req.query('notice'), null, data);
}

// ---------------------------------------------------------------------------------------------
// List: matrix and list views

async function listPage(c: AdminContext) {
  const deps = c.get('deps');
  const connections = await loadConnections(deps);
  const query = (name: string) => c.req.query(name) ?? '';
  const notes: string[] = [];
  let consumerId = query('consumer');
  if (consumerId && !connections.consumers.some((consumer) => consumer.id === consumerId)) {
    notes.push('That consumer no longer exists.');
    consumerId = '';
  }
  let tokenId = query('token');
  if (tokenId && !connections.tokens.some((token) => token.id === tokenId)) {
    notes.push('That token no longer exists.');
    tokenId = '';
  }
  const repository = query('repository').trim().slice(0, 200);
  const status = (STATUS_FILTERS as readonly string[]).includes(query('status'))
    ? (query('status') as StatusFilter)
    : '';
  const filtered = filterAccesses(connections, { consumerId, tokenId, repository, status });
  const model = buildMatrix({
    ...connections,
    consumers: consumerId
      ? connections.consumers.filter((consumer) => consumer.id === consumerId)
      : repository || status
        ? connections.consumers.filter((consumer) =>
            filtered.some((edge) => edge.grant.caller_provider_id === consumer.id),
          )
        : connections.consumers,
    tokens: tokenId
      ? connections.tokens.filter((token) => token.id === tokenId)
      : connections.tokens,
    accesses: filtered,
  });
  const tooBig = model.columns.length > MATRIX_MAX_COLUMNS || model.rowCount > MATRIX_MAX_ROWS;
  const view =
    query('view') === 'list' || (query('view') !== 'matrix' && tooBig) ? 'list' : 'matrix';
  const anyFilter = consumerId !== '' || tokenId !== '' || repository !== '' || status !== '';
  const base = {
    consumer: consumerId || undefined,
    token: tokenId || undefined,
    repository: repository || undefined,
    status: status || undefined,
  };
  const counts = {
    inactive: connections.accesses.filter((edge) => edge.status === 'inactive').length,
    expiring: connections.accesses.filter((edge) => edge.status === 'expiring').length,
    unused: connections.accesses.filter((edge) => edge.flags.some((f) => f.status === 'unused'))
      .length,
    risk: connections.accesses.filter((edge) =>
      edge.flags.some((f) => f.status === 'risk_accepted'),
    ).length,
  };
  return renderPage(
    c,
    {
      title: 'Consumer access',
      section: 'consumers',
      subsection: 'access',
      notice: notice(c, { grant: null, consumer: null }),
    },
    (ctx) => (
      <>
        <p>
          Which service consumers can use which service tokens, and in which jobs.{' '}
          <a href={paths.docs('concepts.md#consumer-access')}>What is consumer access?</a>
        </p>
        {notes.map((note) => (
          <p class="moved">{note}</p>
        ))}
        <Tabs
          label="Consumer access views"
          items={[
            { key: 'matrix', href: paths.access({ ...base, view: 'matrix' }), label: 'Matrix' },
            { key: 'list', href: paths.access({ ...base, view: 'list' }), label: 'List' },
          ]}
          current={view}
        />
        {connections.tokens.length === 0 ? (
          <EmptyState
            action={
              ctx.can('tokens:write') ? (
                <a class="button" href={paths.tokenNew()}>
                  Add a service token
                </a>
              ) : (
                <AskSomeone permission="tokens:write" ctx={ctx} verb="add one" />
              )
            }
          >
            A token manager must add a service token first.
          </EmptyState>
        ) : (
          <>
            {ctx.can('access:write') ? (
              <p class="actions">
                <a
                  class="button"
                  href={paths.accessNew({
                    consumer:
                      consumerId || (connections.consumers.length === 0 ? 'new' : undefined),
                    token: tokenId || undefined,
                  })}
                >
                  Give a consumer access
                </a>
              </p>
            ) : null}
            {connections.consumers.length === 0 ? (
              <EmptyState>
                No consumer yet.{' '}
                {ctx.can('access:write') ? (
                  <>Give a consumer access: the form adds the consumer in the same step.</>
                ) : (
                  <AskSomeone permission="access:write" ctx={ctx} verb="add one" />
                )}
              </EmptyState>
            ) : (
              <>
                <ul class="quick-links">
                  <li>
                    <a href={paths.access({ view, status: 'inactive' })}>
                      Inactive ({counts.inactive})
                    </a>
                  </li>
                  <li>
                    <a href={paths.access({ view, status: 'expiring' })}>
                      Expiring in 14 days ({counts.expiring})
                    </a>
                  </li>
                  <li>
                    <a href={paths.access({ view, status: 'unused' })}>
                      Unused 30 days ({counts.unused})
                    </a>
                  </li>
                  <li>
                    <a href={paths.access({ view, status: 'risk' })}>
                      Risk accepted ({counts.risk})
                    </a>
                  </li>
                </ul>
                <FilterForm
                  connections={connections}
                  view={view}
                  consumerId={consumerId}
                  tokenId={tokenId}
                  repository={repository}
                  status={status}
                />
                <FilterChips
                  items={[
                    ...(consumerId
                      ? [
                          {
                            label: `Consumer: ${connections.consumers.find((x) => x.id === consumerId)?.name ?? ''}`,
                            removeHref: paths.access({ ...base, view, consumer: undefined }),
                          },
                        ]
                      : []),
                    ...(tokenId
                      ? [
                          {
                            label: `Token: ${connections.tokens.find((x) => x.id === tokenId)?.name ?? ''}`,
                            removeHref: paths.access({ ...base, view, token: undefined }),
                          },
                        ]
                      : []),
                    ...(repository
                      ? [
                          {
                            label: `Repository: ${repository}`,
                            removeHref: paths.access({ ...base, view, repository: undefined }),
                          },
                        ]
                      : []),
                    ...(status
                      ? [
                          {
                            label: `Status: ${status}`,
                            removeHref: paths.access({ ...base, view, status: undefined }),
                          },
                        ]
                      : []),
                  ]}
                  clearHref={paths.access({ view })}
                />
                {tooBig && view === 'list' && query('view') !== 'list' ? (
                  <p class="moved">Too many to show as a matrix; filter by consumer or token.</p>
                ) : null}
                {anyFilter && filtered.length === 0 ? (
                  <EmptyState>
                    No consumer access matches these filters.{' '}
                    <a href={paths.access({ view })}>Clear filters</a>
                  </EmptyState>
                ) : (
                  <>
                    {connections.accesses.length === 0 ? (
                      <p>No consumer can use any token yet.</p>
                    ) : null}
                    {view === 'matrix' ? (
                      <Matrix model={model} connections={connections} ctx={ctx} />
                    ) : (
                      <AccessList edges={filtered} connections={connections} ctx={ctx} />
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </>
    ),
  );
}

function filterAccesses(
  connections: Connections,
  filter: { consumerId: string; tokenId: string; repository: string; status: StatusFilter | '' },
): AccessEdge[] {
  const needle = filter.repository.toLowerCase();
  return connections.accesses.filter((edge) => {
    if (filter.consumerId && edge.grant.caller_provider_id !== filter.consumerId) return false;
    if (filter.tokenId && edge.grant.service_id !== filter.tokenId) return false;
    if (needle) {
      const labels = connections.labels.filter(
        (l) => l.caller_provider_id === edge.grant.caller_provider_id,
      );
      const anchors = anchorsOf(edge, labels);
      const hit = anchors.some(
        (anchor) =>
          anchor.repositoryId === filter.repository || anchor.header.toLowerCase().includes(needle),
      );
      if (!hit) return false;
    }
    switch (filter.status) {
      case 'active':
        return edge.status === 'active';
      case 'inactive':
        return edge.status === 'inactive';
      case 'expiring':
        return edge.status === 'expiring';
      case 'unused':
        return edge.flags.some((f) => f.status === 'unused');
      case 'risk':
        return edge.flags.some((f) => f.status === 'risk_accepted');
      default:
        return true;
    }
  });
}

function FilterForm(props: {
  connections: Connections;
  view: string;
  consumerId: string;
  tokenId: string;
  repository: string;
  status: string;
}) {
  const repositories = props.connections.labels
    .filter((label) => label.claim === 'repository_id' || label.claim === 'project_id')
    .map((label) => ({ value: label.label, label: `${label.label} (${label.value})` }));
  return (
    <form
      method="get"
      action={paths.access()}
      role="search"
      aria-label="Filter consumer access"
      class="filters"
    >
      <input type="hidden" name="view" value={props.view} />
      <Select
        name="consumer"
        label="Consumer"
        value={props.consumerId}
        options={[
          { value: '', label: 'All consumers' },
          ...props.connections.consumers.map((consumer) => ({
            value: consumer.id,
            label: consumer.name,
          })),
        ]}
      />
      <Select
        name="token"
        label="Token"
        value={props.tokenId}
        options={[
          { value: '', label: 'All tokens' },
          ...props.connections.tokens.map((token) => ({ value: token.id, label: token.name })),
        ]}
      />
      <Field
        name="repository"
        label="Repository"
        type="search"
        value={props.repository}
        example="acme/api"
        hint="Name or ID."
        maxlength={200}
        suggestions={[...new Map(repositories.map((r) => [r.value, r])).values()]}
        autocomplete="off"
        spellcheck={false}
        autocapitalize="none"
      />
      <Select
        name="status"
        label="Status"
        value={props.status}
        options={[
          { value: '', label: 'Any status' },
          { value: 'active', label: 'Active' },
          { value: 'inactive', label: 'Inactive' },
          { value: 'expiring', label: 'Expiring in 14 days' },
          { value: 'unused', label: 'Unused 30 days' },
          { value: 'risk', label: 'Risk accepted' },
        ]}
      />
      <button type="submit" class="secondary">
        Apply
      </button>
    </form>
  );
}

function AccessList(props: { edges: AccessEdge[]; connections: Connections; ctx: ViewContext }) {
  const { ctx } = props;
  const rows = [...props.edges].sort(
    (a, b) =>
      (a.consumer?.name ?? '').localeCompare(b.consumer?.name ?? '') ||
      a.subject.localeCompare(b.subject) ||
      (a.token?.name ?? '').localeCompare(b.token?.name ?? ''),
  );
  return (
    <DataTable<AccessEdge>
      id="access-list"
      caption="Consumer access"
      rowHeader="subject"
      rows={rows}
      columns={[
        {
          key: 'consumer',
          header: 'Consumer',
          render: (edge) =>
            edge.consumer ? (
              <a href={paths.consumer(edge.consumer.id)}>{edge.consumer.name}</a>
            ) : (
              '—'
            ),
        },
        {
          key: 'subject',
          header: 'Repository / workflow',
          render: (edge) => <a href={paths.accessItem(edge.grant.id)}>{edge.subject}</a>,
        },
        { key: 'context', header: 'Constraint', render: (edge) => edge.context },
        {
          key: 'token',
          header: 'Token',
          render: (edge) =>
            edge.token ? <a href={paths.token(edge.token.id)}>{edge.token.name}</a> : '—',
        },
        {
          key: 'operations',
          header: 'Operations',
          render: (edge) =>
            edge.operations.length === 0
              ? '—'
              : `${edge.operations[0]}${edge.operations.length > 1 ? `; +${edge.operations.length - 1}` : ''}`,
        },
        {
          key: 'status',
          header: 'Status',
          render: (edge) => (
            <>
              <StatusBadge status={edge.status} detail={edge.statusDetail} />
              {edge.flags.map((flagItem) => (
                <>
                  {' '}
                  <StatusBadge status={flagItem.status} detail={flagItem.detail} />
                </>
              ))}
            </>
          ),
        },
        {
          key: 'expires',
          header: 'Expires',
          render: (edge) =>
            edge.grant.expires_at === null ? 'Never' : <Time ms={edge.grant.expires_at} />,
        },
        {
          key: 'last',
          header: 'Last used',
          render: (edge) =>
            edge.lastUsedHour === null
              ? 'No allowed calls in 30 days'
              : relativeTime(edge.lastUsedHour + HOUR_MS / 2, ctx.now),
        },
        ...(ctx.can('access:write')
          ? [
              {
                key: 'actions',
                header: 'Actions',
                render: (edge: AccessEdge) => (
                  <ActionButton
                    action={`${paths.accessItem(edge.grant.id)}/toggle`}
                    csrf={ctx.csrf}
                    label={edge.grant.enabled ? 'Disable' : 'Enable'}
                    context={edge.grant.name}
                    fields={{ enabled: edge.grant.enabled ? '0' : '1' }}
                    returnTo="list"
                  />
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// The form: data and model

interface FormData {
  connections: Connections;
  consumers: CallerProvider[];
  tokens: Service[];
}

async function loadFormData(c: AdminContext): Promise<FormData> {
  const connections = await loadConnections(c.get('deps'));
  const consumers = [...connections.consumers].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  );
  const tokens = [...connections.tokens].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  );
  return { connections, consumers, tokens };
}

/** What the form shows before the admin types: from the query (GET) or a failed POST. */
interface FormSeed {
  /** Submitted fields of a re-render; branches present in them keep their values. */
  fields: Fields | null;
  consumerId: string;
  tokenId: string;
  /** `consumer=new` was asked for: the consumer fieldset is the add form. */
  consumerView: 'fixed' | 'new' | 'auto';
  tokenView: 'fixed' | 'auto';
  /** Prefilled "Which jobs" of the chosen consumer (copy, from_request, repository). */
  jobs?: JobsForm | null;
  ops?: OpsForm | null;
  expiry?: ExpiryForm;
  errors: FieldError[];
  ack: { digest: string; warnings: string[] } | null;
  /** The `_action` of a re-render. */
  action?: string;
  /** The repository's organization or group to add (new_owner), for the chosen branch. */
  unknownOwner?: string | null;
  hidden?: Record<string, string>;
}

function labelsOf(connections: Connections, consumerId: string): ClaimLabel[] {
  return connections.labels.filter((label) => label.caller_provider_id === consumerId);
}

function grantCount(connections: Connections, consumerId: string): number {
  return connections.accesses.filter((edge) => edge.grant.caller_provider_id === consumerId).length;
}

function repositoryOptions(
  profile: Pick<IssuerProfile, 'id'>,
  labels: readonly ClaimLabel[],
  connections: Connections,
  consumerId: string,
): Suggestion[] {
  const claims = anchorClaims(profile);
  if (claims === null) return [];
  const use = new Map<string, number>();
  for (const edge of connections.accesses) {
    if (edge.grant.caller_provider_id !== consumerId) continue;
    for (const c of edge.grant.conditions) {
      if (c.claim !== claims.repository) continue;
      for (const value of c.values) use.set(value, (use.get(value) ?? 0) + 1);
    }
  }
  return labels
    .filter((label) => label.claim === claims.repository)
    .sort(
      (a, b) => (use.get(b.value) ?? 0) - (use.get(a.value) ?? 0) || a.label.localeCompare(b.label),
    )
    .map((label) => ({ value: idText(label.value, label.label) }));
}

/** A consumer built in memory from the add fields, for validation before anything is written. */
function pendingConsumer(
  input: ConsumerInput | null,
  type: ProfileId,
  existing: readonly CallerProvider[],
): CallerProvider {
  const profile = PROFILES[type];
  const claim = tenantClaimOf(type);
  const issuer = input ? consumerIssuer(input) : (profile.defaults.issuer ?? '');
  const match =
    claim !== null ? existing.find((p) => p.profile === type && p.issuer === issuer) : undefined;
  const pin: Condition[] = [];
  if (claim !== null) {
    const values = [
      ...new Set([
        ...(match?.tenant_pin.filter((c) => c.claim === claim).flatMap((c) => c.values) ?? []),
        ...(input?.tenants.map((t) => t.value) ?? []),
      ]),
    ];
    if (values.length > 0) pin.push({ claim, match: 'exact', values });
    for (const other of match?.tenant_pin.filter((c) => c.claim !== claim) ?? []) pin.push(other);
  }
  if (type === 'github-actions' && input?.enterprise_id && !match) {
    pin.push({ claim: 'enterprise_id', match: 'exact', values: [input.enterprise_id] });
  }
  if (type === 'generic' && input?.pin) {
    pin.push({ claim: input.pin.claim, match: 'exact', values: [input.pin.value] });
  }
  return {
    id: match?.id ?? 'cpr_new',
    name: match?.name ?? profile.label,
    profile: type,
    issuer,
    jwks_uri: match?.jwks_uri ?? issuer,
    audience: match?.audience ?? 'tokengate:pending-consumer-audience',
    allowed_algs: match?.allowed_algs ?? [...profile.defaults.allowedAlgs],
    max_token_age_seconds: match?.max_token_age_seconds ?? profile.defaults.maxTokenAgeSeconds,
    tenant_pin: pin,
    anchor_claims: type === 'generic' ? (input?.anchor_claims ?? ['sub']) : [],
    enabled: match?.enabled ?? true,
    created_at: 0,
    updated_at: match?.updated_at ?? 0,
  };
}

function pendingLabels(
  input: ConsumerInput | null,
  provider: CallerProvider,
  connections: Connections,
): ClaimLabel[] {
  const claim = tenantClaimOf(provider.profile);
  const stored = provider.id === 'cpr_new' ? [] : labelsOf(connections, provider.id);
  if (claim === null || !input) return stored;
  return withTypedLabels(
    stored,
    provider.id,
    input.tenants.map((t) => ({ claim, value: t.value, label: t.label })),
  );
}

async function consumerBranch(
  c: AdminContext,
  data: FormData,
  provider: CallerProvider,
  prefix: string,
  seed: FormSeed,
  selected: boolean,
  labelsOverride?: ClaimLabel[],
): Promise<ConsumerBranch | null> {
  const profile = getProfile(provider.profile);
  if (!profile) return null;
  const db = c.get('deps').env.DB;
  const shapes = provider.id === 'cpr_new' ? [] : await consumerAccessShapes(db, provider.id);
  const labels = labelsOverride ?? labelsOf(data.connections, provider.id);
  const suggestions = consumerSuggestions(shapes, provider);
  let jobs: JobsForm;
  if (seed.fields && (selected || seed.fields[`${prefix}editor`] !== undefined)) {
    jobs = readJobsForm(seed.fields, prefix, profile);
  } else if (selected && seed.jobs) {
    jobs = seed.jobs;
  } else {
    jobs = defaultJobs(profile, labels, shapes, suggestions.environments);
  }
  const branch: ConsumerBranch = {
    provider,
    profile,
    prefix,
    jobs,
    labels,
    suggestions,
    repositoryOptions: repositoryOptions(profile, labels, data.connections, provider.id),
    unknownOwner: selected ? (seed.unknownOwner ?? null) : null,
    accessCount: provider.id === 'cpr_new' ? 0 : grantCount(data.connections, provider.id),
  };
  if (selected && seed.action === 'rows') {
    branch.jobs = jobsToRows(branch.jobs, { profile, provider, labels, prefix });
  }
  if (selected && seed.action === 'add:cond') branch.extraRows = 2;
  return branch;
}

function defaultJobs(
  profile: IssuerProfile,
  labels: readonly ClaimLabel[],
  shapes: Awaited<ReturnType<typeof consumerAccessShapes>>,
  environments: readonly string[],
): JobsForm {
  const jobs = blankJobsForm(profile);
  const claims = anchorClaims(profile);
  if (claims) {
    const repositories = labels.filter((label) => label.claim === claims.repository);
    const [only] = repositories;
    if (repositories.length === 1 && only) jobs.repository = idText(only.value, only.label);
    jobs.context = mostUsedContext(shapes, profile);
    const [environment] = environments;
    if (environments.length === 1 && environment) jobs.environment = environment;
  }
  return jobs;
}

async function tokenBranch(
  c: AdminContext,
  data: FormData,
  token: Service,
  prefix: string,
  seed: FormSeed,
  selected: boolean,
): Promise<TokenBranch> {
  const shapes = await tokenAccessShapes(c.get('deps').env.DB, token.id);
  const template = templateForService(token);
  const sets = ruleSetsOf(shapes);
  let ops: OpsForm;
  if (seed.fields && (selected || seed.fields[`${prefix}ops`] !== undefined)) {
    ops = readOpsForm(seed.fields, prefix);
  } else if (selected && seed.ops) ops = seed.ops;
  else ops = defaultOpsForm(template, sets);
  return {
    token,
    template,
    ruleSets: sets,
    pathSuggestions: rulePathSuggestions(shapes),
    prefix,
    ops,
    credential: credentialText(token, data.connections.unreadableTokenIds, c.get('deps').now()),
    ...(selected && seed.action === 'add:rule' ? { extraRows: 2 } : {}),
  };
}

async function newConsumerBranch(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
  selected: boolean,
): Promise<NewConsumerBranch> {
  const form = seed.fields ? readConsumerForm(seed.fields, 'new.') : blankConsumerForm();
  if (!CONSUMER_TYPES.includes(form.type as ProfileId)) form.type = 'github-actions';
  const jobs = {} as Record<ProfileId, ConsumerBranch>;
  for (const type of CONSUMER_TYPES) {
    const parsed = parseConsumerForm({ ...form, type }, 'new.');
    const input = parsed.ok ? parsed.input : null;
    const provider = pendingConsumer(input, type, data.consumers);
    const branch = await consumerBranch(
      c,
      data,
      provider,
      `new.${type}.`,
      seed,
      selected && form.type === type,
      pendingLabels(input, provider, data.connections),
    );
    if (branch) jobs[type] = branch;
  }
  return { form, jobs };
}

async function buildFormModel(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
): Promise<AccessFormModel> {
  const ctxNow = c.get('deps').now();
  const fields = seed.fields;
  const consumers = data.consumers;
  const selectedConsumer = consumers.find((consumer) => consumer.id === seed.consumerId) ?? null;
  let consumer: ConsumerChoice;
  const queryBase = { token: seed.tokenId || undefined };
  if (
    consumers.length === 0 ||
    seed.consumerView === 'new' ||
    (seed.consumerId === 'new' && (consumers.length === 1 || consumers.length > MAX_CARDS))
  ) {
    consumer = {
      kind: 'new',
      newBranch: await newConsumerBranch(c, data, seed, true),
      existingHref: consumers.length > 0 ? paths.accessNew(queryBase) : null,
    };
  } else if (selectedConsumer && (consumers.length === 1 || seed.consumerView === 'fixed')) {
    const branch = await consumerBranch(c, data, selectedConsumer, '', seed, true);
    if (!branch) throw new Error('unknown consumer profile');
    consumer = {
      kind: 'fixed',
      branch,
      changeHref: consumers.length > 1 ? paths.accessNew(queryBase) : null,
      newHref: paths.accessNew({ ...queryBase, consumer: 'new' }),
    };
  } else if (consumers.length <= MAX_CARDS) {
    const branches: ConsumerBranch[] = [];
    for (const provider of consumers) {
      const branch = await consumerBranch(
        c,
        data,
        provider,
        `${provider.id}.`,
        seed,
        provider.id === seed.consumerId,
      );
      if (branch) branches.push(branch);
    }
    consumer = {
      kind: 'cards',
      branches,
      selected: seed.consumerId,
      newBranch: await newConsumerBranch(c, data, seed, seed.consumerId === 'new'),
    };
  } else {
    consumer = {
      kind: 'select',
      options: consumers,
      selected: seed.consumerId,
      branch: selectedConsumer
        ? await consumerBranch(c, data, selectedConsumer, `${selectedConsumer.id}.`, seed, true)
        : null,
    };
  }

  const tokens = data.tokens;
  const selectedToken = tokens.find((token) => token.id === seed.tokenId) ?? null;
  let token: TokenChoice;
  if (selectedToken && (tokens.length === 1 || seed.tokenView === 'fixed')) {
    token = {
      kind: 'fixed',
      branch: await tokenBranch(c, data, selectedToken, '', seed, true),
      changeHref:
        tokens.length > 1 ? paths.accessNew({ consumer: seed.consumerId || undefined }) : null,
    };
  } else if (tokens.length <= MAX_CARDS) {
    const branches: TokenBranch[] = [];
    for (const item of tokens) {
      branches.push(
        await tokenBranch(c, data, item, `${item.id}.`, seed, item.id === seed.tokenId),
      );
    }
    token = { kind: 'cards', branches, selected: seed.tokenId };
  } else {
    token = {
      kind: 'select',
      options: tokens,
      selected: seed.tokenId,
      branch: selectedToken
        ? await tokenBranch(c, data, selectedToken, `${selectedToken.id}.`, seed, true)
        : null,
    };
  }
  const hidden: Record<string, string> = { ...seed.hidden };
  if (consumer.kind === 'fixed' && consumers.length > 1) hidden.consumer_view = 'fixed';
  if (consumer.kind === 'new' && consumers.length > 0) hidden.consumer_view = 'new';
  if (token.kind === 'fixed' && tokens.length > 1) hidden.token_view = 'fixed';
  for (const branch of tokenBranches(token)) hidden[`${branch.prefix}ops`] = '1';
  return {
    action: paths.access(),
    csrf: c.get('viewer').csrfToken,
    mode: 'create',
    consumer,
    token,
    existingConsumers: consumers,
    expiry: fields ? readExpiryForm(fields) : (seed.expiry ?? { expires: 'never', expires_on: '' }),
    now: ctxNow,
    ack: seed.ack,
    errors: seed.errors,
    hidden,
    focus: focusOf(seed, consumer, token),
  };
}

function tokenBranches(choice: TokenChoice): TokenBranch[] {
  if (choice.kind === 'cards') return choice.branches;
  return choice.branch ? [choice.branch] : [];
}

function focusOf(
  seed: FormSeed,
  consumer: ConsumerChoice,
  token: TokenChoice,
): AccessFormModel['focus'] {
  if (seed.action === 'add:cond') {
    const branch = chosenConsumerBranch(consumer);
    if (branch)
      return { group: `${branch.prefix}cond`, index: Math.max(branch.jobs.cond.length, 1) + 2 };
  }
  if (seed.action === 'add:rule') {
    const branch = chosenTokenBranch(token);
    if (branch) return { group: `${branch.prefix}rule`, index: branch.ops.rule.length + 2 };
  }
  return null;
}

function chosenConsumerBranch(choice: ConsumerChoice): ConsumerBranch | null {
  if (choice.kind === 'fixed') return choice.branch;
  if (choice.kind === 'select') return choice.branch;
  if (choice.kind === 'new')
    return choice.newBranch.jobs[choice.newBranch.form.type as ProfileId] ?? null;
  if (choice.selected === 'new')
    return choice.newBranch.jobs[choice.newBranch.form.type as ProfileId] ?? null;
  return choice.branches.find((branch) => branch.provider.id === choice.selected) ?? null;
}

function chosenTokenBranch(choice: TokenChoice): TokenBranch | null {
  if (choice.kind === 'fixed' || choice.kind === 'select') return choice.branch;
  return choice.branches.find((branch) => branch.token.id === choice.selected) ?? null;
}

async function renderForm(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
  options: {
    status?: 200 | 400 | 409 | 422;
    banner?: Child;
    notice?: ReturnType<typeof notice>;
  } = {},
) {
  if (data.tokens.length === 0) {
    return renderPage(
      c,
      {
        title: 'Give a consumer access',
        section: 'consumers',
        subsection: 'access',
        status: options.status ?? 200,
      },
      (ctx) => (
        <EmptyState
          action={
            ctx.can('tokens:write') ? (
              <a class="button" href={paths.tokenNew()}>
                Add a service token
              </a>
            ) : (
              <AskSomeone permission="tokens:write" ctx={ctx} verb="add one" />
            )
          }
        >
          A token manager must add a service token first.
        </EmptyState>
      ),
    );
  }
  const model = await buildFormModel(c, data, seed);
  return renderPage(
    c,
    {
      title: 'Give a consumer access',
      section: 'consumers',
      subsection: 'access',
      breadcrumbs: [
        { href: paths.access(), label: 'Consumer access' },
        { href: paths.accessNew(), label: 'Give a consumer access' },
      ],
      errors: seed.errors,
      status: options.status ?? 200,
      notice: seed.errors.length > 0 ? null : (options.notice ?? null),
    },
    () => (
      <>
        {options.banner ? <div class="prefill">{options.banner}</div> : null}
        <AccessForm model={model} />
      </>
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// GET /admin/access/new

async function newPage(c: AdminContext) {
  const data = await loadFormData(c);
  const query = (name: string) => c.req.query(name) ?? '';
  const fromRequest = query('from_request');
  if (fromRequest) return prefillFromRequest(c, data, fromRequest);
  let consumerId = query('consumer');
  let tokenId = query('token');
  let jobs: JobsForm | null = null;
  let ops: OpsForm | null = null;
  let banner: Child | null = null;
  const copyId = query('copy');
  if (copyId) {
    const source = await getGrant(c.get('deps').env.DB, copyId);
    const sourceConsumer = source
      ? data.consumers.find((p) => p.id === source.caller_provider_id)
      : undefined;
    const profile = sourceConsumer ? getProfile(sourceConsumer.profile) : null;
    if (source && sourceConsumer && profile) {
      consumerId = sourceConsumer.id;
      tokenId = tokenId || source.service_id;
      const labels = labelsOf(data.connections, sourceConsumer.id);
      jobs = accessFormFromGrant(source, profile, labels);
      const repository = query('repository');
      if (repository && jobs.editor === 'structured') {
        const claims = anchorClaims(profile);
        const label = claims ? labelFor(labels, claims.repository, repository) : null;
        jobs.repository = idText(repository, label);
      }
      const target = data.tokens.find((token) => token.id === tokenId);
      const sourceToken = data.tokens.find((token) => token.id === source.service_id);
      if (target && sourceToken && sameOperationSource(target, sourceToken)) {
        const sets = ruleSetsOf(await tokenAccessShapes(c.get('deps').env.DB, target.id));
        ops = opsFormFromRules(
          source.rules,
          templateForService(target),
          sets,
          repositoryLabelOf(source, labels, profile),
        );
        if (repository) {
          ops = opsFormFromRules(
            source.rules,
            templateForService(target),
            sets,
            repositoryLabelOf(source, labels, profile),
          );
        }
      }
      banner = <p>Copied the constraints of “{source.name}”.</p>;
    } else {
      banner = <p>That access no longer exists; nothing was copied.</p>;
    }
  } else if (query('repository') && consumerId) {
    const provider = data.consumers.find((p) => p.id === consumerId);
    const profile = provider ? getProfile(provider.profile) : null;
    const claims = profile ? anchorClaims(profile) : null;
    if (provider && profile && claims) {
      const labels = labelsOf(data.connections, provider.id);
      const shapes = await consumerAccessShapes(c.get('deps').env.DB, provider.id);
      jobs = defaultJobs(
        profile,
        labels,
        shapes,
        consumerSuggestions(shapes, provider).environments,
      );
      jobs.repository = idText(
        query('repository'),
        labelFor(labels, claims.repository, query('repository')),
      );
    }
  }
  if (query('mode') === 'rows' && consumerId && consumerId !== 'new') {
    const provider = data.consumers.find((p) => p.id === consumerId);
    const profile = provider ? getProfile(provider.profile) : null;
    if (provider && profile) {
      jobs = {
        ...(jobs ?? blankJobsForm(profile)),
        editor: 'rows',
        cond: jobs?.editor === 'rows' ? jobs.cond : [],
      };
    }
  }
  const knownConsumer = data.consumers.some((p) => p.id === consumerId);
  const seed: FormSeed = {
    fields: null,
    consumerId:
      knownConsumer || consumerId === 'new'
        ? consumerId
        : data.consumers.length === 1
          ? (data.consumers[0]?.id ?? '')
          : '',
    tokenId: data.tokens.some((token) => token.id === tokenId)
      ? tokenId
      : data.tokens.length === 1
        ? (data.tokens[0]?.id ?? '')
        : '',
    consumerView: consumerId === 'new' ? 'new' : knownConsumer ? 'fixed' : 'auto',
    tokenView: data.tokens.some((token) => token.id === tokenId) ? 'fixed' : 'auto',
    jobs,
    ops,
    errors: [],
    ack: null,
  };
  // Prefilled risky values need an explicit acknowledgement on this render (A7.7 rule 4).
  if (copyId && jobs) seed.ack = await prefillAck(c, data, seed);
  const consumerForNotice = data.consumers.find((p) => p.id === consumerId) ?? null;
  return renderForm(c, data, seed, {
    ...(banner ? { banner } : {}),
    notice: notice(c, { grant: null, consumer: consumerForNotice }),
  });
}

function repositoryLabelOf(
  grant: Pick<Grant, 'conditions'>,
  labels: readonly ClaimLabel[],
  profile: Pick<IssuerProfile, 'id'>,
): string | null {
  const claims = anchorClaims(profile);
  if (claims === null) return null;
  const id = grant.conditions.find(
    (c) => c.claim === claims.repository && c.match === 'exact' && c.negate !== true,
  )?.values[0];
  return id === undefined ? null : labelFor(labels, claims.repository, id);
}

/** Copying keeps the operations when the target token has the same operation source. */
function sameOperationSource(target: Service, source: Service): boolean {
  if (target.id === source.id) return true;
  const a = templateForService(target);
  const b = templateForService(source);
  return a !== null && b !== null && a.id === b.id;
}

/** The acknowledgement a prefilled form needs on its first render, or null. */
async function prefillAck(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
): Promise<FormSeed['ack']> {
  const evaluation = await evaluateForm(c, data, { ...seed, fields: null }, null);
  if (!evaluation.ok || evaluation.risks.messages.length === 0) return null;
  return { digest: evaluation.risks.digest, warnings: evaluation.risks.messages };
}

/** `?from_request=`: an access matching exactly the caller of a denied, verified request. */
async function prefillFromRequest(c: AdminContext, data: FormData, requestId: string) {
  const deps = c.get('deps');
  const record = await getRequest(deps.env.TELEMETRY_DB, requestId);
  const claims = record ? parseJson(record.caller_claims) : null;
  const provider = record?.caller_provider_id
    ? data.consumers.find((p) => p.id === record.caller_provider_id)
    : undefined;
  const token = record?.service_id
    ? data.tokens.find((t) => t.id === record.service_id)
    : undefined;
  const profile = provider ? getProfile(provider.profile) : null;
  const usable =
    record !== null &&
    record.claims_verified === 1 &&
    accessFixable(record.reason) &&
    isRecord(claims) &&
    provider !== undefined &&
    token !== undefined &&
    profile !== null;
  if (!usable || !record || !isRecord(claims) || !provider || !token || !profile) {
    return renderPage(
      c,
      {
        title: 'Cannot give access from this request',
        section: 'consumers',
        subsection: 'access',
        status: 400,
      },
      () => (
        <>
          <p>
            Only requests that were denied with “no matching access” or “event not trusted”, whose
            token was verified, and whose consumer and token still exist can prefill the form.
          </p>
          <p>
            <a href={paths.accessNew()}>Give a consumer access from scratch</a>
          </p>
        </>
      ),
    );
  }
  const jobs = jobsFromClaims(profile, provider, claims, record.reason);
  const template = templateForService(token);
  const sets = ruleSetsOf(await tokenAccessShapes(deps.env.DB, token.id));
  const repositoryLabel = claimText(
    claims,
    profile.id === 'gitlab-ci' ? 'project_path' : 'repository',
  );
  const ops = opsFromCall(record.method, record.path, template, sets, repositoryLabel);
  const literalPath = !/\*|%2f/i.test(record.path);
  const seed: FormSeed = {
    fields: null,
    consumerId: provider.id,
    tokenId: token.id,
    consumerView: 'fixed',
    tokenView: 'fixed',
    jobs,
    ops,
    errors: [],
    ack: null,
  };
  seed.ack = await prefillAck(c, data, seed);
  return renderForm(c, data, seed, {
    banner: (
      <p>
        Prefilled from request <a href={paths.request(record.id)}>{record.id}</a>: these values
        match exactly that caller and call. Change what you need, then save.
        {ops.op.length === 0 && ops.rule.length === 0
          ? literalPath
            ? ''
            : ' No operation was prefilled: the path contains "*" or "%2F", which an operation cannot match literally ("*" is a wildcard; "%2F" needs "**"). Add the narrowest one under Other operations.'
          : ''}
      </p>
    ),
  });
}

/** Structured "Which jobs" values from a verified request's claims, or rows for other events. */
function jobsFromClaims(
  profile: IssuerProfile,
  provider: CallerProvider,
  claims: Record<string, unknown>,
  reason: string | null,
): JobsForm {
  const jobs = blankJobsForm(profile);
  const claim = (name: string) => claimText(claims, name);
  const event = profile.eventClaim ? claim(profile.eventClaim) : null;
  const rowsForEvent =
    reason === 'event_not_trusted' &&
    !(profile.id === 'github-actions' && event === 'pull_request');
  if (profile.id === 'generic' || rowsForEvent) {
    return {
      ...jobs,
      editor: 'rows',
      cond: condRows(prefillConditions(profile, provider, claims)),
    };
  }
  const gitlab = profile.id === 'gitlab-ci';
  const repository = claim(gitlab ? 'project_path' : 'repository');
  const repositoryId = claim(gitlab ? 'project_id' : 'repository_id');
  if (repository && repositoryId) jobs.repository = `${repository} (${repositoryId})`;
  const owner = claim(gitlab ? 'namespace_id' : 'repository_owner_id');
  if (owner) jobs.owner_id = owner;
  const ref = claim('ref') ?? '';
  const environment = claim('environment');
  const refType = claim('ref_type');
  jobs.ref_protection = claim('ref_protected') === 'true' ? 'protected' : 'unprotected';
  if (environment) {
    jobs.context = 'environment';
    jobs.environment = environment;
  } else if (!gitlab && event === 'pull_request') {
    jobs.context = 'pull_request';
    jobs.pr_base = claim('base_ref') ?? '';
  } else if (refType === 'tag' || ref.startsWith('refs/tags/')) {
    const name = ref.replace(/^refs\/tags\//, '');
    if (!gitlab && event === 'release') {
      jobs.context = 'release';
      jobs.release_tag = name;
    } else {
      jobs.context = 'tag';
      jobs.tag = name;
    }
  } else {
    jobs.context = 'branch';
    jobs.branch = ref.replace(/^refs\/heads\//, '');
  }
  return jobs;
}

/** Claims copied from a request record besides the anchors, per profile. */
const PREFILL_EXTRA_CLAIMS: Record<string, string[]> = {
  'github-actions': ['ref', 'event_name', 'environment'],
  'gitlab-ci': ['ref', 'pipeline_source', 'environment'],
  generic: [],
};

/** Exact conditions on the first anchor rule the stored claims satisfy, plus ref/event/environment. */
function prefillConditions(
  profile: IssuerProfile,
  provider: CallerProvider,
  claims: Record<string, unknown>,
): Condition[] {
  const anchorRules = profile.anchorRules(provider);
  const anchors =
    anchorRules.find((rule) => rule.every((claim) => claimText(claims, claim) !== null)) ??
    anchorRules[0] ??
    [];
  const conditions: Condition[] = [];
  for (const claim of [...anchors, ...(PREFILL_EXTRA_CLAIMS[profile.id] ?? [])]) {
    const value = claimText(claims, claim);
    if (value !== null && !conditions.some((c) => c.claim === claim)) {
      conditions.push({ claim, match: 'exact', values: [value] });
    }
  }
  return conditions;
}

/** The operation of a call as a preset, a rule set, or one custom row (never a wildcard path). */
function opsFromCall(
  method: string,
  path: string,
  template: ReturnType<typeof templateForService>,
  sets: ReturnType<typeof ruleSetsOf>,
  repositoryLabel: string | null,
): OpsForm {
  // Rule paths have no escape syntax: "*" would become a wildcard and "%2F" is matched only
  // through "**" (src/policy/evaluate.ts). Neither gets a prefilled operation.
  if (/\*|%2f/i.test(path)) return { op: [], rule: [] };
  // A preset or rule set is chosen only when one of its rules is exactly the call.
  const matches = (rule: Rule) =>
    rule.path === path &&
    (rule.methods.includes('*') || rule.methods.includes(method as Rule['methods'][number]));
  for (const preset of template?.operation_presets ?? []) {
    const rules = preset.rules.map((rule) => ({
      ...rule,
      path: rule.path.replaceAll('{repo}', repositoryLabel ?? '\u0000'),
    }));
    if (rules.some(matches)) return { op: [preset.id], rule: [] };
  }
  for (const set of sets) {
    if (set.rules.some(matches)) return { op: [set.id], rule: [] };
  }
  return { op: [], rule: [{ m: [method], path }] };
}

// ---------------------------------------------------------------------------------------------
// Evaluating a submitted (or prefilled) form

interface Risks {
  codes: WarningCode[];
  messages: string[];
  digest: string;
}

type Evaluation =
  | {
      ok: true;
      provider: CallerProvider;
      profile: IssuerProfile;
      token: Service;
      consumerInput: ConsumerInput | null;
      jobs: JobsForm;
      conditions: Condition[];
      rules: Rule[];
      labels: GrantLabel[];
      newOwner: { id: string; label: string } | null;
      /** Field name prefix of the chosen consumer branch. */
      prefix: string;
      expiresAt: number | null;
      name: string;
      risks: Risks;
      covered: Set<WarningCode>;
    }
  | { ok: false; errors: FieldError[]; unknownOwner: string | null; refresh?: boolean };

/** The chosen consumer branch of the submitted (or seeded) form: its provider, prefix and jobs. */
function chosenBranch(
  data: FormData,
  seed: FormSeed,
):
  | { provider: CallerProvider; prefix: string; consumerInput: ConsumerInput | null }
  | { error: FieldError }
  | null {
  const fields = seed.fields;
  const consumers = data.consumers;
  if (seed.consumerId === 'new' || consumers.length === 0) {
    const form: ConsumerForm = fields ? readConsumerForm(fields, 'new.') : blankConsumerForm();
    const parsed = parseConsumerForm(form, 'new.');
    if (!parsed.ok)
      return {
        error: parsed.errors[0] ?? { field: 'new.type', message: 'Choose a consumer type.' },
      };
    const type = parsed.input.profile;
    return {
      provider: pendingConsumer(parsed.input, type, consumers),
      prefix: `new.${type}.`,
      consumerInput: parsed.input,
    };
  }
  const provider = consumers.find((p) => p.id === seed.consumerId);
  if (!provider) return null;
  const fixed = consumers.length === 1 || seed.consumerView === 'fixed';
  return { provider, prefix: fixed ? '' : `${provider.id}.`, consumerInput: null };
}

async function evaluateForm(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
  editing: Grant | null,
): Promise<Evaluation> {
  const deps = c.get('deps');
  const errors: FieldError[] = [];
  const fields = seed.fields;
  let consumerErrors: FieldError[] = [];
  let branch: {
    provider: CallerProvider;
    prefix: string;
    consumerInput: ConsumerInput | null;
  } | null = null;
  if (editing) {
    const provider = data.consumers.find((p) => p.id === editing.caller_provider_id);
    if (provider) branch = { provider, prefix: '', consumerInput: null };
  } else {
    const chosen = chosenBranch(data, seed);
    if (chosen && 'error' in chosen) {
      // Collect every add-consumer error, not only the first.
      const form: ConsumerForm = fields ? readConsumerForm(fields, 'new.') : blankConsumerForm();
      const parsed = parseConsumerForm(form, 'new.');
      consumerErrors = parsed.ok ? [chosen.error] : parsed.errors;
    } else branch = chosen;
  }
  if (!branch && consumerErrors.length === 0) {
    errors.push({ field: 'consumer_id', message: 'Choose a consumer.' });
  }
  const tokenId = editing ? editing.service_id : seed.tokenId;
  const token = data.tokens.find((item) => item.id === tokenId) ?? null;
  if (!token) errors.push({ field: 'token_id', message: 'Choose a token.' });
  if (!branch || !token)
    return { ok: false, errors: [...consumerErrors, ...errors], unknownOwner: null };
  const profile = getProfile(branch.provider.profile);
  if (!profile)
    return {
      ok: false,
      errors: [{ field: null, message: 'The consumer has an unknown type.' }],
      unknownOwner: null,
    };

  const tokenFixed = editing !== null || data.tokens.length === 1 || seed.tokenView === 'fixed';
  const opsPrefix = tokenFixed ? '' : `${token.id}.`;
  const jobsPrefix = branch.prefix;
  // A select without "Show fields": the chosen branch's fields were not on the page.
  const consumerSelect =
    !editing &&
    jobsPrefix !== '' &&
    !jobsPrefix.startsWith('new.') &&
    data.consumers.length > MAX_CARDS;
  const tokenSelect = !tokenFixed && data.tokens.length > MAX_CARDS;
  if (
    fields &&
    ((consumerSelect && fields[`${jobsPrefix}editor`] === undefined) ||
      (tokenSelect && fields[`${opsPrefix}ops`] === undefined))
  ) {
    return { ok: false, errors: [], unknownOwner: null, refresh: true };
  }
  const labels = branch.consumerInput
    ? pendingLabels(branch.consumerInput, branch.provider, data.connections)
    : labelsOf(data.connections, branch.provider.id);
  const jobs = fields
    ? readJobsForm(fields, jobsPrefix, profile)
    : (seed.jobs ?? blankJobsForm(profile));
  const parsedJobs = parseJobs(jobs, {
    profile,
    provider: branch.provider,
    labels,
    prefix: jobsPrefix,
  });
  const sets = ruleSetsOf(await tokenAccessShapes(deps.env.DB, token.id));
  const template = templateForService(token);
  const ops = fields
    ? readOpsForm(fields, opsPrefix)
    : (seed.ops ?? defaultOpsForm(template, sets));
  const parsedOps = parseOps(ops, {
    token,
    template,
    ruleSets: sets,
    repositoryLabel: parsedJobs.repository?.label ?? null,
    prefix: opsPrefix,
  });
  const expiry = parseExpiry(
    fields ? readExpiryForm(fields) : (seed.expiry ?? { expires: 'never', expires_on: '' }),
    deps.now(),
    editing ? editing.expires_at : undefined,
  );
  errors.push(...consumerErrors, ...parsedJobs.errors, ...parsedOps.errors);
  if (!expiry.ok) errors.push(expiry.error);
  if (errors.length > 0 || !parsedJobs.conditions || !parsedOps.rules || !expiry.ok) {
    return { ok: false, errors, unknownOwner: parsedJobs.unknownOwner };
  }

  // The consumer the access is checked against: with the new organization when one is added.
  let provider = branch.provider;
  let checkLabels = labels;
  const claims = anchorClaims(profile);
  if (parsedJobs.newOwner && claims) {
    provider = {
      ...provider,
      tenant_pin: [
        ...provider.tenant_pin.filter((c) => c.claim !== claims.owner),
        {
          claim: claims.owner,
          match: 'exact',
          values: [
            ...provider.tenant_pin.filter((c) => c.claim === claims.owner).flatMap((c) => c.values),
            parsedJobs.newOwner.id,
          ],
        },
      ],
    };
    checkLabels = withTypedLabels(labels, provider.id, [
      { claim: claims.owner, value: parsedJobs.newOwner.id, label: parsedJobs.newOwner.label },
    ]);
  }
  const nameLabels = withTypedLabels(checkLabels, provider.id, parsedJobs.labels);
  const derivedName = deriveAccessName(token.name, parsedJobs.conditions, nameLabels);
  let name = derivedName;
  if (editing) {
    const storedDerived = deriveAccessName(token.name, editing.conditions, labels);
    name = editing.name === storedDerived ? derivedName : editing.name;
  }
  const checked = await checkGrant(
    deps,
    provider.id,
    token.id,
    {
      name,
      description: editing?.description ?? '',
      conditions: parsedJobs.conditions,
      rules: parsedOps.rules,
      enabled: editing?.enabled ?? true,
      expires_at: expiry.value,
    },
    {
      expiryChanged: editing ? expiry.value !== editing.expires_at : expiry.value !== null,
      acknowledged: true,
      provider,
    },
  );
  if (!checked.ok) {
    return {
      ok: false,
      errors: checked.errors.map((message) => ({
        field: grantErrorField(message, jobs, jobsPrefix),
        message: grantErrorMessage(message),
      })),
      unknownOwner: parsedJobs.unknownOwner,
    };
  }
  const risks = await risksOf(checked.warningDetails, parsedJobs.risks, parsedJobs.presetWarnings);
  return {
    ok: true,
    provider,
    profile,
    token,
    consumerInput: branch.consumerInput,
    jobs,
    conditions: parsedJobs.conditions,
    rules: parsedOps.rules,
    labels: parsedJobs.labels,
    newOwner: parsedJobs.newOwner,
    prefix: jobsPrefix,
    expiresAt: expiry.value,
    name,
    risks,
    covered: coveredRiskCodes(jobs),
  };
}

/** The risks of a result: the validator's warnings plus the builder's own risk choices. */
async function risksOf(
  details: readonly WarningDetail[],
  presetRisks: readonly string[],
  presetWarnings: readonly string[],
): Promise<Risks> {
  const codes = new Set<WarningCode>(details.map((detail) => detail.code));
  const messages = details.map((detail) => detail.message);
  presetRisks.forEach((risk, index) => {
    if (codes.has(risk as WarningCode)) return;
    codes.add(risk as WarningCode);
    const message = presetWarnings[index];
    if (message) messages.push(message);
  });
  const sorted = [...messages].sort();
  return { codes: [...codes].sort(), messages, digest: await sha256Hex(JSON.stringify(sorted)) };
}

/** The input a validateGrant error belongs to. */
function grantErrorField(message: string, jobs: JobsForm, prefix: string): string | null {
  if (
    message.includes('I-AUTHZ-2') ||
    message.includes('tenant pin') ||
    message.includes('outside')
  ) {
    return jobs.editor === 'rows' ? `${prefix}cond.0.values` : `${prefix}repository`;
  }
  if (message.startsWith('expiry')) return 'expires_on';
  if (message.startsWith('condition'))
    return jobs.editor === 'rows' ? `${prefix}cond.0.values` : null;
  return null;
}

function grantErrorMessage(message: string): string {
  if (message.includes('I-AUTHZ-2')) {
    return `Each access needs exact, non-negated conditions on the consumer's anchor claims: ${message.replace(/^the grant must have /, '')}`;
  }
  if (message.includes("outside the caller provider's tenant pin")) {
    return `${message.replace("outside the caller provider's tenant pin", 'are not organizations or groups of this consumer')}. Add them to the consumer first.`;
  }
  return message;
}

/** A7.7: is the risk set of this result accepted by the selection or by the digest and the box? */
async function acceptance(
  fields: Fields,
  evaluation: Extract<Evaluation, { ok: true }>,
): Promise<
  { ok: true } | { ok: false; error: FieldError; ack: { digest: string; warnings: string[] } }
> {
  const { risks, covered } = evaluation;
  const ack = { digest: risks.digest, warnings: risks.messages };
  const submittedDigest = text(fields, 'warnings_digest');
  if (submittedDigest !== '') {
    if (submittedDigest !== risks.digest) {
      if (risks.codes.length === 0) return { ok: true };
      return {
        ok: false,
        ack,
        error: {
          field: 'acknowledge_warnings',
          message: 'The risks changed: review them and tick the box again.',
        },
      };
    }
    if (risks.codes.length > 0 && !flag(fields, 'acknowledge_warnings')) {
      return {
        ok: false,
        ack,
        error: { field: 'acknowledge_warnings', message: 'Tick the box to accept these risks.' },
      };
    }
    return { ok: true };
  }
  const uncovered = risks.codes.filter((code) => !covered.has(code));
  if (uncovered.length > 0) {
    return {
      ok: false,
      ack,
      error: {
        field: 'acknowledge_warnings',
        message: 'Review these risks and tick the box to accept them.',
      },
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// POST /admin/access

function seedFromFields(data: FormData, fields: Fields): FormSeed {
  const consumerId = text(fields, 'consumer_id');
  const tokenId = text(fields, 'token_id');
  const consumerView = text(fields, 'consumer_view');
  return {
    fields,
    consumerId: consumerId || (data.consumers.length === 0 ? 'new' : ''),
    tokenId,
    consumerView: consumerView === 'fixed' ? 'fixed' : consumerView === 'new' ? 'new' : 'auto',
    tokenView: text(fields, 'token_view') === 'fixed' ? 'fixed' : 'auto',
    errors: [],
    ack: null,
  };
}

const SUB_ACTIONS = ['rows', 'add:cond', 'add:rule', 'refresh'];

async function create(c: AdminContext) {
  const deps = c.get('deps');
  const actor = adminActor(c);
  const fields = await formData(c);
  const data = await loadFormData(c);
  const seed = seedFromFields(data, fields);
  const action = text(fields, '_action');
  if (SUB_ACTIONS.includes(action)) return renderForm(c, data, { ...seed, action });

  const evaluation = await evaluateForm(c, data, seed, null);
  if (!evaluation.ok) {
    if (evaluation.refresh) return renderForm(c, data, { ...seed, action: 'refresh' });
    return renderForm(
      c,
      data,
      { ...seed, errors: evaluation.errors, unknownOwner: evaluation.unknownOwner },
      { status: 422 },
    );
  }
  const accepted = await acceptance(fields, evaluation);
  if (!accepted.ok) {
    return renderForm(
      c,
      data,
      { ...seed, errors: [accepted.error], ack: accepted.ack },
      { status: 422 },
    );
  }

  // Step 4: the consumer (new, or merged) and a new organization, each its own audited change.
  let providerId = evaluation.provider.id;
  let savedConsumer: CallerProvider | null = null;
  if (evaluation.consumerInput) {
    const consumerForm = readConsumerForm(fields, 'new.');
    const created = await createOrMergeConsumer(deps, actor, evaluation.consumerInput);
    if (!created.ok) {
      return renderForm(
        c,
        data,
        { ...seed, errors: consumerFailureErrors(consumerForm, created, 'new.') },
        { status: failureStatus(created) },
      );
    }
    providerId = created.callerProvider.id;
    savedConsumer = created.callerProvider;
  }
  if (evaluation.newOwner) {
    const claim = tenantClaimOf(evaluation.profile.id);
    if (claim) {
      const added = await addTenantValue(deps, actor, providerId, {
        claim,
        entries: [{ value: evaluation.newOwner.id, label: evaluation.newOwner.label }],
      });
      if (!added.ok) {
        const reloaded = await loadFormData(c);
        return renderForm(
          c,
          reloaded,
          {
            ...seedAfterConsumerSaved(seed, providerId, savedConsumer),
            errors: [
              ...(savedConsumer ? [savedNote(savedConsumer)] : []),
              ...added.errors.map((message) => ({
                field: `${savedConsumer ? '' : evaluation.prefix}new_owner`,
                message,
              })),
            ],
          },
          { status: failureStatus(added) },
        );
      }
    }
  }
  const result = await createGrant(deps, actor, {
    name: evaluation.name,
    caller_provider_id: providerId,
    service_id: evaluation.token.id,
    conditions: evaluation.conditions,
    rules: evaluation.rules,
    expires_at: evaluation.expiresAt,
    acknowledge_warnings: true,
    accepted_risks: evaluation.risks.codes,
    labels: evaluation.labels,
  });
  if (result.ok) return redirectWithNotice(c, paths.accessItem(result.grant.id), 'created');
  // Step 6: the consumer may already be saved; keep everything and preselect it.
  const reloaded = savedConsumer ? await loadFormData(c) : data;
  return renderForm(
    c,
    reloaded,
    {
      ...(savedConsumer ? seedAfterConsumerSaved(seed, providerId, savedConsumer) : seed),
      errors: [
        ...(savedConsumer ? [savedNote(savedConsumer)] : []),
        ...result.errors.map((message) => ({ field: null, message: grantErrorMessage(message) })),
      ],
    },
    { status: failureStatus(result) },
  );
}

function savedNote(consumer: CallerProvider): FieldError {
  return {
    field: null,
    message: `Consumer ${consumer.name} was saved; the access was not. Fix the errors and save again.`,
  };
}

/**
 * After an inline consumer create succeeded and the access failed: the new consumer is fixed, and
 * the access values move from the `new.<type>.` branch to the unprefixed one, so nothing is lost.
 */
function seedAfterConsumerSaved(
  seed: FormSeed,
  providerId: string,
  saved: CallerProvider | null,
): FormSeed {
  if (!saved || !seed.fields) return seed;
  const prefix = `new.${saved.profile}.`;
  const fields: Fields = Object.create(null);
  for (const [name, value] of Object.entries(seed.fields)) {
    if (name.startsWith('new.')) {
      if (name.startsWith(prefix)) fields[name.slice(prefix.length)] = value;
      continue;
    }
    fields[name] = value;
  }
  fields.consumer_id = providerId;
  return { ...seed, fields, consumerId: providerId, consumerView: 'fixed' };
}

function failureStatus(failure: OpFailure): 409 | 422 {
  return failure.reason === 'conflict' ? 409 : 422;
}

// ---------------------------------------------------------------------------------------------
// Access page

async function loadAccess(c: AdminContext, data?: FormData) {
  const deps = c.get('deps');
  const grant = await getGrant(deps.env.DB, c.req.param('id') ?? '');
  if (!grant) return null;
  const formData_ = data ?? (await loadFormData(c));
  const consumer = formData_.consumers.find((p) => p.id === grant.caller_provider_id);
  const token = formData_.tokens.find((t) => t.id === grant.service_id);
  const profile = consumer ? getProfile(consumer.profile) : null;
  const edge = formData_.connections.accesses.find((item) => item.grant.id === grant.id);
  if (!consumer || !token || !profile || !edge) return null;
  return { grant, consumer, token, profile, edge, data: formData_ };
}

type LoadedAccess = NonNullable<Awaited<ReturnType<typeof loadAccess>>>;

interface PageState {
  edit?: {
    fields: Fields | null;
    errors: FieldError[];
    ack: { digest: string; warnings: string[] } | null;
    action?: string;
    unknownOwner?: string | null;
  };
  rename?: { name: string; description: string; errors: Record<string, string> };
  copy?: { repository: string; tokenId: string; errors: Record<string, string> };
  errors?: FieldError[];
  status?: 200 | 400 | 409 | 422;
}

async function detailPage(c: AdminContext) {
  const loaded = await loadAccess(c);
  if (!loaded) return notFound(c);
  return renderAccessPage(c, loaded, {
    edit: c.req.query('open') === 'edit' ? { fields: null, errors: [], ack: null } : undefined,
  });
}

async function renderAccessPage(c: AdminContext, loaded: LoadedAccess, state: PageState) {
  const { grant, consumer, token, profile, edge, data } = loaded;
  const deps = c.get('deps');
  const labels = labelsOf(data.connections, consumer.id);
  const validation = validateGrant(
    { conditions: grant.conditions, rules: grant.rules },
    profile,
    consumer,
    token,
  );
  const overlapKeys = new Set(anchorsOf(edge, labels).map((anchor) => anchor.key));
  const overlaps = data.connections.accesses.filter(
    (other) =>
      other.grant.id !== grant.id &&
      other.grant.enabled &&
      other.grant.caller_provider_id === consumer.id &&
      other.grant.service_id === token.id &&
      anchorsOf(other, labels).some(
        (anchor) => overlapKeys.has(anchor.key) && !anchor.key.startsWith('custom:'),
      ),
  );
  const template = templateForService(token);
  const sets = ruleSetsOf(await tokenAccessShapes(deps.env.DB, token.id));
  const editing = state.edit;
  const editJobs = editing?.fields ? null : accessFormFromGrant(grant, profile, labels);
  const editSeed: FormSeed = {
    fields: editing?.fields ?? null,
    consumerId: consumer.id,
    tokenId: token.id,
    consumerView: 'fixed',
    tokenView: 'fixed',
    jobs: editJobs,
    ops: editing?.fields
      ? null
      : opsFormFromRules(grant.rules, template, sets, repositoryLabelOf(grant, labels, profile)),
    errors: editing?.errors ?? [],
    ack: editing?.ack ?? null,
    action: editing?.action,
    unknownOwner: editing?.unknownOwner ?? null,
  };
  const consumerBranchModel = await consumerBranch(c, data, consumer, '', editSeed, true);
  const tokenBranchModel = await tokenBranch(c, data, token, '', editSeed, true);
  const edit: AccessFormModel | null = consumerBranchModel
    ? {
        action: paths.accessItem(grant.id),
        csrf: c.get('viewer').csrfToken,
        mode: 'edit',
        version: String(grant.updated_at),
        consumer: { kind: 'fixed', branch: consumerBranchModel, changeHref: null, newHref: null },
        token: { kind: 'fixed', branch: tokenBranchModel, changeHref: null },
        existingConsumers: data.consumers,
        expiry: editing?.fields
          ? readExpiryForm(editing.fields)
          : { expires: 'keep', expires_on: '' },
        keep: grant.expires_at,
        now: deps.now(),
        ack: editSeed.ack,
        errors: editSeed.errors,
        hidden: { ops: '1' },
        focus:
          editSeed.action === 'add:cond'
            ? { group: 'cond', index: consumerBranchModel.jobs.cond.length + 2 }
            : editSeed.action === 'add:rule'
              ? { group: 'rule', index: tokenBranchModel.ops.rule.length + 2 }
              : null,
      }
    : null;
  const claims = anchorClaims(profile);
  const repositoryId = claims
    ? (grant.conditions.find((c2) => c2.claim === claims.repository && c2.match === 'exact')
        ?.values[0] ?? null)
    : null;
  const sourceToken = token;
  const model: AccessPageModel = {
    grant,
    edge,
    consumer,
    profile,
    token,
    tokens: data.tokens,
    template,
    labels,
    warningDetails: validation.warningDetails,
    overlaps,
    origin: new URL(c.req.url).origin,
    requests30d: data.connections.usageAvailable
      ? (data.connections.usage.get(grant.id)?.requests ?? 0)
      : null,
    repositoryOptions: repositoryOptions(profile, labels, data.connections, consumer.id),
    reviewTokens: new Set(
      data.tokens.filter((t) => !sameOperationSource(t, sourceToken)).map((t) => t.id),
    ),
    edit,
    editOpen: editing !== undefined,
    rename: {
      name: state.rename?.name ?? grant.name,
      description: state.rename?.description ?? grant.description,
      open: state.rename !== undefined,
      errors: state.rename?.errors ?? {},
    },
    copy: {
      repository:
        state.copy?.repository ??
        (repositoryId !== null && claims
          ? idText(repositoryId, labelFor(labels, claims.repository, repositoryId))
          : ''),
      tokenId: state.copy?.tokenId ?? token.id,
      error: state.copy?.errors ?? {},
    },
  };
  const errors = [
    ...(state.errors ?? []),
    ...(editing?.errors ?? []),
    ...Object.entries(state.rename?.errors ?? {}).map(([field, message]) => ({ field, message })),
    ...Object.entries(state.copy?.errors ?? {}).map(([field, message]) => ({
      field: `copy-${field}`,
      message,
    })),
  ];
  return renderPage(
    c,
    {
      title: grant.name,
      section: 'consumers',
      subsection: 'access',
      breadcrumbs: [
        { href: paths.access(), label: 'Consumer access' },
        { href: paths.accessItem(grant.id), label: grant.name },
      ],
      errors,
      status: state.status ?? 200,
      notice: errors.length > 0 ? null : notice(c, { grant, consumer }),
    },
    (ctx) => <AccessPage model={model} ctx={ctx} />,
  );
}

async function update(c: AdminContext) {
  const deps = c.get('deps');
  const actor = adminActor(c);
  const loaded = await loadAccess(c);
  if (!loaded) return notFound(c);
  const { grant } = loaded;
  const fields = await formData(c);
  const intent = text(fields, 'intent');
  const version = submittedVersion(text(fields, 'expected_updated_at'));
  if (intent === 'rename') {
    const name = text(fields, 'name');
    const description = text(fields, 'description');
    const result = await updateGrant(deps, actor, grant.id, {
      name,
      description,
      expected_updated_at: version,
    });
    if (result.ok) {
      return redirectWithNotice(
        c,
        paths.accessItem(grant.id),
        result.changed === false ? 'unchanged' : 'renamed',
      );
    }
    if (result.reason === 'not_found') return notFound(c);
    const errors: Record<string, string> = {};
    const other: FieldError[] = [];
    for (const message of result.errors) {
      if (message.startsWith('name')) errors.name = `The name ${message.slice(5)}.`;
      else if (message.startsWith('description'))
        errors.description = `The description ${message.slice(12)}.`;
      else other.push({ field: null, message });
    }
    return renderAccessPage(c, loaded, {
      rename: { name, description, errors },
      errors: other,
      status: failureStatus(result),
    });
  }
  const action = text(fields, '_action');
  if (SUB_ACTIONS.includes(action)) {
    return renderAccessPage(c, loaded, { edit: { fields, errors: [], ack: null, action } });
  }
  const seed: FormSeed = {
    fields,
    consumerId: grant.caller_provider_id,
    tokenId: grant.service_id,
    consumerView: 'fixed',
    tokenView: 'fixed',
    errors: [],
    ack: null,
  };
  const evaluation = await evaluateForm(c, loaded.data, seed, grant);
  if (!evaluation.ok) {
    return renderAccessPage(c, loaded, {
      edit: { fields, errors: evaluation.errors, ack: null, unknownOwner: evaluation.unknownOwner },
      status: 422,
    });
  }
  const accepted = await acceptance(fields, evaluation);
  if (!accepted.ok) {
    return renderAccessPage(c, loaded, {
      edit: { fields, errors: [accepted.error], ack: accepted.ack },
      status: 422,
    });
  }
  if (evaluation.newOwner) {
    const claim = tenantClaimOf(evaluation.profile.id);
    if (claim) {
      const added = await addTenantValue(deps, actor, grant.caller_provider_id, {
        claim,
        entries: [{ value: evaluation.newOwner.id, label: evaluation.newOwner.label }],
      });
      if (!added.ok) {
        return renderAccessPage(c, loaded, {
          edit: {
            fields,
            errors: added.errors.map((message) => ({ field: 'new_owner', message })),
            ack: null,
            unknownOwner: evaluation.newOwner.label,
          },
          status: failureStatus(added),
        });
      }
    }
  }
  const result = await updateGrant(deps, actor, grant.id, {
    name: evaluation.name,
    conditions: evaluation.conditions,
    rules: evaluation.rules,
    expires_at: evaluation.expiresAt,
    acknowledge_warnings: true,
    accepted_risks: evaluation.risks.codes,
    labels: evaluation.labels,
    expected_updated_at: version,
  });
  if (result.ok) {
    return redirectWithNotice(
      c,
      paths.accessItem(grant.id),
      result.changed === false ? 'unchanged' : result.labelsChanged ? 'label_changed' : 'updated',
    );
  }
  if (result.reason === 'not_found') return notFound(c);
  const reloaded = (await loadAccess(c)) ?? loaded;
  return renderAccessPage(c, reloaded, {
    edit: {
      fields,
      errors: result.errors.map((message) => ({
        field: null,
        message: grantErrorMessage(message),
      })),
      ack: null,
    },
    status: failureStatus(result),
  });
}

// ---------------------------------------------------------------------------------------------
// Copy

async function copy(c: AdminContext) {
  const deps = c.get('deps');
  const loaded = await loadAccess(c);
  if (!loaded) return notFound(c);
  const { grant, consumer, token: sourceToken, profile, data } = loaded;
  const fields = await formData(c);
  const repositoryRaw = text(fields, 'repository');
  const tokenId = text(fields, 'token_id') || sourceToken.id;
  const target = data.tokens.find((item) => item.id === tokenId);
  const labels = labelsOf(data.connections, consumer.id);
  const state = (errors: Record<string, string>): PageState => ({
    copy: { repository: repositoryRaw, tokenId, errors },
    status: 422,
  });
  if (!target) return renderAccessPage(c, loaded, state({ token_id: 'Choose a token.' }));
  const parsed = parseRepositoryInput(repositoryRaw, profile, labels);
  if (!parsed.ok) return renderAccessPage(c, loaded, state({ repository: parsed.message }));
  const sourceRepository = repositoryLabelOf(grant, labels, profile);
  const claims = anchorClaims(profile);
  const sourceRepositoryId = claims
    ? (grant.conditions.find((cond) => cond.claim === claims.repository && cond.match === 'exact')
        ?.values[0] ?? null)
    : null;
  const repository = parsed.value;
  if (!repository)
    return renderAccessPage(c, loaded, state({ repository: 'Choose the repository of the copy.' }));
  if (target.id === sourceToken.id && repository.id === sourceRepositoryId) {
    return renderAccessPage(
      c,
      loaded,
      state({ repository: 'Choose another repository or token.' }),
    );
  }
  const jobs = accessFormFromGrant(grant, profile, labels);
  // Another operation source, or constraints only the rows editor can show: review them first.
  if (!sameOperationSource(target, sourceToken) || jobs.editor !== 'structured') {
    return redirectWithNotice(
      c,
      paths.accessNew({ copy: grant.id, token: target.id, repository: repository.id }),
      'copy_review',
    );
  }
  jobs.repository = idText(repository.id, repository.label);
  const sets = ruleSetsOf(await tokenAccessShapes(deps.env.DB, target.id));
  const ops = opsFormFromRules(grant.rules, templateForService(target), sets, sourceRepository);
  const seed: FormSeed = {
    fields: null,
    consumerId: consumer.id,
    tokenId: target.id,
    consumerView: 'fixed',
    tokenView: 'fixed',
    jobs,
    ops,
    errors: [],
    ack: null,
  };
  const evaluation = await evaluateForm(c, data, seed, null);
  if (!evaluation.ok) {
    // An unknown organization (new_owner) or another problem: the prefilled create form.
    return renderForm(
      c,
      data,
      { ...seed, errors: evaluation.errors, unknownOwner: evaluation.unknownOwner },
      { status: 422, banner: <p>Copied the constraints of “{grant.name}”.</p> },
    );
  }
  const sourceCodes = new Set<WarningCode>(
    validateGrant(
      { conditions: grant.conditions, rules: grant.rules },
      profile,
      consumer,
      sourceToken,
    ).warningDetails.map((d) => d.code),
  );
  const newRisk = evaluation.risks.codes.some(
    (code) => !sourceCodes.has(code) && !evaluation.covered.has(code),
  );
  if (newRisk) {
    return renderForm(
      c,
      data,
      {
        ...seed,
        errors: [
          {
            field: 'acknowledge_warnings',
            message: 'The copy has risks the source does not: review them and tick the box.',
          },
        ],
        ack: { digest: evaluation.risks.digest, warnings: evaluation.risks.messages },
      },
      { status: 422, banner: <p>Copied the constraints of “{grant.name}”.</p> },
    );
  }
  const result = await duplicateGrant(deps, adminActor(c), grant.id, {
    service_id: target.id,
    conditions: evaluation.conditions,
    rules: evaluation.rules,
    labels: evaluation.labels,
    name: evaluation.name,
    acknowledge_warnings: true,
    accepted_risks: evaluation.risks.codes,
  });
  if (result.ok) return redirectWithNotice(c, paths.accessItem(result.grant.id), 'copied');
  if (result.reason === 'not_found') return notFound(c);
  return renderAccessPage(c, loaded, {
    copy: { repository: repositoryRaw, tokenId, errors: {} },
    errors: result.errors.map((message) => ({ field: null, message: grantErrorMessage(message) })),
    status: failureStatus(result),
  });
}

// ---------------------------------------------------------------------------------------------
// Toggle and delete

async function toggle(c: AdminContext) {
  const id = c.req.param('id') ?? '';
  const form = await formData(c);
  const enabled = flag(form, 'enabled');
  const result = await setGrantEnabled(c.get('deps'), adminActor(c), id, enabled);
  if (result.ok) {
    const back = returnPath('POST /admin/access/:id/toggle', form._return, { id });
    return redirectWithNotice(c, back, enabled ? 'enabled' : 'disabled');
  }
  return rerenderDetail(c, result);
}

async function remove(c: AdminContext) {
  const fields = await formData(c);
  if (!flag(fields, 'confirm')) {
    const loaded = await loadAccess(c);
    if (!loaded) return notFound(c);
    return renderAccessPage(c, loaded, {
      errors: [{ field: null, message: 'Confirm the deletion in the Delete dialog.' }],
      status: 400,
    });
  }
  const result = await deleteGrant(c.get('deps'), adminActor(c), c.req.param('id') ?? '');
  if (result.ok) return redirectWithNotice(c, paths.access(), 'deleted');
  return rerenderDetail(c, result);
}

async function rerenderDetail(c: AdminContext, failure: OpFailure) {
  const loaded = await loadAccess(c);
  if (!loaded || failure.reason === 'not_found') return notFound(c);
  return renderAccessPage(c, loaded, {
    errors: failure.errors.map((message) => ({ field: null, message: grantErrorMessage(message) })),
    status: failureStatus(failure),
  });
}

function notFound(c: AdminContext) {
  return renderPage(
    c,
    { title: 'Consumer access not found', section: 'consumers', subsection: 'access', status: 404 },
    () => <NotFound what="access" />,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Notice entries the form page understands from other pages (closed set). */
export const ACCESS_FORM_NOTICES: readonly string[] = Object.keys(NOTICES);
export type { Notice };
