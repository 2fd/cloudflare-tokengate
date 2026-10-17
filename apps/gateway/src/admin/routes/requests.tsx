// Monitoring › Requests: the request log (outcome tabs, the time range control, "+ Token" style
// filter menus, a repository search, and cells that set filters too; keyset pagination both
// ways), and one record as a runbook: what happened, a re-evaluation against the current consumer
// accesses (always run, read-only), what to do, then the summary, the stored trace, claims and
// technical details. Claims shown are the allowlisted subset stored at request time (I-LOG-1), and
// only verified records have any or prefill a form (I-LOG-2). Query text is validated against
// closed sets and never echoed as a label.
import {
  ActiveFilters,
  AddFilter,
  ArrowRow,
  Badge,
  Button,
  Callout,
  Cell,
  Column,
  Disclosure,
  EmptyState,
  FieldError,
  type FilterOptionGroup,
  Filters,
  FilterSearch,
  Grid,
  Identity,
  KeyValue,
  LinkAction,
  Mono,
  NextStep,
  PageHeader,
  Panel,
  type PrefillValue,
  RailKeyValue,
  type RailKeyValueItem,
  RelationLine,
  Result,
  Row,
  RowHeader,
  Segmented,
  Stack,
  Table,
  TabRow,
  Tabs,
  Time as UiTime,
  Trace,
  type TraceStep,
  Tray,
  ZeroState,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { repositoryLabelOptions } from '../../db/claim-labels';
import {
  getCredentialAccessRule,
  listCredentialAccessRules,
} from '../../db/credential-access-rules';
import { getService, listServices } from '../../db/credentials';
import { listIssuerAccessRules } from '../../db/issuer_access_rules';
import {
  getRequest,
  type RequestFilter,
  REQUEST_SCAN_ROWS,
  type RequestPage,
  searchRequests,
} from '../../db/requests';
import { getSettings } from '../../db/settings';
import type { CredentialAccessRule, IssuerAccessRule, Service } from '../../db/types';
import { tenantPinHolds } from '../../identity/jwt';
import { getProfile } from '../../identity/profiles';
import type { Claims } from '../../identity/types';
import { idTimestamp } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { boundaryHolds, conditionsWithin } from '../../policy/boundaries';
import { evaluateIssuerAccessRules } from '../../policy/evaluate';
import type { Decision, TraceEntry } from '../../policy/types';
import { canonicalizePath } from '../../proxy/path';
import {
  parseRange,
  RANGE_LABEL,
  rangeStart,
  REQUESTS_RANGES,
  type RequestsRange,
} from '../../telemetry/ranges';
import type { Outcome, RequestRecord } from '../../telemetry/types';
import type { Permission } from '../auth/rbac';
import type { FieldError as FieldErrorData } from '../ops/shared';
import { paths } from '../paths';
import { type AdminContext, renderPage, type ViewContext } from '../render';
import { AskSomeone, NotFound, notFoundText } from '../views/components';
import { formatCount, formatDuration, formatTime } from '../views/format';
import {
  consumerLogo,
  extractRequestId,
  FIND_REQUEST_MAX,
  FindRequest,
  LogPager,
  LogTime,
  profileForIssuer,
  tokenLogo,
} from '../views/monitoring';
import {
  accessFixable,
  docsUrl,
  isReasonCode,
  REASON_CODES,
  REASON_GROUPS,
  reasonLabel,
  reasonText,
} from '../views/reasons';

const PAGE_SIZE = 50;
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const REQUEST_ID = new RegExp(`^req_${ULID}$`);
const SERVICE_ID = new RegExp(`^svc_${ULID}$`);
const PROVIDER_ID = new RegExp(`^cpr_${ULID}$`);
const GRANT_ID = new RegExp(`^grt_${ULID}$`);
const SLUG = /^[a-z0-9-]{1,63}$/;
/** owner/name, group/sub/project: the repository filter (HTML pattern, compiled with the v flag). */
export const REPO_PATTERN = '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)+';
const REPO = new RegExp(`^(?:${REPO_PATTERN})$`);
const REPO_MAX = 256;
const OUTCOMES: readonly Outcome[] = ['allowed', 'denied', 'error'];

const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  allowed: 'Allowed',
  denied: 'Denied',
  error: 'Errors',
};

/** Validated query of the list: every value is from a closed set or matches its pattern. */
export interface RequestParams {
  range?: RequestsRange;
  outcome?: Outcome;
  /** A token id or `none`. */
  token?: string;
  /** A credential access rule id or `none`. */
  consumer?: string;
  access?: string;
  repo?: string;
  reason?: string;
  slug?: string;
  before?: string;
  after?: string;
}

type FilterKey = 'token' | 'consumer' | 'access' | 'repo' | 'reason' | 'slug';

/** The list URL for `params` with `changes` applied; a filter change always drops the cursor. */
function listLink(params: RequestParams, changes: Partial<RequestParams>): string {
  const cursorless =
    'before' in changes || 'after' in changes
      ? params
      : { ...params, before: undefined, after: undefined };
  return paths.requests({ ...cursorless, ...changes });
}

export function parseRequestParams(query: (name: string) => string | undefined): {
  params: RequestParams;
  errors: FieldErrorData[];
} {
  const params: RequestParams = {};
  const errors: FieldErrorData[] = [];
  const raw = (name: string) => query(name)?.trim() ?? '';
  const range = parseRange(raw('range'), REQUESTS_RANGES);
  if (range) params.range = range;
  else if (raw('range'))
    errors.push({
      field: null,
      message: 'That time range is not available; showing every request still kept.',
    });
  const outcome = parseRange(raw('outcome'), OUTCOMES);
  if (outcome) params.outcome = outcome;
  else if (raw('outcome'))
    errors.push({ field: null, message: 'That outcome is not available; showing every outcome.' });
  const token = raw('token');
  if (token) {
    if (token === 'none' || SERVICE_ID.test(token)) params.token = token;
    else errors.push({ field: 'token', message: 'Choose a token from the list.' });
  }
  const consumer = raw('consumer');
  if (consumer) {
    if (consumer === 'none' || PROVIDER_ID.test(consumer)) params.consumer = consumer;
    else
      errors.push({ field: 'consumer', message: 'Choose a credential access rule from the list.' });
  }
  const access = raw('access');
  if (access) {
    if (GRANT_ID.test(access)) params.access = access;
    else
      errors.push({
        field: null,
        message: 'That issuer access rules filter is not valid; it was removed.',
      });
  }
  const repo = raw('repo');
  if (repo) {
    if (repo.length <= REPO_MAX && REPO.test(repo)) params.repo = repo;
    else
      errors.push({
        field: 'repo',
        message: 'Enter the owner and name, like acme/api, or pick a suggestion.',
      });
  }
  const reason = raw('reason');
  if (reason) {
    if (isReasonCode(reason)) params.reason = reason;
    else errors.push({ field: 'reason', message: 'Choose a reason from the list.' });
  }
  const slug = raw('slug');
  if (slug) {
    if (SLUG.test(slug)) params.slug = slug;
    else
      errors.push({ field: null, message: 'That token slug filter is not valid; it was removed.' });
  }
  for (const cursor of ['before', 'after'] as const) {
    const value = raw(cursor);
    if (!value) continue;
    if (REQUEST_ID.test(value)) params[cursor] = value;
    else
      errors.push({
        field: null,
        message: 'The page position is not valid; showing the newest requests.',
      });
  }
  if (params.after) delete params.before;
  return { params, errors };
}

function toFilter(params: RequestParams, now: number): RequestFilter {
  return {
    ...(params.token === undefined
      ? {}
      : { service_id: params.token === 'none' ? null : params.token }),
    ...(params.consumer === undefined
      ? {}
      : { credential_access_rule_id: params.consumer === 'none' ? null : params.consumer }),
    ...(params.access ? { grant_id: params.access } : {}),
    ...(params.outcome ? { outcomeClass: params.outcome } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.repo ? { repository: params.repo } : {}),
    ...(params.slug ? { slug: params.slug } : {}),
    ...(params.range ? { since: rangeStart(params.range, now) } : {}),
    ...(params.before ? { before: params.before } : {}),
    ...(params.after ? { after: params.after } : {}),
  };
}

