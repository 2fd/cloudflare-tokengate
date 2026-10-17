// Admin pages: credential access rules (credential access rules, the CI systems whose jobs call the gateway).
// Every change goes through ops/credential-access-rules.ts (validation, tenant pin I-TEN-1, anchors
// I-AUTHZ-2, audit I-AUDIT-1). Adding a credential access rule asks only what cannot be derived (its
// organizations, groups or issuer); an issuer/JWKS change under enabled accesses needs the confirm
// checkbox; disabling never validates; deleting with accesses is one confirmed cascade.
import {
  ArrowRow,
  Button,
  Callout,
  Cell,
  Chip,
  Chips,
  DangerRow,
  DangerZone,
  DetailLayout,
  Dialog,
  DialogClose,
  DialogTrigger,
  Disclosure,
  EmptyState as UiEmptyState,
  Entity,
  formatTime,
  GroupRow,
  Identity,
  KeyValue,
  LiveForm,
  Mono,
  PageHeader,
  Panel,
  RailFoot,
  RailKeyValue,
  RelationLine,
  Row,
  RowHeader,
  SubmitRow,
  Table,
  Tray,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { labelFor, listClaimLabels } from '../../db/claim-labels';
import { getCredentialAccessRule } from '../../db/credential-access-rules';
import { listIssuerAccessRules } from '../../db/issuer_access_rules';
import type { CredentialAccessRule, ClaimLabel, IssuerAccessRule, Service } from '../../db/types';
import { getProfile } from '../../identity/profiles';
import { GITHUB_ACTIONS_ISSUER } from '../../identity/profiles/github-actions';
import { GITLAB_COM_ISSUER } from '../../identity/profiles/gitlab-ci';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import type { Condition } from '../../policy/types';
import { ALLOWED_ALGS, validateCredentialAccessRule } from '../../policy/validate';
import { loadUnknownIssuers, type UnknownIssuer } from '../access-traffic';
import { parseBoundaryFilters } from '../boundary-filters';
import { type AccessEdge, type Connections, loadConnections } from '../connections';
import {
  all,
  type Fields,
  flag,
  ownerFindCommand,
  parseOwnerList,
  text,
  withAnyRefFlags,
} from '../consumer-access';
import { formatConditions, formatValueList, parseValueList } from '../grant-text';
import { type NoticeContext, type NoticeTable, resolveNotice } from '../notice';
import {
  addTenantValue,
  type CredentialAccessRuleUpdateInput,
  createOrMergeConsumer,
  deleteCredentialAccessRule,
  grantsUsingPinValue,
  pinValues,
  removeTenantValue,
  setCredentialAccessRuleEnabled,
  tenantClaimOf,
  updateCredentialAccessRule,
} from '../ops/credential-access-rules';
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
  accessesText,
  consumerLogo,
  Breakable,
  busiestFirst,
  issuerHost,
  leadStatus,
  operationsText,
  StatusDot,
  tenantsText,
  tokenLogo,
} from '../views/access-visuals';
import {
  AddConsumerFields,
  blankConsumerForm,
  type ConsumerForm,
  GENERIC_PRESETS,
  genericAnchorSuggestions,
  parseConsumerForm,
  readConsumerForm,
  SetForYou,
} from '../views/add-consumer-fields';
import {
  ActionButton,
  AskSomeone,
  Checkbox,
  CheckboxGroup,
  type ConfirmDialogProps,
  ConfirmBox,
  ConfirmTrigger,
  Field,
  IdWithLabelField,
  NotFound,
  notFoundText,
  PostForm,
  Select,
  StatusBadge,
  VersionField,
} from '../views/components';
import { ConsumerSnippet } from '../views/consumer-snippet';
import { formatCount, lastUsedTime, relativeTime } from '../views/format';
import { LearnMore } from '../views/header';
import { anchorsOf } from '../views/matrix';
import { profileForIssuer } from '../views/monitoring';
import { RepeatingRows } from '../views/rows';
import { statusLabel } from '../views/status';

