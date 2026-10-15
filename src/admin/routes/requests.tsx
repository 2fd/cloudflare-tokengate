// Request log pages: filtered list with keyset pagination, and one record with its stored claims,
// policy trace and a read-only re-evaluation against the current grants. Read-only; claims shown
// are the allowlisted subset stored at request time (I-LOG-1), and only verified records have any.
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { getCallerProvider } from '../../db/caller-providers';
import { listGrants } from '../../db/grants';
import {
  getRequest,
  REQUEST_SCAN_ROWS,
  type RequestFilter,
  searchRequests,
} from '../../db/requests';
import { getService, listServices } from '../../db/services';
import type { CallerProvider, Grant, Service } from '../../db/types';
import { tenantPinHolds } from '../../identity/jwt';
import { getProfile } from '../../identity/profiles';
import type { Claims } from '../../identity/types';
import { parseJson } from '../../lib/json';
import { evaluateGrants } from '../../policy/evaluate';
import type { Decision, TraceEntry } from '../../policy/types';
import { canonicalizePath } from '../../proxy/path';
import type { Outcome, RequestRecord } from '../../telemetry/types';
import { can } from '../auth/rbac';
import { paths } from '../paths';
import { renderPage } from '../render';
import {
  Badge,
  Code,
  Details,
  EmptyState,
  Field,
  Messages,
  NextPage,
  Select,
} from '../views/components';
import { formatCount, formatDuration, formatTime, withQuery } from '../views/format';
import { docsUrl, reasonText } from '../views/reasons';

const SECTION = '/admin/requests';
const PAGE_SIZE = 50;
const OUTCOMES: readonly Outcome[] = ['allowed', 'denied', 'error'];
const REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const SERVICE_ID = /^svc_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TEXT_FILTER = 256;
/**
 * Deny reasons a grant can fix; only these records offer "Create grant from this request". Keep in
 * sync with PREFILL_REASONS in grants.tsx.
 */
const GRANT_FIXABLE = new Set(['no_matching_grant', 'event_not_trusted']);