export function registerRequestsRoutes(app: App): void {
  app.get('/admin/requests', async (c) => {
    const deps = c.get('deps');
    const findRaw = c.req.query('id');
    let findError: string | null = null;
    if (findRaw !== undefined && findRaw.trim() !== '') {
      const id = extractRequestId(findRaw);
      if (id && REQUEST_ID.test(id) && (await getRequest(deps.env.TELEMETRY_DB, id))) {
        return c.redirect(paths.request(id), 303);
      }
      findError = id
        ? 'There is no request record with this ID. It may have been purged by data retention.'
        : 'Enter a request ID like req_01JB8Z5K2Q7W3N4M6P8R9T0V1X, or paste the log line that holds it.';
    }
    const { params, errors } = parseRequestParams((name) => c.req.query(name));
    if (findError) errors.unshift({ field: 'id', message: findError });
    return requestsPage(c, {
      params,
      errors,
      find: findError
        ? { value: (findRaw ?? '').slice(0, FIND_REQUEST_MAX), error: findError }
        : undefined,
      rawRepo: (c.req.query('repo') ?? '').trim().slice(0, REPO_MAX),
      status: findError ? 404 : errors.length > 0 ? 400 : 200,
    });
  });

  app.get('/admin/requests/:id', async (c) => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    const record = REQUEST_ID.test(id) ? await getRequest(deps.env.TELEMETRY_DB, id) : null;
    if (!record) {
      const settings = await getSettings(deps.env.DB);
      return renderPage(
        c,
        {
          title: 'Request not found',
          section: 'monitoring',
          subsection: 'requests',
          status: 404,
          header: (
            <PageHeader
              crumbs={[{ href: paths.requests(), label: 'Requests' }, { label: 'Not found' }]}
              title="Request not found"
              description={notFoundText('request')}
            >
              <FindRequest placement="header" />
            </PageHeader>
          ),
        },
        () => (
          <NotFound
            hint={{
              title: `Records are kept ${settings.request_log_retention_days} days.`,
              text: (
                <>
                  See <a href={paths.retention()}>Data retention</a>.
                </>
              ),
            }}
          />
        ),
      );
    }
    const db = deps.env.DB;
    const [service, provider, issuer_access_rules, settings] = await Promise.all([
      record.service_id ? getService(db, record.service_id) : null,
      record.credential_access_rule_id
        ? getCredentialAccessRule(db, record.credential_access_rule_id)
        : null,
      record.service_id ? listIssuerAccessRules(db, { service_id: record.service_id }) : [],
      getSettings(db),
    ]);
    const reevaluation =
      record.claims_verified === 1
        ? reevaluate(record, { service, provider, issuer_access_rules, now: deps.now() })
        : null;
    // One flag for every "Give access from this request" on the page (I-LOG-2): a verified record,
    // an access-fixable reason, and the re-evaluation does not already allow it.
    const accessAllowsNow = reevaluation?.ok === true && reevaluation.decision.decision === 'allow';
    const giveAccess =
      record.claims_verified === 1 && accessFixable(record.reason) && !accessAllowsNow;
    const outcome = OUTCOME_TITLE[shownOutcome(record)];
    const claims = storedClaims(record);
    const ref = refOf(claims);
    const repo = record.claims_verified === 1 ? record.caller_repository : null;
    return renderPage(
      c,
      {
        title: `${outcome}: ${record.method} ${record.path}`,
        section: 'monitoring',
        subsection: 'requests',
        header: (ctx) => (
          <PageHeader
            crumbs={[
              { href: paths.requests(), label: 'Requests' },
              { label: `${record.id.slice(0, 12)}…` },
            ]}
            identity={
              <Identity
                logo={tokenLogo(service)}
                title={
                  <>
                    <span class="vh">{outcome}: </span>
                    <Mono>
                      {record.method} {record.path}
                    </Mono>
                  </>
                }
                status={<OutcomeBadge record={record} />}
                slug={service?.slug ?? record.service_slug ?? undefined}
                entityId={{ value: record.id, kind: 'Request' }}
                facts={[
                  <>
                    <UiTime datetime={new Date(record.ts)} format="datetime" /> UTC
                  </>,
                ]}
              />
            }
            actions={
              service || (giveAccess && ctx.can('access:write')) ? (
                <>
                  {service ? (
                    <Button href={paths.token(service.id)}>Open {service.name}</Button>
                  ) : null}
                  {giveAccess && ctx.can('access:write') ? (
                    <Button variant="primary" href={paths.accessNew({ from_request: record.id })}>
                      Give access from this request
                    </Button>
                  ) : null}
                </>
              ) : undefined
            }
          >
            <RelationLine>
              HTTP {record.status}
              {record.reason ? (
                <>
                  {' '}
                  <code>{record.reason}</code>
                  {reasonText(record.reason) ? `: ${reasonText(record.reason)}` : ''}
                </>
              ) : null}
              {repo ? (
                <>
                  {' · '}
                  {REPO.test(repo) ? <a href={paths.requests({ repo })}>{repo}</a> : repo}
                  {ref ? (
                    <>
                      {' '}
                      on {ref.kind} <b>{ref.name}</b>
                    </>
                  ) : null}
                </>
              ) : null}
              {service ? (
                <>
                  {' → '}
                  <a href={paths.token(service.id)}>{service.name}</a>
                </>
              ) : null}
              .
            </RelationLine>
          </PageHeader>
        ),
      },
      (ctx) => (
        <RequestDetail
          ctx={ctx}
          record={record}
          service={service}
          provider={provider}
          issuer_access_rules={issuer_access_rules}
          reevaluation={reevaluation}
          giveAccess={giveAccess}
          accessAllowsNow={accessAllowsNow}
          retentionDays={settings.request_log_retention_days}
        />
      ),
    );
  });
}

const OUTCOME_TITLE: Readonly<Record<Outcome, string>> = {
  allowed: 'Allowed',
  denied: 'Denied',
  error: 'Error',
};

const OUTCOME_TONE: Readonly<Record<Outcome, { tone: 'ok' | 'bad' | 'warn'; glyph: string }>> = {
  allowed: { tone: 'ok', glyph: '✓' },
  denied: { tone: 'bad', glyph: '✕' },
  error: { tone: 'warn', glyph: '!' },
};

/** The outcome a person reads: an allowed call the upstream answered with a 5xx is an error, as the
 * Errors tab counts it ("Error 502", never a green "Allowed 502"). */
function shownOutcome(record: Pick<RequestRecord, 'outcome' | 'status'>): Outcome {
  return record.outcome === 'allowed' && record.status >= 500 ? 'error' : record.outcome;
}

/** "✕ Denied · 403": the outcome word and the HTTP status. */
function OutcomeBadge(props: { record: Pick<RequestRecord, 'outcome' | 'status'> }) {
  const shown = shownOutcome(props.record);
  const { tone, glyph } = OUTCOME_TONE[shown];
  return (
    <Badge tone={tone} glyph={glyph}>
      {OUTCOME_TITLE[shown]} · {props.record.status}
    </Badge>
  );
}

/** The branch, tag or environment of stored claims: "branch main", "environment production". */
function refOf(claims: Claims | null): { kind: string; name: string } | null {
  if (!claims) return null;
  const environment = claims.environment;
  if (typeof environment === 'string' && environment !== '') {
    return { kind: 'environment', name: environment };
  }
  const ref = claims.ref;
  if (typeof ref !== 'string' || ref === '') return null;
  if (ref.startsWith('refs/heads/')) return { kind: 'branch', name: ref.slice(11) };
  if (ref.startsWith('refs/tags/')) return { kind: 'tag', name: ref.slice(10) };
  const refType = claims.ref_type;
  if (refType === 'branch' || refType === 'tag') return { kind: refType, name: ref };
  return { kind: 'ref', name: ref };
}

function refText(claims: Claims | null): string | undefined {
  const ref = refOf(claims);
  return ref ? `${ref.kind} ${ref.name}` : undefined;
}

// ---------------------------------------------------------------------------------------------
// List

interface Names {
  tokens: ReadonlyMap<string, Service>;
  consumers: ReadonlyMap<string, CredentialAccessRule>;
  issuer_access_rules: ReadonlyMap<string, string>;
}

