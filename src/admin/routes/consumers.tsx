// Admin pages: service consumers (caller providers, the CI systems whose jobs call the gateway).
// Every change goes through ops/caller-providers.ts (validation, tenant pin I-TEN-1, anchors
// I-AUTHZ-2, audit I-AUDIT-1). Adding a consumer asks only what cannot be derived (its
// organizations, groups or issuer); an issuer/JWKS change under enabled accesses needs the confirm
// checkbox; disabling never validates; deleting with accesses is one confirmed cascade.
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { getCallerProvider } from '../../db/caller-providers';
import { labelFor, listClaimLabels } from '../../db/claim-labels';
import { listGrants } from '../../db/grants';
import type { CallerProvider, ClaimLabel, Grant } from '../../db/types';
import { getProfile } from '../../identity/profiles';
import { GITHUB_ACTIONS_ISSUER } from '../../identity/profiles/github-actions';
import { GITLAB_COM_ISSUER } from '../../identity/profiles/gitlab-ci';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import type { Condition } from '../../policy/types';
import { ALLOWED_ALGS, validateCallerProvider } from '../../policy/validate';
import { type AccessEdge, type Connections, loadConnections } from '../connections';
import { all, type Fields, flag, ownerFindCommand, parseOwnerList, text } from '../consumer-access';
import { formatValueList, parseValueList } from '../grant-text';
import { loadDone, type NoticeContext, type NoticeTable, resolveNotice } from '../notice';
import {
  addTenantValue,
  type CallerProviderUpdateInput,
  createOrMergeConsumer,
  deleteCallerProvider,
  grantsUsingPinValue,
  pinValues,
  removeTenantValue,
  setCallerProviderEnabled,
  tenantClaimOf,
  updateCallerProvider,
} from '../ops/caller-providers';
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
import {
  AddConsumerFields,
  blankConsumerForm,
  type ConsumerForm,
  parseConsumerForm,
  readConsumerForm,
} from '../views/add-consumer-fields';
import {
  ActionButton,
  AskSomeone,
  Checkbox,
  CheckboxGroup,
  ChipList,
  type ChipProps,
  ConfirmDialog,
  DataTable,
  Details,
  EmptyState,
  Field,
  IdWithLabelField,
  NotFound,
  PostForm,
  Select,
  StatusBadge,
  Time,
  VersionField,
} from '../views/components';
import { ConsumerSnippet } from '../views/consumer-snippet';
import { relativeTime } from '../views/format';
import { anchorsOf } from '../views/matrix';
import { RepeatingRows } from '../views/rows';
import { statusLabel } from '../views/status';

const HOUR_MS = 3_600_000;