/** What the operator can do about a reason. */
const NEXT_STEP: Readonly<Record<string, string>> = {
  token_missing:
    'The caller sent no token. Pass the token from the get-token action in the x-tokengate-token header.',
  token_ambiguous: 'The caller sent two different tokens. Send exactly one.',
  token_malformed:
    "The token is not a JWT with an algorithm and key id this caller provider accepts. Check the caller provider's allowed algorithms.",
  issuer_unknown:
    'No enabled caller provider has this issuer. Add a caller provider for it, or enable the existing one.',
  audience_mismatch:
    'The token was minted for another audience. Use the audience shown on the caller provider page.',
  token_expired: 'Mint the token right before the call: tokens are short-lived.',
  token_too_old:
    "Mint the token right before the call, or raise the caller provider's maximum token age.",
  signature_invalid:
    "The token signature does not match the issuer's signing keys. Check that the caller provider's issuer and JWKS URL are correct.",
  jwks_unavailable:
    "The gateway could not download the issuer's signing keys. Usually temporary; if it persists, check the caller provider's JWKS URL.",
  claims_invalid: 'The token lacks claims this caller provider requires.',
  tenant_mismatch:
    "The caller is outside the organization or namespace pinned on the caller provider (tenant pin). Check the caller provider's tenant pin.",
  no_matching_grant:
    'No grant allows this caller to make this request. Read the policy evaluation below to see which check failed. An access manager, admin or owner can create a grant from this request.',
  event_not_trusted:
    'The workflow event (for example pull_request_target) is not trusted by default. A grant must list it explicitly, which is risky for events that run untrusted code.',
  service_not_found: 'Check the service slug in the URL.',
  service_disabled: 'Enable the service if callers should use it again.',
  path_invalid:
    'The path has empty or dot segments ("//", "..", "."), forbidden escapes or characters not allowed in URL paths. Fix the URL in the caller.',
  query_invalid:
    'The query string has characters the gateway does not forward or a malformed copy of the injected parameter. Fix the URL in the caller.',
  method_not_allowed: 'Use a standard HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS).',
  base_url_invalid: "Check the service's base URL on the service page.",
  injection_invalid: 'Re-enter the credential and injection on the service page.',
  keyring_absent:
    'Set the TOKENGATE_KEK secret on the Worker. See Service tokens › Encryption keys for the keyring status.',
  keyring_malformed:
    'Fix the TOKENGATE_KEK or TOKENGATE_KEYRING secret. See Service tokens › Encryption keys.',
  active_kid_missing:
    'Fix the TOKENGATE_KEYRING secret: its active key is missing. See Service tokens › Encryption keys.',
  key_not_32_bytes:
    'Fix the keyring secret: every key must be 32 bytes. See Service tokens › Encryption keys.',
  both_kek_and_keyring_set: 'Remove one of TOKENGATE_KEK and TOKENGATE_KEYRING.',
  dev_placeholder_key:
    'Replace the development TOKENGATE_KEK from .dev.vars.example with a key of your own. See Service tokens › Encryption keys.',
  credential_missing:
    'Set the credential on the service page. If the service had one, check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the credential again: the row may have been edited in D1.',
  credential_binding_mismatch:
    'If Service tokens › Encryption keys shows a replaced key, restore it. Otherwise the service row was probably edited in D1: check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the credential again.',
  credential_invalid: 'Re-enter the credential on the service page.',
  keyring_missing_key:
    'Restore the missing key in the keyring. If you enter the credential again instead, first check the base URL and injection against an out-of-band source (provider docs, configuration as code).',
  sealed_malformed:
    'The stored credential is damaged, possibly by an edit in D1: check the base URL and injection against an out-of-band source (provider docs, configuration as code) before you enter the credential again.',
  upstream_timeout:
    "The upstream API did not answer in time. Check its status, or raise the service's timeout.",
  upstream_unreachable: 'The upstream API could not be reached. Check its status and base URL.',
  upstream_invalid_status:
    'The upstream answered with an invalid HTTP status after receiving the request. Check the upstream; do not assume the request failed.',
  rate_limited: 'The caller exceeded the rate limit for this grant.',
};

function nextStep(reason: string | null): string | null {
  return reason !== null && Object.hasOwn(NEXT_STEP, reason) ? (NEXT_STEP[reason] ?? null) : null;
}

