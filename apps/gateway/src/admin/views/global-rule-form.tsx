// The global access rule form (A7.4) on design D: the issuer (type cards and URL, read-only on edit,
// AR-5), name and description, then one box per limit; a ticked box shows its fields (pages.css
// `.gr-limit`, no JS) and an unticked one submits no value, which the op stores as NULL (no limit).
// The token settings limits sit in a "Token settings" disclosure that opens when one of them is set
// or has an error (Content density). Expiry and state last. The rail says what a global access rule
// does and which rules of its issuer exist. A change that the server classifies as a first ceiling
// or a widening (AR-21) re-renders the form with a confirmation dialog that resubmits it.
import {
  Button,
  ConfirmDialog as UiConfirmDialog,
  Disclosure,
  FormStep,
  LiveForm,
  LiveSummary,
  Stepper,
  SubmitRow,
  SummaryFoot,
  SummaryRow,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { GlobalAccessRule } from '../../db/types';
import { GITHUB_ACTIONS_ISSUER } from '../../identity/profiles/github-actions';
import { GITLAB_COM_ISSUER } from '../../identity/profiles/gitlab-ci';
import { VERCEL_OIDC_ISSUER } from '../../identity/profiles/vercel';
import type { ProfileId } from '../../identity/types';
import { PROXY_METHODS } from '../../policy/types';
import { ALLOWED_ALGS } from '../../policy/validate';
import type { GlobalConfirmation } from '../ops/global-access-rules';
import type { FieldError } from '../ops/shared';
import { ownerFindCommand } from '../rule-access';
import { issuerHost, issuerLogo } from './access-visuals';
import { Checkbox, CheckboxGroup, Field, IdWithLabelField, Select, TextArea } from './components';
import { ISSUER_TYPES, IssuerType } from './issuer-fields';
import { RepeatingRows } from './rows';

/** The limit boxes, in GLOBAL_LIMITS order (policy/limits.ts). */
export const LIMIT_COLUMNS = [
  'tenant_pin',
  'conditions',
  'rules',
  'anchor_claims',
  'audience',
  'jwks_uri',
  'allowed_algs',
  'max_token_age_seconds',
] as const;
export type LimitColumn = (typeof LIMIT_COLUMNS)[number];

/** Limits inside the "Token settings" disclosure. */
const TOKEN_LIMITS: readonly LimitColumn[] = [
  'audience',
  'jwks_uri',
  'allowed_algs',
  'max_token_age_seconds',
];

/** The raw values of the form, kept as text for a re-render. */
export interface GlobalRuleForm {
  type: string;
  issuer: string;
  name: string;
  description: string;
  limits: Record<LimitColumn, boolean>;
  /** GitHub organizations or GitLab groups as `name (ID), …`. */
  tenants: string;
  /** Generic: one claim and its exact values. */
  pin_claim: string;
  pin_values: string;
  cond: Array<{ claim: string; match: string; not: boolean; values: string }>;
  rule: Array<{ m: string[]; path: string }>;
  anchor_claims: string;
  audience: string;
  jwks_uri: string;
  allowed_algs: string[];
  max_token_age_seconds: string;
  /** YYYY-MM-DD, or empty for no expiry. */
  expires_on: string;
  enabled: boolean;
}

export interface GlobalRuleFormModel {
  action: string;
  csrf: string;
  mode: 'create' | 'edit';
  version?: string;
  form: GlobalRuleForm;
  errors: FieldError[];
  /** The other global access rules of the issuer key (rail). */
  siblings: GlobalAccessRule[];
  /** Credential access rules of the issuer key (rail). */
  ruleCount: number | null;
  /** A confirmation the server asks for, and its text. */
  confirm: { kind: GlobalConfirmation; text: string } | null;
  cancelHref: string;
}

const FORM_ID = 'gr-form';

function errorFor(errors: readonly FieldError[], name: string): string | null {
  return errors.find((error) => error.field === name)?.message ?? null;
}

const LIMIT_TEXT: Readonly<Record<LimitColumn, { box: string; hint: string }>> = {
  tenant_pin: {
    box: 'Limit organizations or groups',
    hint: 'Every token must carry one of these tenants (an exact pin, ANDed with each rule’s own).',
  },
  conditions: {
    box: 'Limit jobs',
    hint: 'Every condition must hold on the token: repositories, branches, environments, events.',
  },
  rules: {
    box: 'Limit operations',
    hint: 'Operations are compared with the path relative to each credential’s base URL.',
  },
  anchor_claims: {
    box: 'Require anchors',
    hint: 'Each credential access rule must pin one of these claims exactly.',
  },
  audience: { box: 'Pin the audience', hint: 'Credential access rules must use this audience.' },
  jwks_uri: {
    box: 'Pin the JWKS URI',
    hint: 'Credential access rules must use these signing keys.',
  },
  allowed_algs: {
    box: 'Limit the signing algorithms',
    hint: 'A token signed with another algorithm is refused.',
  },
  max_token_age_seconds: {
    box: 'Limit the token age',
    hint: 'Tokens older than this are refused, whatever the rule allows.',
  },
};

/** One limit: its box, then its fields (shown while the box is ticked). */
function Limit(props: { column: LimitColumn; model: GlobalRuleFormModel; children: Child }) {
  const { column, model } = props;
  const text = LIMIT_TEXT[column];
  return (
    <div class="gr-limit">
      <div class="gr-box">
        <Checkbox
          name={`limit.${column}`}
          label={text.box}
          hint={text.hint}
          checked={model.form.limits[column]}
        />
      </div>
      <div class="gr-fields subbox">{props.children}</div>
    </div>
  );
}

export function GlobalRuleFormView(props: { model: GlobalRuleFormModel }) {
  const { model } = props;
  const { form } = model;
  const err = (name: string) => errorFor(model.errors, name);
  const edit = model.mode === 'edit';
  const tokenOpen = TOKEN_LIMITS.some(
    (column) => form.limits[column] || model.errors.some((e) => e.field?.startsWith(column)),
  );
  const o = (type: ProfileId) => String(ISSUER_TYPES.indexOf(type) + 1);
  return (
    <>
      <LiveForm
        id={FORM_ID}
        action={model.action}
        hidden={{
          _csrf: model.csrf,
          ...(model.version !== undefined ? { expected_updated_at: model.version } : {}),
        }}
        layout={edit ? 'fields' : 'form-layout'}
        class="ga-form gr-form"
        rail={edit ? undefined : <GlobalRail model={model} />}
      >
        <Stepper>
          <FormStep
            n={1}
            kind="group"
            id="gr-issuer"
            title="Issuer"
            description="A global access rule caps every credential access rule of this issuer, on every credential."
          >
            <IssuerType
              prefix=""
              value={form.type}
              error={err('type')}
              legend="Issuer type"
              live="scoped"
              fixed={edit}
            />
            <Field
              name="issuer"
              label="Issuer URL"
              optional={!edit}
              mono
              type="url"
              value={form.issuer}
              example={GITHUB_ACTIONS_ISSUER}
              hint={
                edit
                  ? 'To move this ceiling to another issuer, add a new global access rule and delete this one.'
                  : `Empty: ${GITHUB_ACTIONS_ISSUER} for GitHub Actions, ${GITLAB_COM_ISSUER} for GitLab CI, ${VERCEL_OIDC_ISSUER} (global mode) for Vercel. GitHub Enterprise, self-managed GitLab and Vercel team mode (${VERCEL_OIDC_ISSUER}/<team slug>): their own issuer.`
              }
              error={err('issuer')}
              autocomplete="off"
              readonly={edit}
              conditional
            />
          </FormStep>
          <FormStep n={2} kind="group" id="gr-name" title="Name and description">
            <Field
              name="name"
              label="Name"
              value={form.name}
              example="acme organizations only"
              maxlength={100}
              error={err('name')}
              autocomplete="off"
              conditional
            />
            <TextArea
              name="description"
              label="Description"
              optional
              value={form.description}
              hint="Why this ceiling exists, a ticket link, or an owner to ask."
              error={err('description')}
              autocomplete="off"
              rows={2}
              conditional
            />
          </FormStep>
          <FormStep
            n={3}
            kind="group"
            id="gr-limits"
            title="Limits"
            description="Tick only what you limit. An unticked box is no limit; a ticked box needs at least one value. Operation limits apply to every credential of the issuer, which may be different APIs."
          >
            <Limit column="tenant_pin" model={model}>
              <div class="ga-tbranch" data-o={o('github-actions')}>
                <IdWithLabelField
                  kind="github_owner_list"
                  name="tenants.github"
                  label="Organizations"
                  value={form.type === 'github-actions' ? form.tenants : ''}
                  example="acme (1234567), acme-labs (7654321)"
                  findCommand={ownerFindCommand({ id: 'github-actions' })}
                  error={err('tenants.github')}
                  autocomplete="off"
                  conditional
                />
              </div>
              <div class="ga-tbranch" data-o={o('gitlab-ci')}>
                <IdWithLabelField
                  kind="gitlab_group_list"
                  name="tenants.gitlab"
                  label="Groups"
                  value={form.type === 'gitlab-ci' ? form.tenants : ''}
                  example="acme-group (5678901)"
                  findCommand={ownerFindCommand({ id: 'gitlab-ci' })}
                  error={err('tenants.gitlab')}
                  autocomplete="off"
                  conditional
                />
              </div>
              <div class="ga-tbranch" data-o={o('vercel')}>
                <IdWithLabelField
                  kind="vercel_team"
                  name="tenants.vercel"
                  label="Teams"
                  value={form.type === 'vercel' ? form.tenants : ''}
                  example="acme (team_7Gw5ZMzpQA8h90F832KGp7nwbuh3)"
                  findCommand={ownerFindCommand({ id: 'vercel' })}
                  hint="Separate several with commas."
                  error={err('tenants.vercel')}
                  autocomplete="off"
                  conditional
                />
              </div>
              <div class="ga-tbranch" data-o={o('generic')}>
                <Field
                  name="pin_claim"
                  label="Pin claim"
                  mono
                  value={form.pin_claim}
                  example="organization_id"
                  error={err('pin_claim')}
                  autocomplete="off"
                  conditional
                />
                <Field
                  name="pin_values"
                  label="Pin values"
                  mono
                  value={form.pin_values}
                  example="0c9f3e1a-7b2d-4c5e-9f10-123456789abc"
                  hint='Comma-separated alternatives. Quote a value that contains a comma: "a,b".'
                  error={err('pin_values')}
                  autocomplete="off"
                  conditional
                />
              </div>
            </Limit>
            <Limit column="conditions" model={model}>
              <RepeatingRows
                group="cond"
                legend="Conditions"
                keys={['claim', 'match', 'not', 'values']}
                rows={form.cond.map((row) => ({ ...row, not: row.not ? '1' : '' }))}
                render={(index, row, prefix) => (
                  <>
                    <Field
                      name={`${prefix}claim`}
                      label={`Claim ${index + 1}`}
                      value={row.claim ?? ''}
                      example="repository_owner_id"
                      hint="Literal top-level claim name."
                      error={err(`${prefix}claim`)}
                      autocomplete="off"
                      mono
                      conditional
                    />
                    <Select
                      name={`${prefix}match`}
                      label={`Match ${index + 1}`}
                      value={row.match || 'exact'}
                      options={[
                        { value: 'exact', label: 'is exactly' },
                        { value: 'glob', label: 'matches pattern' },
                      ]}
                      error={err(`${prefix}match`)}
                    />
                    <Checkbox
                      name={`${prefix}not`}
                      label={
                        <>
                          Not<span class="vh"> (condition {index + 1})</span>
                        </>
                      }
                      hint="True when the value differs. A missing claim never matches."
                      checked={row.not === '1'}
                    />
                    <Field
                      name={`${prefix}values`}
                      label={`Values ${index + 1}`}
                      value={row.values ?? ''}
                      example="refs/heads/main, refs/heads/release/*"
                      hint='Comma-separated alternatives. Quote a value that contains a comma: "a,b".'
                      error={err(`${prefix}values`)}
                      autocomplete="off"
                      mono
                      conditional
                    />
                  </>
                )}
              />
            </Limit>
            <Limit column="rules" model={model}>
              <RepeatingRows
                group="rule"
                legend="Methods and paths"
                keys={['m', 'path']}
                rows={form.rule.map((row) => ({ m: row.m.join(','), path: row.path }))}
                render={(index, row, prefix) => {
                  const methods = (row.m ?? '').split(',').filter((m) => m !== '');
                  return (
                    <>
                      <CheckboxGroup
                        name={`${prefix}m`}
                        legend={`Methods of operation ${index + 1}`}
                        options={[
                          ...PROXY_METHODS.map((method) => ({
                            value: method,
                            label: method,
                            checked: methods.includes(method),
                          })),
                          { value: '*', label: 'All methods', checked: methods.includes('*') },
                        ]}
                        error={err(`${prefix}m`)}
                      />
                      <Field
                        name={`${prefix}path`}
                        label={`Path of operation ${index + 1}`}
                        value={row.path ?? ''}
                        example="/chat.postMessage"
                        hint="* matches one segment, ** any depth."
                        error={err(`${prefix}path`)}
                        autocomplete="off"
                        mono
                        conditional
                      />
                    </>
                  );
                }}
              />
            </Limit>
            <Limit column="anchor_claims" model={model}>
              <Field
                name="anchor_claims"
                label="Anchor claims"
                mono
                value={form.anchor_claims}
                example="repository_id"
                hint="1 to 8 claim names, comma-separated."
                error={err('anchor_claims')}
                autocomplete="off"
                conditional
              />
            </Limit>
            <Disclosure
              id="gr-token"
              summary="Token settings"
              hint="audience, signing keys, algorithms and token age"
              open={tokenOpen}
            >
              <Limit column="audience" model={model}>
                <Field
                  name="audience"
                  label="Audience"
                  mono
                  value={form.audience}
                  example="tokengate:6qx4bd7mkt3pzw2hylf5c8ran9"
                  error={err('audience')}
                  autocomplete="off"
                  conditional
                />
              </Limit>
              <Limit column="jwks_uri" model={model}>
                <Field
                  name="jwks_uri"
                  label="JWKS URI"
                  mono
                  type="url"
                  value={form.jwks_uri}
                  example="https://token.actions.githubusercontent.com/.well-known/jwks"
                  error={err('jwks_uri')}
                  autocomplete="off"
                  conditional
                />
              </Limit>
              <Limit column="allowed_algs" model={model}>
                <CheckboxGroup
                  name="allowed_algs"
                  legend="Signing algorithms"
                  options={ALLOWED_ALGS.map((alg) => ({
                    value: alg,
                    label: alg,
                    checked: form.allowed_algs.includes(alg),
                  }))}
                  error={err('allowed_algs')}
                />
              </Limit>
              <Limit column="max_token_age_seconds" model={model}>
                <Field
                  name="max_token_age_seconds"
                  label="Maximum token age (seconds)"
                  inputmode="numeric"
                  value={form.max_token_age_seconds}
                  example="300"
                  error={err('max_token_age_seconds')}
                  autocomplete="off"
                  conditional
                />
              </Limit>
            </Disclosure>
          </FormStep>
          <FormStep n={4} kind="group" id="gr-state" title="Expiry and state">
            <Field
              name="expires_on"
              label="Last day"
              optional
              value={form.expires_on}
              example="2027-01-31"
              hint="When this expires and no other global access rule of the issuer holds, its credential access rules admit nothing. Empty: never."
              error={err('expires_on')}
              autocomplete="off"
              conditional
            />
            {edit ? null : (
              <Checkbox
                name="enabled"
                label="Enabled"
                hint="While it is disabled and no other global access rule of the issuer holds, its credential access rules admit nothing."
                checked={form.enabled}
              />
            )}
          </FormStep>
        </Stepper>
        <SubmitRow>
          <Button variant="primary" type="submit">
            Save global access rule
          </Button>
          <Button href={model.cancelHref}>Cancel</Button>
        </SubmitRow>
      </LiveForm>
      {model.confirm ? (
        <UiConfirmDialog
          id="dlg-gr-confirm"
          title={CONFIRM_TITLE[model.confirm.kind]}
          description={model.confirm.text}
          confirmLabel={CONFIRM_LABEL[model.confirm.kind]}
          confirmVariant="primary"
          form={FORM_ID}
          name={model.confirm.kind === 'new_ceiling' ? 'confirm_new_ceiling' : 'confirm_widening'}
          value="1"
          open
          cancelHref={model.cancelHref}
        />
      ) : null}
    </>
  );
}

const CONFIRM_TITLE: Readonly<Record<GlobalConfirmation, string>> = {
  new_ceiling: 'Add the first global access rule of this issuer?',
  widening: 'Let more requests in?',
  last_disable: 'Disable the last enabled global access rule?',
  last_delete: 'Delete the last global access rule?',
};

const CONFIRM_LABEL: Readonly<Record<GlobalConfirmation, string>> = {
  new_ceiling: 'Save the ceiling',
  widening: 'Save and let more in',
  last_disable: 'Disable it',
  last_delete: 'Delete it',
};

function GlobalRail(props: { model: GlobalRuleFormModel }) {
  const { model } = props;
  return (
    <LiveSummary
      id="gr-sum"
      title="This global access rule"
      description="It never lets a request in by itself."
    >
      <SummaryRow
        logo={issuerLogo({
          profile: (model.form.type as ProfileId) || 'generic',
          issuer: model.form.issuer || GITHUB_ACTIONS_ISSUER,
          enabled: true,
        })}
        title={model.form.issuer ? issuerHost(model.form.issuer) : 'The issuer you choose'}
        meta={
          model.siblings.length === 0
            ? 'No global access rule yet: its credential access rules are not limited.'
            : `${model.siblings.length} other global access ${model.siblings.length === 1 ? 'rule' : 'rules'}; a request needs one that holds.`
        }
      />
      <SummaryFoot>
        {model.ruleCount === null
          ? 'Choose the issuer to see how many credential access rules it caps.'
          : `${model.ruleCount} credential access ${model.ruleCount === 1 ? 'rule uses' : 'rules use'} this issuer.`}
      </SummaryFoot>
    </LiveSummary>
  );
}

/** The fields of a stored rule (edit), as text. */
export function globalFormFromRule(
  rule: GlobalAccessRule,
  labels: (value: string) => string | null,
): GlobalRuleForm {
  const pin = rule.tenant_pin ?? [];
  const tenantValues = pin.flatMap((c) => (c && Array.isArray(c.values) ? c.values : []));
  return {
    type: rule.profile,
    issuer: rule.issuer,
    name: rule.name,
    description: rule.description,
    limits: Object.fromEntries(
      LIMIT_COLUMNS.map((column) => [column, rule[column] !== null]),
    ) as Record<LimitColumn, boolean>,
    tenants:
      rule.profile === 'generic'
        ? ''
        : tenantValues
            .map((value) => {
              const label = labels(value);
              return label ? `${label} (${value})` : value;
            })
            .join(', '),
    pin_claim: rule.profile === 'generic' ? (pin[0]?.claim ?? '') : '',
    pin_values: rule.profile === 'generic' ? (pin[0]?.values ?? []).join(', ') : '',
    cond: (rule.conditions ?? [])
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        claim: c.claim,
        match: c.match,
        not: c.negate === true,
        values: c.values.join(', '),
      })),
    rule: (rule.rules ?? [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({ m: [...r.methods], path: r.path })),
    anchor_claims: (rule.anchor_claims ?? []).join(', '),
    audience: rule.audience ?? '',
    jwks_uri: rule.jwks_uri ?? '',
    allowed_algs: [...(rule.allowed_algs ?? [])],
    max_token_age_seconds:
      rule.max_token_age_seconds === null ? '' : String(rule.max_token_age_seconds),
    expires_on:
      rule.expires_at === null ? '' : new Date(rule.expires_at).toISOString().slice(0, 10),
    enabled: rule.enabled,
  };
}

export function blankGlobalForm(type?: string | null, issuer?: string): GlobalRuleForm {
  return {
    type: ISSUER_TYPES.includes(type as ProfileId) ? (type as string) : 'github-actions',
    issuer: issuer ?? '',
    name: '',
    description: '',
    limits: Object.fromEntries(LIMIT_COLUMNS.map((column) => [column, false])) as Record<
      LimitColumn,
      boolean
    >,
    tenants: '',
    pin_claim: '',
    pin_values: '',
    cond: [],
    rule: [],
    anchor_claims: '',
    audience: '',
    jwks_uri: '',
    allowed_algs: [],
    max_token_age_seconds: '',
    expires_on: '',
    enabled: true,
  };
}
