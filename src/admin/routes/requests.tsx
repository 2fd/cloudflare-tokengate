// Monitoring › Requests: the request log with link-tab and select filters (every value but the
// repository is picked, and cells set filters too), keyset pagination both ways, and one record
// with what to do, a re-evaluation against the current consumer accesses (always run, read-only),
// its stored claims and policy trace. Claims shown are the allowlisted subset stored at request
// time (I-LOG-1), and only verified records have any or prefill a form (I-LOG-2). Query text is
// validated against closed sets and never echoed as a label.
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { getCallerProvider, listCallerProviders } from '../../db/caller-providers';
import { repositoryLabelOptions } from '../../db/claim-labels';
import { listGrants } from '../../db/grants';
import {
  getRequest,
  type RequestFilter,
  REQUEST_SCAN_ROWS,
  type RequestPage,
  searchRequests,
} from '../../db/requests';
import { getService, listServices } from '../../db/services';
import { getSettings } from '../../db/settings';
import type { CallerProvider, Grant, Service } from '../../db/types';
import { tenantPinHolds } from '../../identity/jwt';
import { getProfile, PROFILES } from '../../identity/profiles';
import type { Claims } from '../../identity/types';
import { idTimestamp } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { evaluateGrants } from '../../policy/evaluate';
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
import type { FieldError } from '../ops/shared';
import { paths } from '../paths';
import { type AdminContext, renderPage, type ViewContext } from '../render';
import {
  AskSomeone,
  DataTable,
  Details,
  EmptyState,
  Field,
  FilterChips,
  NotFound,
  type OptionList,
  Pager,
  Select,
  StatusBadge,
  Tabs,
  Time,
} from '../views/components';
import { formatCount, formatDuration, formatTime } from '../views/format';
import {
  extractRequestId,
  FIND_REQUEST_MAX,
  FindRequestForm,
  profileForIssuer,
} from '../views/monitoring';
import {
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
  /** A consumer id or `none`. */
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
  errors: FieldError[];
} {
  const params: RequestParams = {};
  const errors: FieldError[] = [];
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
    else errors.push({ field: 'consumer', message: 'Choose a service consumer from the list.' });
  }
  const access = raw('access');
  if (access) {
    if (GRANT_ID.test(access)) params.access = access;
    else
      errors.push({
        field: null,
        message: 'That consumer access filter is not valid; it was removed.',
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
      : { caller_provider_id: params.consumer === 'none' ? null : params.consumer }),
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
          subnavExtra: <FindRequestForm />,
          breadcrumbs: [
            { href: paths.overview(), label: 'Monitoring' },
            { href: paths.requests(), label: 'Requests' },
            { href: c.req.path, label: 'Not found' },
          ],
        },
        () => (
          <NotFound
            what="request"
            hint={
              <p>
                Records are kept {settings.request_log_retention_days} days (
                <a href={paths.retention()}>Data retention</a>).
              </p>
            }
          />
        ),
      );
    }
    const db = deps.env.DB;
    const [service, provider, grants] = await Promise.all([
      record.service_id ? getService(db, record.service_id) : null,
      record.caller_provider_id ? getCallerProvider(db, record.caller_provider_id) : null,
      record.service_id ? listGrants(db, { service_id: record.service_id }) : [],
    ]);
    const reevaluation =
      record.claims_verified === 1
        ? reevaluate(record, { service, provider, grants, now: deps.now() })
        : null;
    return renderPage(
      c,
      {
        title: `${OUTCOME_TITLE[record.outcome]}: ${record.method} ${record.path}`,
        section: 'monitoring',
        subsection: 'requests',
        subnavExtra: <FindRequestForm />,
        breadcrumbs: [
          { href: paths.overview(), label: 'Monitoring' },
          { href: paths.requests(), label: 'Requests' },
          { href: paths.request(record.id), label: record.id },
        ],
      },
      (ctx) => (
        <RequestDetail
          ctx={ctx}
          record={record}
          service={service}
          provider={provider}
          grants={grants}
          reevaluation={reevaluation}
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

// ---------------------------------------------------------------------------------------------
// List

async function requestsPage(
  c: AdminContext,
  o: {
    params: RequestParams;
    errors: FieldError[];
    find?: { value: string; error: string };
    rawRepo?: string;
    status: 200 | 400 | 404;
  },
) {
  const deps = c.get('deps');
  const { params } = o;
  const now = deps.now();
  const [services, providers, grants, repos, page] = await Promise.all([
    listServices(deps.env.DB),
    listCallerProviders(deps.env.DB),
    listGrants(deps.env.DB),
    repositoryLabelOptions(deps.env.DB),
    searchRequests(deps.env.TELEMETRY_DB, { ...toFilter(params, now), limit: PAGE_SIZE + 1 }),
  ]);
  const names = {
    tokens: new Map(services.map((s) => [s.id, s])),
    consumers: new Map(providers.map((p) => [p.id, p])),
    grants: new Map(grants.map((g) => [g.id, g.name])),
  };
  const { rows, pager } = paginate(params, page);
  const titleParts = [
    params.outcome ? OUTCOME_LABEL[params.outcome].toLowerCase() : null,
    params.range ? `last ${RANGE_LABEL[params.range]}` : null,
    params.token ? `token ${tokenName(params.token, names.tokens)}` : null,
    params.consumer ? `consumer ${consumerName(params.consumer, names.consumers)}` : null,
    params.access ? `access ${names.grants.get(params.access) ?? params.access}` : null,
    params.repo ? params.repo : null,
    params.reason ? params.reason : null,
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
  return renderPage(
    c,
    {
      title: titleParts.length > 0 ? `Requests: ${titleParts.join(', ')}` : 'Requests',
      section: 'monitoring',
      subsection: 'requests',
      errors: o.errors,
      status: o.status,
      subnavExtra: <FindRequestForm value={o.find?.value} error={o.find?.error} />,
    },
    (ctx) => (
      <>
        <p class="muted">
          Every call that reached the gateway, newest first. Denied and failed requests are always
          recorded; allowed requests may be sampled (<a href={paths.retention()}>Data retention</a>
          ). Open a request to see why it was allowed or denied.
        </p>
        <Tabs
          label="Time range"
          current={params.range ?? 'all'}
          items={[
            ...REQUESTS_RANGES.map((key) => ({
              key,
              href: listLink(params, { range: key }),
              label: RANGE_LABEL[key],
            })),
            { key: 'all', href: listLink(params, { range: undefined }), label: 'All' },
          ]}
        />
        <Tabs
          label="Outcome"
          current={params.outcome ?? 'all'}
          items={[
            { key: 'all', href: listLink(params, { outcome: undefined }), label: 'All' },
            ...OUTCOMES.map((key) => ({
              key,
              href: listLink(params, { outcome: key }),
              label: OUTCOME_LABEL[key],
            })),
          ]}
        />
        <RequestFilters
          params={params}
          errors={o.errors}
          services={services}
          providers={providers}
          repos={[...new Set(repos.map((r) => r.label))]}
          rawRepo={o.rawRepo}
        />
        <FilterChips items={filterChips(params, names)} clearHref={paths.requests()} />
        {page.olderBefore ? (
          <p class="note">
            Searched the {formatCount(REQUEST_SCAN_ROWS)} requests before{' '}
            <Time ms={idTimestamp(page.olderBefore) ?? now} />.{' '}
            <a href={listLink(params, { before: page.olderBefore, after: undefined })}>
              Search older
            </a>
          </p>
        ) : null}
        {page.newerAfter ? (
          <p class="note">
            Searched the {formatCount(REQUEST_SCAN_ROWS)} requests after{' '}
            <Time ms={idTimestamp(page.newerAfter) ?? now} />.{' '}
            <a href={listLink(params, { after: page.newerAfter, before: undefined })}>
              Search newer
            </a>
          </p>
        ) : null}
        {rows.length === 0 ? (
          filtered || params.before || params.after ? (
            <EmptyState>
              No requests match these filters
              {page.olderBefore || page.newerAfter ? ' in this range' : ''}.{' '}
              <a href={paths.requests()}>Clear filters</a>
            </EmptyState>
          ) : (
            <EmptyState
              action={
                <>
                  <a href={paths.overview({ hash: 'get-started' })}>Get started</a>{' '}
                  <a href={docsUrl('callers/github-actions.md')}>
                    GitHub Actions guide<span class="vh"> (GitHub docs)</span>
                  </a>
                </>
              }
            >
              No requests recorded yet.
            </EmptyState>
          )
        ) : (
          <RequestTable records={rows} params={params} names={names} ctx={ctx} />
        )}
        <Pager {...pager} />
      </>
    ),
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

function consumerName(value: string, consumers: ReadonlyMap<string, CallerProvider>): string {
  if (value === 'none') return 'none';
  return consumers.get(value)?.name ?? value;
}

function filterChips(
  params: RequestParams,
  names: {
    tokens: ReadonlyMap<string, Service>;
    consumers: ReadonlyMap<string, CallerProvider>;
    grants: ReadonlyMap<string, string>;
  },
) {
  const chip = (key: FilterKey, label: string) => ({
    label,
    removeHref: listLink(params, { [key]: undefined }),
  });
  const chips: Array<{ label: string; removeHref: string }> = [];
  if (params.token) {
    chips.push(
      chip(
        'token',
        params.token === 'none'
          ? 'Token: refused before a token was chosen'
          : `Token: ${tokenName(params.token, names.tokens)}`,
      ),
    );
  }
  if (params.consumer) {
    chips.push(
      chip(
        'consumer',
        params.consumer === 'none'
          ? 'Consumer: none'
          : `Consumer: ${consumerName(params.consumer, names.consumers)}`,
      ),
    );
  }
  if (params.access)
    chips.push(chip('access', `Access: ${names.grants.get(params.access) ?? params.access}`));
  if (params.repo) chips.push(chip('repo', `Repository: ${params.repo}`));
  if (params.reason) chips.push(chip('reason', `Reason: ${params.reason}`));
  if (params.slug) chips.push(chip('slug', `Slug: ${params.slug}`));
  return chips;
}

function RequestFilters(props: {
  params: RequestParams;
  errors: FieldError[];
  services: Service[];
  providers: CallerProvider[];
  repos: string[];
  /** The submitted repository when it was invalid, re-rendered for correction (WCAG 3.3.7). */
  rawRepo?: string;
}) {
  const { params, services, providers } = props;
  const error = (field: string) => props.errors.find((e) => e.field === field)?.message ?? null;
  const tokenOptions = [
    ...[...services]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ value: s.id, label: `${s.name} (${s.slug})` })),
    { value: 'none', label: 'Refused before a token was chosen' },
  ];
  // Only a well-formed id gets its own option: arbitrary query text is never shown as a label.
  if (
    params.token &&
    SERVICE_ID.test(params.token) &&
    !services.some((s) => s.id === params.token)
  ) {
    tokenOptions.push({ value: params.token, label: `Deleted token ${params.token}` });
  }
  const consumerOptions = [
    ...[...providers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        value: p.id,
        label: `${p.name} (${PROFILES[p.profile]?.label ?? p.profile})`,
      })),
    { value: 'none', label: 'No consumer (unknown issuer)' },
  ];
  if (
    params.consumer &&
    PROVIDER_ID.test(params.consumer) &&
    !providers.some((p) => p.id === params.consumer)
  ) {
    consumerOptions.push({ value: params.consumer, label: `Deleted consumer ${params.consumer}` });
  }
  const reasonOptions: OptionList = REASON_GROUPS.map((group) => ({
    group: group.group,
    options: group.codes
      .filter((code) => REASON_CODES.includes(code))
      .map((code) => ({ value: code, label: reasonLabel(code) })),
  }));
  return (
    <form method="get" action={paths.requests()} class="filters" aria-label="Filter requests">
      <fieldset>
        <legend>All filters are optional</legend>
        {params.range ? <input type="hidden" name="range" value={params.range} /> : null}
        {params.outcome ? <input type="hidden" name="outcome" value={params.outcome} /> : null}
        {params.access ? <input type="hidden" name="access" value={params.access} /> : null}
        {params.slug ? <input type="hidden" name="slug" value={params.slug} /> : null}
        <Select
          name="token"
          label="Token"
          value={params.token ?? null}
          placeholder="Any token"
          options={tokenOptions}
          hint="Pick a token. For calls to unknown slugs, open a request and use “Requests to this slug”."
          error={error('token')}
        />
        <Select
          name="consumer"
          label="Service consumer"
          value={params.consumer ?? null}
          placeholder="Any consumer"
          options={consumerOptions}
          hint="The service consumer the caller token was issued for."
          error={error('consumer')}
        />
        <Field
          name="repo"
          type="search"
          label="Repository"
          value={params.repo ?? props.rawRepo}
          example="acme/api"
          hint="Owner and name exactly as GitHub or GitLab shows them; case matters. Pick a suggestion or click a repository in the table."
          error={error('repo')}
          pattern={REPO_PATTERN}
          maxlength={REPO_MAX}
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
          suggestions={props.repos.map((value) => ({ value }))}
        />
        <Select
          name="reason"
          label="Reason"
          value={params.reason ?? null}
          placeholder="Any reason"
          options={reasonOptions}
          hint="Why the gateway refused or failed the call."
          error={error('reason')}
        />
        <div class="actions">
          <button type="submit" class="secondary">
            Apply filters
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function RequestTable(props: {
  records: RequestRecord[];
  params: RequestParams;
  names: {
    tokens: ReadonlyMap<string, Service>;
    consumers: ReadonlyMap<string, CallerProvider>;
    grants: ReadonlyMap<string, string>;
  };
  ctx: ViewContext;
}) {
  const { params, names } = props;
  const filterLink = (changes: Partial<RequestParams>, what: string, text: Child) => (
    <a href={listLink(params, changes)}>
      <span class="vh">Filter by {what} </span>
      {text}
    </a>
  );
  return (
    <DataTable
      id="requests"
      caption="Requests, newest first"
      rowHeader="request"
      rows={props.records}
      columns={[
        { key: 'when', header: 'When', render: (r) => <Time ms={r.ts} /> },
        {
          key: 'result',
          header: 'Result',
          render: (r) => (
            <>
              <StatusBadge status={r.outcome} /> · {r.status}
            </>
          ),
        },
        {
          key: 'request',
          header: 'Request',
          render: (r) => (
            <a href={paths.request(r.id)}>
              <code>
                {r.method} {r.path}
              </code>
              <span class="vh">
                {' '}
                at {formatTime(r.ts).slice(11, 19)}, {r.outcome}
              </span>
            </a>
          ),
        },
        {
          key: 'token',
          header: 'Token',
          render: (r) =>
            r.service_id ? (
              filterLink(
                { token: r.service_id },
                'token',
                <code>
                  {names.tokens.get(r.service_id)?.slug ?? r.service_slug ?? r.service_id}
                </code>,
              )
            ) : r.service_slug && SLUG.test(r.service_slug) ? (
              filterLink({ slug: r.service_slug }, 'slug', <code>{r.service_slug}</code>)
            ) : r.service_slug ? (
              <code>{r.service_slug}</code>
            ) : (
              '—'
            ),
        },
        {
          key: 'consumer',
          header: 'Consumer',
          render: (r) =>
            r.claims_verified === 1 ? (
              <>
                {r.caller_repository && REPO.test(r.caller_repository)
                  ? filterLink({ repo: r.caller_repository }, 'repository', r.caller_repository)
                  : (r.caller_repository ?? r.caller_subject ?? '—')}
                {r.caller_provider_id ? (
                  <>
                    <br />
                    {filterLink(
                      { consumer: r.caller_provider_id },
                      'consumer',
                      <span class="muted">
                        {names.consumers.get(r.caller_provider_id)?.name ?? 'deleted consumer'}
                      </span>,
                    )}
                  </>
                ) : null}
              </>
            ) : (
              <span class="muted">
                unverified token{r.untrusted_iss ? ` (${r.untrusted_iss})` : ''}
              </span>
            ),
        },
        {
          key: 'access',
          header: 'Access',
          render: (r) =>
            r.grant_id
              ? filterLink(
                  { access: r.grant_id },
                  'access',
                  names.grants.get(r.grant_id) ?? <code>{r.grant_id}</code>,
                )
              : '—',
        },
        {
          key: 'reason',
          header: 'Reason',
          render: (r) =>
            r.reason && isReasonCode(r.reason) ? (
              filterLink({ reason: r.reason }, 'reason', reasonText(r.reason) ?? r.reason)
            ) : r.reason ? (
              <code>{r.reason}</code>
            ) : (
              '—'
            ),
        },
        {
          key: 'duration',
          header: 'Duration',
          numeric: true,
          render: (r) => formatDuration(r.duration_ms),
        },
      ]}
    />
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
  /** The ask text: "Ask a token manager to …". */
  verb?: string;
}

interface ActionContext {
  record: RequestRecord;
  /** The re-evaluation says the request would be allowed now. */
  allowedNow: boolean;
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
  record.caller_provider_id
    ? [{ href: paths.consumer(record.caller_provider_id), label: 'Open consumer' }]
    : [];

const openKeys = (): NextAction[] => [{ href: paths.tokenKeys(), label: 'Open encryption keys' }];

const giveAccess = ({ record, allowedNow }: ActionContext): NextAction[] =>
  record.claims_verified === 1 && !allowedNow
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
    text: "The token is not a JWT with an algorithm and key id this service consumer accepts. Check the service consumer's allowed algorithms.",
    actions: openConsumer,
  },
  issuer_unknown: {
    text: 'No enabled service consumer has this issuer. Add a service consumer for it, or enable the existing one.',
    actions: ({ record }) => {
      const type =
        record.claims_verified === 0 ? profileForIssuer(record.untrusted_iss) : undefined;
      return [
        {
          href: paths.consumerNew(type ? { type } : undefined),
          label: 'Add a service consumer',
          permission: 'access:write',
          verb: 'add a service consumer',
        },
      ];
    },
  },
  audience_mismatch: {
    text: 'The token was minted for another audience. Use the audience shown on the service consumer page.',
    actions: openConsumer,
  },
  token_expired: {
    text: 'Mint the token right before the call: tokens are short-lived.',
    actions: callerDocs('token_expired'),
  },
  token_too_old: {
    text: "Mint the token right before the call, or raise the service consumer's maximum token age.",
    actions: openConsumer,
  },
  signature_invalid: {
    text: "The token signature does not match the issuer's signing keys. Check that the service consumer's issuer and JWKS URL are correct.",
    actions: openConsumer,
  },
  jwks_unavailable: {
    text: "The gateway could not download the issuer's signing keys. Usually temporary; if it persists, check the service consumer's JWKS URL.",
    actions: openConsumer,
  },
  claims_invalid: {
    text: 'The token lacks claims this service consumer requires.',
    actions: openConsumer,
  },
  tenant_mismatch: {
    text: "The caller is outside the organization or group pinned on the service consumer (tenant pin). Check the service consumer's organizations or groups.",
    actions: openConsumer,
  },
  profile_unknown: {
    text: 'The service consumer uses a consumer type this version does not know. Check the service consumer, or upgrade the gateway.',
    actions: openConsumer,
  },
  no_matching_grant: {
    text: 'No consumer access allows this caller to make this request. Read the policy evaluation below to see which check failed. An access manager, admin or owner can give access from this request.',
    actions: giveAccess,
  },
  event_not_trusted: {
    text: 'The workflow event (for example pull_request_target) is not trusted by default. A consumer access must list it explicitly, which is risky for events that run untrusted code.',
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
        label: 'Add a service token',
        permission: 'tokens:write',
        verb: 'add a service token',
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
    text: 'Set the TOKENGATE_KEK secret on the Worker. See Service tokens › Encryption keys for the keyring status.',
    actions: openKeys,
  },
  keyring_malformed: {
    text: 'Fix the TOKENGATE_KEK or TOKENGATE_KEYRING secret. See Service tokens › Encryption keys.',
    actions: openKeys,
  },
  active_kid_missing: {
    text: 'Fix the TOKENGATE_KEYRING secret: its active key is missing. See Service tokens › Encryption keys.',
    actions: openKeys,
  },
  key_not_32_bytes: {
    text: 'Fix the keyring secret: every key must be 32 bytes. See Service tokens › Encryption keys.',
    actions: openKeys,
  },
  both_kek_and_keyring_set: {
    text: 'Remove one of TOKENGATE_KEK and TOKENGATE_KEYRING.',
    actions: openKeys,
  },
  dev_placeholder_key: {
    text: 'Replace the development TOKENGATE_KEK from .dev.vars.example with a key of your own. See Service tokens › Encryption keys.',
    actions: openKeys,
  },
  credential_missing: {
    text: 'Set the secret on the token page. If the token had one, check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the secret again: the row may have been edited in D1.',
    actions: setSecretAgain,
  },
  credential_binding_mismatch: {
    text: 'If Service tokens › Encryption keys shows a replaced key, restore it. Otherwise the token row was probably edited in D1: check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the secret again.',
    actions: setSecretAgain,
  },
  credential_invalid: { text: 'Re-enter the secret on the token page.', actions: setSecretAgain },
  credential_unavailable: {
    text: "The token's secret could not be opened. Check Service tokens › Encryption keys; if the keys are fine, check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the secret again.",
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
    text: 'The caller exceeded the rate limit for this consumer access.',
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

function WhatToDo(props: { ctx: ViewContext; record: RequestRecord; allowedNow: boolean }) {
  const { record, ctx } = props;
  const entry =
    record.reason !== null && Object.hasOwn(NEXT_ACTIONS, record.reason)
      ? NEXT_ACTIONS[record.reason]
      : undefined;
  if (!entry) return null;
  const actions = (entry.actions?.({ record, allowedNow: props.allowedNow }) ?? []).slice(0, 2);
  return (
    <section class="next" aria-labelledby="next-h">
      <h2 id="next-h">What to do</h2>
      <p>{entry.text}</p>
      {actions.length > 0 ? (
        <div class="actions">
          {actions.map((action) =>
            !action.permission || ctx.can(action.permission) ? (
              <a href={action.href}>
                {action.label}
                {action.context ? <span class="vh"> {action.context}</span> : null}
              </a>
            ) : (
              <AskSomeone permission={action.permission} ctx={ctx} verb={action.verb} />
            ),
          )}
        </div>
      ) : null}
    </section>
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
      decision: Decision<Grant>;
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
    provider: CallerProvider | null;
    /** Accesses of the record's token, any state. */
    grants: Grant[];
    now: number;
  },
): Reevaluation {
  if (record.claims_verified !== 1) {
    return { ok: false, message: 'The token was not verified, so no claims were stored.' };
  }
  const claims = storedClaims(record);
  if (claims === null) return { ok: false, message: 'No claims were stored for this request.' };
  const { provider, service } = ctx;
  if (!record.caller_provider_id || !provider) {
    return { ok: false, message: 'The service consumer of this request no longer exists.' };
  }
  const profile = getProfile(provider.profile);
  if (!profile)
    return { ok: false, message: 'The service consumer uses an unknown consumer type.' };
  if (!record.service_id || !service) {
    return {
      ok: false,
      message:
        'The request did not reach a token that exists today, so no consumer access applies.',
    };
  }
  const canonical = canonicalizePath(record.path);
  if (!canonical.ok) return { ok: false, message: 'The stored path is not a valid proxy path.' };

  const blockers: string[] = [];
  if (!provider.enabled) {
    blockers.push('The service consumer is disabled: the gateway rejects all of its callers.');
  }
  if (!tenantPinHolds(provider, claims)) {
    blockers.push(
      "The stored claims do not satisfy the service consumer's current organizations or groups (tenant pin), or the pin now uses a claim that was not stored.",
    );
  }
  if (!service.enabled) blockers.push('The token is disabled.');

  // Same access set and order as the proxy (db/proxy-context.ts): enabled, unexpired, sorted by
  // (created_at, id) as listGrants returns them.
  const grants = ctx.grants.filter(
    (g) =>
      g.caller_provider_id === provider.id &&
      g.service_id === service.id &&
      g.enabled &&
      (g.expires_at === null || g.expires_at > ctx.now),
  );
  const decision = evaluateGrants(grants, {
    claims,
    profile,
    provider,
    method: record.method,
    path: canonical.path,
    matchPath: canonical.matchPath,
    revealClaims: new Set(profile.logClaimAllowlist(provider)),
  });
  return { ok: true, blockers, decision, grantsChecked: grants.length };
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
  invalid_grant: "the access no longer meets the service consumer's anchor rule (I-AUTHZ-2)",
  condition_failed: 'a constraint did not match',
  event_not_trusted: 'event not opted in',
  no_rule: 'no rule allows this method and path',
};

function GrantLink(props: { id: string | null; names: Map<string, string> }) {
  if (!props.id) return <>—</>;
  const name = props.names.get(props.id);
  return <a href={paths.accessItem(props.id)}>{name ?? <code>{props.id}</code>}</a>;
}

function claimsText(claims: Claims | null): string | null {
  if (!claims) return null;
  const parts = ['repository', 'project_path', 'workflow', 'job_workflow_ref', 'ref', 'environment']
    .map((key) => (typeof claims[key] === 'string' ? `${key} ${claims[key] as string}` : null))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function RequestDetail(props: {
  ctx: ViewContext;
  record: RequestRecord;
  service: Service | null;
  provider: CallerProvider | null;
  grants: Grant[];
  reevaluation: Reevaluation | null;
}) {
  const { record: r, service, provider, ctx } = props;
  const grantNames = new Map(props.grants.map((g) => [g.id, g.name]));
  const claims = storedClaims(r);
  const trace = storedTrace(r);
  const allowedNow =
    props.reevaluation?.ok === true && props.reevaluation.decision.decision === 'allow';
  const tokenLabel = service?.slug ?? r.service_slug;
  return (
    <>
      <p class="status-line">
        <StatusBadge status={r.outcome} /> {tokenLabel ? <code>{tokenLabel}</code> : 'no token'} ·{' '}
        <Time ms={r.ts} /> · HTTP {r.status}
        {r.reason ? (
          <>
            {' · '}
            <code>{r.reason}</code>
            {reasonText(r.reason) ? `: ${reasonText(r.reason)}` : ''}
          </>
        ) : null}
      </p>
      <WhatToDo ctx={ctx} record={r} allowedNow={allowedNow} />

      <section aria-labelledby="recheck-h">
        <h2 id="recheck-h">Check against current access</h2>
        <Recheck record={r} result={props.reevaluation} grantNames={grantNames} />
      </section>

      <h2>Summary</h2>
      <Details
        rows={[
          [
            'Token',
            r.service_id && service ? (
              <a href={paths.token(r.service_id)}>
                {service.name} <code>{service.slug}</code>
              </a>
            ) : r.service_slug ? (
              <>
                <code>{r.service_slug}</code>{' '}
                <span class="muted">
                  {r.service_id ? '(deleted)' : '(no such token when called)'}
                </span>
              </>
            ) : (
              '—'
            ),
          ],
          [
            'Consumer',
            r.caller_provider_id ? (
              provider ? (
                <a href={paths.consumer(r.caller_provider_id)}>{provider.name}</a>
              ) : (
                <>
                  <code>{r.caller_provider_id}</code> <span class="muted">(deleted)</span>
                </>
              )
            ) : (
              '—'
            ),
          ],
          ['Access that allowed it', <GrantLink id={r.grant_id} names={grantNames} />],
          [
            'Caller',
            r.claims_verified === 1
              ? (claimsText(claims) ?? r.caller_repository ?? r.caller_subject ?? '—')
              : '—',
          ],
          [
            'Token verified',
            r.claims_verified === 1
              ? 'Yes: signature, issuer, audience and tenant pin were checked.'
              : 'No: the request was refused before the token was trusted, so no caller details were stored.',
          ],
          ...(r.untrusted_iss
            ? ([
                [
                  'Issuer (unverified)',
                  <>
                    <code>{r.untrusted_iss}</code>{' '}
                    <span class="muted">read from a token that was not trusted</span>
                  </>,
                ],
              ] as Array<[string, Child]>)
            : []),
          [
            'Upstream status',
            r.upstream_status === null
              ? 'Not forwarded to the upstream'
              : String(r.upstream_status),
          ],
          ['Total time', formatDuration(r.duration_ms)],
          ['Upstream time', formatDuration(r.upstream_ms)],
          ...(r.weight !== 1
            ? ([
                [
                  'Sampling',
                  `This record stands for about ${formatCount(r.weight)} allowed requests.`,
                ],
              ] as Array<[string, Child]>)
            : []),
        ]}
      />

      {trace.length > 0 ? (
        <>
          <h2>Policy evaluation at request time</h2>
          <p class="muted">
            Each consumer access of this consumer and token, in evaluation order, with the first
            check that failed.
          </p>
          <TraceTable
            id="trace"
            caption="Policy evaluation at request time"
            trace={trace}
            grantNames={grantNames}
          />
        </>
      ) : null}

      <h2>Caller claims</h2>
      {claims && Object.keys(claims).length > 0 ? (
        <>
          <p class="muted">
            Only claims on the service consumer's allowlist are stored; others (and the token
            itself) are never kept.
          </p>
          <DataTable
            id="claims"
            caption="Stored caller claims"
            captionHidden
            rowHeader="claim"
            rows={Object.entries(claims)}
            columns={[
              { key: 'claim', header: 'Claim', render: ([name]) => <code>{name}</code> },
              {
                key: 'value',
                header: 'Value',
                render: ([, value]) => (
                  <code>{typeof value === 'string' ? value : JSON.stringify(value)}</code>
                ),
              },
            ]}
          />
        </>
      ) : (
        <EmptyState>
          {r.claims_verified === 1
            ? 'No claims were stored for this request.'
            : 'None: the token was not verified, so its claims were not stored.'}
        </EmptyState>
      )}

      <details>
        <summary>Technical details</summary>
        <Details
          rows={[
            ['Request ID', <code>{r.id}</code>],
            ['Time', <Time ms={r.ts} />],
            ['Token ID (jti)', r.jti ? <code>{r.jti}</code> : '—'],
            ['Caller subject (sub)', r.caller_subject ? <code>{r.caller_subject}</code> : '—'],
            ['Client IP', r.ip ?? '—'],
            ['User agent', r.user_agent ?? '—'],
            ['Cloudflare location', r.colo ?? '—'],
          ]}
        />
      </details>

      <h2>Related</h2>
      <ul class="related">
        {r.claims_verified === 1 && r.caller_repository && REPO.test(r.caller_repository) ? (
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
            <a href={paths.requests({ slug: r.service_slug })}>Requests to {r.service_slug}</a>
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
    </>
  );
}

function TraceTable(props: {
  id: string;
  caption: string;
  trace: TraceItem[];
  grantNames: Map<string, string>;
}) {
  return (
    <DataTable
      id={props.id}
      caption={props.caption}
      captionHidden
      rowHeader="access"
      rows={props.trace}
      columns={[
        {
          key: 'access',
          header: 'Consumer access',
          render: (item) =>
            'omitted' in item ? (
              `${item.omitted} more not shown (trace size limit)`
            ) : (
              <GrantLink id={item.grant_id} names={props.grantNames} />
            ),
        },
        {
          key: 'result',
          header: 'Result',
          render: (item) =>
            'omitted' in item ? '—' : (TRACE_RESULT_TEXT[item.result] ?? item.result),
        },
        {
          key: 'detail',
          header: 'Detail',
          render: (item) => ('omitted' in item ? '—' : <code>{item.detail}</code>),
        },
      ]}
    />
  );
}

function Recheck(props: {
  record: RequestRecord;
  result: Reevaluation | null;
  grantNames: Map<string, string>;
}) {
  if (props.record.claims_verified !== 1 || props.result === null) {
    return <p>Not available: the token was not verified, so no claims were stored.</p>;
  }
  const intro = (
    <p class="muted">
      The policy runs again with this request's stored claims against the consumer accesses as they
      are now. Stored claims subset only: constraints on claims that were not stored fail, so a real
      token may be allowed where this check says denied. Nothing is changed.
    </p>
  );
  const { result } = props;
  if (!result.ok) {
    return (
      <>
        {intro}
        <p>{result.message}</p>
      </>
    );
  }
  const { decision } = result;
  return (
    <>
      {intro}
      {result.blockers.length > 0 ? (
        <ul class="blockers">
          {result.blockers.map((blocker) => (
            <li>{blocker}</li>
          ))}
        </ul>
      ) : null}
      {decision.decision === 'allow' ? (
        <p>
          Would now be <b>allowed</b> by access{' '}
          <GrantLink id={decision.grant.id} names={props.grantNames} />.
        </p>
      ) : (
        <p>
          Would still be <b>denied</b> (<code>{decision.code}</code>).{' '}
          {result.grantsChecked === 0
            ? 'No enabled consumer access exists for this consumer and token.'
            : `${result.grantsChecked} enabled ${result.grantsChecked === 1 ? 'access' : 'accesses'} checked.`}
        </p>
      )}
      {decision.trace.length > 0 ? (
        <TraceTable
          id="recheck-trace"
          caption="Check against current access"
          trace={decision.trace}
          grantNames={props.grantNames}
        />
      ) : null}
    </>
  );
}
