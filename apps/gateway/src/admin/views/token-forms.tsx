// Credential forms: the submitted values as strings (so a rejected form re-renders what was
// typed), their parsing into op inputs, and the field groups the create cards and the token page
// share, built on @tokengate/ui. The secret is never part of the values and never rendered back
// (I-CRED-1); a re-render carries a sealed draft instead (A13.6, ADR 0020). Field ids carry a
// per-form prefix (`f-slack-credential`), and errors name `<prefix>.<field>` so the ErrorSummary
// links to them. Controls in a hidden branch (a Reveal, a closed More) carry no native validation:
// the server checks them (A7.6).
import {
  Button,
  Callout,
  Checkbox as UiCheckbox,
  CodeBlock,
  Field,
  FieldGrid,
  FieldSet,
  firstChoiceId,
  Input,
  More,
  RadioCards as UiRadioCards,
  Reveal,
  Select as UiSelect,
  SubmitRow,
  type Suggestion,
  Textarea,
} from '@tokengate/ui';
import { type Child, useContext } from 'hono/jsx';
import type { Service } from '../../db/types';
import type { Injection, VerifyCheck } from '../../policy/types';
import type { FieldError } from '../ops/shared';
import type { VerifyOutcome } from '../ops/verify';
import type { FormFields } from '../render';
import { fieldId, FocusTargets } from './components';
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

/**
 * The secret input (A7.8): a ui secret (password type, mono, ignored by password managers, never
 * a value), a fake exact-format placeholder, and after a failed submit the kept draft as a note
 * plus its hidden field. A `credential_draft` error is shown here and its summary link lands here.
 */
export function SecretField(props: {
  ids: FormIds;
  label: string;
  placeholder: string;
  hint: Child;
  pattern?: string;
  draft: FormState['draft'];
}) {
  const { ids } = props;
  // The summary entry of a draft error links to this visible input, not to the hidden field.
  useContext(FocusTargets)?.set(ids.id('credential_draft'), ids.id('credential'));
  return (
    <>
      <Field
        id={ids.id('credential')}
        label={props.label}
        hint={props.hint}
        error={ids.error('credential', 'credential_draft') ?? undefined}
        note={props.draft ? <DraftNote hint={props.draft.hint} /> : undefined}
      >
        <Input
          name="credential"
          secret
          placeholder={props.placeholder}
          pattern={props.pattern}
          required={props.draft === null ? true : undefined}
        />
      </Field>
      {props.draft ? (
        <input type="hidden" name="credential_draft" value={props.draft.value} />
      ) : null}
    </>
  );
}

/** "Secret kept for 15 minutes (…WXYZ, 34 characters)." in bold, then what to do. */
function DraftNote(props: { hint: string }) {
  const at = props.hint.indexOf('. ');
  if (at < 0) return <>{props.hint}</>;
  return (
    <>
      <b class="t-ok">{props.hint.slice(0, at + 1)}</b>
      {props.hint.slice(at + 1)}
    </>
  );
}

export function ExpiryField(props: {
  ids: FormIds;
  values: TokenFormValues;
  /** `min` = today (UTC); the details form has none, so a stored past date still saves. */
  min?: string;
  hint?: Child;
  label?: string;
  optional?: boolean;
  class?: string;
  /** A hint shared with other fields (the "Name and options" hint). */
  describedBy?: string;
}) {
  return (
    <Field
      id={props.ids.id('credential_expires_at')}
      label={props.label ?? 'Secret expires on'}
      optional={props.optional}
      hint={props.hint}
      error={props.ids.error('credential_expires_at') ?? undefined}
      class={props.class}
    >
      <Input
        name="credential_expires_at"
        type="date"
        width="date"
        value={props.values.credential_expires_at}
        min={props.min}
        describedBy={props.describedBy}
      />
    </Field>
  );
}

const DESCRIPTION_EXAMPLE = 'Bot "deploy-bot" in workspace acme; owner: platform team';

/**
 * Name, slug, expiry and description of a new token, as one optional group ("Name and options")
 * with one shared hint: every field is derived when left empty.
 */
