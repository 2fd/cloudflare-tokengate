// Admin pages: credential access rules (ADR 0026). One rule lets the jobs of one issuer use one credential:
// its issuer and tenant pin (I-TEN-1), its token verification settings (I-JWT-1), the jobs it admits
// (anchored, I-AUTHZ-2) and the operations it allows. The structured form builds the conditions and
// rules (rule-access.ts) and every save goes through ops/credential-access-rules.ts
// (validateCredentialAccessRule; audit I-AUDIT-1). Risks are accepted by the selection that causes
// them, or by ticking a box bound to a digest of exactly the risks shown (A7.7). The global access
// rules of the issuer are shown as a status, never as a refusal (AR-8). Autocomplete reads only
// control-plane data; a request record prefills the form only on request, verified (I-LOG-2).
import {
  ActiveFilters,
  AddFilter,
  Button,
  Callout,
  Cell,
  EmptyState as UiEmptyState,
  Entity,
  Filters,
  Mono,
  PageHeader,
  Panel,
  QuickLinks,
  Row,
  RowHeader,
  Table,
  Tray,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { sha256Hex } from '../../crypto/hash';
import { listGlobalAccessRules } from '../../db/access-rules';
import { listAuditEvents } from '../../db/audit';
import { labelFor } from '../../db/claim-labels';
import { getRequest } from '../../db/requests';
import {
  credentialRuleShapes,
  issuerRuleShapes,
  jobSuggestions,
  rulePathSuggestions,
  ruleSets as ruleSetsOf,
} from '../../db/suggestions';
import type { ClaimLabel, CredentialAccessRule, Service } from '../../db/types';
import { getProfile, PROFILES } from '../../identity/profiles';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import { parseJson } from '../../lib/json';
import { claimText } from '../../policy/conditions';
import { globalStatus } from '../../policy/global-status';
import { issuerKey } from '../../policy/limits';
import type { Condition, Rule } from '../../policy/types';
import type { WarningCode, WarningDetail } from '../../policy/validate';
import { validateCredentialAccessRule } from '../../policy/validate-rules';
import { loadUnknownIssuers, type UnknownIssuer } from '../access-traffic';
import { can } from '../auth/rbac';
import { type Connections, loadConnections, type RuleEdge } from '../connections';
import { type NoticeContext, type NoticeTable, resolveNotice } from '../notice';
import {
  addTenantValue,
  createCredentialAccessRule,
  type CredentialRuleInput,
  deleteCredentialAccessRule,
  duplicateCredentialAccessRule,
  removeTenantValue,
  ruleIssuer,
  setCredentialAccessRuleEnabled,
  tenantClaimOf,
  updateCredentialAccessRule,
} from '../ops/credential-access-rules';
import type { FieldError, OpFailure } from '../ops/shared';
import { paths, returnPath, type RuleStatusFilter } from '../paths';
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
  accessWarningDetails,
  anchorClaims,
  blankJobsForm,
  condRows,
  coveredRiskCodes,
  defaultOpsForm,
  deriveAccessName,
  type ExpiryForm,
  type Fields,
  flag,
  idText,
  type JobsForm,
  jobsFormFromRule,
  jobsToRows,
  mostUsedContext,
  type OpsForm,
  opsFormFromRules,
  parseExpiry,
  parseJobs,
  parseOps,
  parseOwnerList,
  readExpiryForm,
  readJobsForm,
  readOpsForm,
  text,
  withAnyRefFlags,
  withTypedLabels,
} from '../rule-access';
import { templateForService } from '../service-templates';
import { AccessRuleTabs } from '../views/access-rule-tabs';
import {
  issuerHost,
  issuerLogo,
  leadStatus,
  operationsText,
  PathName,
  StatusDot,
  tenantsText,
  tokenLogo,
} from '../views/access-visuals';
import {
  ActionButton,
  AskSomeone,
  NotFound,
  notFoundText,
  type Suggestion,
} from '../views/components';
import {
  type FormEntry,
  type JobsBranch,
  type RequestFacts,
  RuleForm,
  type RuleFormModel,
  type TokenBranch,
  type TokenChoice,
  type TokenSettingsForm,
} from '../views/credential-rule-form';
import {
  CredentialRuleHeader,
  CredentialRulePage,
  type CredentialRulePageModel,
  type HistoryEntry,
} from '../views/credential-rule-page';
import { formatCount, relativeTime } from '../views/format';
import { LearnMore } from '../views/header';
import {
  blankIssuerForm,
  type IssuerForm,
  type IssuerInput,
  issuerFormFromRule,
  issuerPin,
  ISSUER_TYPES,
  parseIssuerForm,
  readIssuerForm,
} from '../views/issuer-fields';
import { credentialText } from '../views/matrix';
import { profileForIssuer } from '../views/monitoring';
import { accessFixable, reasonText } from '../views/reasons';
import { statusLabel } from '../views/status';

/** At most this many cards; more choices become a select (A7.1, Choice). */
const MAX_CARDS = 6;

const STATUS_FILTERS: readonly RuleStatusFilter[] = ['active', 'disabled', 'expired', 'blocked'];
const STATUS_WORDS: Readonly<Record<RuleStatusFilter, string>> = {
  active: 'Active',
  disabled: 'Disabled',
  expired: 'Expired',
  blocked: 'Blocked by global rules',
};

