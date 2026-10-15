// The consumer access page (A14.5): who can use which token in which context, how to connect the
// job, what the access allows, the risks it carries, overlapping accesses, a one-submit copy, the
// edit form and the delete dialog. Read-only parts are shown to every role.
import type { Child } from 'hono/jsx';
import { labelFor } from '../../db/claim-labels';
import type { CallerProvider, ClaimLabel, Grant, Service } from '../../db/types';
import type { IssuerProfile } from '../../identity/types';
import type { WarningDetail } from '../../policy/validate';
import type { AccessEdge } from '../connections';
import { anchorClaims, repositoryFindCommand } from '../consumer-access';
import { eventSummary, formatConditions } from '../grant-text';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { REPO_PLACEHOLDER, type ServiceTemplate } from '../service-templates';
import { AccessForm, type AccessFormModel } from './access-form';
import {
  ActionButton,
  ConfirmDialog,
  Details,
  Field,
  IdWithLabelField,
  PostForm,
  Select,
  StatusBadge,
  type Suggestion,
  TextArea,
  Time,
  VersionField,
} from './components';
import { ConsumerSnippet } from './consumer-snippet';
import { formatCount, relativeTime } from './format';
import { anchorsOf, shortContext } from './matrix';

const HOUR_MS = 3_600_000;

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

function inactiveCause(edge: AccessEdge): Child {
  if (edge.status !== 'inactive') return null;
  const reason = edge.statusDetail ?? '';
  if (reason === 'consumer disabled' && edge.consumer) {
    return (
      <p>
        Inactive because the consumer is disabled:{' '}
        <a href={paths.consumer(edge.consumer.id)}>{edge.consumer.name}</a>.
      </p>
    );
  }
  if (edge.token) {
    return (
      <p>
        Inactive because the {reason.startsWith('token') ? '' : 'token’s '}
        {reason}: <a href={paths.token(edge.token.id)}>{edge.token.name}</a>.
      </p>
    );
  }
  return <p>Inactive because the token was deleted.</p>;
}

