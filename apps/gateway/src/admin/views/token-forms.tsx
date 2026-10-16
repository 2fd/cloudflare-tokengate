// Service token forms: the submitted values as strings (so a rejected form re-renders what was
// typed), their parsing into op inputs, and the field groups the create cards and the token page
// share. The secret is never part of the values and never rendered back (I-CRED-1); a re-render
// carries a sealed draft instead (A13.6, ADR 0020). Field ids carry a per-form prefix
// (`f-slack-credential`), and errors name `<prefix>.<field>` so the ErrorSummary links to them.
import type { Child } from 'hono/jsx';
import type { Service } from '../../db/types';
import type { Injection, VerifyCheck } from '../../policy/types';
import type { FieldError } from '../ops/shared';
import type { VerifyOutcome } from '../ops/verify';
import type { FormFields } from '../render';
import {
  Checkbox,
  Field,
  fieldId,
  RadioCards,
  Select,
  type Suggestion,
  TextArea,
} from './components';
import { formatTime } from './format';

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Every token form field except the secret, as submitted. */
export interface TokenFormValues {
  template: string;
  slug: string;
  name: string;
  description: string;
  credential_expires_at: string;
  base_url: string;
  injection_kind: string;
  injection_header_name: string;
  injection_header_prefix: string;
  injection_username: string;
  injection_param: string;
  injection_path_prefix: string;
  forward_headers: string;
  timeout_ms: string;
  verify_method: string;
  verify_path: string;
  verify_expect_status: string;
  verify_expect_ok_field: boolean;
  also_uploads: boolean;
  allow_host: string;
  /** Sibling token ids ticked on the rotate form, comma separated. */
  also_replace: string;
  confirm_destination: string;
  expected_updated_at: string;
}

export const EMPTY_VALUES: TokenFormValues = {
  template: '',
  slug: '',
  name: '',
  description: '',
  credential_expires_at: '',
  base_url: '',
  injection_kind: 'bearer',
  injection_header_name: '',
  injection_header_prefix: '',
  injection_username: '',
  injection_param: '',
  injection_path_prefix: '',
  forward_headers: '',
  timeout_ms: String(DEFAULT_TIMEOUT_MS),
  verify_method: 'GET',
  verify_path: '',
  verify_expect_status: '200',
  verify_expect_ok_field: false,
  also_uploads: false,
  allow_host: '',
  also_replace: '',
  confirm_destination: '',
  expected_updated_at: '',
};

const FLAGS = new Set<keyof TokenFormValues>(['verify_expect_ok_field', 'also_uploads']);

export function text(form: FormFields, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
}

