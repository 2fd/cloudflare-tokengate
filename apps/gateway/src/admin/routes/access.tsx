// Admin pages: issuer access rules (issuer_access_rules). The connections map, the matrix and the access list show
// which consumers can use which tokens; the structured form builds the conditions and rules
// (consumer-access.ts) and every save goes through ops/issuer_access_rules.ts (validateIssuerAccessRule: anchors
// I-AUTHZ-2, tenant pin containment, event guard I-AUTHZ-3; audit I-AUDIT-1). Risks are accepted
// by the selection that causes them, or by ticking a box bound to a digest of exactly the risks
// shown (A7.7). Autocomplete reads only control-plane data; a request record prefills the form
// only on request, verified (I-LOG-2).
import {
  ActiveFilters,
  AddFilter,
  ArrowRow,
  Button,
  Callout,
  Cell,
  ConnectionsMap,
  EmptyState as UiEmptyState,
  Entity,
  Filters,
  FilterSearch,
  formatTime,
  GroupRow,
  Legend,
  Mono,
  PageHeader,
  Panel,
  QuickLinks,
  Row,
  RowHeader,
  Segmented,
  Table,
  Tray,
  ZeroState,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { sha256Hex } from '../../crypto/hash';
import { listAuditEvents } from '../../db/audit';
import { labelFor, parseIdWithLabel } from '../../db/claim-labels';
import { getIssuerAccessRule } from '../../db/issuer_access_rules';
import { getRequest } from '../../db/requests';
import {
  consumerAccessShapes,
  consumerSuggestions,
  ruleSets as ruleSetsOf,
  rulePathSuggestions,
  tokenAccessShapes,
} from '../../db/suggestions';
import type { CredentialAccessRule, ClaimLabel, IssuerAccessRule, Service } from '../../db/types';
import { getProfile, PROFILES } from '../../identity/profiles';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import { parseJson } from '../../lib/json';
import { claimText } from '../../policy/conditions';
import type { Condition, Rule } from '../../policy/types';
import {
  validateCredentialAccessRule,
  validateIssuerAccessRule,
  type WarningCode,
  type WarningDetail,
} from '../../policy/validate';
import { loadTokenTraffic, type TokenTraffic } from '../access-traffic';
import { type AccessEdge, type Connections, loadConnections } from '../connections';
import {
  accessFormFromIssuerAccessRule,
  anchorClaims,
  accessWarningDetails,
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
  withAnyRefFlags,
  withTypedLabels,
} from '../consumer-access';
import { parseValueList } from '../grant-text';
import { type Notice, type NoticeContext, type NoticeTable, resolveNotice } from '../notice';
import {
  addTenantValue,
  type ConsumerInput,
  consumerIssuer,
  createOrMergeConsumer,
  pinValues,
  tenantClaimOf,
} from '../ops/credential-access-rules';
import {
  checkIssuerAccessRule,
  createIssuerAccessRule,
  deleteIssuerAccessRule,
  duplicateIssuerAccessRule,
  type IssuerAccessRuleLabel,
  setIssuerAccessRuleEnabled,
  updateIssuerAccessRule,
} from '../ops/issuer_access_rules';
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
  type FormEntry,
  type NewConsumerBranch,
  type RequestFacts,
  type TokenBranch,
  type TokenChoice,
} from '../views/access-form';
import { groupedRest, mapModel } from '../views/access-map';
import {
  AccessHeader,
  AccessPage,
  type AccessPageModel,
  type HistoryEntry,
} from '../views/access-page';
import {
  accessesText,
  consumerLogo,
  operationsText,
  PathName,
  tokenLogo,
} from '../views/access-visuals';
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
  NotFound,
  notFoundText,
  type Suggestion,
} from '../views/components';
import { formatCount, lastUsedTime, relativeTime } from '../views/format';
import { LearnMore } from '../views/header';
import {
  anchorsOf,
  AccessMatrix,
  buildMatrix,
  credentialText,
  MATRIX_MAX_COLUMNS,
  MATRIX_MAX_ROWS,
} from '../views/matrix';
import { accessFixable, reasonText } from '../views/reasons';
import { AccessStatus, consumerFailureErrors } from './consumers';

const STATUS_FILTERS = ['active', 'inactive', 'expiring', 'expired', 'unused', 'risk'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const STATUS_WORDS: Readonly<Record<StatusFilter, string>> = {
  active: 'Active',
  inactive: 'Inactive',
  expiring: 'Expiring in 14 days',
  expired: 'Expired',
  unused: 'Unused 30 days',
  risk: 'Risk accepted',
};
/** At most this many cards; more choices become a select (A7.1, Choice). */
const MAX_CARDS = 6;
/** Rows per side of the connections map (its scale rule). */
const MAP_ROWS = 7;

export function registerAccessRoutes(app: App): void {
  app.get('/admin/issuer-access-rules', listPage);
  app.get('/admin/issuer-access-rules/new', newPage);
  app.post('/admin/issuer-access-rules', create);
  app.get('/admin/issuer-access-rules/:id', detailPage);
  app.post('/admin/issuer-access-rules/:id', update);
  app.post('/admin/issuer-access-rules/:id/copy', copy);
  app.post('/admin/issuer-access-rules/:id/toggle', toggle);
  app.post('/admin/issuer-access-rules/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Notices

interface AccessNoticeData {
  grant: IssuerAccessRule | null;
  consumer: CredentialAccessRule | null;
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
            srSuffix: grant.name,
          },
        }
      : {}),
  }),
  deleted: () => ({ text: 'Access deleted.' }),
  copy_review: () => ({
    text: 'This token has other operations: review them, then save the copy.',
  }),
  copy_review_rows: () => ({
    text: 'These constraints need the conditions editor: review them, then save the copy.',
  }),
  copy_review_paths: () => ({
    text: 'Some operations name the source repository: review their paths under Other operations, then save the copy.',
  }),
  copy_review_expired: () => ({
    text: 'The source access has expired: choose when the copy expires, then save it.',
  }),
  consumer_created: ({ consumer }) => ({
    text: `Consumer ${consumer?.name ?? ''} created. Now give it access to a token.${consumerRisks(consumer)}`,
  }),
  tenant_added: ({ consumer }) => ({
    text: `Added to ${consumer?.name ?? 'the credential access rule'}. Now give it access to a token.`,
  }),
};

/** " Risk: …" for each standing warning of a credential access rule (a generic one without a pin), or "". */
function consumerRisks(consumer: CredentialAccessRule | null): string {
  const profile = consumer ? getProfile(consumer.profile) : null;
  if (!consumer || !profile) return '';
  return validateCredentialAccessRule(consumer, profile, consumer)
    .warnings.map((warning) => ` Risk: ${warning}.`)
    .join('');
}

function notice(c: AdminContext, data: AccessNoticeData) {
  return resolveNotice(NOTICES, c.req.query('notice'), null, data);
}

// ---------------------------------------------------------------------------------------------
// The connections view: Map (default) and Matrix

interface ListQuery {
  view: 'map' | 'matrix';
  consumerId: string;
  tokenId: string;
  repository: string;
  status: StatusFilter | '';
  focusId: string;
  rest: { consumers: boolean; tokens: boolean };
}