export function AccessPage(props: { model: AccessPageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { grant, edge, consumer, profile, token, labels } = model;
  const canWrite = ctx.can('access:write');
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
  const subject = typicalSubject(profile, repositoryLabel, edge.context);
  const events = eventSummary(grant.conditions, profile);
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
  return (
    <>
      <p class="relationship">
        <a href={paths.consumer(consumer.id)}>{consumer.name}</a>
        <span aria-hidden="true"> › </span>
        <span class="vh">, </span>
        {repositoryId !== null ? (
          <a href={paths.access({ repository: repositoryId })}>{edge.subject}</a>
        ) : (
          edge.subject
        )}
        <span aria-hidden="true"> › </span>
        <span class="vh">, </span>
        {edge.context}
        <span aria-hidden="true"> → </span>
        <span class="vh"> can use </span>
        <a href={paths.token(token.id)}>{token.name}</a>
      </p>
      {subject ? (
        <p class="hint">
          Typical subject claim: <code>{subject}</code>
        </p>
      ) : null}
      <p class="status-line">
        <StatusBadge status={edge.status} detail={edge.statusDetail} />
        {edge.flags.map((flag) => (
          <>
            {' '}
            <StatusBadge status={flag.status} detail={flag.detail} />
          </>
        ))}
      </p>
      {inactiveCause(edge)}
      {canWrite ? (
        <div class="actions header-actions">
          <ActionButton
            action={`${paths.accessItem(grant.id)}/toggle`}
            csrf={ctx.csrf}
            label={grant.enabled ? 'Disable' : 'Enable'}
            context={grant.name}
            fields={{ enabled: grant.enabled ? '0' : '1' }}
            returnTo="detail"
          />
          <details class="inline-details" open={model.rename.open}>
            <summary>Rename</summary>
            <PostForm action={paths.accessItem(grant.id)} csrf={ctx.csrf} class="stack">
              <VersionField value={String(grant.updated_at)} />
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
              <div class="actions">
                <button type="submit" name="intent" value="rename" class="primary">
                  Save name
                </button>
              </div>
            </PostForm>
          </details>
        </div>
      ) : null}

      <section id="use" aria-labelledby="use-h">
        <h2 id="use-h">Connect your jobs</h2>
        <ConsumerSnippet
          consumer={consumer}
          origin={model.origin}
          slugs={[token.slug]}
          environment={environment}
        />
      </section>

      <section aria-labelledby="summary-h">
        <h2 id="summary-h">What this access allows</h2>
        <Details
          rows={[
            [
              profile.id === 'gitlab-ci' ? 'Project or pipeline' : 'Repository or workflow',
              edge.subject,
            ],
            ['Context', edge.context],
            ['Protected refs', protectedRefs ? 'Required' : 'Not required'],
            ...(workflowPin
              ? ([['Workflow pin', <code>{workflowPin}</code>]] as Array<[string, Child]>)
              : []),
            [
              'Allowed operations',
              <>
                {presetNames.length > 0 ? <p>{presetNames.join(', ')}</p> : null}
                <ul class="operations">
                  {grant.rules.map((rule) => (
                    <li>
                      <code>
                        {rule.methods.join(', ')} {rule.path}
                      </code>
                    </li>
                  ))}
                </ul>
              </>,
            ],
            [
              'Accepted risks',
              model.warningDetails.length === 0 ? (
                'None'
              ) : (
                <>
                  <ul class="warnings">
                    {model.warningDetails.map((warning) => (
                      <li>
                        <strong>Risk:</strong> {warning.message}
                      </li>
                    ))}
                  </ul>
                  <a href={paths.audit({ target: grant.id })}>History of this access</a>
                </>
              ),
            ],
            [
              'Expires',
              grant.expires_at === null ? (
                'Never'
              ) : (
                <Time ms={grant.expires_at} relative now={ctx.now} />
              ),
            ],
            [
              'Created',
              <>
                <Time ms={grant.created_at} /> by {grant.created_by ?? 'unknown'} ·{' '}
                <a href={paths.audit({ target: grant.id })}>History</a>
              </>,
            ],
            [
              'Last used',
              <>
                {edge.lastUsedHour === null
                  ? 'No allowed calls in 30 days'
                  : relativeTime(edge.lastUsedHour + HOUR_MS / 2, ctx.now)}
                {model.requests30d !== null
                  ? `; ${formatCount(model.requests30d)} allowed requests in 30 days`
                  : ''}
                {' · '}
                <a href={paths.requests({ access: grant.id })}>Requests</a>
              </>,
            ],
            ...(events
              ? ([
                  [
                    `Events accepted (${events.claim})`,
                    <>
                      {[...events.trusted, ...events.optedIn].join(', ') || 'none'}. Implicitly
                      excluded:{' '}
                      {events.restricted
                        ? [
                            ...profile.trustedEvents.filter(
                              (event) => !events.trusted.includes(event),
                            ),
                            `every other ${events.claim} value`,
                          ].join(', ')
                        : `every other ${events.claim} value`}
                      .
                    </>,
                  ],
                ] as Array<[string, Child]>)
              : []),
          ]}
        />
        <details>
          <summary>Exact conditions</summary>
          <pre tabindex={0}>{formatConditions(grant.conditions)}</pre>
        </details>
      </section>

      {model.overlaps.length > 0 ? (
        <section aria-labelledby="overlap-h">
          <h2 id="overlap-h">Also matched by</h2>
          <p>
            These enabled accesses of the same consumer and token cover the same jobs. A call is
            allowed when any one of them matches; the request record names the oldest.
          </p>
          <ul>
            {model.overlaps.map((other) => (
              <li>
                <a href={paths.accessItem(other.grant.id)}>{other.grant.name}</a> (
                {shortContext(other.context)})
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canWrite ? <CopySection model={model} ctx={ctx} repositoryId={repositoryId} /> : null}

      {canWrite && model.edit ? (
        <details id="edit" open={model.editOpen}>
          <summary>Change this access</summary>
          <AccessForm model={model.edit} />
        </details>
      ) : null}

      {canWrite ? (
        <section id="danger" aria-labelledby="danger-h">
          <h2 id="danger-h">Delete</h2>
          <p>To stop it for now, disable it instead. The audit log keeps a copy.</p>
          <ConfirmDialog
            id="delete-access"
            trigger="Delete…"
            triggerContext={grant.name}
            title={`Delete ${grant.name}?`}
            body={`${edge.subject} can no longer use ${token.name} from the next request on.`}
            confirmLabel="Delete access"
            danger
            variant="standalone"
            action={`${paths.accessItem(grant.id)}/delete`}
            csrf={ctx.csrf}
          />
        </section>
      ) : null}
    </>
  );
}

function CopySection(props: {
  model: AccessPageModel;
  ctx: ViewContext;
  repositoryId: string | null;
}) {
  const { model, ctx } = props;
  const gitlab = model.profile.id === 'gitlab-ci';
  const repositoryLabel = props.repositoryId;
  const anchors = anchorsOf(model.edge, model.labels);
  if (anchorClaims(model.profile) === null || repositoryLabel === null) {
    return (
      <section id="copy" aria-labelledby="copy-h">
        <h2 id="copy-h">Copy to another token</h2>
        <p>
          <a href={paths.accessNew({ copy: model.grant.id })}>Copy to another token</a> opens the
          form with these constraints.
        </p>
      </section>
    );
  }
  return (
    <section id="copy" aria-labelledby="copy-h">
      <h2 id="copy-h">Copy to another repository or token</h2>
      <PostForm action={`${paths.accessItem(model.grant.id)}/copy`} csrf={ctx.csrf} class="stack">
        <IdWithLabelField
          kind={gitlab ? 'gitlab_project' : 'github_repo'}
          name="repository"
          id="f-copy-repository"
          label={gitlab ? 'Project' : 'Repository'}
          value={model.copy.repository}
          example={gitlab ? 'acme-group/app (4567890)' : 'acme/api (89012345)'}
          findCommand={repositoryFindCommand(model.profile, anchors[0]?.subject)}
          suggestions={model.repositoryOptions}
          error={model.copy.error.repository ?? null}
          autocomplete="off"
          required
        />
        <Select
          name="token_id"
          id="f-copy-token_id"
          label="Token"
          value={model.copy.tokenId}
          options={model.tokens.map((token) => ({
            value: token.id,
            label: `${token.name}${model.reviewTokens.has(token.id) ? ' (review operations)' : ''}`,
          }))}
          hint="Operations are copied when the token uses the same template; otherwise you review them first."
          error={model.copy.error.token_id ?? null}
        />
        <p>
          {model.warningDetails.length === 0
            ? 'The copy has no accepted risks.'
            : `The copy keeps these accepted risks: ${model.warningDetails.map((w) => w.message).join('; ')}.`}
        </p>
        <div class="actions">
          <button type="submit" class="primary">
            Create copy
          </button>
        </div>
      </PostForm>
    </section>
  );
}
