// The consumer access page (A14.5) on design D: who can use which token in which context (header
// relation line), how a call flows through its conditions, how to connect the job, what the access
// allows and the risks it carries, overlapping accesses, a one-submit copy, the edit form and the
// delete dialog; the rail holds its activity, history and IDs. Read-only parts are shown to every
// role; Rename, Disable, Change, Copy and Delete need access:write.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  CodeBlock,
  DangerRow,
  DangerZone,
  DetailLayout,
  Dialog,
  DialogClose,
  DialogTrigger,
  Disclosure,
  FieldSet,
  Feed,
  FeedItem,
  formatTime,
  Identity,
  KeyValue,
  type KeyValueItem,
  Kpis,
  Mono,
  PageHeader,
  Panel,
  Picks,
  RailFoot,
  RailKeyValue,
  RelationLine,
  SubmitRow,
  Time as UiTime,
  Trace,
  Tray,
  ArrowRow,
} from '@tokengate/ui';
import { labelFor } from '../../db/claim-labels';
import type { CallerProvider, ClaimLabel, Grant, Service } from '../../db/types';
import type { IssuerProfile } from '../../identity/types';
import type { WarningDetail } from '../../policy/validate';
import type { AccessEdge } from '../connections';
import { anchorClaims, pinOwnerValues, repositoryFindCommand } from '../consumer-access';
import { eventSummary, formatConditions } from '../grant-text';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { REPO_PLACEHOLDER, type ServiceTemplate } from '../service-templates';
import { AccessForm, type AccessFormModel } from './access-form';
import {
  consumerLogo,
  hostOf,
  issuerHost,
  leadStatus,
  tokenLogo,
  useFocusTarget,
} from './access-visuals';
import {
  ActionButton,
  type ConfirmDialogProps,
  ConfirmBox,
  ConfirmTrigger,
  Field,
  IdWithLabelField,
  PostForm,
  Select,
  StatusBadge,
  type Suggestion,
  TextArea,
} from './components';
import { ConsumerSnippet, snippetCall } from './consumer-snippet';
import { formatCount, lastUsedTime, relativeTime } from './format';
import { anchorsOf, shortContext } from './matrix';

/** One line of the access history in the rail. */
export interface HistoryEntry {
  ts: number;
  actor: string;
  summary: string;
}

export interface AccessPageModel {
  grant: Grant;
  edge: AccessEdge;
  consumer: CallerProvider;
  profile: IssuerProfile;
  token: Service;
  tokens: Service[];
  template: ServiceTemplate | null;
  labels: ClaimLabel[];
  warningDetails: WarningDetail[];
  overlaps: AccessEdge[];
  origin: string;
  requests30d: number | null;
  repositoryOptions: Suggestion[];
  /** Tokens whose operations a copy would not keep (another template). */
  reviewTokens: Set<string>;
  edit: AccessFormModel | null;
  editOpen: boolean;
  rename: { name: string; description: string; open: boolean; errors: Record<string, string> };
  copy: { repository: string; tokenId: string; error: Record<string, string> };
  /** The newest audit rows of this access (rail history). */
  history: HistoryEntry[];
  /** Who accepted the current risks, from the newest audit row that recorded them. */
  acceptedBy: { actor: string; ts: number } | null;
}

/** "repo:acme/api:environment:production": the usual `sub` of a matching GitHub job. */
export function typicalSubject(
  profile: Pick<IssuerProfile, 'id'>,
  repositoryLabel: string | null,
  context: string,
): string | null {
  if (repositoryLabel === null) return null;
  const [kind, ...rest] = context.split(' ');
  const value = rest.join(' ');
  if (profile.id === 'github-actions') {
    if (kind === 'environment') return `repo:${repositoryLabel}:environment:${value}`;
    if (kind === 'branch' && !value.includes('*'))
      return `repo:${repositoryLabel}:ref:refs/heads/${value}`;
    if ((kind === 'tag' || kind === 'release') && !value.includes('*')) {
      return `repo:${repositoryLabel}:ref:refs/tags/${value}`;
    }
    if (kind === 'PR') return `repo:${repositoryLabel}:pull_request`;
    return null;
  }
  if (profile.id === 'gitlab-ci') {
    if ((kind === 'branch' || kind === 'tag') && !value.includes('*')) {
      return `project_path:${repositoryLabel}:ref_type:${kind}:ref:${value}`;
    }
    return null;
  }
  return null;
}

