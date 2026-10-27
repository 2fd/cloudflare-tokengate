// The credential access rule page (A7.8) on design D: who may use which credential (issuer and tenants, with
// Add/Remove), which jobs, which operations, how to call, its requests and history; the rail holds
// its status, the global access rules of its issuer with each one's verdict for this rule (AR-8),
// its token settings, Enable/Disable, Copy to another credential and Edit. `?open=edit` renders the
// merged form in place of the main column (layout `fields`); its global status and risk callouts
// sit in the rail, so the page keeps one rail. Read-only parts are shown to every role; changes
// need access:write.
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
  RailFoot,
  RailKeyValue,
  RelationLine,
  SubmitRow,
  Time as UiTime,
  Tray,
} from '@tokengate/ui';
import { labelFor } from '../../db/claim-labels';
import type { ClaimLabel, CredentialAccessRule, GlobalAccessRule, Service } from '../../db/types';
import type { IssuerProfile } from '../../identity/types';
import type { GlobalStatus } from '../../policy/global-status';
import type { WarningDetail } from '../../policy/validate';
import type { RuleEdge } from '../connections';
import { pinValues, tenantClaimOf, tenantWord } from '../ops/credential-access-rules';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { anchorClaims, ownerFindCommand } from '../rule-access';
import { eventSummary, formatConditions } from '../rule-text';
import { REPO_PLACEHOLDER, type ServiceTemplate } from '../service-templates';
import { Breakable, hostOf, issuerHost, issuerLogo, leadStatus, tokenLogo } from './access-visuals';
import {
  ActionButton,
  type ConfirmDialogProps,
  ConfirmBox,
  ConfirmTrigger,
  IdWithLabelField,
  PostForm,
  Select,
  StatusBadge,
  VersionField,
} from './components';
import { GlobalRail, RuleForm, type RuleFormModel } from './credential-rule-form';
import { formatCount, lastUsedTime, relativeTime } from './format';
import { RuleSnippet, snippetCall } from './rule-snippet';

/** One line of the rule history in the rail. */
export interface HistoryEntry {
  ts: number;
  actor: string;
  summary: string;
}

