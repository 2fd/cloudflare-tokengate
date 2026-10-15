// Admin pages for services: list, create (optionally from a template), detail, settings edit, and a
// separate credential form. The destination (base URL + injection) changes only together with a
// re-entered credential (I-CRED-2); submitted credentials are never rendered back (I-CRED-1).
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { App } from '../../app';
import { loadKeyring } from '../../crypto/keyring';
import { listCallerProviders } from '../../db/caller-providers';
import { grantCountsByService, listGrants } from '../../db/grants';
import { getService, listServices } from '../../db/services';
import type { Service } from '../../db/types';
import type { AppEnv } from '../../env';
import type { Injection, Rule, VerifyCheck } from '../../policy/types';
import { EXPIRY_WARNING_MS } from '../../telemetry/dashboard';
import { can } from '../auth/rbac';
import {
  createService,
  deleteService,
  opContextFor,
  type StoredBinding,
  setServiceCredential,
  storedBinding,
  testServiceCredential,
  updateServiceFields,
} from '../ops/services';
import type { OpFailure, OpFailureReason } from '../ops/shared';
import type { VerifyOutcome } from '../ops/verify';
import { paths, returnPath } from '../paths';
import {
  type AdminContext,
  adminActor,
  formData,
  redirectWithNotice,
  renderPage,
  submittedVersion,
} from '../render';
import { getServiceTemplate, SERVICE_TEMPLATES, type ServiceTemplate } from '../service-templates';
import { formatTime } from '../views/format';
import {
  ActionButton,
  Badge,
  Checkbox,
  Csrf,
  Details,
  EmptyState,
  EnabledBadge,
  Field,
  Messages,
  Select,
  TextArea,
  VersionField,
  type Banner,
  legacyNotice,
} from '../views/legacy';

const DEFAULT_TIMEOUT_MS = 120_000;

const NOTICES: Record<string, string> = {
  created: 'Service created without a credential.',
  created_with_credential: 'Service created and its credential stored.',
  created_verified: 'Service created; the credential check against the upstream passed.',
  created_unverified: 'Service created. The credential was stored although its check failed.',
  updated: 'Settings saved.',
  unchanged: 'Nothing changed: the submitted values are the current ones.',
  credential_saved: 'Credential saved.',
  credential_verified: 'Credential saved; the check against the upstream passed.',
  credential_unverified: 'Credential saved although its check failed.',
  enabled: 'Service enabled. Callers with a matching grant can use it again.',
  disabled: 'Service disabled. Proxied requests to it are refused from now on.',
  deleted: 'Service deleted.',
};

const FAILURE_STATUS: Record<OpFailureReason, ContentfulStatusCode> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  acknowledgement_required: 422,
  confirmation_required: 422,
  verify_failed: 422,
  unavailable: 503,
};

const INJECTION_KINDS: Array<{ value: Injection['kind']; label: string }> = [
  { value: 'bearer', label: 'Bearer token: "Authorization: Bearer <credential>" (most APIs)' },
  { value: 'header', label: 'Custom header, e.g. "x-api-key: <credential>"' },
  { value: 'basic', label: 'HTTP Basic authentication' },
  { value: 'path', label: 'Part of the URL path (webhooks such as Slack or Discord)' },
  { value: 'query', label: 'Query parameter (not recommended)' },
];

const QUERY_WARNING =
  'Query parameter injection puts the credential in the URL. Upstreams may echo URLs in error messages or logs; prefer header injection when the API supports it.';

const PATH_WARNING =
  'With URL path injection the credential is part of the webhook URL. Some webhook APIs return it in the response body: Discord GET and PATCH on the webhook URL return the webhook token. Response bodies are not redacted, so grant only POST / for these services.';

