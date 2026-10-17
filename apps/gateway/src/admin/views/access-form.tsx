// The consumer access form (A14.4) on design D: a ui LiveForm with numbered steps (Consumer,
// Which jobs, Allowed operations, Expires), a summary rail that follows the choices without JS,
// and the risk acceptance when the server asks for one. A choice between several consumers or
// tokens is a list whose branches hold that choice's own fields, prefixed with its id, so hidden
// branches never share a field name and the server reads only the chosen one. The live slots of
// the ui (`.sfN`/`.rvN`) are global to the form, so the fields of a consumer branch use the
// page-local scoped classes (`.ga-scope`, `.ga-fN`, `.ga-rN`; pages.css) instead. The primary
// submit is the first submit in tree order; "Write conditions by hand", "Add 2 more rows" and
// "Show fields" are secondary submits after it (formnovalidate), and write nothing.
import {
  Badge,
  Button,
  ButtonRow,
  Callout,
  CheckPresets,
  cx,
  Disclosure,
  FieldSet,
  FixedBar,
  FormStep,
  Inherit,
  KeyValue,
  LiveForm,
  LivePhrase,
  LiveSummary,
  More,
  Panel,
  Picks,
  RadioCards as UiRadioCards,
  Reveal,
  RiskAcceptance,
  RiskSwitch,
  RiskTag,
  RowPicker,
  Stepper,
  SubmitRow,
  SummaryFoot,
  SummaryRow,
  SummaryWire,
  Tray,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import { type ConsumerSuggestions, type RuleSet, ruleSetKey } from '../../db/suggestions';
import type { CallerProvider, ClaimLabel, Service } from '../../db/types';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import { PROXY_METHODS } from '../../policy/types';
import {
  type AccessContext,
  anchorClaims,
  CONTEXT_INPUT,
  contextsFor,
  type ExpiryForm,
  hasCheckboxes,
  isNumericId,
  isPathInjected,
  type JobsForm,
  type OpsForm,
  ownerFindCommand,
  pinOwnerValues,
  repositoryFindCommand,
  repositoryFindCommandForId,
} from '../consumer-access';
import type { FieldError } from '../ops/shared';
import { REPO_PLACEHOLDER, type ServiceTemplate } from '../service-templates';
import { consumerLogo, hostOf, Tile, tokenLogo, trustLine, useFocusTarget } from './access-visuals';
import {
  AddConsumerFields,
  type ConsumerForm,
  genericAnchorSuggestions,
} from './add-consumer-fields';
import {
  Checkbox,
  CheckboxGroup,
  Field,
  fieldId,
  IdWithLabelField,
  Select,
  type Suggestion,
} from './components';
import { formatTime } from './format';
import { AddRowsButton, BLANK_ROWS, RepeatingRows } from './rows';

export interface ConsumerBranch {
  provider: CallerProvider;
  profile: IssuerProfile;
  prefix: string;
  jobs: JobsForm;
  labels: ClaimLabel[];
  suggestions: ConsumerSuggestions;
  /** Known repositories as `name (ID)`, most used first. */
  repositoryOptions: Suggestion[];
  /** Accesses per repository option value. */
  repositoryCounts?: Record<string, number>;
  /** The safe context the consumer's accesses use most, or null without accesses. */
  mostUsedContext?: string | null;
  /** The repository's organization or group prefix that is not pinned yet (new_owner). */
  unknownOwner: string | null;
  accessCount: number;
  /** Extra blank condition rows (after "Add 2 more rows"). */
  extraRows?: number;
}

export interface NewConsumerBranch {
  form: ConsumerForm;
  /** The "Which jobs" fields of each type, prefix `new.<type>.`. */
  jobs: Record<ProfileId, ConsumerBranch>;
}

export interface TokenBranch {
  token: Service;
  template: ServiceTemplate | null;
  ruleSets: RuleSet[];
  pathSuggestions: string[];
  prefix: string;
  ops: OpsForm;
  /** The secret state in words ("Secret set", "No secret yet"). */
  credential: string;
  extraRows?: number;
}

export type ConsumerChoice =
  | { kind: 'fixed'; branch: ConsumerBranch; changeHref: string | null; newHref: string | null }
  | { kind: 'cards'; branches: ConsumerBranch[]; selected: string; newBranch: NewConsumerBranch }
  | {
      kind: 'select';
      options: CallerProvider[];
      selected: string;
      branch: ConsumerBranch | null;
    }
  | { kind: 'new'; newBranch: NewConsumerBranch; existingHref: string | null };

export type TokenChoice =
  | { kind: 'fixed'; branch: TokenBranch; changeHref: string | null }
  | { kind: 'cards'; branches: TokenBranch[]; selected: string }
  | { kind: 'select'; options: Service[]; selected: string; branch: TokenBranch | null };

/** The denied request a form was prefilled from (the rail shows it). */
export interface RequestFacts {
  id: string;
  ts: number;
  method: string;
  path: string;
  status: number;
  reason: string;
  repository: string | null;
  ref: string | null;
}

/** Where the form was opened from: its Cancel link and, from a request, the request. */
export interface FormEntry {
  cancelHref: string;
  cancelLabel: string;
  request?: RequestFacts | null;
}

export interface AccessFormModel {
  action: string;
  csrf: string;
  mode: 'create' | 'edit';
  /** Edit: the access's version. */
  version?: string;
  consumer: ConsumerChoice;
  token: TokenChoice;
  existingConsumers: CallerProvider[];
  expiry: ExpiryForm;
  /** Edit: the stored expiry ("Keep"). */
  keep?: number | null;
  now: number;
  /** The gateway origin, for the proxy URL in the rail. */
  origin?: string;
  entry?: FormEntry;
  /** Warnings the admin must acknowledge on this render (A7.7). */
  ack: { digest: string; warnings: string[] } | null;
  errors: FieldError[];
  /** Hidden fields to carry (e.g. `from_request`, `copy`). */
  hidden?: Record<string, string>;
  /** Page-level focus: the first new row after "Add 2 more rows" (ErrorSummary and notices win). */
  focus?: { group: string; index: number } | null;
}

/** The id of the risk acceptance; its checkbox (`-ack`) is the ErrorSummary target. */
const RISK_ID = 'ga-risk';

function errorFor(errors: readonly FieldError[], name: string): string | null {
  return errors.find((error) => error.field === name)?.message ?? null;
}

type Live = 'global' | 'scoped';

export function AccessForm(props: { model: AccessFormModel }) {
  const { model } = props;
  const err = (name: string) => errorFor(model.errors, name);
  const edit = model.mode === 'edit';
  const formId = edit ? 'access-edit' : 'access-form';
  const consumer = model.consumer;
  const token = model.token;
  const selectedJobs = selectedConsumerBranch(consumer);
  const selectedToken = selectedTokenBranch(token);
  const consumerFixed = consumer.kind === 'fixed';
  const tokenFixed = token.kind === 'fixed';
  if (model.ack) useFocusTarget('acknowledge_warnings', `${RISK_ID}-ack`);
  const hidden: Record<string, string> = {
    _csrf: model.csrf,
    ...(model.version !== undefined ? { expected_updated_at: model.version } : {}),
    ...model.hidden,
    ...(consumer.kind === 'fixed' && !edit ? { consumer_id: consumer.branch.provider.id } : {}),
    ...(consumer.kind === 'new' ? { consumer_id: 'new' } : {}),
    ...(token.kind === 'fixed' && !edit ? { token_id: token.branch.token.id } : {}),
    ...(model.ack ? { warnings_digest: model.ack.digest } : {}),
  };
  // Step numbers: a fixed consumer has no Consumer step; a new one has its jobs in that step.
  const consumerStep =
    consumer.kind === 'cards' || consumer.kind === 'select' || consumer.kind === 'new';
  const jobsStep = consumer.kind !== 'new';
  const opsN = Number(consumerStep) + Number(jobsStep) + 1;
  const steps: Child[] = [
    consumerStep ? <ConsumerStep model={model} n={1} /> : null,
    jobsStep ? <JobsStep model={model} n={consumerStep ? 2 : 1} /> : null,
    <OpsStep model={model} n={opsN} jobs={selectedJobs} />,
    <ExpiryStep model={model} n={opsN + 1} />,
  ];
  const liveRisk =
    !model.ack &&
    consumerFixed &&
    selectedJobs !== null &&
    selectedJobs.jobs.editor === 'structured' &&
    !edit;
  const tokenName = selectedToken?.token.name ?? 'the token';
  // Prefilled from a denied request, consumer and token fixed: a review of the values, the risk
  // tick and the submit; the full form waits in "Change the prefilled values" (1 tick + 1 submit).
  // The disclosure follows the submit, so Give access stays the first submit in tree order.
  const review =
    !edit &&
    model.entry?.request != null &&
    consumer.kind === 'fixed' &&
    token.kind === 'fixed' &&
    consumer.branch.jobs.editor === 'structured';
  const changeOpen =
    review &&
    (model.focus != null ||
      model.errors.some((error) => error.field !== null && error.field !== 'acknowledge_warnings'));
  const fields = (
    <>
      {!edit && tokenFixed ? (
        <TokenBar branch={token.branch} changeHref={token.changeHref} />
      ) : null}
      {!edit && consumerFixed ? (
        <ConsumerBar
          branch={consumer.branch}
          changeHref={consumer.changeHref}
          newHref={consumer.newHref}
        />
      ) : null}
      <Stepper>{steps}</Stepper>
    </>
  );
  const secondary = (
    <>
      {selectedJobs && selectedJobs.jobs.editor === 'structured' ? (
        <Button type="submit" name="_action" value="rows" formnovalidate>
          Write conditions by hand
        </Button>
      ) : null}
      {selectedJobs && selectedJobs.jobs.editor === 'rows' ? <AddRowsButton group="cond" /> : null}
      {selectedToken &&
      !isPathInjected(selectedToken.token) &&
      // "Other operations" starts with blank rows; more are offered once it is in use.
      (selectedToken.ops.rule.length > 0 ||
        (selectedToken.extraRows ?? 0) > 0 ||
        !hasCheckboxes(selectedToken)) ? (
        <Button type="submit" name="_action" value="add:rule" formnovalidate>
          Add {BLANK_ROWS} more operation rows
        </Button>
      ) : null}
      {consumer.kind === 'select' || token.kind === 'select' ? (
        <Button type="submit" name="_action" value="refresh" formnovalidate>
          Show fields for the chosen consumer and token
        </Button>
      ) : null}
    </>
  );
  return (
    <LiveForm
      id={formId}
      action={model.action}
      hidden={hidden}
      layout={edit ? 'fields' : 'form-layout'}
      class={edit ? undefined : cx('ga-form', review && 'ga-reviewing')}
      rail={edit ? undefined : <FormRail model={model} />}
    >
      {review && consumer.kind === 'fixed' && token.kind === 'fixed' ? (
        <ReviewCard jobs={consumer.branch} ops={token.branch} model={model} />
      ) : (
        fields
      )}
      {model.ack ? (
        <RiskAcceptance
          id={RISK_ID}
          always
          // The edit form sits in a closed disclosure (A7.6): the server enforces it there.
          required={!edit}
          title={`Accept ${model.ack.warnings.length === 1 ? '1 risk' : `${model.ack.warnings.length} risks`} to save this access`}
          risks={model.ack.warnings.map((warning) => ({ label: 'Risk', text: warning }))}
          confirm={`I accept ${model.ack.warnings.length === 1 ? 'this risk' : 'these risks'} for ${subjectOf(selectedJobs)} → ${tokenName}`}
          error={err('acknowledge_warnings')}
          hint="If you change the constraints or operations, the list may change and you are asked again."
        />
      ) : null}
      {liveRisk ? (
        <Callout
          tone="warn"
          class="ga-risknote"
          title="This choice accepts a risk."
          more="Saving accepts it; the access page lists it under Accepted risks. Pick a safer option above to avoid it."
        />
      ) : null}
      <SubmitRow
        hint={!edit ? 'After saving you get the workflow snippet for these jobs.' : undefined}
      >
        <Button
          variant="primary"
          type="submit"
          name={edit ? 'intent' : undefined}
          value={edit ? 'save' : undefined}
        >
          {edit ? 'Save changes' : 'Give access'}
        </Button>
        {!edit && model.entry ? (
          <Button href={model.entry.cancelHref}>{model.entry.cancelLabel}</Button>
        ) : null}
        {review ? null : secondary}
      </SubmitRow>
      {review ? (
        <Tray id="ga-change-tray" title="Change the prefilled values" hideTitle>
          <Panel variant="pad">
            <Disclosure
              id="ga-change"
              class="ga-change"
              summary="Change the prefilled values"
              hint="the full form, with these values"
              open={changeOpen}
            >
              {fields}
              <ButtonRow class="ga-change-acts">{secondary}</ButtonRow>
            </Disclosure>
          </Panel>
        </Tray>
      ) : null}
    </LiveForm>
  );
}

/** "Branch feature/login-redesign": the context of structured jobs as the review card says it. */
function contextWords(jobs: JobsForm): Child {
  const value = (text: string) => <span class="mono">{text}</span>;
  switch (jobs.context) {
    case 'environment':
      return <>Environment {value(jobs.environment)}</>;
    case 'branch':
      return <>Branch {value(jobs.branch)}</>;
    case 'tag':
      return <>Tag {value(jobs.tag)}</>;
    case 'release':
      return <>Release {value(jobs.release_tag)}</>;
    case 'pull_request':
      return <>Pull requests into {value(jobs.pr_base)}</>;
    case 'protected':
      return 'Any protected branch or tag';
    case 'any':
      return 'Any branch, tag or environment';
    default:
      return jobs.context;
  }
}

/**
 * The prefilled values of a give-access-from-a-request form, read-only (con-access-risk): who →
 * which token in the title, then repository, context, refs, operations and expiry. Saving reads
 * the same values from the fields in "Change the prefilled values"; once that is open this card
 * hides (pages.css), so it never shows values the admin has changed.
 */
function ReviewCard(props: { jobs: ConsumerBranch; ops: TokenBranch; model: AccessFormModel }) {
  const { jobs: branch, ops: tokenBranch, model } = props;
  const { jobs, provider } = branch;
  const token = tokenBranch.token;
  const gitlab = branch.profile.id === 'gitlab-ci';
  const repo = repositoryLabelOf(branch) ?? '‹repository›';
  const presets = (tokenBranch.template?.operation_presets ?? []).filter((preset) =>
    tokenBranch.ops.op.includes(preset.id),
  );
  const sets = tokenBranch.ruleSets.filter((set) => tokenBranch.ops.op.includes(set.id));
  const refScoped = ['environment', 'branch', 'tag', 'release'].includes(jobs.context);
  const expiry = expiryOptions(model).find((option) => option.value === model.expiry.expires);
  const operations: Child[] = [
    ...presets.map((preset) => (
      <span class="d-block">
        {preset.label}
        <code class="d-block">
          {preset.rules
            .map(
              (rule) =>
                `${rule.methods.join(', ')} ${rule.path.replaceAll(REPO_PLACEHOLDER, repo)}`,
            )
            .join(' · ')}
        </code>
      </span>
    )),
    ...sets.map((set) => (
      <code class="d-block">
        {set.rules.map((rule) => `${rule.methods.join(', ')} ${rule.path}`).join(' · ')}
      </code>
    )),
    ...tokenBranch.ops.rule
      .filter((row) => row.path.trim() !== '')
      .map((row) => (
        <code class="d-block">
          {row.m.join(', ')} {row.path}
        </code>
      )),
  ];
  return (
    <Tray
      id="ga-review"
      class="ga-review"
      title={
        <span class="ga-review-t">
          <Tile logo={consumerLogo(provider)} size="sm" />
          {provider.name}
          <span aria-hidden="true">→</span>
          <span class="vh">can use</span>
          <Tile logo={tokenLogo(token)} size="sm" />
          {token.name}
        </span>
      }
    >
      <Panel variant="pad">
        <KeyValue
          items={[
            {
              label: gitlab ? 'Project' : 'Repository',
              value: jobs.repository || 'Any of the consumer',
              mono: jobs.repository !== '',
            },
            { label: 'When', value: contextWords(jobs) },
            ...(refScoped
              ? [
                  {
                    label: 'Refs',
                    value:
                      jobs.ref_protection === 'unprotected' ? (
                        <>
                          <RiskTag /> Also unprotected branches and tags
                          <span class="meta d-block">
                            The caller’s ref is not protected, so only this choice allows the call.
                          </span>
                        </>
                      ) : (
                        'Only protected branches and tags'
                      ),
                  },
                ]
              : []),
            {
              label: 'May call',
              value: operations.length > 0 ? <>{operations}</> : 'No operation yet',
            },
            {
              label: 'Expires',
              value:
                model.expiry.expires === 'never'
                  ? 'Never'
                  : (expiry?.label ?? model.expiry.expires),
            },
          ]}
        />
      </Panel>
    </Tray>
  );
}

export function selectedConsumerBranch(choice: ConsumerChoice): ConsumerBranch | null {
  switch (choice.kind) {
    case 'fixed':
      return choice.branch;
    case 'cards':
      return (
        choice.branches.find((branch) => branch.provider.id === choice.selected) ??
        (choice.selected === 'new'
          ? (choice.newBranch.jobs[choice.newBranch.form.type as ProfileId] ?? null)
          : null)
      );
    case 'select':
      return choice.branch;
    case 'new':
      return choice.newBranch.jobs[choice.newBranch.form.type as ProfileId] ?? null;
  }
}

export function selectedTokenBranch(choice: TokenChoice): TokenBranch | null {
  switch (choice.kind) {
    case 'fixed':
      return choice.branch;
    case 'cards':
      return choice.branches.find((branch) => branch.token.id === choice.selected) ?? null;
    case 'select':
      return choice.branch;
  }
}

function repositoryLabelOf(branch: ConsumerBranch | null): string | null {
  const text = branch?.jobs.repository.trim() ?? '';
  const match = /^(.+?)\s*(?:\(\d+\)|#\d+)$/.exec(text);
  return match?.[1] ?? null;
}

/** "acme/api" or the consumer: what a risk confirmation names. */
function subjectOf(branch: ConsumerBranch | null): string {
  return repositoryLabelOf(branch) ?? branch?.provider.name ?? 'these jobs';
}

function secretBadge(credential: string): Child {
  if (credential === 'Secret set') {
    return (
      <Badge tone="ok" glyph="✓">
        Secret set
      </Badge>
    );
  }
  if (credential === 'No secret yet') {
    return (
      <Badge tone="bad" glyph="–">
        No secret yet: calls fail until a token manager sets it
      </Badge>
    );
  }
  return (
    <Badge tone="bad" glyph="✕">
      {credential}
    </Badge>
  );
}

function TokenBar(props: { branch: TokenBranch; changeHref: string | null }) {
  const { token } = props.branch;
  return (
    <FixedBar
      label="Token"
      logo={tokenLogo(token)}
      name={`${token.name}${token.enabled ? '' : ' (disabled)'}`}
      meta={`/proxy/${token.slug}`}
      status={secretBadge(props.branch.credential)}
      change={props.changeHref ? { href: props.changeHref, srSuffix: 'token' } : undefined}
    />
  );
}

function ConsumerBar(props: {
  branch: ConsumerBranch;
  changeHref: string | null;
  newHref: string | null;
}) {
  const { provider, labels } = props.branch;
  return (
    <div class="ga-bar">
      <FixedBar
        label="Consumer"
        logo={consumerLogo(provider)}
        name={`${provider.name}${provider.enabled ? '' : ' (disabled)'}`}
        meta={trustLine(provider, labels)}
        change={props.changeHref ? { href: props.changeHref, srSuffix: 'consumer' } : undefined}
      />
      {props.newHref ? (
        <Button variant="ghost" size="sm" plus href={props.newHref}>
          Add a new consumer
        </Button>
      ) : null}
    </div>
  );
}

/** "Inherited from GitHub Actions (acme): organization acme (1234567)." */
function InheritLine(props: { branch: ConsumerBranch }) {
  const { provider, profile, labels } = props.branch;
  const claims = anchorClaims(profile);
  const owners =
    claims === null
      ? []
      : pinOwnerValues(provider, claims.owner).map((value) => {
          const label = labels.find((l) => l.claim === claims.owner && l.value === value)?.label;
          return label ? `${label} (${value})` : value;
        });
  if (owners.length === 0) {
    return (
      <Inherit>
        Inherited from <b>{provider.name}</b>: its issuer and audience.
      </Inherit>
    );
  }
  const word = profile.id === 'gitlab-ci' ? 'group' : 'organization';
  return (
    <Inherit>
      Inherited from <b>{provider.name}</b>: {owners.length === 1 ? word : `${word}s`}{' '}
      <span class="mono">{owners.join(', ')}</span>. Only its repositories can match.
    </Inherit>
  );
}

// ---------------------------------------------------------------------------------------------
// Step: consumer

function ConsumerStep(props: { model: AccessFormModel; n: number }) {
  const { model } = props;
  const choice = model.consumer;
  const err = (name: string) => errorFor(model.errors, name);
  if (choice.kind === 'cards') {
    const options = [
      ...choice.branches.map((branch, index) => ({
        value: branch.provider.id,
        o: index + 1,
        logo: consumerLogo(branch.provider),
        title: `${branch.provider.name}${branch.provider.enabled ? '' : ' (disabled)'}`,
        meta: `${
          index === 0 && branch.accessCount > (choice.branches[1]?.accessCount ?? 0)
            ? 'most used · '
            : ''
        }${branch.accessCount === 1 ? '1 access' : `${branch.accessCount} accesses`}`,
      })),
      {
        value: 'new',
        o: choice.branches.length + 1,
        title: 'New consumer',
        meta: 'Add one in this step',
      },
    ];
    const id = fieldId('consumer_id');
    useFocusTarget('consumer_id', { id, options });
    return (
      <FormStep
        n={props.n}
        title="Consumer"
        live={1}
        id={id}
        description="Whose jobs call the token. Its organizations and issuer are inherited."
        error={err('consumer_id') ?? undefined}
      >
        <RowPicker
          name="consumer_id"
          value={choice.selected}
          invalid={err('consumer_id') ? true : undefined}
          options={options}
        />
      </FormStep>
    );
  }
  if (choice.kind === 'select') {
    return (
      <FormStep n={props.n} kind="group" id="ga-consumer" title="Consumer">
        <Select
          name="consumer_id"
          label="Which consumer"
          value={choice.selected}
          placeholder="Choose a consumer"
          options={[
            ...choice.options.map((provider) => ({
              value: provider.id,
              label: `${provider.name}${provider.enabled ? '' : ' (disabled)'}`,
            })),
            { value: 'new', label: 'New consumer' },
          ]}
          hint="After choosing, use Show fields for the chosen consumer and token below the form."
          error={err('consumer_id')}
        />
      </FormStep>
    );
  }
  if (choice.kind === 'new') {
    return (
      <FormStep
        n={props.n}
        kind="group"
        id="ga-consumer"
        title="Consumer and its jobs"
        description="Adding the consumer and its access is one step: nothing is saved until Give access."
      >
        {choice.existingHref ? (
          <p>
            <Button variant="ghost" size="sm" href={choice.existingHref}>
              Use an existing consumer
            </Button>
          </p>
        ) : null}
        <NewConsumerFields
          branch={choice.newBranch}
          model={model}
          legend="Where do the jobs run?"
        />
      </FormStep>
    );
  }
  return null;
}

function NewConsumerFields(props: {
  branch: NewConsumerBranch;
  model: AccessFormModel;
  legend: string;
}) {
  const jobs = Object.fromEntries(
    Object.entries(props.branch.jobs).map(([type, branch]) => [
      type,
      <JobsFields
        branch={branch}
        errors={props.model.errors}
        live="scoped"
        focus={props.model.focus}
      />,
    ]),
  ) as Partial<Record<ProfileId, Child>>;
  // Each type's branch holds the labels of the consumer a save would merge into.
  const labels = Object.values(props.branch.jobs).flatMap((branch) => branch.labels);
  return (
    <AddConsumerFields
      prefix="new."
      live="scoped"
      form={props.branch.form}
      errors={props.model.errors}
      existing={props.model.existingConsumers}
      labels={labels}
      anchorSuggestions={genericAnchorSuggestions(props.model.existingConsumers)}
      jobs={jobs}
      legend={props.legend}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Step: which jobs

function JobsStep(props: { model: AccessFormModel; n: number }) {
  const { model } = props;
  const choice = model.consumer;
  const edit = model.mode === 'edit';
  if (choice.kind === 'fixed') {
    return (
      <FormStep
        n={props.n}
        kind="group"
        id="ga-jobs"
        title="Which jobs"
        description={<InheritLine branch={choice.branch} />}
      >
        <JobsFields
          branch={choice.branch}
          errors={model.errors}
          live="global"
          // Native validation only on a visible create form with a fixed, existing consumer (not
          // in the review of a prefilled request: its fields wait in a closed disclosure).
          fixed={!edit && model.entry?.request == null}
          focus={model.focus}
        />
      </FormStep>
    );
  }
  if (choice.kind === 'cards') {
    return (
      <FormStep
        n={props.n}
        kind="group"
        id="ga-jobs"
        title="Which jobs"
        description="Only the fields of the chosen consumer are saved."
      >
        {choice.branches.map((branch, index) => (
          <div class="rv1 ga-branch ga-scope" data-o={String(index + 1)}>
            <InheritLine branch={branch} />
            <JobsFields branch={branch} errors={model.errors} live="scoped" focus={model.focus} />
          </div>
        ))}
        <div class="rv1 ga-branch" data-o={String(choice.branches.length + 1)}>
          <NewConsumerFields
            branch={choice.newBranch}
            model={model}
            legend="Where do the jobs run?"
          />
        </div>
      </FormStep>
    );
  }
  if (choice.kind === 'select') {
    return (
      <FormStep n={props.n} kind="group" id="ga-jobs" title="Which jobs">
        {choice.branch ? (
          <>
            <InheritLine branch={choice.branch} />
            <JobsFields
              branch={choice.branch}
              errors={model.errors}
              live="global"
              focus={model.focus}
            />
          </>
        ) : (
          <p class="hint">
            Choose a consumer above, then use Show fields for the chosen consumer and token.
          </p>
        )}
      </FormStep>
    );
  }
  return null;
}

const CONTEXT_TEXT: Readonly<
  Record<AccessContext, { title: string; description: string; risk?: string }>
> = {
  environment: {
    title: 'Environment',
    description: 'Jobs that deploy to a GitHub environment',
  },
  branch: { title: 'Branch', description: 'Pushes, manual runs and schedules on a branch' },
  tag: { title: 'Tag', description: 'Pushes of a tag' },
  protected: { title: 'Any protected branch or tag', description: 'Every protected ref' },
  release: { title: 'Release', description: 'Published releases' },
  pull_request: {
    title: 'Pull request into',
    description: 'Pull requests into a branch.',
    risk: 'pull_request jobs run the code proposed in the pull request.',
  },
  any: {
    title: 'Any branch, tag or environment',
    description: 'Every job of the repository.',
    risk: 'anyone with write access to the repository gets the token.',
  },
};

const GITLAB_CONTEXT_TEXT: Partial<Record<AccessContext, { description: string }>> = {
  environment: { description: 'Jobs that deploy to a GitLab environment' },
  branch: { description: 'Pipelines on a branch' },
  tag: { description: 'Pipelines of a tag' },
};

/** The contexts shown as cards first; the rest sit under "Tag, release, pull request or any". */
const MAIN_CONTEXTS: ReadonlySet<AccessContext> = new Set(['environment', 'branch', 'protected']);

/** Known repositories shown as rows; the datalist of "Another repository" keeps all of them. */
const PICKS_SHOWN = 6;

function suggestions(values: readonly string[]): Suggestion[] {
  return values.map((value) => ({ value }));
}

/**
 * The class of a field slot: a ui live slot on a global form, a page-local scoped field in a
 * branch (pages.css shows `.ga-rN[data-o=K]` while option K of `.ga-fN` in the same `.ga-scope`
 * is checked).
 */
function slot(live: Live, n: 3 | 4 | 5 | 6) {
  return live === 'global' ? { live: n } : { class: `ga-f${n}` };
}

/** A hidden branch of field `n`, option `o`: a ui Reveal, or a scoped page-local branch. */
function Branch(props: { live: Live; n: 3 | 4 | 5; o: number; box?: boolean; children: Child }) {
  if (props.live === 'global') {
    return (
      <Reveal field={props.n} option={props.o} box={props.box}>
        {props.children}
      </Reveal>
    );
  }
  return (
    <div class={`ga-r${props.n}${props.box === false ? '' : ' subbox'}`} data-o={String(props.o)}>
      {props.children}
    </div>
  );
}

/** "Which jobs" of one consumer branch: the structured fields, or the conditions rows editor. */
export function JobsFields(props: {
  branch: ConsumerBranch;
  errors: readonly FieldError[];
  live: Live;
  /** A visible create form with a fixed consumer: the repository may carry `pattern`. */
  fixed?: boolean;
  focus?: AccessFormModel['focus'];
}) {
  const { branch, errors, live } = props;
  const { prefix, jobs, profile } = branch;
  const name = (key: string) => `${prefix}${key}`;
  const err = (key: string) => errorFor(errors, name(key));
  const conditional = props.fixed !== true;
  if (jobs.editor === 'rows') {
    return <ConditionRows branch={branch} errors={errors} focus={props.focus} />;
  }
  const claims = anchorClaims(profile);
  const owners =
    claims === null
      ? []
      : pinOwnerValues(branch.provider, claims.owner).map((value) => ({
          value,
          label: branch.labels.find((l) => l.claim === claims.owner && l.value === value)?.label,
        }));
  const firstOwner = owners.find((owner) => owner.label)?.label;
  const gitlab = profile.id === 'gitlab-ci';
  const exampleRepo = gitlab
    ? `${firstOwner ?? 'acme-group'}/app (4567890)`
    : `${firstOwner ?? 'acme'}/api (89012345)`;
  const moreOpen =
    jobs.workflow_ref !== '' ||
    jobs.require_github_hosted ||
    err('workflow_ref') !== null ||
    err('owner_id') !== null;
  const findCommand = isNumericId(jobs.repository.trim())
    ? repositoryFindCommandForId(profile, jobs.repository.trim())
    : repositoryFindCommand(
        profile,
        gitlab ? `${firstOwner ?? 'acme-group'}/app` : `${firstOwner ?? 'acme'}/api`,
      );
  return (
    <>
      <input type="hidden" name={name('editor')} value="structured" />
      {claims !== null ? (
        <RepositoryFields
          branch={branch}
          live={live}
          conditional={conditional}
          example={exampleRepo}
          findCommand={findCommand}
          error={err('repository')}
        />
      ) : null}
      {branch.unknownOwner !== null ? (
        <IdWithLabelField
          kind={gitlab ? 'gitlab_group_list' : 'github_owner_list'}
          name={name('new_owner')}
          label={`Add ${gitlab ? 'group' : 'organization'} ${branch.unknownOwner} to this consumer`}
          value={jobs.new_owner}
          example={`${branch.unknownOwner} (7654321)`}
          findCommand={ownerFindCommand(profile, branch.unknownOwner)}
          hint={`Saving adds this ${gitlab ? 'group' : 'organization'} to the consumer, then creates the access.`}
          error={err('new_owner')}
          autocomplete="off"
          required
          conditional={conditional}
        />
      ) : null}
      <ContextFields branch={branch} live={live} error={err('context')} errors={errors} />
      <RefProtection branch={branch} live={live} />
      <More
        summary="More constraints"
        meta={gitlab ? 'pipeline configuration pin' : 'workflow pin, GitHub-hosted runners only'}
        open={moreOpen}
      >
        <Field
          name={name('workflow_ref')}
          label={gitlab ? 'Pipeline configuration pin' : 'Workflow pin'}
          optional
          mono
          value={jobs.workflow_ref}
          example={
            gitlab
              ? 'gitlab.com/acme-group/app//.gitlab-ci.yml@refs/heads/main'
              : 'acme/api/.github/workflows/deploy.yml@refs/heads/main'
          }
          suggestions={suggestions(branch.suggestions.workflowRefs)}
          hint={
            gitlab
              ? 'Only jobs from this pipeline configuration at this ref get the token. With an empty project, every project of the group that uses it gets it.'
              : 'Only jobs from this workflow file at this ref get the token. With an empty repository, every repository of the organization that calls this reusable workflow gets it.'
          }
          error={err('workflow_ref')}
          autocomplete="off"
          conditional
        />
        {owners.length > 1 ? (
          <Select
            name={name('owner_id')}
            label={
              gitlab ? 'Group of the calling projects' : 'Organization of the calling repositories'
            }
            value={jobs.owner_id}
            placeholder="Only needed for a pin without a repository"
            options={owners.map((owner) => ({
              value: owner.value,
              label: owner.label ? `${owner.label} (${owner.value})` : owner.value,
            }))}
            hint="Used only when the repository is empty."
            error={err('owner_id')}
            conditional
          />
        ) : null}
        {profile.id === 'github-actions' ? (
          <Checkbox
            name={name('require_github_hosted')}
            label="GitHub-hosted runners only"
            hint="Refuse self-hosted runners."
            checked={jobs.require_github_hosted}
          />
        ) : null}
      </More>
    </>
  );
}

/**
 * The repository: the consumer's known repositories as rows plus "Another repository" (a reveal
 * with the free-text input, `<p>repository_other`), or one input when none is known yet.
 */
function RepositoryFields(props: {
  branch: ConsumerBranch;
  live: Live;
  conditional: boolean;
  example: string;
  findCommand: string;
  error: string | null;
}) {
  const { branch, live } = props;
  const { prefix, jobs, profile } = branch;
  const gitlab = profile.id === 'gitlab-ci';
  const label = gitlab ? 'Project' : 'Repository';
  const inputId = fieldId(`${prefix}repository`);
  const all = branch.repositoryOptions;
  if (all.length === 0) {
    return (
      <IdWithLabelField
        kind={gitlab ? 'gitlab_project' : 'github_repo'}
        name={`${prefix}repository`}
        label={label}
        value={jobs.repository}
        example={props.example}
        findCommand={props.findCommand}
        error={props.error}
        autocomplete="off"
        // Not required: an empty repository is valid with a workflow pin (More constraints).
        conditional={props.conditional}
      />
    );
  }
  const value = jobs.repository.trim();
  const shown = all.slice(0, PICKS_SHOWN);
  const matched = all.find((option) => option.value === value);
  if (matched && !shown.includes(matched)) shown.push(matched);
  const another = shown.length + 1;
  const options = [
    ...shown.map((option, index) => {
      const parsed = /^(.*) \((\d+)\)$/.exec(option.value);
      const count = branch.repositoryCounts?.[option.value] ?? 0;
      return {
        value: option.value,
        o: index + 1,
        title: parsed?.[1] ?? option.value,
        mono: true,
        detail: parsed ? `(${parsed[2]})` : undefined,
        meta:
          count > 0
            ? `${index === 0 && count > 0 ? 'most used · ' : ''}${count === 1 ? '1 access' : `${count} accesses`}`
            : undefined,
      };
    }),
    {
      value: '',
      o: another,
      title: gitlab ? 'Another project' : 'Another repository',
    },
  ];
  const checked = matched ? matched.value : value !== '' ? '' : undefined;
  const pickId = `${inputId}-pick`;
  const checkedIndex = options.findIndex((option) => option.value === checked);
  useFocusTarget(
    `${prefix}repository`,
    checked === '' ? inputId : checkedIndex >= 0 ? `${pickId}-${checkedIndex + 1}` : `${pickId}-1`,
  );
  return (
    <>
      <FieldSet
        id={pickId}
        legend={label}
        hint={`${gitlab ? 'Projects' : 'Repositories'} this consumer used before, most used first. The ID keeps working after a rename.`}
        {...slot(live, 3)}
      >
        <RowPicker name={`${prefix}repository`} value={checked} options={options} />
      </FieldSet>
      <Branch live={live} n={3} o={another}>
        <IdWithLabelField
          kind={gitlab ? 'gitlab_project' : 'github_repo'}
          name={`${prefix}repository_other`}
          id={inputId}
          label={`${label} name (ID)`}
          value={checked === '' ? jobs.repository : ''}
          example={props.example}
          findCommand={props.findCommand}
          suggestions={all}
          error={props.error}
          autocomplete="off"
          conditional
        />
      </Branch>
    </>
  );
}

function ContextFields(props: {
  branch: ConsumerBranch;
  live: Live;
  error: string | null;
  errors: readonly FieldError[];
}) {
  const { branch, live } = props;
  const { prefix, jobs, profile } = branch;
  const gitlab = profile.id === 'gitlab-ci';
  const id = fieldId(`${prefix}context`);
  const all = contextsFor(profile).map((context, index) => {
    const info = CONTEXT_TEXT[context];
    const risky = info.risk !== undefined;
    const description = gitlab
      ? (GITLAB_CONTEXT_TEXT[context]?.description ?? info.description)
      : info.description;
    return {
      context,
      card: {
        value: context,
        o: index + 1,
        title: info.title,
        description: risky ? (
          <>
            <strong>Risk:</strong> {info.risk} {description}
          </>
        ) : (
          description
        ),
        // A risky card arms the form-wide risk rules only where the slots are global; in a
        // scoped branch the tag is drawn by hand (ui RadioCards couples it to data-risk).
        risk: risky && live === 'global' ? true : undefined,
        badge:
          context === branch.mostUsedContext ? (
            <Badge tone="accent">Most used</Badge>
          ) : risky && live === 'scoped' ? (
            <RiskTag />
          ) : undefined,
        wide: context === 'protected',
      },
    };
  });
  const main = all.filter((entry) => MAIN_CONTEXTS.has(entry.context)).map((e) => e.card);
  const rest = all.filter((entry) => !MAIN_CONTEXTS.has(entry.context)).map((e) => e.card);
  useFocusTarget(`${prefix}context`, { id, options: [...main, ...rest] });
  const restChecked = rest.some((card) => card.value === jobs.context);
  // The context inputs sit after the fieldset: a live slot reads every [data-o] inside its
  // fieldset, so the environment picks inside it would count as context choices.
  return (
    <>
      <FieldSet
        id={id}
        legend="When can its jobs use the token?"
        error={props.error}
        {...slot(live, 4)}
      >
        <UiRadioCards
          name={`${prefix}context`}
          value={jobs.context}
          invalid={props.error ? true : undefined}
          options={main}
        />
        {rest.length > 0 ? (
          <More
            summary={gitlab ? 'Tag or any ref' : 'Tag, release, pull request or any ref'}
            meta={`${rest.filter((card) => CONTEXT_TEXT[card.value].risk).length} carry a risk`}
            open={restChecked}
          >
            <UiRadioCards name={`${prefix}context`} value={jobs.context} options={rest} />
          </More>
        ) : null}
      </FieldSet>
      {all.map((entry) => {
        const input = CONTEXT_INPUT[entry.context];
        return input ? (
          <Branch live={live} n={4} o={entry.card.o}>
            <ContextInput
              branch={branch}
              context={entry.context}
              input={input}
              live={live}
              error={errorFor(props.errors, `${prefix}${input}`)}
            />
          </Branch>
        ) : null;
      })}
    </>
  );
}

function ContextInput(props: {
  branch: ConsumerBranch;
  context: AccessContext;
  input: string;
  live: Live;
  error: string | null;
}) {
  const { branch, live } = props;
  const gitlab = branch.profile.id === 'gitlab-ci';
  const name = `${branch.prefix}${props.input}`;
  const value = (branch.jobs as unknown as Record<string, string>)[props.input] ?? '';
  const common = {
    name,
    value,
    error: props.error,
    autocomplete: 'off',
    mono: true,
    conditional: true,
  };
  switch (props.context) {
    case 'environment': {
      const known = branch.suggestions.environments;
      const hint = gitlab
        ? "Exact name from the job's environment: key. Protect it in GitLab."
        : "Exact name from the job's environment: key. Add required reviewers to it in GitHub.";
      if (known.length === 0) {
        return <Field {...common} label="Environment" example="production" hint={hint} />;
      }
      const shown = known.slice(0, PICKS_SHOWN);
      const matched = known.includes(value);
      if (matched && !shown.includes(value)) shown.push(value);
      const other = shown.length + 1;
      const inputId = fieldId(name);
      const pickId = `${inputId}-pick`;
      const checked = matched ? value : value !== '' ? '' : undefined;
      const checkedIndex = shown.indexOf(value);
      useFocusTarget(
        name,
        checked === ''
          ? inputId
          : checkedIndex >= 0
            ? `${pickId}-${checkedIndex + 1}`
            : `${pickId}-1`,
      );
      return (
        <>
          <FieldSet id={pickId} legend="Environment" hint={hint} {...slot(live, 5)}>
            <Picks
              name={name}
              value={checked}
              options={[
                ...shown.map((env, index) => ({
                  value: env,
                  o: index + 1,
                  label: env,
                  mono: true,
                  meta: index === 0 ? 'most used' : undefined,
                })),
                { value: '', o: other, label: 'Other' },
              ]}
            />
          </FieldSet>
          <Branch live={live} n={5} o={other} box={false}>
            <Field
              {...common}
              name={`${name}_other`}
              id={inputId}
              label="Environment name"
              example="production"
              value={checked === '' ? value : ''}
              suggestions={suggestions(known)}
            />
          </Branch>
        </>
      );
    }
    case 'branch':
      return (
        <Field
          {...common}
          label="Branch"
          example="main"
          suggestions={suggestions(branch.suggestions.branches)}
          hint={`Branch name without ${gitlab ? 'a prefix' : 'refs/heads/'}. A trailing * matches a prefix: release/*.`}
        />
      );
    case 'tag':
      return (
        <Field
          {...common}
          label="Tag"
          example="v*"
          suggestions={suggestions(branch.suggestions.tags)}
          hint={`Tag name without ${gitlab ? 'a prefix' : 'refs/tags/'}. v* matches v1.2.3.`}
        />
      );
    case 'release':
      return (
        <Field
          {...common}
          label="Release tag"
          example="v*"
          suggestions={suggestions(branch.suggestions.tags)}
          hint="Tag of the published release. v* matches v1.2.3."
        />
      );
    case 'pull_request':
      return (
        <Field
          {...common}
          label="Base branch"
          example="main"
          suggestions={suggestions(branch.suggestions.baseRefs)}
          hint="Branch the pull request targets."
        />
      );
    default:
      return null;
  }
}

function RefProtection(props: { branch: ConsumerBranch; live: Live }) {
  const { branch, live } = props;
  const gitlab = branch.profile.id === 'gitlab-ci';
  const id = fieldId(`${branch.prefix}ref_protection`);
  return (
    <FieldSet
      id={id}
      legend="Which refs may use it?"
      hint={`Applies to Environment, Branch, Tag and Release. ${gitlab ? 'Protect a branch or tag in Settings › Repository.' : 'Protect it with required reviewers or branch protection in GitHub.'} Risk of unprotected refs: anyone who can push a branch gets the token.`}
      class={live === 'scoped' ? 'ga-f6 ga-prot' : 'ga-prot'}
      live={live === 'global' ? 6 : undefined}
    >
      <RowPicker
        name={`${branch.prefix}ref_protection`}
        value={branch.jobs.ref_protection}
        options={[
          {
            value: 'protected',
            title: 'Only protected branches and tags',
            detail: '(recommended)',
          },
          {
            value: 'unprotected',
            title: 'Also unprotected branches and tags',
            meta: <RiskTag />,
            // The form-wide risk rules only where the slots are global (a scoped branch draws
            // the tag alone).
            risk: live === 'global' ? true : undefined,
          },
        ]}
      />
    </FieldSet>
  );
}

const CLAIM_HINT = 'Literal top-level claim name.';

function ConditionRows(props: {
  branch: ConsumerBranch;
  errors: readonly FieldError[];
  focus?: AccessFormModel['focus'];
}) {
  const { branch, errors } = props;
  const group = `${branch.prefix}cond`;
  const claimOptions = [
    ...new Set([
      ...branch.profile.anchorRules(branch.provider).flat(),
      ...branch.profile.tenantClaims,
      ...branch.profile.logClaimAllowlist(branch.provider),
    ]),
  ].map((value) => ({ value }));
  const rows = branch.jobs.cond.length > 0 ? branch.jobs.cond : starterRows(branch);
  const anchors = new Set(branch.profile.anchorRules(branch.provider).flat());
  return (
    <div class="ga-rows">
      <input type="hidden" name={`${branch.prefix}editor`} value="rows" />
      <p class="hint">
        Every condition must hold. Anchor claims (
        {branch.profile
          .anchorRules(branch.provider)
          .map((rule) => rule.join(' + '))
          .join('; or ')}
        ) need an exact, non-negated condition.
      </p>
      <RepeatingRows
        group={group}
        legend="Conditions"
        keys={['claim', 'match', 'not', 'values']}
        rows={rows.map((row) => ({ ...row, not: row.not ? '1' : '' }))}
        blank={BLANK_ROWS + (branch.extraRows ?? 0)}
        focusIndex={props.focus?.group === group ? props.focus.index : undefined}
        render={(index, row, rowPrefix) => (
          <>
            {anchors.has(row.claim ?? '') ? (
              // An anchor claim's name is fixed (I-AUTHZ-2): only its values are typed.
              <div id={fieldId(`${rowPrefix}claim`)}>
                <FixedBar label={`Claim ${index + 1}`} name={<code>{row.claim}</code>} />
                <input type="hidden" name={`${rowPrefix}claim`} value={row.claim ?? ''} />
              </div>
            ) : (
              <Field
                name={`${rowPrefix}claim`}
                label={`Claim ${index + 1}`}
                value={row.claim ?? ''}
                example="repository_id"
                suggestions={claimOptions}
                hint={CLAIM_HINT}
                error={errorFor(errors, `${rowPrefix}claim`)}
                autocomplete="off"
                mono
                conditional
              />
            )}
            <Select
              name={`${rowPrefix}match`}
              label={`Match ${index + 1}`}
              value={row.match || 'exact'}
              options={[
                { value: 'exact', label: 'is exactly' },
                { value: 'glob', label: 'matches pattern' },
              ]}
              error={errorFor(errors, `${rowPrefix}match`)}
            />
            <Checkbox
              name={`${rowPrefix}not`}
              label={
                <>
                  Not<span class="vh"> (condition {index + 1})</span>
                </>
              }
              hint="True when the value differs. A missing claim never matches."
              checked={row.not === '1'}
            />
            <Field
              name={`${rowPrefix}values`}
              label={`Values ${index + 1}`}
              value={row.values ?? ''}
              example="89012345, 89012346"
              suggestions={suggestions(branch.suggestions.claimValues(row.claim ?? ''))}
              hint='Comma-separated alternatives. Quote a value that contains a comma: "a,b".'
              error={errorFor(errors, `${rowPrefix}values`)}
              autocomplete="off"
              mono
              conditional
            />
          </>
        )}
      />
    </div>
  );
}

/** Empty rows editor: one row per anchor claim of the first anchor rule. */
function starterRows(branch: ConsumerBranch): JobsForm['cond'] {
  const [rule] = branch.profile.anchorRules(branch.provider);
  return (rule ?? []).map((claim) => ({ claim, match: 'exact', not: false, values: '' }));
}

// ---------------------------------------------------------------------------------------------
// Step: allowed operations

function OpsStep(props: { model: AccessFormModel; n: number; jobs: ConsumerBranch | null }) {
  const { model } = props;
  const choice = model.token;
  const err = (name: string) => errorFor(model.errors, name);
  const repositoryLabel = repositoryLabelOf(props.jobs);
  if (choice.kind === 'fixed') {
    const branch = choice.branch;
    const withBoxes = hasCheckboxes(branch) && !isPathInjected(branch.token);
    const description = branch.template
      ? `Presets for the ${branch.template.label}. Calls outside these are denied and show up in Requests.`
      : 'Calls outside these are denied and show up in Requests.';
    if (!withBoxes) {
      return (
        <FormStep
          n={props.n}
          kind="group"
          id="ga-ops"
          title="Allowed operations"
          description={description}
        >
          <OpsFields
            branch={branch}
            errors={model.errors}
            repositoryLabel={repositoryLabel}
            focus={model.focus}
          />
        </FormStep>
      );
    }
    const id = fieldId(`${branch.prefix}op`);
    return (
      <FormStep
        n={props.n}
        title="Allowed operations"
        description={description}
        live={7}
        id={id}
        error={err(`${branch.prefix}op`) ?? undefined}
      >
        <OpsFields
          branch={branch}
          errors={model.errors}
          repositoryLabel={repositoryLabel}
          focus={model.focus}
        />
      </FormStep>
    );
  }
  if (choice.kind === 'cards') {
    const id = fieldId('token_id');
    const options = choice.branches.map((branch, index) => ({
      value: branch.token.id,
      o: index + 1,
      logo: tokenLogo(branch.token),
      title: `${branch.token.name}${branch.token.enabled ? '' : ' (disabled)'}`,
      description: (
        <>
          <code>/proxy/{branch.token.slug}</code> · {hostOf(branch.token.base_url)} ·{' '}
          {branch.credential === 'No secret yet'
            ? 'No secret yet: calls fail until a token manager sets it'
            : branch.credential}
        </>
      ),
    }));
    useFocusTarget('token_id', { id, options });
    return (
      <FormStep n={props.n} kind="group" id="ga-token" title="Token and operations">
        <FieldSet id={id} legend="Token" live={2} error={err('token_id')}>
          <UiRadioCards
            name="token_id"
            value={choice.selected}
            invalid={err('token_id') ? true : undefined}
            options={options}
          />
        </FieldSet>
        {choice.branches.map((branch, index) => (
          <div class="rv2 ga-tok" data-o={String(index + 1)}>
            <TokenOps branch={branch} model={model} repositoryLabel={repositoryLabel} />
          </div>
        ))}
      </FormStep>
    );
  }
  return (
    <FormStep n={props.n} kind="group" id="ga-token" title="Token and operations">
      <Select
        name="token_id"
        label="Which token"
        value={choice.selected}
        placeholder="Choose a token"
        options={choice.options.map((token) => ({
          value: token.id,
          label: `${token.name} (/proxy/${token.slug})`,
        }))}
        hint="After choosing, use Show fields for the chosen consumer and token below the form."
        error={err('token_id')}
      />
      {choice.branch ? (
        <TokenOps branch={choice.branch} model={model} repositoryLabel={repositoryLabel} />
      ) : null}
    </FormStep>
  );
}

/** The operations of one token branch in its own group (the token is a choice). */
function TokenOps(props: {
  branch: TokenBranch;
  model: AccessFormModel;
  repositoryLabel: string | null;
}) {
  const { branch, model } = props;
  const withBoxes = hasCheckboxes(branch) && !isPathInjected(branch.token);
  const fields = (
    <OpsFields
      branch={branch}
      errors={model.errors}
      repositoryLabel={props.repositoryLabel}
      focus={model.focus}
    />
  );
  if (!withBoxes) return fields;
  return (
    <FieldSet
      id={fieldId(`${branch.prefix}op`)}
      legend={`Allowed operations of ${branch.token.name}`}
      error={errorFor(model.errors, `${branch.prefix}op`)}
    >
      {fields}
    </FieldSet>
  );
}

/** "Allowed operations" of one token: preset boxes, then other operations as rows. */
export function OpsFields(props: {
  branch: TokenBranch;
  errors: readonly FieldError[];
  repositoryLabel: string | null;
  focus?: AccessFormModel['focus'];
}) {
  const { branch, errors } = props;
  const { prefix } = branch;
  if (isPathInjected(branch.token)) {
    return (
      <p>
        Allowed operation: <code>POST /</code> (the only safe operation on a webhook URL).
      </p>
    );
  }
  const repo = props.repositoryLabel ?? '‹repository›';
  const presets = branch.template?.operation_presets ?? [];
  // A set other accesses use that is exactly a preset is the preset's box already; it shows
  // only while it is the checked one (a copy), so a checked value is never hidden.
  const presetKeys = new Set(
    presets.map((preset) =>
      ruleSetKey(
        preset.rules.map((rule) => ({
          ...rule,
          path: rule.path.replaceAll(REPO_PLACEHOLDER, repo),
        })),
      ),
    ),
  );
  const ruleSets = branch.ruleSets.filter(
    (set) => !presetKeys.has(ruleSetKey(set.rules)) || branch.ops.op.includes(set.id),
  );
  const options = [
    ...presets.map((preset) => ({
      value: preset.id,
      title: preset.label,
      note: preset.default ? '(default)' : undefined,
      code: preset.rules
        .map((rule) => `${rule.methods.join(', ')} ${rule.path.replaceAll(REPO_PLACEHOLDER, repo)}`)
        .join(' · '),
    })),
    ...ruleSets.map((set) => ({
      value: set.id,
      title: `Used by ${set.count === 1 ? '1 other access' : `${set.count} other accesses`}`,
      code: set.rules.map((rule) => `${rule.methods.join(', ')} ${rule.path}`).join(' · '),
    })),
  ];
  const withBoxes = hasCheckboxes(branch);
  const opError = errorFor(errors, `${prefix}op`);
  if (withBoxes) useFocusTarget(`${prefix}op`, { id: fieldId(`${prefix}op`), options });
  const group = `${prefix}rule`;
  const rows = branch.ops.rule;
  // The placeholder is an exact example, so {repo} becomes a real-looking name, never ‹repository›.
  const firstPath =
    presets[0]?.rules[0]?.path.replaceAll(REPO_PLACEHOLDER, props.repositoryLabel ?? 'acme/api') ??
    '/v1/resource';
  const otherOpen =
    rows.length > 0 ||
    !withBoxes ||
    errors.some((error) => error.field?.startsWith(`${group}.`)) ||
    (branch.extraRows ?? 0) > 0;
  return (
    <>
      {withBoxes ? (
        <CheckPresets
          name={`${prefix}op`}
          value={branch.ops.op}
          invalid={opError ? true : undefined}
          options={options}
        />
      ) : null}
      <More summary="Other operations" meta="method and path" open={otherOpen}>
        <RepeatingRows
          group={group}
          legend="Methods and paths"
          keys={['m', 'path']}
          rows={rows.map((row) => ({ m: row.m.join(','), path: row.path }))}
          blank={BLANK_ROWS + (branch.extraRows ?? 0)}
          focusIndex={props.focus?.group === group ? props.focus.index : undefined}
          render={(index, row, rowPrefix) => {
            const methods = (row.m ?? '').split(',').filter((m) => m !== '');
            return (
              <>
                <CheckboxGroup
                  name={`${rowPrefix}m`}
                  legend={`Methods of operation ${index + 1}`}
                  options={[
                    ...PROXY_METHODS.map((method) => ({
                      value: method,
                      label: method,
                      checked: methods.includes(method),
                    })),
                    { value: '*', label: 'All methods', checked: methods.includes('*') },
                  ]}
                  error={errorFor(errors, `${rowPrefix}m`)}
                />
                <Field
                  name={`${rowPrefix}path`}
                  label={`Path of operation ${index + 1}`}
                  value={row.path ?? ''}
                  example={firstPath}
                  suggestions={suggestions(branch.pathSuggestions)}
                  hint={`Path under ${branch.token.base_url}. * matches one segment, ** any depth.`}
                  error={errorFor(errors, `${rowPrefix}path`)}
                  autocomplete="off"
                  mono
                  conditional
                />
              </>
            );
          }}
        />
      </More>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Step: expires

const DAY_MS = 86_400_000;

function expiryOptions(model: AccessFormModel) {
  // "Keep" only for a stored date: for an access that never expires it would repeat "Never".
  const keep = model.mode === 'edit' && model.keep !== undefined && model.keep !== null;
  const keepText =
    model.keep === null || model.keep === undefined
      ? ''
      : `Keep: ${formatTime(model.keep).slice(0, 10)} (in ${Math.max(0, Math.ceil((model.keep - model.now) / DAY_MS))} days)`;
  return [
    ...(keep ? [{ value: 'keep', label: keepText }] : []),
    { value: 'never', label: 'Never' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: 'date', label: 'On a date' },
  ].map((option, index) => ({ ...option, o: index + 1 }));
}

function ExpiryStep(props: { model: AccessFormModel; n: number }) {
  const { model } = props;
  const options = expiryOptions(model);
  const keep = options.some((option) => option.value === 'keep');
  const value = !keep && model.expiry.expires === 'keep' ? 'never' : model.expiry.expires;
  const date = options.find((option) => option.value === 'date')?.o ?? options.length;
  const id = fieldId('expires');
  const error = errorFor(model.errors, 'expires');
  useFocusTarget('expires', { id, options });
  return (
    <FormStep n={props.n} title="Expires" live={8} id={id} error={error ?? undefined}>
      <Picks name="expires" value={value} options={options} />
      <Reveal field={8} option={date} box={false}>
        <Field
          name="expires_on"
          label="Last day of access"
          value={model.expiry.expires_on}
          example="2027-01-31"
          hint="Access stops at the end of this day (UTC). Use a date like 2027-01-31."
          error={errorFor(model.errors, 'expires_on')}
          autocomplete="off"
          conditional
        />
      </Reveal>
    </FormStep>
  );
}

// ---------------------------------------------------------------------------------------------
// The summary rail

const CONTEXT_PHRASE: Readonly<Record<AccessContext, Child>> = {
  environment: ' · environment',
  branch: ' · the branch you enter',
  tag: ' · the tag you enter',
  protected: ' · any protected ref',
  release: ' · releases',
  pull_request: <span class="t-warn"> · pull requests (risk)</span>,
  any: <span class="t-warn"> · any ref (risk)</span>,
};

function FormRail(props: { model: AccessFormModel }) {
  const { model } = props;
  const consumer = model.consumer;
  const token = model.token;
  const request = model.entry?.request ?? null;
  const fixedJobs = consumer.kind === 'fixed' ? consumer.branch : null;
  const tokenBranch = token.kind === 'fixed' ? token.branch : null;
  const expiry = expiryOptions(model);
  const consumerRow =
    consumer.kind === 'fixed' ? (
      <SummaryRow
        logo={consumerLogo(consumer.branch.provider)}
        title={consumer.branch.provider.name}
        meta={<JobsPhrase branch={consumer.branch} />}
      />
    ) : consumer.kind === 'cards' ? (
      <SummaryRow
        logoSlot={
          <LivePhrase
            field={1}
            decorative
            phrases={Object.fromEntries([
              ...consumer.branches.map((branch, index) => [
                index + 1,
                <Tile logo={consumerLogo(branch.provider)} />,
              ]),
              [consumer.branches.length + 1, <Tile logo="oidc" />],
            ])}
            empty={<Tile logo="oidc" />}
          />
        }
        title={
          <LivePhrase
            field={1}
            phrases={Object.fromEntries([
              ...consumer.branches.map((branch, index) => [index + 1, branch.provider.name]),
              [consumer.branches.length + 1, 'The new consumer'],
            ])}
            empty="Choose a consumer"
          />
        }
        meta="the jobs you choose in step 2"
      />
    ) : (
      <SummaryRow
        logo="oidc"
        title={consumer.kind === 'new' ? 'The new consumer' : 'The chosen consumer'}
        meta="the jobs you choose"
      />
    );
  const presets = tokenBranch?.template?.operation_presets ?? [];
  const opsMeta =
    tokenBranch && presets.length > 0 && !isPathInjected(tokenBranch.token) ? (
      <LivePhrase
        field={7}
        phrases={Object.fromEntries(
          presets.map((preset, index) => [
            index + 1,
            <>
              {preset.label}
              <br />
            </>,
          ]),
        )}
        empty={<span class="t-bad">No preset chosen: only the other operations you add</span>}
      />
    ) : tokenBranch && isPathInjected(tokenBranch.token) ? (
      'POST / (the webhook)'
    ) : (
      'the operations you tick'
    );
  const tokenRow = tokenBranch ? (
    <SummaryRow
      logo={tokenLogo(tokenBranch.token)}
      title={tokenBranch.token.name}
      meta={`${model.origin ? hostOf(model.origin) : ''}/proxy/${tokenBranch.token.slug}`}
      mono
    />
  ) : token.kind === 'cards' ? (
    <SummaryRow
      logoSlot={
        <LivePhrase
          field={2}
          decorative
          phrases={Object.fromEntries(
            token.branches.map((branch, index) => [
              index + 1,
              <Tile logo={tokenLogo(branch.token)} />,
            ]),
          )}
          empty={<Tile logo={{ brand: 'custom', text: '?' }} />}
        />
      }
      title={
        <LivePhrase
          field={2}
          phrases={Object.fromEntries(
            token.branches.map((branch, index) => [index + 1, branch.token.name]),
          )}
          empty="Choose a token"
        />
      }
    />
  ) : (
    <SummaryRow glyph="?" title="The chosen token" />
  );
  return (
    <LiveSummary
      id="ga-sum"
      title={request ? 'The denied request' : 'This access'}
      description={
        request
          ? 'Saving allows this caller to make this call.'
          : 'Follows the choices in this form.'
      }
    >
      {request ? (
        <>
          <SummaryRow
            logo={fixedJobs ? consumerLogo(fixedJobs.provider) : 'oidc'}
            title={fixedJobs?.provider.name ?? 'The consumer'}
            meta={
              <>
                {request.repository ? <span class="v">{request.repository}</span> : null}
                {request.repository && request.ref ? ' · ' : null}
                {request.ref ? <span class="v">{request.ref}</span> : null}
              </>
            }
          />
          <SummaryWire />
          <SummaryRow
            glyph="✕"
            title={`Denied ${formatTime(request.ts).slice(11, 16)} · ${request.status}`}
            meta={request.reason}
          />
          <SummaryWire />
          <SummaryRow
            logo={tokenBranch ? tokenLogo(tokenBranch.token) : { brand: 'custom', text: '?' }}
            title={tokenBranch?.token.name ?? 'The token'}
            meta={`${request.method} ${request.path}`}
            mono
          />
          <SummaryFoot>After saving, the same call from these jobs is allowed.</SummaryFoot>
        </>
      ) : (
        <>
          {consumerRow}
          <SummaryWire />
          <SummaryRow glyph="→" title="May call" meta={opsMeta} />
          <SummaryWire />
          {tokenRow}
          <SummaryFoot>
            Expires{' '}
            <LivePhrase
              field={8}
              as="b"
              phrases={Object.fromEntries(
                expiry.map((option) => [
                  option.o,
                  option.value === 'never'
                    ? 'never'
                    : option.value === 'date'
                      ? 'on the date you choose'
                      : option.value === 'keep'
                        ? option.label.replace('Keep: ', 'on ')
                        : `in ${option.label}`,
                ]),
              )}
            />
            .{' '}
            {fixedJobs && fixedJobs.jobs.editor === 'structured' ? (
              <RiskSwitch safe="No risks." risk="This choice accepts a risk." />
            ) : null}
          </SummaryFoot>
        </>
      )}
    </LiveSummary>
  );
}

/** The jobs line of a fixed consumer: repository, context and refs, following the live slots. */
function JobsPhrase(props: { branch: ConsumerBranch }) {
  const { branch } = props;
  if (branch.jobs.editor === 'rows') return <>the conditions you write</>;
  const all = branch.repositoryOptions;
  const shown = all.slice(0, PICKS_SHOWN);
  const value = branch.jobs.repository.trim();
  const matched = all.find((option) => option.value === value);
  if (matched && !shown.includes(matched)) shown.push(matched);
  const repo =
    all.length === 0 ? (
      <span class="v">{repositoryLabelOf(branch) ?? (value || 'the repository you enter')}</span>
    ) : (
      <LivePhrase
        field={3}
        phrases={Object.fromEntries([
          ...shown.map((option, index) => [
            index + 1,
            <span class="v">{/^(.*) \(\d+\)$/.exec(option.value)?.[1] ?? option.value}</span>,
          ]),
          [shown.length + 1, 'the repository you enter'],
        ])}
        empty="the repository you choose"
      />
    );
  const contexts = contextsFor(branch.profile);
  // The environment picks are live field 5 (ContextInput): the phrase names the picked one.
  const environments = branch.suggestions.environments.slice(0, PICKS_SHOWN);
  const known = branch.suggestions.environments.includes(branch.jobs.environment);
  if (known && !environments.includes(branch.jobs.environment)) {
    environments.push(branch.jobs.environment);
  }
  const environmentPhrase =
    environments.length === 0 ? (
      CONTEXT_PHRASE.environment
    ) : (
      <>
        {' · environment '}
        <LivePhrase
          field={5}
          phrases={Object.fromEntries([
            ...environments.map((env, index) => [index + 1, <span class="v">{env}</span>]),
            [environments.length + 1, 'you enter'],
          ])}
          empty="you choose"
        />
      </>
    );
  return (
    <>
      {repo}
      <LivePhrase
        field={4}
        phrases={Object.fromEntries(
          contexts.map((context, index) => [
            index + 1,
            context === 'environment' ? environmentPhrase : CONTEXT_PHRASE[context],
          ]),
        )}
      />
      <LivePhrase
        field={6}
        phrases={{
          1: ' · protected refs only',
          2: <span class="t-warn"> · also unprotected refs (risk)</span>,
        }}
      />
    </>
  );
}