export function registerConsumersRoutes(app: App): void {
  app.get('/admin/consumers', listPage);
  app.get('/admin/consumers/new', newPage);
  app.post('/admin/consumers', create);
  app.get('/admin/consumers/:id', detailPage);
  app.post('/admin/consumers/:id', update);
  app.post('/admin/consumers/:id/tenants', tenants);
  app.post('/admin/consumers/:id/toggle', toggle);
  app.post('/admin/consumers/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Notices

interface ConsumerNoticeData {
  consumer: CallerProvider | null;
}

const NOTICES: NoticeTable<NoticeContext & ConsumerNoticeData> = {
  created: () => ({
    text: 'Consumer created. Add the snippet below to your workflow, then give it access to a token.',
  }),
  tenant_added: ({ consumer }) => ({
    text: `${consumer?.name ?? 'The consumer'} can now be used by the added organizations or groups.`,
  }),
  tenant_removed: () => ({
    text: 'Removed from the consumer. Its tokens are refused from the next request on.',
  }),
  renamed: () => ({ text: 'Consumer renamed.' }),
  trust_saved: () => ({ text: 'Trust settings saved.' }),
  unchanged: () => ({ text: 'Nothing changed: the submitted values are the current ones.' }),
  label_changed: () => ({ text: 'Saved. A display name of an ID changed everywhere it is shown.' }),
  enabled: () => ({ text: 'Consumer enabled. Its accesses work again from the next request on.' }),
  disabled: ({ consumer }) => ({
    text: 'Consumer disabled. Its jobs are refused from the next request on.',
    ...(consumer && !consumer.enabled
      ? {
          undo: {
            action: `${paths.consumer(consumer.id)}/toggle`,
            fields: { enabled: '1', _return: 'detail' },
            label: 'Enable again',
          },
        }
      : {}),
  }),
  deleted: () => ({ text: 'Consumer deleted.' }),
  deleted_with_accesses: () => ({ text: 'Consumer and its accesses deleted.' }),
};

function pageNotice(c: AdminContext, consumer: CallerProvider | null) {
  return resolveNotice(NOTICES, c.req.query('notice'), null, { consumer });
}

// ---------------------------------------------------------------------------------------------
// List and add

async function listPage(c: AdminContext) {
  return renderList(c, null);
}

async function renderList(
  c: AdminContext,
  failed: { form: ConsumerForm; errors: FieldError[] } | null,
) {
  const deps = c.get('deps');
  const connections = await loadConnections(deps);
  const consumers = connections.consumers;
  const anchorClaims = consumerAnchorSuggestions(consumers);
  return renderPage(
    c,
    {
      title: 'Service consumers',
      section: 'consumers',
      subsection: 'consumers',
      notice: failed ? null : pageNotice(c, null),
      ...(failed ? { errors: failed.errors, status: 422 as const } : {}),
    },
    (ctx) => (
      <>
        <p>
          Consumers are the CI systems whose jobs call the gateway. Give them access to tokens under{' '}
          <a href={paths.access()}>Consumer access</a>.{' '}
          <a href={paths.docs('concepts.md#service-consumer')}>What is a consumer?</a>
        </p>
        {ctx.can('access:write') ? (
          <details id="add" class="primary-action" open={consumers.length === 0 || failed !== null}>
            <summary>Add a consumer</summary>
            <AddConsumerForm
              ctx={ctx}
              form={failed?.form ?? blankConsumerForm()}
              errors={failed?.errors ?? []}
              existing={consumers}
              anchorSuggestions={anchorClaims}
            />
          </details>
        ) : null}
        {consumers.length === 0 ? (
          <EmptyState
            action={
              ctx.can('access:write') ? null : (
                <AskSomeone permission="access:write" ctx={ctx} verb="add one" />
              )
            }
          >
            {ctx.can('access:write') ? (
              <>
                No consumers yet. Add the CI system whose jobs will call the gateway.
                {connections.tokens.length > 0 ? (
                  <>
                    {' '}
                    Or do it in one step:{' '}
                    <a href={paths.accessNew({ consumer: 'new' })}>Give a consumer access</a>.
                  </>
                ) : null}
              </>
            ) : (
              'No consumers yet.'
            )}
          </EmptyState>
        ) : (
          <ConsumerTable connections={connections} ctx={ctx} />
        )}
      </>
    ),
  );
}

function consumerAnchorSuggestions(consumers: readonly CallerProvider[]): string[] {
  return [
    ...new Set(
      consumers
        .filter((consumer) => consumer.profile === 'generic')
        .flatMap((consumer) => consumer.anchor_claims),
    ),
  ];
}

function AddConsumerForm(props: {
  ctx: ViewContext;
  form: ConsumerForm;
  errors: FieldError[];
  existing: readonly CallerProvider[];
  anchorSuggestions: readonly string[];
}) {
  return (
    <PostForm action={paths.consumers()} csrf={props.ctx.csrf} class="stack">
      <AddConsumerFields
        prefix=""
        form={props.form}
        errors={props.errors}
        existing={props.existing}
        anchorSuggestions={props.anchorSuggestions}
      />
      <div class="actions">
        <button type="submit" class="primary">
          Add consumer
        </button>
      </div>
    </PostForm>
  );
}

function tenantsText(consumer: CallerProvider, labels: readonly ClaimLabel[]): string {
  const claim = tenantClaimOf(consumer.profile);
  if (claim === null) {
    return consumer.tenant_pin.length === 0
      ? 'No pin'
      : consumer.tenant_pin.map((c) => `${c.claim}=${c.values.join('|')}`).join(', ');
  }
  return pinValues(consumer.tenant_pin, claim)
    .map((value) => {
      const label = labelFor(labels, claim, value);
      return label ? `${label} (${value})` : value;
    })
    .join(', ');
}

function accessChip(edge: AccessEdge, labelSubject = true): ChipProps {
  const token = edge.token?.name ?? 'a deleted token';
  const status = statusLabel(edge.status, edge.statusDetail);
  return {
    href: paths.accessItem(edge.grant.id),
    text: labelSubject
      ? `${token} · ${edge.subject} · ${edge.context}`
      : `${token} · ${edge.context}`,
    status: edge.status,
    ...(edge.statusDetail === undefined ? {} : { statusDetail: edge.statusDetail }),
    srText: `${edge.subject} in ${edge.context} can use ${token}: ${status}`,
  };
}

function ConsumerTable(props: { connections: Connections; ctx: ViewContext }) {
  const { connections, ctx } = props;
  const byConsumer = new Map<string, AccessEdge[]>();
  for (const edge of connections.accesses) {
    const list = byConsumer.get(edge.grant.caller_provider_id) ?? [];
    list.push(edge);
    byConsumer.set(edge.grant.caller_provider_id, list);
  }
  return (
    <DataTable<CallerProvider>
      id="consumers"
      caption="Service consumers"
      rowHeader="consumer"
      rows={connections.consumers}
      columns={[
        {
          key: 'consumer',
          header: 'Consumer',
          render: (consumer) => <a href={paths.consumer(consumer.id)}>{consumer.name}</a>,
        },
        {
          key: 'type',
          header: 'Type',
          render: (consumer) => getProfile(consumer.profile)?.label ?? consumer.profile,
        },
        {
          key: 'tenants',
          header: 'Organizations / groups',
          render: (consumer) =>
            tenantsText(
              consumer,
              connections.labels.filter((label) => label.caller_provider_id === consumer.id),
            ),
        },
        {
          key: 'uses',
          header: 'Can use',
          render: (consumer) => {
            const edges = byConsumer.get(consumer.id) ?? [];
            return edges.length === 0 ? (
              <span class="secondary-text">No token yet</span>
            ) : (
              <ChipList
                label={`Tokens ${consumer.name} can use`}
                items={edges.map((edge) => accessChip(edge))}
                max={3}
                moreHref={paths.access({ consumer: consumer.id })}
                moreText={`+${edges.length - 3} more`}
              />
            );
          },
        },
        {
          key: 'last',
          header: 'Last call',
          render: (consumer) => {
            const hours = (byConsumer.get(consumer.id) ?? [])
              .map((edge) => edge.lastUsedHour)
              .filter((hour): hour is number => hour !== null);
            if (!connections.usageAvailable) return <span class="secondary-text">Unknown</span>;
            return hours.length === 0
              ? 'No allowed calls in 30 days'
              : relativeTime(Math.max(...hours) + HOUR_MS / 2, ctx.now);
          },
        },
        {
          key: 'status',
          header: 'Status',
          render: (consumer) => <StatusBadge status={consumer.enabled ? 'active' : 'disabled'} />,
        },
      ]}
    />
  );
}

async function newPage(c: AdminContext) {
  return renderNew(c, blankConsumerForm(c.req.query('type')), [], 200);
}

async function renderNew(
  c: AdminContext,
  form: ConsumerForm,
  errors: FieldError[],
  status: 200 | 409 | 422,
) {
  const connections = await loadConnections(c.get('deps'));
  return renderPage(
    c,
    {
      title: 'Add a service consumer',
      section: 'consumers',
      subsection: 'consumers',
      breadcrumbs: [
        { href: paths.consumers(), label: 'Service consumers' },
        { href: paths.consumerNew(), label: 'Add a service consumer' },
      ],
      errors,
      status,
    },
    (ctx) => (
      <AddConsumerForm
        ctx={ctx}
        form={form}
        errors={errors}
        existing={connections.consumers}
        anchorSuggestions={consumerAnchorSuggestions(connections.consumers)}
      />
    ),
  );
}

/** Field of an op error of the add form, so the summary links to the input that fixes it. */
function consumerErrorField(form: ConsumerForm, message: string, prefix = ''): string | null {
  const lower = message.toLowerCase();
  if (form.type === 'generic' && (lower.includes('issuer') || lower.includes('discovery'))) {
    return `${prefix}generic_issuer`;
  }
  if (form.type === 'generic' && lower.includes('anchor')) return `${prefix}generic_anchor_claims`;
  if (form.type === 'generic' && lower.includes('pin')) return `${prefix}generic_pin_claim`;
  if (form.type === 'gitlab-ci' && lower.includes('discovery')) {
    return `${prefix}${form.gitlab_url ? 'gitlab_url' : 'gitlab_group'}`;
  }
  if (form.type === 'github-actions' && lower.includes('discovery')) {
    return `${prefix}github_enterprise_slug`;
  }
  if (
    form.type === 'github-actions' &&
    (lower.includes('organization') || lower.includes('already allowed'))
  ) {
    return `${prefix}github_org`;
  }
  if (form.type === 'gitlab-ci' && (lower.includes('group') || lower.includes('already allowed'))) {
    return `${prefix}gitlab_group`;
  }
  return null;
}

/** Plain-language fix for an op error of the add form. */
function consumerErrorMessage(message: string): string {
  if (message.includes('already has this issuer')) {
    return 'Another consumer already uses this issuer: open it under Service consumers and add access there.';
  }
  if (message.startsWith('JWKS discovery failed')) {
    return `The gateway could not read the issuer's OpenID configuration (${message.slice(23)}). Check the URL and save again.`;
  }
  return message;
}

export function consumerFailureErrors(
  form: ConsumerForm,
  failure: OpFailure,
  prefix = '',
): FieldError[] {
  return failure.errors.map((message) => ({
    field: consumerErrorField(form, message, prefix),
    message: consumerErrorMessage(message),
  }));
}

async function create(c: AdminContext) {
  const deps = c.get('deps');
  const fields = await formData(c);
  const form = readConsumerForm(fields, '');
  const parsed = parseConsumerForm(form, '');
  if (!parsed.ok) return renderNew(c, form, parsed.errors, 422);
  const result = await createOrMergeConsumer(deps, adminActor(c), parsed.input);
  if (!result.ok) {
    return renderNew(c, form, consumerFailureErrors(form, result), failureStatus(result));
  }
  if (result.merged && !result.changed) {
    const field = form.type === 'gitlab-ci' ? 'gitlab_group' : 'github_org';
    return renderNew(
      c,
      form,
      [
        {
          field,
          message: `${tenantList(parsed.input.tenants)} ${parsed.input.tenants.length === 1 ? 'is' : 'are'} already allowed for ${result.callerProvider.name}.`,
        },
      ],
      422,
    );
  }
  const id = result.callerProvider.id;
  const hasTokens = (await loadTokenCount(c)) > 0;
  if (hasTokens) {
    return redirectWithNotice(
      c,
      paths.accessNew({ consumer: id }),
      result.merged ? 'tenant_added' : 'consumer_created',
    );
  }
  return redirectWithNotice(c, paths.consumer(id), result.merged ? 'tenant_added' : 'created');
}

function tenantList(entries: ReadonlyArray<{ value: string; label: string }>): string {
  return entries.map((entry) => `${entry.label} (${entry.value})`).join(', ');
}

async function loadTokenCount(c: AdminContext): Promise<number> {
  const row = await c
    .get('deps')
    .env.DB.prepare('SELECT count(*) AS n FROM services')
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Consumer page

interface DetailState {
  errors?: FieldError[];
  /** Which form the errors belong to; its <details> opens. */
  open?: 'rename' | 'trust' | 'tenants' | null;
  rename?: string;
  trust?: Fields;
  tenant?: string;
  pin?: Array<{ claim: string; value: string }>;
  status?: 200 | 400 | 409 | 422;
}

async function detailPage(c: AdminContext) {
  const loaded = await loadProvider(c);
  if (!loaded) return notFound(c);
  return renderDetail(c, loaded.provider, loaded.profile, {
    open: c.req.query('open') === 'trust' ? 'trust' : null,
  });
}

async function renderDetail(
  c: AdminContext,
  provider: CallerProvider,
  profile: IssuerProfile,
  state: DetailState,
) {
  const deps = c.get('deps');
  const [connections, labels, grants] = await Promise.all([
    loadConnections(deps, { consumerId: provider.id }),
    listClaimLabels(deps.env.DB, provider.id),
    listGrants(deps.env.DB, { caller_provider_id: provider.id }),
  ]);
  const origin = new URL(c.req.url).origin;
  const stored = validateCallerProvider(provider, profile, provider);
  const done = await loadDone(deps, { userId: c.get('viewer').user.id }, c.req.query('done'));
  const errors = state.errors ?? [];
  return renderPage(
    c,
    {
      title: provider.name,
      section: 'consumers',
      subsection: 'consumers',
      breadcrumbs: [
        { href: paths.consumers(), label: 'Service consumers' },
        { href: paths.consumer(provider.id), label: provider.name },
      ],
      notice: errors.length > 0 ? null : (pageNotice(c, provider) ?? null),
      errors,
      status: state.status ?? 200,
    },
    (ctx) => (
      <ConsumerPage
        ctx={ctx}
        provider={provider}
        profile={profile}
        connections={connections}
        labels={labels}
        grants={grants}
        origin={origin}
        warnings={[...stored.errors, ...stored.warnings]}
        state={state}
        doneId={done?.id ?? null}
      />
    ),
  );
}

function ConsumerPage(props: {
  ctx: ViewContext;
  provider: CallerProvider;
  profile: IssuerProfile;
  connections: Connections;
  labels: ClaimLabel[];
  grants: Grant[];
  origin: string;
  warnings: string[];
  state: DetailState;
  doneId: string | null;
}) {
  const { ctx, provider, profile, connections, labels, grants, state } = props;
  const canWrite = ctx.can('access:write');
  const edges = connections.accesses;
  const slugs = [
    ...new Set(edges.map((edge) => edge.token?.slug).filter((slug): slug is string => !!slug)),
  ];
  const errors = state.errors ?? [];
  const err = (name: string) => errors.find((error) => error.field === name)?.message ?? null;
  return (
    <>
      <p class="status-line">
        {profile.label} <StatusBadge status={provider.enabled ? 'active' : 'disabled'} />
      </p>
      {props.warnings.map((warning) => (
        <p class="risk">
          <strong>Risk:</strong> {warning}
        </p>
      ))}
      {canWrite ? (
        <div class="actions header-actions">
          <ActionButton
            action={`${paths.consumer(provider.id)}/toggle`}
            csrf={ctx.csrf}
            label={provider.enabled ? 'Disable' : 'Enable'}
            context={provider.name}
            fields={{ enabled: provider.enabled ? '0' : '1' }}
            returnTo="detail"
          />
          <details class="inline-details" open={state.open === 'rename'}>
            <summary>Rename</summary>
            <PostForm action={paths.consumer(provider.id)} csrf={ctx.csrf} class="stack">
              <VersionField value={String(provider.updated_at)} />
              <Field
                name="name"
                label="Name"
                value={state.rename ?? provider.name}
                example="GitHub Actions (acme)"
                maxlength={100}
                error={err('name')}
                autocomplete="off"
                conditional
              />
              <div class="actions">
                <button type="submit" name="intent" value="rename" class="primary">
                  Save name
                </button>
              </div>
            </PostForm>
          </details>
        </div>
      ) : null}

      <section id="snippet" aria-labelledby="snippet-h">
        <h2 id="snippet-h">Connect your jobs</h2>
        <ConsumerSnippet consumer={provider} origin={props.origin} slugs={slugs} />
      </section>

      <section id="access" aria-labelledby="access-h">
        <h2 id="access-h">Tokens this consumer can use ({edges.length})</h2>
        {canWrite ? (
          <p class="actions">
            <a class="button" href={paths.accessNew({ consumer: provider.id })}>
              Give access to a token
            </a>
          </p>
        ) : null}
        {edges.length === 0 ? (
          <EmptyState>This consumer cannot use any token yet.</EmptyState>
        ) : (
          <AccessBlocks edges={edges} labels={labels} provider={provider} canWrite={canWrite} />
        )}
        <p>
          <a href={paths.access({ consumer: provider.id })}>
            All consumer access of {provider.name}
          </a>{' '}
          · <a href={paths.requests({ consumer: provider.id })}>Requests</a> ·{' '}
          <a href={paths.audit({ target: provider.id })}>History</a>
        </p>
      </section>

      <TenantsSection
        ctx={ctx}
        provider={provider}
        profile={profile}
        labels={labels}
        grants={grants}
        state={state}
      />

      <TrustSection
        ctx={ctx}
        provider={provider}
        profile={profile}
        grants={grants}
        state={state}
        tokens={connections}
      />

      <Details
        rows={[
          ['ID', <code>{provider.id}</code>],
          ['Created', <Time ms={provider.created_at} />],
          ['Last changed', <Time ms={provider.updated_at} relative now={ctx.now} />],
        ]}
      />

      {canWrite ? (
        <section id="danger" aria-labelledby="danger-h">
          <h2 id="danger-h">Delete</h2>
          <DeleteConsumer ctx={ctx} provider={provider} grants={grants} />
        </section>
      ) : null}
    </>
  );
}

function AccessBlocks(props: {
  edges: AccessEdge[];
  labels: ClaimLabel[];
  provider: CallerProvider;
  canWrite: boolean;
}) {
  const blocks = new Map<
    string,
    { header: string; subject: string; repositoryId: string | null; edges: AccessEdge[] }
  >();
  for (const edge of props.edges) {
    for (const anchor of anchorsOf(edge, props.labels)) {
      const block = blocks.get(anchor.key) ?? { ...anchor, edges: [] };
      block.edges.push(edge);
      blocks.set(anchor.key, block);
    }
  }
  return (
    <>
      {[...blocks.values()]
        .sort((a, b) => a.header.localeCompare(b.header))
        .map((block, index) => {
          const idText = block.repositoryId !== null ? ` (${block.repositoryId})` : '';
          const heading = block.repositoryId !== null ? block.subject : block.header;
          return (
            <div class="access-block">
              <h3 id={`access-block-${index}`}>
                {heading}
                {idText ? <span class="secondary-text">{idText}</span> : null}
              </h3>
              <ChipList
                label={`Tokens ${heading} can use`}
                items={block.edges.map((edge) => accessChip(edge, false))}
                max={50}
              />
              {props.canWrite ? (
                <p>
                  <a
                    href={paths.accessNew({
                      consumer: props.provider.id,
                      repository: block.repositoryId ?? undefined,
                      copy: block.edges[0]?.grant.id,
                    })}
                  >
                    <span aria-hidden="true">+ </span>Give {heading} access to another token
                  </a>
                </p>
              ) : null}
            </div>
          );
        })}
    </>
  );
}

function TenantsSection(props: {
  ctx: ViewContext;
  provider: CallerProvider;
  profile: IssuerProfile;
  labels: ClaimLabel[];
  grants: Grant[];
  state: DetailState;
}) {
  const { ctx, provider, profile, labels, grants, state } = props;
  const canWrite = ctx.can('access:write');
  const claim = tenantClaimOf(provider.profile);
  const errors = state.errors ?? [];
  const err = (name: string) => errors.find((error) => error.field === name)?.message ?? null;
  const heading =
    provider.profile === 'github-actions'
      ? 'Organizations'
      : provider.profile === 'gitlab-ci'
        ? 'Groups'
        : 'Tenant pin';
  if (claim === null) {
    const rows =
      state.pin ??
      provider.tenant_pin.map((condition) => ({
        claim: condition.claim,
        value: formatValueList(condition.values),
      }));
    return (
      <section id="tenants" aria-labelledby="tenants-h">
        <h2 id="tenants-h">{heading}</h2>
        {provider.tenant_pin.length === 0 ? (
          <p class="risk">
            <strong>Risk:</strong> no pin: every token this issuer signs for this audience reaches
            access evaluation.
          </p>
        ) : (
          <ul>
            {provider.tenant_pin.map((condition) => (
              <li>
                <code>{condition.claim}</code> is {condition.values.join(' or ')}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <details open={state.open === 'tenants'}>
            <summary>Change the pin</summary>
            <PostForm action={paths.consumer(provider.id)} csrf={ctx.csrf} class="stack">
              <VersionField value={String(provider.updated_at)} />
              <input type="hidden" name="pin_rows" value="1" />
              <RepeatingRows
                group="pin"
                legend="Claims every token must carry"
                keys={['claim', 'value']}
                rows={rows}
                render={(index, row, prefix) => (
                  <>
                    <Field
                      name={`${prefix}claim`}
                      label={`Claim ${index + 1}`}
                      value={row.claim ?? ''}
                      example="organization_id"
                      error={err(`${prefix}claim`)}
                      autocomplete="off"
                      spellcheck={false}
                      autocapitalize="none"
                      conditional
                    />
                    <Field
                      name={`${prefix}value`}
                      label={`Value ${index + 1}`}
                      value={row.value ?? ''}
                      example="0c9f3e1a-7b2d-4c5e-9f10-123456789abc"
                      hint='Exact value; several alternatives separated by commas, "a,b" quoted.'
                      error={err(`${prefix}value`)}
                      autocomplete="off"
                      spellcheck={false}
                      autocapitalize="none"
                      conditional
                    />
                  </>
                )}
              />
              <div class="actions">
                <button type="submit" name="intent" value="trust" class="primary">
                  Save the pin
                </button>
              </div>
            </PostForm>
          </details>
        ) : null}
      </section>
    );
  }
  const values = pinValues(provider.tenant_pin, claim);
  const gitlab = provider.profile === 'gitlab-ci';
  return (
    <section id="tenants" aria-labelledby="tenants-h">
      <h2 id="tenants-h">{heading}</h2>
      {values.length === 0 ? (
        <p class="risk">
          <strong>Risk:</strong> no {gitlab ? 'group' : 'organization'} is pinned.
        </p>
      ) : (
        <ul class="tenants">
          {values.map((value) => {
            const label = labelFor(labels, claim, value);
            const text = label ? `${label} (${value})` : value;
            const users = grantsUsingPinValue(grants, profile, provider, claim, value);
            const blocked = users.enabled.length > 0;
            return (
              <li>
                <span class="tenant">{text}</span>{' '}
                {canWrite ? (
                  <PostForm
                    action={`${paths.consumer(provider.id)}/tenants`}
                    csrf={ctx.csrf}
                    class="inline"
                  >
                    <input type="hidden" name="intent" value="remove" />
                    <button
                      type="submit"
                      name="remove"
                      value={value}
                      class="secondary"
                      disabled={blocked || values.length === 1}
                    >
                      Remove<span class="vh"> {text}</span>
                    </button>
                  </PostForm>
                ) : null}
                {blocked ? (
                  <p class="hint">
                    Used by {users.enabled.length} enabled{' '}
                    {users.enabled.length === 1 ? 'access' : 'accesses'}:{' '}
                    {users.enabled.map((grant, index) => (
                      <>
                        {index > 0 ? ', ' : ''}
                        <a href={paths.accessItem(grant.id)}>{grant.name}</a>
                      </>
                    ))}
                    . Disable or change them first.
                  </p>
                ) : values.length === 1 ? (
                  <p class="hint">
                    The last {gitlab ? 'group' : 'organization'} cannot be removed; add another
                    first.
                  </p>
                ) : null}
                {users.disabled.length > 0 ? (
                  <p class="hint">
                    {users.disabled.length} disabled{' '}
                    {users.disabled.length === 1 ? 'access uses' : 'accesses use'} it; they cannot
                    be enabled again after removal.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canWrite ? (
        <PostForm action={`${paths.consumer(provider.id)}/tenants`} csrf={ctx.csrf} class="stack">
          <IdWithLabelField
            kind={gitlab ? 'gitlab_group_list' : 'github_owner_list'}
            name="tenant"
            label={gitlab ? 'Add groups' : 'Add organizations'}
            value={state.tenant ?? ''}
            example={gitlab ? 'acme-group/platform (5678902)' : 'acme-labs (7654321)'}
            findCommand={ownerFindCommand(profile)}
            hint="Separate several with commas."
            error={err('tenant')}
            autocomplete="off"
            required
          />
          <div class="actions">
            <button type="submit" name="intent" value="add" class="primary">
              {gitlab ? 'Add groups' : 'Add organizations'}
            </button>
          </div>
        </PostForm>
      ) : null}
    </section>
  );
}

function ageOptions(
  profile: IssuerProfile,
  stored: number,
): Array<{ value: string; label: string }> {
  const limit = profile.defaults.maxTokenAgeLimitSeconds;
  const seconds = [300, 600, 900, 1800, 3600].filter((value) => value <= limit);
  if (!seconds.includes(stored)) seconds.push(stored);
  return seconds
    .sort((a, b) => a - b)
    .map((value) => ({
      value: String(value),
      label: value % 60 === 0 ? `${value / 60} minutes` : `${value} seconds`,
    }));
}

/** True when the issuer of this consumer can be edited (generic, GHE slug, self-managed GitLab). */
function issuerEditable(provider: CallerProvider): boolean {
  if (provider.profile === 'generic') return true;
  if (provider.profile === 'github-actions') return provider.issuer !== GITHUB_ACTIONS_ISSUER;
  return provider.issuer !== GITLAB_COM_ISSUER;
}

function TrustSection(props: {
  ctx: ViewContext;
  provider: CallerProvider;
  profile: IssuerProfile;
  grants: Grant[];
  state: DetailState;
  tokens: Connections;
}) {
  const { ctx, provider, profile, grants, state } = props;
  const errors = state.errors ?? [];
  const err = (name: string) => errors.find((error) => error.field === name)?.message ?? null;
  const trust = state.trust;
  const value = (name: string, fallback: string) => (trust ? text(trust, name) : fallback);
  const enabledGrants = grants.filter((grant) => grant.enabled);
  const tokenName = (grant: Grant) =>
    props.tokens.tokens.find((token) => token.id === grant.service_id)?.name ?? 'a deleted token';
  const enterprise = pinValues(provider.tenant_pin, 'enterprise_id')[0] ?? '';
  const algs = trust ? all(trust, 'allowed_algs') : provider.allowed_algs;
  if (!ctx.can('access:write')) {
    return (
      <section id="trust" aria-labelledby="trust-h">
        <h2 id="trust-h">Trust settings</h2>
        <Details
          rows={[
            ['Issuer', <code>{provider.issuer}</code>],
            ['JWKS URI', <code>{provider.jwks_uri}</code>],
            ['Audience', <code>{provider.audience}</code>],
            ['Signature algorithms', provider.allowed_algs.join(', ')],
            ['Maximum token age', `${provider.max_token_age_seconds} seconds`],
            ...(provider.profile === 'generic'
              ? ([['Anchor claims', provider.anchor_claims.join(', ')]] as Array<[string, Child]>)
              : []),
          ]}
        />
      </section>
    );
  }
  return (
    <details id="trust" open={state.open === 'trust'}>
      <summary>Advanced trust settings</summary>
      <PostForm action={paths.consumer(provider.id)} csrf={ctx.csrf} class="stack">
        <VersionField value={String(provider.updated_at)} />
        {issuerEditable(provider) ? (
          <Field
            name="issuer"
            label="Issuer"
            type="url"
            value={value('issuer', provider.issuer)}
            example={provider.issuer}
            hint="Changing it makes every access of this consumer trust a new issuer."
            error={err('issuer')}
            autocomplete="off"
            spellcheck={false}
            autocapitalize="none"
            conditional
          />
        ) : (
          <p>
            Issuer: <code>{provider.issuer}</code>
          </p>
        )}
        {provider.profile === 'generic' ? (
          <Field
            name="jwks_uri"
            label="JWKS URI"
            type="url"
            value={value('jwks_uri', provider.jwks_uri)}
            example="https://agent.buildkite.com/.well-known/jwks"
            hint="Where the issuer publishes its signing keys. Clear it to discover it again from a new issuer."
            error={err('jwks_uri')}
            autocomplete="off"
            spellcheck={false}
            autocapitalize="none"
            conditional
          />
        ) : (
          <p>
            JWKS URI: <code>{provider.jwks_uri}</code> (read from the issuer's discovery document)
          </p>
        )}
        <Field
          name="audience"
          label="Audience"
          value={value('audience', provider.audience)}
          example="tokengate:abcdefghijklmnopqrstuvwxyz"
          hint="Changing it breaks every job until its snippet is updated."
          error={err('audience')}
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
          conditional
        />
        <CheckboxGroup
          name="allowed_algs"
          legend="Signature algorithms"
          hint="Algorithms the issuer signs with."
          error={err('allowed_algs')}
          options={ALLOWED_ALGS.map((alg) => ({
            value: alg,
            label: alg,
            checked: algs.includes(alg),
          }))}
        />
        <Select
          name="max_token_age_seconds"
          label="Maximum token age"
          value={value('max_token_age_seconds', String(provider.max_token_age_seconds))}
          options={ageOptions(profile, provider.max_token_age_seconds)}
          hint="Tokens older than this are refused."
          error={err('max_token_age_seconds')}
          conditional
        />
        {provider.profile === 'github-actions' ? (
          <Field
            name="enterprise_id"
            label="Enterprise ID"
            optional
            value={value('enterprise_id', enterprise)}
            example="12345"
            inputmode="numeric"
            hint="Tokens must also come from this GitHub Enterprise. Empty: no enterprise pin."
            error={err('enterprise_id')}
            autocomplete="off"
            conditional
          />
        ) : null}
        {provider.profile === 'generic' ? (
          <Field
            name="anchor_claims"
            label="Anchor claims"
            value={value('anchor_claims', provider.anchor_claims.join(', '))}
            example="pipeline_id"
            hint="Claims that identify one workload exactly, comma-separated. Every access needs an exact condition on one of them."
            error={err('anchor_claims')}
            autocomplete="off"
            spellcheck={false}
            autocapitalize="none"
            conditional
          />
        ) : null}
        {enabledGrants.length > 0 ? (
          <div class="confirm-trust">
            <Checkbox
              name="confirm_trust_change"
              label={`I understand that these ${enabledGrants.length} enabled ${enabledGrants.length === 1 ? 'access' : 'accesses'} will trust the new issuer or keys`}
              hint="Needed only when the issuer or the JWKS URI changes."
              checked={trust ? flag(trust, 'confirm_trust_change') : false}
              error={err('confirm_trust_change')}
            />
            <ul>
              {enabledGrants.map((grant) => (
                <li>
                  <a href={paths.accessItem(grant.id)}>{grant.name}</a> ({tokenName(grant)})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div class="actions">
          <button type="submit" name="intent" value="trust" class="primary">
            Save trust settings
          </button>
        </div>
      </PostForm>
    </details>
  );
}

function DeleteConsumer(props: { ctx: ViewContext; provider: CallerProvider; grants: Grant[] }) {
  const { ctx, provider, grants } = props;
  const ids = grants.map((grant) => grant.id).sort();
  const count = grants.length;
  return (
    <>
      <p>
        {count > 0
          ? `Deleting removes its ${count} consumer ${count === 1 ? 'access' : 'accesses'} too. To stop all its tokens now and keep the configuration, disable the consumer instead.`
          : 'The audit log keeps a copy of its configuration. To stop its jobs for now, disable it instead.'}
      </p>
      <ConfirmDialog
        id="delete-consumer"
        trigger="Delete…"
        triggerContext={provider.name}
        title={
          count > 0
            ? `Delete ${provider.name} and its ${count} consumer ${count === 1 ? 'access' : 'accesses'}?`
            : `Delete ${provider.name}?`
        }
        body={
          count > 0
            ? 'Its jobs are refused from the next request on, and these accesses are deleted with it. Disable the consumer to stop all its tokens now instead.'
            : 'Its jobs are refused from the next request on.'
        }
        affected={grants.map((grant) => (
          <a href={paths.accessItem(grant.id)}>{grant.name}</a>
        ))}
        confirmLabel={
          count > 0
            ? `Delete consumer and ${count} ${count === 1 ? 'access' : 'accesses'}`
            : 'Delete consumer'
        }
        danger
        variant="standalone"
        action={`${paths.consumer(provider.id)}/delete`}
        csrf={ctx.csrf}
        fields={count > 0 ? { with_accesses: '1', access_ids: ids.join(',') } : {}}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Consumer page mutations

async function update(c: AdminContext) {
  const loaded = await loadProvider(c);
  if (!loaded) return notFound(c);
  const { provider, profile } = loaded;
  const fields = await formData(c);
  const intent = text(fields, 'intent');
  const actor = adminActor(c);
  const deps = c.get('deps');
  const version = submittedVersion(text(fields, 'expected_updated_at'));
  if (intent === 'rename') {
    const name = text(fields, 'name');
    const result = await updateCallerProvider(deps, actor, provider.id, {
      name,
      expected_updated_at: version,
    });
    if (result.ok) {
      return redirectWithNotice(
        c,
        paths.consumer(provider.id),
        result.changed === false ? 'unchanged' : 'renamed',
      );
    }
    if (result.reason === 'not_found') return notFound(c);
    return renderDetail(c, provider, profile, {
      errors: result.errors.map((message) => ({
        field: message.startsWith('name') || message.includes('this name') ? 'name' : null,
        message: message.includes('this name')
          ? 'Another consumer already uses this name: choose a different name.'
          : message,
      })),
      open: 'rename',
      rename: name,
      status: failureStatus(result),
    });
  }
  if (intent !== 'trust') {
    return renderDetail(c, provider, profile, {
      errors: [{ field: null, message: 'Use one of the forms on this page.' }],
      status: 400,
    });
  }
  if (fields.pin_rows !== undefined) return savePin(c, provider, profile, fields, version);
  const input: CallerProviderUpdateInput = { expected_updated_at: version };
  const fieldErrors: FieldError[] = [];
  if (issuerEditable(provider) && fields.issuer !== undefined)
    input.issuer = text(fields, 'issuer');
  if (provider.profile === 'generic' && fields.jwks_uri !== undefined) {
    input.jwks_uri = text(fields, 'jwks_uri');
  }
  if (fields.audience !== undefined) input.audience = text(fields, 'audience');
  if (fields.max_token_age_seconds !== undefined) {
    input.max_token_age_seconds = Number(text(fields, 'max_token_age_seconds'));
  }
  input.allowed_algs = all(fields, 'allowed_algs');
  if (input.allowed_algs.length === 0) {
    fieldErrors.push({
      field: 'allowed_algs',
      message: 'Choose at least one signature algorithm.',
    });
  }
  if (provider.profile === 'github-actions' && fields.enterprise_id !== undefined) {
    const enterprise = text(fields, 'enterprise_id').trim();
    if (enterprise !== '' && !/^[0-9]{1,20}$/.test(enterprise)) {
      fieldErrors.push({
        field: 'enterprise_id',
        message: 'Enter the numeric enterprise ID, like 12345.',
      });
    } else {
      const others = provider.tenant_pin.filter((condition) => condition.claim !== 'enterprise_id');
      input.tenant_pin = [
        ...others,
        ...(enterprise === ''
          ? []
          : [{ claim: 'enterprise_id', match: 'exact' as const, values: [enterprise] }]),
      ];
    }
  }
  if (provider.profile === 'generic' && fields.anchor_claims !== undefined) {
    input.anchor_claims = text(fields, 'anchor_claims')
      .split(',')
      .map((claim) => claim.trim())
      .filter((claim) => claim !== '');
  }
  input.confirm_trust_change = flag(fields, 'confirm_trust_change');
  if (fieldErrors.length > 0) {
    return renderDetail(c, provider, profile, {
      errors: fieldErrors,
      open: 'trust',
      trust: fields,
      status: 422,
    });
  }
  const result = await updateCallerProvider(deps, actor, provider.id, input);
  if (result.ok) {
    return redirectWithNotice(
      c,
      paths.consumer(provider.id),
      result.changed === false ? 'unchanged' : 'trust_saved',
    );
  }
  if (result.reason === 'not_found') return notFound(c);
  return renderDetail(c, provider, profile, {
    errors: result.errors.map((message) => ({
      field:
        result.reason === 'confirmation_required'
          ? 'confirm_trust_change'
          : trustErrorField(message),
      message:
        result.reason === 'confirmation_required'
          ? 'Tick the box to confirm that these enabled accesses trust the new issuer or keys.'
          : message,
    })),
    open: 'trust',
    trust: fields,
    status: failureStatus(result),
  });
}

function trustErrorField(message: string): string | null {
  for (const [prefix, field] of [
    ['issuer', 'issuer'],
    ['JWKS', 'jwks_uri'],
    ['audience', 'audience'],
    ['signing algorithm', 'allowed_algs'],
    ['maximum token age', 'max_token_age_seconds'],
    ['anchor', 'anchor_claims'],
    ['generic caller providers need', 'anchor_claims'],
  ] as const) {
    if (message.startsWith(prefix)) return field;
  }
  return null;
}

async function savePin(
  c: AdminContext,
  provider: CallerProvider,
  profile: IssuerProfile,
  fields: Fields,
  version: number | undefined,
) {
  const rows: Array<{ claim: string; value: string }> = [];
  const errors: FieldError[] = [];
  const pin: Condition[] = [];
  for (let index = 0; index < 200; index++) {
    const claim = text(fields, `pin.${index}.claim`).trim();
    const raw = text(fields, `pin.${index}.value`);
    if (fields[`pin.${index}.claim`] === undefined && fields[`pin.${index}.value`] === undefined) {
      if (index > 50) break;
      continue;
    }
    if (flag(fields, `pin.${index}.remove`) || (claim === '' && raw.trim() === '')) continue;
    rows.push({ claim, value: raw });
    const values = parseValueList(raw);
    if (claim === '') {
      errors.push({
        field: `pin.${index}.claim`,
        message: 'Enter the claim name, like organization_id.',
      });
    } else if (!values.ok) {
      errors.push({ field: `pin.${index}.value`, message: values.error });
    } else if (values.values.length === 0) {
      errors.push({ field: `pin.${index}.value`, message: `Enter the value of ${claim}.` });
    } else {
      pin.push({ claim, match: 'exact', values: values.values });
    }
  }
  if (errors.length === 0) {
    const result = await updateCallerProvider(c.get('deps'), adminActor(c), provider.id, {
      tenant_pin: pin,
      expected_updated_at: version,
    });
    if (result.ok) {
      return redirectWithNotice(
        c,
        paths.consumer(provider.id, { hash: 'tenants' }),
        result.changed === false ? 'unchanged' : 'trust_saved',
      );
    }
    if (result.reason === 'not_found') return notFound(c);
    return renderDetail(c, provider, profile, {
      errors: result.errors.map((message) => ({ field: null, message })),
      open: 'tenants',
      pin: rows,
      status: failureStatus(result),
    });
  }
  return renderDetail(c, provider, profile, { errors, open: 'tenants', pin: rows, status: 422 });
}

async function tenants(c: AdminContext) {
  const loaded = await loadProvider(c);
  if (!loaded) return notFound(c);
  const { provider, profile } = loaded;
  const fields = await formData(c);
  const claim = tenantClaimOf(provider.profile);
  const deps = c.get('deps');
  const actor = adminActor(c);
  if (claim === null) {
    return renderDetail(c, provider, profile, {
      errors: [
        { field: null, message: 'Change the pin of a generic consumer with Change the pin.' },
      ],
      open: 'tenants',
      status: 400,
    });
  }
  const intent = text(fields, 'intent');
  if (intent === 'remove') {
    const value = text(fields, 'remove');
    const result = await removeTenantValue(deps, actor, provider.id, { claim, value });
    if (result.ok) {
      return redirectWithNotice(
        c,
        paths.consumer(provider.id, { hash: 'tenants' }),
        'tenant_removed',
      );
    }
    if (result.reason === 'not_found') return notFound(c);
    return renderDetail(c, provider, profile, {
      errors: result.errors.map((message) => ({ field: null, message })),
      status: failureStatus(result),
    });
  }
  const raw = text(fields, 'tenant');
  const parsed = parseOwnerList(raw, profile);
  if (intent !== 'add' || !parsed.ok) {
    return renderDetail(c, provider, profile, {
      errors: [
        {
          field: 'tenant',
          message: parsed.ok ? 'Use the Add button.' : parsed.message,
        },
      ],
      tenant: raw,
      status: 422,
    });
  }
  const result = await addTenantValue(deps, actor, provider.id, {
    claim,
    entries: parsed.entries.map((entry) => ({ value: entry.id, label: entry.label })),
  });
  if (result.ok) {
    return redirectWithNotice(c, paths.consumer(provider.id, { hash: 'tenants' }), 'tenant_added');
  }
  if (result.reason === 'not_found') return notFound(c);
  return renderDetail(c, provider, profile, {
    errors: result.errors.map((message) => ({
      field: message.includes('already allowed') || message.includes('numeric') ? 'tenant' : null,
      message,
    })),
    tenant: raw,
    status: failureStatus(result),
  });
}

async function toggle(c: AdminContext) {
  const id = c.req.param('id') ?? '';
  const form = await formData(c);
  const enabled = flag(form, 'enabled');
  const result = await setCallerProviderEnabled(c.get('deps'), adminActor(c), id, enabled);
  if (result.ok) {
    const back = returnPath('POST /admin/consumers/:id/toggle', form._return, { id });
    return redirectWithNotice(c, back, enabled ? 'enabled' : 'disabled');
  }
  return rerenderDetail(c, result);
}

async function remove(c: AdminContext) {
  const fields = await formData(c);
  const loaded = await loadProvider(c);
  if (!loaded) return notFound(c);
  if (!flag(fields, 'confirm')) {
    return renderDetail(c, loaded.provider, loaded.profile, {
      errors: [{ field: null, message: 'Confirm the deletion in the Delete dialog.' }],
      status: 400,
    });
  }
  const withAccesses = flag(fields, 'with_accesses');
  const accessIds = all(fields, 'access_ids')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const result = await deleteCallerProvider(c.get('deps'), adminActor(c), loaded.provider.id, {
    withAccesses,
    accessIds,
  });
  if (result.ok) {
    return redirectWithNotice(
      c,
      paths.consumers(),
      result.deletedAccesses > 0 ? 'deleted_with_accesses' : 'deleted',
    );
  }
  return rerenderDetail(c, {
    ...result,
    errors: result.errors.map((message) =>
      message.includes('delete them first')
        ? 'This consumer still has consumer accesses: delete it from the Delete dialog, which deletes them too.'
        : message,
    ),
  });
}

async function rerenderDetail(c: AdminContext, failure: OpFailure) {
  const loaded = await loadProvider(c);
  if (!loaded || failure.reason === 'not_found') return notFound(c);
  return renderDetail(c, loaded.provider, loaded.profile, {
    errors: failure.errors.map((message) => ({ field: null, message })),
    status: failureStatus(failure),
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers

async function loadProvider(
  c: AdminContext,
): Promise<{ provider: CallerProvider; profile: IssuerProfile } | null> {
  const provider = await getCallerProvider(c.get('deps').env.DB, c.req.param('id') ?? '');
  const profile = provider ? getProfile(provider.profile) : null;
  return provider && profile ? { provider, profile } : null;
}

function notFound(c: AdminContext) {
  return renderPage(
    c,
    {
      title: 'Consumer not found',
      section: 'consumers',
      subsection: 'consumers',
      status: 404,
    },
    () => <NotFound what="consumer" />,
  );
}

function failureStatus(failure: OpFailure): 409 | 422 {
  return failure.reason === 'conflict' ? 409 : 422;
}

/** Label of a consumer type, for other pages. */
export function consumerTypeLabel(profile: ProfileId): string {
  return getProfile(profile)?.label ?? profile;
}