export function registerTokensRoutes(app: App): void {
  app.get('/admin/tokens', listPage);
  // Registered before `/admin/tokens/:id` so "new" is never taken as an id.
  app.get('/admin/tokens/new', newPage);
  app.post('/admin/tokens', create);
  app.get('/admin/tokens/:id', detailPage);
  app.post('/admin/tokens/:id', update);
  app.post('/admin/tokens/:id/credential', setCredential);
  app.post('/admin/tokens/:id/test', testCredential);
  app.post('/admin/tokens/:id/toggle', toggle);
  app.post('/admin/tokens/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Form values as submitted strings, so a rejected form re-renders what was typed. The credential
// is not part of this shape: it is never rendered back (I-CRED-1).

interface ServiceForm {
  template: string;
  slug: string;
  name: string;
  description: string;
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
  credential_expires_at: string;
  /** `updated_at` the settings form was opened at; empty on create. */
  expected_updated_at: string;
  /** Host typed to confirm the destination when the stored binding is unattested (I-CRED-2). */
  confirm_destination: string;
}

const EMPTY_FORM: ServiceForm = {
  template: '',
  slug: '',
  name: '',
  description: '',
  base_url: '',
  injection_kind: 'bearer',
  injection_header_name: '',
  injection_header_prefix: '',
  injection_username: '',
  injection_param: '',
  injection_path_prefix: '',
  forward_headers: '',
  timeout_ms: String(DEFAULT_TIMEOUT_MS),
  verify_method: '',
  verify_path: '',
  verify_expect_status: '200',
  verify_expect_ok_field: false,
  credential_expires_at: '',
  expected_updated_at: '',
  confirm_destination: '',
};

type FormFields = Awaited<ReturnType<typeof formData>>;

function text(form: FormFields, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
}

function flag(form: FormFields, name: string): boolean {
  const value = text(form, name);
  return value === '1' || value === 'on';
}

function formFromRequest(form: FormFields): ServiceForm {
  const out = { ...EMPTY_FORM };
  for (const key of Object.keys(EMPTY_FORM) as Array<keyof ServiceForm>) {
    if (key === 'verify_expect_ok_field') out[key] = flag(form, key);
    else out[key] = text(form, key);
  }
  return out;
}

function injectionFields(injection: Injection): Partial<ServiceForm> {
  const fields: Partial<ServiceForm> = { injection_kind: injection.kind };
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

function verifyFields(verify: VerifyCheck | null): Partial<ServiceForm> {
  if (!verify) return { verify_method: '', verify_path: '', verify_expect_status: '200' };
  return {
    verify_method: verify.method,
    verify_path: verify.path,
    verify_expect_status: String(verify.expect_status),
    verify_expect_ok_field: verify.expect_ok_field === true,
  };
}

function formFromTemplate(template: ServiceTemplate): ServiceForm {
  return {
    ...EMPTY_FORM,
    template: template.id,
    slug: template.slug,
    name: template.name,
    base_url: template.base_url,
    ...injectionFields(template.injection),
    forward_headers: template.forward_headers.join('\n'),
    timeout_ms: String(template.timeout_ms),
    ...verifyFields(template.verify),
  };
}

function formFromService(service: Service): ServiceForm {
  return {
    ...EMPTY_FORM,
    slug: service.slug,
    name: service.name,
    description: service.description,
    base_url: service.base_url,
    ...injectionFields(service.injection),
    forward_headers: service.forward_headers.join('\n'),
    timeout_ms: String(service.timeout_ms),
    ...verifyFields(service.verify),
    credential_expires_at: dateInput(service.credential_expires_at),
    expected_updated_at: String(service.updated_at),
  };
}

/** The injection object for the selected kind; ops validate it (normalizeInjection). */
function injectionFromForm(values: ServiceForm): unknown {
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

function forwardHeadersFromForm(values: ServiceForm): string[] {
  return values.forward_headers
    .split(/[\n,]/)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
}

/** Empty means "use the default" (create) or "keep the current value" (edit). */
function timeoutFromForm(values: ServiceForm): number | undefined {
  const raw = values.timeout_ms.trim();
  return raw === '' ? undefined : Number(raw);
}

function verifyFromForm(values: ServiceForm): VerifyCheck | null {
  if (values.verify_method === '') return null;
  return {
    method: values.verify_method as VerifyCheck['method'],
    path: values.verify_path.trim(),
    expect_status: Number(values.verify_expect_status.trim()),
    expect_ok_field: values.verify_expect_ok_field,
  };
}

/** `YYYY-MM-DD` (UTC midnight) → ms; empty → null. */
function parseDateInput(raw: string): { ok: true; value: number | null } | { ok: false } {
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

function dateInput(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString().slice(0, 10);
}

const EXPIRY_FORMAT_ERROR = 'the credential expiry must be a date such as 2027-01-31';

// ---------------------------------------------------------------------------------------------
// Handlers

async function listPage(c: AdminContext) {
  const deps = c.get('deps');
  const [services, grantCounts] = await Promise.all([
    listServices(deps.env.DB),
    grantCountsByService(deps.env.DB),
  ]);
  const canWrite = can(c.get('viewer').user.role, 'tokens:write');
  const now = deps.now();
  return renderPage(
    c,
    {
      title: 'Services',
      section: 'tokens',
      subsection: 'tokens',
      notice: legacyNotice(noticeFor(c)),
    },
    () => (
      <>
        <p class="muted">
          A service is an upstream API (for example Slack or OpenAI) plus the credential the gateway
          attaches to requests. Callers never see the credential.
        </p>
        {canWrite ? (
          <p class="actions">
            <a href={paths.tokenNew()}>Add a service</a>
          </p>
        ) : null}
        {services.length === 0 ? (
          <EmptyState>
            No services yet.{' '}
            {canWrite ? (
              <>
                <a href={paths.tokenNew()}>Add your first service</a> — templates for Slack, OpenAI,
                Anthropic and GitHub are available.
              </>
            ) : (
              'Ask an admin to add one.'
            )}{' '}
            See <code>docs/getting-started.md</code> for a walkthrough.
          </EmptyState>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Slug</th>
                <th scope="col">Name</th>
                <th scope="col">Upstream host</th>
                <th scope="col">Injection</th>
                <th scope="col">Credential</th>
                <th scope="col">Status</th>
                <th scope="col">Grants</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr>
                  <td>
                    <a href={paths.token(service.id)}>
                      <code>{service.slug}</code>
                    </a>
                  </td>
                  <td>{service.name}</td>
                  <td>{upstreamHost(service.base_url)}</td>
                  <td>{service.injection.kind}</td>
                  <td>
                    <CredentialStatus service={service} now={now} />
                  </td>
                  <td>
                    <EnabledBadge enabled={service.enabled} />
                  </td>
                  <td>{grantCounts.get(service.id) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    ),
  );
}

async function newPage(c: AdminContext) {
  const template = getServiceTemplate(c.req.query('template') ?? '');
  const values = template ? formFromTemplate(template) : { ...EMPTY_FORM };
  return renderNewForm(c, { values });
}

async function create(c: AdminContext) {
  const deps = c.get('deps');
  const form = await formData(c);
  const values = formFromRequest(form);
  const expiry = parseDateInput(values.credential_expires_at);
  if (!expiry.ok) return renderNewForm(c, { values, errors: [EXPIRY_FORMAT_ERROR], status: 400 });

  const secret = text(form, 'credential');
  const result = await createService(
    deps,
    adminActor(c),
    {
      slug: values.slug.trim(),
      name: values.name,
      description: values.description,
      base_url: values.base_url,
      injection: injectionFromForm(values),
      forward_headers: forwardHeadersFromForm(values),
      timeout_ms: timeoutFromForm(values),
      verify: verifyFromForm(values),
      credential_expires_at: expiry.value,
      secret,
      save_anyway: flag(form, 'save_anyway'),
    },
    opContextFor(new URL(c.req.url)),
  );
  if (!result.ok) {
    return renderNewForm(c, {
      values,
      ...failureView(result),
      credentialEntered: secret.trim() !== '',
      status: FAILURE_STATUS[result.reason],
    });
  }
  const notice = !result.service.credential_set
    ? 'created'
    : result.verify === null
      ? 'created_with_credential'
      : result.verify.passed
        ? 'created_verified'
        : 'created_unverified';
  return redirectWithNotice(c, paths.token(result.service.id), notice);
}

async function detailPage(c: AdminContext) {
  const service = await getService(c.get('deps').env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  return renderDetail(c, service, { notice: noticeFor(c) });
}

async function update(c: AdminContext) {
  const deps = c.get('deps');
  const service = await getService(deps.env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const values = formFromRequest(await formData(c));
  const editState = (errors: string[], warnings: string[] = []) => ({
    edit: { values, errors, warnings },
  });
  const expiry = parseDateInput(values.credential_expires_at);
  if (!expiry.ok)
    return renderDetail(c, service, { ...editState([EXPIRY_FORMAT_ERROR]), status: 400 });

  // The form shows dates only; an unchanged date keeps the stored time of day.
  const expiresAt =
    values.credential_expires_at.trim() === dateInput(service.credential_expires_at)
      ? service.credential_expires_at
      : expiry.value;
  const result = await updateServiceFields(deps, adminActor(c), service.id, {
    name: values.name,
    description: values.description,
    forward_headers: forwardHeadersFromForm(values),
    timeout_ms: timeoutFromForm(values),
    verify: verifyFromForm(values),
    credential_expires_at: expiresAt,
    expected_updated_at: submittedVersion(values.expected_updated_at),
  });
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    return renderDetail(c, service, {
      ...editState(result.errors, result.warnings),
      status: FAILURE_STATUS[result.reason],
    });
  }
  return redirectWithNotice(
    c,
    paths.token(service.id),
    result.changed === false ? 'unchanged' : 'updated',
  );
}

async function setCredential(c: AdminContext) {
  const deps = c.get('deps');
  const service = await getService(deps.env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const form = await formData(c);
  const values = formFromRequest(form);
  const expiry = parseDateInput(values.credential_expires_at);
  if (!expiry.ok) {
    return renderDetail(c, service, {
      credential: { values, errors: [EXPIRY_FORMAT_ERROR], warnings: [], verify: null },
      status: 400,
    });
  }
  const result = await setServiceCredential(
    deps,
    adminActor(c),
    service.id,
    {
      base_url: values.base_url,
      injection: injectionFromForm(values),
      secret: text(form, 'credential'),
      save_anyway: flag(form, 'save_anyway'),
      // Undefined: the op uses the expiry the credential check reports (GitHub), else none.
      credential_expires_at: expiry.value ?? undefined,
      confirm_destination: values.confirm_destination,
    },
    opContextFor(new URL(c.req.url)),
  );
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    return renderDetail(c, service, {
      credential: { values, ...failureView(result) },
      status: FAILURE_STATUS[result.reason],
    });
  }
  const notice =
    result.verify === null
      ? 'credential_saved'
      : result.verify.passed
        ? 'credential_verified'
        : 'credential_unverified';
  return redirectWithNotice(c, paths.token(service.id), notice);
}

async function testCredential(c: AdminContext) {
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
    return renderDetail(c, service, {
      actionErrors: result.errors,
      status: FAILURE_STATUS[result.reason],
    });
  }
  // Rendered directly (no redirect): the result is shown once and not stored.
  return renderDetail(c, service, { test: result.verify });
}

async function toggle(c: AdminContext) {
  const deps = c.get('deps');
  const service = await getService(deps.env.DB, c.req.param('id') ?? '');
  if (!service) return notFound(c);
  const form = await formData(c);
  const requested = text(form, 'enabled');
  if (requested !== '1' && requested !== '0') {
    return renderDetail(c, service, {
      actionErrors: ['choose whether to enable or disable the service'],
      status: 400,
    });
  }
  // A disable passes `enabled` alone, so it never depends on the stored row validating.
  const enabled = requested === '1';
  const result = await updateServiceFields(deps, adminActor(c), service.id, { enabled });
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    return renderDetail(c, service, {
      actionErrors: result.errors,
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
  if (!flag(await formData(c), 'confirm')) {
    return renderDetail(c, service, {
      actionErrors: ['tick the confirmation box to delete the service'],
      status: 400,
    });
  }
  const result = await deleteService(deps, adminActor(c), service.id);
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(c);
    return renderDetail(c, service, {
      actionErrors: result.errors,
      status: FAILURE_STATUS[result.reason],
    });
  }
  return redirectWithNotice(c, paths.tokens(), 'deleted');
}

function noticeFor(c: AdminContext): string | null {
  const key = c.req.query('notice');
  return key !== undefined && Object.hasOwn(NOTICES, key) ? (NOTICES[key] ?? null) : null;
}

/** A failed op as form messages; a failed check is shown by <VerifyResult> instead of as text. */
function failureView(failure: OpFailure & { verify?: VerifyOutcome }) {
  const verify = failure.verify ?? null;
  return {
    errors: failure.reason === 'verify_failed' ? [] : failure.errors,
    warnings: failure.warnings,
    verify,
  };
}

function notFound(c: AdminContext) {
  return renderPage(
    c,
    { title: 'Service not found', section: 'tokens', subsection: 'tokens', status: 404 },
    () => (
      <p>
        This service does not exist or was deleted. <a href={paths.tokens()}>Back to services</a>
      </p>
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// New service page

function renderNewForm(
  c: AdminContext,
  state: {
    values: ServiceForm;
    errors?: string[];
    warnings?: string[];
    verify?: VerifyOutcome | null;
    /** A credential was submitted; it is not rendered back and must be entered again. */
    credentialEntered?: boolean;
    status?: ContentfulStatusCode;
  },
) {
  const { values } = state;
  const template = getServiceTemplate(values.template);
  const csrf = c.get('viewer').csrfToken;
  return renderPage(
    c,
    { title: 'Add a service', section: 'tokens', subsection: 'tokens', status: state.status },
    () => (
      <>
        {template ? <TemplateGuidance template={template} /> : <TemplatePicker />}
        {state.verify && !state.verify.passed ? (
          <p class="banner error" role="alert">
            The credential check failed, so nothing was saved. The result is shown above the Create
            button.
          </p>
        ) : null}
        <Messages errors={state.errors} warnings={state.warnings} />
        <form method="post" action={paths.tokens()} class="stack">
          <Csrf token={csrf} />
          <input type="hidden" name="template" value={template?.id ?? ''} />
          <fieldset>
            <legend>Basics</legend>
            <Field
              label="Slug"
              name="slug"
              value={values.slug}
              required
              placeholder="openai"
              hint={
                <>
                  Short name used in the proxy address: callers send requests to{' '}
                  <code>/proxy/&lt;slug&gt;/…</code>. Lower-case letters, digits and dashes. It
                  cannot be changed later.
                </>
              }
            />
            <NameFields values={values} />
          </fieldset>
          <fieldset>
            <legend>Upstream API</legend>
            <DestinationFields values={values} />
          </fieldset>
          <fieldset>
            <legend>Credential</legend>
            <CredentialInput required={false} reentry={state.credentialEntered === true} />
            <ExpiryField values={values} />
          </fieldset>
          <OptionsFields values={values} />
          <VerifyFields values={values} />
          {state.verify ? <VerifyResult verify={state.verify} /> : null}
          {state.verify && !state.verify.passed ? <SaveAnyway /> : null}
          <p class="actions">
            <button type="submit">Create service</button>
            <a href={paths.tokens()}>Cancel</a>
          </p>
        </form>
      </>
    ),
  );
}

function TemplatePicker() {
  return (
    <section>
      <h2>Start from a template</h2>
      <p class="muted">
        Templates fill in the address, injection and a credential check for common APIs. You can
        change every value before saving, or fill in the form below from scratch.
      </p>
      <ul>
        {SERVICE_TEMPLATES.map((template) => (
          <li>
            <a href={paths.tokenNew({ template: template.id })}>{template.label}</a>{' '}
            <span class="muted">{template.base_url}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TemplateGuidance(props: { template: ServiceTemplate }) {
  const { template } = props;
  return (
    <section>
      <p>
        Using the <strong>{template.label}</strong> template.{' '}
        <a href={paths.tokenNew()}>Choose another template or start from scratch</a>
      </p>
      <p class="muted">
        {template.notes} Provider documentation: <a href={template.docs_url}>{template.docs_url}</a>
      </p>
      <StarterRules rules={template.starter_rules} />
    </section>
  );
}

function StarterRules(props: { rules: readonly Rule[] }) {
  if (props.rules.length === 0) return null;
  return (
    <>
      <h2>Suggested grant rules</h2>
      <p class="muted">
        A grant decides which callers may use this service and which requests they may make. When
        you create one, these rules are a starting point; narrow them to what callers need (one rule
        per line: methods, then path pattern).
      </p>
      <pre>{props.rules.map(ruleText).join('\n')}</pre>
    </>
  );
}

function ruleText(rule: Rule): string {
  return `${rule.methods.join(',')} ${rule.path}`;
}

// ---------------------------------------------------------------------------------------------
// Form sections shared by the create and detail pages

function NameFields(props: { values: ServiceForm }) {
  return (
    <>
      <Field
        label="Name"
        name="name"
        value={props.values.name}
        required
        placeholder="OpenAI"
        hint="Display name shown in this admin UI."
      />
      <TextArea
        label="Description (optional)"
        name="description"
        value={props.values.description}
        rows={2}
        hint="Notes for other admins, e.g. which account the credential belongs to and who owns it."
      />
    </>
  );
}

function DestinationFields(props: { values: ServiceForm }) {
  const { values } = props;
  return (
    <>
      <Field
        label="Base URL"
        name="base_url"
        type="url"
        value={values.base_url}
        required
        placeholder="https://api.example.com/v1"
        hint="The upstream API address. Callers can only reach paths under it. Must start with https:// and contain no query string."
      />
      <Select
        label="How the credential is sent"
        name="injection_kind"
        value={values.injection_kind}
        options={INJECTION_KINDS}
        hint="Check the API's authentication docs. Fill in the matching option below; the others are ignored."
      />
      {values.injection_kind === 'query' ? <p class="banner warning">{QUERY_WARNING}</p> : null}
      {values.injection_kind === 'path' ? <p class="banner warning">{PATH_WARNING}</p> : null}
      <Field
        label="Header name (custom header only)"
        name="injection_header_name"
        value={values.injection_header_name}
        placeholder="x-api-key"
        hint="The request header that carries the credential, e.g. x-api-key."
      />
      <Field
        label="Header value prefix (custom header only, optional)"
        name="injection_header_prefix"
        value={values.injection_header_prefix}
        placeholder="Token "
        hint='Text placed before the credential, including any space, e.g. "Token ". Leave empty for none.'
      />
      <Field
        label="Username (Basic authentication only, optional)"
        name="injection_username"
        value={values.injection_username}
        hint='Leave empty if you enter the credential as "username:password".'
      />
      <Field
        label="Query parameter name (query parameter only)"
        name="injection_param"
        value={values.injection_param}
        placeholder="api_key"
        hint={QUERY_WARNING}
      />
      <Field
        label="Path prefix (URL path only, optional)"
        name="injection_path_prefix"
        value={values.injection_path_prefix}
        placeholder="/bot"
        hint="Text before the credential in the URL path, e.g. /bot for Telegram. Leave empty for Slack and Discord webhooks. Grant only POST / on webhook services: Discord GET and PATCH on the webhook URL return the token in the response body."
      />
    </>
  );
}

function CredentialInput(props: { required: boolean; reentry: boolean }) {
  return (
    <>
      {props.reentry ? (
        <p class="banner warning">
          For safety the credential you entered is not shown again. Enter it again to save.
        </p>
      ) : null}
      <Field
        label={props.required ? 'Credential' : 'Credential (optional)'}
        name="credential"
        type="password"
        autocomplete="new-password"
        required={props.required}
        hint={
          <>
            The API key or token from the upstream provider. It is encrypted before it is stored and
            can never be viewed again; only its length and last 4 characters are shown.
            {props.required ? '' : ' Leave empty to add it later.'}
          </>
        }
      />
    </>
  );
}

function ExpiryField(props: { values: ServiceForm }) {
  return (
    <Field
      label="Credential expires on (optional, UTC)"
      name="credential_expires_at"
      type="date"
      value={props.values.credential_expires_at}
      hint="When the credential stops working, if the provider told you. The dashboard warns 14 days before. GitHub tokens report this automatically when checked."
    />
  );
}

function OptionsFields(props: { values: ServiceForm }) {
  const { values } = props;
  return (
    <fieldset>
      <legend>Request options</legend>
      <TextArea
        label="Extra headers callers may send (optional)"
        name="forward_headers"
        value={values.forward_headers}
        rows={3}
        hint="One lower-case header name per line, e.g. openai-beta. Common headers such as content-type and accept are always passed through; all others are dropped."
      />
      <Field
        label="Timeout (milliseconds)"
        name="timeout_ms"
        type="number"
        value={values.timeout_ms}
        hint="How long to wait for the upstream to start answering: 1000 to 900000. 120000 is 2 minutes; use more for slow APIs such as AI models."
      />
    </fieldset>
  );
}

function VerifyFields(props: { values: ServiceForm }) {
  const { values } = props;
  return (
    <fieldset>
      <legend>Credential check (optional)</legend>
      <p class="muted">
        A request the gateway makes to confirm a credential works when you save or test it. Pick a
        cheap, read-only endpoint, e.g. <code>GET /models</code>.
      </p>
      <Select
        label="Check method"
        name="verify_method"
        value={values.verify_method}
        options={[
          { value: '', label: 'No check' },
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
        ]}
      />
      <Field
        label="Check path"
        name="verify_path"
        value={values.verify_path}
        placeholder="/models"
        hint="Path under the base URL."
      />
      <Field
        label="Expected HTTP status"
        name="verify_expect_status"
        type="number"
        value={values.verify_expect_status}
        hint="The status that means the credential works, usually 200."
      />
      <Checkbox
        label='Also require "ok": true in the JSON response'
        name="verify_expect_ok_field"
        checked={values.verify_expect_ok_field}
        hint="For Slack-style APIs that answer 200 even when the token is wrong."
      />
    </fieldset>
  );
}

function SaveAnyway() {
  return (
    <Checkbox
      label="Save the credential even though the check failed"
      name="save_anyway"
      hint="Use this only if you know the credential works, e.g. the check endpoint is temporarily down."
    />
  );
}

function VerifyResult(props: { verify: VerifyOutcome }) {
  const { verify } = props;
  const status = verify.status === null ? '' : ` (HTTP ${verify.status})`;
  return (
    <section>
      {verify.passed ? (
        <p class="banner info" role="status">
          Credential check passed{status}.
        </p>
      ) : (
        <p class="banner error" role="alert">
          Credential check failed{status}: {verify.error ?? 'unknown error'}
        </p>
      )}
      {verify.bodyPreview ? (
        <>
          <p class="muted">
            Start of the upstream response (any copy of the credential is masked):
          </p>
          <pre>{verify.bodyPreview}</pre>
        </>
      ) : null}
      {verify.expiresAt !== null ? (
        <p>The upstream reports that this credential expires {formatTime(verify.expiresAt)}.</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail page

interface DetailState {
  status?: ContentfulStatusCode;
  notice?: string | null;
  /** Errors of the single-button actions (test, toggle, delete). */
  actionErrors?: string[];
  test?: VerifyOutcome;
  edit?: { values: ServiceForm; errors: string[]; warnings: string[] };
  credential?: {
    values: ServiceForm;
    errors: string[];
    warnings: string[];
    verify: VerifyOutcome | null;
  };
}

async function renderDetail(c: AdminContext, service: Service, state: DetailState) {
  const deps = c.get('deps');
  const [grants, callerProviders] = await Promise.all([
    listGrants(deps.env.DB, { service_id: service.id }),
    listCallerProviders(deps.env.DB),
  ]);
  const providerNames = new Map(callerProviders.map((provider) => [provider.id, provider.name]));
  const viewer = c.get('viewer');
  const canWrite = can(viewer.user.role, 'tokens:write');
  const csrf = viewer.csrfToken;
  const now = deps.now();
  const proxyUrl = `${new URL(c.req.url).origin}/proxy/${service.slug}`;
  const template = SERVICE_TEMPLATES.find(
    (candidate) =>
      candidate.base_url === service.base_url &&
      candidate.injection.kind === service.injection.kind,
  );
  const stored = formFromService(service);
  const banners: Banner[] = [];
  const binding = await loadBinding(deps.env, service);
  if (binding.status === 'unattested') {
    banners.push({ level: 'error', text: bindingBannerText(binding, canWrite) });
  }
  if (!service.credential_sealed) {
    banners.push({
      level: 'warning',
      text: `No credential is stored yet, so proxied requests to this service fail. ${
        canWrite
          ? 'Add it under "Change credential or destination" below.'
          : 'Ask an admin to add it.'
      }`,
    });
  }
  if (service.injection.kind === 'query') banners.push({ level: 'warning', text: QUERY_WARNING });
  if (service.injection.kind === 'path') banners.push({ level: 'info', text: PATH_WARNING });

  return renderPage(
    c,
    {
      title: `Service: ${service.name}`,
      section: 'tokens',
      subsection: 'tokens',
      notice: legacyNotice(state.notice ?? null),
      status: state.status,
      legacyBanners: banners,
    },
    () => (
      <>
        <p>
          <a href={paths.tokens()}>← All services</a>
        </p>
        {/* Results of the action just submitted go first: the re-rendered page opens at the top. */}
        <Messages errors={state.actionErrors} />
        {state.test ? <VerifyResult verify={state.test} /> : null}
        {state.edit ? <FormProblem anchor="settings" section="Settings" /> : null}
        {state.credential ? (
          <FormProblem
            anchor="change-credential"
            section="Change credential or destination"
            verifyFailed={state.credential.verify?.passed === false}
          />
        ) : null}
        <Details
          rows={[
            ['Slug', <code>{service.slug}</code>],
            ['ID', <code>{service.id}</code>],
            ['Status', <EnabledBadge enabled={service.enabled} />],
            [
              'Proxy address',
              <>
                <code>{proxyUrl}</code>
                <br />
                <small class="muted">
                  Callers send requests here; the rest of the path is appended to the base URL.
                </small>
              </>,
            ],
            // An unattested stored destination is shown as unconfirmed so it is not copied into the
            // credential form as if it were known good (I-CRED-2).
            [
              'Base URL',
              <>
                <code>{service.base_url}</code>
                {binding.status === 'unattested' ? <Unconfirmed /> : null}
              </>,
            ],
            [
              'Credential sent as',
              <>
                {injectionText(service.injection)}
                {binding.status === 'unattested' ? <Unconfirmed /> : null}
              </>,
            ],
            [
              'Extra forwarded headers',
              service.forward_headers.length ? (
                service.forward_headers.map((name) => <code>{name} </code>)
              ) : (
                <span class="muted">none</span>
              ),
            ],
            ['Timeout', `${service.timeout_ms} ms`],
            ['Credential check', verifyText(service.verify)],
            ['Description', service.description || <span class="muted">none</span>],
            ['Created', formatTime(service.created_at)],
            ['Updated', formatTime(service.updated_at)],
          ]}
        />

        <h2>Credential</h2>
        <Details
          rows={[
            [
              'Status',
              <CredentialStatus
                service={service}
                now={now}
                unusable={binding.status === 'unattested'}
              />,
            ],
            ['Last set', formatTime(service.credential_updated_at)],
            ['Expires', formatTime(service.credential_expires_at)],
          ]}
        />
        {canWrite ? <TestButton service={service} csrf={csrf} /> : null}

        <h2>Grants using this service</h2>
        <GrantsTable grants={grants} providerNames={providerNames} />
        {canWrite ? (
          <p>
            <a href={paths.accessNew({ token: service.id })}>Create a grant for this service</a>
          </p>
        ) : null}
        {template ? <StarterRules rules={template.starter_rules} /> : null}

        {canWrite ? (
          <>
            <h2>Enable or disable</h2>
            <p class="muted">
              {service.enabled
                ? 'Disabling refuses every proxied request to this service from the next request on. Grants and the credential are kept.'
                : 'This service is disabled: proxied requests to it are refused.'}
            </p>
            <p class="actions">
              <ActionButton
                action={`${paths.token(service.id)}/toggle`}
                csrf={csrf}
                label={service.enabled ? 'Disable service' : 'Enable service'}
                danger={service.enabled}
                fields={{ enabled: service.enabled ? '0' : '1' }}
              />
            </p>

            <h2 id="settings">Settings</h2>
            <EditForm
              service={service}
              csrf={csrf}
              values={state.edit?.values ?? stored}
              errors={state.edit?.errors}
              warnings={state.edit?.warnings}
            />

            <h2 id="change-credential">Change credential or destination</h2>
            <CredentialForm
              service={service}
              csrf={csrf}
              values={state.credential?.values ?? credentialFormValues(stored, binding)}
              errors={state.credential?.errors}
              warnings={state.credential?.warnings}
              verify={state.credential?.verify ?? null}
              reentry={state.credential !== undefined}
              confirmDestination={binding.status === 'unattested'}
            />

            <h2>Delete</h2>
            <DeleteSection service={service} grantCount={grants.length} csrf={csrf} />
          </>
        ) : null}
      </>
    ),
  );
}

/** Binding state for the page; unknown (no banner) when the keyring does not load. */
async function loadBinding(
  appEnv: AppEnv,
  service: Service,
): Promise<StoredBinding | { status: 'unknown' }> {
  const keyring = await loadKeyring(appEnv);
  if (!keyring.ok) return { status: 'unknown' };
  return storedBinding(appEnv.DB, keyring.keyring, service);
}

function bindingBannerText(
  binding: Extract<StoredBinding, { status: 'unattested' }>,
  canWrite: boolean,
): string {
  const cause =
    binding.error === 'credential_binding_mismatch'
      ? binding.keyChanged === false
        ? 'The base URL or the way the credential is sent was changed outside the admin UI: the stored credential no longer matches them, and the encryption key is unchanged.'
        : 'The stored credential does not match this service: either its base URL or the way the credential is sent was changed outside the admin UI, or the key behind its key id was replaced (see Settings).'
      : binding.error === 'keyring_missing_key'
        ? 'The stored credential was encrypted with a key that is no longer in the keyring, so the stored base URL and injection cannot be confirmed.'
        : 'The stored credential is damaged, so the stored base URL and injection cannot be confirmed.';
  return `${cause} Treat this as possible tampering: a credential entered now goes to the base URL you submit. ${
    canWrite
      ? "Check the base URL and injection against an out-of-band source (the provider's documentation, your configuration as code) before you enter the credential again. The audit log is not a reliable reference: anyone who can edit the database can edit it too."
      : 'Ask an admin to check the service.'
  }`;
}

/**
 * Credential form defaults. An unattested stored destination is not prefilled: the admin enters
 * it from an out-of-band source instead of resubmitting a possibly tampered value (I-CRED-2).
 */
function credentialFormValues(
  stored: ServiceForm,
  binding: StoredBinding | { status: 'unknown' },
): ServiceForm {
  if (binding.status !== 'unattested') return { ...stored, credential_expires_at: '' };
  return {
    ...stored,
    base_url: '',
    injection_kind: EMPTY_FORM.injection_kind,
    injection_header_name: '',
    injection_header_prefix: '',
    injection_username: '',
    injection_param: '',
    injection_path_prefix: '',
    credential_expires_at: '',
  };
}

function Unconfirmed() {
  return (
    <>
      {' '}
      <Badge tone="bad">not confirmed</Badge>
      <br />
      <small class="muted">
        May have been changed outside the admin UI. Do not copy it into the credential form.
      </small>
    </>
  );
}

function ConfirmDestinationField(props: { values: ServiceForm }) {
  return (
    <Field
      name="confirm_destination"
      label="Confirm destination host"
      value={props.values.confirm_destination}
      required
      hint="The stored destination cannot be confirmed. After you check the base URL above against an out-of-band source, type its host, for example api.github.com. Nothing is sent to the upstream until this matches."
    />
  );
}

/** Points from the top of the page to a form further down that was re-shown with errors. */
function FormProblem(props: { anchor: string; section: string; verifyFailed?: boolean }) {
  return (
    <p class="banner error" role="alert">
      {props.verifyFailed ? 'The credential check failed, so nothing was saved.' : 'Not saved.'} See{' '}
      <a href={`#${props.anchor}`}>{props.section}</a> below.
    </p>
  );
}

function TestButton(props: { service: Service; csrf: string }) {
  const { service } = props;
  if (!service.credential_sealed) {
    return <p class="muted">No credential is stored yet. Add one below.</p>;
  }
  if (!service.verify) {
    return (
      <p class="muted">
        Configure a credential check under Settings to test the stored credential from here.
      </p>
    );
  }
  return (
    <p class="actions">
      <ActionButton
        action={`${paths.token(service.id)}/test`}
        csrf={props.csrf}
        label="Test credential"
      />
      <small class="muted">
        Sends the credential check ({verifyText(service.verify)}) to the upstream now.
      </small>
    </p>
  );
}

function GrantsTable(props: {
  grants: Array<{
    id: string;
    name: string;
    caller_provider_id: string;
    enabled: boolean;
    expires_at: number | null;
  }>;
  providerNames: Map<string, string>;
}) {
  if (props.grants.length === 0) {
    return (
      <EmptyState>
        No grant uses this service yet, so no caller can reach it. A grant says which callers (for
        example which repositories) may call it and which requests they may make.
      </EmptyState>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Grant</th>
          <th scope="col">Caller provider</th>
          <th scope="col">Status</th>
          <th scope="col">Expires</th>
        </tr>
      </thead>
      <tbody>
        {props.grants.map((grant) => (
          <tr>
            <td>
              <a href={paths.accessItem(grant.id)}>{grant.name}</a>
            </td>
            <td>
              <a href={paths.consumer(grant.caller_provider_id)}>
                {props.providerNames.get(grant.caller_provider_id) ?? grant.caller_provider_id}
              </a>
            </td>
            <td>
              <EnabledBadge enabled={grant.enabled} />
            </td>
            <td>{formatTime(grant.expires_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditForm(props: {
  service: Service;
  csrf: string;
  values: ServiceForm;
  errors?: string[];
  warnings?: string[];
}) {
  const { values } = props;
  return (
    <form method="post" action={paths.token(props.service.id)} class="stack">
      <Csrf token={props.csrf} />
      <VersionField value={values.expected_updated_at} />
      <p class="muted">
        These settings do not affect the stored credential. The slug cannot be changed; the base URL
        and the way the credential is sent are changed together with the credential below.
      </p>
      <Messages errors={props.errors} warnings={props.warnings} />
      <NameFields values={values} />
      <OptionsFields values={values} />
      <VerifyFields values={values} />
      <ExpiryField values={values} />
      <p class="actions">
        <button type="submit">Save settings</button>
      </p>
    </form>
  );
}

function CredentialForm(props: {
  service: Service;
  csrf: string;
  values: ServiceForm;
  errors?: string[];
  warnings?: string[];
  verify: VerifyOutcome | null;
  reentry: boolean;
  /** The stored binding is unattested: ask for the destination host (I-CRED-2). */
  confirmDestination: boolean;
}) {
  const { service, values } = props;
  return (
    <form method="post" action={`${paths.token(service.id)}/credential`} class="stack">
      <Csrf token={props.csrf} />
      <p class="muted">
        Use this form to replace the credential, or to change where and how it is sent. The
        credential is encrypted together with the base URL and the way it is sent, so changing the
        destination or injection requires re-entering the credential. The expiry date applies to the
        new credential: leave it empty if it does not expire.
        {service.verify ? ' The credential check runs before anything is saved.' : ''}
      </p>
      <Messages errors={props.errors} warnings={props.warnings} />
      <DestinationFields values={values} />
      {props.confirmDestination ? <ConfirmDestinationField values={values} /> : null}
      <CredentialInput required reentry={props.reentry} />
      <ExpiryField values={values} />
      {props.verify ? <VerifyResult verify={props.verify} /> : null}
      {props.verify && !props.verify.passed ? <SaveAnyway /> : null}
      <p class="actions">
        <button type="submit">Save credential</button>
      </p>
    </form>
  );
}

function DeleteSection(props: { service: Service; grantCount: number; csrf: string }) {
  if (props.grantCount > 0) {
    return (
      <p class="muted">
        This service is used by {props.grantCount} grant(s). Delete those grants first; then the
        service can be deleted. To stop all traffic right away, disable the service instead.
      </p>
    );
  }
  return (
    <form method="post" action={`${paths.token(props.service.id)}/delete`} class="stack">
      <Csrf token={props.csrf} />
      <Checkbox
        name="confirm"
        label={
          <>
            Delete <code>{props.service.slug}</code> and its stored credential permanently
          </>
        }
        hint="The audit log keeps a record of the configuration, never the credential."
      />
      <p class="actions">
        <button type="submit" class="danger">
          Delete service
        </button>
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Display helpers

/** `unusable`: the stored credential does not open under the stored row (proxied calls fail). */
function CredentialStatus(props: { service: Service; now: number; unusable?: boolean }) {
  const { service, now } = props;
  if (!service.credential_sealed) return <Badge tone="bad">missing</Badge>;
  if (props.unusable) return <Badge tone="bad">does not open</Badge>;
  const hint = service.credential_hint ? (
    <>
      {' '}
      <code>{service.credential_hint}</code>
    </>
  ) : null;
  const expires = service.credential_expires_at;
  if (expires !== null && expires <= now) {
    return (
      <>
        <Badge tone="bad">expired</Badge>
        {hint}
      </>
    );
  }
  if (expires !== null && expires - now <= EXPIRY_WARNING_MS) {
    return (
      <>
        <Badge tone="warn">expires {formatTime(expires)}</Badge>
        {hint}
      </>
    );
  }
  return (
    <>
      <Badge tone="ok">set</Badge>
      {hint}
    </>
  );
}

function injectionText(injection: Injection): string {
  switch (injection.kind) {
    case 'bearer':
      return 'Authorization: Bearer <credential>';
    case 'header':
      return `${injection.name}: ${injection.prefix ?? ''}<credential>`;
    case 'basic':
      return injection.username
        ? `HTTP Basic authentication as user "${injection.username}"`
        : 'HTTP Basic authentication (credential is "username:password")';
    case 'query':
      return `query parameter ?${injection.param}=<credential>`;
    case 'path':
      // Same layout as credentialPathSegment (proxy/path.ts).
      return `URL path: <base URL>/${(injection.prefix ?? '').replace(/^\//, '')}<credential>/…`;
    default:
      return 'invalid stored injection; set the credential again';
  }
}

function verifyText(verify: VerifyCheck | null): string {
  if (!verify) return 'none';
  const okField = verify.expect_ok_field ? ' and "ok": true' : '';
  return `${verify.method} ${verify.path}, expecting HTTP ${verify.expect_status}${okField}`;
}

function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