export function texts(form: FormFields, name: string): string[] {
  const value = form[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export function flag(form: FormFields, name: string): boolean {
  const value = text(form, name);
  return value === '1' || value === 'on';
}

export function valuesFromForm(form: FormFields): TokenFormValues {
  const out = { ...EMPTY_VALUES };
  for (const key of Object.keys(EMPTY_VALUES) as Array<keyof TokenFormValues>) {
    if (FLAGS.has(key)) (out[key] as boolean) = flag(form, key);
    else if (key === 'also_replace') out.also_replace = texts(form, key).join(',');
    else if (form[key] !== undefined) (out[key] as string) = text(form, key);
  }
  return out;
}

export function injectionValues(injection: Injection): Partial<TokenFormValues> {
  const fields: Partial<TokenFormValues> = { injection_kind: injection.kind };
  if (injection.kind === 'header') {
    fields.injection_header_name = injection.name;
    fields.injection_header_prefix = injection.prefix ?? '';
  } else if (injection.kind === 'basic') {
    fields.injection_username = injection.username ?? '';
  } else if (injection.kind === 'query') {
    fields.injection_param = injection.param;
  } else if (injection.kind === 'path') {
    fields.injection_path_prefix = injection.prefix ?? '';
  }
  return fields;
}

function verifyValues(verify: VerifyCheck | null): Partial<TokenFormValues> {
  if (!verify) return { verify_method: 'GET', verify_path: '', verify_expect_status: '200' };
  return {
    verify_method: verify.method,
    verify_path: verify.path,
    verify_expect_status: String(verify.expect_status),
    verify_expect_ok_field: verify.expect_ok_field === true,
  };
}

/** A stored token as form values (details and destination forms). */
export function valuesFromService(service: Service): TokenFormValues {
  return {
    ...EMPTY_VALUES,
    slug: service.slug,
    name: service.name,
    description: service.description,
    base_url: service.base_url,
    ...injectionValues(service.injection),
    forward_headers: service.forward_headers.join(', '),
    timeout_ms: String(service.timeout_ms),
    ...verifyValues(service.verify),
    credential_expires_at: dateInput(service.credential_expires_at),
    expected_updated_at: String(service.updated_at),
  };
}

/** The injection object for the selected kind; ops validate it (normalizeInjection). */
export function injectionFromValues(values: TokenFormValues): unknown {
  switch (values.injection_kind) {
    case 'bearer':
      return { kind: 'bearer' };
    case 'header':
      // HTTP header names are case-insensitive; the stored form is lower case.
      return {
        kind: 'header',
        name: values.injection_header_name.trim().toLowerCase(),
        prefix: values.injection_header_prefix,
      };
    case 'basic':
      return { kind: 'basic', username: values.injection_username.trim() };
    case 'query':
      return { kind: 'query', param: values.injection_param.trim() };
    case 'path':
      return { kind: 'path', prefix: values.injection_path_prefix.trim() };
    default:
      return { kind: values.injection_kind };
  }
}

export function forwardHeadersFromValues(values: TokenFormValues): string[] {
  return values.forward_headers
    .split(/[\n,]/)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
}

export function timeoutFromValues(values: TokenFormValues): number {
  const raw = values.timeout_ms.trim();
  return raw === '' ? DEFAULT_TIMEOUT_MS : Number(raw);
}

/** An empty check path means "no check". */
export function verifyFromValues(values: TokenFormValues): VerifyCheck | null {
  const path = values.verify_path.trim();
  if (path === '') return null;
  return {
    method: (values.verify_method === 'POST' ? 'POST' : values.verify_method) as 'GET' | 'POST',
    path,
    expect_status: Number(values.verify_expect_status.trim()),
    expect_ok_field: values.verify_expect_ok_field,
  };
}

/** `YYYY-MM-DD` (UTC midnight) → ms; empty → null. */
export function parseDateInput(raw: string): { ok: true; value: number | null } | { ok: false } {
  const value = raw.trim();
  if (value === '') return { ok: true, value: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { ok: false };
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { ok: false };
  return { ok: true, value: ms };
}

export function dateInput(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString().slice(0, 10);
}

export const EXPIRY_FORMAT_ERROR = 'Enter the expiry as a date like 2027-01-31, or leave it empty';

// ---------------------------------------------------------------------------------------------
// Form state and ids

/** A form re-rendered after a failed POST. */
export interface FormState {
  values: TokenFormValues;
  /** Fields are plain form field names here; the views add the form prefix. */
  errors: FieldError[];
  /** The sealed draft of the submitted secret (A13.6), with its hint. */
  draft: { value: string; hint: string } | null;
  /** The failed credential check, shown next to the secret with "Save without a passing check". */
  verify: VerifyOutcome | null;
}

/** Field ids and error lookup of one form (`prefix` is the card id or the page form name). */
export class FormIds {
  constructor(
    readonly prefix: string,
    private readonly errors: readonly FieldError[] = [],
  ) {}

  id(name: string): string {
    return fieldId(`${this.prefix}.${name}`);
  }

  error(...names: string[]): string | null {
    const messages = this.errors
      .filter((error) => error.field !== null && names.includes(error.field))
      .map((error) => error.message);
    return messages.length > 0 ? messages.join('. ') : null;
  }

  has(...names: string[]): boolean {
    return this.error(...names) !== null;
  }
}

/** Errors as the ErrorSummary links them: `<prefix>.<field>` → `#f-<prefix>-<field>`. */
export function summaryErrors(prefix: string, errors: readonly FieldError[]): FieldError[] {
  return errors.map((error) =>
    error.field === null ? error : { field: `${prefix}.${error.field}`, message: error.message },
  );
}

/** A label inside a sentence: "Enter the bot token", but "Enter the API key". */
export function inSentence(label: string): string {
  return /^[A-Z]{2}/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/**
 * "Secret kept for 15 minutes (…WXYZ, 34 characters). …" (A13.6), from the hint normalizeCredential
 * computed ("…WXYZ (34 chars)" or "8 chars"): it follows the stored-hint rule, so it is about the
 * secret part only (the password of username:password) and shows its last 4 characters only when
 * that part has at least 20 (I-CRED-1). Never pass the secret itself.
 */
export function draftHint(hint: string | null): string {
  const long = hint === null ? null : /^(…\S{4}) \((\d+) chars\)$/.exec(hint);
  const short = hint === null ? null : /^(\d+) chars$/.exec(hint);
  const shown = long ? `${long[1]}, ${long[2]} characters` : short ? `${short[1]} characters` : '';
  return `Secret kept for 15 minutes${shown ? ` (${shown})` : ''}. Leave this field empty to use it, or enter another.`;
}

// ---------------------------------------------------------------------------------------------
// Field groups

/** The secret input (A7.8): password type, no autofill, a fake exact-format example. */
export function SecretField(props: {
  ids: FormIds;
  label: string;
  placeholder: string;
  hint: Child;
  pattern?: string;
  draft: FormState['draft'];
}) {
  const { ids } = props;
  return (
    <>
      <Field
        name="credential"
        id={ids.id('credential')}
        label={props.label}
        type="password"
        autocomplete="off"
        example={props.placeholder}
        required={props.draft === null}
        optional={false}
        pattern={props.pattern}
        hint={
          props.draft ? (
            <>
              {props.hint} {props.draft.hint}
            </>
          ) : (
            props.hint
          )
        }
        error={ids.error('credential', 'credential_draft')}
      />
      {props.draft ? (
        <input type="hidden" name="credential_draft" value={props.draft.value} />
      ) : null}
    </>
  );
}

export function ExpiryField(props: {
  ids: FormIds;
  values: TokenFormValues;
  /** `min` = today (UTC); the details form has none, so a stored past date still saves. */
  min?: string;
  hint: Child;
  label?: string;
}) {
  return (
    <Field
      name="credential_expires_at"
      id={props.ids.id('credential_expires_at')}
      label={props.label ?? 'Secret expires on'}
      type="date"
      optional
      autocomplete="off"
      value={props.values.credential_expires_at}
      min={props.min}
      hint={props.hint}
      error={props.ids.error('credential_expires_at')}
    />
  );
}

/** Name, slug, description and expiry of a new token: all optional, derived when empty. */
export function OptionalFields(props: {
  ids: FormIds;
  values: TokenFormValues;
  slugPlaceholder: string;
  namePlaceholder: string;
  proxyOrigin: string;
  /** False for GitHub types: the expiry is read from GitHub. */
  expiry: boolean;
  today: string;
  /** How an empty slug and name are derived; default: the placeholders are the derived values. */
  derived?: { slug: string; name: string };
}) {
  const { ids, values } = props;
  return (
    <>
      <Field
        name="name"
        id={ids.id('name')}
        label="Name"
        optional
        autocomplete="off"
        value={values.name}
        example={props.namePlaceholder}
        maxlength={100}
        hint={`Shown to people who give access. ${props.derived?.name ?? 'Leave empty to use the placeholder.'}`}
        error={ids.error('name')}
      />
      <Field
        name="slug"
        id={ids.id('slug')}
        label="Slug"
        optional
        autocomplete="off"
        spellcheck={false}
        autocapitalize="none"
        value={values.slug}
        example={props.slugPlaceholder}
        pattern="[a-z0-9][a-z0-9\-]{0,62}"
        maxlength={63}
        hint={
          <>
            Consumers call <code>{`${props.proxyOrigin}/proxy/<slug>`}</code>. Lower-case letters,
            digits and dashes. Cannot be changed later.{' '}
            {props.derived?.slug ?? 'Leave empty to use the placeholder.'}
          </>
        }
        error={ids.error('slug')}
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
      {props.expiry ? (
        <ExpiryField
          ids={ids}
          values={values}
          min={props.today}
          hint="Leave empty if it does not expire. The Overview warns 14 days before."
        />
      ) : null}
    </>
  );
}

export const INJECTION_LABELS: Readonly<Record<Injection['kind'], string>> = {
  bearer: 'Bearer token: "Authorization: Bearer <secret>" (most APIs)',
  header: 'Custom header, e.g. "x-api-key: <secret>"',
  basic: 'HTTP Basic authentication',
  path: 'Part of the URL path (webhooks such as Slack or Discord)',
  query: 'Query parameter (not recommended)',
};

export const QUERY_WARNING =
  'Query parameter injection puts the secret in the URL. Upstreams may echo URLs in error messages or logs; prefer header injection when the API supports it.';

export const PATH_WARNING =
  'With URL path injection the secret is part of the webhook URL. Some webhook APIs return it in the response body: Discord GET and PATCH on the webhook URL return the webhook token. Response bodies are not redacted, so give consumers only POST / on these tokens.';

const HEADER_NAME_DEFAULTS = ['x-api-key', 'api-key', 'x-auth-token', 'x-api-token'];
const QUERY_PARAM_DEFAULTS = ['api_key', 'key', 'token', 'access_token'];
const HEADER_PREFIXES = ['Token ', 'Bearer ', 'Key ', 'Api-Key '];

/** Header names and query parameters existing tokens use, first, then common ones. */
export function injectionSuggestions(tokens: readonly Service[]): {
  headerNames: Suggestion[];
  params: Suggestion[];
} {
  const used = (pick: (injection: Injection) => string | null) =>
    tokens.map((token) => pick(token.injection)).filter((value): value is string => !!value);
  const unique = (values: string[]) => [...new Set(values)].map((value) => ({ value }));
  return {
    headerNames: unique([
      ...used((injection) => (injection.kind === 'header' ? injection.name : null)),
      ...HEADER_NAME_DEFAULTS,
    ]),
    params: unique([
      ...used((injection) => (injection.kind === 'query' ? injection.param : null)),
      ...QUERY_PARAM_DEFAULTS,
    ]),
  };
}

/** "How the secret is sent": 5 kinds as cards, each kind's sub-fields revealed with it. */
export function InjectionFields(props: {
  ids: FormIds;
  values: TokenFormValues;
  tokens: readonly Service[];
}) {
  const { ids, values } = props;
  const suggestions = injectionSuggestions(props.tokens);
  const prefixes = [
    ...HEADER_PREFIXES,
    ...(values.injection_header_prefix !== '' &&
    !HEADER_PREFIXES.includes(values.injection_header_prefix)
      ? [values.injection_header_prefix]
      : []),
  ];
  return (
    <RadioCards
      name="injection_kind"
      legend="How the secret is sent"
      idPrefix={ids.id('injection_kind')}
      value={values.injection_kind}
      hint="Check the API's authentication docs."
      error={ids.error('injection_kind')}
      options={[
        { value: 'bearer', title: INJECTION_LABELS.bearer },
        {
          value: 'header',
          title: INJECTION_LABELS.header,
          reveal: (
            <>
              <Field
                name="injection_header_name"
                id={ids.id('injection_header_name')}
                label="Header name"
                conditional
                autocomplete="off"
                spellcheck={false}
                autocapitalize="none"
                maxlength={64}
                value={values.injection_header_name}
                example="x-api-key"
                suggestions={suggestions.headerNames}
                hint="Lower-case header name, e.g. x-api-key. Not a reserved header."
                error={ids.error('injection_header_name')}
              />
              <Select
                name="injection_header_prefix"
                id={ids.id('injection_header_prefix')}
                label="Text before the secret"
                conditional
                value={values.injection_header_prefix}
                options={[
                  { value: '', label: '(none)' },
                  ...prefixes.map((prefix) => ({
                    value: prefix,
                    label: prefix.endsWith(' ') ? `${prefix.trimEnd()} + space` : prefix,
                  })),
                ]}
                hint="Text sent before the secret."
                error={ids.error('injection_header_prefix')}
              />
            </>
          ),
        },
        {
          value: 'basic',
          title: INJECTION_LABELS.basic,
          reveal: (
            <Field
              name="injection_username"
              id={ids.id('injection_username')}
              label="Username"
              optional
              conditional
              autocomplete="off"
              spellcheck={false}
              maxlength={256}
              value={values.injection_username}
              example="apikey"
              hint="Leave empty if the secret is username:password."
              error={ids.error('injection_username')}
            />
          ),
        },
        {
          value: 'path',
          title: INJECTION_LABELS.path,
          reveal: (
            <>
              <p class="hint">{PATH_WARNING}</p>
              <Field
                name="injection_path_prefix"
                id={ids.id('injection_path_prefix')}
                label="Path before the secret"
                optional
                conditional
                autocomplete="off"
                spellcheck={false}
                autocapitalize="none"
                maxlength={256}
                value={values.injection_path_prefix}
                example="/bot"
                hint="Path before the secret, e.g. Telegram /bot. Usually empty."
                error={ids.error('injection_path_prefix')}
              />
            </>
          ),
        },
        {
          value: 'query',
          title: INJECTION_LABELS.query,
          reveal: (
            <>
              <p class="hint">{QUERY_WARNING}</p>
              <Field
                name="injection_param"
                id={ids.id('injection_param')}
                label="Query parameter name"
                conditional
                autocomplete="off"
                spellcheck={false}
                autocapitalize="none"
                maxlength={64}
                value={values.injection_param}
                example="api_key"
                suggestions={suggestions.params}
                hint="Letters, digits and . _ ~ -"
                error={ids.error('injection_param')}
              />
            </>
          ),
        },
      ]}
    />
  );
}

const TIMEOUTS: ReadonlyArray<[number, string]> = [
  [30_000, '30 seconds'],
  [60_000, '1 minute'],
  [120_000, '2 minutes'],
  [300_000, '5 minutes'],
  [600_000, '10 minutes'],
  [900_000, '15 minutes'],
];

const STATUSES = ['200', '201', '204'];

/**
 * Forward headers, timeout and the check, in a collapsed "Advanced (optional)" details: nothing
 * in it carries native validation (A7.6). Opens when one of its fields has an error.
 */
export function AdvancedFields(props: {
  ids: FormIds;
  values: TokenFormValues;
  tokens: readonly Service[];
  /** Template check headers, shown read-only and kept on save. */
  verifyHeaders?: Record<string, string>;
}) {
  const { ids, values } = props;
  const timeout = Number(values.timeout_ms);
  const timeouts = TIMEOUTS.some(([ms]) => ms === timeout)
    ? TIMEOUTS
    : [...TIMEOUTS, [timeout, `${values.timeout_ms} ms`] as [number, string]];
  const statuses = STATUSES.includes(values.verify_expect_status)
    ? STATUSES
    : [...STATUSES, values.verify_expect_status];
  const inUse = [...new Set(props.tokens.flatMap((token) => token.forward_headers))].sort();
  const open = ids.has(
    'forward_headers',
    'timeout_ms',
    'verify_path',
    'verify_method',
    'verify_expect_status',
  );
  return (
    <details class="advanced" open={open}>
      <summary>Advanced (optional)</summary>
      <div class="stack">
        <Field
          name="forward_headers"
          id={ids.id('forward_headers')}
          label="Extra headers consumers may send"
          optional
          conditional
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
          maxlength={1024}
          value={values.forward_headers}
          example="openai-organization, openai-beta"
          hint={
            <>
              Comma separated. Common headers such as content-type and accept are always passed
              through; all others are dropped.
              {inUse.length > 0 ? <> In use by other tokens: {inUse.join(', ')}.</> : null}
            </>
          }
          error={ids.error('forward_headers')}
        />
        <Select
          name="timeout_ms"
          id={ids.id('timeout_ms')}
          label="Timeout"
          conditional
          value={values.timeout_ms}
          options={timeouts.map(([ms, label]) => ({ value: String(ms), label }))}
          hint="How long to wait for the upstream to start answering."
          error={ids.error('timeout_ms')}
        />
        <fieldset>
          <legend>Secret check</legend>
          <Field
            name="verify_path"
            id={ids.id('verify_path')}
            label="Check path"
            optional
            conditional
            autocomplete="off"
            spellcheck={false}
            autocapitalize="none"
            maxlength={512}
            value={values.verify_path}
            example="/v1/models"
            hint="A read-only path that proves the secret works. Empty: no check."
            error={ids.error('verify_path')}
          />
          <Select
            name="verify_method"
            id={ids.id('verify_method')}
            label="Check method"
            conditional
            value={values.verify_method === 'POST' ? 'POST' : 'GET'}
            options={[
              { value: 'GET', label: 'GET' },
              { value: 'POST', label: 'POST' },
            ]}
            error={ids.error('verify_method')}
          />
          <Select
            name="verify_expect_status"
            id={ids.id('verify_expect_status')}
            label="Expected HTTP status"
            conditional
            value={values.verify_expect_status}
            options={statuses.map((status) => ({ value: status, label: status }))}
            error={ids.error('verify_expect_status')}
          />
          <Checkbox
            name="verify_expect_ok_field"
            id={ids.id('verify_expect_ok_field')}
            label='Response JSON must have "ok": true (Slack-style)'
            checked={values.verify_expect_ok_field}
          />
          {props.verifyHeaders && Object.keys(props.verifyHeaders).length > 0 ? (
            <p class="hint">
              The check also sends{' '}
              {Object.entries(props.verifyHeaders).map(([name, value], index) => (
                <>
                  {index > 0 ? ', ' : ''}
                  <code>
                    {name}: {value}
                  </code>
                </>
              ))}{' '}
              (set by the token type; kept).
            </p>
          ) : null}
        </fieldset>
      </div>
    </details>
  );
}

/** The result of a credential check: preview of the upstream answer, the reported expiry. */
export function VerifyResult(props: { verify: VerifyOutcome; title?: string }) {
  const { verify } = props;
  const status = verify.status === null ? '' : ` (HTTP ${verify.status})`;
  return (
    <div class={verify.passed ? 'check-result passed' : 'check-result failed'}>
      <p>
        <strong>{verify.passed ? 'Check passed' : 'Check failed'}</strong>
        {status}
        {verify.passed ? '.' : `: ${verify.error ?? 'unknown error'}.`}
      </p>
      {verify.bodyPreview ? (
        <>
          <p class="hint">Start of the upstream response (any copy of the secret is masked):</p>
          <pre>{verify.bodyPreview}</pre>
        </>
      ) : null}
      {verify.expiresAt !== null ? (
        <p>The upstream reports that this secret expires {formatTime(verify.expiresAt)}.</p>
      ) : null}
    </div>
  );
}

/**
 * The submits of a form that sends the secret: the primary first in tree order; after a failed
 * check, "Check again and save" plus `save_anyway` (the draft keeps the secret).
 */
export function SecretSubmits(props: {
  label: string;
  context?: string;
  failedCheck: boolean;
  extra?: Child;
}) {
  return (
    <div class="actions">
      <button type="submit" class="primary">
        {props.failedCheck ? 'Check again and save' : props.label}
        {props.context ? <span class="vh"> {props.context}</span> : null}
      </button>
      {props.failedCheck ? (
        <button type="submit" name="save_anyway" value="1" class="secondary">
          Save without a passing check
          {props.context ? <span class="vh"> {props.context}</span> : null}
        </button>
      ) : null}
      {props.extra}
    </div>
  );
}

/** `https://(api\.github\.com|[a-z0-9\-.]+\.slack\.com)(\/[^?#\s]*)?` from the allowlist. */
export function allowlistPattern(hosts: readonly string[]): string {
  const escape = (host: string) => host.replace(/\./g, '\\.');
  const alternatives = hosts.map((entry) =>
    entry.startsWith('*.') ? `[a-z0-9\\-.]+\\.${escape(entry.slice(2))}` : escape(entry),
  );
  return `https://(${alternatives.join('|')})(\\/[^?#\\s]*)?`;
}

/** Base URL suggestions: `https://<host>` per literal allowlist entry, then existing base URLs. */
export function baseUrlSuggestions(
  allowlist: readonly string[] | null,
  tokens: readonly Service[],
): Suggestion[] {
  const values = [
    ...(allowlist ?? [])
      .filter((entry) => !entry.startsWith('*.'))
      .map((host) => `https://${host}`),
    ...tokens.map((token) => token.base_url),
  ];
  return [...new Set(values)].map((value) => ({ value }));
}