async function listPage(c: AdminContext) {
  const deps = c.get('deps');
  const connections = withAnyRefFlags(await loadConnections(deps));
  const query = (name: string) => c.req.query(name) ?? '';
  const notes: string[] = [];
  const known = (id: string) => connections.consumers.some((consumer) => consumer.id === id);
  let consumerId = query('consumer');
  if (consumerId && !known(consumerId)) {
    notes.push('That consumer no longer exists.');
    consumerId = '';
  }
  let focusId = query('focus');
  if (focusId && !known(focusId)) {
    if (!notes.includes('That consumer no longer exists.')) {
      notes.push('That consumer no longer exists.');
    }
    focusId = '';
  }
  let tokenId = query('token');
  if (tokenId && !connections.tokens.some((token) => token.id === tokenId)) {
    notes.push('That token no longer exists.');
    tokenId = '';
  }
  const q: ListQuery = {
    view: query('view') === 'matrix' ? 'matrix' : 'map',
    consumerId,
    tokenId,
    repository: query('repository').trim().slice(0, 200),
    status: (STATUS_FILTERS as readonly string[]).includes(query('status'))
      ? (query('status') as StatusFilter)
      : '',
    focusId,
    rest: { consumers: query('consumers') === 'rest', tokens: query('tokens') === 'rest' },
  };
  // Both views order the tokens by their 24-hour requests (the map draws them too).
  const traffic: TokenTraffic = await loadTokenTraffic(deps);
  const filtered = filterAccesses(connections, q);
  const anyFilter =
    q.consumerId !== '' || q.tokenId !== '' || q.repository !== '' || q.status !== '';
  const consumer = connections.consumers.find((item) => item.id === q.consumerId) ?? null;
  const token = connections.tokens.find((item) => item.id === q.tokenId) ?? null;
  const total = connections.accesses.length;
  return renderPage(
    c,
    {
      title: 'Issuer access rules',
      section: 'consumers',
      subsection: 'access',
      notice: notice(c, { grant: null, consumer: null }),
      header: (ctx) => (
        <PageHeader
          title="Issuer access rules"
          count={anyFilter ? `${filtered.length} of ${total}` : total}
          description={
            <ListDescription
              q={q}
              token={token}
              filtered={filtered}
              traffic={traffic}
              canWrite={ctx.can('access:write')}
            />
          }
          actions={
            ctx.can('access:write') && connections.tokens.length > 0 ? (
              <Button
                variant="primary"
                plus
                href={paths.accessNew({
                  consumer:
                    q.consumerId || (connections.consumers.length === 0 ? 'new' : undefined),
                  token: q.tokenId || undefined,
                })}
              >
                {token ? `Add issuer access rule to ${token.name}` : 'Add issuer access rule'}
              </Button>
            ) : undefined
          }
        >
          {connections.tokens.length > 0 && connections.consumers.length > 0 ? (
            <ListFilters connections={connections} q={q} consumer={consumer} token={token} />
          ) : null}
        </PageHeader>
      ),
    },
    (ctx) => (
      <>
        {notes.map((note) => (
          <Callout title={note} />
        ))}
        <ListBody
          connections={connections}
          q={q}
          filtered={filtered}
          anyFilter={anyFilter}
          traffic={traffic}
          ctx={ctx}
        />
      </>
    ),
  );
}

function ListDescription(props: {
  q: ListQuery;
  token: Service | null;
  filtered: readonly AccessEdge[];
  traffic: TokenTraffic;
  canWrite: boolean;
}) {
  const { q, token, filtered, traffic } = props;
  if (token) {
    const consumers = new Set(filtered.map((edge) => edge.grant.credential_access_rule_id)).size;
    const requests = traffic.byToken.get(token.id)?.requests ?? 0;
    return (
      <>
        <b>
          {consumers} {consumers === 1 ? 'consumer' : 'consumers'}
        </b>{' '}
        can use <a href={paths.token(token.id)}>{token.name}</a> through{' '}
        <b>{accessesText(filtered.length)}</b>.
        {traffic.available ? ` ${formatCount(requests)} requests in the last 24 hours.` : null}
      </>
    );
  }
  return (
    <>
      Which credential access rule jobs can use which credential, and for what.
      {q.view === 'matrix' && props.canWrite
        ? ' Select + in a row to give the same jobs another token.'
        : null}
      <LearnMore path="concepts.md#consumer-access" about="issuer access rules" />
    </>
  );
}

/** The access list query without one key (for the active filter chips and quick links). */
function listHref(q: ListQuery, change: Partial<Parameters<typeof paths.access>[0]> = {}) {
  return paths.access({
    view: q.view === 'matrix' ? 'matrix' : undefined,
    consumer: q.consumerId || undefined,
    token: q.tokenId || undefined,
    repository: q.repository || undefined,
    status: q.status || undefined,
    focus: q.focusId || undefined,
    ...change,
  });
}

function ListFilters(props: {
  connections: Connections;
  q: ListQuery;
  consumer: CredentialAccessRule | null;
  token: Service | null;
}) {
  const { connections, q } = props;
  const all = connections.accesses;
  const count = (test: (edge: AccessEdge) => boolean) => all.filter(test).length;
  const statusCount: Record<StatusFilter, number> = {
    active: count((edge) => edge.status === 'active'),
    inactive: count((edge) => edge.status === 'inactive'),
    expiring: count((edge) => edge.status === 'expiring'),
    expired: count((edge) => edge.status === 'expired'),
    unused: count((edge) => edge.flags.some((f) => f.status === 'unused')),
    risk: count((edge) => edge.flags.some((f) => f.status === 'risk_accepted')),
  };
  const repositories = [
    ...new Set(
      connections.labels
        .filter((label) => label.claim === 'repository_id' || label.claim === 'project_id')
        .map((label) => `${label.label} (${label.value})`),
    ),
  ];
  const statusOption = (status: StatusFilter) => ({
    href: listHref(q, { status }),
    label: STATUS_WORDS[status],
    count: statusCount[status],
  });
  const quick: Array<{ status: StatusFilter; glyph: string; tone?: 'warn' | 'bad' }> = [
    { status: 'inactive', glyph: '⏸' },
    { status: 'expiring', glyph: '⌛', tone: 'warn' },
    { status: 'expired', glyph: '✕', tone: 'bad' },
    { status: 'risk', glyph: '⚠', tone: 'warn' },
    { status: 'unused', glyph: '' },
  ];
  return (
    <>
      <Filters
        label="Filter issuer access rules"
        action={paths.access()}
        hidden={Object.fromEntries(
          Object.entries({
            view: q.view === 'matrix' ? 'matrix' : '',
            consumer: q.consumerId,
            token: q.tokenId,
            status: q.status,
            focus: q.focusId,
          }).filter(([, value]) => value !== ''),
        )}
        submitLabel="Apply"
      >
        <FilterSearch
          id="f-access-repository"
          label="Repository"
          name="repository"
          value={q.repository}
          placeholder="acme/api (89012345)"
          maxlength={200}
          suggestions={repositories}
        />
        {props.consumer ? null : (
          <AddFilter
            label="Credential access rule"
            options={connections.consumers.map((consumer) => ({
              href: listHref(q, { consumer: consumer.id }),
              label: consumer.name,
              logo: consumerLogo(consumer),
              count: count((edge) => edge.grant.credential_access_rule_id === consumer.id),
            }))}
            srSuffix="accesses"
          />
        )}
        {props.token ? null : (
          <AddFilter
            label="Credential"
            options={connections.tokens.map((token) => ({
              href: listHref(q, { token: token.id }),
              label: token.name,
              logo: tokenLogo(token),
              slug: token.slug,
              count: count((edge) => edge.grant.service_id === token.id),
            }))}
            srSuffix="accesses"
          />
        )}
        <AddFilter
          label="Status"
          options={[statusOption('active')]}
          extra={(['inactive', 'expiring', 'expired', 'risk', 'unused'] as const).map(statusOption)}
          srSuffix="accesses"
        />
      </Filters>
      <ActiveFilters
        filters={[
          ...(props.consumer
            ? [
                {
                  label: `Consumer: ${props.consumer.name}`,
                  href: listHref(q, { consumer: undefined }),
                },
              ]
            : []),
          ...(props.token
            ? [{ label: `Token: ${props.token.name}`, href: listHref(q, { token: undefined }) }]
            : []),
          ...(q.repository
            ? [
                {
                  label: `Repository: ${q.repository}`,
                  href: listHref(q, { repository: undefined }),
                },
              ]
            : []),
          ...(q.status
            ? [
                {
                  label: `Status: ${STATUS_WORDS[q.status]}`,
                  href: listHref(q, { status: undefined }),
                },
              ]
            : []),
        ]}
        clearHref={paths.access({ view: q.view === 'matrix' ? 'matrix' : undefined })}
        clearLabel="Clear filters"
      />
      {props.consumer || props.token || q.repository ? null : (
        <QuickLinks
          label="Accesses that need attention"
          lead="Needs attention"
          links={quick.map((link) => ({
            label: STATUS_WORDS[link.status],
            glyph: link.glyph || undefined,
            tone: link.tone,
            count: statusCount[link.status],
            href: paths.access({
              view: q.view === 'matrix' ? 'matrix' : undefined,
              status: link.status,
            }),
            current: q.status === link.status,
          }))}
        />
      )}
    </>
  );
}