export function registerRequestsRoutes(app: App): void {
  app.get('/admin/requests', async (c) => {
    const deps = c.get('deps');
    const query = {
      token: c.req.query('token') ?? '',
      outcome: c.req.query('outcome') ?? '',
      repo: (c.req.query('repo') ?? '').trim(),
      slug: (c.req.query('slug') ?? '').trim(),
      before: c.req.query('before') ?? '',
    };
    const parsed = parseRequestFilter(query);
    const [services, grants] = await Promise.all([
      listServices(deps.env.DB),
      listGrants(deps.env.DB),
    ]);
    if (!parsed.ok) {
      return renderPage(
        c,
        { title: 'Requests', section: SECTION, status: 400 },
        <>
          <Messages errors={parsed.errors} />
          <RequestFilters query={query} services={services} />
        </>,
      );
    }
    const { records: rows, olderBefore } = await searchRequests(deps.env.TELEMETRY_DB, {
      ...parsed.filter,
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const next =
      rows.length > PAGE_SIZE && last
        ? withQuery(SECTION, { ...query, before: last.id })
        : olderBefore
          ? withQuery(SECTION, { ...query, before: olderBefore })
          : null;
    const filtered = Boolean(query.token || query.outcome || query.repo || query.slug);
    return renderPage(
      c,
      { title: 'Requests', section: SECTION },
      <>
        <p class="muted">
          Every call that reached the gateway, newest first. Denied and failed requests are always
          recorded; allowed requests may be sampled (see{' '}
          <a href={paths.retention()}>Data retention</a>). Open a request to see why it was allowed
          or denied.
        </p>
        <RequestFilters query={query} services={services} />
        {query.before ? (
          <p>
            <a href={withQuery(SECTION, { ...query, before: '' })}>← Newest requests</a>
          </p>
        ) : null}
        {olderBefore ? (
          <p class="muted">
            Outcome and service slug filters search {formatCount(REQUEST_SCAN_ROWS)} requests at a
            time. Use "Older entries" to search further back.
          </p>
        ) : null}
        {page.length === 0 ? (
          filtered || query.before ? (
            <EmptyState>
              No requests match these filters{olderBefore ? ' in this range' : ''}.{' '}
              <a href={SECTION}>Clear filters</a>
            </EmptyState>
          ) : (
            <EmptyState>
              No requests recorded yet. Once a service, a caller provider and a grant exist, call
              the gateway from a workflow:{' '}
              <a href={docsUrl('callers/github-actions.md')}>GitHub Actions guide</a>.
            </EmptyState>
          )
        ) : (
          <RequestTable records={page} grantNames={namesById(grants)} />
        )}
        <NextPage href={next} />
      </>,
    );
  });

  app.get('/admin/requests/:id', async (c) => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    const record = REQUEST_ID.test(id) ? await getRequest(deps.env.TELEMETRY_DB, id) : null;
    if (!record) {
      return renderPage(
        c,
        { title: 'Request not found', section: SECTION, status: 404 },
        <EmptyState>
          There is no request record with this id. It may have been removed by the retention policy.{' '}
          <a href={SECTION}>Back to requests</a>
        </EmptyState>,
      );
    }
    const db = deps.env.DB;
    const [service, provider, grants] = await Promise.all([
      record.service_id ? getService(db, record.service_id) : null,
      record.caller_provider_id ? getCallerProvider(db, record.caller_provider_id) : null,
      record.service_id ? listGrants(db, { service_id: record.service_id }) : [],
    ]);
    const reevaluation =
      c.req.query('reevaluate') === '1'
        ? reevaluate(record, { service, provider, grants, now: deps.now() })
        : null;
    const canCreateGrant =
      can(c.get('viewer').user.role, 'access:write') &&
      record.claims_verified === 1 &&
      record.reason !== null &&
      GRANT_FIXABLE.has(record.reason);
    return renderPage(
      c,
      { title: 'Request', section: SECTION },
      <RequestDetail
        record={record}
        service={service}
        provider={provider}
        grants={grants}
        reevaluation={reevaluation}
        canCreateGrant={canCreateGrant}
      />,
    );
  });
}

type FilterQuery = Record<'token' | 'outcome' | 'repo' | 'slug' | 'before', string>;

function parseRequestFilter(
  query: FilterQuery,
): { ok: true; filter: RequestFilter } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const filter: RequestFilter = {};
  if (query.token) {
    if (SERVICE_ID.test(query.token)) filter.service_id = query.token;
    else errors.push('The service filter is not a valid service id.');
  }
  if (query.outcome) {
    const outcome = OUTCOMES.find((o) => o === query.outcome);
    if (outcome) filter.outcome = outcome;
    else errors.push('Outcome must be allowed, denied or error.');
  }
  if (query.repo) {
    if (query.repo.length <= MAX_TEXT_FILTER) filter.repository = query.repo;
    else errors.push('The repository filter is too long.');
  }
  if (query.slug) {
    if (query.slug.length <= MAX_TEXT_FILTER) filter.slug = query.slug;
    else errors.push('The service slug filter is too long.');
  }
  if (query.before) {
    if (REQUEST_ID.test(query.before)) filter.before = query.before;
    else errors.push('The page position (before) is not a valid request id.');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, filter };
}

function namesById(items: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  return new Map(items.map((item) => [item.id, item.name]));
}