export interface CredentialRulePageModel {
  rule: CredentialAccessRule;
  edge: RuleEdge;
  profile: IssuerProfile;
  token: Service;
  tokens: Service[];
  template: ServiceTemplate | null;
  labels: ClaimLabel[];
  warningDetails: WarningDetail[];
  /** The global access rules of the rule's issuer key, each with its verdict for this rule. */
  globals: Array<{ global: GlobalAccessRule; verdict: GlobalStatus['kind'] }>;
  origin: string;
  requests30d: number | null;
  edit: RuleFormModel | null;
  editOpen: boolean;
  /** The typed value of "Add organizations" after a failed add. */
  tenant: string;
  copy: { credentialId: string; open: boolean };
  /** The newest audit rows of this rule (rail history). */
  history: HistoryEntry[];
  /** Who accepted the current risks, from the newest audit row that recorded them. */
  acceptedBy: { actor: string; ts: number } | null;
  errors: Array<{ field: string | null; message: string }>;
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

/** The callout that says why an enabled rule does not work, or null. */
/** The callout title of each inactive reason (`InactiveReason`). */
const INACTIVE_TITLES: Readonly<Record<string, string>> = {
  'credential disabled': 'the credential is disabled',
  'credential has no secret': 'the credential has no secret',
  'credential unreadable': 'the secret of the credential cannot be read',
};

function InactiveCause(props: { model: CredentialRulePageModel }) {
  const { edge, token } = props.model;
  if (edge.status === 'global_blocked') {
    return (
      <Callout tone="bad" title="Blocked by the global access rules of its issuer:">
        no global access rule of {issuerHost(edge.rule.issuer)} can hold for this rule, so it admits
        nothing. See <a href="#global">Global access rules</a>.
      </Callout>
    );
  }
  if (edge.status !== 'inactive') return null;
  const reason = INACTIVE_TITLES[edge.statusDetail ?? ''] ?? 'the credential cannot be used';
  return (
    <Callout tone="warn" title={`Inactive because ${reason}:`}>
      <a href={paths.token(token.id)}>{token.name}</a>. A credential manager fixes it on the
      credential page.
    </Callout>
  );
}

/** Facts of a rule the page shows in several places. */
function facts(model: CredentialRulePageModel) {
  const { rule, edge, profile, labels } = model;
  const conditions = rule.conditions.filter((c) => typeof c === 'object' && c !== null);
  const claims = anchorClaims(profile);
  const repositoryId =
    claims === null
      ? null
      : (conditions.find(
          (c) => c.claim === claims.repository && c.match === 'exact' && c.negate !== true,
        )?.values[0] ?? null);
  const repositoryLabel =
    repositoryId !== null && claims !== null
      ? labelFor(labels, claims.repository, repositoryId)
      : null;
  const environment =
    conditions.find((c) => c.claim === 'environment' && c.match === 'exact' && c.negate !== true)
      ?.values[0] ?? null;
  const workflowPin = conditions.find(
    (c) => (c.claim === 'job_workflow_ref' || c.claim === 'ci_config_ref_uri') && c.negate !== true,
  )?.values[0];
  const protectedRefs = conditions.some(
    (c) => c.claim === 'ref_protected' && c.match === 'exact' && c.values.includes('true'),
  );
  const rules = rule.rules.filter((r) => typeof r === 'object' && r !== null);
  const presetNames = (model.template?.operation_presets ?? [])
    .filter((preset) =>
      preset.rules.every((presetRule) =>
        rules.some(
          (stored) =>
            stored.path ===
              presetRule.path.replaceAll(REPO_PLACEHOLDER, repositoryLabel ?? '‹repository›') &&
            presetRule.methods.every((method) => stored.methods.includes(method)),
        ),
      ),
    )
    .map((preset) => preset.label);
  return {
    conditions,
    rules,
    repositoryId,
    repositoryLabel,
    environment,
    workflowPin,
    protectedRefs,
    presetNames,
    subject: typicalSubject(profile, repositoryLabel, edge.context),
    events: eventSummary(conditions, profile),
  };
}

export function CredentialRuleHeader(props: { model: CredentialRulePageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { rule, edge, token } = model;
  const lead = leadStatus(edge);
  const expiresIn =
    rule.expires_at !== null && rule.expires_at > ctx.now && edge.status !== 'expiring'
      ? relativeTime(rule.expires_at, ctx.now)
      : null;
  return (
    <PageHeader
      crumbs={[
        { label: 'Credential access rules', href: paths.accessRules() },
        { label: rule.name },
      ]}
      identity={
        <Identity
          logo={issuerLogo(rule)}
          title={rule.name}
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
          entityId={{ value: rule.id, kind: 'Access rule' }}
          facts={[
            `Created ${formatTime(new Date(rule.created_at), 'date')}${rule.created_by ? ` by ${rule.created_by}` : ''}`,
          ]}
        />
      }
      actions={
        ctx.can('access:write') ? (
          <>
            <ActionButton
              action={`${paths.accessRule(rule.id)}/toggle`}
              csrf={ctx.csrf}
              label={rule.enabled ? 'Disable' : 'Enable'}
              context={rule.name}
              fields={{ enabled: rule.enabled ? '0' : '1' }}
              returnTo="detail"
            />
            <DialogTrigger dialog="dlg-copy-rule">Copy to another credential…</DialogTrigger>
            {model.editOpen ? null : (
              <Button variant="primary" href={paths.accessRule(rule.id, { open: 'edit' })}>
                Change this rule
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <RelationLine>
        <span>{issuerHost(rule.issuer)}</span>
        <span class="sep" aria-hidden="true">
          {' '}
          ›{' '}
        </span>
        <span class="vh">, </span>
        <span>{edge.subject}</span>
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

export function CredentialRulePage(props: { model: CredentialRulePageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { rule, edge, token } = model;
  const canWrite = ctx.can('access:write');
  const f = facts(model);
  const risky = model.warningDetails.length > 0;
  const deleteDialog: ConfirmDialogProps = {
    id: 'delete-rule',
    trigger: 'Delete this rule…',
    triggerContext: rule.name,
    title: `Delete ${rule.name}?`,
    body: 'You cannot undo this. To pause it instead, use Disable; you can enable it again.',
    affected: [
      <>
        {edge.subject} can no longer use {token.name} through this rule from the next request on.
        {model.requests30d ? (
          <>
            {' '}
            <a href={paths.requests({ rule: rule.id })}>
              {formatCount(model.requests30d)} requests
            </a>{' '}
            used it in 30 days.
          </>
        ) : null}
      </>,
      ...(risky ? ['The accepted risk and its history stay in the audit log.'] : []),
    ],
    confirmLabel: `Delete ${rule.name}`,
    danger: true,
    variant: 'standalone',
    action: `${paths.accessRule(rule.id)}/delete`,
    csrf: ctx.csrf,
  };
  const editing = canWrite && model.edit !== null && model.editOpen;
  return (
    <>
      <InactiveCause model={model} />
      <DetailLayout
        railLabel="Access rule status and details"
        rail={<RuleRail model={model} ctx={ctx} subject={f.subject} />}
      >
        {editing && model.edit ? (
          <Tray
            id="edit"
            title="Change this rule"
            description="The same form as Add credential access rule; the credential and the issuer type stay."
          >
            <Panel variant="pad">
              <RuleForm model={model.edit} />
            </Panel>
          </Tray>
        ) : (
          <>
            <WhoSection model={model} ctx={ctx} />
            <Tray
              id="jobs"
              title="Jobs"
              description="Every condition must match, or the call is denied."
            >
              <Panel variant="pad">
                <KeyValue items={jobItems(model, f)} />
                <Disclosure summary="Exact conditions">
                  <CodeBlock label="Exact conditions">{formatConditions(f.conditions)}</CodeBlock>
                </Disclosure>
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
              >
                {model.warningDetails.map((warning) => warning.message).join(' ')}
              </Callout>
            ) : null}
            <Tray
              id="operations"
              title="Operations"
              description={`What the jobs may call on ${token.name}.`}
            >
              <Panel variant="pad">
                {f.presetNames.length > 0 ? <p>{f.presetNames.join(', ')}</p> : null}
                <ul class="operations">
                  {f.rules.map((item) => (
                    <li>
                      <code>
                        {item.methods.join(', ')} {item.path}
                      </code>
                    </li>
                  ))}
                </ul>
              </Panel>
            </Tray>
            <Tray
              id="snippet"
              title="How to call"
              description={`Add this to a workflow of ${edge.subject}. Nothing else needs a secret.`}
            >
              <Panel variant="pad">
                <RuleSnippet
                  rule={rule}
                  origin={model.origin}
                  slugs={[token.slug]}
                  environment={f.environment}
                  call={snippetCall(f.rules)}
                />
              </Panel>
            </Tray>
            <Tray id="requests" title="Recent requests" description="Last 30 days">
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
                        href: paths.requests({ rule: rule.id }),
                        label: 'See the requests of this rule',
                      },
                    },
                  ]}
                />
              </Panel>
            </Tray>
            {model.history.length > 0 ? (
              <Tray
                id="history"
                title="History"
                actions={
                  <a class="sm" href={paths.audit({ target: rule.id })}>
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
                          <UiTime datetime={new Date(entry.ts)}>
                            {relativeTime(entry.ts, ctx.now)}
                          </UiTime>
                        }
                      >
                        {entry.summary}
                      </FeedItem>
                    ))}
                  </Feed>
                </Panel>
              </Tray>
            ) : null}
            {canWrite ? (
              <DangerZone id="danger">
                <DangerRow
                  title="Delete this rule"
                  description="Disable stops it now and can be undone. Delete removes it for good; its history stays in the audit log."
                  action={<ConfirmTrigger {...deleteDialog} />}
                />
              </DangerZone>
            ) : null}
          </>
        )}
      </DetailLayout>
      {canWrite ? (
        <>
          <CopyDialog model={model} ctx={ctx} />
          <ConfirmBox {...deleteDialog} />
        </>
      ) : null}
    </>
  );
}