export function registerCredentialAccessRulesRoutes(app: App): void {
  app.get('/admin/credential-access-rules', listPage);
  app.get('/admin/credential-access-rules/new', newPage);
  app.post('/admin/credential-access-rules', create);
  app.get('/admin/credential-access-rules/:id', detailPage);
  app.post('/admin/credential-access-rules/:id', update);
  app.post('/admin/credential-access-rules/:id/tenants', tenants);
  app.post('/admin/credential-access-rules/:id/copy', copy);
  app.post('/admin/credential-access-rules/:id/toggle', toggle);
  app.post('/admin/credential-access-rules/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Notices

interface RuleNoticeData {
  rule: CredentialAccessRule | null;
}

const NOTICES: NoticeTable<NoticeContext & RuleNoticeData> = {
  created: () => ({
    text: 'Access rule created. Add the snippet below to the job; it can use the credential from the next request on.',
  }),
  copied: () => ({ text: 'Copy created and enabled. Add the snippet below to the job.' }),
  updated: () => ({ text: 'Access rule saved.' }),
  label_changed: () => ({
    text: 'Access rule saved. A display name of an ID changed everywhere it is shown.',
  }),
  unchanged: () => ({ text: 'Nothing changed: the submitted values are the current ones.' }),
  enabled: () => ({ text: 'Access rule enabled.' }),
  disabled: ({ rule }) => ({
    text: 'Access rule disabled. It stops matching from the next request on.',
    ...(rule && !rule.enabled
      ? {
          undo: {
            action: `${paths.accessRule(rule.id)}/toggle`,
            fields: { enabled: '1', _return: 'detail' },
            label: 'Enable again',
            srSuffix: rule.name,
          },
        }
      : {}),
  }),
  deleted: () => ({ text: 'Access rule deleted.' }),
  tenant_added: () => ({ text: 'Added. Jobs of it can match from the next request on.' }),
  tenant_removed: () => ({ text: 'Removed. Its jobs no longer match from the next request on.' }),
  copy_review: () => ({
    text: 'The copy has risks the source does not have on that credential: review them, then save.',
  }),
  copy_operations: () => ({
    text: 'That credential has other operations: choose its operations, then save. Nothing was copied yet.',
  }),
  copy_expiry: () => ({
    text: 'The source has expired: choose the expiry of the copy, then save. Nothing was copied yet.',
  }),
};

function notice(c: AdminContext, data: RuleNoticeData) {
  return resolveNotice(NOTICES, c.req.query('notice'), null, data);
}

// ---------------------------------------------------------------------------------------------
// The list

interface ListQuery {
  credentialId: string;
  issuer: string;
  status: RuleStatusFilter | '';
}

async function listPage(c: AdminContext) {
  const deps = c.get('deps');
  const [connections, unknownIssuers] = await Promise.all([
    loadConnections(deps).then(withAnyRefFlags),
    loadUnknownIssuers(deps),
  ]);
  const query = (name: string) => c.req.query(name) ?? '';
  const notes: string[] = [];
  let credentialId = query('credential');
  if (credentialId && !connections.credentials.some((item) => item.id === credentialId)) {
    notes.push('That credential no longer exists.');
    credentialId = '';
  }
  const issuers = issuerKeys(connections);
  let issuer = query('issuer');
  if (issuer && !issuers.has(issuer)) {
    notes.push('No credential access rule uses that issuer.');
    issuer = '';
  }
  const status = (STATUS_FILTERS as readonly string[]).includes(query('status'))
    ? (query('status') as RuleStatusFilter)
    : '';
  const q: ListQuery = { credentialId, issuer, status };
  const filtered = connections.rules.filter((edge) => matches(edge, q));
  const anyFilter = q.credentialId !== '' || q.issuer !== '' || q.status !== '';
  const credential = connections.credentials.find((item) => item.id === q.credentialId) ?? null;
  const total = connections.rules.length;
  return renderPage(
    c,
    {
      title: 'Credential access rules',
      section: 'credentials',
      subsection: 'access-rules',
      notice: notice(c, { rule: null }),
      header: (ctx) => (
        <PageHeader
          title="Access rules"
          count={anyFilter ? `${filtered.length} of ${total}` : total}
          description={
            <>
              Which jobs may use which credential, and for what. The global access rules of each
              issuer cap them.
              {credential ? (
                <>
                  {' '}
                  Showing the rules of <a href={paths.token(credential.id)}>{credential.name}</a>.
                </>
              ) : null}
              <LearnMore
                path="concepts.md#credential-access-rule"
                about="credential access rules"
              />
            </>
          }
          actions={
            ctx.can('access:write') && connections.credentials.length > 0 && total > 0 ? (
              <Button
                variant="primary"
                plus
                href={paths.accessRuleNew({ credential: q.credentialId || undefined })}
              >
                Add credential access rule
              </Button>
            ) : undefined
          }
        >
          <AccessRuleTabs
            current="credential"
            counts={{ credential: total, global: connections.globals.length }}
          />
        </PageHeader>
      ),
    },
    (ctx) => (
      <>
        {notes.map((note) => (
          <Callout title={note} />
        ))}
        <ListBody
          connections={connections}
          q={q}
          filtered={filtered}
          anyFilter={anyFilter}
          ctx={ctx}
        />
        <UnknownIssuers issuers={unknownIssuers} ctx={ctx} />
      </>
    ),
  );
}

/** Issuer key → the issuer as written by the oldest rule, of every credential access rule. */
function issuerKeys(connections: Connections): Map<string, CredentialAccessRule> {
  const keys = new Map<string, CredentialAccessRule>();
  for (const edge of connections.rules) {
    if (!keys.has(edge.rule.issuer_key)) keys.set(edge.rule.issuer_key, edge.rule);
  }
  return keys;
}

function matches(edge: RuleEdge, q: ListQuery): boolean {
  if (q.credentialId && edge.rule.credential_id !== q.credentialId) return false;
  if (q.issuer && edge.rule.issuer_key !== q.issuer) return false;
  return q.status === '' || statusMatches(edge, q.status);
}

function statusMatches(edge: RuleEdge, status: RuleStatusFilter): boolean {
  switch (status) {
    case 'active':
      return edge.status === 'active' || edge.status === 'expiring';
    case 'disabled':
      return edge.status === 'disabled';
    case 'expired':
      return edge.status === 'expired';
    case 'blocked':
      return edge.globalStatus.kind === 'blocked';
  }
}

function listHref(q: ListQuery, change: Partial<Parameters<typeof paths.accessRules>[0]> = {}) {
  return paths.accessRules({
    credential: q.credentialId || undefined,
    issuer: q.issuer || undefined,
    status: q.status || undefined,
    ...change,
  });
}

function ListBody(props: {
  connections: Connections;
  q: ListQuery;
  filtered: RuleEdge[];
  anyFilter: boolean;
  ctx: ViewContext;
}) {
  const { connections, q, filtered, ctx } = props;
  const canWrite = ctx.can('access:write');
  if (connections.credentials.length === 0) {
    return (
      <UiEmptyState
        headingLevel={2}
        title="A credential manager must add a credential first."
        description="A credential access rule lets the jobs of an issuer use a credential."
        actions={
          ctx.can('tokens:write') ? (
            <Button variant="primary" plus href={paths.tokenNew()}>
              Add credential
            </Button>
          ) : (
            <AskSomeone permission="tokens:write" ctx={ctx} verb="add a credential" />
          )
        }
      />
    );
  }
  if (connections.rules.length === 0) {
    return (
      <UiEmptyState
        headingLevel={2}
        title="No credential access rules. A workload can use a credential only through one."
        actions={
          canWrite ? (
            <Button variant="primary" plus href={paths.accessRuleNew()}>
              Add credential access rule
            </Button>
          ) : (
            <AskSomeone permission="access:write" ctx={ctx} verb="add a credential access rule" />
          )
        }
      />
    );
  }
  const all = connections.rules;
  const count = (test: (edge: RuleEdge) => boolean) => all.filter(test).length;
  const issuers = [...issuerKeys(connections).entries()];
  const columns = [
    { label: 'Rule' },
    { label: 'Credential' },
    { label: 'Issuer' },
    { label: 'Jobs' },
    { label: 'Operations' },
    { label: 'Global' },
    { label: 'Status' },
    ...(canWrite ? [{ label: 'Actions', act: true }] : []),
  ];
  return (
    <Tray
      id="rules"
      title="Credential access rules"
      hideTitle
      bar={
        <>
          <QuickLinks
            label="Filter credential access rules by status"
            links={[
              {
                href: listHref(q, { status: undefined }),
                label: 'All',
                count: all.length,
                current: q.status === '',
              },
              ...STATUS_FILTERS.map((status) => ({
                href: listHref(q, { status }),
                label: STATUS_WORDS[status],
                glyph: status === 'blocked' ? '✕' : undefined,
                tone: status === 'blocked' ? ('bad' as const) : undefined,
                count: count((edge) => statusMatches(edge, status)),
                current: q.status === status,
              })),
            ]}
          />
          <Filters label="Filter credential access rules" as="group">
            <AddFilter
              label="Credential"
              options={connections.credentials.map((credential) => ({
                href: listHref(q, { credential: credential.id }),
                label: credential.name,
                logo: tokenLogo(credential),
                slug: credential.slug,
                count: count((edge) => edge.rule.credential_id === credential.id),
              }))}
              srSuffix="rules"
            />
            <AddFilter
              label="Issuer"
              options={issuers.map(([key, rule]) => ({
                href: listHref(q, { issuer: key }),
                label: issuerHost(rule.issuer),
                logo: issuerLogo({ ...rule, enabled: true }),
                count: count((edge) => edge.rule.issuer_key === key),
              }))}
              srSuffix="rules"
            />
          </Filters>
          <ActiveFilters
            filters={[
              ...(q.credentialId
                ? [
                    {
                      label: `Credential: ${connections.credentials.find((s) => s.id === q.credentialId)?.name ?? q.credentialId}`,
                      href: listHref(q, { credential: undefined }),
                    },
                  ]
                : []),
              ...(q.issuer
                ? [
                    {
                      label: `Issuer: ${q.issuer}`,
                      href: listHref(q, { issuer: undefined }),
                    },
                  ]
                : []),
              ...(q.status
                ? [
                    {
                      label: `Status: ${STATUS_WORDS[q.status]}`,
                      href: listHref(q, { status: undefined }),
                    },
                  ]
                : []),
            ]}
            clearHref={paths.accessRules()}
            clearLabel="Clear filters"
          />
        </>
      }
    >
      <Panel variant="flush">
        <Table id="rule-list" labelledBy="rules-h" stackable columns={columns}>
          {filtered.length === 0
            ? undefined
            : filtered.map((edge) => (
                <RuleListRow edge={edge} connections={connections} ctx={ctx} />
              ))}
        </Table>
        {filtered.length === 0 ? (
          <UiEmptyState
            title="No credential access rule matches these filters."
            actions={<Button href={paths.accessRules()}>Clear filters</Button>}
          />
        ) : null}
      </Panel>
    </Tray>
  );
}

function RuleListRow(props: { edge: RuleEdge; connections: Connections; ctx: ViewContext }) {
  const { edge, connections, ctx } = props;
  const { rule, credential } = edge;
  const labels = connections.labels.filter((label) => label.access_rule_id === rule.id);
  return (
    <Row>
      <RowHeader>
        <a href={paths.accessRule(rule.id)}>{rule.name}</a>
        {rule.description ? <span class="meta d-block">{rule.description}</span> : null}
      </RowHeader>
      <Cell label="Credential">
        {credential ? (
          <Entity
            logo={tokenLogo(credential)}
            logoSize="sm"
            href={paths.token(credential.id)}
            name={credential.name}
          />
        ) : (
          'Deleted credential'
        )}
      </Cell>
      <Cell label="Issuer">
        <Entity
          logo={issuerLogo(rule)}
          logoSize="sm"
          name={issuerHost(rule.issuer)}
          meta={<span class="mono">{tenantsText(rule, labels)}</span>}
        />
      </Cell>
      <Cell label="Jobs">
        <span class="mono">
          <PathName text={edge.subject} />
        </span>
        <span class="meta d-block">{edge.context}</span>
      </Cell>
      <Cell label="Operations">{operationsText(edge)}</Cell>
      <Cell label="Global">
        <GlobalChip edge={edge} />
      </Cell>
      <Cell label="Status">
        <RuleStatus edge={edge} now={ctx.now} />
      </Cell>
      {ctx.can('access:write') ? (
        <Cell act>
          <ActionButton
            action={`${paths.accessRule(rule.id)}/toggle`}
            csrf={ctx.csrf}
            label={rule.enabled ? 'Disable' : 'Enable'}
            context={rule.name}
            fields={{ enabled: rule.enabled ? '0' : '1' }}
            returnTo="list"
            size="sm"
          />
        </Cell>
      ) : null}
    </Row>
  );
}

/**
 * The global access rule status of a rule as a short word with a link to its issuer's rules. The
 * column header says "Global"; the rest of the phrase is for screen readers only, so the eight list
 * columns fit the page width.
 */
export function GlobalChip(props: { edge: Pick<RuleEdge, 'rule' | 'globalStatus'> }) {
  const { rule, globalStatus: status } = props.edge;
  const href = paths.globalRules({ issuer: rule.issuer_key });
  switch (status.kind) {
    case 'not_limited':
      return <span class="meta">Not limited</span>;
    case 'within':
      return (
        <a href={href}>
          Within<span class="vh"> global access rules</span>
        </a>
      );
    case 'limited':
      return (
        <a class="t-warn" href={href}>
          Limited<span class="vh"> by global access rules</span>
        </a>
      );
    case 'blocked':
      return (
        <a class="t-bad" href={href}>
          Blocked<span class="vh"> by global access rules</span>
        </a>
      );
  }
}

/** The status of a rule as the dense row form, with its flags and its expiry. */
export function RuleStatus(props: {
  edge: Pick<RuleEdge, 'rule' | 'status' | 'statusDetail' | 'flags'>;
  now: number;
}) {
  const { edge } = props;
  const expires = edge.rule.expires_at;
  const lead = leadStatus(edge);
  return (
    <>
      <StatusDot status={lead.status} detail={lead.detail} />
      {lead.rest.map((item) => (
        <span class="meta d-block">{statusLabel(item.status, item.detail)}</span>
      ))}
      {expires !== null && expires > props.now && edge.status !== 'expiring' ? (
        <span class="meta d-block">Expires {new Date(expires).toISOString().slice(0, 10)}</span>
      ) : null}
    </>
  );
}

function UnknownIssuers(props: { issuers: UnknownIssuer[]; ctx: ViewContext }) {
  const { issuers, ctx } = props;
  if (issuers.length === 0) return null;
  return (
    <Tray
      id="unk"
      title="Callers no access rule trusts"
      description="Refused before a credential was chosen, last 24 hours. Add an access rule only if you recognize the issuer."
      actions={
        <Button
          size="sm"
          href={paths.requests({ outcome: 'denied', token: 'none', reason: 'issuer_unknown' })}
        >
          See refused requests
        </Button>
      }
    >
      <Panel variant="flush">
        {issuers.map((item) => {
          const type = profileForIssuer(item.issuer);
          return (
            <div class="dz-row">
              <Entity
                logo="oidc"
                name={<span class="mono">{item.issuer}</span>}
                meta={
                  <>
                    Unknown issuer ·{' '}
                    <span class="t-bad">{formatCount(item.requests)} requests</span> · last seen{' '}
                    {relativeTime(item.latestTs, ctx.now)}
                  </>
                }
              />
              {ctx.can('access:write') ? (
                <Button
                  href={paths.accessRuleNew(type ? { type } : undefined)}
                  srSuffix={`: ${item.issuer}`}
                >
                  Add credential access rule
                </Button>
              ) : null}
            </div>
          );
        })}
      </Panel>
    </Tray>
  );
}

// ---------------------------------------------------------------------------------------------
// The form: data and model

interface FormData {
  connections: Connections;
  tokens: Service[];
}

async function loadFormData(c: AdminContext): Promise<FormData> {
  const connections = withAnyRefFlags(await loadConnections(c.get('deps')));
  const tokens = [...connections.credentials].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  );
  return { connections, tokens };
}

/** What the form shows before the admin types: from the query (GET) or a failed POST. */
interface FormSeed {
  /** Submitted fields of a re-render; branches present in them keep their values. */
  fields: Fields | null;
  tokenId: string;
  tokenView: 'fixed' | 'auto';
  /** The issuer fields before the admin types (copy, edit, from a request, `?type=`). */
  issuer?: IssuerForm;
  /** Prefilled "Which jobs" of the chosen type (copy, edit, from a request). */
  jobs?: JobsForm | null;
  /** Stored labels that prefilled values may name (copy, edit). */
  labels?: ClaimLabel[];
  ops?: OpsForm | null;
  expiry?: ExpiryForm;
  details?: { name: string; description: string };
  settings?: TokenSettingsForm;
  errors: FieldError[];
  ack: { digest: string; warnings: string[] } | null;
  /** The `_action` of a re-render. */
  action?: string;
  /** The repository's organization or group that the rule does not pin (unknownOwner). */
  unknownOwner?: string | null;
  hidden?: Record<string, string>;
  global?: RuleFormModel['global'];
}

const BLANK_SETTINGS: TokenSettingsForm = {
  audience: '',
  jwks_uri: '',
  allowed_algs: [],
  max_token_age_seconds: '',
};

function settingsOf(rule: CredentialAccessRule): TokenSettingsForm {
  return {
    audience: rule.audience,
    jwks_uri: rule.profile === 'generic' ? rule.jwks_uri : '',
    allowed_algs: [...rule.allowed_algs],
    max_token_age_seconds: String(rule.max_token_age_seconds),
  };
}

function readSettings(fields: Fields): TokenSettingsForm {
  const algs = fields.allowed_algs;
  return {
    audience: text(fields, 'audience'),
    jwks_uri: text(fields, 'jwks_uri'),
    allowed_algs: (Array.isArray(algs) ? algs : algs === undefined ? [] : [algs]).filter(
      (alg): alg is string => typeof alg === 'string' && alg !== '',
    ),
    max_token_age_seconds: text(fields, 'max_token_age_seconds'),
  };
}

/**
 * The rule the form describes for one issuer type, in memory: the issuer and tenant pin of the
 * fields (or of the stored rule), for the jobs parser and the anchor rules. Never stored as is.
 */
function pendingRule(
  input: IssuerInput | null,
  type: ProfileId,
  editing: CredentialAccessRule | null,
): CredentialAccessRule {
  const profile = PROFILES[type];
  const issuer = input?.issuer ?? editing?.issuer ?? ruleIssuer(type, undefined);
  const pin = input ? issuerPin(input).tenant_pin : (editing?.tenant_pin ?? []);
  return {
    kind: 'credential',
    id: editing?.id ?? 'acr_new',
    credential_id: editing?.credential_id ?? '',
    name: editing?.name ?? profile.label,
    description: editing?.description ?? '',
    profile: type,
    issuer,
    issuer_key: issuerKey(issuer),
    jwks_uri: editing?.jwks_uri ?? issuer,
    audience: editing?.audience ?? 'tokengate:pending-rule-audience',
    allowed_algs: editing?.allowed_algs ?? [...profile.defaults.allowedAlgs],
    max_token_age_seconds: editing?.max_token_age_seconds ?? profile.defaults.maxTokenAgeSeconds,
    tenant_pin: pin,
    anchor_claims:
      type === 'generic' ? (input?.anchor_claims ?? editing?.anchor_claims ?? ['sub']) : [],
    conditions: editing?.conditions ?? [],
    rules: editing?.rules ?? [],
    enabled: editing?.enabled ?? true,
    expires_at: editing?.expires_at ?? null,
    created_by: null,
    created_at: 0,
    updated_at: editing?.updated_at ?? 0,
  };
}

/** The labels the jobs of a type can name: the typed tenant labels on top of the stored ones. */
function pendingLabels(input: IssuerInput | null, stored: readonly ClaimLabel[]): ClaimLabel[] {
  const typed = input ? issuerPin(input).labels : [];
  return [
    ...typed.map((label) => ({
      access_rule_id: 'acr_new',
      ...label,
      updated_at: 0,
      updated_by: null,
    })),
    ...stored.filter(
      (label) => !typed.some((t) => t.claim === label.claim && t.value === label.value),
    ),
  ];
}

/** Rules per repository ID of a credential (the repository picker's usage column). */
function repositoryUse(
  profile: Pick<IssuerProfile, 'id'>,
  connections: Connections,
  credentialId: string,
): Map<string, number> {
  const claims = anchorClaims(profile);
  const use = new Map<string, number>();
  if (claims === null) return use;
  for (const edge of connections.rules) {
    if (edge.rule.credential_id !== credentialId || edge.rule.profile !== profile.id) continue;
    for (const c of edge.rule.conditions) {
      if (c?.claim !== claims.repository) continue;
      for (const value of c.values) use.set(value, (use.get(value) ?? 0) + 1);
    }
  }
  return use;
}

function repositoryOptions(
  profile: Pick<IssuerProfile, 'id'>,
  labels: readonly ClaimLabel[],
  use: Map<string, number>,
): Suggestion[] {
  const claims = anchorClaims(profile);
  if (claims === null) return [];
  const seen = new Set<string>();
  return labels
    .filter((label) => label.claim === claims.repository)
    .filter((label) => (seen.has(label.value) ? false : (seen.add(label.value), true)))
    .sort(
      (a, b) => (use.get(b.value) ?? 0) - (use.get(a.value) ?? 0) || a.label.localeCompare(b.label),
    )
    .map((label) => ({ value: idText(label.value, label.label) }));
}

/** The labels a credential's rules of one type already carry (repositories, organizations). */
function credentialLabels(
  connections: Connections,
  credentialId: string,
  type: ProfileId,
): ClaimLabel[] {
  const ids = new Set(
    connections.rules
      .filter((edge) => edge.rule.credential_id === credentialId && edge.rule.profile === type)
      .map((edge) => edge.rule.id),
  );
  return connections.labels.filter((label) => ids.has(label.access_rule_id));
}

async function jobsBranch(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
  type: ProfileId,
  form: IssuerForm,
  editing: CredentialAccessRule | null,
  selected: boolean,
): Promise<JobsBranch> {
  const profile = PROFILES[type];
  const prefix = `new.${type}.`;
  const parsed = parseIssuerForm({ ...form, type }, 'new.');
  const input = parsed.ok ? parsed.input : null;
  const rule = pendingRule(input, type, editing && editing.profile === type ? editing : null);
  const credentialId = editing?.credential_id ?? seed.tokenId;
  const stored = [
    ...(seed.labels ?? []),
    ...(credentialId ? credentialLabels(data.connections, credentialId, type) : []),
  ];
  const labels = pendingLabels(input, stored);
  const db = c.get('deps').env.DB;
  const shapes = credentialId ? await issuerRuleShapes(db, credentialId, rule.issuer_key) : [];
  const suggestions = jobSuggestions(shapes, rule);
  let jobs: JobsForm;
  if (seed.fields && (selected || seed.fields[`${prefix}editor`] !== undefined)) {
    jobs = readJobsForm(seed.fields, prefix, profile);
  } else if (selected && seed.jobs) {
    jobs = seed.jobs;
  } else {
    jobs = defaultJobs(profile, labels, shapes, suggestions.environments);
  }
  const use = credentialId
    ? repositoryUse(profile, data.connections, credentialId)
    : new Map<string, number>();
  const branch: JobsBranch = {
    rule,
    profile,
    prefix,
    jobs,
    labels,
    suggestions,
    repositoryOptions: repositoryOptions(profile, labels, use),
    repositoryCounts: Object.fromEntries(
      [...use].map(([value, n]) => [idText(value, labelFor(labels, 'repository_id', value)), n]),
    ),
    mostUsedContext: shapes.length > 0 ? mostUsedContext(shapes, profile) : null,
    unknownOwner: selected ? (seed.unknownOwner ?? null) : null,
    ruleCount: shapes.length,
  };
  if (selected && seed.action === 'rows') {
    branch.jobs = jobsToRows(branch.jobs, { profile, provider: rule, labels, prefix });
  }
  if (selected && seed.action === `add:${prefix}cond`) branch.extraRows = 2;
  return branch;
}

function defaultJobs(
  profile: IssuerProfile,
  labels: readonly ClaimLabel[],
  shapes: Awaited<ReturnType<typeof issuerRuleShapes>>,
  environments: readonly string[],
): JobsForm {
  const jobs = blankJobsForm(profile);
  const claims = anchorClaims(profile);
  if (claims) {
    const repositories = labels.filter((label) => label.claim === claims.repository);
    const [only] = repositories;
    if (repositories.length === 1 && only) jobs.repository = idText(only.value, only.label);
    jobs.context = mostUsedContext(shapes, profile);
    const [environment] = environments;
    if (environments.length === 1 && environment) jobs.environment = environment;
  }
  return jobs;
}

async function tokenBranch(
  c: AdminContext,
  data: FormData,
  token: Service,
  prefix: string,
  seed: FormSeed,
  selected: boolean,
): Promise<TokenBranch> {
  const shapes = await credentialRuleShapes(c.get('deps').env.DB, token.id);
  const template = templateForService(token);
  const sets = ruleSetsOf(shapes);
  let ops: OpsForm;
  if (seed.fields && (selected || seed.fields[`${prefix}ops`] !== undefined)) {
    ops = readOpsForm(seed.fields, prefix);
  } else if (selected && seed.ops) ops = seed.ops;
  else ops = defaultOpsForm(template, sets);
  return {
    token,
    template,
    ruleSets: sets,
    pathSuggestions: rulePathSuggestions(shapes),
    prefix,
    ops,
    credential: credentialText(token, data.connections.unreadableTokenIds),
    ...(selected && seed.action === 'add:rule' ? { extraRows: 2 } : {}),
  };
}

function issuerFormOf(seed: FormSeed): IssuerForm {
  const form = seed.fields
    ? readIssuerForm(seed.fields, 'new.')
    : (seed.issuer ?? blankIssuerForm());
  if (!ISSUER_TYPES.includes(form.type as ProfileId)) form.type = 'github-actions';
  return form;
}

async function buildFormModel(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
  editing: CredentialAccessRule | null,
): Promise<RuleFormModel> {
  const now = c.get('deps').now();
  const fields = seed.fields;
  const form = issuerFormOf(seed);
  if (editing) form.type = editing.profile;
  const jobs = {} as Record<ProfileId, JobsBranch>;
  for (const type of ISSUER_TYPES) {
    if (editing && type !== editing.profile) continue;
    jobs[type] = await jobsBranch(c, data, seed, type, form, editing, form.type === type);
  }

  const tokens = data.tokens;
  const selectedToken = tokens.find((token) => token.id === seed.tokenId) ?? null;
  let token: TokenChoice;
  if (selectedToken && (editing || tokens.length === 1 || seed.tokenView === 'fixed')) {
    token = {
      kind: 'fixed',
      branch: await tokenBranch(c, data, selectedToken, '', seed, true),
      changeHref:
        !editing && tokens.length > 1 && !seed.hidden?.from_request
          ? paths.accessRuleNew({ copy: seed.hidden?.copy })
          : null,
    };
  } else if (tokens.length <= MAX_CARDS) {
    const branches: TokenBranch[] = [];
    for (const item of tokens) {
      branches.push(
        await tokenBranch(c, data, item, `${item.id}.`, seed, item.id === seed.tokenId),
      );
    }
    token = { kind: 'cards', branches, selected: seed.tokenId };
  } else {
    token = {
      kind: 'select',
      options: tokens,
      selected: seed.tokenId,
      branch: selectedToken
        ? await tokenBranch(c, data, selectedToken, `${selectedToken.id}.`, seed, true)
        : null,
    };
  }
  const hidden: Record<string, string> = { ...seed.hidden };
  if (!editing && token.kind === 'fixed' && tokens.length > 1) hidden.token_view = 'fixed';
  for (const branch of tokenBranches(token)) hidden[`${branch.prefix}ops`] = '1';
  return {
    action: editing ? paths.accessRule(editing.id) : paths.accessRules(),
    csrf: c.get('viewer').csrfToken,
    mode: editing ? 'edit' : 'create',
    ...(editing ? { version: String(editing.updated_at) } : {}),
    issuer: { form, jobs, fixedType: editing !== null },
    token,
    existingRules: data.connections.rules.map((edge) => edge.rule),
    details: fields
      ? { name: text(fields, 'name'), description: text(fields, 'description') }
      : (seed.details ?? { name: '', description: '' }),
    settings: fields ? readSettings(fields) : (seed.settings ?? BLANK_SETTINGS),
    expiry: fields ? readExpiryForm(fields) : (seed.expiry ?? { expires: 'never', expires_on: '' }),
    ...(editing ? { keep: editing.expires_at } : {}),
    now,
    origin: new URL(c.req.url).origin,
    ack: seed.ack,
    errors: seed.errors,
    hidden,
    focus: focusOf(seed, form, jobs, token),
    global: seed.global ?? null,
  };
}

function tokenBranches(choice: TokenChoice): TokenBranch[] {
  if (choice.kind === 'cards') return choice.branches;
  return choice.branch ? [choice.branch] : [];
}

function focusOf(
  seed: FormSeed,
  form: IssuerForm,
  jobs: Record<ProfileId, JobsBranch>,
  token: TokenChoice,
): RuleFormModel['focus'] {
  const branch = jobs[form.type as ProfileId];
  if (branch && seed.action === `add:${branch.prefix}cond`) {
    return { group: `${branch.prefix}cond`, index: Math.max(branch.jobs.cond.length, 1) + 2 };
  }
  if (seed.action === 'add:rule') {
    const chosen =
      token.kind === 'cards'
        ? (token.branches.find((item) => item.token.id === token.selected) ?? null)
        : token.branch;
    if (chosen) return { group: `${chosen.prefix}rule`, index: chosen.ops.rule.length + 2 };
  }
  return null;
}

async function renderForm(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
  options: {
    status?: 200 | 400 | 409 | 422;
    banner?: Child;
    notice?: ReturnType<typeof notice>;
    /** The denied request the form was prefilled from (header, rail, Back link). */
    request?: RequestFacts;
  } = {},
) {
  const plainHeader = (
    <PageHeader
      crumbs={[
        { label: 'Credential access rules', href: paths.accessRules() },
        { label: 'Add credential access rule' },
      ]}
      title="Add credential access rule"
      description="Choose the issuer, the jobs, and what they may call on which credential. Everything is preset; change only what differs."
    />
  );
  if (data.tokens.length === 0) {
    return renderPage(
      c,
      {
        title: 'Add credential access rule',
        section: 'credentials',
        subsection: 'access-rules',
        status: options.status ?? 200,
        header: plainHeader,
      },
      (ctx) => (
        <UiEmptyState
          headingLevel={2}
          title="A credential manager must add a credential first."
          description="A credential access rule lets the jobs of an issuer use a credential."
          actions={
            ctx.can('tokens:write') ? (
              <Button variant="primary" plus href={paths.tokenNew()}>
                Add credential
              </Button>
            ) : (
              <AskSomeone permission="tokens:write" ctx={ctx} verb="add a credential" />
            )
          }
        />
      ),
    );
  }
  const model = await buildFormModel(c, data, seed, null);
  const fixedToken =
    seed.tokenView === 'fixed' ? data.tokens.find((token) => token.id === seed.tokenId) : undefined;
  const request = options.request;
  let header: Child = plainHeader;
  let entry: FormEntry = { cancelHref: paths.accessRules(), cancelLabel: 'Cancel' };
  if (request) {
    header = (
      <PageHeader
        crumbs={[
          { label: 'Requests', href: paths.requests() },
          { label: `${request.id.slice(0, 12)}…`, href: paths.request(request.id) },
          { label: 'Give access' },
        ]}
        title={`Allow this call from ${request.repository ?? 'this caller'}`}
        description="Creates a credential access rule that lets exactly this caller make exactly this call."
      />
    );
    entry = { cancelHref: paths.request(request.id), cancelLabel: 'Back to the request', request };
  } else if (fixedToken) {
    header = (
      <PageHeader
        crumbs={[
          { label: 'Credentials', href: paths.tokens() },
          { label: fixedToken.name, href: paths.token(fixedToken.id) },
          { label: 'Add credential access rule' },
        ]}
        title={`Add credential access rule to ${fixedToken.name}`}
        description={`Choose which jobs can call ${fixedToken.name} and what they may do. Everything is preset; change only what differs.`}
      />
    );
    entry = { cancelHref: paths.token(fixedToken.id), cancelLabel: 'Cancel' };
  }
  model.entry = entry;
  return renderPage(
    c,
    {
      title: 'Add credential access rule',
      section: 'credentials',
      subsection: 'access-rules',
      errors: seed.errors,
      errorSummary:
        seed.errors.length > 0 ? { title: 'The credential access rule was not saved' } : undefined,
      status: options.status ?? 200,
      notice: seed.errors.length > 0 ? null : (options.notice ?? null),
      header,
    },
    () => (
      <>
        {options.banner ?? null}
        <RuleForm model={model} />
      </>
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// GET /admin/credential-access-rules/new

async function newPage(c: AdminContext) {
  const data = await loadFormData(c);
  const query = (name: string) => c.req.query(name) ?? '';
  const fromRequest = query('from_request');
  if (fromRequest) return prefillFromRequest(c, data, fromRequest);
  const explicitToken = query('credential');
  let tokenId = explicitToken;
  const type = (ISSUER_TYPES as readonly string[]).includes(query('type'))
    ? (query('type') as ProfileId)
    : null;
  const seed: FormSeed = {
    fields: null,
    tokenId: '',
    tokenView: 'auto',
    issuer: blankIssuerForm(type),
    errors: [],
    ack: null,
  };
  let banner: Child | null = null;
  const copyId = query('copy');
  if (copyId) {
    const source = data.connections.rules.find((edge) => edge.rule.id === copyId)?.rule;
    const profile = source ? getProfile(source.profile) : null;
    if (source && profile) {
      const labels = data.connections.labels.filter((label) => label.access_rule_id === source.id);
      tokenId = tokenId || source.credential_id;
      seed.hidden = { copy: source.id };
      seed.issuer = issuerFormFromRule(source, labels);
      seed.labels = labels;
      seed.jobs = jobsFormFromRule(source, profile, labels);
      seed.settings = settingsOf(source);
      seed.details = { name: '', description: source.description };
      const target = data.tokens.find((token) => token.id === tokenId);
      const from = data.tokens.find((token) => token.id === source.credential_id);
      if (target && from && sameOperationSource(target, from)) {
        const sets = ruleSetsOf(await credentialRuleShapes(c.get('deps').env.DB, target.id));
        seed.ops = opsFormFromRules(
          source.rules,
          templateForService(target),
          sets,
          repositoryLabelOf(source, labels, profile),
        );
      }
      banner = (
        <Callout title={<>Copied the values of “{source.name}”.</>}>
          Change what differs, then save.
        </Callout>
      );
    } else {
      banner = (
        <Callout tone="warn" title="That access rule no longer exists; nothing was copied." />
      );
    }
  }
  seed.tokenId = data.tokens.some((token) => token.id === tokenId)
    ? tokenId
    : data.tokens.length === 1
      ? (data.tokens[0]?.id ?? '')
      : '';
  seed.tokenView = data.tokens.some((token) => token.id === explicitToken) ? 'fixed' : 'auto';
  // Prefilled risky values need an explicit acknowledgement on this render (A7.7 rule 4).
  if (copyId && seed.jobs) seed.ack = await prefillAck(c, data, seed);
  return renderForm(c, data, seed, {
    ...(banner ? { banner } : {}),
    notice: notice(c, { rule: null }),
  });
}

function repositoryLabelOf(
  rule: Pick<CredentialAccessRule, 'conditions'>,
  labels: readonly ClaimLabel[],
  profile: Pick<IssuerProfile, 'id'>,
): string | null {
  const claims = anchorClaims(profile);
  if (claims === null) return null;
  const id = rule.conditions.find(
    (c) => c?.claim === claims.repository && c.match === 'exact' && c.negate !== true,
  )?.values[0];
  return id === undefined ? null : labelFor(labels, claims.repository, id);
}

/** Copying keeps the operations when the target credential has the same operation source. */
function sameOperationSource(target: Service, source: Service): boolean {
  if (target.id === source.id) return true;
  const a = templateForService(target);
  const b = templateForService(source);
  return a !== null && b !== null && a.id === b.id;
}

/** The acknowledgement a prefilled form needs on its first render, or null. */
async function prefillAck(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
): Promise<FormSeed['ack']> {
  const blank = { ...seed, fields: null };
  return ackOf(await prefilledRisks(c, data, blank, await evaluateForm(c, data, blank, null)));
}

/**
 * The risks of a prefilled (or re-rendered) form, also when its repository or tenant does not parse
 * yet: no stored name, or an organization still to add. Anchors never change the risks (the
 * warnings name refs, environments, events and methods only), so a placeholder organization and
 * repository stand in, and the digest is the one the form has once they parse (A7.7 rule 4).
 */
async function prefilledRisks(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
  evaluation: Evaluation,
): Promise<Risks | null> {
  if (evaluation.ok) return evaluation.risks;
  if (evaluation.risks) return evaluation.risks;
  const stand = placeholderSeed(seed);
  if (!stand) return null;
  const again = await evaluateForm(c, data, stand, null);
  return again.ok ? again.risks : (again.risks ?? null);
}

/**
 * The seed with placeholder names: the tenant IDs stay (rows may name them), a structured
 * repository becomes a placeholder. Null for an issuer type without anchors.
 */
function placeholderSeed(seed: FormSeed): FormSeed | null {
  const form = issuerFormOf(seed);
  const type = form.type as ProfileId;
  const profile = PROFILES[type];
  const prefix = `new.${type}.`;
  if (anchorClaims(profile) === null) return null;
  const jobs = seed.fields ? readJobsForm(seed.fields, prefix, profile) : seed.jobs;
  if (!jobs) return null;
  const orgs = placeholderTenants(form.github_org);
  const groups = placeholderTenants(form.gitlab_group);
  const teams = placeholderTenants(form.vercel_team, true);
  const ownerId = (type === 'gitlab-ci' ? groups : type === 'vercel' ? teams : orgs).ids[0] ?? '1';
  const structured = jobs.editor === 'structured';
  const repository =
    structured && jobs.repository.trim() !== ''
      ? type === 'vercel'
        ? 'placeholder (prj_2)'
        : 'placeholder/repository (2)'
      : jobs.repository;
  const owner = structured ? { new_owner: '', owner_id: ownerId } : {};
  if (seed.fields) {
    return {
      ...seed,
      fields: {
        ...seed.fields,
        'new.github_org': orgs.text,
        'new.github_enterprise_slug': '',
        'new.github_enterprise_id': '',
        'new.gitlab_group': groups.text,
        'new.vercel_team': teams.text,
        [`${prefix}repository`]: repository,
        ...(structured ? { [`${prefix}new_owner`]: '', [`${prefix}owner_id`]: ownerId } : {}),
      },
    };
  }
  return {
    ...seed,
    issuer: {
      ...form,
      github_org: orgs.text,
      github_enterprise_slug: '',
      github_enterprise_id: '',
      gitlab_group: groups.text,
      vercel_team: teams.text,
    },
    jobs: { ...jobs, repository, ...owner },
  };
}

/**
 * The IDs of a tenant field ("4242, acme (5)") as the `name (ID)` list it needs. Vercel team IDs
 * are `team_…`.
 */
function placeholderTenants(raw: string, vercel = false): { ids: string[]; text: string } {
  const shape = vercel ? /^team_[A-Za-z0-9]{1,64}$/ : /^\d+$/;
  const typed = raw
    .split(',')
    .map((item) => /\(([A-Za-z0-9_]+)\)\s*$/.exec(item)?.[1] ?? item.trim())
    .filter((id) => shape.test(id));
  const ids = typed.length > 0 ? typed : [vercel ? 'team_1' : '1'];
  return { ids, text: ids.map((id) => `placeholder (${id})`).join(', ') };
}

function ackOf(risks: Risks | null): FormSeed['ack'] {
  if (!risks || risks.messages.length === 0) return null;
  return { digest: risks.digest, warnings: risks.messages };
}

/** `?from_request=`: a rule matching exactly the caller of a denied, verified request. */
async function prefillFromRequest(c: AdminContext, data: FormData, requestId: string) {
  const deps = c.get('deps');
  const record = await getRequest(deps.env.TELEMETRY_DB, requestId);
  const claims = record ? parseJson(record.caller_claims) : null;
  const source = record?.credential_access_rule_id
    ? data.connections.rules.find((edge) => edge.rule.id === record.credential_access_rule_id)?.rule
    : undefined;
  const token = record?.service_id
    ? data.tokens.find((t) => t.id === record.service_id)
    : undefined;
  const profile = source ? getProfile(source.profile) : null;
  const usable =
    record !== null &&
    record.claims_verified === 1 &&
    accessFixable(record.reason) &&
    isRecord(claims) &&
    source !== undefined &&
    token !== undefined &&
    profile !== null;
  if (!usable || !record || !isRecord(claims) || !source || !token || !profile) {
    return renderPage(
      c,
      {
        title: 'Cannot give access from this request',
        section: 'credentials',
        subsection: 'access-rules',
        status: 400,
        errors: [
          {
            field: null,
            message:
              'This request cannot prefill the form. Only requests that were denied with “no matching rule” or “event not trusted”, whose token was verified, and whose credential access rule and credential still exist can.',
          },
        ],
      },
      () => (
        <p>
          <Button href={paths.accessRuleNew()}>Add credential access rule from scratch</Button>
        </p>
      ),
    );
  }
  const labels = data.connections.labels.filter((label) => label.access_rule_id === source.id);
  const jobs = jobsFromClaims(profile, source, claims, record.reason);
  const template = templateForService(token);
  const sets = ruleSetsOf(await credentialRuleShapes(deps.env.DB, token.id));
  const repositoryLabel = claimText(
    claims,
    profile.id === 'gitlab-ci' ? 'project_path' : 'repository',
  );
  const ops = opsFromCall(record.method, record.path, template, sets, repositoryLabel);
  const literalPath = !/\*|%2f/i.test(record.path);
  const seed: FormSeed = {
    fields: null,
    // The rule's issuer and settings verified this caller; the credential is the request's.
    tokenId: token.id,
    tokenView: 'fixed',
    issuer: issuerFormFromRule(source, labels),
    labels,
    jobs,
    ops,
    settings: settingsOf(source),
    errors: [],
    ack: null,
    hidden: { from_request: record.id },
  };
  seed.ack = await prefillAck(c, data, seed);
  const ref = claimText(claims, 'ref');
  return renderForm(c, data, seed, {
    request: {
      id: record.id,
      ts: record.ts,
      method: record.method,
      path: record.path,
      status: record.status,
      reason: reasonText(record.reason) ?? 'Denied',
      repository: repositoryLabel,
      ref: ref ? ref.replace(/^refs\/(heads|tags)\//, '') : null,
    },
    banner: (
      <Callout
        title={
          <>
            Prefilled from request <Mono>{record.id.slice(0, 12)}…</Mono>:
          </>
        }
        actions={
          <Button size="sm" href={paths.request(record.id)}>
            Open the request
          </Button>
        }
      >
        these values match exactly that caller and call. Change what you need, then save.
        {ops.op.length === 0 && ops.rule.length === 0
          ? literalPath
            ? ''
            : ' No operation was prefilled: the path contains "*" or "%2F", which an operation cannot match literally ("*" is a wildcard; "%2F" needs "**"). Add the narrowest one under Other operations.'
          : ''}
      </Callout>
    ),
  });
}

/** Structured "Which jobs" values from a verified request's claims, or rows for other events. */
function jobsFromClaims(
  profile: IssuerProfile,
  rule: CredentialAccessRule,
  claims: Record<string, unknown>,
  reason: string | null,
): JobsForm {
  const jobs = blankJobsForm(profile);
  const claim = (name: string) => claimText(claims, name);
  const event = profile.eventClaim ? claim(profile.eventClaim) : null;
  const rowsForEvent =
    reason === 'event_not_trusted' &&
    profile.id !== 'vercel' &&
    !(profile.id === 'github-actions' && event === 'pull_request');
  if (profile.id === 'generic' || rowsForEvent) {
    return { ...jobs, editor: 'rows', cond: condRows(prefillConditions(profile, rule, claims)) };
  }
  if (profile.id === 'vercel') {
    // The structured environment covers development too: the save asks to accept that opt-in.
    const project = claim('project');
    const projectId = claim('project_id');
    if (project && projectId) jobs.repository = `${project} (${projectId})`;
    const owner = claim('owner_id');
    if (owner) jobs.owner_id = owner;
    jobs.context = 'environment';
    jobs.environment = claim('environment') ?? 'production';
    return jobs;
  }
  const gitlab = profile.id === 'gitlab-ci';
  const repository = claim(gitlab ? 'project_path' : 'repository');
  const repositoryId = claim(gitlab ? 'project_id' : 'repository_id');
  if (repository && repositoryId) jobs.repository = `${repository} (${repositoryId})`;
  const owner = claim(gitlab ? 'namespace_id' : 'repository_owner_id');
  if (owner) jobs.owner_id = owner;
  const ref = claim('ref') ?? '';
  const environment = claim('environment');
  const refType = claim('ref_type');
  jobs.ref_protection = claim('ref_protected') === 'true' ? 'protected' : 'unprotected';
  if (environment) {
    jobs.context = 'environment';
    jobs.environment = environment;
  } else if (!gitlab && event === 'pull_request') {
    jobs.context = 'pull_request';
    jobs.pr_base = claim('base_ref') ?? '';
  } else if (refType === 'tag' || ref.startsWith('refs/tags/')) {
    const name = ref.replace(/^refs\/tags\//, '');
    if (!gitlab && event === 'release') {
      jobs.context = 'release';
      jobs.release_tag = name;
    } else {
      jobs.context = 'tag';
      jobs.tag = name;
    }
  } else {
    jobs.context = 'branch';
    jobs.branch = ref.replace(/^refs\/heads\//, '');
  }
  return jobs;
}

/** Claims copied from a request record besides the anchors, per profile. */
const PREFILL_EXTRA_CLAIMS: Record<string, string[]> = {
  'github-actions': ['ref', 'event_name', 'environment'],
  'gitlab-ci': ['ref', 'pipeline_source', 'environment'],
  vercel: ['environment'],
  generic: [],
};

/** Exact conditions on the first anchor rule the stored claims satisfy, plus ref/event/environment. */
function prefillConditions(
  profile: IssuerProfile,
  rule: CredentialAccessRule,
  claims: Record<string, unknown>,
): Condition[] {
  const anchorRules = profile.anchorRules(rule);
  const anchors =
    anchorRules.find((anchor) => anchor.every((claim) => claimText(claims, claim) !== null)) ??
    anchorRules[0] ??
    [];
  const conditions: Condition[] = [];
  for (const claim of [...anchors, ...(PREFILL_EXTRA_CLAIMS[profile.id] ?? [])]) {
    const value = claimText(claims, claim);
    if (value !== null && !conditions.some((c) => c.claim === claim)) {
      conditions.push({ claim, match: 'exact', values: [value] });
    }
  }
  return conditions;
}

/** The operation of a call as a preset, a rule set, or one custom row (never a wildcard path). */
function opsFromCall(
  method: string,
  path: string,
  template: ReturnType<typeof templateForService>,
  sets: ReturnType<typeof ruleSetsOf>,
  repositoryLabel: string | null,
): OpsForm {
  // Rule paths have no escape syntax: "*" would become a wildcard and "%2F" is matched only
  // through "**" (src/policy/limits.ts). Neither gets a prefilled operation.
  if (/\*|%2f/i.test(path)) return { op: [], rule: [] };
  // A preset or rule set is chosen only when one of its rules is exactly the call.
  const matchesCall = (rule: Rule) =>
    rule.path === path &&
    (rule.methods.includes('*') || rule.methods.includes(method as Rule['methods'][number]));
  for (const preset of template?.operation_presets ?? []) {
    const rules = preset.rules.map((rule) => ({
      ...rule,
      path: rule.path.replaceAll('{repo}', repositoryLabel ?? '\u0000'),
    }));
    if (rules.some(matchesCall)) return { op: [preset.id], rule: [] };
  }
  for (const set of sets) {
    if (set.rules.some(matchesCall)) return { op: [set.id], rule: [] };
  }
  return { op: [], rule: [{ m: [method], path }] };
}

// ---------------------------------------------------------------------------------------------
// Evaluating a submitted (or prefilled) form

interface Risks {
  codes: WarningCode[];
  messages: string[];
  digest: string;
}

type Evaluation =
  | {
      ok: true;
      input: CredentialRuleInput;
      profile: IssuerProfile;
      token: Service;
      jobs: JobsForm;
      prefix: string;
      risks: Risks;
      covered: Set<WarningCode>;
      global: NonNullable<RuleFormModel['global']>;
    }
  | {
      ok: false;
      errors: FieldError[];
      unknownOwner: string | null;
      refresh?: boolean;
      /** The risks of the values that did parse, for a prefilled form's acknowledgement. */
      risks?: Risks | null;
    };

async function evaluateForm(
  c: AdminContext,
  data: FormData,
  seed: FormSeed,
  editing: CredentialAccessRule | null,
): Promise<Evaluation> {
  const deps = c.get('deps');
  const errors: FieldError[] = [];
  const fields = seed.fields;
  const form = issuerFormOf(seed);
  if (editing) form.type = editing.profile;
  const parsedIssuer = parseIssuerForm(form, 'new.');
  if (!parsedIssuer.ok) errors.push(...parsedIssuer.errors);
  const tokenId = editing ? editing.credential_id : seed.tokenId;
  const token = data.tokens.find((item) => item.id === tokenId) ?? null;
  if (!token) errors.push({ field: 'token_id', message: 'Choose a credential.' });
  const type = (ISSUER_TYPES.find((id) => id === form.type) ?? 'github-actions') as ProfileId;
  const profile = PROFILES[type];
  const tokenFixed = editing !== null || data.tokens.length === 1 || seed.tokenView === 'fixed';
  if (!token) return { ok: false, errors, unknownOwner: null };
  const opsPrefix = tokenFixed ? '' : `${token.id}.`;
  const tokenSelect = !tokenFixed && data.tokens.length > MAX_CARDS;
  if (fields && tokenSelect && fields[`${opsPrefix}ops`] === undefined) {
    return { ok: false, errors: [], unknownOwner: null, refresh: true };
  }
  const input = parsedIssuer.ok ? parsedIssuer.input : null;
  const rule = pendingRule(input, type, editing);
  const stored = [
    ...(seed.labels ?? []),
    ...credentialLabels(data.connections, token.id, type),
    ...(editing
      ? data.connections.labels.filter((label) => label.access_rule_id === editing.id)
      : []),
  ];
  const labels = pendingLabels(input, stored);
  const jobsPrefix = `new.${type}.`;
  const jobs = fields
    ? readJobsForm(fields, jobsPrefix, profile)
    : (seed.jobs ?? blankJobsForm(profile));
  const parsedJobs = parseJobs(jobs, { profile, provider: rule, labels, prefix: jobsPrefix });
  const sets = ruleSetsOf(await credentialRuleShapes(deps.env.DB, token.id));
  const template = templateForService(token);
  const ops = fields
    ? readOpsForm(fields, opsPrefix)
    : (seed.ops ?? defaultOpsForm(template, sets));
  const parsedOps = parseOps(ops, {
    token,
    template,
    ruleSets: sets,
    repositoryLabel: parsedJobs.repository?.label ?? null,
    prefix: opsPrefix,
  });
  const expiry = parseExpiry(
    fields ? readExpiryForm(fields) : (seed.expiry ?? { expires: 'never', expires_on: '' }),
    deps.now(),
    editing ? editing.expires_at : undefined,
  );
  const settings = fields ? readSettings(fields) : (seed.settings ?? BLANK_SETTINGS);
  const parsedSettings = parseSettings(settings);
  errors.push(...parsedJobs.errors, ...parsedOps.errors, ...parsedSettings.errors);
  if (!expiry.ok) errors.push(expiry.error);
  if (
    errors.length > 0 ||
    !input ||
    !parsedJobs.conditions ||
    !parsedOps.rules ||
    !expiry.ok ||
    parsedSettings.values === null
  ) {
    return { ok: false, errors, unknownOwner: parsedJobs.unknownOwner };
  }

  const details = fields
    ? { name: text(fields, 'name'), description: text(fields, 'description') }
    : (seed.details ?? { name: '', description: '' });
  // The typed repository name is not stored yet: derive the name with it on top.
  const derived = deriveAccessName(
    token.name,
    parsedJobs.conditions,
    withTypedLabels(labels, editing?.id ?? '', parsedJobs.labels),
  );
  let name = details.name.trim();
  if (!editing && name === '') name = derived;
  else if (editing && name === '') {
    errors.push({ field: 'name', message: 'Enter a name.' });
    return { ok: false, errors, unknownOwner: null };
  }
  const pin = issuerPin(input);
  const values = parsedSettings.values;
  const sibling = [...data.connections.rules]
    .reverse()
    .find(
      (edge) =>
        edge.rule.credential_id === token.id &&
        edge.rule.issuer_key === issuerKey(input.issuer) &&
        edge.rule.id !== editing?.id,
    )?.rule;
  const ruleInput: CredentialRuleInput = {
    credential_id: token.id,
    name,
    description: details.description,
    profile: type,
    issuer: input.issuer,
    ...(values.audience ? { audience: values.audience } : {}),
    ...(values.jwks_uri ? { jwks_uri: values.jwks_uri } : {}),
    ...(values.allowed_algs ? { allowed_algs: values.allowed_algs } : {}),
    ...(values.max_token_age_seconds !== null
      ? { max_token_age_seconds: values.max_token_age_seconds }
      : {}),
    tenant_pin: pin.tenant_pin,
    anchor_claims: type === 'generic' ? (input.anchor_claims ?? ['sub']) : [],
    conditions: parsedJobs.conditions,
    rules: parsedOps.rules,
    expires_at: expiry.value,
    labels: [...pin.labels, ...parsedJobs.labels],
  };
  // Validate the row the op will store: stored settings on edit, the sibling's or placeholder
  // settings on create (the op derives them the same way, after discovery).
  const draft: CredentialAccessRule = {
    ...rule,
    name,
    description: details.description,
    issuer: input.issuer,
    issuer_key: issuerKey(input.issuer),
    audience:
      values.audience ||
      editing?.audience ||
      sibling?.audience ||
      'tokengate:pending-rule-audience',
    jwks_uri:
      values.jwks_uri ||
      (editing && editing.issuer === input.issuer ? editing.jwks_uri : null) ||
      (sibling?.issuer === input.issuer ? sibling.jwks_uri : null) ||
      input.issuer,
    allowed_algs: values.allowed_algs ??
      editing?.allowed_algs ??
      sibling?.allowed_algs ?? [...profile.defaults.allowedAlgs],
    max_token_age_seconds:
      values.max_token_age_seconds ??
      editing?.max_token_age_seconds ??
      sibling?.max_token_age_seconds ??
      profile.defaults.maxTokenAgeSeconds,
    tenant_pin: pin.tenant_pin,
    anchor_claims: ruleInput.anchor_claims ?? [],
    conditions: parsedJobs.conditions,
    rules: parsedOps.rules,
  };
  const others = data.connections.rules
    .filter((edge) => edge.rule.credential_id === token.id)
    .map((edge) => edge.rule);
  const validation = validateCredentialAccessRule(draft, profile, editing, {
    injection: token.injection,
    rules: others,
  });
  const details_ = accessWarningDetails(
    validation.warningDetails.filter((d) => d.code !== 'no_tenant_pin') as WarningDetail[],
    parsedJobs.conditions,
    profile,
  );
  const risks = await risksOf(details_, parsedJobs.risks, parsedJobs.presetWarnings);
  if (validation.errors.length > 0) {
    return {
      ok: false,
      errors: validation.errors.map((message) => ({
        field: ruleErrorField(message, jobs, jobsPrefix, form),
        message: ruleErrorMessage(message),
      })),
      unknownOwner: parsedJobs.unknownOwner,
      risks,
    };
  }
  const globals = await listGlobalAccessRules(deps.env.DB, { issuer_key: draft.issuer_key });
  return {
    ok: true,
    input: ruleInput,
    profile,
    token,
    jobs,
    prefix: jobsPrefix,
    risks,
    covered: coveredRiskCodes(jobs),
    global: { status: globalStatus(draft, globals, deps.now()), issuer: draft.issuer_key },
  };
}

/** The "Token settings" values; empty fields keep the derived (create) or stored (edit) value. */
function parseSettings(settings: TokenSettingsForm): {
  values: {
    audience: string;
    jwks_uri: string;
    allowed_algs: string[] | null;
    max_token_age_seconds: number | null;
  } | null;
  errors: FieldError[];
} {
  const errors: FieldError[] = [];
  const age = settings.max_token_age_seconds.trim();
  let maxAge: number | null = null;
  if (age !== '') {
    if (!/^[0-9]{1,7}$/.test(age)) {
      errors.push({
        field: 'max_token_age_seconds',
        message: 'Enter the maximum token age in whole seconds, like 300.',
      });
    } else maxAge = Number(age);
  }
  return {
    values:
      errors.length > 0
        ? null
        : {
            audience: settings.audience.trim(),
            jwks_uri: settings.jwks_uri.trim(),
            allowed_algs: settings.allowed_algs.length > 0 ? settings.allowed_algs : null,
            max_token_age_seconds: maxAge,
          },
    errors,
  };
}

/** The risks of a result: the validator's warnings plus the builder's own risk choices. */
async function risksOf(
  details: readonly WarningDetail[],
  presetRisks: readonly string[],
  presetWarnings: readonly string[],
): Promise<Risks> {
  const codes = new Set<WarningCode>(details.map((detail) => detail.code));
  const messages = details.map((detail) => detail.message);
  presetRisks.forEach((risk, index) => {
    if (codes.has(risk as WarningCode)) return;
    codes.add(risk as WarningCode);
    const message = presetWarnings[index];
    if (message) messages.push(message);
  });
  const sorted = [...messages].sort();
  return { codes: [...codes].sort(), messages, digest: await sha256Hex(JSON.stringify(sorted)) };
}

/** The input a validator or op error belongs to. */
function ruleErrorField(
  message: string,
  jobs: JobsForm,
  prefix: string,
  form: IssuerForm,
): string | null {
  const lower = message.toLowerCase();
  if (lower.startsWith('audience')) return 'audience';
  if (lower.startsWith('jwks uri')) return 'jwks_uri';
  if (lower.includes('signing algorithm')) return 'allowed_algs';
  if (lower.includes('maximum token age')) return 'max_token_age_seconds';
  if (lower.startsWith('name')) return 'name';
  if (lower.startsWith('description')) return 'description';
  if (
    lower.includes('jwks uri and audience pairs') ||
    lower.includes('token verification settings')
  ) {
    return 'audience';
  }
  if (
    lower.startsWith('issuer') ||
    lower.startsWith('write the issuer') ||
    lower.includes('discovery') ||
    lower.includes('issuers on')
  ) {
    if (form.type === 'generic') return 'new.generic_issuer';
    if (form.type === 'gitlab-ci') return 'new.gitlab_url';
    if (form.type === 'vercel') return 'new.vercel_team';
    return 'new.github_enterprise_slug';
  }
  if (lower.includes('tenant pin') && !lower.includes('outside')) {
    if (form.type === 'generic') return 'new.generic_pin_claim';
    if (form.type === 'vercel') return 'new.vercel_team';
    return form.type === 'gitlab-ci' ? 'new.gitlab_group' : 'new.github_org';
  }
  if (lower.includes('anchor claim')) return 'new.generic_anchor_claims';
  if (message.includes('I-AUTHZ-2') || lower.includes('outside the tenant pin')) {
    return jobs.editor === 'rows' ? `${prefix}cond.0.values` : `${prefix}repository`;
  }
  if (lower.startsWith('expiry')) return 'expires_on';
  if (lower.startsWith('condition'))
    return jobs.editor === 'rows' ? `${prefix}cond.0.values` : null;
  return null;
}

function ruleErrorMessage(message: string): string {
  if (message.includes('I-AUTHZ-2')) {
    return `Each access rule needs exact, non-negated conditions on its anchor claims: ${message.replace(/^the access rule must have /, '')}`;
  }
  if (message.includes('outside the tenant pin of this access rule')) {
    return `${message.replace('are outside the tenant pin of this access rule', 'are not organizations or groups of this rule')}. Add them under Issuer and tenant first.`;
  }
  if (message.startsWith('JWKS discovery failed')) {
    return `The gateway could not read the issuer's OpenID configuration (${message.slice(23)}). Check the issuer and save again.`;
  }
  return message;
}

/**
 * A form prefilled from a copy or a request (its hidden marker): every save of it goes through the
 * digest and the box while it has risks, so a prefilled selection never accepts one.
 */
function isPrefilled(fields: Fields): boolean {
  return text(fields, 'copy') !== '' || text(fields, 'from_request') !== '';
}

/**
 * A7.7: is the risk set of this result accepted by the selection or by the digest and the box? A
 * prefilled form's selection was not made by the admin, so it covers nothing (rule 4).
 */
async function acceptance(
  fields: Fields,
  evaluation: Extract<Evaluation, { ok: true }>,
): Promise<
  { ok: true } | { ok: false; error: FieldError; ack: { digest: string; warnings: string[] } }
> {
  const { risks } = evaluation;
  const covered = isPrefilled(fields) ? new Set<WarningCode>() : evaluation.covered;
  const ack = { digest: risks.digest, warnings: risks.messages };
  const submittedDigest = text(fields, 'warnings_digest');
  if (submittedDigest !== '') {
    if (submittedDigest !== risks.digest) {
      if (risks.codes.length === 0) return { ok: true };
      return {
        ok: false,
        ack,
        error: {
          field: 'acknowledge_warnings',
          message: 'The risks changed: review them and tick the box again.',
        },
      };
    }
    if (risks.codes.length > 0 && !flag(fields, 'acknowledge_warnings')) {
      return {
        ok: false,
        ack,
        error: { field: 'acknowledge_warnings', message: 'Tick the box to accept these risks.' },
      };
    }
    return { ok: true };
  }
  const uncovered = risks.codes.filter((code) => !covered.has(code));
  if (uncovered.length > 0) {
    return {
      ok: false,
      ack,
      error: {
        field: 'acknowledge_warnings',
        message: 'Review these risks and tick the box to accept them.',
      },
    };
  }
  return { ok: true };
}

/** Op failures as form errors, each on its field when it has one. */
function opErrors(
  failure: OpFailure,
  jobs: JobsForm,
  prefix: string,
  form: IssuerForm,
): FieldError[] {
  return failure.errors.map((message) => ({
    field: ruleErrorField(message, jobs, prefix, form),
    message: ruleErrorMessage(message),
  }));
}

// ---------------------------------------------------------------------------------------------
// POST /admin/credential-access-rules

function seedFromFields(fields: Fields): FormSeed {
  return {
    fields,
    tokenId: text(fields, 'token_id'),
    tokenView: text(fields, 'token_view') === 'fixed' ? 'fixed' : 'auto',
    errors: [],
    ack: null,
    // The prefill marker stays on every re-render of the form.
    hidden: Object.fromEntries(
      (['copy', 'from_request'] as const)
        .map((name) => [name, text(fields, name).slice(0, 100)])
        .filter(([, value]) => value !== ''),
    ),
  };
}

const SUB_ACTIONS = ['rows', 'add:rule', 'refresh'];

function subAction(action: string): boolean {
  return SUB_ACTIONS.includes(action) || /^add:new\.[a-z-]+\.cond$/.test(action);
}

async function create(c: AdminContext) {
  const deps = c.get('deps');
  const fields = await formData(c);
  const data = await loadFormData(c);
  const seed = seedFromFields(fields);
  const action = text(fields, '_action');
  if (subAction(action)) return renderForm(c, data, { ...seed, action });

  const evaluation = await evaluateForm(c, data, seed, null);
  if (!evaluation.ok) {
    if (evaluation.refresh) return renderForm(c, data, { ...seed, action: 'refresh' });
    // A prefilled form keeps showing the risks it carries while another input is fixed.
    const ack = isPrefilled(fields) ? ackOf(await prefilledRisks(c, data, seed, evaluation)) : null;
    return renderForm(
      c,
      data,
      { ...seed, errors: evaluation.errors, unknownOwner: evaluation.unknownOwner, ack },
      { status: 422 },
    );
  }
  const accepted = await acceptance(fields, evaluation);
  if (!accepted.ok) {
    return renderForm(
      c,
      data,
      { ...seed, errors: [accepted.error], ack: accepted.ack, global: evaluation.global },
      { status: 422 },
    );
  }
  const result = await createCredentialAccessRule(deps, adminActor(c), {
    ...evaluation.input,
    acknowledge_warnings: true,
    accepted_risks: evaluation.risks.codes,
  });
  if (result.ok) return redirectWithNotice(c, paths.accessRule(result.rule.id), 'created');
  return renderForm(
    c,
    data,
    {
      ...seed,
      errors: opErrors(result, evaluation.jobs, evaluation.prefix, issuerFormOf(seed)),
      global: evaluation.global,
    },
    { status: failureStatus(result) },
  );
}

function failureStatus(failure: OpFailure): 409 | 422 {
  return failure.reason === 'conflict' ? 409 : 422;
}

// ---------------------------------------------------------------------------------------------
// The rule page

async function loadRule(c: AdminContext, data?: FormData) {
  const formData_ = data ?? (await loadFormData(c));
  const id = c.req.param('id') ?? '';
  const edge = formData_.connections.rules.find((item) => item.rule.id === id);
  if (!edge) return null;
  const token = formData_.tokens.find((t) => t.id === edge.rule.credential_id);
  const profile = getProfile(edge.rule.profile);
  if (!token || !profile) return null;
  return { rule: edge.rule, token, profile, edge, data: formData_ };
}

type LoadedRule = NonNullable<Awaited<ReturnType<typeof loadRule>>>;

interface PageState {
  edit?: {
    fields: Fields | null;
    errors: FieldError[];
    ack: { digest: string; warnings: string[] } | null;
    action?: string;
    unknownOwner?: string | null;
    global?: RuleFormModel['global'];
  };
  tenant?: string;
  copy?: { credentialId: string; open: boolean };
  errors?: FieldError[];
  status?: 200 | 400 | 409 | 422;
}

async function detailPage(c: AdminContext) {
  const loaded = await loadRule(c);
  if (!loaded) return notFound(c);
  return renderRulePage(c, loaded, {
    edit: c.req.query('open') === 'edit' ? { fields: null, errors: [], ack: null } : undefined,
  });
}

async function renderRulePage(c: AdminContext, loaded: LoadedRule, state: PageState) {
  const { rule, token, profile, edge, data } = loaded;
  const deps = c.get('deps');
  const labels = data.connections.labels.filter((label) => label.access_rule_id === rule.id);
  const validation = validateCredentialAccessRule(rule, profile, rule, {
    injection: token.injection,
    rules: [],
  });
  const editing = state.edit;
  let edit: RuleFormModel | null = null;
  if (editing && c.get('viewer') && ctxCan(c, 'access:write')) {
    const template = templateForService(token);
    const sets = ruleSetsOf(await credentialRuleShapes(deps.env.DB, token.id));
    const seed: FormSeed = {
      fields: editing.fields,
      tokenId: token.id,
      tokenView: 'fixed',
      issuer: issuerFormFromRule(rule, labels),
      labels,
      jobs: editing.fields ? null : jobsFormFromRule(rule, profile, labels),
      ops: editing.fields
        ? null
        : opsFormFromRules(rule.rules, template, sets, repositoryLabelOf(rule, labels, profile)),
      // "Keep" exists only for a stored date; a rule that never expires starts on Never.
      expiry: { expires: rule.expires_at === null ? 'never' : 'keep', expires_on: '' },
      details: { name: rule.name, description: rule.description },
      settings: settingsOf(rule),
      errors: editing.errors,
      ack: editing.ack,
      action: editing.action,
      unknownOwner: editing.unknownOwner ?? null,
      global: editing.global ?? null,
    };
    edit = await buildFormModel(c, data, seed, rule);
    edit.entry = { cancelHref: paths.accessRule(rule.id), cancelLabel: 'Cancel' };
  }
  const globals = data.connections.globals.filter((g) => g.issuer_key === rule.issuer_key);
  const { history, acceptedBy } = await ruleHistory(c, rule.id);
  const model: CredentialRulePageModel = {
    rule,
    edge,
    profile,
    token,
    tokens: data.tokens,
    template: templateForService(token),
    labels,
    warningDetails: accessWarningDetails(
      validation.warningDetails.filter((d) => d.code !== 'no_tenant_pin') as WarningDetail[],
      rule.conditions,
      profile,
    ),
    globals: globals.map((global) => ({
      global,
      verdict: globalStatus(rule, [global], deps.now()).kind,
    })),
    origin: new URL(c.req.url).origin,
    requests30d: data.connections.usageAvailable
      ? (data.connections.usage.get(rule.id)?.requests ?? 0)
      : null,
    edit,
    editOpen: editing !== undefined,
    tenant: state.tenant ?? '',
    copy: {
      credentialId: state.copy?.credentialId ?? '',
      open: state.copy?.open ?? false,
    },
    history,
    acceptedBy,
    errors: [...(state.errors ?? []), ...(editing?.errors ?? [])],
  };
  const errors = model.errors;
  return renderPage(
    c,
    {
      title: rule.name,
      section: 'credentials',
      subsection: 'access-rules',
      errors,
      status: state.status ?? 200,
      notice: errors.length > 0 ? null : notice(c, { rule }),
      header: (ctx) => <CredentialRuleHeader model={model} ctx={ctx} />,
    },
    (ctx) => <CredentialRulePage model={model} ctx={ctx} />,
  );
}

function ctxCan(c: AdminContext, permission: 'access:write'): boolean {
  const authority = c.get('viewer');
  return authority !== undefined && can(authority.user.role, permission);
}

/** The rail history of a rule (newest audit rows) and who accepted its current risks. */
async function ruleHistory(
  c: AdminContext,
  ruleId: string,
): Promise<{ history: HistoryEntry[]; acceptedBy: CredentialRulePageModel['acceptedBy'] }> {
  const events = await listAuditEvents(c.get('deps').env.DB, { targetId: ruleId, limit: 20 });
  const actor = (event: (typeof events)[number]) =>
    event.actor_email ?? (event.actor_type === 'system' ? 'tokengate' : 'Someone');
  const accepted = events.find((event) => {
    const risks = event.diff?.accepted_risks;
    return Array.isArray(risks) && risks.length > 0;
  });
  return {
    history: events.slice(0, 3).map((event) => ({
      ts: event.ts,
      actor: actor(event),
      summary: `${actor(event)}: ${event.summary}`,
    })),
    acceptedBy: accepted ? { actor: actor(accepted), ts: accepted.ts } : null,
  };
}

async function update(c: AdminContext) {
  const deps = c.get('deps');
  const loaded = await loadRule(c);
  if (!loaded) return notFound(c);
  const { rule } = loaded;
  const fields = await formData(c);
  const version = submittedVersion(text(fields, 'expected_updated_at'));
  const action = text(fields, '_action');
  if (subAction(action)) {
    return renderRulePage(c, loaded, { edit: { fields, errors: [], ack: null, action } });
  }
  const seed: FormSeed = {
    fields,
    tokenId: rule.credential_id,
    tokenView: 'fixed',
    errors: [],
    ack: null,
  };
  const evaluation = await evaluateForm(c, loaded.data, seed, rule);
  if (!evaluation.ok) {
    return renderRulePage(c, loaded, {
      edit: { fields, errors: evaluation.errors, ack: null, unknownOwner: evaluation.unknownOwner },
      status: 422,
    });
  }
  const accepted = await acceptance(fields, evaluation);
  if (!accepted.ok) {
    return renderRulePage(c, loaded, {
      edit: { fields, errors: [accepted.error], ack: accepted.ack, global: evaluation.global },
      status: 422,
    });
  }
  const { credential_id: _credential, profile: _profile, audience, ...changes } = evaluation.input;
  const result = await updateCredentialAccessRule(deps, adminActor(c), rule.id, {
    ...changes,
    // An empty field keeps the stored setting; a changed issuer rediscovers its JWKS.
    ...(audience ? { audience } : {}),
    jwks_uri: changes.jwks_uri ?? null,
    acknowledge_warnings: true,
    accepted_risks: evaluation.risks.codes,
    ...(version === undefined ? {} : { expected_updated_at: version }),
  });
  if (result.ok) {
    return redirectWithNotice(
      c,
      paths.accessRule(rule.id),
      result.changed === false ? 'unchanged' : result.labelsChanged ? 'label_changed' : 'updated',
    );
  }
  if (result.reason === 'not_found') return notFound(c);
  const reloaded = (await loadRule(c)) ?? loaded;
  return renderRulePage(c, reloaded, {
    edit: {
      fields,
      errors: opErrors(result, evaluation.jobs, evaluation.prefix, issuerFormOf(seed)),
      ack: null,
      global: evaluation.global,
    },
    status: failureStatus(result),
  });
}

// ---------------------------------------------------------------------------------------------
// Tenants

async function tenants(c: AdminContext) {
  const loaded = await loadRule(c);
  if (!loaded) return notFound(c);
  const { rule, profile } = loaded;
  const fields = await formData(c);
  const claim = tenantClaimOf(rule.profile);
  const deps = c.get('deps');
  const actor = adminActor(c);
  const version = submittedVersion(text(fields, 'expected_updated_at'));
  const versioned = version === undefined ? {} : { expected_updated_at: version };
  if (claim === null) {
    return renderRulePage(c, loaded, {
      errors: [{ field: null, message: 'Change the pin of a generic rule with Change this rule.' }],
      status: 400,
    });
  }
  const intent = text(fields, 'intent');
  if (intent === 'remove') {
    const value = text(fields, 'remove');
    const labels = loaded.data.connections.labels.filter((l) => l.access_rule_id === rule.id);
    const label = labelFor(labels, claim, value);
    const result = await removeTenantValue(deps, actor, rule.id, {
      claim,
      value,
      ...(label ? { label: `${label} (${value})` } : {}),
      ...versioned,
    });
    if (result.ok) {
      return redirectWithNotice(
        c,
        paths.accessRule(rule.id, { hash: 'tenants' }),
        'tenant_removed',
      );
    }
    if (result.reason === 'not_found') return notFound(c);
    return renderRulePage(c, loaded, {
      errors: result.errors.map((message) => ({ field: null, message })),
      status: failureStatus(result),
    });
  }
  const raw = text(fields, 'tenant');
  const parsed = parseOwnerList(raw, profile);
  if (intent !== 'add' || !parsed.ok) {
    return renderRulePage(c, loaded, {
      errors: [{ field: 'tenant', message: parsed.ok ? 'Use the Add button.' : parsed.message }],
      tenant: raw,
      status: 422,
    });
  }
  const result = await addTenantValue(deps, actor, rule.id, {
    claim,
    entries: parsed.entries.map((entry) => ({ value: entry.id, label: entry.label })),
    ...versioned,
  });
  if (result.ok) {
    return redirectWithNotice(c, paths.accessRule(rule.id, { hash: 'tenants' }), 'tenant_added');
  }
  if (result.reason === 'not_found') return notFound(c);
  return renderRulePage(c, loaded, {
    errors: result.errors.map((message) => ({
      field: message.includes('already allowed') || message.includes('numeric') ? 'tenant' : null,
      message,
    })),
    tenant: raw,
    status: failureStatus(result),
  });
}

// ---------------------------------------------------------------------------------------------
// Copy, toggle and delete

async function copy(c: AdminContext) {
  const loaded = await loadRule(c);
  if (!loaded) return notFound(c);
  const fields = await formData(c);
  const credentialId = text(fields, 'credential_id');
  if (credentialId && !loaded.data.tokens.some((token) => token.id === credentialId)) {
    return renderRulePage(c, loaded, {
      copy: { credentialId, open: true },
      errors: [{ field: 'copy-credential_id', message: 'Choose a credential.' }],
      status: 422,
    });
  }
  // A copy that cannot work as it is opens the form with the copied values, writing nothing: the
  // target credential has other operations, or the source has expired.
  const target = loaded.data.tokens.find((token) => token.id === (credentialId || loaded.token.id));
  const expired = loaded.rule.expires_at !== null && loaded.rule.expires_at <= c.get('deps').now();
  const review =
    target && !sameOperationSource(target, loaded.token)
      ? 'copy_operations'
      : expired
        ? 'copy_expiry'
        : null;
  if (review) {
    return redirectWithNotice(
      c,
      paths.accessRuleNew({ copy: loaded.rule.id, credential: credentialId || undefined }),
      review,
    );
  }
  const result = await duplicateCredentialAccessRule(c.get('deps'), adminActor(c), loaded.rule.id, {
    credentialId,
  });
  if (result.ok) return redirectWithNotice(c, paths.accessRule(result.rule.id), 'copied');
  if (result.reason === 'not_found') return notFound(c);
  if (result.reason === 'acknowledgement_required') {
    // A copy to a credential that adds a risk opens the form with the copied values instead.
    return redirectWithNotice(
      c,
      paths.accessRuleNew({ copy: loaded.rule.id, credential: credentialId || undefined }),
      'copy_review',
    );
  }
  return renderRulePage(c, loaded, {
    copy: { credentialId, open: true },
    errors: result.errors.map((message) => ({ field: null, message: ruleErrorMessage(message) })),
    status: failureStatus(result),
  });
}

async function toggle(c: AdminContext) {
  const id = c.req.param('id') ?? '';
  const form = await formData(c);
  const enabled = flag(form, 'enabled');
  const result = await setCredentialAccessRuleEnabled(c.get('deps'), adminActor(c), id, enabled);
  if (result.ok) {
    const back = returnPath('POST /admin/credential-access-rules/:id/toggle', form._return, { id });
    return redirectWithNotice(c, back, enabled ? 'enabled' : 'disabled');
  }
  return rerenderDetail(c, result);
}

async function remove(c: AdminContext) {
  const fields = await formData(c);
  if (!flag(fields, 'confirm')) {
    const loaded = await loadRule(c);
    if (!loaded) return notFound(c);
    return renderRulePage(c, loaded, {
      errors: [{ field: null, message: 'Confirm the deletion in the Delete dialog.' }],
      status: 400,
    });
  }
  const result = await deleteCredentialAccessRule(
    c.get('deps'),
    adminActor(c),
    c.req.param('id') ?? '',
  );
  if (result.ok) return redirectWithNotice(c, paths.accessRules(), 'deleted');
  return rerenderDetail(c, result);
}

async function rerenderDetail(c: AdminContext, failure: OpFailure) {
  const loaded = await loadRule(c);
  if (!loaded || failure.reason === 'not_found') return notFound(c);
  return renderRulePage(c, loaded, {
    errors: failure.errors.map((message) => ({ field: null, message: ruleErrorMessage(message) })),
    status: failureStatus(failure),
  });
}

function notFound(c: AdminContext) {
  return renderPage(
    c,
    {
      title: 'Credential access rule not found',
      section: 'credentials',
      subsection: 'access-rules',
      status: 404,
      header: (
        <PageHeader
          crumbs={[
            { href: paths.accessRules(), label: 'Credential access rules' },
            { label: 'Not found' },
          ]}
          title="Credential access rule not found"
          description={notFoundText('rule')}
        />
      ),
    },
    () => <NotFound />,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Notice entries the form page understands from other pages (closed set). */
export const RULE_FORM_NOTICES: readonly string[] = Object.keys(NOTICES);