export function OptionalFields(props: {
  ids: FormIds;
  values: TokenFormValues;
  slugPlaceholder: string;
  namePlaceholder: string;
  /** False for GitHub types: the expiry is read from GitHub. */
  expiry: boolean;
  today: string;
  /** How an empty slug and name are derived; default: the suggestions shown are the derived values. */
  derived?: { slug: string; name: string };
}) {
  const { ids, values } = props;
  const groupId = ids.id('options');
  const hintId = `${groupId}-hint`;
  return (
    <FieldSet
      id={groupId}
      legend="Name and options"
      optional
      hint={
        <>
          {props.derived
            ? `Slug: ${props.derived.slug} Name: ${props.derived.name}`
            : 'Leave empty to use the suggestions shown.'}{' '}
          {props.expiry ? 'An empty expiry means the secret does not expire. ' : ''}
          Consumers call <code>{`/proxy/${props.slugPlaceholder}`}</code>; the slug cannot be
          changed later.
        </>
      }
    >
      <FieldGrid>
        <Field id={ids.id('name')} label="Name" error={ids.error('name') ?? undefined}>
          <Input
            name="name"
            value={values.name}
            placeholder={props.namePlaceholder}
            maxlength={100}
            autocomplete="off"
            describedBy={hintId}
          />
        </Field>
        <Field id={ids.id('slug')} label="Slug" error={ids.error('slug') ?? undefined}>
          <Input
            name="slug"
            mono
            value={values.slug}
            placeholder={props.slugPlaceholder}
            pattern="[a-z0-9][a-z0-9\-]{0,62}"
            maxlength={63}
            describedBy={hintId}
          />
        </Field>
        {props.expiry ? (
          <ExpiryField
            ids={ids}
            values={values}
            label="Secret expires"
            min={props.today}
            describedBy={hintId}
          />
        ) : null}
        <Field
          id={ids.id('description')}
          label="Description"
          hint="Which account the secret belongs to and who owns it. Access managers see this."
          error={ids.error('description') ?? undefined}
          class="span-all"
        >
          <Textarea
            name="description"
            rows={2}
            maxlength={2000}
            value={values.description}
            placeholder={DESCRIPTION_EXAMPLE}
          />
        </Field>
      </FieldGrid>
    </FieldSet>
  );
}