/** The callout that says why an enabled access does not work, or null. */
function InactiveCause(props: { edge: AccessEdge }) {
  const { edge } = props;
  if (edge.status !== 'inactive') return null;
  const reason = edge.statusDetail ?? '';
  if (reason === 'consumer disabled' && edge.consumer) {
    return (
      <Callout tone="warn" title="Inactive because the consumer is disabled:">
        <a href={paths.consumer(edge.consumer.id)}>{edge.consumer.name}</a>. Enable it on its page;
        this access then works again.
      </Callout>
    );
  }
  if (edge.token) {
    return (
      <Callout
        tone="warn"
        title={`Inactive because the ${reason.startsWith('token') ? '' : 'token’s '}${reason}:`}
      >
        <a href={paths.token(edge.token.id)}>{edge.token.name}</a>. A token manager fixes it on the
        token page.
      </Callout>
    );
  }
  return <Callout tone="warn" title="Inactive because the token was deleted." />;
}

/** Facts of an access the page shows in several places. */
function facts(model: AccessPageModel) {
  const { grant, edge, profile, labels } = model;
  const claims = anchorClaims(profile);
  const repositoryId =
    claims === null
      ? null
      : (grant.conditions.find(
          (c) => c.claim === claims.repository && c.match === 'exact' && c.negate !== true,
        )?.values[0] ?? null);
  const repositoryLabel =
    repositoryId !== null && claims !== null
      ? labelFor(labels, claims.repository, repositoryId)
      : null;
  const environment =
    grant.conditions.find(
      (c) => c.claim === 'environment' && c.match === 'exact' && c.negate !== true,
    )?.values[0] ?? null;
  const workflowPin = grant.conditions.find(
    (c) => (c.claim === 'job_workflow_ref' || c.claim === 'ci_config_ref_uri') && c.negate !== true,
  )?.values[0];
  const protectedRefs = grant.conditions.some(
    (c) => c.claim === 'ref_protected' && c.match === 'exact' && c.values.includes('true'),
  );
  const presetNames = (model.template?.operation_presets ?? [])
    .filter((preset) =>
      preset.rules.every((rule) =>
        grant.rules.some(
          (stored) =>
            stored.path ===
              rule.path.replaceAll(REPO_PLACEHOLDER, repositoryLabel ?? '‹repository›') &&
            rule.methods.every((method) => stored.methods.includes(method)),
        ),
      ),
    )
    .map((preset) => preset.label);
  return {
    repositoryId,
    repositoryLabel,
    environment,
    workflowPin,
    protectedRefs,
    presetNames,
    subject: typicalSubject(profile, repositoryLabel, edge.context),
    events: eventSummary(grant.conditions, profile),
  };
}