function RequestFilters(props: { query: FilterQuery; services: Service[] }) {
  const { query, services } = props;
  const serviceOptions = [
    { value: '', label: 'All services' },
    ...services.map((s) => ({ value: s.id, label: `${s.name} (${s.slug})` })),
  ];
  // Only a well-formed id gets its own option: arbitrary query text is never shown as a label.
  if (SERVICE_ID.test(query.token) && !services.some((s) => s.id === query.token)) {
    serviceOptions.push({ value: query.token, label: `Deleted service ${query.token}` });
  }
  return (
    <form method="get" action={SECTION} class="filters" aria-label="Filter requests">
      <Select label="Service" name="token" value={query.token} options={serviceOptions} />
      <Select
        label="Outcome"
        name="outcome"
        value={query.outcome}
        options={[
          { value: '', label: 'Any outcome' },
          { value: 'allowed', label: 'Allowed' },
          { value: 'denied', label: 'Denied' },
          { value: 'error', label: 'Error' },
        ]}
      />
      <Field
        label="Repository"
        name="repo"
        value={query.repo}
        placeholder="octo-org/app"
        hint="Exact caller repository (owner/name)."
      />
      <Field
        label="Service slug"
        name="slug"
        value={query.slug}
        placeholder="slack"
        hint="The name in /proxy/<slug>/; also finds calls to unknown services."
      />
      <button type="submit">Apply filters</button>
      <a href={SECTION}>Clear</a>
    </form>
  );
}

function OutcomeBadge(props: { outcome: Outcome }) {
  const tone = props.outcome === 'allowed' ? 'ok' : props.outcome === 'denied' ? 'warn' : 'bad';
  return <Badge tone={tone}>{props.outcome}</Badge>;
}

function CallerCell(props: { record: RequestRecord }) {
  const r = props.record;
  if (r.claims_verified === 1) {
    return (
      <>
        {r.caller_repository ?? r.caller_subject ?? '—'}
        {r.caller_repository && r.caller_subject ? (
          <>
            <br />
            <small class="muted">{r.caller_subject}</small>
          </>
        ) : null}
      </>
    );
  }
  return (
    <span class="muted">
      unverified token{r.untrusted_iss ? ` (issuer ${r.untrusted_iss})` : ''}
    </span>
  );
}

function GrantLink(props: { id: string | null; names: Map<string, string> }) {
  if (!props.id) return <>—</>;
  const name = props.names.get(props.id);
  return <a href={paths.accessItem(props.id)}>{name ?? <Code>{props.id}</Code>}</a>;
}