/** Name, description and expiry of a stored token (the details form). */
export function DetailFields(props: { ids: FormIds; values: TokenFormValues; example: string }) {
  const { ids, values } = props;
  return (
    <>
      <Field id={ids.id('name')} label="Name" error={ids.error('name') ?? undefined}>
        <Input
          name="name"
          value={values.name}
          placeholder={props.example}
          required
          maxlength={100}
          autocomplete="off"
        />
      </Field>
      <Field
        id={ids.id('description')}
        label="Description"
        optional
        hint="Which account the secret belongs to and who owns it. Access managers see this."
        error={ids.error('description') ?? undefined}
      >
        <Textarea
          name="description"
          rows={2}
          maxlength={2000}
          value={values.description}
          placeholder={DESCRIPTION_EXAMPLE}
        />
      </Field>
      <ExpiryField
        ids={ids}
        values={values}
        optional
        hint="Fix the expiry without pasting the secret again. Empty = does not expire."
      />
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

const INJECTION_KINDS = ['bearer', 'header', 'basic', 'path', 'query'] as const;

/**
 * "How the secret is sent": 5 kinds as radio cards (live slot 1), each kind's sub-fields in a
 * Reveal shown while it is checked. The form or disclosure around it carries `lform`. Nothing in
 * a Reveal is required or typed: the server validates the sub-fields of the chosen kind.
 */
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
  const groupId = ids.id('injection_kind');
  const options = INJECTION_KINDS.map((kind) => ({ value: kind, title: INJECTION_LABELS[kind] }));
  useContext(FocusTargets)?.set(groupId, firstChoiceId(groupId, options));
  const error = ids.error('injection_kind');
  const option = (kind: (typeof INJECTION_KINDS)[number]) => INJECTION_KINDS.indexOf(kind) + 1;
  return (
    <>
      <FieldSet
        id={groupId}
        legend="How the secret is sent"
        hint="Check the API's authentication docs."
        error={error ?? undefined}
        live={1}
      >
        <UiRadioCards
          name="injection_kind"
          columns={1}
          value={values.injection_kind}
          invalid={error ? true : undefined}
          options={options}
        />
      </FieldSet>
      <Reveal field={1} option={option('header')}>
        <Field
          id={ids.id('injection_header_name')}
          label="Header name"
          neededFor="Custom header"
          hint="Lower-case header name, e.g. x-api-key. Not a reserved header."
          error={ids.error('injection_header_name') ?? undefined}
        >
          <Input
            name="injection_header_name"
            mono
            maxlength={64}
            value={values.injection_header_name}
            placeholder="x-api-key"
            suggestions={suggestions.headerNames}
          />
        </Field>
        <Field
          id={ids.id('injection_header_prefix')}
          label="Text before the secret"
          hint="Text sent before the secret."
          error={ids.error('injection_header_prefix') ?? undefined}
        >
          <UiSelect
            name="injection_header_prefix"
            value={values.injection_header_prefix}
            options={[
              { value: '', label: '(none)' },
              ...prefixes.map((prefix) => ({
                value: prefix,
                label: prefix.endsWith(' ') ? `${prefix.trimEnd()} + space` : prefix,
              })),
            ]}
          />
        </Field>
      </Reveal>
      <Reveal field={1} option={option('basic')}>
        <Field
          id={ids.id('injection_username')}
          label="Username"
          optional
          hint="Leave empty if the secret is username:password."
          error={ids.error('injection_username') ?? undefined}
        >
          <Input
            name="injection_username"
            mono
            maxlength={256}
            value={values.injection_username}
            placeholder="apikey"
          />
        </Field>
      </Reveal>
      <Reveal field={1} option={option('path')}>
        <p class="hint">{PATH_WARNING}</p>
        <Field
          id={ids.id('injection_path_prefix')}
          label="Path before the secret"
          optional
          hint="Path before the secret, e.g. Telegram /bot. Usually empty."
          error={ids.error('injection_path_prefix') ?? undefined}
        >
          <Input
            name="injection_path_prefix"
            mono
            maxlength={256}
            value={values.injection_path_prefix}
            placeholder="/bot"
          />
        </Field>
      </Reveal>
      <Reveal field={1} option={option('query')}>
        <p class="hint">{QUERY_WARNING}</p>
        <Field
          id={ids.id('injection_param')}
          label="Query parameter name"
          neededFor="Query parameter"
          hint="Letters, digits and . _ ~ -"
          error={ids.error('injection_param') ?? undefined}
        >
          <Input
            name="injection_param"
            mono
            maxlength={64}
            value={values.injection_param}
            placeholder="api_key"
            suggestions={suggestions.params}
          />
        </Field>
      </Reveal>
    </>
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
 * Forward headers, timeout and the check, in a collapsed "Advanced (optional)" More: nothing in
 * it carries native validation (A7.6). Opens when one of its fields has an error.
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
    <More summary="Advanced (optional)" meta="extra headers, timeout, secret check" open={open}>
      <Field
        id={ids.id('forward_headers')}
        label="Extra headers consumers may send"
        optional
        hint={
          <>
            Comma separated. Common headers such as content-type and accept are always passed
            through; all others are dropped.
            {inUse.length > 0 ? <> In use by other tokens: {inUse.join(', ')}.</> : null}
          </>
        }
        error={ids.error('forward_headers') ?? undefined}
      >
        <Input
          name="forward_headers"
          mono
          maxlength={1024}
          value={values.forward_headers}
          placeholder="openai-organization, openai-beta"
        />
      </Field>
      <Field
        id={ids.id('timeout_ms')}
        label="Timeout"
        hint="How long to wait for the upstream to start answering."
        error={ids.error('timeout_ms') ?? undefined}
      >
        <UiSelect
          name="timeout_ms"
          value={values.timeout_ms}
          options={timeouts.map(([ms, label]) => ({ value: String(ms), label }))}
        />
      </Field>
      <FieldSet id={ids.id('verify')} legend="Secret check">
        <Field
          id={ids.id('verify_path')}
          label="Check path"
          optional
          hint="A read-only path that proves the secret works. Empty: no check."
          error={ids.error('verify_path') ?? undefined}
        >
          <Input
            name="verify_path"
            mono
            maxlength={512}
            value={values.verify_path}
            placeholder="/v1/models"
          />
        </Field>
        <Field
          id={ids.id('verify_method')}
          label="Check method"
          error={ids.error('verify_method') ?? undefined}
        >
          <UiSelect
            name="verify_method"
            value={values.verify_method === 'POST' ? 'POST' : 'GET'}
            options={[
              { value: 'GET', label: 'GET' },
              { value: 'POST', label: 'POST' },
            ]}
          />
        </Field>
        <Field
          id={ids.id('verify_expect_status')}
          label="Expected HTTP status"
          error={ids.error('verify_expect_status') ?? undefined}
        >
          <UiSelect
            name="verify_expect_status"
            value={values.verify_expect_status}
            options={statuses.map((status) => ({ value: status, label: status }))}
          />
        </Field>
        <UiCheckbox
          name="verify_expect_ok_field"
          id={ids.id('verify_expect_ok_field')}
          value="1"
          checked={values.verify_expect_ok_field}
        >
          Response JSON must have "ok": true (Slack-style)
        </UiCheckbox>
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
            (set by the credential type; kept).
          </p>
        ) : null}
      </FieldSet>
    </More>
  );
}