/** Who: the issuer and the tenants it admits, with Add and Remove (I-TEN-1). */
function WhoSection(props: { model: CredentialRulePageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { rule, profile, labels } = model;
  const canWrite = ctx.can('access:write');
  const claim = tenantClaimOf(rule.profile);
  const gitlab = rule.profile === 'gitlab-ci';
  const err = (name: string) => model.errors.find((error) => error.field === name)?.message ?? null;
  const issuerItems: KeyValueItem[] = [
    { label: 'Issuer type', value: profile.label },
    { label: 'Issuer', value: <Breakable text={rule.issuer} />, mono: true },
  ];
  if (claim === null) {
    const pin = rule.tenant_pin.filter((c) => typeof c === 'object' && c !== null);
    return (
      <Tray
        id="tenants"
        title="Who"
        description="The issuer and the claims every token must carry."
      >
        <Panel variant="pad">
          <KeyValue
            items={[
              ...issuerItems,
              {
                label: 'Tenant pin',
                value:
                  pin.length === 0 ? (
                    <span class="t-warn">
                      None: every token this issuer signs for this audience reaches the jobs below.
                    </span>
                  ) : (
                    <ul class="con-pins">
                      {pin.map((condition) => (
                        <li>
                          <code>{condition.claim}</code> is {condition.values.join(' or ')}
                        </li>
                      ))}
                    </ul>
                  ),
              },
            ]}
          />
        </Panel>
      </Tray>
    );
  }
  const values = pinValues(rule.tenant_pin, claim);
  const used = (value: string) =>
    rule.conditions.some(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        c.claim === claim &&
        c.negate !== true &&
        Array.isArray(c.values) &&
        c.values.includes(value),
    );
  const word = tenantWord(rule.profile);
  return (
    <Tray
      id="tenants"
      title="Who"
      description={
        gitlab
          ? 'Only jobs from projects in these groups match.'
          : rule.profile === 'vercel'
            ? 'Only deployments of projects in this team match.'
            : 'Only jobs from repositories owned by these organizations match.'
      }
    >
      <Panel variant="pad">
        <KeyValue items={issuerItems} />
      </Panel>
      {values.length === 0 ? (
        <Panel variant="pad">
          <Callout tone="warn" title="Risk:">
            no {word} is pinned.
          </Callout>
        </Panel>
      ) : (
        <Panel variant="flush">
          {values.map((value, index) => {
            const label = labelFor(labels, claim, value);
            const shown = label ? `${label} (${value})` : value;
            const blocked = used(value);
            const last = values.length === 1;
            const whyId = blocked || last ? `tn-${index}-why` : undefined;
            return (
              <div class="dz-row con-tenant">
                <div>
                  <Mono>{shown}</Mono>
                  {blocked ? (
                    <p class="hint" id={whyId}>
                      The jobs of this rule use it. Change the jobs first.
                    </p>
                  ) : last ? (
                    <p class="hint" id={whyId}>
                      The last {word} cannot be removed; add another first.
                    </p>
                  ) : null}
                </div>
                {canWrite ? (
                  <PostForm action={`${paths.accessRule(rule.id)}/tenants`} csrf={ctx.csrf}>
                    <VersionField value={String(rule.updated_at)} />
                    <input type="hidden" name="intent" value="remove" />
                    <Button
                      size="sm"
                      type="submit"
                      name="remove"
                      value={value}
                      disabled={last || blocked}
                      describedBy={whyId}
                      srSuffix={shown}
                    >
                      Remove
                    </Button>
                  </PostForm>
                ) : null}
              </div>
            );
          })}
        </Panel>
      )}
      {canWrite ? (
        <Panel variant="pad">
          <PostForm
            action={`${paths.accessRule(rule.id)}/tenants`}
            csrf={ctx.csrf}
            class="con-stack"
          >
            <VersionField value={String(rule.updated_at)} />
            <IdWithLabelField
              kind={gitlab ? 'gitlab_group_list' : 'github_owner_list'}
              name="tenant"
              label={gitlab ? 'Add groups' : 'Add organizations'}
              value={model.tenant}
              example={gitlab ? 'acme-group/platform (5678902)' : 'acme-labs (7654321)'}
              findCommand={ownerFindCommand(profile)}
              hint="Separate several with commas."
              error={err('tenant')}
              autocomplete="off"
              required
            />
            <SubmitRow>
              <Button type="submit" name="intent" value="add">
                {gitlab ? 'Add groups' : 'Add organizations'}
              </Button>
            </SubmitRow>
          </PostForm>
        </Panel>
      ) : null}
    </Tray>
  );
}

function jobItems(model: CredentialRulePageModel, f: ReturnType<typeof facts>): KeyValueItem[] {
  const { edge, profile } = model;
  const events = f.events;
  return [
    {
      label:
        profile.id === 'vercel'
          ? 'Project'
          : profile.id === 'gitlab-ci'
            ? 'Project or pipeline'
            : 'Repository or workflow',
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
  ];
}

const VERDICT_TEXT: Readonly<Record<GlobalStatus['kind'], string>> = {
  not_limited: 'Not limited',
  within: 'Holds for every request of this rule',
  limited: 'Holds for some requests of this rule',
  blocked: 'Holds for no request of this rule',
};

function RuleRail(props: {
  model: CredentialRulePageModel;
  ctx: ViewContext;
  subject: string | null;
}) {
  const { model, ctx } = props;
  const { rule, edge } = model;
  const expires = rule.expires_at;
  return (
    <>
      <Tray id="status" title="Status">
        <Panel>
          <RailKeyValue
            items={[
              {
                label: 'State',
                value: rule.enabled
                  ? expires !== null && expires <= ctx.now
                    ? 'Expired'
                    : 'Enabled'
                  : 'Disabled',
              },
              {
                label: 'Expires',
                value:
                  expires === null
                    ? 'Never'
                    : `${formatTime(new Date(expires), 'date')} (${relativeTime(expires, ctx.now)})`,
              },
              { label: 'Credential', value: model.token.name },
            ]}
          />
        </Panel>
      </Tray>
      {model.edit && model.editOpen && model.edit.global ? (
        <Tray id="edit-global" title="Global access rules">
          <Panel variant="pad">
            <GlobalRail global={model.edit.global} />
          </Panel>
        </Tray>
      ) : (
        <Tray
          id="global"
          title="Global access rules"
          actions={
            <a class="sm" href={paths.globalRules({ issuer: rule.issuer_key })}>
              Open
            </a>
          }
        >
          <Panel variant="pad">
            {model.globals.length === 0 ? (
              <p class="hint">Not limited: {issuerHost(rule.issuer)} has no global access rule.</p>
            ) : (
              <>
                {edge.globalStatus.kind === 'not_limited' ? (
                  <p class="hint">
                    Not limited: no global access rule of {issuerHost(rule.issuer)} is enabled.
                  </p>
                ) : (
                  <p>
                    <StatusBadge
                      status={
                        edge.globalStatus.kind === 'blocked'
                          ? 'global_blocked'
                          : edge.globalStatus.kind === 'limited'
                            ? 'global_limited'
                            : 'global_within'
                      }
                    />
                  </p>
                )}
                <ul class="con-list">
                  {model.globals.map(({ global, verdict }) => (
                    <li>
                      <a href={paths.globalRule(global.id)}>{global.name}</a>
                      <span class="meta d-block">
                        {global.enabled ? '' : 'Disabled · '}
                        {VERDICT_TEXT[verdict]}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
        </Tray>
      )}
      <Tray id="trust" title="Token settings">
        <Panel>
          <RailKeyValue
            items={[
              { label: 'Audience', value: rule.audience, mono: true, copyable: true },
              { label: 'JWKS URI', value: <Breakable text={rule.jwks_uri} />, mono: true },
              { label: 'Algorithms', value: rule.allowed_algs.join(', ') },
              { label: 'Maximum token age', value: `${rule.max_token_age_seconds} s` },
              ...(rule.profile === 'generic'
                ? [{ label: 'Anchor claims', value: rule.anchor_claims.join(', '), mono: true }]
                : []),
            ]}
          />
        </Panel>
      </Tray>
      <Tray id="ids" title="Details">
        <Panel>
          <RailKeyValue
            items={[
              { label: 'Access rule ID', value: rule.id, mono: true, copyable: true },
              ...(props.subject
                ? [{ label: 'Typical subject', value: props.subject, mono: true, copyable: true }]
                : []),
              { label: 'Credential host', value: hostOf(model.token.base_url), mono: true },
            ]}
          />
          <RailFoot>
            <a href={paths.audit({ target: rule.id })}>Audit history →</a>
          </RailFoot>
        </Panel>
      </Tray>
    </>
  );
}

/** "Copy to another credential": the same rule, a new id, on the chosen credential (A7.8). */
function CopyDialog(props: { model: CredentialRulePageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const err = model.errors.find((error) => error.field === 'copy-credential_id')?.message ?? null;
  return (
    <Dialog
      id="dlg-copy-rule"
      title="Copy to another credential"
      action={`${paths.accessRule(model.rule.id)}/copy`}
      hidden={ctx.hidden()}
      open={model.copy.open}
      footer={
        <>
          <DialogClose dialog="dlg-copy-rule" />
          <Button variant="primary" type="submit">
            Create copy
          </Button>
        </>
      }
    >
      <p>
        The copy keeps the issuer, the tenants, the jobs, the operations and the token settings. It
        starts enabled.
      </p>
      <Select
        name="credential_id"
        id="f-copy-credential_id"
        label="Credential"
        value={model.copy.credentialId}
        options={model.tokens.map((token) => ({
          value: token.id === model.token.id ? '' : token.id,
          label: token.id === model.token.id ? `${token.name} (this one)` : token.name,
        }))}
        hint="A copy to a credential with other operations or other risks, or a copy of an expired rule, opens the form with these values instead."
        error={err}
      />
    </Dialog>
  );
}

/** The tile of the credential of a rule, for other pages. */
export function credentialTile(token: Service | null) {
  return tokenLogo(token);
}