async function requestsPage(
  c: AdminContext,
  o: {
    params: RequestParams;
    errors: FieldErrorData[];
    find?: { value: string; error: string };
    rawRepo?: string;
    status: 200 | 400 | 404;
  },
) {
  const deps = c.get('deps');
  const { params } = o;
  const now = deps.now();
  const [credentials, providers, issuer_access_rules, repos, page] = await Promise.all([
    listServices(deps.env.DB),
    listCredentialAccessRules(deps.env.DB),
    listIssuerAccessRules(deps.env.DB),
    repositoryLabelOptions(deps.env.DB),
    searchRequests(deps.env.TELEMETRY_DB, { ...toFilter(params, now), limit: PAGE_SIZE + 1 }),
  ]);
  const names: Names = {
    tokens: new Map(credentials.map((s) => [s.id, s])),
    consumers: new Map(providers.map((p) => [p.id, p])),
    issuer_access_rules: new Map(issuer_access_rules.map((g) => [g.id, g.name])),
  };
  const { rows, pager } = paginate(params, page);
  const titleParts = [
    params.outcome ? OUTCOME_LABEL[params.outcome].toLowerCase() : null,
    params.range ? `last ${RANGE_LABEL[params.range]}` : null,
    params.token ? `token ${tokenName(params.token, names.tokens)}` : null,
    params.consumer ? `consumer ${consumerName(params.consumer, names.consumers)}` : null,
    params.access
      ? `access ${names.issuer_access_rules.get(params.access) ?? params.access}`
      : null,
    params.repo ? params.repo : null,
    params.reason ? reasonLabel(params.reason) : null,
    params.slug ? `slug ${params.slug}` : null,
  ].filter((part): part is string => part !== null);
  const filtered = Boolean(
    params.token ||
    params.consumer ||
    params.access ||
    params.repo ||
    params.reason ||
    params.slug ||
    params.outcome ||
    params.range,
  );
  // A7.1: the filter bar only when it can narrow something: an active filter or cursor, an invalid
  // value to correct, or more than 10 rows. Table cells set filters too.
  const showFilters =
    filtered || Boolean(params.before || params.after) || o.errors.length > 0 || rows.length > 10;
  const sentence = filtered ? listSentence(params, names) : null;
  return renderPage(
    c,
    {
      title: titleParts.length > 0 ? `Requests: ${titleParts.join(', ')}` : 'Requests',
      section: 'monitoring',
      subsection: 'requests',
      errors: o.errors,
      status: o.status,
      header: (
        <PageHeader
          title="Requests"
          description={
            sentence
              ? `${sentence.title}${sentence.rest}, newest first.`
              : 'Every call through tokengate, newest first. Select a repository, token or reason in a row to filter by it.'
          }
        >
          <FindRequest placement="header" value={o.find?.value} error={o.find?.error} />
          <TabRow>
            <Tabs
              label="Outcome"
              items={[
                {
                  label: 'All',
                  href: listLink(params, { outcome: undefined }),
                  current: !params.outcome,
                },
                ...OUTCOMES.map((key) => ({
                  label: OUTCOME_LABEL[key],
                  href: listLink(params, { outcome: key }),
                  current: params.outcome === key,
                })),
              ]}
            />
            <Segmented
              label="Time range"
              size="sm"
              items={[
                ...REQUESTS_RANGES.map((key) => ({
                  label: RANGE_LABEL[key],
                  href: listLink(params, { range: key }),
                  current: params.range === key,
                })),
                {
                  label: 'All',
                  href: listLink(params, { range: undefined }),
                  current: !params.range,
                },
              ]}
            />
          </TabRow>
          <ActiveFilters
            lead="Active filters"
            filters={filterChips(params, names)}
            clearHref={paths.requests()}
            clearLabel="Clear filters"
          />
        </PageHeader>
      ),
    },
    (ctx) => (
      <>
        {page.olderBefore ? (
          <Callout
            title={
              <>
                Searched the {formatCount(REQUEST_SCAN_ROWS)} requests before{' '}
                <UiTime datetime={new Date(idTimestamp(page.olderBefore) ?? now)} />.
              </>
            }
            actions={
              <LinkAction href={listLink(params, { before: page.olderBefore, after: undefined })}>
                Search older
              </LinkAction>
            }
          />
        ) : null}
        {page.newerAfter ? (
          <Callout
            title={
              <>
                Searched the {formatCount(REQUEST_SCAN_ROWS)} requests after{' '}
                <UiTime datetime={new Date(idTimestamp(page.newerAfter) ?? now)} />.
              </>
            }
            actions={
              <LinkAction href={listLink(params, { after: page.newerAfter, before: undefined })}>
                Search newer
              </LinkAction>
            }
          />
        ) : null}
        <OneCaller params={params} rows={rows} ctx={ctx} />
        <Tray
          id="requests"
          title={sentence ? sentence.title : 'Requests, newest first'}
          hideTitle={!sentence && showFilters}
          description={
            params.range ? (
              <>
                Since <UiTime datetime={new Date(rangeStart(params.range, now))} /> · newest first ·
                times in UTC
              </>
            ) : (
              'Times in UTC'
            )
          }
          bar={
            showFilters ? (
              <RequestFilters
                params={params}
                errors={o.errors}
                credentials={credentials}
                providers={providers}
                repos={[...new Set(repos.map((r) => r.label))]}
                rawRepo={o.rawRepo}
              />
            ) : undefined
          }
        >
          <Panel variant="flush">
            {/* no empty table: an empty log is its empty state (and a pager only when it can page) */}
            {rows.length > 0 ? (
              <RequestTable records={rows} params={params} names={names} now={now} />
            ) : null}
            {rows.length === 0 ? (
              filtered || params.before || params.after ? (
                <EmptyState
                  title={`No requests match these filters${page.olderBefore || page.newerAfter ? ' in this range' : ''}.`}
                  actions={<Button href={paths.requests()}>Clear filters</Button>}
                />
              ) : (
                <EmptyState
                  title="No requests recorded yet."
                  description={
                    <>
                      Requests appear once a credential access rule calls{' '}
                      <code>/proxy/&lt;token slug&gt;/…</code>
                    </>
                  }
                  actions={
                    <>
                      <Button href={paths.overview({ hash: 'get-started' })}>Get started</Button>
                      <LinkAction
                        href={docsUrl('callers/github-actions.md')}
                        srSuffix="(GitHub docs)"
                      >
                        GitHub Actions guide
                      </LinkAction>
                    </>
                  }
                />
              )
            ) : null}
            {rows.length > 0 || pager.newest || pager.newer || pager.older ? (
              <LogPager
                summary={
                  <>
                    Showing {formatCount(rows.length)} {rows.length === 1 ? 'request' : 'requests'}{' '}
                    · times in UTC
                  </>
                }
                newest={pager.newest}
                newer={pager.newer}
                older={pager.older}
              />
            ) : null}
          </Panel>
        </Tray>
      </>
    ),
  );
}

/**
 * "Denied requests to slack" + " from acme/web in the last 24 hours": the filters as a sentence,
 * split so the tray title can stop after the token. Names come from the database or closed sets.
 */
function listSentence(params: RequestParams, names: Names): { title: string; rest: string } {
  const what = params.outcome
    ? { allowed: 'Allowed requests', denied: 'Denied requests', error: 'Requests with errors' }[
        params.outcome
      ]
    : 'Requests';
  const to = params.token
    ? params.token === 'none'
      ? ' refused before a token was chosen'
      : ` to ${tokenName(params.token, names.tokens)}`
    : params.slug
      ? ` to the slug ${params.slug}`
      : '';
  const rest = [
    params.repo ? ` from ${params.repo}` : '',
    params.consumer
      ? params.consumer === 'none'
        ? ' with no verified consumer'
        : ` through ${consumerName(params.consumer, names.consumers)}`
      : '',
    params.access
      ? ` through the access ${names.issuer_access_rules.get(params.access) ?? params.access}`
      : '',
    params.reason ? ` for the reason ${reasonLabel(params.reason)}` : '',
    params.range ? ` in the last ${RANGE_LABEL[params.range]}` : '',
  ].join('');
  return { title: `${what}${to}`, rest };
}

/**
 * "All 38 on this page come from one caller": on a denied list where every row is the same
 * verified caller, token and access-fixable reason, offer the access form from the newest one.
 */
function OneCaller(props: { params: RequestParams; rows: RequestRecord[]; ctx: ViewContext }) {
  const { rows } = props;
  const [first] = rows;
  if (
    props.params.outcome !== 'denied' ||
    !first ||
    rows.length < 2 ||
    !props.ctx.can('access:write') ||
    !rows.every(
      (r) =>
        r.claims_verified === 1 &&
        accessFixable(r.reason) &&
        r.caller_repository !== null &&
        r.caller_repository === first.caller_repository &&
        r.service_id !== null &&
        r.service_id === first.service_id,
    )
  ) {
    return null;
  }
  const ref = refText(storedClaims(first));
  return (
    <Callout
      title={`All ${formatCount(rows.length)} on this page come from one caller: ${first.caller_repository}${ref ? ` on ${ref}` : ''}.`}
      more="No issuer access rules allows this call. The form opens with this caller and call filled in."
      actions={
        <Button variant="primary" href={paths.accessNew({ from_request: first.id })}>
          Give access from the latest request
        </Button>
      }
    />
  );
}

function paginate(params: RequestParams, page: RequestPage) {
  let rows: RequestRecord[];
  let newer: string | null = null;
  let older: string | null = null;
  if (params.after) {
    rows = page.records.length > PAGE_SIZE ? page.records.slice(1) : page.records;
    const first = rows[0];
    if (page.records.length > PAGE_SIZE && first)
      newer = listLink(params, { after: first.id, before: undefined });
    const last = rows.at(-1);
    older = last ? listLink(params, { before: last.id, after: undefined }) : null;
  } else {
    rows = page.records.slice(0, PAGE_SIZE);
    const last = rows.at(-1);
    if (page.records.length > PAGE_SIZE && last)
      older = listLink(params, { before: last.id, after: undefined });
    const first = rows[0];
    if (params.before && first) newer = listLink(params, { after: first.id, before: undefined });
  }
  return {
    rows,
    pager: {
      newest: params.before || params.after ? listLink(params, {}) : null,
      newer,
      older,
    },
  };
}