function filterAccesses(connections: Connections, q: ListQuery): AccessEdge[] {
  const needle = q.repository.toLowerCase();
  return connections.accesses.filter((edge) => {
    if (q.consumerId && edge.grant.credential_access_rule_id !== q.consumerId) return false;
    if (q.tokenId && edge.grant.service_id !== q.tokenId) return false;
    if (needle) {
      const labels = connections.labels.filter(
        (l) => l.credential_access_rule_id === edge.grant.credential_access_rule_id,
      );
      const anchors = anchorsOf(edge, labels);
      const hit = anchors.some(
        (anchor) =>
          anchor.repositoryId === q.repository ||
          anchor.header.toLowerCase().includes(needle) ||
          `${anchor.subject} (${anchor.repositoryId ?? ''})`.toLowerCase() === needle,
      );
      if (!hit) return false;
    }
    switch (q.status) {
      case 'active':
        return edge.status === 'active';
      case 'inactive':
        return edge.status === 'inactive';
      case 'expiring':
        return edge.status === 'expiring';
      case 'expired':
        return edge.status === 'expired';
      case 'unused':
        return edge.flags.some((f) => f.status === 'unused');
      case 'risk':
        return edge.flags.some((f) => f.status === 'risk_accepted');
      default:
        return true;
    }
  });
}

function ListBody(props: {
  connections: Connections;
  q: ListQuery;
  filtered: AccessEdge[];
  anyFilter: boolean;
  traffic: TokenTraffic;
  ctx: ViewContext;
}) {
  const { connections, q, filtered, ctx } = props;
  const canWrite = ctx.can('access:write');
  if (connections.tokens.length === 0) {
    return (
      <UiEmptyState
        headingLevel={2}
        title="A credential manager must add a credential first."
        description="Issuer access rules lets the jobs of a credential access rule use a credential."
        actions={
          ctx.can('tokens:write') ? (
            <Button variant="primary" plus href={paths.tokenNew()}>
              Add credential
            </Button>
          ) : (
            <AskSomeone permission="tokens:write" ctx={ctx} verb="add a credential" />
          )
        }
      />
    );
  }
  if (connections.consumers.length === 0) {
    return (
      <UiEmptyState
        headingLevel={2}
        title="No consumer yet."
        description={
          canWrite
            ? 'Add issuer access rule: the form adds the credential access rule in the same step.'
            : undefined
        }
        actions={
          canWrite ? undefined : (
            <AskSomeone permission="access:write" ctx={ctx} verb="add a credential access rule" />
          )
        }
      />
    );
  }
  const segmented = (current: 'map' | 'matrix') => (
    <Segmented
      label="View"
      size="sm"
      items={[
        { label: 'Map', href: listHref(q, { view: undefined }), current: current === 'map' },
        {
          label: 'Matrix',
          href: listHref(q, { view: 'matrix', focus: undefined }),
          current: current === 'matrix',
        },
      ]}
    />
  );
  if (q.view === 'matrix') {
    return <MatrixView {...props} segmented={segmented('matrix')} />;
  }
  const token = connections.tokens.find((item) => item.id === q.tokenId) ?? null;
  const focus = connections.consumers.find((item) => item.id === q.focusId) ?? null;
  // Filtered to one token only: the map keeps every line and lights up that token's (focusToken).
  const tokenFocus =
    token !== null && !q.consumerId && !q.repository && !q.status && !focus ? token : null;
  const model = mapModel(
    connections,
    tokenFocus ? connections.accesses : filtered,
    props.traffic,
    ctx.now,
  );
  const focusEdges = focus
    ? connections.accesses.filter((edge) => edge.grant.credential_access_rule_id === focus.id)
    : [];
  return (
    <>
      <Tray
        id="map"
        title={token ? `Connections to ${token.name}` : 'Connections'}
        description={
          focus
            ? `Focused on ${focus.name}: ${accessesText(focusEdges.length)} to ${new Set(focusEdges.map((e) => e.grant.service_id)).size} tokens. Everything else is dimmed.`
            : token
              ? tokenFocus
                ? `Other connections are dimmed. Remove the filter to see all.`
                : `Only the lines to ${token.name} are drawn. Remove the filter to see all.`
              : `${connections.consumers.length} consumers can use ${new Set(connections.accesses.map((e) => e.grant.service_id)).size} tokens through ${accessesText(connections.accesses.length)}. Each line is one or more accesses; the token's second line says why a line needs attention.`
        }
        actions={segmented('map')}
      >
        {connections.accesses.length === 0 ? (
          <Panel variant="pad">
            <ZeroState>No workload can use any token yet.</ZeroState>
          </Panel>
        ) : null}
        <ConnectionsMap
          id="cmap"
          baseHref={paths.access()}
          focus={focus?.id}
          focusToken={tokenFocus?.id}
          maxRows={MAP_ROWS}
          focusLinks={3}
          consumers={model.consumers}
          tokens={model.tokens}
          accesses={model.accesses}
          footer={
            props.traffic.available ? (
              <>
                Refused before a token was chosen:{' '}
                <b class="t-bad">{formatCount(props.traffic.refused)}</b> ·{' '}
                <a href={paths.requests({ token: 'none' })}>See them</a>
              </>
            ) : undefined
          }
        />
      </Tray>
      <AccessListTray
        connections={connections}
        edges={
          focus ? filtered.filter((e) => e.grant.credential_access_rule_id === focus.id) : filtered
        }
        title={
          focus ? `Accesses of ${focus.name}` : token ? `Accesses to ${token.name}` : 'All accesses'
        }
        description={
          focus
            ? 'The list follows the focus. Clear the focus to list all.'
            : 'Busiest consumer first, then by repository. Disable stops an access at once; you can enable it again.'
        }
        anyFilter={props.anyFilter}
        clearHref={paths.access()}
        ctx={ctx}
      />
    </>
  );
}

function MatrixView(props: {
  connections: Connections;
  q: ListQuery;
  filtered: AccessEdge[];
  anyFilter: boolean;
  traffic: TokenTraffic;
  ctx: ViewContext;
  segmented: Child;
}) {
  const { connections, q, filtered, ctx } = props;
  const canWrite = ctx.can('access:write');
  // The nodes the map grouped as "+ N more": the same busiest-first rule as ConnectionsMap.
  const count = (id: string) =>
    connections.accesses.filter((edge) => edge.grant.credential_access_rule_id === id).length;
  const restConsumers = q.rest.consumers
    ? groupedRest(
        [...connections.consumers].sort((a, b) => count(b.id) - count(a.id)),
        MAP_ROWS,
      )
    : null;
  const restTokens = q.rest.tokens
    ? groupedRest(
        [...connections.tokens].sort(
          (a, b) =>
            (props.traffic.byToken.get(b.id)?.requests ?? 0) -
            (props.traffic.byToken.get(a.id)?.requests ?? 0),
        ),
        MAP_ROWS,
      )
    : null;
  const edges = filtered.filter(
    (edge) =>
      (!restConsumers || restConsumers.has(edge.grant.credential_access_rule_id)) &&
      (!restTokens || restTokens.has(edge.grant.service_id)),
  );
  const filteredConsumers = props.anyFilter && !q.consumerId;
  const model = buildMatrix(
    {
      ...connections,
      consumers: connections.consumers.filter(
        (consumer) =>
          (!q.consumerId || consumer.id === q.consumerId) &&
          (!restConsumers || restConsumers.has(consumer.id)) &&
          (!filteredConsumers ||
            edges.some((e) => e.grant.credential_access_rule_id === consumer.id)),
      ),
      tokens: connections.tokens.filter(
        (token) =>
          (!q.tokenId || token.id === q.tokenId) && (!restTokens || restTokens.has(token.id)),
      ),
      accesses: edges,
    },
    props.traffic.available ? (id) => props.traffic.byToken.get(id)?.requests ?? 0 : undefined,
  );
  const tooBig = model.columns.length > MATRIX_MAX_COLUMNS || model.rowCount > MATRIX_MAX_ROWS;
  if (tooBig) {
    return (
      <>
        <Callout title="Too many to show as a matrix; filter by consumer or token.">
          The list below shows the same accesses as rows.
        </Callout>
        <AccessListTray
          connections={connections}
          edges={edges}
          title="All accesses"
          description="Busiest consumer first, then by repository."
          anyFilter={props.anyFilter}
          clearHref={paths.access({ view: 'matrix' })}
          ctx={ctx}
        />
      </>
    );
  }
  return (
    <Tray
      id="mx"
      title={
        restConsumers
          ? 'Connections of the other consumers'
          : restTokens
            ? 'Connections to the other tokens'
            : 'Connections'
      }
      description="Rows: consumer › repository. Columns: tokens, busiest first. Each cell is one issuer access rule."
      actions={props.segmented}
      footer={
        <>
          <Legend
            items={[
              { mark: 'cell', label: '✓ Active' },
              { mark: 'cell-warn', label: '⌛ Expiring · ⚠ Risk accepted' },
              { mark: 'cell-bad', label: '✕ Expired' },
              { mark: 'cell-off', label: '⏸ Inactive' },
            ]}
          />
          {canWrite ? (
            <span>
              <b class="mono">+</b> Give these jobs this token
            </span>
          ) : null}
          <span>
            The <a href={listHref(q, { view: undefined })}>Map</a> view lists the same{' '}
            {accessesText(edges.length)} as rows.
          </span>
        </>
      }
    >
      {connections.accesses.length === 0 ? (
        <Panel variant="pad">
          <ZeroState>No workload can use any token yet.</ZeroState>
        </Panel>
      ) : null}
      {props.anyFilter && edges.length === 0 ? (
        <Panel variant="pad">
          <UiEmptyState
            title="No issuer access rules matches these filters."
            actions={<Button href={paths.access({ view: 'matrix' })}>Clear filters</Button>}
          />
        </Panel>
      ) : (
        <Panel variant="flush">
          <AccessMatrix model={model} connections={connections} ctx={ctx} />
        </Panel>
      )}
    </Tray>
  );
}