export function registerConsumersRoutes(app: App): void {
  app.get('/admin/credential-access-rules', listPage);
  app.get('/admin/credential-access-rules/new', newPage);
  app.post('/admin/credential-access-rules', create);
  app.get('/admin/credential-access-rules/:id', detailPage);
  app.post('/admin/credential-access-rules/:id', update);
  app.post('/admin/credential-access-rules/:id/tenants', tenants);
  app.post('/admin/credential-access-rules/:id/toggle', toggle);
  app.post('/admin/credential-access-rules/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Notices

interface ConsumerNoticeData {
  consumer: CredentialAccessRule | null;
}

const NOTICES: NoticeTable<NoticeContext & ConsumerNoticeData> = {
  created: () => ({
    text: 'Credential access rule created. Add the snippet below to your workflow, then create an issuer access rule for this credential.',
  }),
  tenant_added: ({ consumer }) => ({
    text: `${consumer?.name ?? 'The credential access rule'} can now be used by the added organizations or groups.`,
  }),
  tenant_removed: () => ({
    text: 'Removed from the credential access rule. Its tokens are refused from the next request on.',
  }),
  renamed: () => ({ text: 'Credential access rule renamed.' }),
  trust_saved: () => ({ text: 'Trust settings saved.' }),
  unchanged: () => ({ text: 'Nothing changed: the submitted values are the current ones.' }),
  label_changed: () => ({ text: 'Saved. A display name of an ID changed everywhere it is shown.' }),
  enabled: () => ({
    text: 'Credential access rule enabled. Its accesses work again from the next request on.',
  }),
  disabled: ({ consumer }) => ({
    text: 'Credential access rule disabled. Its jobs are refused from the next request on.',
    ...(consumer && !consumer.enabled
      ? {
          undo: {
            action: `${paths.consumer(consumer.id)}/toggle`,
            fields: { enabled: '1', _return: 'detail' },
            label: 'Enable again',
            srSuffix: consumer.name,
          },
        }
      : {}),
  }),
  deleted: () => ({ text: 'Credential access rule deleted.' }),
  deleted_with_accesses: () => ({
    text: 'Credential access rule and its issuer access rules deleted.',
  }),
};

function pageNotice(c: AdminContext, consumer: CredentialAccessRule | null) {
  return resolveNotice(NOTICES, c.req.query('notice'), null, { consumer });
}

// ---------------------------------------------------------------------------------------------
// Shared facts

/** "Organization", "Groups", the pin claims of a generic consumer, or null without a pin. */
function trustKind(consumer: CredentialAccessRule): string | null {
  const claim = tenantClaimOf(consumer.profile);
  if (claim === null) {
    return consumer.tenant_pin.length === 0
      ? null
      : `Tenant pin on ${consumer.tenant_pin.map((c) => c.claim).join(', ')}`;
  }
  const count = pinValues(consumer.tenant_pin, claim).length;
  if (count === 0) return null;
  const word = consumer.profile === 'gitlab-ci' ? 'Group' : 'Organization';
  return count === 1 ? word : `${word}s`;
}

/** "organization", "groups": the word for a credential access rule's pinned owners in a sentence. */
function ownerWord(consumer: CredentialAccessRule, count: number): string {
  const word = consumer.profile === 'gitlab-ci' ? 'group' : 'organization';
  return count === 1 ? word : `${word}s`;
}

function lastCall(
  edges: readonly AccessEdge[],
  connections: Pick<Connections, 'usageAvailable'>,
  now: number,
): string {
  if (!connections.usageAvailable) return 'Unknown';
  const hours = edges
    .map((edge) => edge.lastUsedHour)
    .filter((hour): hour is number => hour !== null);
  return hours.length === 0 ? 'None in 30 days' : lastUsedTime(Math.max(...hours), now);
}

function byConsumer(accesses: readonly AccessEdge[]): Map<string, AccessEdge[]> {
  const map = new Map<string, AccessEdge[]>();
  for (const edge of accesses) {
    const list = map.get(edge.grant.credential_access_rule_id) ?? [];
    list.push(edge);
    map.set(edge.grant.credential_access_rule_id, list);
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// List

async function listPage(c: AdminContext) {
  const deps = c.get('deps');
  const [connections, unknownIssuers] = await Promise.all([
    loadConnections(deps).then(withAnyRefFlags),
    loadUnknownIssuers(deps),
  ]);
  const { consumers, accesses } = connections;
  const tokenCount = new Set(accesses.map((edge) => edge.grant.service_id)).size;
  const description = (
    <>
      CI systems whose jobs call the gateway.
      {consumers.length === 0 ? null : accesses.length === 0 ? (
        ' None can use a token yet.'
      ) : (
        <>
          {' '}
          Together they can use{' '}
          <a href={paths.access()}>
            {tokenCount} {tokenCount === 1 ? 'token' : 'tokens'} through{' '}
            {accessesText(accesses.length)}
          </a>
          .
        </>
      )}
      <LearnMore path="concepts.md#credential-access-rule" about="credential access rules" />
    </>
  );
  return renderPage(
    c,
    {
      title: 'Credential access rules',
      section: 'consumers',
      subsection: 'consumers',
      notice: pageNotice(c, null),
      header: (ctx) => (
        <PageHeader
          title="Credential access rules"
          count={consumers.length}
          description={description}
          actions={
            ctx.can('tokens:write') ? (
              <>
                {connections.tokens.length > 0 ? (
                  <Button href={paths.accessNew()}>Add issuer access rule</Button>
                ) : null}
                {consumers.length > 0 ? (
                  <Button variant="primary" plus href={paths.consumerNew()}>
                    Add credential access rule
                  </Button>
                ) : null}
              </>
            ) : undefined
          }
        />
      ),
    },
    (ctx) => (
      <>
        <ConsumerList connections={connections} ctx={ctx} />
        <UnknownIssuers issuers={unknownIssuers} ctx={ctx} />
      </>
    ),
  );
}

function ConsumerList(props: { connections: Connections; ctx: ViewContext }) {
  const { connections, ctx } = props;
  const { consumers } = connections;
  const canWrite = ctx.can('tokens:write');
  const rowAction = ctx.can('access:write') && connections.tokens.length > 0;
  const edges = byConsumer(connections.accesses);
  const tokenCount = new Set(connections.accesses.map((edge) => edge.grant.service_id)).size;
  const sorted = busiestFirst(consumers, (id) => edges.get(id)?.length ?? 0);
  return (
    <Tray
      id="cl"
      title="All credential access rules"
      count={consumers.length}
      description={
        consumers.length === 0
          ? undefined
          : `${accessesText(connections.accesses.length)} to ${tokenCount} ${tokenCount === 1 ? 'token' : 'tokens'}. A chip opens that credential access rule's accesses for the token.`
      }
      actions={
        consumers.length > 0 ? (
          <Button size="sm" href={paths.access()}>
            Open the connections map
          </Button>
        ) : undefined
      }
    >
      <Panel variant="flush">
        <Table
          id="consumers"
          labelledBy="cl-h"
          stackable
          columns={[
            { label: 'Credential access rule' },
            { label: 'Trusts' },
            { label: 'Can use' },
            { label: 'Last call', num: true },
            { label: 'Status' },
            ...(rowAction ? [{ label: 'Actions', act: true }] : []),
          ]}
        >
          {sorted.map((consumer) => {
            const own = edges.get(consumer.id) ?? [];
            const labels = connections.labels.filter(
              (label) => label.credential_access_rule_id === consumer.id,
            );
            const profile = getProfile(consumer.profile);
            const kind = trustKind(consumer);
            return (
              <Row>
                <RowHeader>
                  <Entity
                    logo={consumerLogo(consumer)}
                    href={paths.consumer(consumer.id)}
                    name={consumer.name}
                    meta={`${profile?.label ?? consumer.profile} · ${issuerHost(consumer.issuer)}`}
                  />
                </RowHeader>
                <Cell label="Trusts">
                  {kind === null ? (
                    <span class="t-warn">No pin</span>
                  ) : (
                    <TrustsCell consumer={consumer} labels={labels} kind={kind} />
                  )}
                </Cell>
                <Cell label="Can use">
                  <CanUse consumer={consumer} edges={own} />
                </Cell>
                <Cell label="Last call" num nowrap>
                  {lastCall(own, connections, ctx.now)}
                </Cell>
                <Cell label="Status">
                  <StatusDot status={consumer.enabled ? 'active' : 'disabled'} />
                </Cell>
                {rowAction ? (
                  <Cell act>
                    <Button
                      size="sm"
                      href={paths.accessNew({ consumer: consumer.id })}
                      srSuffix={`to ${consumer.name}`}
                    >
                      Give access
                    </Button>
                  </Cell>
                ) : null}
              </Row>
            );
          })}
        </Table>
        {consumers.length === 0 ? (
          <UiEmptyState
            title="No credential access rules yet."
            description="Define the issuers and identity filters that may receive access to each credential."
            actions={
              canWrite ? (
                <Button variant="primary" plus href={paths.consumerNew()}>
                  Add credential access rule
                </Button>
              ) : (
                <AskSomeone
                  permission="tokens:write"
                  ctx={ctx}
                  verb="add a credential access rule"
                />
              )
            }
          />
        ) : null}
      </Panel>
    </Tray>
  );
}

/**
 * "Callers no consumer trusts": issuers refused in the last 24 hours (`issuer_unknown`), so an
 * admin who recognizes one adds it in one click. The issuer is unverified text: it is shown, never
 * put into the add form (I-LOG-2); a built-in issuer only preselects its type.
 */
function UnknownIssuers(props: { issuers: UnknownIssuer[]; ctx: ViewContext }) {
  const { issuers, ctx } = props;
  if (issuers.length === 0) return null;
  return (
    <Tray
      id="unk"
      title="Callers no consumer trusts"
      description="Refused before a token was chosen, last 24 hours. Add a consumer only if you recognize the issuer."
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
              {ctx.can('tokens:write') ? (
                <Button
                  href={paths.consumerNew(type ? { type } : undefined)}
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

/** "0c9f3e1a-…-123456789abc": a long pin value kept to one line in the list (the page shows it all). */
function shortValue(value: string): string {
  return value.length > 24 ? `${value.slice(0, 8)}…${value.slice(-12)}` : value;
}

/** "organization_id" → "Organization ID": a pin claim as the second line of the Trusts cell. */
function claimWords(claim: string): string {
  const words = claim
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => (word.toLowerCase() === 'id' ? 'ID' : word));
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What a consumer trusts, as one short mono line plus its kind: the pinned owners of GitHub and
 * GitLab, or a generic pin's value under the words of its claim. The full value is in the title.
 */
function TrustsCell(props: { consumer: CredentialAccessRule; labels: ClaimLabel[]; kind: string }) {
  const { consumer } = props;
  const full = tenantsText(consumer, props.labels);
  const [only] = consumer.tenant_pin;
  if (tenantClaimOf(consumer.profile) === null && consumer.tenant_pin.length === 1 && only) {
    const value = only.values.join(', ');
    return (
      <>
        <span class={only.values.length === 1 ? 'mono nw' : 'mono'} title={full}>
          {only.values.length === 1 ? shortValue(value) : value}
        </span>
        <span class="meta d-block">{claimWords(only.claim)}</span>
      </>
    );
  }
  return (
    <>
      <span class="mono">
        {full.split(', ').map((part, index) => (
          <>
            {index > 0 ? ', ' : null}
            <span class="nw">{part}</span>
          </>
        ))}
      </span>
      <span class="meta d-block">{props.kind}</span>
    </>
  );
}

const CHIPS_SHOWN = 4;

/** The tokens one consumer can use: a chip per token (its accesses grouped), then the facts. */
function CanUse(props: { consumer: CredentialAccessRule; edges: readonly AccessEdge[] }) {
  const { consumer, edges } = props;
  if (edges.length === 0) return <span class="meta">No credential yet</span>;
  const tokens = new Map<string, { token: Service | null; edges: AccessEdge[] }>();
  for (const edge of edges) {
    const entry = tokens.get(edge.grant.service_id) ?? { token: edge.token, edges: [] };
    entry.edges.push(edge);
    tokens.set(edge.grant.service_id, entry);
  }
  const groups = [...tokens.entries()].sort((a, b) =>
    (a[1].token?.name ?? '').localeCompare(b[1].token?.name ?? ''),
  );
  const shown = groups.slice(0, CHIPS_SHOWN);
  const rest = groups.length - shown.length;
  const facts = edgeFacts(edges);
  return (
    <>
      <Chips
        label={`Credentials allowed by ${consumer.name}`}
        more={
          rest > 0
            ? { href: paths.access({ consumer: consumer.id }), label: `+${rest} more` }
            : undefined
        }
      >
        {shown.map(([tokenId, group]) => {
          const look = chipLook(group.edges);
          return (
            <Chip
              href={paths.access({ consumer: consumer.id, token: tokenId })}
              logo={tokenLogo(group.token)}
              count={group.edges.length}
              tone={look.tone}
              glyph={look.glyph}
              srSuffix={`: ${accessesText(group.edges.length)}${look.words}. Open.`}
            >
              {group.token?.name ?? 'Deleted credential'}
            </Chip>
          );
        })}
      </Chips>
      <span class="meta d-block">
        {accessesText(edges.length)}
        {facts.map((fact) => (
          <>
            {' · '}
            <span class={fact.tone ? `t-${fact.tone}` : undefined}>
              <span aria-hidden="true">{fact.glyph} </span>
              {fact.text}
            </span>
          </>
        ))}
      </span>
    </>
  );
}

/** The worst state of a token's accesses, as a chip tone, glyph and spoken words. */
function chipLook(edges: readonly AccessEdge[]): {
  tone?: 'warn' | 'bad' | 'off';
  glyph?: string;
  words: string;
} {
  const expired = edges.filter((edge) => edge.status === 'expired').length;
  const expiring = edges.filter((edge) => edge.status === 'expiring');
  const risky = edges.filter((edge) => edge.flags.some((f) => f.status === 'risk_accepted')).length;
  const off = edges.filter((edge) => edge.status === 'inactive' || edge.status === 'disabled');
  const words = [
    expired > 0 ? `${expired} expired` : null,
    expiring.length > 0 ? statusLabel('expiring', expiring[0]?.statusDetail).toLowerCase() : null,
    risky > 0 ? 'risk accepted' : null,
    off.length > 0 ? (off[0]?.status === 'disabled' ? 'disabled' : 'inactive') : null,
  ].filter((word): word is string => word !== null);
  const spoken = words.length > 0 ? `, ${words.join(', ')}` : '';
  if (expired > 0) return { tone: 'bad', glyph: '✕', words: spoken };
  if (expiring.length > 0) return { tone: 'warn', glyph: '⌛', words: spoken };
  if (risky > 0) return { tone: 'warn', glyph: '⚠', words: spoken };
  if (off.length === edges.length) return { tone: 'off', glyph: '⏸', words: spoken };
  return { words: spoken };
}

/** The facts line under the chips: risks, expired and expiring accesses, inactive ones. */
function edgeFacts(
  edges: readonly AccessEdge[],
): Array<{ glyph: string; text: string; tone?: 'warn' | 'bad' }> {
  const facts: Array<{ glyph: string; text: string; tone?: 'warn' | 'bad' }> = [];
  const risky = edges.filter((edge) => edge.flags.some((f) => f.status === 'risk_accepted')).length;
  if (risky > 0) facts.push({ glyph: '⚠', text: `${risky} risk accepted`, tone: 'warn' });
  const expired = edges.filter((edge) => edge.status === 'expired').length;
  if (expired > 0) facts.push({ glyph: '✕', text: `${expired} expired`, tone: 'bad' });
  for (const edge of edges.filter((item) => item.status === 'expiring')) {
    facts.push({
      glyph: '⌛',
      text: `1 ${statusLabel('expiring', edge.statusDetail).toLowerCase()}`,
    });
  }
  // One line per reason: "2 inactive: token has no credential".
  const inactive = new Map<string, number>();
  for (const edge of edges.filter((item) => item.status === 'inactive')) {
    const reason = edge.statusDetail ?? '';
    inactive.set(reason, (inactive.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of inactive) {
    facts.push({ glyph: '⏸', text: `${count} inactive${reason ? `: ${reason}` : ''}` });
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------
// Add

async function newPage(c: AdminContext) {
  const form = blankConsumerForm(c.req.query('type'));
  form.credential_id = c.req.query('credential') ?? '';
  return renderNew(c, form, [], 200);
}

async function renderNew(
  c: AdminContext,
  form: ConsumerForm,
  errors: FieldError[],
  status: 200 | 409 | 422,
) {
  const connections = withAnyRefFlags(await loadConnections(c.get('deps')));
  return renderPage(
    c,
    {
      title: 'Add a credential access rule',
      section: 'consumers',
      subsection: 'consumers',
      errors,
      status,
      errorSummary:
        errors.length > 0 ? { title: 'The credential access rule was not added' } : undefined,
      header: (
        <PageHeader
          crumbs={[
            { label: 'Credential access rules', href: paths.consumers() },
            { label: 'Add credential access rule' },
          ]}
          title="Add a credential access rule"
          description="Tell tokengate which CI system to trust. Adding a consumer gives nobody access; you choose tokens next."
        />
      ),
    },
    (ctx) => (
      <LiveForm
        id="f-add"
        action={paths.consumers()}
        hidden={ctx.hidden()}
        rail={<SetForYou existing={[]} />}
      >
        <div class="field">
          <label for="credential_id">Credential</label>
          <select id="credential_id" name="credential_id" required>
            <option value="">Choose a credential</option>
            {connections.tokens.map((token) => (
              <option value={token.id} selected={form.credential_id === token.id}>
                {token.name}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="boundary_filters">Required identity filters</label>
          <textarea
            id="boundary_filters"
            name="boundary_filters"
            rows={4}
            placeholder="environment exact production"
          >
            {form.boundary_filters ?? ''}
          </textarea>
          <p class="hint">
            One filter per line: claim, exact or glob, then allowed values. Every filter is
            required, in addition to the organization below.
          </p>
        </div>
        <AddConsumerFields
          prefix=""
          live={1}
          form={form}
          errors={errors}
          existing={[]}
          labels={connections.labels}
          anchorSuggestions={genericAnchorSuggestions(connections.consumers)}
        />
        <SubmitRow hint="Access managers can grant access within these limits after you save them.">
          <Button variant="primary" type="submit">
            Add credential access rule
          </Button>
          <Button href={paths.consumers()}>Cancel</Button>
        </SubmitRow>
      </LiveForm>
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Consumer page

interface DetailState {
  errors?: FieldError[];
  /** Which form the errors belong to; its dialog or disclosure opens. */
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

interface ConsumerPageModel {
  provider: CredentialAccessRule;
  profile: IssuerProfile;
  connections: Connections;
  labels: ClaimLabel[];
  issuer_access_rules: IssuerAccessRule[];
  origin: string;
  warnings: string[];
  state: DetailState;
}

async function renderDetail(
  c: AdminContext,
  provider: CredentialAccessRule,
  profile: IssuerProfile,
  state: DetailState,
) {
  const deps = c.get('deps');
  const [connections, labels, issuer_access_rules] = await Promise.all([
    loadConnections(deps, { consumerId: provider.id }).then(withAnyRefFlags),
    listClaimLabels(deps.env.DB, provider.id),
    listIssuerAccessRules(deps.env.DB, { credential_access_rule_id: provider.id }),
  ]);
  const stored = validateCredentialAccessRule(provider, profile, provider);
  const errors = state.errors ?? [];
  const model: ConsumerPageModel = {
    provider,
    profile,
    connections,
    labels,
    issuer_access_rules,
    origin: new URL(c.req.url).origin,
    warnings: [...stored.errors, ...stored.warnings],
    state,
  };
  return renderPage(
    c,
    {
      title: provider.name,
      section: 'consumers',
      subsection: 'consumers',
      notice: errors.length > 0 ? null : (pageNotice(c, provider) ?? null),
      errors,
      status: state.status ?? 200,
      header: (ctx) => <ConsumerHeader model={model} ctx={ctx} />,
    },
    (ctx) => <ConsumerPage model={model} ctx={ctx} />,
  );
}

function ConsumerHeader(props: { model: ConsumerPageModel; ctx: ViewContext }) {
  const { provider, profile, connections, labels } = props.model;
  const { ctx } = props;
  const edges = connections.accesses;
  const tokenCount = new Set(edges.map((edge) => edge.grant.service_id)).size;
  const repositories = new Set(
    edges.flatMap((edge) =>
      anchorsOf(edge, labels)
        .filter((anchor) => anchor.repositoryId !== null)
        .map((anchor) => anchor.key),
    ),
  ).size;
  const claim = tenantClaimOf(provider.profile);
  const owners = claim === null ? [] : pinValues(provider.tenant_pin, claim);
  return (
    <PageHeader
      crumbs={[
        { label: 'Credential access rules', href: paths.consumers() },
        { label: provider.name },
      ]}
      identity={
        <Identity
          logo={consumerLogo(provider)}
          title={provider.name}
          status={<StatusBadge status={provider.enabled ? 'active' : 'disabled'} />}
          type={`${profile.label} · ${issuerHost(provider.issuer)}`}
          entityId={{ value: provider.id, kind: 'Credential access rule' }}
          facts={[`Created ${formatTime(new Date(provider.created_at), 'date')}`]}
        />
      }
      actions={
        <>
          {ctx.can('tokens:write') ? (
            <>
              <DialogTrigger dialog="dlg-rename-consumer">Rename…</DialogTrigger>
              <ActionButton
                action={`${paths.consumer(provider.id)}/toggle`}
                csrf={ctx.csrf}
                label={provider.enabled ? 'Disable' : 'Enable'}
                context={provider.name}
                fields={{ enabled: provider.enabled ? '0' : '1' }}
                returnTo="detail"
              />
            </>
          ) : null}
          {ctx.can('access:write') ? (
            <Button
              variant="primary"
              plus
              href={paths.accessNew({ consumer: provider.id, token: provider.credential_id })}
            >
              Add issuer access rule
            </Button>
          ) : null}
        </>
      }
    >
      <RelationLine>
        {edges.length === 0 ? (
          'No issuer access rules use this boundary yet.'
        ) : (
          <>
            Can use{' '}
            <a href={paths.access({ consumer: provider.id })}>
              {tokenCount} {tokenCount === 1 ? 'token' : 'tokens'}
            </a>{' '}
            through <b>{accessesText(edges.length)}</b>
            {repositories > 0 ? (
              <>
                {' '}
                from{' '}
                <b>
                  {repositories} {repositories === 1 ? 'repository' : 'repositories'}
                </b>
              </>
            ) : null}
            {owners.length > 0 ? (
              <>
                {' '}
                of {ownerWord(provider, owners.length)} <Mono>{tenantsText(provider, labels)}</Mono>
              </>
            ) : null}
            .
          </>
        )}
      </RelationLine>
    </PageHeader>
  );
}

function ConsumerPage(props: { model: ConsumerPageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { provider, profile, connections, labels, issuer_access_rules, state } = model;
  const canWrite = ctx.can('tokens:write');
  const edges = connections.accesses;
  const slugs = [
    ...new Set(edges.map((edge) => edge.token?.slug).filter((slug): slug is string => !!slug)),
  ];
  const errors = state.errors ?? [];
  const err = (name: string) => errors.find((error) => error.field === name)?.message ?? null;
  const deleteDialog = deleteDialogProps(ctx, provider, issuer_access_rules, connections);
  return (
    <>
      {model.warnings.map((warning) => (
        <Callout tone="warn" title="Risk:">
          {warning}
        </Callout>
      ))}
      <DetailLayout
        railLabel="Credential access rule"
        rail={<ConsumerRail model={model} ctx={ctx} />}
      >
        <Tray id="boundary" title="Credential access limits">
          <p>
            This boundary applies to{' '}
            <a href={paths.token(provider.credential_id)}>
              {connections.tokens.find((token) => token.id === provider.credential_id)?.name ??
                provider.credential_id}
            </a>
            . It does not grant access by itself.
          </p>
          <pre>
            {formatConditions(provider.conditions) ||
              'No additional filters beyond the organization limits.'}
          </pre>
          {canWrite ? (
            <PostForm action={paths.consumer(provider.id)} csrf={ctx.csrf}>
              <VersionField value={String(provider.updated_at)} />
              <input type="hidden" name="intent" value="boundary" />
              <label for="boundary_filters">Required identity filters</label>
              <textarea id="boundary_filters" name="boundary_filters" rows={4}>
                {formatConditions(provider.conditions)}
              </textarea>
              <p class="hint">
                For example: environment exact production. Changes apply to existing access rules on
                the next request.
              </p>
              <Button type="submit" variant="primary">
                Save limits
              </Button>
            </PostForm>
          ) : null}
        </Tray>
        <Tray
          id="access"
          title="Accesses by repository"
          count={edges.length}
          description="Each row is one issuer access rule: which jobs, which token, what they may call."
          actions={
            edges.length > 0 ? (
              <Button size="sm" href={paths.access({ consumer: provider.id })}>
                Open in connections map
              </Button>
            ) : undefined
          }
          footer={
            <span>
              <a href={paths.access({ consumer: provider.id })}>
                All issuer access rules of {provider.name}
              </a>{' '}
              · <a href={paths.requests({ consumer: provider.id })}>Requests</a> ·{' '}
              <a href={paths.audit({ target: provider.id })}>History</a>
            </span>
          }
        >
          <Panel variant="flush">
            <Table
              labelledBy="access-h"
              stackable
              columns={[
                { label: 'Jobs → token' },
                { label: 'Status' },
                { label: 'Last used', num: true },
              ]}
            >
              {edges.length > 0 ? (
                <AccessBlocks
                  edges={edges}
                  labels={labels}
                  provider={provider}
                  canWrite={canWrite}
                  connections={connections}
                  now={ctx.now}
                />
              ) : undefined}
            </Table>
            {edges.length === 0 ? (
              <UiEmptyState
                title="This credential access rule cannot use any token yet."
                description="Give it access to a token; the snippet below then names the token."
              />
            ) : null}
          </Panel>
        </Tray>

        <Tray
          id="snippet"
          title="Connect your jobs"
          description="Add this step to a workflow in any repository above. The audience is unique to this credential access rule."
        >
          <Panel variant="pad">
            <ConsumerSnippet consumer={provider} origin={model.origin} slugs={slugs} />
          </Panel>
        </Tray>

        <TenantsSection
          ctx={ctx}
          provider={provider}
          profile={profile}
          labels={labels}
          issuer_access_rules={issuer_access_rules}
          state={state}
        />

        <TrustSection
          ctx={ctx}
          provider={provider}
          profile={profile}
          issuer_access_rules={issuer_access_rules}
          state={state}
          tokens={connections}
        />

        {canWrite ? (
          <DangerZone id="danger">
            <DangerRow
              title="Delete this credential access rule"
              description={
                issuer_access_rules.length > 0
                  ? `Removes ${provider.name} and its ${issuer_access_rules.length} issuer access rules. To pause it instead, use Disable at the top; you can enable it again.`
                  : 'The audit log keeps a copy of its configuration. To stop its jobs for now, disable it instead.'
              }
              action={<ConfirmTrigger {...deleteDialog} />}
            />
          </DangerZone>
        ) : null}
      </DetailLayout>
      {canWrite ? (
        <>
          <Dialog
            id="dlg-rename-consumer"
            title={`Rename ${provider.name}`}
            action={paths.consumer(provider.id)}
            hidden={ctx.hidden({ expected_updated_at: String(provider.updated_at) })}
            open={state.open === 'rename'}
            footer={
              <>
                <DialogClose dialog="dlg-rename-consumer" />
                <Button variant="primary" type="submit" name="intent" value="rename">
                  Save name
                </Button>
              </>
            }
          >
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
          </Dialog>
          <ConfirmBox {...deleteDialog} />
        </>
      ) : null}
    </>
  );
}

function deleteDialogProps(
  ctx: ViewContext,
  provider: CredentialAccessRule,
  issuer_access_rules: readonly IssuerAccessRule[],
  connections: Connections,
): ConfirmDialogProps {
  const ids = issuer_access_rules.map((grant) => grant.id).sort();
  const count = issuer_access_rules.length;
  const tokenNames = [
    ...new Set(
      issuer_access_rules.map(
        (grant) => connections.tokens.find((token) => token.id === grant.service_id)?.name,
      ),
    ),
  ].filter((name): name is string => !!name);
  const requests = connections.usageAvailable
    ? issuer_access_rules.reduce(
        (sum, grant) => sum + (connections.usage.get(grant.id)?.requests ?? 0),
        0,
      )
    : null;
  return {
    id: 'delete-consumer',
    trigger: `Delete ${provider.name}…`,
    title:
      count > 0
        ? `Delete ${provider.name} and its ${count} issuer access ${count === 1 ? 'rule' : 'rules'}?`
        : `Delete ${provider.name}?`,
    body:
      count > 0
        ? 'You cannot undo this. Its jobs are refused from the next request on, and these accesses are deleted with it.'
        : 'Its jobs are refused from the next request on.',
    affected: [
      ...(count > 0 && tokenNames.length > 0
        ? [`Its jobs stop getting ${tokenNames.join(', ')} at their next call.`]
        : []),
      ...(count > 0 && requests !== null
        ? [`${formatCount(requests)} allowed requests used it in 30 days.`]
        : []),
      ...issuer_access_rules.map((grant) => <a href={paths.accessItem(grant.id)}>{grant.name}</a>),
    ],
    confirmLabel:
      count > 0
        ? `Delete consumer and ${count} ${count === 1 ? 'access' : 'accesses'}`
        : 'Delete consumer',
    danger: true,
    variant: 'standalone',
    action: `${paths.consumer(provider.id)}/delete`,
    csrf: ctx.csrf,
    fields: count > 0 ? { with_accesses: '1', access_ids: ids.join(',') } : {},
  };
}

function ConsumerRail(props: { model: ConsumerPageModel; ctx: ViewContext }) {
  const { provider, connections } = props.model;
  const edges = connections.accesses;
  const requests = edges.reduce(
    (sum, edge) => sum + (connections.usage.get(edge.grant.id)?.requests ?? 0),
    0,
  );
  const last = lastCall(edges, connections, props.ctx.now);
  return (
    <Tray id="facts" title="Details">
      <Panel>
        <RailKeyValue
          items={[
            {
              label: 'Last call',
              value: last,
              note: connections.usageAvailable ? (
                <>
                  {formatCount(requests)} allowed in 30 days ·{' '}
                  <a href={paths.requests({ consumer: provider.id })}>See requests</a>
                </>
              ) : undefined,
            },
            { label: 'Issuer', value: <Breakable text={provider.issuer} />, mono: true },
            {
              label: 'Audience',
              value: <Breakable text={provider.audience} />,
              mono: true,
              copyable: true,
            },
            {
              label: 'Max token age',
              value: `${ageText(provider.max_token_age_seconds)} · ${provider.allowed_algs.join(', ')}`,
            },
            { label: 'Created', value: formatTime(new Date(provider.created_at), 'date') },
            { label: 'Last changed', value: relativeTime(provider.updated_at, props.ctx.now) },
            { label: 'ID', value: provider.id, mono: true, copyable: true },
          ]}
        />
        <RailFoot>
          <a href={paths.audit({ target: provider.id })}>Audit history →</a>
        </RailFoot>
      </Panel>
    </Tray>
  );
}

function ageText(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
}

function protectedRefs(edge: AccessEdge): boolean {
  return edge.grant.conditions.some(
    (c) => c.claim === 'ref_protected' && c.match === 'exact' && c.values.includes('true'),
  );
}

function AccessBlocks(props: {
  edges: AccessEdge[];
  labels: ClaimLabel[];
  provider: CredentialAccessRule;
  canWrite: boolean;
  connections: Connections;
  now: number;
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
        .sort((a, b) => b.edges.length - a.edges.length || a.header.localeCompare(b.header))
        .map((block) => {
          const heading = block.repositoryId !== null ? block.subject : block.header;
          return (
            <>
              <GroupRow
                colspan={3}
                actions={
                  props.canWrite ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      plus
                      href={paths.accessNew({
                        consumer: props.provider.id,
                        repository: block.repositoryId ?? undefined,
                        copy: block.edges[0]?.grant.id,
                      })}
                    >
                      Give {heading} access to another token
                    </Button>
                  ) : undefined
                }
              >
                <Mono>{heading}</Mono>
                {block.repositoryId !== null ? (
                  <>
                    {' '}
                    <span class="meta">({block.repositoryId})</span>
                  </>
                ) : null}
              </GroupRow>
              {block.edges.map((edge) => (
                <Row>
                  <RowHeader>
                    <ArrowRow
                      href={paths.accessItem(edge.grant.id)}
                      verb={
                        ['expired', 'disabled', 'inactive'].includes(edge.status)
                          ? 'could use'
                          : 'can use'
                      }
                      consumer={{
                        name: edge.context,
                        context: edge.flags.some((f) => f.status === 'risk_accepted') ? (
                          <span class="t-warn">risk accepted</span>
                        ) : protectedRefs(edge) ? (
                          'protected refs only'
                        ) : undefined,
                      }}
                      token={{
                        name: edge.token?.name ?? 'Deleted credential',
                        logo: tokenLogo(edge.token),
                        context: operationsText(edge),
                      }}
                    />
                  </RowHeader>
                  <Cell label="Status">
                    <AccessStatus edge={edge} now={props.now} />
                  </Cell>
                  <Cell label="Last used" num nowrap>
                    {!props.connections.usageAvailable
                      ? 'Unknown'
                      : edge.lastUsedHour === null
                        ? 'None in 30 days'
                        : lastUsedTime(edge.lastUsedHour, props.now)}
                  </Cell>
                </Row>
              ))}
            </>
          );
        })}
    </>
  );
}

/** The status dot of an access, then its flags and its expiry, one muted line each. */
export function AccessStatus(props: { edge: AccessEdge; now: number; expiry?: boolean }) {
  const { edge } = props;
  const expires = edge.grant.expires_at;
  const lead = leadStatus(edge);
  return (
    <>
      <StatusDot status={lead.status} detail={lead.detail} />
      {lead.rest.map((flagItem) => (
        <span class="meta d-block">{statusLabel(flagItem.status, flagItem.detail)}</span>
      ))}
      {props.expiry !== false &&
      expires !== null &&
      expires > props.now &&
      edge.status !== 'expiring' ? (
        <span class="meta d-block">Expires {formatTime(new Date(expires), 'date')}</span>
      ) : null}
    </>
  );
}

function TenantsSection(props: {
  ctx: ViewContext;
  provider: CredentialAccessRule;
  profile: IssuerProfile;
  labels: ClaimLabel[];
  issuer_access_rules: IssuerAccessRule[];
  state: DetailState;
}) {
  const { ctx, provider, profile, labels, issuer_access_rules, state } = props;
  const canWrite = ctx.can('tokens:write');
  const claim = tenantClaimOf(provider.profile);
  const errors = state.errors ?? [];
  const err = (name: string) => errors.find((error) => error.field === name)?.message ?? null;
  const gitlab = provider.profile === 'gitlab-ci';
  if (claim === null) {
    // The presets' pin claims, then the claims this pin already uses.
    const pinClaimSuggestions = [
      ...new Set([
        ...GENERIC_PRESETS.map((preset) => preset.pin),
        ...provider.tenant_pin.map((condition) => condition.claim),
      ]),
    ].map((value) => ({ value }));
    const rows =
      state.pin ??
      provider.tenant_pin.map((condition) => ({
        claim: condition.claim,
        value: formatValueList(condition.values),
      }));
    return (
      <Tray
        id="tenants"
        title="Tenant pin"
        description="Claims every token of this issuer must carry before any access is evaluated."
      >
        <Panel variant="pad">
          {provider.tenant_pin.length === 0 ? (
            <Callout tone="warn" title="Risk:">
              no pin: every token this issuer signs for this audience reaches access evaluation.
            </Callout>
          ) : (
            <ul class="con-pins">
              {provider.tenant_pin.map((condition) => (
                <li>
                  <code>{condition.claim}</code> is {condition.values.join(' or ')}
                </li>
              ))}
            </ul>
          )}
          {canWrite ? (
            <Disclosure id="pin" summary="Change the pin" open={state.open === 'tenants'}>
              <PostForm action={paths.consumer(provider.id)} csrf={ctx.csrf} class="con-stack">
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
                        suggestions={pinClaimSuggestions}
                        hint="Literal top-level claim name that every token of your organization carries."
                        error={err(`${prefix}claim`)}
                        autocomplete="off"
                        mono
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
                        mono
                        conditional
                      />
                    </>
                  )}
                />
                <SubmitRow>
                  <Button variant="primary" type="submit" name="intent" value="trust">
                    Save the pin
                  </Button>
                </SubmitRow>
              </PostForm>
            </Disclosure>
          ) : null}
        </Panel>
      </Tray>
    );
  }
  const values = pinValues(provider.tenant_pin, claim);
  const word = gitlab ? 'group' : 'organization';
  return (
    <Tray
      id="tenants"
      title={gitlab ? 'Groups' : 'Organizations'}
      description={
        gitlab
          ? 'Only jobs from projects in these groups are trusted.'
          : 'Only jobs from repositories owned by these organizations are trusted.'
      }
    >
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
            const users = grantsUsingPinValue(issuer_access_rules, profile, provider, claim, value);
            const blocked = users.enabled.length > 0;
            const last = values.length === 1;
            const whyId = blocked || last ? `tn-${index}-why` : undefined;
            return (
              <div class="dz-row con-tenant">
                <div>
                  <Mono>{shown}</Mono>
                  {blocked ? (
                    <p class="hint" id={whyId}>
                      Used by {users.enabled.length} enabled{' '}
                      {users.enabled.length === 1 ? 'access' : 'accesses'}
                      {users.enabled.length <= 2 ? (
                        <>
                          :{' '}
                          {users.enabled.map((grant, i) => (
                            <>
                              {i > 0 ? ', ' : ''}
                              <a href={paths.accessItem(grant.id)}>{grant.name}</a>
                            </>
                          ))}
                        </>
                      ) : (
                        <>
                          {' '}
                          (<a href={paths.access({ consumer: provider.id })}>see them</a>)
                        </>
                      )}
                      . Removing this organization revokes its access on the next request.
                    </p>
                  ) : last ? (
                    <p class="hint" id={whyId}>
                      The last {word} cannot be removed; add another first.
                    </p>
                  ) : null}
                  {users.disabled.length > 0 ? (
                    <p class="hint">
                      {users.disabled.length} disabled{' '}
                      {users.disabled.length === 1 ? 'access uses' : 'accesses use'} it; they cannot
                      be enabled again after removal.
                    </p>
                  ) : null}
                </div>
                {canWrite ? (
                  <PostForm action={`${paths.consumer(provider.id)}/tenants`} csrf={ctx.csrf}>
                    <input type="hidden" name="intent" value="remove" />
                    <Button
                      size="sm"
                      type="submit"
                      name="remove"
                      value={value}
                      disabled={last}
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
            action={`${paths.consumer(provider.id)}/tenants`}
            csrf={ctx.csrf}
            class="con-stack"
          >
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

function ageOptions(
  profile: IssuerProfile,
  stored: number,
): Array<{ value: string; label: string }> {
  const limit = profile.defaults.maxTokenAgeLimitSeconds;
  const seconds = [300, 600, 900, 1800, 3600].filter((value) => value <= limit);
  if (!seconds.includes(stored)) seconds.push(stored);
  return seconds
    .sort((a, b) => a - b)
    .map((value) => ({ value: String(value), label: ageText(value) }));
}

/** True when the issuer of this credential access rule can be edited (generic, GHE slug, self-managed GitLab). */
function issuerEditable(provider: CredentialAccessRule): boolean {
  if (provider.profile === 'generic') return true;
  if (provider.profile === 'github-actions') return provider.issuer !== GITHUB_ACTIONS_ISSUER;
  return provider.issuer !== GITLAB_COM_ISSUER;
}

function TrustSection(props: {
  ctx: ViewContext;
  provider: CredentialAccessRule;
  profile: IssuerProfile;
  issuer_access_rules: IssuerAccessRule[];
  state: DetailState;
  tokens: Connections;
}) {
  const { ctx, provider, profile, issuer_access_rules, state } = props;
  const errors = state.errors ?? [];
  const err = (name: string) => errors.find((error) => error.field === name)?.message ?? null;
  const trust = state.trust;
  const value = (name: string, fallback: string) => (trust ? text(trust, name) : fallback);
  const enabledIssuerAccessRules = issuer_access_rules.filter((grant) => grant.enabled);
  const tokenName = (grant: IssuerAccessRule) =>
    props.tokens.tokens.find((token) => token.id === grant.service_id)?.name ??
    'a deleted credential';
  const enterprise = pinValues(provider.tenant_pin, 'enterprise_id')[0] ?? '';
  const algs = trust ? all(trust, 'allowed_algs') : provider.allowed_algs;
  if (!ctx.can('tokens:write')) {
    return (
      <Tray id="trust" title="Trust settings">
        <Panel variant="pad">
          <KeyValue
            items={[
              { label: 'Issuer', value: provider.issuer, mono: true },
              { label: 'JWKS URI', value: provider.jwks_uri, mono: true },
              { label: 'Audience', value: provider.audience, mono: true, copyable: true },
              { label: 'Signature algorithms', value: provider.allowed_algs.join(', ') },
              {
                label: 'Maximum token age',
                value: `${provider.max_token_age_seconds} seconds`,
              },
              ...(provider.profile === 'generic'
                ? [
                    {
                      label: 'Anchor claims',
                      value: provider.anchor_claims.join(', '),
                      mono: true,
                    },
                  ]
                : []),
            ]}
          />
        </Panel>
      </Tray>
    );
  }
  const fixedFacts: Array<{ label: string; value: Child; mono?: boolean }> = [
    ...(issuerEditable(provider) ? [] : [{ label: 'Issuer', value: provider.issuer, mono: true }]),
    ...(provider.profile === 'generic'
      ? []
      : [
          {
            label: 'JWKS URI',
            value: provider.jwks_uri,
            mono: true,
          },
        ]),
  ];
  return (
    <Tray id="trust-tray" title="Advanced trust settings" hideTitle>
      <Panel variant="pad">
        <Disclosure
          id="trust"
          summary="Advanced trust settings"
          hint="issuer, audience, algorithms, max token age"
          open={state.open === 'trust'}
        >
          <p class="hint">Changing them affects every job of this credential access rule.</p>
          <PostForm action={paths.consumer(provider.id)} csrf={ctx.csrf} class="con-stack">
            <VersionField value={String(provider.updated_at)} />
            {fixedFacts.length > 0 ? <KeyValue items={fixedFacts} /> : null}
            {issuerEditable(provider) ? (
              <Field
                name="issuer"
                label="Issuer"
                type="url"
                mono
                value={value('issuer', provider.issuer)}
                example={provider.issuer}
                hint="Changing it makes every access of this credential access rule trust a new issuer."
                error={err('issuer')}
                autocomplete="off"
                conditional
              />
            ) : null}
            {provider.profile === 'generic' ? (
              <Field
                name="jwks_uri"
                label="JWKS URI"
                type="url"
                mono
                value={value('jwks_uri', provider.jwks_uri)}
                example="https://agent.buildkite.com/.well-known/jwks"
                hint="Where the issuer publishes its signing keys. Clear it to discover it again from a new issuer."
                error={err('jwks_uri')}
                autocomplete="off"
                conditional
              />
            ) : null}
            <Field
              name="audience"
              label="Audience"
              mono
              value={value('audience', provider.audience)}
              example="tokengate:abcdefghijklmnopqrstuvwxyz"
              hint="Changing it breaks every job until its snippet is updated."
              error={err('audience')}
              autocomplete="off"
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
                mono
                value={value('anchor_claims', provider.anchor_claims.join(', '))}
                example="pipeline_id"
                suggestions={genericAnchorSuggestions(props.tokens.consumers).map((claim) => ({
                  value: claim,
                }))}
                hint="Claims that identify one workload exactly, comma-separated. Every access needs an exact condition on one of them."
                error={err('anchor_claims')}
                autocomplete="off"
                conditional
              />
            ) : null}
            {/* Only the issuer (editable here) or the JWKS URI (generic) can need the confirmation. */}
            {enabledIssuerAccessRules.length > 0 &&
            (issuerEditable(provider) || provider.profile === 'generic') ? (
              <div class="con-confirm">
                <Checkbox
                  name="confirm_trust_change"
                  label={
                    enabledIssuerAccessRules.length === 1
                      ? 'I understand that this enabled access will trust the new issuer or keys'
                      : `I understand that these ${enabledIssuerAccessRules.length} enabled accesses will trust the new issuer or keys`
                  }
                  hint="Needed only when the issuer or the JWKS URI changes."
                  checked={trust ? flag(trust, 'confirm_trust_change') : false}
                  error={err('confirm_trust_change')}
                />
                <ul>
                  {enabledIssuerAccessRules.map((grant) => (
                    <li>
                      <a href={paths.accessItem(grant.id)}>{grant.name}</a> ({tokenName(grant)})
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <SubmitRow>
              <Button variant="primary" type="submit" name="intent" value="trust">
                Save trust settings
              </Button>
            </SubmitRow>
          </PostForm>
        </Disclosure>
      </Panel>
    </Tray>
  );
}

// ---------------------------------------------------------------------------------------------
// Add credential access rule: errors and the create route

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
  if (form.type === 'github-actions' && lower.includes('enterprise id')) {
    return `${prefix}github_enterprise_id`;
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
    return 'Another credential access rule already uses this issuer: open it under Credential access rules and add access there.';
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
  const boundary = parseBoundaryFilters(form.boundary_filters ?? '');
  if (!boundary.ok)
    return renderNew(c, form, [{ field: 'boundary_filters', message: boundary.error }], 422);
  const result = await createOrMergeConsumer(deps, adminActor(c), {
    ...parsed.input,
    conditions: boundary.conditions,
  });
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
          message: `${tenantList(parsed.input.tenants)} ${parsed.input.tenants.length === 1 ? 'is' : 'are'} already allowed for ${result.credentialAccessRule.name}.`,
        },
      ],
      422,
    );
  }
  return redirectWithNotice(c, paths.consumer(result.credentialAccessRule.id), 'created');
}

function tenantList(entries: ReadonlyArray<{ value: string; label: string }>): string {
  return entries.map((entry) => `${entry.label} (${entry.value})`).join(', ');
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
  if (intent === 'boundary') {
    const parsed = parseBoundaryFilters(text(fields, 'boundary_filters'));
    if (!parsed.ok)
      return renderDetail(c, provider, profile, {
        status: 422,
        errors: [{ field: 'boundary_filters', message: parsed.error }],
      });
    const result = await updateCredentialAccessRule(deps, actor, provider.id, {
      conditions: parsed.conditions,
      expected_updated_at: version,
    });
    if (result.ok) return redirectWithNotice(c, paths.consumer(provider.id), 'updated');
    return renderDetail(c, provider, profile, {
      status: failureStatus(result),
      errors: result.errors.map((message) => ({ field: null, message })),
    });
  }
  if (intent === 'rename') {
    const name = text(fields, 'name');
    const result = await updateCredentialAccessRule(deps, actor, provider.id, {
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
          ? 'Another credential access rule already uses this name: choose a different name.'
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
  const input: CredentialAccessRuleUpdateInput = { expected_updated_at: version };
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
  const result = await updateCredentialAccessRule(deps, actor, provider.id, input);
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
    ['generic credential access rules need', 'anchor_claims'],
  ] as const) {
    if (message.startsWith(prefix)) return field;
  }
  return null;
}

async function savePin(
  c: AdminContext,
  provider: CredentialAccessRule,
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
    } else if (pin.some((condition) => condition.claim === claim)) {
      // Rows are ANDed: two rows on one claim admit only their common values, which reads as
      // either. One row per claim keeps the pin what it looks like (I-TEN-1).
      errors.push({
        field: `pin.${index}.claim`,
        message: `Put every value of ${claim} in one row, separated by commas.`,
      });
    } else {
      pin.push({ claim, match: 'exact', values: values.values });
    }
  }
  if (errors.length === 0) {
    const result = await updateCredentialAccessRule(c.get('deps'), adminActor(c), provider.id, {
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
  const result = await setCredentialAccessRuleEnabled(c.get('deps'), adminActor(c), id, enabled);
  if (result.ok) {
    const back = returnPath('POST /admin/credential-access-rules/:id/toggle', form._return, { id });
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
  const result = await deleteCredentialAccessRule(
    c.get('deps'),
    adminActor(c),
    loaded.provider.id,
    {
      withAccesses,
      accessIds,
    },
  );
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
        ? 'This credential access rule still has issuer access rules: delete it from the Delete dialog, which deletes them too.'
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
): Promise<{ provider: CredentialAccessRule; profile: IssuerProfile } | null> {
  const provider = await getCredentialAccessRule(c.get('deps').env.DB, c.req.param('id') ?? '');
  const profile = provider ? getProfile(provider.profile) : null;
  return provider && profile ? { provider, profile } : null;
}

function notFound(c: AdminContext) {
  return renderPage(
    c,
    {
      title: 'Credential access rule not found',
      section: 'consumers',
      subsection: 'consumers',
      status: 404,
      header: (
        <PageHeader
          crumbs={[
            { href: paths.consumers(), label: 'Credential access rules' },
            { label: 'Not found' },
          ]}
          title="Credential access rule not found"
          description={notFoundText('consumer')}
        />
      ),
    },
    () => <NotFound />,
  );
}

function failureStatus(failure: OpFailure): 409 | 422 {
  return failure.reason === 'conflict' ? 409 : 422;
}

/** Label of a credential access rule type, for other pages. */
export function consumerTypeLabel(profile: ProfileId): string {
  return getProfile(profile)?.label ?? profile;
}
