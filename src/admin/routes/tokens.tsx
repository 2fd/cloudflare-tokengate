// Service tokens (A13): the list with the "Add a token" accordion, the standalone accordion, create,
// the token page and its forms. The destination (base URL + injection) changes only on
// /destination, together with the secret (I-CRED-2); /secret rotates with the stored destination;
// template cards never read the destination from the form (I-SSRF-1). Submitted secrets are never
// rendered back (I-CRED-1): a re-render carries a sealed draft (A13.6).
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { App } from '../../app';
import { upstreamHostAllowed } from '../../config';
import { sealedKid } from '../../crypto/envelope';
import { KID_PATTERN, type KeyringError, loadKeyring } from '../../crypto/keyring';
import { getService, listServices } from '../../db/services';
import { getAllowedUpstreamHosts } from '../../db/settings';
import type { Service } from '../../db/types';
import { normalizeCredential, normalizeInjection, validateBaseUrl } from '../../policy/validate';
import { EXPIRY_WARNING_MS } from '../../telemetry/dashboard';
import { can } from '../auth/rbac';
import { type AccessEdge, loadConnections } from '../connections';
import { type NoticeContext, type NoticeTable, resolveNotice } from '../notice';
import { openCredentialDraft, sealCredentialDraft } from '../ops/credential-draft';
import {
  checkServiceCreate,
  checkServiceCredential,
  createService,
  deleteService,
  destinationFingerprint,
  freeName,
  freeSlug,
  lastSecretChange,
  opContextFor,
  rotateServiceSecret,
  rotationSiblings,
  type ServiceCreateInput,
  serviceFieldErrors,
  setServiceCredential,
  slugBaseFor,
  storedBinding,
  testServiceCredential,
  updateServiceFields,
} from '../ops/services';
import { type FieldError, fieldError, type OpFailure, type OpFailureReason } from '../ops/shared';
import { addUpstreamHost, storedHostOutside, storedUpstreamHost } from '../ops/upstream-hosts';
import type { VerifyOutcome } from '../ops/verify';
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
import {
  getServiceTemplate,
  type ServiceTemplate,
  secretFromTemplateInput,
  templateForService,
  templateIdFor,
} from '../service-templates';
import {
  type Alert,
  AlertList,
  AskSomeone,
  type ChipProps,
  ChipList,
  DataTable,
  EmptyState,
  FilterChips,
  NotFound,
  Select,
  StatusBadge,
  Time,
} from '../views/components';
import { docsUrl } from '../views/docs';
import { type CardsData, CUSTOM, type FailedCard, TokenTypeCards } from '../views/token-cards';
import {
  dateInput,
  draftHint,
  EXPIRY_FORMAT_ERROR,
  type FormState,
  flag,
  forwardHeadersFromValues,
  inSentence,
  injectionFromValues,
  parseDateInput,
  summaryErrors,
  type TokenFormValues,
  text,
  texts,
  timeoutFromValues,
  valuesFromForm,
  verifyFromValues,
} from '../views/token-forms';
import {
  type BindingState,
  LastUsed,
  SecretBadge,
  TokenPage,
  type TokenPageData,
  type TokenPageState,
  type TokenAlso,
  typeLabel,
  upstreamHost,
} from '../views/token-page';

const FAILURE_STATUS: Record<OpFailureReason, ContentfulStatusCode> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  acknowledgement_required: 422,
  confirmation_required: 422,
  verify_failed: 422,
  unavailable: 503,
};

/** Fields a template card posts; an op error about any other field belongs to the whole form. */
const TEMPLATE_CARD_FIELDS = new Set([
  'credential',
  'credential_draft',
  'slug',
  'name',
  'description',
  'credential_expires_at',
  'allow_host',
  'also_uploads',
]);