function AccessListTray(props: {
  connections: Connections;
  edges: AccessEdge[];
  title: string;
  description: string;
  anyFilter: boolean;
  clearHref: string;
  ctx: ViewContext;
}) {
  const { connections, ctx } = props;
  const canWrite = ctx.can('access:write');
  const total = (consumerId: string) =>
    connections.accesses.filter((edge) => edge.grant.credential_access_rule_id === consumerId)
      .length;
  const rows = [...props.edges].sort(
    (a, b) =>
      total(b.grant.credential_access_rule_id) - total(a.grant.credential_access_rule_id) ||
      (a.consumer?.name ?? '').localeCompare(b.consumer?.name ?? '') ||
      a.subject.localeCompare(b.subject) ||
      (a.token?.name ?? '').localeCompare(b.token?.name ?? ''),
  );
  const groups = new Map<string, AccessEdge[]>();
  for (const edge of rows) {
    const list = groups.get(edge.grant.credential_access_rule_id) ?? [];
    list.push(edge);
    groups.set(edge.grant.credential_access_rule_id, list);
  }
  const columns = [
    { label: 'Jobs → token · operations' },
    { label: 'Status' },
    { label: 'Expires' },
    { label: 'Last used · 30 days', num: true },
    ...(canWrite ? [{ label: 'Actions', act: true }] : []),
  ];
  const empty = rows.length === 0;
  return (
    <Tray id="al" title={props.title} count={rows.length} description={props.description}>
      <Panel variant="flush">
        <Table id="access-list" labelledBy="al-h" stackable columns={columns}>
          {empty
            ? undefined
            : [...groups.entries()].map(([consumerId, edges]) => {
                const consumer = edges[0]?.consumer ?? null;
                const all = connections.accesses.filter(
                  (edge) => edge.grant.credential_access_rule_id === consumerId,
                ).length;
                return (
                  <>
                    <GroupRow colspan={columns.length}>
                      <Entity
                        logo={consumerLogo(consumer)}
                        logoSize="sm"
                        href={consumer ? paths.consumer(consumer.id) : undefined}
                        name={consumer?.name ?? 'Deleted credential access rule'}
                        after={
                          <span class="meta">
                            {edges.length === all
                              ? accessesText(all)
                              : `${edges.length} of ${accessesText(all)}`}
                          </span>
                        }
                      />
                    </GroupRow>
                    {edges.map((edge) => (
                      <AccessListRow edge={edge} connections={connections} ctx={ctx} />
                    ))}
                  </>
                );
              })}
        </Table>
        {empty ? (
          props.anyFilter ? (
            <UiEmptyState
              title="No issuer access rules matches these filters."
              actions={<Button href={props.clearHref}>Clear filters</Button>}
            />
          ) : (
            <UiEmptyState title="No workload can use any token yet." />
          )
        ) : null}
      </Panel>
    </Tray>
  );
}

/**
 * The one action a row offers, the fix its status asks for: Extend an expired or expiring access
 * (its Change form, expiry step), open the disabled token of an inactive one, else Disable/Enable.
 */
function RowAction(props: { edge: AccessEdge; ctx: ViewContext }) {
  const { edge, ctx } = props;
  if (edge.grant.enabled && (edge.status === 'expired' || edge.status === 'expiring')) {
    return (
      <Button
        size="sm"
        href={paths.accessItem(edge.grant.id, { open: 'edit', hash: 'edit' })}
        srSuffix={edge.grant.name}
      >
        Extend
      </Button>
    );
  }
  if (edge.status === 'inactive' && edge.statusDetail === 'credential disabled' && edge.token) {
    return (
      <Button size="sm" href={paths.token(edge.token.id)} srSuffix={edge.token.name}>
        Open token
      </Button>
    );
  }
  return (
    <ActionButton
      action={`${paths.accessItem(edge.grant.id)}/toggle`}
      csrf={ctx.csrf}
      label={edge.grant.enabled ? 'Disable' : 'Enable'}
      context={edge.grant.name}
      fields={{ enabled: edge.grant.enabled ? '0' : '1' }}
      returnTo="list"
      size="sm"
    />
  );
}

function protectedRefs(edge: AccessEdge): boolean {
  return edge.grant.conditions.some(
    (c) => c.claim === 'ref_protected' && c.match === 'exact' && c.values.includes('true'),
  );
}