function tokenName(value: string, tokens: ReadonlyMap<string, Service>): string {
  if (value === 'none') return 'none';
  return tokens.get(value)?.slug ?? value;
}

function consumerName(value: string, consumers: ReadonlyMap<string, CredentialAccessRule>): string {
  if (value === 'none') return 'none';
  return consumers.get(value)?.name ?? value;
}

/** "Reason: No issuer access rules allows this call (no_matching_grant)". */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function filterChips(params: RequestParams, names: Names) {
  const chip = (key: FilterKey | 'outcome', label: string) => ({
    label,
    href: listLink(params, { [key]: undefined }),
  });
  const chips: Array<{ label: string; href: string }> = [];
  if (params.outcome) chips.push(chip('outcome', `Outcome: ${OUTCOME_LABEL[params.outcome]}`));
  if (params.token) {
    chips.push(
      chip(
        'token',
        params.token === 'none'
          ? 'Token: refused before a token was chosen'
          : names.tokens.has(params.token)
            ? `Token: ${tokenName(params.token, names.tokens)}`
            : `Token: Deleted credential ${params.token}`,
      ),
    );
  }
  if (params.consumer) {
    chips.push(
      chip(
        'consumer',
        params.consumer === 'none'
          ? 'Consumer: none'
          : names.consumers.has(params.consumer)
            ? `Consumer: ${consumerName(params.consumer, names.consumers)}`
            : `Consumer: Deleted credential access rule ${params.consumer}`,
      ),
    );
  }
  if (params.access)
    chips.push(
      chip('access', `Access: ${names.issuer_access_rules.get(params.access) ?? params.access}`),
    );
  if (params.repo) chips.push(chip('repo', `Repository: ${params.repo}`));
  if (params.reason) chips.push(chip('reason', `Reason: ${reasonLabel(params.reason)}`));
  if (params.slug) chips.push(chip('slug', `Slug: ${params.slug}`));
  return chips;
}

/** The tray's filter bar: the repository search, then one menu per picked filter. */
function RequestFilters(props: {
  params: RequestParams;
  errors: FieldErrorData[];
  credentials: Service[];
  providers: CredentialAccessRule[];
  repos: string[];
  /** The submitted repository when it was invalid, re-rendered for correction (WCAG 3.3.7). */
  rawRepo?: string;
}) {
  const { params, credentials, providers } = props;
  const error = (field: string) => props.errors.find((e) => e.field === field)?.message;
  // Every filter set by a link is kept when the repository is applied.
  const hidden: Record<string, string> = {};
  for (const key of [
    'range',
    'outcome',
    'token',
    'consumer',
    'access',
    'reason',
    'slug',
  ] as const) {
    const value = params[key];
    if (value) hidden[key] = value;
  }
  const reasonGroups: FilterOptionGroup[] = REASON_GROUPS.map((group) => ({
    group: group.group,
    options: group.codes
      .filter((code) => REASON_CODES.includes(code))
      .map((code) => ({
        href: listLink(params, { reason: code }),
        label: capitalise(reasonText(code) ?? code),
        slug: code,
      })),
  }));
  const repoError = error('repo');
  return (
    <Filters label="Filter requests" action={paths.requests()} hidden={hidden}>
      <FilterSearch
        id="f-repo"
        name="repo"
        label="Repository"
        value={params.repo ?? props.rawRepo}
        placeholder="acme/api"
        suggestions={props.repos}
        pattern={REPO_PATTERN}
        maxlength={REPO_MAX}
        invalid={repoError !== undefined}
        describedBy={
          [props.repos.length > 0 ? 'f-repo-s' : null, repoError ? 'f-repo-error' : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
      />
      {/* Apply sits on the repository box it submits; the "+" menus are links */}
      <Button type="submit">Apply</Button>
      <AddFilter
        id="f-token"
        label="Credential"
        open={error('token') !== undefined}
        options={[...credentials]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({
            href: listLink(params, { token: s.id }),
            label: s.name,
            logo: tokenLogo(s),
            slug: s.slug,
          }))}
        extra={[
          { href: listLink(params, { token: 'none' }), label: 'Refused before a token was chosen' },
        ]}
      />
      <AddFilter
        id="f-consumer"
        label="Credential access rule"
        open={error('consumer') !== undefined}
        options={[...providers]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({
            href: listLink(params, { consumer: p.id }),
            label: p.name,
            logo: consumerLogo(p),
          }))}
        extra={[
          { href: listLink(params, { consumer: 'none' }), label: 'No consumer (unknown issuer)' },
        ]}
      />
      <AddFilter
        id="f-reason"
        label="Reason"
        open={error('reason') !== undefined}
        options={reasonGroups}
      />
      {props.repos.length > 0 ? (
        <p class="suggest" id="f-repo-s">
          Suggestions{' '}
          {props.repos.map((repo) => (
            <a href={listLink(params, { repo })}>{repo}</a>
          ))}{' '}
          <span class="faint">· Owner and name, exactly as GitHub or GitLab shows them.</span>
        </p>
      ) : null}
      {(['repo', 'token', 'consumer', 'reason'] as const).map((field) => {
        const message = error(field);
        return message ? <FieldError id={`f-${field}-error`}>{message}</FieldError> : null;
      })}
    </Filters>
  );
}