const STATUS_FILTERS = [
  'credential_unreadable',
  'expiring',
  'no_credential',
  'outside_hosts',
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_FILTER_LABELS: Readonly<Record<StatusFilter, string>> = {
  credential_unreadable: 'Secret does not open',
  expiring: 'Secret expired or expiring',
  no_credential: 'No secret',
  outside_hosts: 'Not an allowed host',
};

export function registerTokensRoutes(app: App): void {
  app.get('/admin/tokens', listPage);
  // Registered before `/admin/tokens/:id` so "new" is never taken as an id.
  app.get('/admin/tokens/new', newPage);
  app.post('/admin/tokens', create);
  app.get('/admin/tokens/:id', detailPage);
  app.post('/admin/tokens/:id', update);
  app.post('/admin/tokens/:id/secret', rotate);
  app.post('/admin/tokens/:id/destination', changeDestination);
  app.post('/admin/tokens/:id/test', testSecret);
  app.post('/admin/tokens/:id/toggle', toggle);
  app.post('/admin/tokens/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Notices

interface TokenNoticeData {
  service: Service | null;
  also: string | null;
}

const UPLOADS_HOST = 'uploads.github.com';

/** " api.github.com was added to Allowed hosts." for the `also` codes of a host added on the way. */
function hostsAddedText(data: TokenNoticeData): string {
  if (!data.service) return '';
  const own = upstreamHost(data.service.base_url);
  if (data.also === 'host_added') return ` ${own} was added to Allowed hosts.`;
  if (data.also === 'uploads_host_added') return ` ${UPLOADS_HOST} was added to Allowed hosts.`;
  if (data.also === 'hosts_added') {
    return ` ${own} and ${UPLOADS_HOST} were added to Allowed hosts.`;
  }
  return '';
}

const createdText = (data: TokenNoticeData, check: string) =>
  `${data.service?.name ?? 'Token'} created (slug ${data.service?.slug ?? '?'})${check}.${hostsAddedText(
    data,
  )} No consumer can use it until someone gives access.`;

const TOKEN_NOTICES: NoticeTable<NoticeContext & TokenNoticeData> = {
  created_verified: (ctx) => ({
    text: createdText(ctx, '; the secret check passed'),
    ...giveAccessNext(ctx),
  }),
  created_unverified: (ctx) => ({
    text: createdText(ctx, '. The secret was saved although its check failed'),
    ...giveAccessNext(ctx),
  }),
  created: (ctx) => ({ text: createdText(ctx, ''), ...giveAccessNext(ctx) }),
  updated: () => ({ text: 'Changes saved.' }),
  unchanged: () => ({ text: 'Nothing changed: the submitted values are the current ones.' }),
  secret_verified: (ctx) => ({
    text: `Secret replaced; the check against the upstream passed.${siblingText(ctx)}`,
  }),
  secret_unverified: (ctx) => ({
    text: `Secret replaced although its check failed.${siblingText(ctx)}`,
  }),
  secret_saved: (ctx) => ({ text: `Secret replaced.${siblingText(ctx)}` }),
  destination_changed: (ctx) => ({
    text: `Destination saved with the new secret.${ctx.also === 'host_added' ? hostsAddedText(ctx) : ''}`,
  }),
  enabled: () => ({ text: 'Token enabled. Consumers with access can use it again.' }),
  disabled: (ctx) => ({
    text: 'Token disabled. Requests through it are refused from now on.',
    ...(ctx.service && !ctx.service.enabled && ctx.view.can('tokens:write')
      ? {
          undo: {
            action: `${paths.token(ctx.service.id)}/toggle`,
            fields: { enabled: '1', _return: 'detail' },
            label: 'Enable again',
          },
        }
      : {}),
  }),
};

/** A rotate whose sibling replacement failed: the main token was replaced, a sibling was not. */
function siblingText(ctx: TokenNoticeData): string {
  return ctx.also === 'sibling_failed'
    ? ' It was not replaced in every other token that held the same secret: replace it there too.'
    : '';
}

function giveAccessNext(ctx: NoticeContext & TokenNoticeData) {
  return ctx.service && ctx.view.can('access:write')
    ? {
        next: { href: paths.accessNew({ token: ctx.service.id }), label: 'Give a consumer access' },
      }
    : {};
}

const LIST_NOTICES: NoticeTable = {
  deleted: () => ({ text: 'Token deleted.' }),
  deleted_with_accesses: () => ({ text: 'Token and its consumer access deleted.' }),
  enabled: () => ({ text: 'Token enabled. Consumers with access can use it again.' }),
  disabled: () => ({ text: 'Token disabled. Requests through it are refused from now on.' }),
};

const ALSO_KEYS: ReadonlySet<string> = new Set<TokenAlso>([
  'host_added',
  'uploads_host_added',
  'hosts_added',
  'pair_failed',
  'pair_failed_hosts',
  'pair_failed_conflict',
  'pair_failed_check',
  'sibling_failed',
]);

function alsoParam(c: AdminContext): TokenAlso | null {
  const raw = c.req.query('also');
  return raw !== undefined && ALSO_KEYS.has(raw) ? (raw as TokenAlso) : null;
}

// ---------------------------------------------------------------------------------------------
// Shared loading

function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function cardsData(c: AdminContext, tokens?: Service[]): Promise<CardsData> {
  const deps = c.get('deps');
  const [list, allowlist, keyring] = await Promise.all([
    tokens ? Promise.resolve(tokens) : listServices(deps.env.DB),
    getAllowedUpstreamHosts(deps.env.DB),
    loadKeyring(deps.env),
  ]);
  return {
    tokens: list,
    allowlist,
    keyringError: keyring.ok ? null : keyring.error,
    proxyOrigin: new URL(c.req.url).origin,
    today: todayUtc(deps.now()),
  };
}

const notFound = (c: AdminContext) =>
  renderPage(
    c,
    {
      title: 'Token not found',
      section: 'tokens',
      subsection: 'tokens',
      status: 404,
      breadcrumbs: [{ href: paths.tokens(), label: 'Service tokens' }],
    },
    () => <NotFound what="token" />,
  );

/** The op's errors as UI copy (A7.3), with `secretLabel` naming the secret ("API key"). */
function failureErrors(failure: OpFailure, secretLabel = 'secret'): FieldError[] {
  return (failure.fieldErrors ?? serviceFieldErrors(failure.errors)).map((error) =>
    uiCopy(error, secretLabel),
  );
}

const BASE_URL_EXAMPLE = 'like https://api.example.com/v1';

/**
 * Op messages ("injection: header name must be …", "credential check failed: …") rewritten to name
 * the field's label and say how to fix it (A7.3). Unknown messages keep their text, capitalized.
 * The confirm-destination text stays as the op wrote it (I-CRED-2).
 */
function uiCopy(error: FieldError, secretLabel: string): FieldError {
  if (error.field === 'confirm_destination') return error;
  const label = inSentence(secretLabel);
  const m = error.message;
  const rules: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
    [
      /^credential check failed: (.*)$/s,
      (match) =>
        `The check of the ${label} failed (${match[1]}). Check the ${label}, or choose Save without a passing check`,
    ],
    [/^credential (is empty|is required)$/, () => `Enter the ${label}`],
    [
      /^credential must be printable ASCII/,
      () => `Paste the ${label} without spaces, line breaks or control characters`,
    ],
    [
      /^credential is longer than (\d+) characters$/,
      (match) => `Paste only the ${label}: it is longer than ${match[1]} characters`,
    ],
    [
      /^credential without a configured username/,
      () =>
        `Enter the ${label} as username:password, like apikey:XXXXXXXX, or set a username under How the secret is sent`,
    ],
    [
      /^credential for path injection/,
      () =>
        `Enter the ${label} as the path segments after the base URL, like T000/B000/XXXX (letters, digits and - . _ ~ ! $ & ' ( ) * + , = : @; no empty or dot segments)`,
    ],
    [
      /^injection: header name must be a lower-case HTTP token/,
      () => 'Enter the header name in lower case, like x-api-key (at most 64 characters)',
    ],
    [
      /^injection: header name "(.+)" is reserved$/,
      (match) => `Header name "${match[1]}" is reserved: enter another one, like x-api-key`,
    ],
    [
      /^injection: query parameter must be/,
      () =>
        'Enter the query parameter name with 1-64 letters, digits and . _ ~ - only, like api_key',
    ],
    [/^injection: username must not contain ":"$/, () => 'Enter the username without ":"'],
    [/^injection: kind must be one of/, () => 'Choose how the secret is sent'],
    [/^base URL is required$/, () => `Enter the base URL, ${BASE_URL_EXAMPLE}`],
    [
      /^base URL (must start with https:\/\/|must use https)$/,
      () => `Enter a base URL that starts with https://, ${BASE_URL_EXAMPLE}`,
    ],
    [
      /^base URL must not contain a query string$/,
      () => 'Remove the query string (?…) from the base URL',
    ],
    [
      /^slug must be 1-63 characters/,
      () =>
        'Enter a slug of 1-63 lower-case letters, digits and dashes, starting with a letter or digit, like slack',
    ],
  ];
  for (const [pattern, copy] of rules) {
    const match = pattern.exec(m);
    if (match) return { field: error.field, message: copy(match) };
  }
  const text = m
    .replace(/^injection: /, '')
    .replace(/^credential /, `${secretLabel} `)
    .replace(/^verify /, 'check ')
    .replace(/^forward header/, 'extra header');
  return { field: error.field, message: `${text.charAt(0).toUpperCase()}${text.slice(1)}` };
}

// ---------------------------------------------------------------------------------------------
// Secrets and drafts

interface ResolvedSecret {
  /** The secret to send to the op, or null with `error`. */
  secret: string | null;
  /** Typed in this request (only fresh plaintext is ever sealed into a draft). */
  fresh: boolean;
  /** The draft string this request used, echoed unchanged so it is never renewed. */
  usedDraft: string | null;
  error: FieldError | null;
  /** The template the pasted value seems to belong to (wrong-type guard). */
  likely: string | null;
}

interface SecretTarget {
  template: ServiceTemplate | null;
  label: string;
  /** As submitted or stored; only normalized here to bind a draft. */
  baseUrl: string;
  injection: unknown;
  /** `new`, or the service id. */
  target: string;
}

/** The draft binding of the viewer and destination, or null when the destination is invalid. */
function draftContext(c: AdminContext, target: SecretTarget) {
  const base = validateBaseUrl(target.baseUrl, { gatewayHosts: [], allowedUpstreamHosts: null });
  const injection = normalizeInjection(target.injection);
  if (!base.ok || !injection.ok) return null;
  const authority = adminActor(c).authority;
  return {
    context: {
      userId: authority.userId,
      loginProvider: authority.loginProvider,
      subject: authority.subject,
      target: target.target,
      baseUrl: base.normalized,
      injectionJson: injection.json,
    },
    injection: injection.injection,
  };
}

/**
 * The secret of a form: a typed value wins (through the wrong-type guard), else the sealed draft
 * of an earlier re-render, else an error at the field.
 */
async function resolveSecret(
  c: AdminContext,
  form: Awaited<ReturnType<typeof formData>>,
  target: SecretTarget,
): Promise<ResolvedSecret> {
  const raw = text(form, 'credential');
  const draft = text(form, 'credential_draft');
  const none = { fresh: false, usedDraft: null, likely: null };
  if (raw.trim() !== '') {
    if (target.template) {
      const guarded = secretFromTemplateInput(target.template, raw);
      return guarded.ok
        ? { ...none, secret: guarded.secret, fresh: true, error: null }
        : {
            ...none,
            secret: null,
            error: fieldError('credential', guarded.error),
            likely: guarded.likely,
          };
    }
    const kind = (target.injection as { kind?: unknown } | null)?.kind;
    if (kind !== 'path' && /^https?:\/\//i.test(raw.trim())) {
      return {
        ...none,
        secret: null,
        error: fieldError(
          'credential',
          'This is a URL, not a secret. Paste the API key or token itself; for a webhook URL choose URL path as how the secret is sent',
        ),
      };
    }
    return { ...none, secret: raw, fresh: true, error: null };
  }
  if (draft !== '') {
    const bound = draftContext(c, target);
    if (!bound) {
      return {
        ...none,
        secret: null,
        error: fieldError(
          'credential',
          `Enter the ${inSentence(target.label)} again: the destination changed`,
        ),
      };
    }
    const opened = await openCredentialDraft(c.get('deps'), bound.context, draft);
    if (opened.ok) return { ...none, secret: opened.credential, usedDraft: draft, error: null };
    return {
      ...none,
      secret: null,
      error: fieldError(
        'credential',
        opened.reason === 'mismatch'
          ? `Enter the ${inSentence(target.label)} again: the destination changed`
          : `Enter the ${inSentence(target.label)} again`,
      ),
    };
  }
  return {
    ...none,
    secret: null,
    error: fieldError('credential', `Enter the ${inSentence(target.label)}`),
  };
}

/**
 * The draft for a re-render (A13.6): the same string when the request used one; a new one only for
 * a fresh secret that passes the local format check, bound to the destination of this form.
 */
async function draftFor(
  c: AdminContext,
  resolved: ResolvedSecret,
  target: SecretTarget,
): Promise<FormState['draft']> {
  if (resolved.secret === null) return null;
  const bound = draftContext(c, target);
  if (!bound) return null;
  const normalized = normalizeCredential(resolved.secret, bound.injection);
  if (!normalized.ok) return null;
  if (resolved.usedDraft !== null) {
    return { value: resolved.usedDraft, hint: draftHint(normalized.hint) };
  }
  if (!resolved.fresh) return null;
  const sealed = await sealCredentialDraft(c.get('deps'), bound.context, normalized.value);
  return sealed === null ? null : { value: sealed, hint: draftHint(normalized.hint) };
}

// ---------------------------------------------------------------------------------------------
// List

async function listPage(c: AdminContext) {
  const deps = c.get('deps');
  const now = deps.now();
  const [connections, cards] = await Promise.all([loadConnections(deps), cardsData(c)]);
  const tokens = [...connections.tokens].sort((a, b) => a.name.localeCompare(b.name));
  const rawStatus = c.req.query('status');
  const status = STATUS_FILTERS.find((value) => value === rawStatus) ?? null;
  const usedKids = new Set(
    tokens.map((token) => sealedKid(token.credential_sealed)).filter(Boolean),
  );
  const rawKey = c.req.query('key');
  const key =
    rawKey !== undefined && KID_PATTERN.test(rawKey) && usedKids.has(rawKey) ? rawKey : null;
  const allowlist = cards.allowlist;
  const facts = (token: Service) => {
    const unreadable = cards.keyringError !== null || connections.unreadableTokenIds.has(token.id);
    // A stored base URL that does not parse (written straight into D1) fails closed as outside.
    const outside = storedHostOutside(token.base_url, allowlist);
    return { unreadable, outside };
  };
  const matches = (token: Service) => {
    const { unreadable, outside } = facts(token);
    if (key !== null && sealedKid(token.credential_sealed) !== key) return false;
    if (status === 'credential_unreadable') return token.credential_sealed !== null && unreadable;
    if (status === 'no_credential') return token.credential_sealed === null;
    if (status === 'outside_hosts') return outside;
    if (status === 'expiring') {
      return (
        token.credential_sealed !== null &&
        token.credential_expires_at !== null &&
        token.credential_expires_at - now <= EXPIRY_WARNING_MS
      );
    }
    return true;
  };
  const rows = tokens.filter(matches);
  const byToken = new Map<string, AccessEdge[]>();
  for (const edge of connections.accesses) {
    const list = byToken.get(edge.grant.service_id) ?? [];
    list.push(edge);
    byToken.set(edge.grant.service_id, list);
  }
  const done = null;
  // `?open=add` opens the accordion (A7.1); a bare `#add` fragment never reaches the server.
  // Deviation from A13.1: paths.tokens (WP0) has no `open` option yet, so a link built with
  // `hash: 'add'` alone leaves it closed once tokens exist. WP5 item: add `open?: 'add'`.
  const openAdd = c.req.query('open') === 'add';
  return renderPage(
    c,
    {
      title: 'Service tokens',
      section: 'tokens',
      subsection: 'tokens',
      notice: resolveNotice(LIST_NOTICES, c.req.query('notice'), done),
    },
    (ctx) => {
      const canWrite = ctx.can('tokens:write');
      const empty = tokens.length === 0;
      const filters = [
        ...(status
          ? [
              {
                label: STATUS_FILTER_LABELS[status],
                removeHref: paths.tokens({ key: key ?? undefined }),
              },
            ]
          : []),
        ...(key
          ? [{ label: `Key ${key}`, removeHref: paths.tokens({ status: status ?? undefined }) }]
          : []),
      ];
      return (
        <>
          <p class="lead">
            Secrets of the upstream APIs the gateway can call for consumers. Loading a token gives
            nobody access; <a href={docsUrl('concepts.md#grant')}>consumer access</a> is granted
            separately.
          </p>
          <ListAlerts ctx={ctx} tokens={tokens} facts={facts} keyringError={cards.keyringError} />
          {canWrite ? (
            <details id="add" class="add-token" open={empty || openAdd}>
              <summary>{empty ? 'Add your first token' : 'Add a token'}</summary>
              <TokenTypeCards ctx={ctx} data={cards} open={null} failed={null} />
            </details>
          ) : empty ? (
            <EmptyState action={<AskSomeone permission="tokens:write" ctx={ctx} verb="add one" />}>
              No service tokens yet.
            </EmptyState>
          ) : (
            <AskSomeone permission="tokens:write" ctx={ctx} verb="add a token" />
          )}
          {tokens.length > 10 ? (
            <form
              method="get"
              action={paths.tokens()}
              class="filters"
              aria-label="Filter service tokens"
            >
              {key ? <input type="hidden" name="key" value={key} /> : null}
              <Select
                name="status"
                label="Show"
                value={status}
                options={[
                  { value: '', label: 'All tokens' },
                  ...STATUS_FILTERS.map((value) => ({ value, label: STATUS_FILTER_LABELS[value] })),
                ]}
              />
              <button type="submit" class="secondary">
                Filter
              </button>
            </form>
          ) : null}
          <FilterChips items={filters} clearHref={paths.tokens()} />
          {empty ? null : (
            <DataTable
              id="tokens"
              caption={`Service tokens (${rows.length})`}
              rowHeader="token"
              rows={rows}
              empty={<p>No token matches these filters.</p>}
              columns={[
                {
                  key: 'token',
                  header: 'Token',
                  render: (token) => (
                    <>
                      <a href={paths.token(token.id)}>{token.name}</a> <code>{token.slug}</code>
                      <br />
                      <span class="muted">{typeLabel(templateForService(token))}</span>
                    </>
                  ),
                },
                {
                  key: 'upstream',
                  header: 'Upstream',
                  render: (token) => (
                    <>
                      {upstreamHost(token.base_url)}
                      {facts(token).outside ? (
                        <>
                          {' '}
                          <StatusBadge status="outside_hosts" />
                        </>
                      ) : null}
                    </>
                  ),
                },
                {
                  key: 'secret',
                  header: 'Secret',
                  render: (token) => (
                    <>
                      <SecretBadge service={token} unreadable={facts(token).unreadable} now={now} />
                      {token.credential_expires_at !== null ? (
                        <>
                          <br />
                          <span class="muted">
                            expires <Time ms={token.credential_expires_at} />
                          </span>
                        </>
                      ) : null}
                    </>
                  ),
                },
                {
                  key: 'used',
                  header: 'Used by',
                  render: (token) => <UsedBy token={token} edges={byToken.get(token.id) ?? []} />,
                },
                {
                  key: 'last',
                  header: 'Last used',
                  render: (token) => (
                    <LastUsed
                      hour={lastUsedHour(byToken.get(token.id) ?? [])}
                      now={now}
                      usageAvailable={connections.usageAvailable}
                      sampleRate={connections.sampleRate}
                    />
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (token) => <StatusBadge status={token.enabled ? 'active' : 'disabled'} />,
                },
              ]}
            />
          )}
        </>
      );
    },
  );
}

function lastUsedHour(edges: readonly AccessEdge[]): number | null {
  const hours = edges
    .map((edge) => edge.lastUsedHour)
    .filter((hour): hour is number => hour !== null);
  return hours.length > 0 ? Math.max(...hours) : null;
}

function UsedBy(props: { token: Service; edges: AccessEdge[] }) {
  if (props.edges.length === 0) return <span class="muted">0 consumers</span>;
  const items: ChipProps[] = props.edges.map((edge) => {
    const consumer = edge.consumer?.name ?? 'deleted consumer';
    return {
      href: paths.accessItem(edge.grant.id),
      text: `${consumer} · ${edge.subject} · ${edge.context}`,
      status: edge.status,
      ...(edge.statusDetail ? { statusDetail: edge.statusDetail } : {}),
      // The accessible name starts with the visible text (WCAG 2.5.3).
      srText: `${consumer} · ${edge.subject} · ${edge.context}: can use ${props.token.name}, ${edge.statusDetail ?? edge.status}`,
    };
  });
  return (
    <ChipList
      label={`Consumers that can use ${props.token.name}`}
      items={items}
      max={3}
      moreHref={paths.access({ token: props.token.id })}
      moreText={`+${items.length - 3} more`}
    />
  );
}

function ListAlerts(props: {
  ctx: ViewContext;
  tokens: Service[];
  facts: (token: Service) => { unreadable: boolean; outside: boolean };
  keyringError: KeyringError | null;
}) {
  const { ctx, tokens, facts } = props;
  const now = ctx.now;
  const link = (hash: 'secret' | 'destination') => (token: Service) => ({
    href:
      hash === 'destination'
        ? paths.token(token.id, { open: 'destination', hash })
        : paths.token(token.id, { hash }),
    label: token.name,
  });
  const alerts: Alert[] = [];
  if (props.keyringError !== null) {
    alerts.push({
      code: 'keyring_unavailable',
      level: 'error',
      title: 'Encryption keys are not loaded: no secret can be used or changed.',
      detail: '',
      objects: [{ href: paths.tokenKeys(), label: 'Encryption keys' }],
    });
  }
  const unreadable =
    props.keyringError === null
      ? tokens.filter((token) => token.credential_sealed !== null && facts(token).unreadable)
      : [];
  if (unreadable.length > 0) {
    alerts.push({
      code: 'credential_malformed',
      level: 'error',
      title: `${unreadable.length === 1 ? '1 secret does' : `${unreadable.length} secrets do`} not open.`,
      detail: 'Set them again under Change destination.',
      objects: unreadable.map(link('destination')),
    });
  }
  const missing = tokens.filter((token) => token.credential_sealed === null);
  if (missing.length > 0) {
    alerts.push({
      code: 'credential_missing_used',
      level: 'error',
      title: `${missing.length === 1 ? '1 token has' : `${missing.length} tokens have`} no secret.`,
      detail: 'Set it under Destination; you will be asked to confirm the host.',
      objects: missing.map(link('destination')),
    });
  }
  const unparsed = tokens.filter((token) => storedUpstreamHost(token.base_url) === null);
  if (unparsed.length > 0) {
    alerts.push({
      code: 'config_problem',
      level: 'error',
      title: `${unparsed.length === 1 ? '1 token has a base URL' : `${unparsed.length} tokens have base URLs`} that cannot be read, so requests through ${unparsed.length === 1 ? 'it' : 'them'} are refused.`,
      detail: 'Set the destination again under Change destination.',
      objects: unparsed.map(link('destination')),
    });
  }
  const outside = tokens.filter(
    (token) => facts(token).outside && storedUpstreamHost(token.base_url) !== null,
  );
  if (outside.length > 0) {
    alerts.push({
      code: 'outside_hosts',
      level: 'error',
      title: `${outside.length === 1 ? '1 token points' : `${outside.length} tokens point`} at a host that is not allowed, so requests through ${outside.length === 1 ? 'it' : 'them'} are refused.`,
      detail: '',
      objects: outside.map((token) => ({ href: paths.token(token.id), label: token.name })),
      fix: { href: paths.tokenHosts(), label: 'Open allowed hosts', permission: 'settings:write' },
    });
  }
  const sealed = tokens.filter(
    (token) => token.credential_sealed !== null && token.credential_expires_at !== null,
  );
  const expired = sealed.filter((token) => (token.credential_expires_at ?? 0) <= now);
  const expiring = sealed.filter((token) => {
    const at = token.credential_expires_at ?? 0;
    return at > now && at - now <= EXPIRY_WARNING_MS;
  });
  if (expired.length > 0) {
    alerts.push({
      code: 'credential_expired',
      level: 'error',
      title: `${expired.length === 1 ? '1 secret has' : `${expired.length} secrets have`} expired.`,
      detail: 'Replace them on the token page.',
      objects: expired.map(link('secret')),
    });
  }
  if (expiring.length > 0) {
    alerts.push({
      code: 'credential_expiring',
      level: 'warning',
      title: `${expiring.length === 1 ? '1 secret expires' : `${expiring.length} secrets expire`} within 14 days.`,
      detail: 'Replace them before then.',
      objects: expiring.map(link('secret')),
    });
  }
  if (alerts.length === 0) return null;
  return (
    <section aria-labelledby="attention-h">
      <h2 id="attention-h">Needs attention</h2>
      <AlertList alerts={alerts} ctx={ctx} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Create

async function newPage(c: AdminContext) {
  const raw = c.req.query('template') ?? '';
  const open = raw === CUSTOM || getServiceTemplate(raw) ? raw : null;
  return renderNew(c, { open, failed: null, errors: [] });
}

async function renderNew(
  c: AdminContext,
  o: {
    open: string | null;
    failed: FailedCard | null;
    errors: FieldError[];
    status?: ContentfulStatusCode;
  },
) {
  const cards = await cardsData(c);
  return renderPage(
    c,
    {
      title: 'Add a service token',
      section: 'tokens',
      subsection: 'tokens',
      breadcrumbs: [
        { href: paths.tokens(), label: 'Service tokens' },
        { href: paths.tokenNew(), label: 'Add a token' },
      ],
      errors: o.errors,
      status: o.status,
    },
    (ctx) => (
      <>
        <TokenTypeCards ctx={ctx} data={cards} open={o.open} failed={o.failed} />
        <p>
          <a href={paths.tokens()}>Cancel</a>
        </p>
      </>
    ),
  );
}

async function create(c: AdminContext) {
  const deps = c.get('deps');
  const db = deps.env.DB;
  const form = await formData(c);
  const values = valuesFromForm(form);
  const template = getServiceTemplate(values.template);
  if (!template && values.template !== CUSTOM) {
    return renderNew(c, {
      open: null,
      failed: null,
      errors: [fieldError(null, 'Choose which API the token unlocks')],
      status: 400,
    });
  }
  const card = template?.id ?? CUSTOM;
  const context = opContextFor(new URL(c.req.url));
  // Template cards never read the destination, headers, timeout or check from the form (I-SSRF-1).
  const destination = template
    ? {
        base_url: template.base_url,
        injection: template.injection,
        forward_headers: [...template.forward_headers],
        timeout_ms: template.timeout_ms,
        verify: template.verify,
      }
    : {
        base_url: values.base_url.trim(),
        injection: injectionFromValues(values),
        forward_headers: forwardHeadersFromValues(values),
        timeout_ms: timeoutFromValues(values),
        verify: verifyFromValues(values),
      };
  const target: SecretTarget = {
    template,
    label: template?.secret.label ?? 'secret',
    baseUrl: destination.base_url,
    injection: destination.injection,
    target: 'new',
  };
  // 1. Field formats and the secret format (A7.4).
  const errors: FieldError[] = [];
  const expiry = template?.expiry_from_check
    ? ({ ok: true, value: null } as const)
    : parseDateInput(values.credential_expires_at);
  if (!expiry.ok) errors.push(fieldError('credential_expires_at', EXPIRY_FORMAT_ERROR));
  const secret = await resolveSecret(c, form, target);
  if (secret.error) errors.push(secret.error);

  // 3. The allowlist, after an owner's allow_host. A template card may allow its own host and, on
  // the GitHub card, uploads.github.com for the uploads token (that box is also_uploads for an
  // owner whose allowlist blocks it).
  const allowlist = await getAllowedUpstreamHosts(db);
  const host = hostOf(destination.base_url);
  const covered = host === null || upstreamHostAllowed(host, allowlist);
  const canAllow = can(c.get('viewer').user.role, 'settings:write');
  const allowValues = texts(form, 'allow_host').filter((value) => value !== '');
  const uploads = template?.id === 'github' ? getServiceTemplate('github-uploads') : null;
  const uploadsHost = uploads ? hostOf(uploads.base_url) : null;
  const uploadsAllowRequested = uploadsHost !== null && allowValues.includes(uploadsHost);
  const alsoUploads = uploads !== null && (values.also_uploads || uploadsAllowRequested);
  const uploadsCovered = uploadsHost === null || upstreamHostAllowed(uploadsHost, allowlist);
  const allowRequested = template
    ? host !== null && allowValues.includes(host)
    : allowValues.length > 0;
  // A template card's box names the host it allows; another value is a stale form.
  const stale = template
    ? allowValues.filter((value) => value !== host && value !== uploadsHost)
    : [];
  const hostErrors: FieldError[] = [];
  if (!covered && stale.length > 0) {
    hostErrors.push(fieldError('allow_host', 'Check the box again: the host it allows changed'));
  } else if (!covered && !allowRequested) {
    hostErrors.push(
      fieldError(
        template ? 'allow_host' : 'base_url',
        `${host} is not an allowed host. ${
          canAllow
            ? `Tick "Also allow" to add it to Allowed hosts, ${template ? 'or choose another type' : 'or use another base URL'}`
            : 'Ask an owner to allow it, or use an allowed host'
        }`,
      ),
    );
  }
  if (alsoUploads && !uploadsCovered && !uploadsAllowRequested) {
    hostErrors.push(
      fieldError(
        'also_uploads',
        `${uploadsHost} is not an allowed host, so the uploads token cannot be added. ${
          canAllow
            ? 'Tick the uploads box again: it now also allows the host'
            : 'Untick the box, or ask an owner to allow it'
        }`,
      ),
    );
  }
  const allowHost = !covered && allowRequested && host !== null;
  const allowUploadsHost = alsoUploads && !uploadsCovered && uploadsAllowRequested;
  // A re-render ticks each box again as submitted (`allow_host` may hold both hosts).
  values.also_uploads = alsoUploads;
  if (template) values.allow_host = allowRequested && host !== null ? host : '';

  const fail = async (
    failure: FieldError[],
    status: ContentfulStatusCode,
    verify: VerifyOutcome | null = null,
  ) => {
    const scoped = template
      ? failure.map((error) =>
          error.field !== null && !TEMPLATE_CARD_FIELDS.has(error.field)
            ? fieldError(null, error.message)
            : error,
        )
      : failure;
    const draft = await draftFor(c, secret, target);
    const state: FormState = { values, errors: scoped, draft, verify };
    return renderNew(c, {
      open: card,
      failed: { template: card, state, likely: secret.likely },
      errors: summaryErrors(card, scoped),
      status,
    });
  };
  const slugBase = template ? template.slug : slugBaseFor(destination.base_url);
  const slug = values.slug.trim() === '' ? await freeSlug(db, slugBase) : values.slug.trim();
  const name =
    values.name.trim() === ''
      ? await freeName(db, template ? template.name : slug)
      : values.name.trim();
  const input: ServiceCreateInput = {
    slug,
    name,
    description: values.description,
    ...destination,
    credential_expires_at: expiry.ok ? expiry.value : null,
    secret: secret.secret,
    save_anyway: flag(form, 'save_anyway'),
  };
  // 1-2. The op's formats and the slug pre-check (SELECTs only), reported together with the
  // route's errors and the allowlist (step 3) in one re-render. The route checks the allowlist
  // itself, so the op skips it; createService enforces it again.
  const checked = await checkServiceCreate(deps, input, context, { hostAllowed: true });
  const all = [
    ...errors,
    ...(!checked.ok && checked.reason !== 'unavailable'
      ? failureErrors(checked, target.label)
      : []),
    ...hostErrors,
  ];
  if (all.length > 0) {
    const onlyOp = errors.length === 0 && hostErrors.length === 0 && !checked.ok;
    return fail(all, onlyOp ? FAILURE_STATUS[checked.reason] : 400);
  }
  // 4. The keyring.
  if (!checked.ok)
    return fail(failureErrors(checked, target.label), FAILURE_STATUS[checked.reason]);

  // Everything that sends nothing has passed; only now the hosts are added, each its own op.
  const actor = adminActor(c);
  const added: string[] = [];
  for (const [allow, value] of [
    [allowHost, host],
    [allowUploadsHost, uploadsHost],
  ] as const) {
    if (!allow || value === null) continue;
    const result = await addUpstreamHost(deps, actor, value);
    if (!result.ok) return fail(failureErrors(result, target.label), FAILURE_STATUS[result.reason]);
    if (result.changed) added.push(value);
  }
  const result = await createService(deps, actor, input, context);
  if (!result.ok) {
    const failure = failureErrors(result, target.label);
    return fail(
      added.length > 0
        ? [
            fieldError(
              null,
              `${added.join(' and ')} ${added.length === 1 ? 'was' : 'were'} added to Allowed hosts; the token was not saved:`,
            ),
            ...failure,
          ]
        : failure,
      FAILURE_STATUS[result.reason],
      result.verify ?? null,
    );
  }

  let pairFailure: TokenAlso | null = null;
  if (alsoUploads && uploads) {
    const pair = await createService(
      deps,
      actor,
      {
        slug: await freeSlug(db, uploads.slug),
        name: await freeName(db, uploads.name),
        description: values.description,
        base_url: uploads.base_url,
        injection: uploads.injection,
        forward_headers: [...uploads.forward_headers],
        timeout_ms: uploads.timeout_ms,
        verify: uploads.verify,
        credential_expires_at: result.service.credential_expires_at,
        secret: secret.secret,
        save_anyway: input.save_anyway,
      },
      context,
    );
    if (!pair.ok) pairFailure = pairFailureAlso(pair);
  }
  const notice =
    result.verify === null
      ? 'created'
      : result.verify.passed
        ? 'created_verified'
        : 'created_unverified';
  const hostsAlso: TokenAlso | undefined =
    added.length === 2
      ? 'hosts_added'
      : added[0] === uploadsHost && uploadsHost !== null
        ? 'uploads_host_added'
        : added.length === 1
          ? 'host_added'
          : undefined;
  return redirectWithNotice(c, paths.token(result.service.id), notice, {
    also: pairFailure ?? hostsAlso,
  });
}

/** Why the uploads token of a GitHub create failed, as a closed `also` code (no free text in URLs). */
function pairFailureAlso(failure: OpFailure): TokenAlso {
  if (failure.errors.some((error) => error.startsWith('base URL'))) return 'pair_failed_hosts';
  if (failure.reason === 'conflict') return 'pair_failed_conflict';
  if (failure.reason === 'verify_failed') return 'pair_failed_check';
  return 'pair_failed';
}

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Token page

async function loadPage(c: AdminContext, service: Service): Promise<TokenPageData> {
  const deps = c.get('deps');
  const [connections, allowlist, keyring, lastSet, tokens] = await Promise.all([
    loadConnections(deps, { tokenId: service.id }),
    getAllowedUpstreamHosts(deps.env.DB),
    loadKeyring(deps.env),
    lastSecretChange(deps.env.DB, service.id),
    listServices(deps.env.DB),
  ]);
  const binding: BindingState = keyring.ok
    ? await storedBinding(deps.env.DB, keyring.keyring, service)
    : { status: 'unknown' };
  const siblings = binding.status === 'attested' ? await rotationSiblings(deps, service) : [];
  return {
    service,
    template: templateForService(service),
    binding,
    keyringError: keyring.ok ? null : keyring.error,
    allowlist,
    outside: storedHostOutside(service.base_url, allowlist),
    accesses: connections.accesses,
    usageAvailable: connections.usageAvailable,
    sampleRate: connections.sampleRate,
    lastSet,
    siblings,
    destinationFingerprint: await destinationFingerprint(service),
    tokens,
    proxyOrigin: new URL(c.req.url).origin,
    today: todayUtc(deps.now()),
    also: alsoParam(c),
  };
}

async function renderToken(
  c: AdminContext,
  service: Service,
  o: {
    state?: TokenPageState;
    errors?: FieldError[];
    status?: ContentfulStatusCode;
    withNotice?: boolean;
  } = {},
) {
  const data = await loadPage(c, service);
  const rawOpen = c.req.query('open');
  const open = rawOpen === 'destination' || rawOpen === 'details' ? rawOpen : null;
  return renderPage(
    c,
    {
      title: service.name,
      section: 'tokens',
      subsection: 'tokens',
      breadcrumbs: [
        { href: paths.tokens(), label: 'Service tokens' },
        { href: paths.token(service.id), label: service.name },
      ],
      errors: o.errors,
      status: o.status,
      notice: o.withNotice
        ? resolveNotice(TOKEN_NOTICES, c.req.query('notice'), null, {
            service,
            also: data.also,
          })
        : null,
    },
    (ctx) => <TokenPage ctx={ctx} data={data} state={{ open, ...o.state }} />,
  );
}

async function detailPage(c: AdminContext) {
  const service = await getService(c.get('deps').env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  return renderToken(c, service, { withNotice: true });
}

/** A form of the token page failed: re-render it open, with its errors in the summary. */
function pageFailure(
  c: AdminContext,
  service: Service,
  formName: 'secret' | 'destination' | 'details',
  state: FormState,
  status: ContentfulStatusCode,
) {
  return renderToken(c, service, {
    state: { [formName]: state },
    errors: summaryErrors(formName, state.errors),
    status,
  });
}

async function update(c: AdminContext) {
  const deps = c.get('deps');
  const service = await getService(deps.env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const values = valuesFromForm(await formData(c));
  const state = (errors: FieldError[]): FormState => ({
    values,
    errors,
    draft: null,
    verify: null,
  });
  const expiry = parseDateInput(values.credential_expires_at);
  if (!expiry.ok) {
    return pageFailure(
      c,
      service,
      'details',
      state([fieldError('credential_expires_at', EXPIRY_FORMAT_ERROR)]),
      400,
    );
  }
  // The form shows dates only; an unchanged date keeps the stored time of day.
  const expiresAt =
    values.credential_expires_at.trim() === dateInput(service.credential_expires_at)
      ? service.credential_expires_at
      : expiry.value;
  // Template check headers have no input: they are kept with the check.
  const posted = verifyFromValues(values);
  const verify =
    posted && service.verify?.headers ? { ...posted, headers: service.verify.headers } : posted;
  const result = await updateServiceFields(deps, adminActor(c), service.id, {
    name: values.name,
    description: values.description,
    forward_headers: forwardHeadersFromValues(values),
    timeout_ms: timeoutFromValues(values),
    verify,
    credential_expires_at: expiresAt,
    expected_updated_at: submittedVersion(values.expected_updated_at),
  });
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    return pageFailure(
      c,
      service,
      'details',
      state(failureErrors(result)),
      FAILURE_STATUS[result.reason],
    );
  }
  return redirectWithNotice(
    c,
    paths.token(service.id),
    result.changed === false ? 'unchanged' : 'updated',
    { fragment: 'details' },
  );
}

async function rotate(c: AdminContext) {
  const deps = c.get('deps');
  const service = await getService(deps.env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const form = await formData(c);
  const values = valuesFromForm(form);
  const template = templateForService(service);
  // The destination is the stored one; posted base_url or injection fields are ignored (I-CRED-2).
  const target: SecretTarget = {
    template,
    label: template?.secret.label ?? 'secret',
    baseUrl: service.base_url,
    injection: service.injection,
    target: service.id,
  };
  const errors: FieldError[] = [];
  const expiry = template?.expiry_from_check
    ? ({ ok: true, value: null } as const)
    : parseDateInput(values.credential_expires_at);
  if (!expiry.ok) errors.push(fieldError('credential_expires_at', EXPIRY_FORMAT_ERROR));
  const secret = await resolveSecret(c, form, target);
  if (secret.error) errors.push(secret.error);
  const fail = async (
    failure: FieldError[],
    status: ContentfulStatusCode,
    verify: VerifyOutcome | null = null,
  ) =>
    pageFailure(
      c,
      service,
      'secret',
      { values, errors: failure, draft: await draftFor(c, secret, target), verify },
      status,
    );
  // The destination the form showed (a digest, never a posted destination): a token repointed
  // since the page was loaded is refused before anything is sent, and without a draft, so a
  // second click cannot send the kept secret to the new destination (I-CRED-2).
  const expected = text(form, 'expected_destination');
  if (expected !== (await destinationFingerprint(service))) {
    return pageFailure(
      c,
      service,
      'secret',
      {
        values,
        errors: [
          fieldError(
            null,
            `The destination of this token changed since the page was loaded: it now sends the secret to ${upstreamHost(service.base_url)}. Nothing was sent or saved. Check the destination below, then enter the secret again`,
          ),
        ],
        draft: null,
        verify: null,
      },
      409,
    );
  }
  if (errors.length > 0 || secret.secret === null) return fail(errors, 400);
  const result = await rotateServiceSecret(
    deps,
    adminActor(c),
    service.id,
    {
      secret: secret.secret,
      save_anyway: flag(form, 'save_anyway'),
      credential_expires_at: (expiry.ok ? expiry.value : null) ?? undefined,
      siblings: texts(form, 'also_replace'),
      expected_destination: expected,
    },
    opContextFor(new URL(c.req.url)),
  );
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    // Repointed or changed between the route's read and the op's: no draft either.
    if (result.reason === 'conflict') {
      return pageFailure(
        c,
        (await getService(deps.env.DB, service.id)) ?? service,
        'secret',
        { values, errors: failureErrors(result, target.label), draft: null, verify: null },
        409,
      );
    }
    if (result.reason === 'confirmation_required') {
      return renderToken(c, service, {
        state: { open: 'destination' },
        errors: [
          fieldError(
            'destination.base_url',
            `${result.errors.join('. ')}. Set the secret under Change destination`,
          ),
        ],
        status: 422,
      });
    }
    return fail(
      failureErrors(result, target.label),
      FAILURE_STATUS[result.reason],
      result.verify ?? null,
    );
  }
  const notice =
    result.verify === null
      ? 'secret_saved'
      : result.verify.passed
        ? 'secret_verified'
        : 'secret_unverified';
  return redirectWithNotice(c, paths.token(service.id), notice, {
    fragment: 'secret',
    also: result.siblings.some((sibling) => !sibling.ok) ? 'sibling_failed' : undefined,
  });
}

async function changeDestination(c: AdminContext) {
  const deps = c.get('deps');
  const db = deps.env.DB;
  const service = await getService(db, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const form = await formData(c);
  const values: TokenFormValues = valuesFromForm(form);
  const injection = injectionFromValues(values);
  const normalizedInjection = normalizeInjection(injection);
  const base = validateBaseUrl(values.base_url, { gatewayHosts: [], allowedUpstreamHosts: null });
  // The wrong-type guard of the template this destination is (if any).
  const template =
    base.ok && normalizedInjection.ok
      ? getServiceTemplate(templateIdFor(base.normalized, normalizedInjection.json) ?? '')
      : null;
  const target: SecretTarget = {
    template,
    label: template?.secret.label ?? 'secret',
    baseUrl: values.base_url,
    injection,
    target: service.id,
  };
  const errors: FieldError[] = [];
  const expiry = parseDateInput(values.credential_expires_at);
  if (!expiry.ok) errors.push(fieldError('credential_expires_at', EXPIRY_FORMAT_ERROR));
  const secret = await resolveSecret(c, form, target);
  if (secret.error) errors.push(secret.error);
  // The allowlist (A7.4 step 3): the owner's box is shown from the start (value 1) and applies
  // only when the submitted host is not covered; a box naming another host is stale.
  const host = hostOf(values.base_url);
  const allowlist = await getAllowedUpstreamHosts(db);
  const covered = host === null || upstreamHostAllowed(host, allowlist);
  const allowRequested = values.allow_host !== '';
  const hostErrors: FieldError[] = [];
  if (!covered && allowRequested && values.allow_host !== '1' && values.allow_host !== host) {
    hostErrors.push(fieldError('allow_host', 'Check the box again: the base URL changed'));
  } else if (!covered && !allowRequested) {
    const canAllow = can(c.get('viewer').user.role, 'settings:write');
    hostErrors.push(
      fieldError(
        'base_url',
        `${host} is not an allowed host. ${canAllow ? 'Tick "Also allow" below, or use another base URL' : 'Use an allowed host, or ask an owner to allow it'}`,
      ),
    );
  }
  const fail = async (
    failure: FieldError[],
    status: ContentfulStatusCode,
    verify: VerifyOutcome | null = null,
  ) =>
    pageFailure(
      c,
      service,
      'destination',
      { values, errors: failure, draft: await draftFor(c, secret, target), verify },
      status,
    );
  const input = {
    base_url: values.base_url,
    injection,
    secret: secret.secret ?? '',
    save_anyway: flag(form, 'save_anyway'),
    // Undefined: the op uses the expiry the check reports (GitHub), else none.
    credential_expires_at:
      expiry.ok && !template?.expiry_from_check ? (expiry.value ?? undefined) : undefined,
    confirm_destination: values.confirm_destination,
  };
  const context = opContextFor(new URL(c.req.url));
  const allowHost = !covered && allowRequested && host !== null;
  // Everything that sends nothing (formats, keyring, the host confirmation) before the host is
  // added, so a destination refused anyway never changes the allowlist (A7.4). The op's errors
  // come back together with the route's and the allowlist's, in one re-render; the route checks
  // the allowlist itself, and setServiceCredential enforces it again.
  const checked = await checkServiceCredential(deps, service.id, input, context, {
    hostAllowed: true,
    withoutSecret: secret.secret === null,
  });
  if (!checked.ok && checked.reason === 'not_found') return notFound(c);
  const all = [
    ...errors,
    ...(!checked.ok && checked.reason !== 'unavailable'
      ? failureErrors(checked, target.label)
      : []),
    ...hostErrors,
  ];
  if (all.length > 0) {
    const onlyOp = errors.length === 0 && hostErrors.length === 0 && !checked.ok;
    return fail(all, onlyOp ? FAILURE_STATUS[checked.reason] : 400);
  }
  if (!checked.ok)
    return fail(failureErrors(checked, target.label), FAILURE_STATUS[checked.reason]);
  if (secret.secret === null) return fail(errors, 400);
  const actor = adminActor(c);
  let hostAdded = false;
  if (allowHost) {
    const added = await addUpstreamHost(deps, actor, host);
    if (!added.ok) return fail(failureErrors(added, target.label), FAILURE_STATUS[added.reason]);
    hostAdded = added.changed;
  }
  const result = await setServiceCredential(deps, actor, service.id, input, context);
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    const failure = failureErrors(result, target.label);
    return fail(
      hostAdded
        ? [
            fieldError(null, `${host} was added to Allowed hosts; the destination was not saved:`),
            ...failure,
          ]
        : failure,
      FAILURE_STATUS[result.reason],
      result.verify ?? null,
    );
  }
  return redirectWithNotice(c, paths.token(service.id), 'destination_changed', {
    fragment: 'destination',
    also: hostAdded ? 'host_added' : undefined,
  });
}

async function testSecret(c: AdminContext) {
  const deps = c.get('deps');
  const service = await getService(deps.env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const result = await testServiceCredential(
    deps,
    adminActor(c),
    service.id,
    opContextFor(new URL(c.req.url)),
  );
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    return renderToken(c, service, {
      errors: result.errors.map((message) => fieldError(null, message)),
      status: FAILURE_STATUS[result.reason],
    });
  }
  // Rendered directly (no redirect): the result is shown once and not stored. A changed GitHub
  // expiry was saved by the op, so the page reads the row again.
  const current = (await getService(deps.env.DB, service.id)) ?? service;
  return renderToken(c, current, {
    state: { test: result.verify },
    errors: result.verify.passed
      ? []
      : [
          fieldError(
            null,
            `The check of the stored secret failed: ${result.verify.error ?? 'unknown error'}`,
          ),
        ],
  });
}

async function toggle(c: AdminContext) {
  const deps = c.get('deps');
  const service = await getService(deps.env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const form = await formData(c);
  const requested = text(form, 'enabled');
  if (requested !== '1' && requested !== '0') {
    return renderToken(c, service, {
      errors: [fieldError(null, 'Choose whether to enable or disable the token')],
      status: 400,
    });
  }
  // A disable passes `enabled` alone, so it never depends on the stored row validating.
  const enabled = requested === '1';
  const result = await updateServiceFields(deps, adminActor(c), service.id, { enabled });
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    return renderToken(c, service, {
      errors: failureErrors(result),
      status: FAILURE_STATUS[result.reason],
    });
  }
  const back = returnPath('POST /admin/tokens/:id/toggle', form._return, { id: service.id });
  return redirectWithNotice(c, back, enabled ? 'enabled' : 'disabled');
}

async function remove(c: AdminContext) {
  const deps = c.get('deps');
  const service = await getService(deps.env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const form = await formData(c);
  if (text(form, 'confirm') !== '1') {
    return renderToken(c, service, {
      errors: [fieldError(null, `Confirm the delete in the "Delete ${service.name}" dialog`)],
      status: 400,
    });
  }
  const result = await deleteService(deps, adminActor(c), service.id, {
    withAccesses: flag(form, 'with_accesses'),
    accessIds: text(form, 'access_ids')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  });
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    return renderToken(c, service, {
      errors: result.errors.map((message) => fieldError(null, message)),
      status: FAILURE_STATUS[result.reason],
    });
  }
  return redirectWithNotice(
    c,
    paths.tokens(),
    result.deletedAccesses > 0 ? 'deleted_with_accesses' : 'deleted',
  );
}
