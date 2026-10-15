// The token page (A13.3): problems, who can use the token, the secret (with the inline rotate
// form), how consumers call it, the destination (changed only with the secret, I-CRED-2), the
// details form and the danger zone. Viewers and access managers get the same page without forms,
// except the access manager's "Give a consumer access".
import type { Child } from 'hono/jsx';
import { sealedKid } from '../../crypto/envelope';
import type { KeyringError } from '../../crypto/keyring';
import type { Service } from '../../db/types';
import type { Injection, VerifyCheck } from '../../policy/types';
import { EXPIRY_WARNING_MS } from '../../telemetry/dashboard';
import type { AccessEdge } from '../connections';
import { KEYRING_ERROR_TEXT } from '../ops/keyring';
import type { StoredBinding } from '../ops/services';
import type { VerifyOutcome } from '../ops/verify';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { SERVICE_TEMPLATES, type ServiceTemplate } from '../service-templates';
import {
  ActionButton,
  type Alert,
  AlertList,
  AskSomeone,
  Checkbox,
  type ChipProps,
  ChipList,
  ConfirmDialog,
  Details,
  Field,
  PostForm,
  StatusBadge,
  Time,
  VersionField,
  TextArea,
} from './components';
import { formatTime, relativeTime } from './format';
import type { StatusKey } from './status';
import { CUSTOM_SECRET } from './token-cards';
import {
  AdvancedFields,
  baseUrlSuggestions,
  dateInput,
  EMPTY_VALUES,
  ExpiryField,
  FormIds,
  type FormState,
  InjectionFields,
  inSentence,
  PATH_WARNING,
  QUERY_WARNING,
  SecretField,
  SecretSubmits,
  type TokenFormValues,
  valuesFromService,
  VerifyResult,
} from './token-forms';

const DAY_MS = 86_400_000;

export type BindingState = StoredBinding | { status: 'unknown' };

/** The `also` query of a token page notice: a second outcome of the same submit. */
export type TokenAlso = 'host_added' | 'pair_failed' | 'sibling_failed';

/** One token's status in the A9 vocabulary, most severe first. */
export function tokenStatus(
  service: Pick<Service, 'enabled' | 'credential_sealed' | 'credential_expires_at'>,
  o: { unreadable: boolean; outside: boolean; now: number },
): { status: StatusKey; detail?: string } {
  if (!service.enabled) return { status: 'disabled' };
  if (service.credential_sealed === null) return { status: 'no_credential' };
  if (o.unreadable) return { status: 'credential_unreadable' };
  if (o.outside) return { status: 'outside_hosts' };
  const expires = service.credential_expires_at;
  if (expires !== null && expires <= o.now) return { status: 'expired' };
  if (expires !== null && expires - o.now <= EXPIRY_WARNING_MS) {
    return { status: 'expiring', detail: String(Math.ceil((expires - o.now) / DAY_MS)) };
  }
  return { status: 'active' };
}

/** The secret as a badge: missing, does not open, expired, expiring, or set with its hint. */
export function SecretBadge(props: {
  service: Pick<Service, 'credential_sealed' | 'credential_hint' | 'credential_expires_at'>;
  unreadable: boolean;
  now: number;
}) {
  const { service, now } = props;
  if (service.credential_sealed === null) return <StatusBadge status="no_credential" />;
  if (props.unreadable) return <StatusBadge status="credential_unreadable" />;
  const expires = service.credential_expires_at;
  const hint = service.credential_hint ? (
    <>
      {' '}
      <code>{service.credential_hint}</code>
    </>
  ) : null;
  if (expires !== null && expires <= now) {
    return (
      <>
        <StatusBadge status="expired" />
        {hint}
      </>
    );
  }
  if (expires !== null && expires - now <= EXPIRY_WARNING_MS) {
    return (
      <>
        <StatusBadge status="expiring" detail={String(Math.ceil((expires - now) / DAY_MS))} />
        {hint}
      </>
    );
  }
  return (
    <>
      <span class="badge ok">
        <span aria-hidden="true">✓ </span>Set
      </span>
      {hint}
    </>
  );
}

export function typeLabel(template: ServiceTemplate | null): string {
  return template?.label ?? 'Custom API';
}