/** The log: one dense row per record; repositories, tokens, reasons and accesses filter the list. */
function RequestTable(props: {
  records: RequestRecord[];
  params: RequestParams;
  names: Names;
  now: number;
}) {
  const { params, names } = props;
  const filterLink = (
    changes: Partial<RequestParams>,
    what: string,
    text: Child,
    mono?: boolean,
  ) => (
    <a class={mono ? 'flink mono' : 'flink'} href={listLink(params, changes)}>
      <span class="vh">Filter by {what} </span>
      {text}
    </a>
  );
  return (
    <Table
      labelledBy="requests-h"
      caption="Requests, newest first"
      dense
      stackable
      class="log"
      columns={[
        { label: 'When (UTC)' },
        { label: 'Result' },
        { label: 'Caller → token' },
        { label: 'Request' },
        { label: 'Reason or access' },
        { label: 'Duration', num: true },
      ]}
    >
      {props.records.map((r) => {
        const shown = shownOutcome(r);
        const { tone } = OUTCOME_TONE[shown];
        const token = r.service_id ? names.tokens.get(r.service_id) : undefined;
        const provider = r.credential_access_rule_id
          ? names.consumers.get(r.credential_access_rule_id)
          : undefined;
        const tokenSide = {
          logo: tokenLogo(token),
          name: r.service_id
            ? filterLink(
                { token: r.service_id },
                'token',
                token?.slug ?? r.service_slug ?? r.service_id,
                true,
              )
            : r.service_slug && SLUG.test(r.service_slug)
              ? filterLink({ slug: r.service_slug }, 'slug', r.service_slug, true)
              : (r.service_slug ?? '—'),
        };
        return (
          <Row>
            <Cell label="When">
              <LogTime ms={r.ts} now={props.now} />
            </Cell>
            <Cell label="Result">
              <Result tone={tone} code={r.status}>
                {OUTCOME_TITLE[shown]}
              </Result>
            </Cell>
            <Cell label="Caller → token">
              {r.claims_verified === 1 ? (
                <ArrowRow
                  verb="to"
                  consumer={{
                    logo: consumerLogo(provider),
                    name: (
                      <>
                        {provider ? <span class="vh">{provider.name} </span> : null}
                        {r.caller_repository && REPO.test(r.caller_repository)
                          ? filterLink(
                              { repo: r.caller_repository },
                              'repository',
                              r.caller_repository,
                            )
                          : (r.caller_repository ?? r.caller_subject ?? '—')}
                      </>
                    ),
                    context: refText(storedClaims(r)),
                  }}
                  token={tokenSide}
                />
              ) : (
                <ArrowRow
                  consumer={{
                    logo: 'oidc',
                    name: filterLink({ consumer: 'none' }, 'unverified caller', 'unverified token'),
                    // read from a token that was not trusted: text only, never a link; the
                    // muted second line, like a verified caller's ref
                    context: r.untrusted_iss ? `from ${r.untrusted_iss}` : undefined,
                  }}
                />
              )}
            </Cell>
            <RowHeader>
              <a class="ent-n mono" href={paths.request(r.id)}>
                {r.method} {r.path}
                <span class="vh">
                  {' '}
                  at {formatTime(r.ts).slice(11, 19)}, {shown}
                </span>
              </a>
            </RowHeader>
            <Cell label="Reason or access">
              {r.reason && isReasonCode(r.reason) ? (
                filterLink(
                  { reason: r.reason },
                  'reason',
                  capitalise(reasonText(r.reason) ?? r.reason),
                )
              ) : r.reason ? (
                <code>{r.reason}</code>
              ) : r.grant_id ? (
                <>
                  <span class="faint">via</span>{' '}
                  {filterLink(
                    { access: r.grant_id },
                    'access',
                    names.issuer_access_rules.get(r.grant_id) ?? <code>{r.grant_id}</code>,
                  )}
                </>
              ) : (
                '—'
              )}
            </Cell>
            <Cell label="Duration" num>
              {formatDuration(r.duration_ms)}
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail: what to do

interface NextAction {
  href: string;
  label: string;
  /** Visually hidden suffix of the link name. */
  context?: string;
  /** Without it the viewer sees AskSomeone instead of the link. */
  permission?: Permission;
  /** The ask text: "Ask a credential manager to …". */
  verb?: string;
}

interface ActionContext {
  record: RequestRecord;
  /** A current issuer access rules would allow it (blockers aside: an access cannot fix those). */
  accessAllowsNow: boolean;
}

const openToken = ({ record }: ActionContext): NextAction[] =>
  record.service_id ? [{ href: paths.token(record.service_id), label: 'Open token' }] : [];

const setSecretAgain = (ctx: ActionContext): NextAction[] => {
  const id = ctx.record.service_id;
  return [
    ...openToken(ctx),
    ...(id
      ? [
          {
            href: paths.token(id, { open: 'destination', hash: 'destination' }),
            label: 'Set the secret again',
            permission: 'tokens:write' as const,
            verb: 'set the secret again',
          },
        ]
      : []),
  ];
};

const openConsumer = ({ record }: ActionContext): NextAction[] =>
  record.credential_access_rule_id
    ? [{ href: paths.consumer(record.credential_access_rule_id), label: 'Open consumer' }]
    : [];

const openKeys = (): NextAction[] => [{ href: paths.tokenKeys(), label: 'Open encryption keys' }];

const giveAccess = ({ record, accessAllowsNow }: ActionContext): NextAction[] =>
  record.claims_verified === 1 && !accessAllowsNow
    ? [
        {
          href: paths.accessNew({ from_request: record.id }),
          label: 'Give access from this request',
          permission: 'access:write',
          verb: 'give access from this request',
        },
      ]
    : [];

const callerDocs = (code: string) => (): NextAction[] => [
  {
    href: docsUrl(
      `errors.md#${CALLER_DOC_ANCHORS.has(code) ? code : 'request-record-reason-codes'}`,
    ),
    label: `About ${code}`,
    context: '(GitHub docs)',
  },
];

/** Reason codes with their own heading in docs/errors.md. */
const CALLER_DOC_ANCHORS: ReadonlySet<string> = new Set([
  'method_not_allowed',
  'token_missing',
  'token_ambiguous',
  'token_expired',
  'path_invalid',
]);

/**
 * What the operator can do about each reason: the text (today's guidance, with the I-CRED-2
 * out-of-band check kept word for word) and at most two actions, gated by permission.
 */
export const NEXT_ACTIONS: Readonly<
  Record<string, { text: string; actions?: (ctx: ActionContext) => NextAction[] }>
> = {
  token_missing: {
    text: 'The caller sent no token. Pass the token from the get-token action in the x-tokengate-token header.',
    actions: callerDocs('token_missing'),
  },
  token_ambiguous: {
    text: 'The caller sent two different tokens. Send exactly one.',
    actions: callerDocs('token_ambiguous'),
  },
  token_malformed: {
    text: "The token is not a JWT with an algorithm and key id this credential access rule accepts. Check the credential access rule's allowed algorithms.",
    actions: openConsumer,
  },
  issuer_unknown: {
    text: 'No enabled credential access rule has this issuer. Add a credential access rule for it, or enable the existing one.',
    actions: ({ record }) => {
      const type =
        record.claims_verified === 0 ? profileForIssuer(record.untrusted_iss) : undefined;
      return [
        {
          href: paths.consumerNew(type ? { type } : undefined),
          label: 'Add a credential access rule',
          permission: 'access:write',
          verb: 'add a credential access rule',
        },
      ];
    },
  },
  audience_mismatch: {
    text: 'The token was minted for another audience. Use the audience shown on the credential access rule page.',
    actions: openConsumer,
  },
  token_expired: {
    text: 'Mint the token right before the call: tokens are short-lived.',
    actions: callerDocs('token_expired'),
  },
  token_too_old: {
    text: "Mint the token right before the call, or raise the credential access rule's maximum token age.",
    actions: openConsumer,
  },
  signature_invalid: {
    text: "The token signature does not match the issuer's signing keys. Check that the credential access rule's issuer and JWKS URL are correct.",
    actions: openConsumer,
  },
  jwks_unavailable: {
    text: "The gateway could not download the issuer's signing keys. Usually temporary; if it persists, check the credential access rule's JWKS URL.",
    actions: openConsumer,
  },
  claims_invalid: {
    text: 'The token lacks claims this credential access rule requires.',
    actions: openConsumer,
  },
  tenant_mismatch: {
    text: "The caller is outside the organization or group pinned on the credential access rule (tenant pin). Check the credential access rule's organizations or groups.",
    actions: openConsumer,
  },
  profile_unknown: {
    text: 'The credential access rule uses a credential access rule type this version does not know. Check the credential access rule, or upgrade the gateway.',
    actions: openConsumer,
  },
  no_matching_grant: {
    text: 'No issuer access rules allows this caller to make this request. Read the policy evaluation below to see which check failed. An access manager, admin or owner can give access from this request.',
    actions: giveAccess,
  },
  event_not_trusted: {
    text: 'The workflow event (for example pull_request_target) is not trusted by default. A issuer access rules must list it explicitly, which is risky for events that run untrusted code.',
    actions: giveAccess,
  },
  service_not_found: {
    text: 'Check the token slug in the URL.',
    actions: ({ record }) => [
      ...(record.service_slug && SLUG.test(record.service_slug)
        ? [{ href: paths.requests({ slug: record.service_slug }), label: 'Requests to this slug' }]
        : []),
      {
        href: paths.tokenNew(),
        label: 'Add a credential',
        permission: 'tokens:write',
        verb: 'add a credential',
      },
    ],
  },
  service_disabled: {
    text: 'Enable the token if callers should use it again.',
    actions: openToken,
  },
  path_invalid: {
    text: 'The path has empty or dot segments ("//", "..", "."), forbidden escapes or characters not allowed in URL paths. Fix the URL in the caller.',
    actions: callerDocs('path_invalid'),
  },
  query_invalid: {
    text: 'The query string has characters the gateway does not forward or a malformed copy of the injected parameter. Fix the URL in the caller.',
    actions: callerDocs('query_invalid'),
  },
  method_not_allowed: {
    text: 'Use a standard HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS).',
    actions: callerDocs('method_not_allowed'),
  },
  base_url_invalid: {
    text: "Check the token's base URL on the token page.",
    actions: setSecretAgain,
  },
  injection_invalid: {
    text: 'Re-enter the secret and injection on the token page.',
    actions: setSecretAgain,
  },
  keyring_absent: {
    text: 'Set the TOKENGATE_KEK secret on the Worker. See Credentials › Encryption keys for the keyring status.',
    actions: openKeys,
  },
  keyring_malformed: {
    text: 'Fix the TOKENGATE_KEK or TOKENGATE_KEYRING secret. See Credentials › Encryption keys.',
    actions: openKeys,
  },
  active_kid_missing: {
    text: 'Fix the TOKENGATE_KEYRING secret: its active key is missing. See Credentials › Encryption keys.',
    actions: openKeys,
  },
  key_not_32_bytes: {
    text: 'Fix the keyring secret: every key must be 32 bytes. See Credentials › Encryption keys.',
    actions: openKeys,
  },
  both_kek_and_keyring_set: {
    text: 'Remove one of TOKENGATE_KEK and TOKENGATE_KEYRING.',
    actions: openKeys,
  },
  dev_placeholder_key: {
    text: 'Replace the development TOKENGATE_KEK from .dev.vars.example with a key of your own. See Credentials › Encryption keys.',
    actions: openKeys,
  },
  credential_missing: {
    text: 'Set the secret on the token page. If the token had one, check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the secret again: the row may have been edited in D1.',
    actions: setSecretAgain,
  },
  credential_binding_mismatch: {
    text: 'If Credentials › Encryption keys shows a replaced key, restore it. Otherwise the token row was probably edited in D1: check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the secret again.',
    actions: setSecretAgain,
  },
  credential_invalid: { text: 'Re-enter the secret on the token page.', actions: setSecretAgain },
  credential_unavailable: {
    text: "The token's secret could not be opened. Check Credentials › Encryption keys; if the keys are fine, check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the secret again.",
    actions: setSecretAgain,
  },
  keyring_missing_key: {
    text: 'Restore the missing key in the keyring. If you enter the secret again instead, first check the base URL and injection against an out-of-band source (provider docs, configuration as code).',
    actions: setSecretAgain,
  },
  sealed_malformed: {
    text: 'The stored secret is damaged, possibly by an edit in D1: check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the secret again.',
    actions: setSecretAgain,
  },
  upstream_timeout: {
    text: "The upstream API did not answer in time. Check its status, or raise the token's timeout.",
    actions: openToken,
  },
  upstream_unreachable: {
    text: 'The upstream API could not be reached. Check its status and base URL.',
    actions: openToken,
  },
  upstream_invalid_status: {
    text: 'The upstream answered with an invalid HTTP status after receiving the request. Check the upstream; do not assume the request failed.',
    actions: openToken,
  },
  rate_limited: {
    text: 'The caller exceeded the rate limit for this issuer access rules.',
    actions: ({ record }) =>
      record.grant_id ? [{ href: paths.accessItem(record.grant_id), label: 'Open access' }] : [],
  },
  internal_error: {
    text: 'The gateway failed to process the request. Retry; if it persists, look for this request ID in the Workers logs.',
  },
  not_configured: {
    text: 'The gateway is not fully configured. The health panel on the Overview lists what is missing.',
    actions: () => [{ href: paths.overview({ hash: 'health' }), label: 'Open the health panel' }],
  },
};

/** "Give access from this request." + the rest: the box title is the first sentence. */
export function splitFirstSentence(text: string): { title: string; rest: string } {
  const match = /^(.+?\.)\s+([\s\S]*)$/.exec(text);
  return match ? { title: match[1] ?? text, rest: match[2] ?? '' } : { title: text, rest: '' };
}

/** "1" … "3" before a runbook tray title (decorative: the order is the reading order). */
function StepNumber(props: { n: number }) {
  return (
    <span class="fstep-n" aria-hidden="true">
      {props.n}
    </span>
  );
}

function WhatToDo(props: {
  ctx: ViewContext;
  record: RequestRecord;
  service: Service | null;
  provider: CredentialAccessRule | null;
  accessAllowsNow: boolean;
  giveAccess: boolean;
  step: number;
}) {
  const { record, ctx } = props;
  const entry =
    record.reason !== null && Object.hasOwn(NEXT_ACTIONS, record.reason)
      ? NEXT_ACTIONS[record.reason]
      : undefined;
  if (!entry) return null;
  const actions = (entry.actions?.({ record, accessAllowsNow: props.accessAllowsNow }) ?? []).slice(
    0,
    2,
  );
  const { title, rest } = splitFirstSentence(entry.text);
  const claims = storedClaims(record);
  const unprotected =
    props.giveAccess && (claims?.ref_protected === false || claims?.ref_protected === 'false');
  return (
    <Tray
      id="next"
      title={
        <>
          <StepNumber n={props.step} />
          What to do
        </>
      }
    >
      <Panel variant="pad">
        <NextStep
          title={title}
          prefill={
            props.giveAccess
              ? prefillChips(record, claims, props.provider, props.service)
              : undefined
          }
          actions={
            actions.length > 0 ? (
              <>
                {actions.map((action) =>
                  !action.permission || ctx.can(action.permission) ? (
                    <Button href={action.href} srSuffix={action.context}>
                      {action.label}
                    </Button>
                  ) : (
                    <AskSomeone permission={action.permission} ctx={ctx} verb={action.verb} />
                  ),
                )}
              </>
            ) : undefined
          }
        >
          {rest || undefined}
        </NextStep>
        {unprotected ? (
          <p class="sm">
            <span class="t-warn" aria-hidden="true">
              ⚠
            </span>{' '}
            <span class="vh">Risk: </span>The branch is not protected, so anyone who can push a
            branch to {record.caller_repository ?? 'the repository'} would get the{' '}
            {props.service?.name ?? 'upstream'} token.
          </p>
        ) : null}
      </Panel>
    </Tray>
  );
}

/** The values the access form opens with, from the stored allowlisted claims only (I-LOG-2). */
function prefillChips(
  record: RequestRecord,
  claims: Claims | null,
  provider: CredentialAccessRule | null,
  service: Service | null,
): PrefillValue[] {
  const chips: PrefillValue[] = [];
  if (provider) chips.push({ label: provider.name, logo: consumerLogo(provider) });
  if (record.caller_repository) {
    const repoId = typeof claims?.repository_id === 'string' ? claims.repository_id : null;
    chips.push({
      label: (
        <>
          {record.caller_repository}
          {repoId ? <span class="n"> ({repoId})</span> : null}
        </>
      ),
      mono: true,
    });
  }
  const ref = refText(claims);
  if (ref) chips.push({ label: ref, mono: true });
  if (claims?.ref_protected === false || claims?.ref_protected === 'false') {
    chips.push({ label: 'also unprotected' });
  }
  if (service) chips.push({ label: service.name, logo: tokenLogo(service) });
  return chips;
}

/** The reason group a code belongs to ("Caller token", "Issuer access rules", …). */
function reasonGroup(reason: string | null): string | null {
  if (reason === null) return null;
  return REASON_GROUPS.find((group) => group.codes.includes(reason))?.group ?? null;
}

/**
 * Where the call stopped, from the record alone: caller verified → token found → access matched
 * → upstream. The failing step says so; later steps were not reached.
 */
function traceSteps(
  r: RequestRecord,
  ctx: {
    provider: CredentialAccessRule | null;
    service: Service | null;
    grantName: string | null;
    checked: number;
  },
): TraceStep[] {
  const group = reasonGroup(r.reason);
  const upstreamFailed =
    group === 'Upstream' || (r.upstream_status !== null && r.upstream_status >= 500);
  let stop: number | null;
  if (group === 'Caller token' || group === 'Credential access rule') stop = 1;
  else if (group === 'Token configuration' || group === 'Encryption keys') stop = 2;
  else if (group === 'Issuer access rules') stop = 3;
  else if (upstreamFailed) stop = 4;
  else if (r.outcome === 'allowed') stop = null;
  else stop = r.claims_verified !== 1 ? 1 : !r.service_id ? 2 : !r.grant_id ? 3 : 4;
  const why = capitalise(reasonText(r.reason) ?? `HTTP ${r.status}`);
  const tokenName = ctx.service?.name ?? r.service_slug ?? 'The upstream';
  const steps: Array<{ title: string; pass: Child; fail: Child; notrun?: Child }> = [
    {
      title: 'Caller verified',
      pass: ctx.provider?.name ?? 'Verified',
      fail: why,
    },
    {
      title: 'Token found',
      pass: ctx.service
        ? `/proxy/${ctx.service.slug} → ${ctx.service.name}`
        : `/proxy/${r.service_slug ?? '…'}`,
      fail: r.service_slug ? `/proxy/${r.service_slug}: ${why}` : why,
    },
    {
      title: 'Access matched',
      pass: ctx.grantName ?? 'An access matched',
      fail: r.reason === 'rate_limited' ? why : `0 of ${ctx.checked} checked`,
    },
    {
      title: 'Upstream',
      pass: r.upstream_status === null ? 'Forwarded' : `HTTP ${r.upstream_status}`,
      fail: r.upstream_status === null ? why : `HTTP ${r.upstream_status}`,
      notrun: `${tokenName} was not called`,
    },
  ];
  return steps.map((step, index) => {
    const n = index + 1;
    if (stop === null || n < stop) return { state: 'pass', title: step.title, detail: step.pass };
    if (n === stop) {
      return {
        state: 'fail',
        status: 'Failed, stopped here',
        title: step.title,
        detail: step.fail,
      };
    }
    return { state: 'notrun', title: step.title, detail: step.notrun };
  });
}

/** One sentence on what happened, from the record and the current names. */
function happenedSentence(
  r: RequestRecord,
  provider: CredentialAccessRule | null,
  service: Service | null,
): Child {
  const why = reasonText(r.reason);
  const token = service?.name ?? r.service_slug ?? 'the token';
  if (r.claims_verified !== 1) {
    return `The caller token was not verified${why ? `: ${why}` : ''}, so tokengate stopped the call before choosing a token.`;
  }
  const who = provider ? `${provider.name} verified the caller` : 'The caller was verified';
  const caller = r.caller_repository ?? r.caller_subject ?? 'the caller';
  const ref = refOf(storedClaims(r));
  const callerText = (
    <>
      <b>{caller}</b>
      {ref ? (
        <>
          {' '}
          on {ref.kind} <b>{ref.name}</b>
        </>
      ) : null}
    </>
  );
  if (accessFixable(r.reason)) {
    return (
      <>
        {who}, but no access lets {callerText} use {token}.
      </>
    );
  }
  if (r.outcome === 'allowed' && r.reason === null) {
    return (
      <>
        {who}, and an access let {callerText} use {token}
        {r.upstream_status !== null ? `; the upstream answered HTTP ${r.upstream_status}` : ''}.
      </>
    );
  }
  return (
    <>
      {who} ({callerText}), but the call {r.outcome === 'error' ? 'failed' : 'was refused'}
      {why ? `: ${why}` : ''}.
    </>
  );
}

function RequestDetail(props: {
  ctx: ViewContext;
  record: RequestRecord;
  service: Service | null;
  provider: CredentialAccessRule | null;
  issuer_access_rules: IssuerAccessRule[];
  reevaluation: Reevaluation | null;
  giveAccess: boolean;
  accessAllowsNow: boolean;
  retentionDays: number;
}) {
  const { record: r, service, provider, ctx } = props;
  const grantNames = new Map(props.issuer_access_rules.map((g) => [g.id, g.name]));
  const claims = storedClaims(r);
  const trace = storedTrace(r);
  const tokenLabel = service?.slug ?? r.service_slug;
  const verified = r.claims_verified === 1;
  const ref = refOf(claims);
  const workflow =
    typeof claims?.job_workflow_ref === 'string'
      ? claims.job_workflow_ref
      : typeof claims?.workflow === 'string'
        ? claims.workflow
        : null;
  const recheck = props.reevaluation;
  const verdict =
    recheck?.ok !== true ? null : recheck.blockers.length > 0 ? (
      <Badge tone="bad" glyph="✕">
        Still refused now
      </Badge>
    ) : recheck.decision.decision === 'allow' ? (
      <Badge tone="ok" glyph="✓">
        Allowed now
      </Badge>
    ) : (
      <Badge tone="bad" glyph="✕">
        Still denied now
      </Badge>
    );
  const summary: RailKeyValueItem[] = [
    { label: 'Result', value: <OutcomeBadge record={r} /> },
    {
      label: 'Credential',
      value:
        r.service_id && service ? (
          <>
            <a href={paths.token(r.service_id)}>{service.name}</a>{' '}
            <span class="slug">{service.slug}</span>
          </>
        ) : r.service_slug ? (
          <>
            <code>{r.service_slug}</code>{' '}
            <span class="muted">{r.service_id ? '(deleted)' : '(no such token when called)'}</span>
          </>
        ) : (
          '—'
        ),
    },
    {
      label: 'Credential access rule',
      value: r.credential_access_rule_id ? (
        provider ? (
          <a href={paths.consumer(r.credential_access_rule_id)}>{provider.name}</a>
        ) : (
          <>
            <code>{r.credential_access_rule_id}</code> <span class="muted">(deleted)</span>
          </>
        )
      ) : (
        '—'
      ),
    },
    ...(verified && r.caller_repository
      ? [
          {
            label: 'Repository',
            value: r.caller_repository,
            ...(typeof claims?.repository_id === 'string'
              ? { note: `repository_id ${claims.repository_id}` }
              : {}),
          },
        ]
      : []),
    ...(ref
      ? [
          {
            label: capitalise(ref.kind),
            value: <Mono>{ref.name}</Mono>,
            ...(claims?.ref_protected === false || claims?.ref_protected === 'false'
              ? { note: 'not protected' }
              : {}),
          },
        ]
      : []),
    ...(workflow
      ? [
          {
            label: 'Workflow',
            value: <Mono>{workflow}</Mono>,
            ...(typeof claims?.event_name === 'string' ? { note: claims.event_name } : {}),
          },
        ]
      : []),
    {
      label: 'Access that allowed it',
      value: r.grant_id ? (
        <IssuerAccessRuleLink id={r.grant_id} names={grantNames} />
      ) : (
        <span class="muted">None matched</span>
      ),
    },
    {
      label: 'Token verified',
      value: verified
        ? 'Yes: signature, issuer, audience and tenant pin were checked.'
        : 'No: the request was refused before the token was trusted, so no caller details were stored.',
    },
    ...(r.untrusted_iss
      ? [
          {
            label: 'Issuer (unverified)',
            value: <code>{r.untrusted_iss}</code>,
            note: 'read from a token that was not trusted',
          },
        ]
      : []),
    {
      label: 'Upstream',
      value:
        r.upstream_status === null ? (
          <span class="muted">Not forwarded to the upstream</span>
        ) : (
          `HTTP ${r.upstream_status}`
        ),
      ...(r.upstream_ms !== null ? { note: `${formatDuration(r.upstream_ms)} upstream` } : {}),
    },
    { label: 'Total time', value: formatDuration(r.duration_ms) },
    ...(r.weight !== 1
      ? [
          {
            label: 'Sampling',
            value: `This record stands for about ${formatCount(r.weight)} allowed requests.`,
          },
        ]
      : []),
    { label: 'Request ID', value: r.id, mono: true, copyable: true },
  ];
  let step = 0;
  return (
    <Grid>
      <Column span={8}>
        <Stack>
          <Tray
            id="happened"
            title={
              <>
                <StepNumber n={++step} />
                What happened
              </>
            }
          >
            <Panel variant="pad">
              <p>{happenedSentence(r, provider, service)}</p>
              <Trace
                label="Where the call stopped"
                steps={traceSteps(r, {
                  provider,
                  service,
                  grantName: r.grant_id ? (grantNames.get(r.grant_id) ?? r.grant_id) : null,
                  checked: trace.filter((item) => !('omitted' in item)).length,
                })}
              />
            </Panel>
          </Tray>
          {verified ? (
            <Tray
              id="recheck"
              title={
                <>
                  <StepNumber n={++step} />
                  Check against current access{verdict ? <> {verdict}</> : null}
                </>
              }
              description="The policy runs again with this request's stored claims against the issuer access rules as they are now. Stored claims subset only: constraints on claims that were not stored fail, so a real token may be allowed where this check says denied. Nothing is changed."
            >
              <Panel variant="pad">
                <Recheck record={r} result={props.reevaluation} grantNames={grantNames} />
              </Panel>
            </Tray>
          ) : null}
          <WhatToDo
            ctx={ctx}
            record={r}
            service={service}
            provider={provider}
            accessAllowsNow={props.accessAllowsNow}
            giveAccess={props.giveAccess}
            step={step + 1}
          />
        </Stack>
      </Column>
      <Column span={4} rail as="aside" label="Request summary">
        <Tray id="summary" title="Summary">
          <Panel>
            <RailKeyValue items={summary} />
          </Panel>
        </Tray>
      </Column>
      <Column span={8}>
        <Stack>
          {trace.length > 0 ? (
            <Tray
              id="trace"
              title="Evaluation trace"
              description="Each issuer access rules of this credential access rule and token, in evaluation order, with the first check that failed."
            >
              <Panel variant="flush">
                <TraceTable
                  labelledBy="trace-h"
                  caption="Policy evaluation at request time"
                  trace={trace}
                  grantNames={grantNames}
                />
              </Panel>
            </Tray>
          ) : null}
          <Tray
            id="claims"
            title="Caller claims"
            description="Allowlisted claims only: claims off the credential access rule's allowlist, and the token itself, are never stored."
          >
            <Panel variant="pad">
              {claims && Object.keys(claims).length > 0 ? (
                <KeyValue
                  items={Object.entries(claims).map(([name, value]) => ({
                    label: <Mono>{name}</Mono>,
                    value: typeof value === 'string' ? value : JSON.stringify(value),
                    mono: true,
                  }))}
                />
              ) : (
                <ZeroState>
                  {verified
                    ? 'No claims were stored for this request.'
                    : 'None: the token was not verified, so its claims were not stored.'}
                </ZeroState>
              )}
            </Panel>
          </Tray>
          <Tray
            id="technical"
            title="Technical details"
            hideTitle
            bar={
              <Disclosure summary="Technical details">
                <KeyValue
                  items={[
                    { label: 'Request ID', value: r.id, mono: true, copyable: true },
                    { label: 'Time', value: formatTime(r.ts) },
                    { label: 'Credential ID (jti)', value: r.jti ?? '—', mono: r.jti !== null },
                    {
                      label: 'Caller subject (sub)',
                      value: r.caller_subject ?? '—',
                      mono: r.caller_subject !== null,
                    },
                    { label: 'Client IP', value: r.ip ?? '—' },
                    { label: 'User agent', value: r.user_agent ?? '—' },
                    { label: 'Cloudflare location', value: r.colo ?? '—' },
                    {
                      label: 'Kept until',
                      value: (
                        <>
                          <UiTime
                            datetime={new Date(r.ts + props.retentionDays * 86_400_000)}
                            format="date"
                          />{' '}
                          ({props.retentionDays} days,{' '}
                          <a href={paths.retention()}>Data retention</a>)
                        </>
                      ),
                    },
                  ]}
                />
              </Disclosure>
            }
          />
        </Stack>
      </Column>
      <Column span={4} rail as="aside" label="Related requests">
        <Tray id="related" title="Related">
          <Panel>
            <ul class="cmap-list">
              {verified && r.caller_repository && REPO.test(r.caller_repository) ? (
                <li>
                  <a href={paths.requests({ repo: r.caller_repository })}>
                    Requests from {r.caller_repository}
                  </a>
                </li>
              ) : null}
              {r.service_id ? (
                <li>
                  <a href={paths.requests({ token: r.service_id })}>
                    Requests to {tokenLabel ?? 'this token'}
                  </a>
                </li>
              ) : r.service_slug && SLUG.test(r.service_slug) ? (
                <li>
                  <a href={paths.requests({ slug: r.service_slug })}>
                    Requests to {r.service_slug}
                  </a>
                </li>
              ) : null}
              {r.reason && isReasonCode(r.reason) ? (
                <li>
                  <a href={paths.requests({ reason: r.reason, range: '24h' })}>
                    Same reason, last 24 hours
                  </a>
                </li>
              ) : null}
            </ul>
          </Panel>
        </Tray>
      </Column>
    </Grid>
  );
}

function TraceTable(props: {
  labelledBy: string;
  caption: string;
  trace: TraceItem[];
  grantNames: Map<string, string>;
}) {
  return (
    <Table
      labelledBy={props.labelledBy}
      caption={props.caption}
      stackable
      columns={[{ label: 'Issuer access rules and result' }, { label: 'Detail' }]}
    >
      {props.trace.map((item) => (
        <Row>
          {/* the result is the access's muted second line: two columns, so the detail has room */}
          <RowHeader>
            {'omitted' in item ? (
              `${item.omitted} more not shown (trace size limit)`
            ) : (
              <span class="ent-t">
                <IssuerAccessRuleLink id={item.grant_id} names={props.grantNames} />
                {item.result === 'matched' ? (
                  <span class="meta t-ok">
                    <span aria-hidden="true">✓ </span>Matched
                  </span>
                ) : (
                  <span class="meta">
                    <span class="t-bad" aria-hidden="true">
                      ✕{' '}
                    </span>
                    {TRACE_RESULT_TEXT[item.result] ?? item.result}
                  </span>
                )}
              </span>
            )}
          </RowHeader>
          <Cell label="Detail">{'omitted' in item ? '—' : <code>{item.detail}</code>}</Cell>
        </Row>
      ))}
    </Table>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail

export type Reevaluation =
  | { ok: false; message: string }
  | {
      ok: true;
      /** Checks that run before accesses and would refuse the request on their own. */
      blockers: string[];
      decision: Decision<IssuerAccessRule>;
      grantsChecked: number;
    };

/**
 * Re-runs authorization for a stored record against the current configuration, using only the
 * stored (allowlisted) claims. Conditions on claims that were not stored fail closed, so the
 * result can be a deny where the full token would have been allowed. Never used to authorize.
 */
export function reevaluate(
  record: RequestRecord,
  ctx: {
    service: Service | null;
    provider: CredentialAccessRule | null;
    /** Accesses of the record's token, any state. */
    issuer_access_rules: IssuerAccessRule[];
    now: number;
  },
): Reevaluation {
  if (record.claims_verified !== 1) {
    return { ok: false, message: 'The token was not verified, so no claims were stored.' };
  }
  const claims = storedClaims(record);
  if (claims === null) return { ok: false, message: 'No claims were stored for this request.' };
  const { provider, service } = ctx;
  if (!record.credential_access_rule_id || !provider) {
    return { ok: false, message: 'The credential access rule of this request no longer exists.' };
  }
  const profile = getProfile(provider.profile);
  if (!profile)
    return { ok: false, message: 'The credential access rule uses an unknown issuer type.' };
  if (!record.service_id || !service) {
    return {
      ok: false,
      message:
        'The request did not reach a token that exists today, so no issuer access rules applies.',
    };
  }
  const canonical = canonicalizePath(record.path);
  if (!canonical.ok) return { ok: false, message: 'The stored path is not a valid proxy path.' };

  const blockers: string[] = [];
  if (!provider.enabled) {
    blockers.push(
      'The credential access rule is disabled: the gateway rejects all of its callers.',
    );
  }
  if (!tenantPinHolds(provider, claims)) {
    blockers.push(
      "The stored claims do not satisfy the credential access rule's current organizations or groups (tenant pin), or the pin now uses a claim that was not stored.",
    );
  }
  if (!service.enabled) blockers.push('The credential is disabled.');
  if (provider.credential_id !== service.id || !boundaryHolds(provider.conditions, claims)) {
    blockers.push('The stored claims do not satisfy the current credential access limits.');
  }

  // Same access set and order as the proxy (db/proxy-context.ts): enabled, unexpired, sorted by
  // (created_at, id) as listIssuerAccessRules returns them.
  const issuer_access_rules = ctx.issuer_access_rules.filter(
    (g) =>
      g.credential_access_rule_id === provider.id &&
      g.service_id === service.id &&
      conditionsWithin(g.conditions, provider.conditions) &&
      g.enabled &&
      (g.expires_at === null || g.expires_at > ctx.now),
  );
  const decision = evaluateIssuerAccessRules(issuer_access_rules, {
    claims,
    profile,
    provider,
    method: record.method,
    path: canonical.path,
    matchPath: canonical.matchPath,
    revealClaims: new Set(profile.logClaimAllowlist(provider)),
  });
  return { ok: true, blockers, decision, grantsChecked: issuer_access_rules.length };
}

function storedClaims(record: RequestRecord): Claims | null {
  const parsed = parseJson(record.caller_claims);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Claims;
}

type TraceItem = TraceEntry | { omitted: number };

function storedTrace(record: RequestRecord): TraceItem[] {
  const parsed = parseJson(record.eval_trace);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is TraceItem =>
      typeof item === 'object' &&
      item !== null &&
      (typeof (item as { omitted?: unknown }).omitted === 'number' ||
        (typeof (item as TraceEntry).grant_id === 'string' &&
          typeof (item as TraceEntry).result === 'string')),
  );
}

const TRACE_RESULT_TEXT: Record<TraceEntry['result'], string> = {
  matched: 'matched',
  invalid_grant: "the access no longer meets the credential access rule's anchor rule (I-AUTHZ-2)",
  condition_failed: 'a constraint did not match',
  event_not_trusted: 'event not opted in',
  no_rule: 'no rule allows this method and path',
};

function IssuerAccessRuleLink(props: { id: string | null; names: Map<string, string> }) {
  if (!props.id) return <>—</>;
  const name = props.names.get(props.id);
  return <a href={paths.accessItem(props.id)}>{name ?? <code>{props.id}</code>}</a>;
}
function Recheck(props: {
  record: RequestRecord;
  result: Reevaluation | null;
  grantNames: Map<string, string>;
}) {
  if (props.record.claims_verified !== 1 || props.result === null) {
    return <p>Not available: the token was not verified, so no claims were stored.</p>;
  }
  const { result } = props;
  if (!result.ok) {
    return (
      <>
        <p>{result.message}</p>
      </>
    );
  }
  const { decision, blockers } = result;
  const checked =
    result.grantsChecked === 0
      ? 'No enabled issuer access rules exists for this credential access rule and token.'
      : `${result.grantsChecked} enabled ${result.grantsChecked === 1 ? 'access' : 'accesses'} checked.`;
  // Verdict first (A11.3 #4). A blocker refuses the request before any access is consulted, so an
  // allowing access alone never makes the verdict "allowed".
  return (
    <>
      {blockers.length > 0 ? (
        <>
          <p>
            Would still be <b>refused</b>: {blockers.length === 1 ? 'this check' : 'these checks'}{' '}
            {blockers.length === 1 ? 'fails' : 'fail'} before issuer access rules apply.
          </p>
          <ul class="blockers">
            {blockers.map((blocker) => (
              <li>{blocker}</li>
            ))}
          </ul>
          {decision.decision === 'allow' ? (
            <p>
              Once {blockers.length === 1 ? 'it passes' : 'they pass'}, access{' '}
              <IssuerAccessRuleLink id={decision.grant.id} names={props.grantNames} /> would allow
              it.
            </p>
          ) : (
            <p>
              Issuer access ruleses would also deny it (<code>{decision.code}</code>). {checked}
            </p>
          )}
        </>
      ) : decision.decision === 'allow' ? (
        <p>
          Would now be <b>allowed</b> by access{' '}
          <IssuerAccessRuleLink id={decision.grant.id} names={props.grantNames} />.
        </p>
      ) : (
        <p>
          Would still be <b>denied</b> (<code>{decision.code}</code>). {checked}
        </p>
      )}
      {decision.trace.length > 0 ? (
        <TraceTable
          labelledBy="recheck-h"
          caption="Check against current access"
          trace={decision.trace}
          grantNames={props.grantNames}
        />
      ) : null}
    </>
  );
}