export function AccessHeader(props: { model: AccessPageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { grant, edge, consumer, token } = model;
  const { repositoryId } = facts(model);
  // An active access with an accepted risk leads with "Risk accepted" (brief A5); a later expiry
  // that is not yet "Expires in N days" (14 days) still shows when it ends.
  const lead = leadStatus(edge);
  const expiresIn =
    grant.expires_at !== null && grant.expires_at > ctx.now && edge.status !== 'expiring'
      ? relativeTime(grant.expires_at, ctx.now)
      : null;
  return (
    <PageHeader
      crumbs={[{ label: 'Consumer access', href: paths.access() }, { label: grant.name }]}
      identity={
        <Identity
          logo={consumerLogo(consumer)}
          title={grant.name}
          status={
            <>
              <StatusBadge status={lead.status} detail={lead.detail} />
              {lead.rest.map((flag) => (
                <>
                  {' '}
                  <StatusBadge status={flag.status} detail={flag.detail} />
                </>
              ))}
              {expiresIn !== null ? (
                <>
                  {' '}
                  <Badge glyph="⌛">Expires {expiresIn}</Badge>
                </>
              ) : null}
            </>
          }
          entityId={{ value: grant.id, kind: 'Access' }}
          facts={[
            `Created ${formatTime(new Date(grant.created_at), 'date')}${grant.created_by ? ` by ${grant.created_by}` : ''}`,
          ]}
        />
      }
      actions={
        ctx.can('access:write') ? (
          <>
            <DialogTrigger dialog="dlg-rename-access">Rename…</DialogTrigger>
            <ActionButton
              action={`${paths.accessItem(grant.id)}/toggle`}
              csrf={ctx.csrf}
              label={grant.enabled ? 'Disable' : 'Enable'}
              context={grant.name}
              fields={{ enabled: grant.enabled ? '0' : '1' }}
              returnTo="detail"
            />
            {model.edit ? (
              <Button
                variant="primary"
                href={paths.accessItem(grant.id, { open: 'edit', hash: 'edit' })}
              >
                Change this access
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <RelationLine>
        <a href={paths.consumer(consumer.id)}>{consumer.name}</a>
        <span class="sep" aria-hidden="true">
          {' '}
          ›{' '}
        </span>
        <span class="vh">, </span>
        {repositoryId !== null ? (
          <a href={paths.access({ repository: repositoryId })}>{edge.subject}</a>
        ) : (
          edge.subject
        )}
        <span class="sep" aria-hidden="true">
          {' '}
          ›{' '}
        </span>
        <span class="vh">, </span>
        <span>{edge.context}</span>
        <span class="sep" aria-hidden="true">
          {' '}
          →{' '}
        </span>
        <span class="vh"> can use </span>
        <a href={paths.token(token.id)}>{token.name}</a>
      </RelationLine>
    </PageHeader>
  );
}

export function AccessPage(props: { model: AccessPageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { grant, edge, consumer, profile, token, labels } = model;
  const canWrite = ctx.can('access:write');
  const f = facts(model);
  const claims = anchorClaims(profile);
  const owners =
    claims === null
      ? []
      : pinOwnerValues(consumer, claims.owner).map((value) => {
          const label = labelFor(labels, claims.owner, value);
          return label ? `${label} (${value})` : value;
        });
  const risky = model.warningDetails.length > 0;
  const limitable = model.warningDetails.some(
    (warning) => warning.code === 'any_ref' || warning.code === 'unprotected_ref',
  );
  const deleteDialog: ConfirmDialogProps = {
    id: 'delete-access',
    trigger: 'Delete this access…',
    triggerContext: grant.name,
    title: `Delete ${grant.name}?`,
    body: 'You cannot undo this. To pause it instead, use Disable; you can enable it again.',
    affected: [
      <>
        {edge.subject} can no longer use {token.name} from the next request on.
        {model.requests30d ? (
          <>
            {' '}
            <a href={paths.requests({ access: grant.id })}>
              {formatCount(model.requests30d)} requests
            </a>{' '}
            used it in 30 days.
          </>
        ) : null}
      </>,
      ...(risky ? ['The accepted risk and its history stay in the audit log.'] : []),
    ],
    confirmLabel: `Delete ${grant.name}`,
    danger: true,
    variant: 'standalone',
    action: `${paths.accessItem(grant.id)}/delete`,
    csrf: ctx.csrf,
  };
  return (
    <>
      <InactiveCause edge={edge} />
      <DetailLayout
        railLabel="Access activity and details"
        rail={<AccessRail model={model} ctx={ctx} subject={f.subject} />}
      >
        <Tray
          id="flow"
          title="How a call flows"
          description="Every condition must match, or the call is denied."
          actions={
            canWrite && model.edit ? (
              <Button size="sm" href={paths.accessItem(grant.id, { open: 'edit', hash: 'edit' })}>
                Change the conditions
              </Button>
            ) : undefined
          }
        >
          <Panel variant="pad">
            <Trace
              label="Conditions of this access"
              steps={[
                {
                  state: 'pass',
                  glyph: '',
                  status: 'Consumer',
                  title: consumer.name,
                  detail:
                    owners.length > 0 ? (
                      <>
                        {profile.id === 'gitlab-ci' ? 'group' : 'organization'}{' '}
                        <Mono>{owners.join(', ')}</Mono>
                      </>
                    ) : (
                      issuerHost(consumer.issuer)
                    ),
                },
                {
                  state: risky ? 'warn' : 'pass',
                  glyph: risky ? '⚠' : '',
                  status: 'Jobs',
                  title: <Mono>{edge.subject}</Mono>,
                  detail: (
                    <>
                      {risky ? <b class="t-warn">{edge.context}</b> : edge.context}
                      {f.protectedRefs ? ' · protected refs only' : ''}
                    </>
                  ),
                },
                {
                  state: 'pass',
                  glyph: '',
                  status: 'May call',
                  title:
                    f.presetNames.join(', ') ||
                    `${grant.rules.length} ${grant.rules.length === 1 ? 'operation' : 'operations'}`,
                  detail: (
                    <Mono>
                      {grant.rules
                        .map((rule) => `${rule.methods.join(', ')} ${rule.path}`)
                        .join(' · ')}
                    </Mono>
                  ),
                },
                {
                  state: 'pass',
                  glyph: '',
                  status: 'Token',
                  title: token.name,
                  detail: <Mono>{hostOf(token.base_url)}</Mono>,
                },
              ]}
            />
          </Panel>
        </Tray>

        {risky ? (
          <Callout
            tone="warn"
            title="Accepted risk:"
            more={
              model.acceptedBy
                ? `Accepted by ${model.acceptedBy.actor} on ${formatTime(new Date(model.acceptedBy.ts), 'date')}.`
                : undefined
            }
            actions={
              canWrite && limitable && model.edit ? (
                <Button size="sm" href={paths.accessItem(grant.id, { open: 'edit', hash: 'edit' })}>
                  Limit to protected refs
                </Button>
              ) : undefined
            }
          >
            {model.warningDetails.map((warning) => warning.message).join(' ')}
          </Callout>
        ) : null}

        <Tray
          id="use"
          title="Connect your jobs"
          description={`Add this to a workflow in ${edge.subject}. Nothing else needs a secret.`}
        >
          <Panel variant="pad">
            <ConsumerSnippet
              consumer={consumer}
              origin={model.origin}
              slugs={[token.slug]}
              environment={f.environment}
              call={snippetCall(grant.rules)}
            />
          </Panel>
        </Tray>

        <Tray id="summary" title="What this access allows">
          <Panel variant="pad">
            <KeyValue items={summaryItems(model, f, ctx)} />
            <Disclosure summary="Exact conditions">
              <CodeBlock label="Exact conditions">{formatConditions(grant.conditions)}</CodeBlock>
            </Disclosure>
          </Panel>
        </Tray>

        {model.overlaps.length > 0 ? (
          <Tray
            id="overlap"
            title="Also matched by"
            description="These enabled accesses of the same consumer and token cover the same jobs. A call is allowed when any one of them matches; the request record names the oldest."
          >
            <Panel variant="flush">
              <ul class="con-list">
                {model.overlaps.map((other) => (
                  <li>
                    <ArrowRow
                      href={paths.accessItem(other.grant.id)}
                      consumer={{
                        name: <Mono>{other.subject}</Mono>,
                        context: shortContext(other.context),
                      }}
                      token={{ name: token.name, logo: tokenLogo(token) }}
                    />{' '}
                    <span class="meta">{other.grant.name}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </Tray>
        ) : null}

        {canWrite ? <CopySection model={model} ctx={ctx} repositoryId={f.repositoryId} /> : null}

        {canWrite && model.edit ? (
          <Tray id="edit-tray" title="Change this access" hideTitle>
            <Panel variant="pad">
              <Disclosure
                id="edit"
                summary="Change this access"
                hint="The same form as Give access, with consumer and token fixed."
                open={model.editOpen}
              >
                <AccessForm model={model.edit} />
              </Disclosure>
            </Panel>
          </Tray>
        ) : null}

        {canWrite ? (
          <DangerZone id="danger">
            <DangerRow
              title="Delete this access"
              description="Disable stops it now and can be undone. Delete removes it for good; its history stays in the audit log."
              action={<ConfirmTrigger {...deleteDialog} />}
            />
          </DangerZone>
        ) : null}
      </DetailLayout>
      {canWrite ? (
        <>
          <Dialog
            id="dlg-rename-access"
            title="Rename this access"
            action={paths.accessItem(grant.id)}
            hidden={ctx.hidden({ expected_updated_at: String(grant.updated_at) })}
            open={model.rename.open}
            wide
            footer={
              <>
                <DialogClose dialog="dlg-rename-access" />
                <Button variant="primary" type="submit" name="intent" value="rename">
                  Save name
                </Button>
              </>
            }
          >
            <Field
              name="name"
              label="Name"
              value={model.rename.name}
              example="Slack for acme/api (environment production)"
              maxlength={100}
              error={model.rename.errors.name ?? null}
              autocomplete="off"
              conditional
            />
            <TextArea
              name="description"
              label="Description"
              optional
              value={model.rename.description}
              hint="Why this access exists, a ticket link, or an owner to ask."
              error={model.rename.errors.description ?? null}
              autocomplete="off"
              rows={2}
              conditional
            />
          </Dialog>
          <ConfirmBox {...deleteDialog} />
        </>
      ) : null}
    </>
  );
}

function summaryItems(
  model: AccessPageModel,
  f: ReturnType<typeof facts>,
  ctx: ViewContext,
): KeyValueItem[] {
  const { grant, edge, profile } = model;
  const events = f.events;
  const expires = grant.expires_at;
  return [
    {
      label: profile.id === 'gitlab-ci' ? 'Project or pipeline' : 'Repository or workflow',
      value:
        f.repositoryId !== null ? (
          <Mono>
            {edge.subject} ({f.repositoryId})
          </Mono>
        ) : (
          edge.subject
        ),
    },
    { label: 'Context', value: edge.context },
    { label: 'Protected refs', value: f.protectedRefs ? 'Required' : 'Not required' },
    {
      label: 'Workflow pin',
      value: f.workflowPin ? <Mono>{f.workflowPin}</Mono> : <span class="muted">None</span>,
    },
    {
      label: 'Allowed operations',
      value: (
        <>
          {f.presetNames.length > 0 ? f.presetNames.join(', ') : null}
          <ul class="operations">
            {grant.rules.map((rule) => (
              <li>
                <code>
                  {rule.methods.join(', ')} {rule.path}
                </code>
              </li>
            ))}
          </ul>
        </>
      ),
    },
    {
      label: 'Accepted risks',
      value:
        model.warningDetails.length === 0 ? (
          'None'
        ) : (
          <>
            {model.warningDetails.map((warning) => (
              <span class="d-block">
                <Badge tone="warn" glyph="⚠">
                  Risk
                </Badge>{' '}
                {warning.message}
              </span>
            ))}
            <span class="meta d-block">
              <a href={paths.audit({ target: grant.id })}>History of this access</a>
            </span>
          </>
        ),
    },
    {
      label: 'Expires',
      value:
        expires === null ? (
          'Never'
        ) : (
          <>
            <UiTime datetime={new Date(expires)} format="date" />
            <span class="meta d-block">{relativeTime(expires, ctx.now)}</span>
          </>
        ),
    },
    {
      label: 'Last used',
      value: (
        <>
          {edge.lastUsedHour === null
            ? 'No allowed calls in 30 days'
            : lastUsedTime(edge.lastUsedHour, ctx.now)}
          {model.requests30d !== null
            ? ` · ${formatCount(model.requests30d)} allowed requests in 30 days`
            : ''}
          {' · '}
          <a href={paths.requests({ access: grant.id })}>Requests</a>
        </>
      ),
    },
    ...(events
      ? [
          {
            label: `Events accepted (${events.claim})`,
            value: (
              <>
                {[...events.trusted, ...events.optedIn].join(', ') || 'none'}.
                <span class="meta d-block">
                  Implicitly excluded:{' '}
                  {events.restricted
                    ? [
                        ...profile.trustedEvents.filter((event) => !events.trusted.includes(event)),
                        `every other ${events.claim} value`,
                      ].join(', ')
                    : `every other ${events.claim} value`}
                  .
                </span>
              </>
            ),
          },
        ]
      : []),
    {
      label: 'Created',
      value: (
        <>
          {formatTime(new Date(grant.created_at), 'date')} by {grant.created_by ?? 'unknown'} ·{' '}
          <a href={paths.audit({ target: grant.id })}>History</a>
        </>
      ),
    },
  ];
}

function AccessRail(props: { model: AccessPageModel; ctx: ViewContext; subject: string | null }) {
  const { model, ctx } = props;
  const { grant, edge, consumer } = model;
  return (
    <>
      <Tray id="act" title="Activity" description="Last 30 days">
        <Panel>
          <Kpis
            items={[
              {
                label: 'Allowed requests',
                value: model.requests30d ?? '—',
                meta: `Last used ${
                  edge.lastUsedHour === null
                    ? 'more than 30 days ago'
                    : lastUsedTime(edge.lastUsedHour, ctx.now)
                }`,
                link: {
                  href: paths.requests({ access: grant.id }),
                  label: 'See requests of this access',
                },
              },
            ]}
          />
        </Panel>
      </Tray>
      {model.history.length > 0 ? (
        <Tray
          id="hist"
          title="History"
          actions={
            <a class="sm" href={paths.audit({ target: grant.id })}>
              Audit log
            </a>
          }
        >
          <Panel>
            <Feed compact>
              {model.history.map((entry) => (
                <FeedItem
                  avatar={<Avatar name={entry.actor} size="sm" />}
                  time={
                    <UiTime datetime={new Date(entry.ts)}>{relativeTime(entry.ts, ctx.now)}</UiTime>
                  }
                >
                  {entry.summary}
                </FeedItem>
              ))}
            </Feed>
          </Panel>
        </Tray>
      ) : null}
      <Tray id="ids" title="Details">
        <Panel>
          <RailKeyValue
            items={[
              { label: 'Access ID', value: grant.id, mono: true, copyable: true },
              ...(props.subject
                ? [{ label: 'Typical subject', value: props.subject, mono: true, copyable: true }]
                : []),
              { label: 'Consumer ID', value: consumer.id, mono: true, copyable: true },
            ]}
          />
          <RailFoot>
            <a href={paths.audit({ target: grant.id })}>Audit history →</a>
          </RailFoot>
        </Panel>
      </Tray>
    </>
  );
}

/** The 5 most used other repositories offered as picks in the copy form. */
const COPY_PICKS = 5;

function CopySection(props: {
  model: AccessPageModel;
  ctx: ViewContext;
  repositoryId: string | null;
}) {
  const { model, ctx } = props;
  const gitlab = model.profile.id === 'gitlab-ci';
  const anchors = anchorsOf(model.edge, model.labels);
  const claims = anchorClaims(model.profile);
  const expiresAt = model.grant.expires_at;
  if (claims === null || props.repositoryId === null) {
    return (
      <Tray id="copy" title="Copy to another token">
        <Panel variant="pad">
          <p>
            <a href={paths.accessNew({ copy: model.grant.id })}>Copy to another token</a> opens the
            form with these constraints.
          </p>
        </Panel>
      </Tray>
    );
  }
  // The placeholder names the consumer's first labelled organization or group (A7.8).
  const firstOwner =
    pinOwnerValues(model.consumer, claims.owner)
      .map((value) => labelFor(model.labels, claims.owner, value))
      .find((label) => label !== null) ?? null;
  const example = gitlab
    ? `${firstOwner ?? 'acme-group'}/app (4567890)`
    : `${firstOwner ?? 'acme'}/api (89012345)`;
  const own = `${anchors[0]?.subject ?? props.repositoryId} (${props.repositoryId})`;
  const ownValue = model.repositoryOptions.find((option) => option.value === own)?.value ?? own;
  const others = model.repositoryOptions
    .filter((option) => option.value !== ownValue)
    .slice(0, COPY_PICKS);
  const options = [
    { value: ownValue, label: ownValue, mono: true, meta: 'this one' },
    ...others.map((option) => ({ value: option.value, label: option.value, mono: true })),
  ];
  const typed = model.copy.repository.trim();
  const matched = options.find((option) => option.value === typed);
  const anotherO = options.length + 1;
  const checked = matched ? matched.value : '';
  const pickId = 'f-copy-repository-pick';
  const checkedIndex = options.findIndex((option) => option.value === checked);
  useFocusTarget(
    'copy-repository',
    checked === '' ? 'f-copy-repository' : `${pickId}-${checkedIndex + 1}`,
  );
  const tokenPicks = model.tokens.length <= 6;
  if (tokenPicks) useFocusTarget('copy-token_id', 'f-copy-token_id-1');
  const tokenMeta = (token: Service) =>
    token.id === model.token.id
      ? 'this one, same operations'
      : model.reviewTokens.has(token.id)
        ? '(review operations)'
        : undefined;
  return (
    <Tray
      id="copy"
      title="Copy to another repository or token"
      description={
        model.warningDetails.length === 0
          ? 'Keeps the constraints. The copy has no accepted risks.'
          : `Keeps the constraints. The copy keeps these accepted risks: ${model.warningDetails.map((w) => w.message).join('; ')}.`
      }
    >
      <Panel variant="pad">
        <PostForm
          action={`${paths.accessItem(model.grant.id)}/copy`}
          csrf={ctx.csrf}
          class="ga-copy con-stack"
        >
          <FieldSet id={pickId} legend={gitlab ? 'Project' : 'Repository'}>
            <Picks
              name="repository"
              value={checked}
              options={[
                ...options.map((option, index) => ({ ...option, o: index + 1 })),
                { value: '', o: anotherO, label: 'Another…' },
              ]}
            />
          </FieldSet>
          <div class="ga-copy-other subbox">
            <IdWithLabelField
              kind={gitlab ? 'gitlab_project' : 'github_repo'}
              name="repository_other"
              id="f-copy-repository"
              label={`${gitlab ? 'Project' : 'Repository'} name (ID)`}
              value={checked === '' ? model.copy.repository : ''}
              example={example}
              findCommand={repositoryFindCommand(model.profile, anchors[0]?.subject)}
              suggestions={model.repositoryOptions}
              error={model.copy.error.repository ?? null}
              autocomplete="off"
              conditional
            />
          </div>
          {tokenPicks ? (
            <FieldSet id="f-copy-token_id" legend="Token" error={model.copy.error.token_id}>
              <Picks
                name="token_id"
                value={model.copy.tokenId}
                options={model.tokens.map((token) => ({
                  value: token.id,
                  label: token.name,
                  meta: tokenMeta(token),
                }))}
              />
            </FieldSet>
          ) : (
            <Select
              name="token_id"
              id="f-copy-token_id"
              label="Token"
              value={model.copy.tokenId}
              options={model.tokens.map((token) => ({
                value: token.id,
                label: `${token.name}${model.reviewTokens.has(token.id) ? ' (review operations)' : ''}`,
              }))}
              error={model.copy.error.token_id ?? null}
            />
          )}
          {expiresAt === null ? null : expiresAt > ctx.now ? (
            <p class="hint">
              The copy expires with this access: {formatTime(new Date(expiresAt), 'date')}.
            </p>
          ) : (
            <p class="hint">
              This access has expired: Create copy opens the form so that you choose when the copy
              expires.
            </p>
          )}
          <SubmitRow hint="A copy to another token with other operations opens the Give access form with these values filled in.">
            <Button type="submit">Create copy</Button>
          </SubmitRow>
        </PostForm>
      </Panel>
    </Tray>
  );
}