function AccessListRow(props: { edge: AccessEdge; connections: Connections; ctx: ViewContext }) {
  const { edge, connections, ctx } = props;
  const expires = edge.grant.expires_at;
  const risky = edge.flags.some((f) => f.status === 'risk_accepted');
  const usage = connections.usage.get(edge.grant.id)?.requests ?? 0;
  return (
    <Row>
      <RowHeader>
        <ArrowRow
          href={paths.accessItem(edge.grant.id)}
          verb={['expired', 'disabled', 'inactive'].includes(edge.status) ? 'could use' : 'can use'}
          consumer={{
            name: (
              <span class="mono">
                <PathName text={edge.subject} />
              </span>
            ),
            context: (
              <span class={risky ? 't-warn' : edge.status === 'expired' ? 't-bad' : undefined}>
                {edge.context}
                {protectedRefs(edge) ? ' · protected refs' : ''}
              </span>
            ),
          }}
          token={{
            name: edge.token?.name ?? 'Deleted credential',
            logo: tokenLogo(edge.token),
            context: operationsText(edge),
          }}
        />
      </RowHeader>
      <Cell label="Status">
        <AccessStatus edge={edge} now={ctx.now} expiry={false} />
      </Cell>
      <Cell label="Expires" nowrap>
        {expires === null ? (
          'Never'
        ) : (
          <>
            {formatTime(new Date(expires), 'date')}
            {expires > ctx.now ? (
              <span class="meta d-block">{relativeTime(expires, ctx.now)}</span>
            ) : null}
          </>
        )}
      </Cell>
      <Cell label="Last used · 30 days" num nowrap>
        {!connections.usageAvailable
          ? 'Unknown'
          : edge.lastUsedHour === null
            ? 'None in 30 days'
            : lastUsedTime(edge.lastUsedHour, ctx.now)}
        {connections.usageAvailable && usage > 0 ? (
          <span class="meta d-block">{formatCount(usage)} allowed</span>
        ) : null}
      </Cell>
      {ctx.can('access:write') ? (
        <Cell act>
          <RowAction edge={edge} ctx={ctx} />
        </Cell>
      ) : null}
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// The form: data and model

interface FormData {
  connections: Connections;
  consumers: CredentialAccessRule[];
  tokens: Service[];
}

async function loadFormData(c: AdminContext): Promise<FormData> {
  const connections = withAnyRefFlags(await loadConnections(c.get('deps')));
  // Enabled first, then the busiest: the first card is the one most likely meant.
  const consumers = [...connections.consumers].sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      grantCount(connections, b.id) - grantCount(connections, a.id) ||
      a.name.localeCompare(b.name),
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
  /** `consumer=new` was asked for: the credential access rule fieldset is the add form. */
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
  /** The prefill query (`copy`, `repository`) that "Change credential" keeps. */
  prefill?: { copy?: string; repository?: string };
}

/**
 * The credential access rule a plain "Add issuer access rule" preselects (input rule 2: the most used value):
 * the enabled consumer with the most accesses, when one has strictly more than every other.
 */
function mostUsedConsumer(data: FormData): string {
  const ranked = data.consumers
    .filter((consumer) => consumer.enabled)
    .map((consumer) => ({ id: consumer.id, n: grantCount(data.connections, consumer.id) }))
    .sort((a, b) => b.n - a.n);
  const [first, second] = ranked;
  if (!first || first.n === 0 || (second && second.n === first.n)) return '';
  return first.id;
}

function labelsOf(connections: Connections, consumerId: string): ClaimLabel[] {
  return connections.labels.filter((label) => label.credential_access_rule_id === consumerId);
}

function grantCount(connections: Connections, consumerId: string): number {
  return connections.accesses.filter((edge) => edge.grant.credential_access_rule_id === consumerId)
    .length;
}

/** Accesses per repository ID of one consumer. */
function repositoryUse(
  profile: Pick<IssuerProfile, 'id'>,
  connections: Connections,
  consumerId: string,
): Map<string, number> {
  const claims = anchorClaims(profile);
  const use = new Map<string, number>();
  if (claims === null) return use;
  for (const edge of connections.accesses) {
    if (edge.grant.credential_access_rule_id !== consumerId) continue;
    for (const c of edge.grant.conditions) {
      if (c.claim !== claims.repository) continue;
      for (const value of c.values) use.set(value, (use.get(value) ?? 0) + 1);
    }
  }
  return use;
}

function repositoryOptions(
  profile: Pick<IssuerProfile, 'id'>,
  labels: readonly ClaimLabel[],
  connections: Connections,
  consumerId: string,
): Suggestion[] {
  const claims = anchorClaims(profile);
  if (claims === null) return [];
  const use = repositoryUse(profile, connections, consumerId);
  return labels
    .filter((label) => label.claim === claims.repository)
    .sort(
      (a, b) => (use.get(b.value) ?? 0) - (use.get(a.value) ?? 0) || a.label.localeCompare(b.label),
    )
    .map((label) => ({ value: idText(label.value, label.label) }));
}

/** Accesses per repository option value (`name (ID)`), for the picker's usage column. */
function repositoryCounts(
  profile: Pick<IssuerProfile, 'id'>,
  labels: readonly ClaimLabel[],
  connections: Connections,
  consumerId: string,
): Record<string, number> {
  const claims = anchorClaims(profile);
  if (claims === null) return {};
  const use = repositoryUse(profile, connections, consumerId);
  return Object.fromEntries(
    labels
      .filter((label) => label.claim === claims.repository)
      .map((label) => [idText(label.value, label.label), use.get(label.value) ?? 0]),
  );
}

/** A credential access rule built in memory from the add fields, for validation before anything is written. */
function pendingConsumer(
  input: ConsumerInput | null,
  type: ProfileId,
  existing: readonly CredentialAccessRule[],
): CredentialAccessRule {
  const profile = PROFILES[type];
  const claim = tenantClaimOf(type);
  const issuer = input ? consumerIssuer(input) : (profile.defaults.issuer ?? '');
  const match =
    claim !== null ? existing.find((p) => p.profile === type && p.issuer === issuer) : undefined;
  const pin: Condition[] = [];
  if (claim !== null) {
    // The merge adds to the values the stored pin admits (its conditions are ANDed).
    const values = [
      ...new Set([
        ...(match ? pinValues(match.tenant_pin, claim) : []),
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
    credential_id: input?.credential_id ?? '',
    conditions: input?.conditions ?? [],
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
  provider: CredentialAccessRule,
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
  provider: CredentialAccessRule,
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
    repositoryCounts: repositoryCounts(profile, labels, data.connections, provider.id),
    mostUsedContext: shapes.length > 0 ? mostUsedContext(shapes, profile) : null,
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
      newHref: null,
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
      // Keeps the copied constraints and the repository; only the token is chosen again.
      changeHref:
        tokens.length > 1
          ? paths.accessNew({
              consumer: seed.consumerId || undefined,
              copy: seed.prefill?.copy,
              repository: seed.prefill?.repository,
            })
          : null,
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
    origin: new URL(c.req.url).origin,
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
    /** The denied request the form was prefilled from (header, rail, Back link). */
    request?: RequestFacts;
  } = {},
) {
  const plainHeader = (
    <PageHeader
      crumbs={[
        { label: 'Issuer access rules', href: paths.access() },
        { label: 'Add issuer access rule' },
      ]}
      title="Add issuer access rule"
      description="Choose a credential access rule, the jobs, and what they may call. Everything is preset; change only what differs."
    />
  );
  if (data.tokens.length === 0) {
    return renderPage(
      c,
      {
        title: 'Add issuer access rule',
        section: 'consumers',
        subsection: 'access',
        status: options.status ?? 200,
        header: plainHeader,
      },
      (ctx) => (
        <UiEmptyState
          headingLevel={2}
          title="A credential manager must add a credential first."
          description="Issuer access rules lets the jobs of a credential access rule use a credential."
          actions={
            ctx.can('tokens:write') ? (
              <Button variant="primary" plus href={paths.tokenNew()}>
                Add credential
              </Button>
            ) : (
              <AskSomeone permission="tokens:write" ctx={ctx} verb="add a credential" />
            )
          }
        />
      ),
    );
  }
  const model = await buildFormModel(c, data, seed);
  const fixedToken =
    seed.tokenView === 'fixed' ? data.tokens.find((token) => token.id === seed.tokenId) : undefined;
  const request = options.request;
  const consumer = data.consumers.find((item) => item.id === seed.consumerId);
  let header: Child = plainHeader;
  let entry: FormEntry = { cancelHref: paths.access(), cancelLabel: 'Cancel' };
  if (request) {
    header = (
      <PageHeader
        crumbs={[
          { label: 'Requests', href: paths.requests() },
          { label: `${request.id.slice(0, 12)}…`, href: paths.request(request.id) },
          { label: 'Give access' },
        ]}
        title={`Allow this call from ${request.repository ?? consumer?.name ?? 'this caller'}`}
        description="Creates an issuer access rule that lets exactly this caller make exactly this call."
      />
    );
    entry = { cancelHref: paths.request(request.id), cancelLabel: 'Back to the request', request };
  } else if (fixedToken) {
    header = (
      <PageHeader
        crumbs={[
          { label: 'Credentials', href: paths.tokens() },
          { label: fixedToken.name, href: paths.token(fixedToken.id) },
          { label: 'Add issuer access rule' },
        ]}
        title={`Add issuer access rule to ${fixedToken.name}`}
        description={`Choose which jobs can call ${fixedToken.name} and what they may do. Everything is preset; change only what differs.`}
      />
    );
    entry = { cancelHref: paths.token(fixedToken.id), cancelLabel: 'Cancel' };
  }
  model.entry = entry;
  return renderPage(
    c,
    {
      title: 'Add issuer access rule',
      section: 'consumers',
      subsection: 'access',
      errors: seed.errors,
      errorSummary: seed.errors.length > 0 ? { title: 'The access was not saved' } : undefined,
      status: options.status ?? 200,
      notice: seed.errors.length > 0 ? null : (options.notice ?? null),
      header,
    },
    () => (
      <>
        {options.banner ?? null}
        <AccessForm model={model} />
      </>
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// GET /admin/issuer-access-rules/new

async function newPage(c: AdminContext) {
  const data = await loadFormData(c);
  const query = (name: string) => c.req.query(name) ?? '';
  const fromRequest = query('from_request');
  if (fromRequest) return prefillFromRequest(c, data, fromRequest);
  let consumerId = query('consumer');
  // Only an explicit `?token=` fixes the token; a copy's token is preselected among the choices.
  const explicitToken = query('token');
  let tokenId =
    explicitToken || data.consumers.find((rule) => rule.id === consumerId)?.credential_id || '';
  let jobs: JobsForm | null = null;
  let ops: OpsForm | null = null;
  let banner: Child | null = null;
  let hidden: Record<string, string> = {};
  const copyId = query('copy');
  if (copyId) {
    const source = await getIssuerAccessRule(c.get('deps').env.DB, copyId);
    const sourceConsumer = source
      ? data.consumers.find((p) => p.id === source.credential_access_rule_id)
      : undefined;
    const profile = sourceConsumer ? getProfile(sourceConsumer.profile) : null;
    if (source && sourceConsumer && profile) {
      consumerId = sourceConsumer.id;
      tokenId = tokenId || source.service_id;
      hidden = { copy: source.id };
      const labels = labelsOf(data.connections, sourceConsumer.id);
      jobs = accessFormFromIssuerAccessRule(source, profile, labels);
      const repository = prefillRepository(query('repository'), profile, labels);
      const retargeted = repository !== null && retarget(jobs, profile, repository);
      const target = data.tokens.find((token) => token.id === tokenId);
      const sourceToken = data.tokens.find((token) => token.id === source.service_id);
      if (target && sourceToken && sameOperationSource(target, sourceToken)) {
        const sets = ruleSetsOf(await tokenAccessShapes(c.get('deps').env.DB, target.id));
        // Reverse-match against the source's repository; {repo} is re-substituted on submit.
        ops = opsFormFromRules(
          source.rules,
          templateForService(target),
          sets,
          repositoryLabelOf(source, labels, profile),
        );
      }
      banner = (
        <Callout
          title={
            <>
              Copied the constraints of “{source.name}”
              {retargeted && repository ? (
                <> for {idText(repository.id, repository.label)}</>
              ) : null}
              .
            </>
          }
        >
          Change what differs, then save.
        </Callout>
      );
    } else {
      banner = <Callout tone="warn" title="That access no longer exists; nothing was copied." />;
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
      const repository = prefillRepository(query('repository'), profile, labels);
      if (repository) jobs.repository = idText(repository.id, repository.label);
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
          : mostUsedConsumer(data),
    tokenId: data.tokens.some((token) => token.id === tokenId)
      ? tokenId
      : data.tokens.length === 1
        ? (data.tokens[0]?.id ?? '')
        : '',
    consumerView: consumerId === 'new' ? 'new' : knownConsumer ? 'fixed' : 'auto',
    tokenView: data.tokens.some((token) => token.id === explicitToken) ? 'fixed' : 'auto',
    jobs,
    ops,
    errors: [],
    ack: null,
    hidden,
    prefill: {
      copy: hidden.copy,
      repository: query('repository').slice(0, 300) || undefined,
    },
  };
  // Prefilled risky values need an explicit acknowledgement on this render (A7.7 rule 4).
  if (copyId && jobs) seed.ack = await prefillAck(c, data, seed);
  const consumerForNotice = data.consumers.find((p) => p.id === consumerId) ?? null;
  return renderForm(c, data, seed, {
    ...(banner ? { banner } : {}),
    notice: notice(c, { grant: null, consumer: consumerForNotice }),
  });
}

/**
 * `?repository=` of a prefill: `name (ID)` keeps the typed name (a copy to a repository with no
 * stored name yet), a bare ID takes its stored name. The name is written only when the form is
 * saved. Null when the value is not a repository at all.
 */
function prefillRepository(
  raw: string,
  profile: IssuerProfile,
  labels: readonly ClaimLabel[],
): { id: string; label: string | null } | null {
  const input = raw.trim().slice(0, 300);
  if (input === '' || anchorClaims(profile) === null) return null;
  const parsed = parseRepositoryInput(input, profile, labels);
  if (parsed.ok) return parsed.value;
  const bare = parseIdWithLabel(input);
  return bare ? { id: bare.id, label: null } : null;
}

/**
 * Points copied jobs at another repository: the structured repository input, or the one exact
 * repository condition of the rows editor. False when the rows have no single such condition.
 */
function retarget(
  jobs: JobsForm,
  profile: IssuerProfile,
  repository: { id: string; label: string | null },
): boolean {
  const claims = anchorClaims(profile);
  if (claims === null) return false;
  if (jobs.editor === 'structured') {
    jobs.repository = idText(repository.id, repository.label);
    return true;
  }
  const rows = jobs.cond.filter((row) => {
    if (row.claim !== claims.repository || row.match !== 'exact' || row.not) return false;
    const values = parseValueList(row.values);
    return values.ok && values.values.length === 1;
  });
  const [row] = rows;
  if (rows.length !== 1 || !row) return false;
  row.values = repository.id;
  return true;
}

function repositoryLabelOf(
  grant: Pick<IssuerAccessRule, 'conditions'>,
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

/**
 * True when copied literal operations (custom rows and "used by other accesses" sets; presets are
 * re-targeted through {repo}) may name the source repository: its name, its URL-encoded name
 * (GitLab) or its ID. Without a stored name, any literal operation counts.
 */
function namesRepository(
  ops: OpsForm,
  sets: ReturnType<typeof ruleSetsOf>,
  label: string | null,
  id: string | null,
): boolean {
  const paths_ = [
    ...ops.rule.map((row) => row.path),
    ...sets.filter((set) => ops.op.includes(set.id)).flatMap((set) => set.rules.map((r) => r.path)),
  ].map((path) => path.toLowerCase());
  if (paths_.length === 0) return false;
  if (label === null) return true;
  const needles = [label, encodeURIComponent(label), ...(id ? [id] : [])].map((n) =>
    n.toLowerCase(),
  );
  return paths_.some((path) => needles.some((needle) => path.includes(needle)));
}

/** The acknowledgement a prefilled form needs on its first render, or null. */
async function prefillAck(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
): Promise<FormSeed['ack']> {
  const evaluation = await evaluateForm(c, data, { ...seed, fields: null }, null);
  return ackOf(evaluation.ok ? evaluation.risks : await placeholderRisks(c, data, seed));
}

function ackOf(risks: Risks | null): FormSeed['ack'] {
  if (!risks || risks.messages.length === 0) return null;
  return { digest: risks.digest, warnings: risks.messages };
}

/**
 * The risks of a prefilled (or re-rendered) form whose repository does not parse yet: no stored
 * name, or an organization still to add. Anchors never change the risks (the warnings name refs,
 * environments, events and methods only), so a placeholder repository and organization stand in,
 * and the digest is the one the form has once the repository parses (A7.7 rule 4).
 */
async function placeholderRisks(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
): Promise<Risks | null> {
  const chosen = chosenBranch(data, seed);
  if (!chosen || 'error' in chosen) return null;
  const profile = getProfile(chosen.provider.profile);
  const token = data.tokens.find((item) => item.id === seed.tokenId);
  if (!profile || !token) return null;
  const jobs = seed.fields ? readJobsForm(seed.fields, chosen.prefix, profile) : seed.jobs;
  if (!jobs) return null;
  const claims = anchorClaims(profile);
  let provider = chosen.provider;
  let labels: ClaimLabel[] = [];
  let form = jobs;
  if (jobs.editor === 'structured' && claims) {
    provider = {
      ...provider,
      tenant_pin: [{ claim: claims.owner, match: 'exact', values: ['1'] }],
    };
    labels = withTypedLabels([], provider.id, [
      { claim: claims.owner, value: '1', label: 'placeholder' },
    ]);
    form = {
      ...jobs,
      repository: jobs.repository.trim() === '' ? '' : 'placeholder/repository (2)',
      new_owner: '',
      owner_id: '1',
    };
  }
  const parsed = parseJobs(form, { profile, provider, labels, prefix: chosen.prefix });
  if (!parsed.conditions) return null;
  const tokenFixed = data.tokens.length === 1 || seed.tokenView === 'fixed';
  const opsPrefix = tokenFixed ? '' : `${token.id}.`;
  const sets = ruleSetsOf(await tokenAccessShapes(c.get('deps').env.DB, token.id));
  const template = templateForService(token);
  const ops = seed.fields
    ? readOpsForm(seed.fields, opsPrefix)
    : (seed.ops ?? defaultOpsForm(template, sets));
  const rules =
    parseOps(ops, {
      token,
      template,
      ruleSets: sets,
      repositoryLabel: parsed.repository?.label ?? null,
      prefix: opsPrefix,
    }).rules ?? [];
  const validation = validateIssuerAccessRule(
    { conditions: parsed.conditions, rules },
    profile,
    provider,
    token,
  );
  return risksOf(
    accessWarningDetails(validation.warningDetails, parsed.conditions, profile),
    parsed.risks,
    parsed.presetWarnings,
  );
}

/** `?from_request=`: an access matching exactly the caller of a denied, verified request. */
async function prefillFromRequest(c: AdminContext, data: FormData, requestId: string) {
  const deps = c.get('deps');
  const record = await getRequest(deps.env.TELEMETRY_DB, requestId);
  const claims = record ? parseJson(record.caller_claims) : null;
  const provider = record?.credential_access_rule_id
    ? data.consumers.find((p) => p.id === record.credential_access_rule_id)
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
        errors: [
          {
            field: null,
            message:
              'This request cannot prefill the form. Only requests that were denied with “no matching access” or “event not trusted”, whose token was verified, and whose credential access rule and credential still exist can.',
          },
        ],
      },
      () => (
        <p>
          <Button href={paths.accessNew()}>Add issuer access rule from scratch</Button>
        </p>
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
    // Consumer and token are those of the request (brief con-access-risk); Change opens the
    // plain form for another token.
    tokenId: token.id,
    consumerView: 'fixed',
    tokenView: 'fixed',
    jobs,
    ops,
    errors: [],
    ack: null,
    hidden: { from_request: record.id },
  };
  seed.ack = await prefillAck(c, data, seed);
  const ref = claimText(claims, 'ref');
  return renderForm(c, data, seed, {
    request: {
      id: record.id,
      ts: record.ts,
      method: record.method,
      path: record.path,
      status: record.status,
      reason: reasonText(record.reason) ?? 'Denied',
      repository: repositoryLabel,
      ref: ref ? ref.replace(/^refs\/(heads|tags)\//, '') : null,
    },
    banner: (
      <Callout
        title={
          <>
            Prefilled from request <Mono>{record.id.slice(0, 12)}…</Mono>:
          </>
        }
        actions={
          <Button size="sm" href={paths.request(record.id)}>
            Open the request
          </Button>
        }
      >
        these values match exactly that caller and call. Change what you need, then save.
        {ops.op.length === 0 && ops.rule.length === 0
          ? literalPath
            ? ''
            : ' No operation was prefilled: the path contains "*" or "%2F", which an operation cannot match literally ("*" is a wildcard; "%2F" needs "**"). Add the narrowest one under Other operations.'
          : ''}
      </Callout>
    ),
  });
}

/** Structured "Which jobs" values from a verified request's claims, or rows for other events. */
function jobsFromClaims(
  profile: IssuerProfile,
  provider: CredentialAccessRule,
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
  provider: CredentialAccessRule,
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
      provider: CredentialAccessRule;
      profile: IssuerProfile;
      token: Service;
      consumerInput: ConsumerInput | null;
      jobs: JobsForm;
      conditions: Condition[];
      rules: Rule[];
      labels: IssuerAccessRuleLabel[];
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
  | { provider: CredentialAccessRule; prefix: string; consumerInput: ConsumerInput | null }
  | { error: FieldError }
  | null {
  const fields = seed.fields;
  const consumers = data.consumers;
  if (seed.consumerId === 'new' || consumers.length === 0) {
    const form: ConsumerForm = fields ? readConsumerForm(fields, 'new.') : blankConsumerForm();
    const parsed = parseConsumerForm(form, 'new.');
    if (!parsed.ok)
      return {
        error: parsed.errors[0] ?? {
          field: 'new.type',
          message: 'Choose a credential access rule type.',
        },
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
  editing: IssuerAccessRule | null,
): Promise<Evaluation> {
  const deps = c.get('deps');
  const errors: FieldError[] = [];
  const fields = seed.fields;
  let consumerErrors: FieldError[] = [];
  let branch: {
    provider: CredentialAccessRule;
    prefix: string;
    consumerInput: ConsumerInput | null;
  } | null = null;
  if (editing) {
    const provider = data.consumers.find((p) => p.id === editing.credential_access_rule_id);
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
    errors.push({ field: 'consumer_id', message: 'Choose a credential access rule.' });
  }
  const tokenId = editing ? editing.service_id : seed.tokenId;
  const token = data.tokens.find((item) => item.id === tokenId) ?? null;
  if (!token) errors.push({ field: 'token_id', message: 'Choose a credential.' });
  if (!branch || !token)
    return { ok: false, errors: [...consumerErrors, ...errors], unknownOwner: null };
  if (branch.consumerInput || branch.provider.credential_id !== token.id) {
    return {
      ok: false,
      errors: [
        {
          field: 'consumer_id',
          message:
            'Choose an existing credential access rule for this credential. A credential administrator must create its limits first.',
        },
      ],
      unknownOwner: null,
    };
  }
  const profile = getProfile(branch.provider.profile);
  if (!profile)
    return {
      ok: false,
      errors: [{ field: null, message: 'The credential access rule has an unknown type.' }],
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

  // The credential access rule the access is checked against: with the new organization when one is added.
  const provider = branch.provider;
  const checkLabels = labels;
  if (parsedJobs.newOwner)
    return {
      ok: false,
      errors: [
        {
          field: null,
          message:
            'This organization is outside the credential access rule. Ask a credential administrator to change the boundary.',
        },
      ],
      unknownOwner: null,
    };
  const nameLabels = withTypedLabels(checkLabels, provider.id, parsedJobs.labels);
  const derivedName = deriveAccessName(token.name, parsedJobs.conditions, nameLabels);
  let name = derivedName;
  if (editing) {
    const storedDerived = deriveAccessName(token.name, editing.conditions, labels);
    name = editing.name === storedDerived ? derivedName : editing.name;
  }
  const checked = await checkIssuerAccessRule(
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
  const risks = await risksOf(
    accessWarningDetails(checked.warningDetails, parsedJobs.conditions, profile),
    parsedJobs.risks,
    parsedJobs.presetWarnings,
  );
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

/** The input a validateIssuerAccessRule error belongs to. */
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
    return `Each access needs exact, non-negated conditions on the credential access rule's anchor claims: ${message.replace(/^the grant must have /, '')}`;
  }
  if (message.includes("outside the credential access rule's tenant pin")) {
    return `${message.replace("outside the credential access rule's tenant pin", 'are not organizations or groups of this credential access rule')}. Add them to the credential access rule first.`;
  }
  return message;
}

/**
 * A form prefilled from a copy or a request (its hidden marker): every save of it goes through the
 * digest and the box while it has risks, so a prefilled selection never accepts one.
 */
function isPrefilled(fields: Fields): boolean {
  return text(fields, 'copy') !== '' || text(fields, 'from_request') !== '';
}

/**
 * A7.7: is the risk set of this result accepted by the selection or by the digest and the box? A
 * prefilled form's selection was not made by the admin, so it covers nothing (rule 4).
 */
async function acceptance(
  fields: Fields,
  evaluation: Extract<Evaluation, { ok: true }>,
): Promise<
  { ok: true } | { ok: false; error: FieldError; ack: { digest: string; warnings: string[] } }
> {
  const { risks } = evaluation;
  const covered = isPrefilled(fields) ? new Set<WarningCode>() : evaluation.covered;
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
// POST /admin/issuer-access-rules

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
    // The prefill marker stays on every re-render of the form.
    hidden: Object.fromEntries(
      (['copy', 'from_request'] as const)
        .map((name) => [name, text(fields, name).slice(0, 100)])
        .filter(([, value]) => value !== ''),
    ),
    prefill: { copy: text(fields, 'copy').slice(0, 100) || undefined },
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
    // A prefilled form keeps showing the risks it carries while another input is fixed.
    const ack = isPrefilled(fields) ? ackOf(await placeholderRisks(c, data, seed)) : null;
    return renderForm(
      c,
      data,
      { ...seed, errors: evaluation.errors, unknownOwner: evaluation.unknownOwner, ack },
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

  // Step 4: the credential access rule (new, or merged) and a new organization, each its own audited change.
  let providerId = evaluation.provider.id;
  let savedConsumer: CredentialAccessRule | null = null;
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
    providerId = created.credentialAccessRule.id;
    savedConsumer = created.credentialAccessRule;
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
  const result = await createIssuerAccessRule(deps, actor, {
    name: evaluation.name,
    credential_access_rule_id: providerId,
    service_id: evaluation.token.id,
    conditions: evaluation.conditions,
    rules: evaluation.rules,
    expires_at: evaluation.expiresAt,
    acknowledge_warnings: true,
    accepted_risks: evaluation.risks.codes,
    labels: evaluation.labels,
  });
  if (result.ok) return redirectWithNotice(c, paths.accessItem(result.grant.id), 'created');
  // Step 6: the credential access rule may already be saved; keep everything and preselect it.
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

function savedNote(consumer: CredentialAccessRule): FieldError {
  return {
    field: null,
    message: `Consumer ${consumer.name} was saved; the access was not. Fix the errors and save again.`,
  };
}

/**
 * After an inline consumer create succeeded and the access failed: the new credential access rule is fixed, and
 * the access values move from the `new.<type>.` branch to the unprefixed one, so nothing is lost.
 */
function seedAfterConsumerSaved(
  seed: FormSeed,
  providerId: string,
  saved: CredentialAccessRule | null,
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
  const grant = await getIssuerAccessRule(deps.env.DB, c.req.param('id') ?? '');
  if (!grant) return null;
  const formData_ = data ?? (await loadFormData(c));
  const consumer = formData_.consumers.find((p) => p.id === grant.credential_access_rule_id);
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
  const validation = validateIssuerAccessRule(
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
      other.grant.credential_access_rule_id === consumer.id &&
      other.grant.service_id === token.id &&
      anchorsOf(other, labels).some(
        (anchor) => overlapKeys.has(anchor.key) && !anchor.key.startsWith('custom:'),
      ),
  );
  const template = templateForService(token);
  const sets = ruleSetsOf(await tokenAccessShapes(deps.env.DB, token.id));
  const editing = state.edit;
  const editJobs = editing?.fields ? null : accessFormFromIssuerAccessRule(grant, profile, labels);
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
  // The rows editor shows the stored warnings with their acknowledgement up front (A7.7 rule 4).
  if (!editSeed.ack && editJobs?.editor === 'rows')
    editSeed.ack = await prefillAck(c, data, editSeed);
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
        // "Keep" exists only for a stored date; an access that never expires starts on Never.
        expiry: editing?.fields
          ? readExpiryForm(editing.fields)
          : { expires: grant.expires_at === null ? 'never' : 'keep', expires_on: '' },
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
  const { history, acceptedBy } = await accessHistory(c, grant.id);
  const model: AccessPageModel = {
    history,
    acceptedBy,
    grant,
    edge,
    consumer,
    profile,
    token,
    tokens: data.tokens,
    template,
    labels,
    warningDetails: accessWarningDetails(validation.warningDetails, grant.conditions, profile),
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
      errors,
      status: state.status ?? 200,
      notice: errors.length > 0 ? null : notice(c, { grant, consumer }),
      header: (ctx) => <AccessHeader model={model} ctx={ctx} />,
    },
    (ctx) => <AccessPage model={model} ctx={ctx} />,
  );
}

/** The rail history of an access (newest audit rows) and who accepted its current risks. */
async function accessHistory(
  c: AdminContext,
  grantId: string,
): Promise<{ history: HistoryEntry[]; acceptedBy: AccessPageModel['acceptedBy'] }> {
  const events = await listAuditEvents(c.get('deps').env.DB, { targetId: grantId, limit: 20 });
  const actor = (event: (typeof events)[number]) =>
    event.actor_email ?? (event.actor_type === 'system' ? 'tokengate' : 'Someone');
  const accepted = events.find((event) => {
    const risks = event.diff?.accepted_risks;
    return Array.isArray(risks) && risks.length > 0;
  });
  return {
    history: events.slice(0, 3).map((event) => ({
      ts: event.ts,
      actor: actor(event),
      summary: `${actor(event)}: ${event.summary}`,
    })),
    acceptedBy: accepted ? { actor: actor(accepted), ts: accepted.ts } : null,
  };
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
    const result = await updateIssuerAccessRule(deps, actor, grant.id, {
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
    consumerId: grant.credential_access_rule_id,
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
      const added = await addTenantValue(deps, actor, grant.credential_access_rule_id, {
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
  const result = await updateIssuerAccessRule(deps, actor, grant.id, {
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
  // A picked repository, else the one typed under "Another…" (repository_other).
  const repositoryRaw = text(fields, 'repository') || text(fields, 'repository_other');
  const tokenId = text(fields, 'token_id') || sourceToken.id;
  const target = data.tokens.find((item) => item.id === tokenId);
  const labels = labelsOf(data.connections, consumer.id);
  const state = (errors: Record<string, string>): PageState => ({
    copy: { repository: repositoryRaw, tokenId, errors },
    status: 422,
  });
  if (!target) return renderAccessPage(c, loaded, state({ token_id: 'Choose a credential.' }));
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
  const jobs = accessFormFromIssuerAccessRule(grant, profile, labels);
  const sameSource = sameOperationSource(target, sourceToken);
  const sets = ruleSetsOf(await tokenAccessShapes(deps.env.DB, target.id));
  const ops = opsFormFromRules(grant.rules, templateForService(target), sets, sourceRepository);
  // Review first, with nothing written: another operation source; constraints only the rows
  // editor shows; literal operations that may still name the source repository (a copy for
  // another repository would call it); or an expired source (choose the copy's expiry).
  const review = !sameSource
    ? 'copy_review'
    : jobs.editor !== 'structured'
      ? 'copy_review_rows'
      : repository.id !== sourceRepositoryId &&
          namesRepository(ops, sets, sourceRepository, sourceRepositoryId)
        ? 'copy_review_paths'
        : grant.expires_at !== null && grant.expires_at <= deps.now()
          ? 'copy_review_expired'
          : null;
  if (review) {
    return redirectWithNotice(
      c,
      paths.accessNew({
        copy: grant.id,
        token: target.id,
        // The typed name travels with the ID: the repository may have no stored name yet.
        repository: idText(repository.id, repository.label),
      }),
      review,
    );
  }
  jobs.repository = idText(repository.id, repository.label);
  const banner = (
    <Callout
      title={
        <>
          Copied the constraints of “{grant.name}” for {jobs.repository}.
        </>
      }
    >
      Change what differs, then save.
    </Callout>
  );
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
    hidden: { copy: grant.id },
    prefill: { copy: grant.id, repository: jobs.repository },
  };
  const evaluation = await evaluateForm(c, data, seed, null);
  if (!evaluation.ok) {
    // An unknown organization (new_owner) or another problem: the prefilled create form, with
    // the risks the copy carries (A7.7 rule 4).
    return renderForm(
      c,
      data,
      {
        ...seed,
        errors: evaluation.errors,
        unknownOwner: evaluation.unknownOwner,
        ack: await prefillAck(c, data, seed),
      },
      { status: 422, banner },
    );
  }
  const sourceCodes = new Set<WarningCode>(
    accessWarningDetails(
      validateIssuerAccessRule(
        { conditions: grant.conditions, rules: grant.rules },
        profile,
        consumer,
        sourceToken,
      ).warningDetails,
      grant.conditions,
      profile,
    ).map((d) => d.code),
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
      { status: 422, banner },
    );
  }
  const result = await duplicateIssuerAccessRule(deps, adminActor(c), grant.id, {
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
  const result = await setIssuerAccessRuleEnabled(c.get('deps'), adminActor(c), id, enabled);
  if (result.ok) {
    const back = returnPath('POST /admin/issuer-access-rules/:id/toggle', form._return, { id });
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
  const result = await deleteIssuerAccessRule(
    c.get('deps'),
    adminActor(c),
    c.req.param('id') ?? '',
  );
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
    {
      title: 'Issuer access rules not found',
      section: 'consumers',
      subsection: 'access',
      status: 404,
      header: (
        <PageHeader
          crumbs={[{ href: paths.access(), label: 'Issuer access rules' }, { label: 'Not found' }]}
          title="Issuer access rules not found"
          description={notFoundText('access')}
        />
      ),
    },
    () => <NotFound />,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Notice entries the form page understands from other pages (closed set). */
export const ACCESS_FORM_NOTICES: readonly string[] = Object.keys(NOTICES);
export type { Notice };