function RequestTable(props: { records: RequestRecord[]; grantNames: Map<string, string> }) {
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Outcome</th>
            <th scope="col">Status</th>
            <th scope="col">Method</th>
            <th scope="col">Service</th>
            <th scope="col">Path</th>
            <th scope="col">Caller</th>
            <th scope="col">Grant</th>
            <th scope="col">Reason</th>
            <th scope="col">Duration</th>
          </tr>
        </thead>
        <tbody>
          {props.records.map((r) => (
            <tr>
              <td>
                <a href={`${SECTION}/${encodeURIComponent(r.id)}`}>{formatTime(r.ts)}</a>
              </td>
              <td>
                <OutcomeBadge outcome={r.outcome} />
              </td>
              <td>{r.status}</td>
              <td>
                <Code>{r.method}</Code>
              </td>
              <td>{r.service_slug ? <Code>{r.service_slug}</Code> : '—'}</td>
              <td class="wrap">
                <Code>{r.path}</Code>
              </td>
              <td class="wrap">
                <CallerCell record={r} />
              </td>
              <td>
                <GrantLink id={r.grant_id} names={props.grantNames} />
              </td>
              <td>
                {r.reason ? <Code>{r.reason}</Code> : '—'}
                {reasonText(r.reason) ? (
                  <>
                    <br />
                    <small class="muted">{reasonText(r.reason)}</small>
                  </>
                ) : null}
              </td>
              <td>{formatDuration(r.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail

export type Reevaluation =
  | { ok: false; message: string }
  | {
      ok: true;
      /** Checks that run before grants and would refuse the request on their own. */
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
    /** Grants of the record's service, any state. */
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
    return { ok: false, message: 'The caller provider of this request no longer exists.' };
  }
  const profile = getProfile(provider.profile);
  if (!profile) return { ok: false, message: 'The caller provider uses an unknown profile.' };
  if (!record.service_id || !service) {
    return {
      ok: false,
      message: 'The request did not reach a service that exists today, so no grants apply.',
    };
  }
  const canonical = canonicalizePath(record.path);
  if (!canonical.ok) return { ok: false, message: 'The stored path is not a valid proxy path.' };

  const blockers: string[] = [];
  if (!provider.enabled) {
    blockers.push('The caller provider is disabled: the gateway rejects all of its callers.');
  }
  if (!tenantPinHolds(provider, claims)) {
    blockers.push(
      "The stored claims do not satisfy the caller provider's current tenant pin (or the pin now uses a claim that was not stored).",
    );
  }
  if (!service.enabled) blockers.push('The service is disabled.');

  // Same grant set and order as the proxy (db/proxy-context.ts): enabled, unexpired, sorted by
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
  invalid_grant: "the grant no longer meets the caller provider's anchor rule (I-AUTHZ-2)",
  condition_failed: 'a condition did not match',
  event_not_trusted: 'event not opted in',
  no_rule: 'no rule allows this method and path',
};

function RequestDetail(props: {
  record: RequestRecord;
  service: Service | null;
  provider: CallerProvider | null;
  grants: Grant[];
  reevaluation: Reevaluation | null;
  canCreateGrant: boolean;
}) {
  const { record: r, service, provider } = props;
  const grantNames = namesById(props.grants);
  const claims = storedClaims(r);
  const trace = storedTrace(r);
  const step = nextStep(r.reason);
  const self = `${SECTION}/${encodeURIComponent(r.id)}`;
  return (
    <>
      <p class="actions">
        <OutcomeBadge outcome={r.outcome} />
        <span>
          HTTP {r.status}
          {r.reason ? (
            <>
              {' · '}
              <Code>{r.reason}</Code> {reasonText(r.reason)}
            </>
          ) : null}
        </span>
      </p>
      {step ? (
        <p class="banner info">
          <b>Next step:</b> {step}
        </p>
      ) : null}
      {props.canCreateGrant ? (
        <p class="actions">
          <a class="button" href={paths.accessNew({ from_request: r.id })}>
            Create grant from this request
          </a>
          <small class="muted">
            Opens the grant form prefilled with this caller's exact IDs. Review it before saving.
          </small>
        </p>
      ) : null}

      <Details
        rows={[
          ['Request ID', <Code>{r.id}</Code>],
          ['Time', formatTime(r.ts)],
          ['Method and path', <Code>{`${r.method} ${r.path}`}</Code>],
          [
            'Service',
            r.service_id && service ? (
              <a href={paths.token(r.service_id)}>
                {service.name} <Code>{service.slug}</Code>
              </a>
            ) : r.service_slug ? (
              <>
                <Code>{r.service_slug}</Code>{' '}
                <span class="muted">
                  {r.service_id ? '(deleted)' : '(no such service when called)'}
                </span>
              </>
            ) : (
              '—'
            ),
          ],
          [
            'Caller provider',
            r.caller_provider_id ? (
              provider ? (
                <a href={paths.consumer(r.caller_provider_id)}>{provider.name}</a>
              ) : (
                <>
                  <Code>{r.caller_provider_id}</Code> <span class="muted">(deleted)</span>
                </>
              )
            ) : (
              '—'
            ),
          ],
          ['Grant that allowed it', <GrantLink id={r.grant_id} names={grantNames} />],
          [
            'Token verified',
            r.claims_verified === 1
              ? 'Yes: signature, issuer, audience and tenant pin were checked.'
              : 'No: the request was refused before the token was trusted, so no caller details were stored.',
          ],
          ['Caller subject (sub)', r.caller_subject ? <Code>{r.caller_subject}</Code> : '—'],
          ['Caller repository', r.caller_repository ?? '—'],
          ['Token ID (jti)', r.jti ? <Code>{r.jti}</Code> : '—'],
          ...(r.untrusted_iss
            ? ([
                [
                  'Issuer (unverified)',
                  <>
                    <Code>{r.untrusted_iss}</Code>{' '}
                    <small class="muted">read from a token that was not trusted</small>
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
          ['Total duration', formatDuration(r.duration_ms)],
          ['Upstream time', formatDuration(r.upstream_ms)],
          ...(r.weight !== 1
            ? ([
                [
                  'Sampling',
                  `This record stands for about ${formatCount(r.weight)} allowed requests.`,
                ],
              ] as Array<[string, Child]>)
            : []),
          ['Client IP', r.ip ?? '—'],
          ['User agent', r.user_agent ?? '—'],
          ['Cloudflare location', r.colo ?? '—'],
        ]}
      />

      <h2>Caller claims</h2>
      {claims && Object.keys(claims).length > 0 ? (
        <>
          <p class="muted">
            Only claims on the caller provider's allowlist are stored; others (and the token itself)
            are never kept.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(claims).map(([name, value]) => (
                <tr>
                  <td>
                    <Code>{name}</Code>
                  </td>
                  <td class="wrap">
                    <Code>{typeof value === 'string' ? value : JSON.stringify(value)}</Code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <EmptyState>
          {r.claims_verified === 1
            ? 'No claims were stored for this request.'
            : 'None: the token was not verified, so its claims were not stored.'}
        </EmptyState>
      )}

      {trace.length > 0 ? (
        <>
          <h2>Policy evaluation at request time</h2>
          <p class="muted">
            Each grant of this caller provider and service, in evaluation order, with the first
            check that failed.
          </p>
          <TraceTable trace={trace} grantNames={grantNames} />
        </>
      ) : null}

      <h2>Check against current grants</h2>
      <ReevaluationSection
        record={r}
        href={withQuery(self, { reevaluate: '1' })}
        result={props.reevaluation}
        grantNames={grantNames}
      />
    </>
  );
}

function TraceTable(props: { trace: TraceItem[]; grantNames: Map<string, string> }) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Grant</th>
          <th scope="col">Result</th>
          <th scope="col">Detail</th>
        </tr>
      </thead>
      <tbody>
        {props.trace.map((item) =>
          'omitted' in item ? (
            <tr>
              <td colspan={3} class="muted">
                {item.omitted} more grant(s) not shown (trace size limit).
              </td>
            </tr>
          ) : (
            <tr>
              <td>
                <GrantLink id={item.grant_id} names={props.grantNames} />
              </td>
              <td>
                <Badge tone={item.result === 'matched' ? 'ok' : 'warn'}>
                  {TRACE_RESULT_TEXT[item.result] ?? item.result}
                </Badge>
              </td>
              <td class="wrap">
                <Code>{item.detail}</Code>
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function ReevaluationSection(props: {
  record: RequestRecord;
  href: string;
  result: Reevaluation | null;
  grantNames: Map<string, string>;
}) {
  if (props.record.claims_verified !== 1) {
    return (
      <EmptyState>Not available: the token was not verified, so no claims were stored.</EmptyState>
    );
  }
  const intro = (
    <p class="muted">
      Runs the policy again with this request's stored claims against the grants as they are now.
      Stored claims subset only: conditions on claims that were not stored fail, so a real token may
      be allowed where this check says denied. Nothing is changed.
    </p>
  );
  const { result } = props;
  if (result === null) {
    return (
      <>
        {intro}
        <p>
          <a class="button" href={props.href}>
            Re-evaluate against current grants
          </a>
        </p>
      </>
    );
  }
  if (!result.ok) {
    return (
      <>
        {intro}
        <Messages errors={[result.message]} />
      </>
    );
  }
  const { decision } = result;
  return (
    <>
      {intro}
      <Messages warnings={result.blockers} />
      {decision.decision === 'allow' ? (
        <p class="banner info" role="status">
          Result (stored claims subset only): <b>allowed</b> by grant{' '}
          <GrantLink id={decision.grant.id} names={props.grantNames} />.
        </p>
      ) : (
        <p class="banner warning" role="status">
          Result (stored claims subset only): <b>denied</b> (<Code>{decision.code}</Code>).{' '}
          {result.grantsChecked === 0
            ? 'No enabled grant exists for this caller provider and service.'
            : `${result.grantsChecked} enabled grant(s) checked.`}
        </p>
      )}
      {decision.trace.length > 0 ? (
        <TraceTable trace={decision.trace} grantNames={props.grantNames} />
      ) : null}
    </>
  );
}