export function injectionText(injection: Injection): string {
  switch (injection.kind) {
    case 'bearer':
      return 'Authorization: Bearer <secret>';
    case 'header':
      return `${injection.name}: ${injection.prefix ?? ''}<secret>`;
    case 'basic':
      return injection.username
        ? `HTTP Basic authentication as user "${injection.username}"`
        : 'HTTP Basic authentication (the secret is "username:password")';
    case 'query':
      return `query parameter ?${injection.param}=<secret>`;
    case 'path':
      // Same layout as credentialPathSegment (proxy/path.ts).
      return `URL path: <base URL>/${(injection.prefix ?? '').replace(/^\//, '')}<secret>/…`;
    default:
      return 'invalid stored injection; set the secret again under Change destination';
  }
}

export function verifyText(verify: VerifyCheck | null): string {
  if (!verify) return 'none';
  const okField = verify.expect_ok_field ? ' and "ok": true' : '';
  return `${verify.method} ${verify.path}, expecting HTTP ${verify.expect_status}${okField}`;
}

export function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** "3 h ago", or why there is no time. */
export function LastUsed(props: {
  hour: number | null;
  now: number;
  usageAvailable: boolean;
  sampleRate: number;
}) {
  if (props.sampleRate === 0) return <span class="muted">not recorded (sample rate 0)</span>;
  if (!props.usageAvailable) return <span class="muted">not available</span>;
  if (props.hour === null) return <span class="muted">not in the last 30 days</span>;
  return (
    <time datetime={new Date(props.hour).toISOString()}>{relativeTime(props.hour, props.now)}</time>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export interface TokenPageData {
  service: Service;
  template: ServiceTemplate | null;
  binding: BindingState;
  keyringError: KeyringError | null;
  allowlist: string[] | null;
  /** The base URL's host is not on the allowlist (requests are refused). */
  outside: boolean;
  accesses: AccessEdge[];
  usageAvailable: boolean;
  sampleRate: number;
  lastSet: { ts: number; actor_email: string | null } | null;
  /** Tokens of the same family holding the same secret (rotate pre-ticks them). */
  siblings: Service[];
  /** Every token, for the destination form's suggestions. */
  tokens: readonly Service[];
  proxyOrigin: string;
  today: string;
  also: TokenAlso | null;
}

export interface TokenPageState {
  secret?: FormState;
  destination?: FormState;
  details?: FormState;
  /** A check just run with the stored secret (POST /test). */
  test?: VerifyOutcome;
  open?: 'destination' | 'details' | null;
}

export function TokenPage(props: { ctx: ViewContext; data: TokenPageData; state: TokenPageState }) {
  const { ctx, data, state } = props;
  const { service } = data;
  const unattested = data.binding.status === 'unattested';
  const status = tokenStatus(service, {
    unreadable: unattested || data.keyringError !== null,
    outside: data.outside,
    now: ctx.now,
  });
  return (
    <>
      <p class="status-line">
        {typeLabel(data.template)} · <StatusBadge status={status.status} detail={status.detail} />
      </p>
      <Problems ctx={ctx} data={data} />
      <ConsumersSection ctx={ctx} data={data} />
      <SecretSection ctx={ctx} data={data} state={state} />
      <UseSection data={data} />
      <DestinationSection ctx={ctx} data={data} state={state} />
      <DetailsSection ctx={ctx} data={data} state={state} />
      <DangerSection ctx={ctx} data={data} />
      <h2 id="record-h" class="vh">
        Record
      </h2>
      <Details
        rows={[
          ['ID', <code>{service.id}</code>],
          ['Created', <Time ms={service.created_at} />],
          ['Updated', <Time ms={service.updated_at} />],
          [
            'Audit history',
            <a href={paths.audit({ target: service.id })}>Changes to {service.name}</a>,
          ],
        ]}
      />
    </>
  );
}

function Problems(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const alerts: Alert[] = [];
  const destinationFix = {
    href: paths.token(service.id, { open: 'destination', hash: 'destination' }),
    label: 'Change destination',
    permission: 'tokens:write' as const,
  };
  if (data.binding.status === 'unattested') {
    alerts.push({
      code: 'credential_malformed',
      level: 'error',
      title: 'The stored destination is not confirmed.',
      detail: bindingText(data.binding),
      objects: [],
      fix: destinationFix,
    });
  }
  if (service.credential_sealed === null) {
    alerts.push({
      code: 'credential_missing_used',
      level: 'error',
      title: 'No secret is stored, so requests through this token fail.',
      detail: 'Set it under Destination; you will be asked to confirm the host.',
      objects: [],
      fix: destinationFix,
    });
  }
  if (data.keyringError !== null) {
    alerts.push({
      code: 'keyring_unavailable',
      level: 'error',
      title: 'Encryption keys are not loaded: the secret cannot be used or changed.',
      detail: KEYRING_ERROR_TEXT[data.keyringError],
      objects: [{ href: paths.tokenKeys(), label: 'Encryption keys' }],
    });
  }
  if (data.outside) {
    alerts.push({
      code: 'outside_hosts',
      level: 'error',
      title: `${upstreamHost(service.base_url)} is not an allowed host, so requests through this token are refused.`,
      detail: '',
      objects: [],
      fix: { href: paths.tokenHosts(), label: 'Open allowed hosts', permission: 'settings:write' },
    });
  }
  const expires = service.credential_expires_at;
  if (service.credential_sealed !== null && expires !== null) {
    if (expires <= ctx.now) {
      alerts.push({
        code: 'credential_expired',
        level: 'error',
        title: `The secret expired on ${formatTime(expires)}.`,
        detail: 'Upstream calls fail until it is replaced.',
        objects: [],
        fix: {
          href: paths.token(service.id, { hash: 'secret' }),
          label: 'Replace the secret',
          permission: 'tokens:write',
        },
      });
    } else if (expires - ctx.now <= EXPIRY_WARNING_MS) {
      alerts.push({
        code: 'credential_expiring',
        level: 'warning',
        title: `The secret expires on ${formatTime(expires)}.`,
        detail: 'Replace it before then.',
        objects: [],
        fix: {
          href: paths.token(service.id, { hash: 'secret' }),
          label: 'Replace the secret',
          permission: 'tokens:write',
        },
      });
    }
  }
  if (data.also === 'pair_failed') {
    alerts.push({
      code: 'config_problem',
      level: 'warning',
      title: 'The GitHub release asset uploads token was not created.',
      detail: 'This token was saved; add the uploads token on its own.',
      objects: [],
      fix: {
        href: paths.tokenNew({ template: 'github-uploads' }),
        label: 'Add GitHub release asset uploads',
        permission: 'tokens:write',
      },
    });
  }
  if (service.injection.kind === 'query') {
    alerts.push({
      code: 'config_problem',
      level: 'info',
      title: QUERY_WARNING,
      detail: '',
      objects: [],
    });
  }
  if (service.injection.kind === 'path') {
    alerts.push({
      code: 'config_problem',
      level: 'info',
      title: PATH_WARNING,
      detail: '',
      objects: [],
    });
  }
  const disabled = !service.enabled;
  if (alerts.length === 0 && !disabled) return null;
  return (
    <section aria-labelledby="problems-h">
      <h2 id="problems-h">Problems</h2>
      {disabled ? (
        <div class="alert alert-warning disabled-note">
          <p>
            <strong>Warning:</strong> This token is disabled: requests through it are refused.
          </p>
          {ctx.can('tokens:write') ? (
            <ActionButton
              action={`${paths.token(service.id)}/toggle`}
              csrf={ctx.csrf}
              label="Enable"
              context={service.name}
              fields={{ enabled: '1' }}
              returnTo="detail"
            />
          ) : null}
        </div>
      ) : null}
      <AlertList alerts={alerts} ctx={ctx} />
    </section>
  );
}

function bindingText(binding: Extract<StoredBinding, { status: 'unattested' }>): string {
  const cause =
    binding.error === 'credential_binding_mismatch'
      ? binding.keyChanged === false
        ? 'The base URL or the way the secret is sent was changed outside the admin UI: the stored secret no longer matches them, and the encryption key is unchanged.'
        : 'The stored secret does not match this token: either its base URL or the way the secret is sent was changed outside the admin UI, or the key behind its key id was replaced (see Encryption keys).'
      : binding.error === 'keyring_missing_key'
        ? 'The stored secret was encrypted with a key that is no longer in the keyring, so the stored base URL and injection cannot be confirmed.'
        : 'The stored secret is damaged, so the stored base URL and injection cannot be confirmed.';
  return `${cause} Treat this as possible tampering: a secret entered now goes to the base URL you submit. Check the base URL and injection against an out-of-band source (the provider's documentation, your configuration as code) before you enter the secret again. The audit log is not a reliable reference: anyone who can edit the database can edit it too.`;
}

/** Why a token with a secret and accesses still cannot serve them, or null. */
function unusableReason(data: TokenPageData): string | null {
  const { service } = data;
  if (!service.enabled) return 'the token is disabled';
  if (service.credential_sealed === null) return 'no secret is stored';
  if (data.binding.status === 'unattested' || data.keyringError !== null) {
    return 'the stored secret does not open';
  }
  if (data.outside) return `${upstreamHost(service.base_url)} is not an allowed host`;
  return null;
}

/** Accesses that let a consumer call: enabled, unexpired, of an enabled consumer. */
export function usableAccesses(accesses: readonly AccessEdge[], now: number): AccessEdge[] {
  return accesses.filter(
    (edge) =>
      edge.grant.enabled &&
      (edge.grant.expires_at === null || edge.grant.expires_at > now) &&
      edge.consumer?.enabled === true,
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ConsumersSection(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const usable = usableAccesses(data.accesses, ctx.now);
  const consumers = new Set(usable.map((edge) => edge.grant.caller_provider_id));
  const reason = unusableReason(data);
  const heading = `${plural(consumers.size, 'consumer', 'consumers')} can use this token${
    usable.length > 0 ? ` (${plural(usable.length, 'access', 'accesses')})` : ''
  }${reason !== null && usable.length > 0 ? `, but the token is not usable now: ${reason}` : ''}`;
  const groups = new Map<string, AccessEdge[]>();
  for (const edge of data.accesses) {
    const list = groups.get(edge.grant.caller_provider_id) ?? [];
    list.push(edge);
    groups.set(edge.grant.caller_provider_id, list);
  }
  const giveHref = paths.accessNew({ token: service.id });
  const absolute = `${data.proxyOrigin}${giveHref}`;
  return (
    <section id="consumers" aria-labelledby="consumers-h">
      <h2 id="consumers-h">{heading}</h2>
      {[...groups.values()].map((edges) => {
        const consumer = edges[0]?.consumer;
        const name = consumer?.name ?? 'Deleted consumer';
        return (
          <>
            <h3>{consumer ? <a href={paths.consumer(consumer.id)}>{name}</a> : name}</h3>
            <ChipList
              label={`Accesses of ${name} to ${service.name}`}
              items={edges.map((edge) => accessChip(edge, service.name, data, ctx.now))}
            />
          </>
        );
      })}
      {ctx.can('access:write') ? (
        <p class="actions">
          <a class="button" href={giveHref}>
            Give a consumer access
          </a>
        </p>
      ) : (
        <div class="handoff">
          <p>Consumer access is granted by access managers. Send them this link:</p>
          <Field
            name="handoff"
            id="handoff"
            label="Link to give a consumer access to this token"
            autocomplete="off"
            readonly
            value={absolute}
          />
          <HandOff ctx={ctx} service={service} url={absolute} />
        </div>
      )}
      <p>
        <a href={paths.requests({ token: service.id })}>Requests through this token</a> ·{' '}
        <a href={paths.access({ token: service.id })}>All consumers and tokens</a>
      </p>
    </section>
  );
}

function accessChip(
  edge: AccessEdge,
  tokenName: string,
  data: TokenPageData,
  now: number,
): ChipProps {
  const operations = plural(edge.operations.length, 'operation', 'operations');
  const used =
    data.sampleRate === 0 || !data.usageAvailable
      ? null
      : edge.lastUsedHour === null
        ? 'not used in 30 days'
        : `last used ${relativeTime(edge.lastUsedHour, now)}`;
  const text = `${edge.subject} · ${edge.context} · ${operations}`;
  const statusText = edge.statusDetail
    ? `${edge.status === 'inactive' ? 'Inactive: ' : ''}${edge.statusDetail}`
    : edge.status;
  return {
    href: paths.accessItem(edge.grant.id),
    text,
    ...(used ? { secondary: used } : {}),
    status: edge.status,
    ...(edge.statusDetail ? { statusDetail: edge.statusDetail } : {}),
    srText: `${edge.subject} in ${edge.context} can use ${tokenName} (${operations}): ${statusText}${used ? `, ${used}` : ''}`,
  };
}

/** The access managers to mail, with the link in the body (AskSomeone with a prefilled mail). */
function HandOff(props: { ctx: ViewContext; service: Service; url: string }) {
  const people = props.ctx.askers('access:write');
  if (people.length === 0) return <AskSomeone permission="access:write" ctx={props.ctx} />;
  const query = new URLSearchParams({
    subject: `Access to service token ${props.service.name}`,
    body: `Please give a consumer access to the service token ${props.service.name}: ${props.url}`,
  })
    .toString()
    .replace(/\+/g, '%20');
  const more = props.ctx.askersMore('access:write');
  return (
    <p class="ask">
      Ask an access manager:{' '}
      {people.map((person, index) => (
        <>
          {index > 0 ? (index === people.length - 1 && more === 0 ? ' or ' : ', ') : null}
          <a href={`mailto:${person.email}?${query}`}>{person.email}</a>
        </>
      ))}
      {more > 0 ? ` and ${more} more` : ''}.
    </p>
  );
}

/** Rotate prefill: the stored expiry only when it is more than 14 days away (A13.8.2). */
function rotateExpiry(service: Service, now: number): { value: string; past: string | null } {
  const expires = service.credential_expires_at;
  if (expires === null) return { value: '', past: null };
  if (expires - now > EXPIRY_WARNING_MS) return { value: dateInput(expires), past: null };
  return { value: '', past: dateInput(expires) };
}

function secretPlaceholder(template: ServiceTemplate | null) {
  return template?.secret ?? CUSTOM_SECRET;
}

function SecretSection(props: { ctx: ViewContext; data: TokenPageData; state: TokenPageState }) {
  const { ctx, data, state } = props;
  const { service, template } = data;
  const attested = data.binding.status === 'attested';
  const canWrite = ctx.can('tokens:write');
  const kid = sealedKid(service.credential_sealed);
  return (
    <section id="secret" aria-labelledby="secret-h">
      <h2 id="secret-h">Secret</h2>
      <Details
        rows={[
          [
            'Secret',
            service.credential_sealed === null ? (
              <span class="muted">missing</span>
            ) : (
              <SecretBadge
                service={service}
                unreadable={data.binding.status === 'unattested' || data.keyringError !== null}
                now={ctx.now}
              />
            ),
          ],
          [
            'Set on',
            service.credential_updated_at === null ? (
              <span class="muted">never</span>
            ) : (
              <Time ms={service.credential_updated_at} relative now={ctx.now} />
            ),
          ],
          ['Set by', data.lastSet?.actor_email ?? <span class="muted">not recorded</span>],
          [
            'Expires',
            <>
              {service.credential_expires_at === null ? (
                <span class="muted">does not expire, or not known</span>
              ) : (
                <Time ms={service.credential_expires_at} />
              )}
              {template?.expiry_from_check ? <span class="muted"> (read from GitHub)</span> : null}
            </>,
          ],
          ['Key', kid ? <code>{kid}</code> : <span class="muted">none</span>],
        ]}
      />
      {state.test ? (
        state.test.passed ? (
          <div class="check-result passed" role="status">
            <VerifyResult verify={state.test} />
          </div>
        ) : (
          <VerifyResult verify={state.test} />
        )
      ) : null}
      {canWrite && service.verify && attested ? (
        <p class="actions">
          <ActionButton
            action={`${paths.token(service.id)}/test`}
            csrf={ctx.csrf}
            label={`Test ${service.name} secret`}
          />
          <span class="hint">Sends {verifyText(service.verify)} to the upstream now.</span>
        </p>
      ) : null}
      {canWrite ? (
        attested ? (
          <RotateForm ctx={ctx} data={data} state={state.secret} />
        ) : data.keyringError !== null ? (
          <p>
            Secrets cannot be changed while the encryption keys are not loaded.{' '}
            <a href={paths.tokenKeys()}>Open encryption keys</a>
          </p>
        ) : (
          <p>
            <a href={paths.token(service.id, { open: 'destination', hash: 'destination' })}>
              Set the secret through Change destination below
            </a>
            : the host is confirmed there first.
          </p>
        )
      ) : null}
    </section>
  );
}

function RotateForm(props: { ctx: ViewContext; data: TokenPageData; state?: FormState }) {
  const { ctx, data, state } = props;
  const { service, template } = data;
  const ids = new FormIds('secret', state?.errors ?? []);
  const expiry = rotateExpiry(service, ctx.now);
  const values: TokenFormValues = state?.values ?? {
    ...EMPTY_VALUES,
    credential_expires_at: expiry.value,
  };
  const secret = secretPlaceholder(template);
  const submitted = state ? new Set(state.values.also_replace.split(',')) : null;
  return (
    <PostForm action={`${paths.token(service.id)}/secret`} csrf={ctx.csrf} class="stack">
      <h3>Replace secret</h3>
      <SecretField
        ids={ids}
        label={`New ${inSentence(secret.label)}`}
        placeholder={secret.placeholder}
        hint={`Replaces ${service.credential_hint ?? 'the stored secret'}. Consumers keep working, with the new secret from the next request.`}
        pattern={template?.secret.pattern}
        draft={state?.draft ?? null}
      />
      {state?.verify ? <VerifyResult verify={state.verify} /> : null}
      {template?.expiry_from_check ? null : (
        <ExpiryField
          ids={ids}
          values={values}
          label="New secret expires on"
          min={data.today}
          hint={
            expiry.past
              ? `The old secret expires or expired on ${expiry.past}; enter the new one's. Empty = does not expire.`
              : 'Change it if the new secret expires on another date. Empty = does not expire.'
          }
        />
      )}
      {data.siblings.map((sibling) => (
        <Checkbox
          name="also_replace"
          id={ids.id(`also_replace.${sibling.id}`)}
          value={sibling.id}
          checked={submitted ? submitted.has(sibling.id) : true}
          label={`Also replace in ${sibling.slug} (same secret, ${sibling.credential_hint ?? 'stored'})`}
        />
      ))}
      <SecretSubmits
        label={service.verify ? 'Check and replace secret' : 'Replace secret'}
        context={`of ${service.name}`}
        failedCheck={!!state?.verify}
      />
    </PostForm>
  );
}

function UseSection(props: { data: TokenPageData }) {
  const { service, template } = props.data;
  return (
    <section id="use" aria-labelledby="use-h">
      <h2 id="use-h">How consumers call it</h2>
      <Field
        name="proxy_base_url"
        id="proxy-base-url"
        label="Proxy base URL"
        autocomplete="off"
        readonly
        value={`${props.data.proxyOrigin}/proxy/${service.slug}`}
        hint="Consumers send requests here with their CI identity token; the rest of the path is appended to the base URL."
      />
      {template ? <p class="hint">{template.notes}</p> : null}
    </section>
  );
}

function DestinationSection(props: {
  ctx: ViewContext;
  data: TokenPageData;
  state: TokenPageState;
}) {
  const { ctx, data, state } = props;
  const { service } = data;
  const unattested = data.binding.status === 'unattested';
  const none = service.credential_sealed === null;
  const open = unattested || none || !!state.destination || state.open === 'destination';
  const notConfirmed = unattested ? (
    <>
      {' '}
      <span class="badge bad">not confirmed</span>
    </>
  ) : null;
  return (
    <section id="destination" aria-labelledby="destination-h">
      <h2 id="destination-h">Destination</h2>
      <Details
        rows={[
          [
            'Base URL',
            <>
              <code>{service.base_url}</code>
              {notConfirmed}
            </>,
          ],
          [
            'Secret sent as',
            <>
              {injectionText(service.injection)}
              {notConfirmed}
            </>,
          ],
          [
            'Extra forwarded headers',
            service.forward_headers.length > 0 ? (
              service.forward_headers.join(', ')
            ) : (
              <span class="muted">none</span>
            ),
          ],
          ['Timeout', `${service.timeout_ms / 1000} s`],
          ['Secret check', verifyText(service.verify)],
        ]}
      />
      {unattested ? (
        <p class="hint">
          May have been changed outside the admin UI. Do not copy it into the destination form.
        </p>
      ) : null}
      {ctx.can('tokens:write') ? (
        <details id="destination-edit" open={open}>
          <summary>Change destination</summary>
          <DestinationForm ctx={ctx} data={data} state={state.destination} />
        </details>
      ) : null}
    </section>
  );
}

function DestinationForm(props: { ctx: ViewContext; data: TokenPageData; state?: FormState }) {
  const { ctx, data, state } = props;
  const { service, template } = data;
  const attested = data.binding.status === 'attested';
  const confirm = data.binding.status === 'unattested' || service.credential_sealed === null;
  const ids = new FormIds('destination', state?.errors ?? []);
  const stored = valuesFromService(service);
  const expiry = rotateExpiry(service, ctx.now);
  // An unattested or absent binding is not prefilled: the admin types the destination from an
  // out-of-band source instead of resubmitting a possibly tampered value (I-CRED-2).
  const defaults: TokenFormValues = attested
    ? { ...stored, credential_expires_at: expiry.value }
    : { ...EMPTY_VALUES };
  const values = state ? { ...state.values, confirm_destination: '' } : defaults;
  const host = upstreamHost(values.base_url);
  const listed = data.allowlist !== null && data.allowlist.length > 0;
  const showAllow =
    ctx.can('settings:write') &&
    listed &&
    values.base_url !== '' &&
    !data.allowlist?.some((entry) => hostMatches(host, entry));
  // Unattested or none: only code-sourced suggestions; D1 values could be the attacker's.
  const suggestions = attested
    ? baseUrlSuggestions(data.allowlist, data.tokens)
    : SERVICE_TEMPLATES.map((t) => ({ value: t.base_url, label: t.label }));
  const secret = secretPlaceholder(template);
  return (
    <PostForm action={`${paths.token(service.id)}/destination`} csrf={ctx.csrf} class="stack">
      <Field
        name="base_url"
        id={ids.id('base_url')}
        label="Base URL"
        type="url"
        required
        autocomplete="off"
        spellcheck={false}
        autocapitalize="none"
        value={values.base_url}
        example="https://api.example.com/v1"
        suggestions={suggestions}
        hint={
          <>
            Changing it requires the secret again: the secret is bound to its destination.
            {listed ? <> Allowed hosts: {data.allowlist?.join(', ')}.</> : null}
          </>
        }
        error={ids.error('base_url')}
      />
      <InjectionFields ids={ids} values={values} tokens={data.tokens} />
      {confirm ? (
        <Field
          name="confirm_destination"
          id={ids.id('confirm_destination')}
          label="Confirm destination host"
          required
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
          example="api.example.com"
          value=""
          hint="Check the base URL against the provider's docs, then type its host. Nothing is sent upstream until this matches."
          error={ids.error('confirm_destination')}
        />
      ) : null}
      <SecretField
        ids={ids}
        label={secret.label}
        placeholder={secret.placeholder}
        hint="Required: a new destination needs the secret again."
        draft={state?.draft ?? null}
      />
      {state?.verify ? <VerifyResult verify={state.verify} /> : null}
      {showAllow ? (
        <Checkbox
          name="allow_host"
          id={ids.id('allow_host')}
          value={host}
          checked={state ? state.values.allow_host === host : false}
          label={`Also allow ${host} (not in Allowed hosts yet)`}
          hint="Applies to every token."
          error={ids.error('allow_host')}
        />
      ) : null}
      {template?.expiry_from_check ? null : (
        <ExpiryField
          ids={ids}
          values={values}
          min={data.today}
          hint="Leave empty if it does not expire. GitHub tokens report their expiry when checked."
        />
      )}
      <SecretSubmits
        label={service.verify ? 'Check and change destination' : 'Change destination'}
        context={`of ${service.name}`}
        failedCheck={!!state?.verify}
      />
    </PostForm>
  );
}

function hostMatches(host: string, entry: string): boolean {
  const candidate = host.toLowerCase();
  return entry.startsWith('*.') ? candidate.endsWith(entry.slice(1)) : candidate === entry;
}

function DetailsSection(props: { ctx: ViewContext; data: TokenPageData; state: TokenPageState }) {
  const { ctx, data, state } = props;
  if (!ctx.can('tokens:write')) return null;
  const { service } = data;
  const ids = new FormIds('details', state.details?.errors ?? []);
  const values = state.details?.values ?? valuesFromService(service);
  const open = !!state.details || state.open === 'details';
  return (
    <details id="details" open={open}>
      <summary>Edit name, description and options</summary>
      <PostForm action={paths.token(service.id)} csrf={ctx.csrf} class="stack">
        <VersionField value={String(service.updated_at)} />
        <Field
          name="name"
          id={ids.id('name')}
          label="Name"
          required
          autocomplete="off"
          maxlength={100}
          value={values.name}
          example={data.template?.name ?? 'Slack'}
          error={ids.error('name')}
        />
        <TextArea
          name="description"
          id={ids.id('description')}
          label="Description"
          optional
          autocomplete="off"
          rows={2}
          maxlength={2000}
          value={values.description}
          example={'Bot "deploy-bot" in workspace acme; owner: platform team'}
          hint="Which account the secret belongs to and who owns it. Access managers see this."
          error={ids.error('description')}
        />
        <ExpiryField
          ids={ids}
          values={values}
          hint="Fix the expiry without pasting the secret again. Empty = does not expire."
        />
        <AdvancedFields
          ids={ids}
          values={values}
          tokens={data.tokens}
          verifyHeaders={service.verify?.headers}
        />
        <div class="actions">
          <button type="submit" class="primary">
            Save changes<span class="vh"> to {service.name}</span>
          </button>
        </div>
      </PostForm>
    </details>
  );
}

function DangerSection(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  if (!ctx.can('tokens:write')) return null;
  const { service } = data;
  const usable = usableAccesses(data.accesses, ctx.now);
  const consumers = new Set(usable.map((edge) => edge.grant.caller_provider_id)).size;
  const accesses = data.accesses;
  const ids = accesses.map((edge) => edge.grant.id).sort();
  const listed: Child[] = accesses.map((edge) => (
    <a href={paths.accessItem(edge.grant.id)}>
      {edge.grant.name} ({edge.consumer?.name ?? 'deleted consumer'})
    </a>
  ));
  return (
    <section id="danger" aria-labelledby="danger-h">
      <h2 id="danger-h">Danger zone</h2>
      {service.enabled ? (
        <p class="actions">
          <ActionButton
            action={`${paths.token(service.id)}/toggle`}
            csrf={ctx.csrf}
            label="Disable token"
            context={service.name}
            tone="danger"
            fields={{ enabled: '0' }}
            returnTo="detail"
          />
          <span class="hint">
            {plural(consumers, 'consumer loses', 'consumers lose')} access until you enable it
            again.
          </span>
        </p>
      ) : (
        <p class="actions">
          <ActionButton
            action={`${paths.token(service.id)}/toggle`}
            csrf={ctx.csrf}
            label="Enable token"
            context={service.name}
            fields={{ enabled: '1' }}
            returnTo="detail"
          />
        </p>
      )}
      {accesses.length === 0 ? (
        <ConfirmDialog
          id="delete"
          variant="standalone"
          action={`${paths.token(service.id)}/delete`}
          csrf={ctx.csrf}
          danger
          trigger={`Delete ${service.name}…`}
          title={`Delete ${service.name}?`}
          body="The token and its stored secret are deleted. The audit log keeps its configuration, never the secret."
          confirmLabel={`Delete ${service.name}`}
        />
      ) : ctx.can('access:write') ? (
        <ConfirmDialog
          id="delete"
          variant="standalone"
          action={`${paths.token(service.id)}/delete`}
          csrf={ctx.csrf}
          danger
          trigger={`Delete ${service.name} and its ${plural(accesses.length, 'consumer access', 'consumer accesses')}…`}
          title={`Delete ${service.name} and its ${plural(accesses.length, 'consumer access', 'consumer accesses')}?`}
          body="These consumers stop being able to call the token at once. The audit log keeps every deleted row, never the secret."
          affected={listed}
          fields={{ with_accesses: '1', access_ids: ids.join(',') }}
          confirmLabel={`Delete ${service.name} and ${plural(accesses.length, 'access', 'accesses')}`}
        />
      ) : (
        <div class="blocked">
          <p>
            {service.name} cannot be deleted while consumer access uses it. Disable the token now;
            an access manager can delete the accesses, or an admin can delete both.
          </p>
          <ul>
            {listed.map((item) => (
              <li>{item}</li>
            ))}
          </ul>
          <AskSomeone permission="access:write" ctx={ctx} verb="delete these accesses" />
        </div>
      )}
    </section>
  );
}