/** "Check passed (HTTP 200)." or "Check failed (HTTP 401): invalid key." */
export function checkTitle(verify: VerifyOutcome): string {
  const status = verify.status === null ? '' : ` (HTTP ${verify.status})`;
  return verify.passed
    ? `Check passed${status}.`
    : `Check failed${status}: ${verify.error ?? 'unknown error'}.`;
}

/**
 * The result of a credential check: a callout with the outcome and the reported expiry, then the
 * start of the upstream answer (any copy of the secret is masked). `role="status"` right after
 * a Test, so the result is announced.
 */
export function CheckResult(props: {
  verify: VerifyOutcome;
  /** Name of the upstream answer block ("Slack response"). */
  label?: string;
  announce?: boolean;
}) {
  const { verify } = props;
  return (
    <>
      <Callout
        tone={verify.passed ? 'ok' : 'bad'}
        role={props.announce ? 'status' : undefined}
        title={checkTitle(verify)}
        more={
          verify.expiresAt !== null
            ? `The upstream reports that this secret expires ${formatTime(verify.expiresAt)}.`
            : undefined
        }
      />
      {verify.bodyPreview ? (
        <CodeBlock
          label={props.label ?? 'Upstream response'}
          caption="Start of the upstream response (any copy of the secret is masked)"
        >
          {verify.bodyPreview}
        </CodeBlock>
      ) : null}
    </>
  );
}

export const SAVE_ANYWAY_HINT =
  'Saving without a passing check stores the secret as it is. The token page shows the failed check until a test passes, and consumers get the upstream’s error.';

/**
 * The submits of a form that sends the secret (a SubmitRow): the primary first in tree order;
 * after a failed check, "Check again and save" plus `save_anyway` (the draft keeps the secret).
 * `secondary` for a form under a page header that already holds the page's primary.
 */
export function SecretSubmits(props: {
  label: string;
  context?: string;
  failedCheck: boolean;
  id?: string;
  /** After the submits on the row (a docs link). */
  extra?: Child;
  secondary?: boolean;
}) {
  return (
    <SubmitRow id={props.id} hint={props.failedCheck ? SAVE_ANYWAY_HINT : undefined}>
      <Button
        variant={props.secondary && !props.failedCheck ? 'secondary' : 'primary'}
        type="submit"
        srSuffix={props.context}
      >
        {props.failedCheck ? 'Check again and save' : props.label}
      </Button>
      {props.failedCheck ? (
        <Button type="submit" name="save_anyway" value="1" srSuffix={props.context}>
          Save without a passing check
        </Button>
      ) : null}
      {props.extra}
    </SubmitRow>
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
