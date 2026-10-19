// Global access rule pages (A7.3, A7.5) on design D. The list groups the rules by issuer (one group row per
// issuer key), with their limits as chips, how many credential access rules each one affects and its
// state; after it, the issuers that credential access rules use without any global access rule, and
// last, how global access rules work. The detail page lists the set limits, the credential access
// rules of the issuer with their status for this rule and overall, and the history; the rail holds
// the state and the confirmed Enable/Disable and Delete (AR-21, AR-4). Global access rules hold no
// secret and no credential data, so every role sees them (AR-16).
import {
  ActiveFilters,
  AddFilter,
  Badge,
  Button,
  Chip,
  Chips,
  CodeBlock,
  DangerRow,
  DangerZone,
  DetailLayout,
  Disclosure,
  EmptyState as UiEmptyState,
  Entity,
  Feed,
  FeedItem,
  Filters,
  formatTime,
  GroupRow,
  Identity,
  KeyValue,
  type KeyValueItem,
  PageHeader,
  Panel,
  QuickLinks,
  RailKeyValue,
  Row,
  RowHeader,
  Cell,
  Table,
  Time as UiTime,
  Tray,
  Avatar,
  Mono,
} from '@tokengate/ui';
import type { CredentialAccessRule, GlobalAccessRule, Service } from '../../db/types';
import type { GlobalStatus } from '../../policy/global-status';
import { globalRuleUsable } from '../../policy/limits';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { formatConditions } from '../rule-text';
import { Breakable, issuerHost, issuerLogo, tokenLogo } from './access-visuals';
import { ActionButton, type ConfirmDialogProps, ConfirmBox, ConfirmTrigger } from './components';
import { relativeTime } from './format';
import { type GlobalRuleFormModel, GlobalRuleFormView } from './global-rule-form';

export type GlobalStatusFilter = 'enabled' | 'disabled' | 'expired';

/** A credential access rule of the issuer with its status for one global rule and overall. */
export interface AffectedRule {
  rule: CredentialAccessRule;
  credential: Service | null;
  /** Against this global access rule alone. */
  own: GlobalStatus['kind'];
  /** Against every global access rule of the issuer. */
  overall: GlobalStatus['kind'];
}

export interface GlobalListRow {
  global: GlobalAccessRule;
  affected: AffectedRule[];
}

export interface GlobalListModel {
  /** Every global access rule (unfiltered), for the filter options and counts. */
  all: GlobalAccessRule[];
  rows: GlobalListRow[];
  issuer: string;
  status: GlobalStatusFilter | '';
  /** Issuer keys that credential access rules use and no global access rule caps. */
  unlimited: Array<{
    key: string;
    issuer: string;
    profile: CredentialAccessRule['profile'];
    rules: number;
  }>;
  now: number;
}

/** "Enabled", "Disabled" or "Expired": the state of a global rule (it still exists, AR-4). */
export function globalState(rule: GlobalAccessRule, now: number): GlobalStatusFilter {
  if (!rule.enabled) return 'disabled';
  return globalRuleUsable(rule, now) ? 'enabled' : 'expired';
}

const STATE_TEXT: Readonly<Record<GlobalStatusFilter, string>> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  expired: 'Expired',
};

function StateBadge(props: { rule: GlobalAccessRule; now: number }) {
  const state = globalState(props.rule, props.now);
  return (
    <Badge tone={state === 'enabled' ? 'ok' : state === 'expired' ? 'bad' : undefined}>
      {STATE_TEXT[state]}
    </Badge>
  );
}

/** The set limits of a global rule as short chip words; "No limits" when none is set. */
export function limitChips(rule: GlobalAccessRule): string[] {
  const chips: string[] = [];
  if (rule.tenant_pin !== null) {
    chips.push(
      rule.profile === 'gitlab-ci'
        ? 'Groups'
        : rule.profile === 'github-actions'
          ? 'Organizations'
          : 'Tenant pin',
    );
  }
  if (rule.conditions !== null) chips.push(`Conditions: ${rule.conditions.length}`);
  if (rule.rules !== null) chips.push(`Operations: ${rule.rules.length}`);
  if (rule.audience !== null) chips.push('Audience');
  if (rule.jwks_uri !== null) chips.push('JWKS');
  if (rule.allowed_algs !== null) chips.push('Algorithms');
  if (rule.max_token_age_seconds !== null)
    chips.push(`Token age ≤ ${rule.max_token_age_seconds} s`);
  if (rule.anchor_claims !== null) chips.push('Anchors');
  return chips.length > 0 ? chips : ['No limits'];
}

function listHref(
  model: GlobalListModel,
  change: { issuer?: string; status?: GlobalStatusFilter },
) {
  const next = { issuer: model.issuer || undefined, status: model.status || undefined, ...change };
  return paths.globalRules(next);
}

export function GlobalRulesList(props: { model: GlobalListModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const canWrite = ctx.can('access_rules:global');
  const all = model.all;
  if (all.length === 0) {
    return (
      <>
        <UiEmptyState
          headingLevel={2}
          title="No global access rules. Each credential access rule is limited only by itself."
          actions={
            canWrite ? (
              <Button variant="primary" plus href={paths.globalRuleNew()}>
                Add global access rule
              </Button>
            ) : undefined
          }
        />
        <Unlimited model={model} ctx={ctx} />
        <HowItWorks />
      </>
    );
  }
  const issuers = new Map<string, GlobalAccessRule>();
  for (const rule of all) if (!issuers.has(rule.issuer_key)) issuers.set(rule.issuer_key, rule);
  const groups = new Map<string, GlobalListRow[]>();
  for (const row of model.rows) {
    const list = groups.get(row.global.issuer_key) ?? [];
    list.push(row);
    groups.set(row.global.issuer_key, list);
  }
  const columns = [
    { label: 'Rule' },
    { label: 'Limits' },
    { label: 'Affects' },
    { label: 'Status' },
  ];
  const count = (state: GlobalStatusFilter) =>
    all.filter((rule) => globalState(rule, model.now) === state).length;
  return (
    <>
      <Tray
        id="globals"
        title="Global access rules"
        hideTitle
        bar={
          <>
            <QuickLinks
              label="Filter global access rules by state"
              links={[
                {
                  href: paths.globalRules({ issuer: model.issuer || undefined }),
                  label: 'All',
                  count: all.length,
                  current: model.status === '',
                },
                ...(['enabled', 'disabled', 'expired'] as const).map((state) => ({
                  href: listHref(model, { status: state }),
                  label: STATE_TEXT[state],
                  count: count(state),
                  current: model.status === state,
                })),
              ]}
            />
            <Filters label="Filter global access rules" as="group">
              <AddFilter
                label="Issuer"
                options={[...issuers.entries()].map(([key, rule]) => ({
                  href: listHref(model, { issuer: key }),
                  label: issuerHost(rule.issuer),
                  logo: issuerLogo({ ...rule, enabled: true }),
                  count: all.filter((item) => item.issuer_key === key).length,
                }))}
                srSuffix="global access rules"
              />
            </Filters>
            <ActiveFilters
              filters={[
                ...(model.issuer
                  ? [
                      {
                        label: `Issuer: ${model.issuer}`,
                        href: paths.globalRules({ status: model.status || undefined }),
                      },
                    ]
                  : []),
                ...(model.status
                  ? [
                      {
                        label: `Status: ${STATE_TEXT[model.status]}`,
                        href: paths.globalRules({ issuer: model.issuer || undefined }),
                      },
                    ]
                  : []),
              ]}
              clearHref={paths.globalRules()}
              clearLabel="Clear filters"
            />
          </>
        }
      >
        <Panel variant="flush">
          <Table id="global-list" labelledBy="globals-h" stackable columns={columns}>
            {model.rows.length === 0
              ? undefined
              : [...groups.entries()].map(([key, rows]) => {
                  const first = rows[0]?.global;
                  return (
                    <>
                      <GroupRow colspan={columns.length}>
                        <Entity
                          logo={issuerLogo(first ? { ...first, enabled: true } : null)}
                          logoSize="sm"
                          name={first ? issuerHost(first.issuer) : key}
                          after={<span class="meta mono">{key}</span>}
                        />
                      </GroupRow>
                      {rows.map((row) => (
                        <GlobalListRowView row={row} now={model.now} />
                      ))}
                    </>
                  );
                })}
          </Table>
          {model.rows.length === 0 ? (
            <UiEmptyState
              title="No global access rule matches these filters."
              actions={<Button href={paths.globalRules()}>Clear filters</Button>}
            />
          ) : null}
        </Panel>
      </Tray>
      <Unlimited model={model} ctx={ctx} />
      <HowItWorks />
    </>
  );
}

function GlobalListRowView(props: { row: GlobalListRow; now: number }) {
  const { global, affected } = props.row;
  const blocked = affected.filter((item) => item.own === 'blocked').length;
  return (
    <Row>
      <RowHeader>
        <a href={paths.globalRule(global.id)}>{global.name}</a>
        {global.description ? <span class="meta d-block">{global.description}</span> : null}
      </RowHeader>
      <Cell label="Limits">
        <Chips label="Limits">
          {limitChips(global).map((label) => (
            <Chip>{label}</Chip>
          ))}
        </Chips>
      </Cell>
      <Cell label="Affects">
        {affected.length === 1
          ? '1 credential access rule'
          : `${affected.length} credential access rules`}
        {blocked > 0 ? <span class="t-bad"> · {blocked} blocked</span> : null}
      </Cell>
      <Cell label="Status">
        <StateBadge rule={global} now={props.now} />
      </Cell>
    </Row>
  );
}

function Unlimited(props: { model: GlobalListModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  if (model.unlimited.length === 0) return null;
  return (
    <Tray id="unlimited" title="Issuers without a global access rule">
      <Panel variant="flush">
        {model.unlimited.map((item) => (
          <div class="dz-row">
            <Entity
              logo={issuerLogo({ profile: item.profile, issuer: item.issuer, enabled: true })}
              name={issuerHost(item.issuer)}
              meta={
                <>
                  Not limited ·{' '}
                  {item.rules === 1
                    ? '1 credential access rule'
                    : `${item.rules} credential access rules`}{' '}
                  · <span class="mono">{item.key}</span>
                </>
              }
            />
            {ctx.can('access_rules:global') ? (
              <Button
                size="sm"
                href={paths.globalRuleNew({ issuer: item.issuer, type: item.profile })}
                srSuffix={`: ${item.issuer}`}
              >
                Add a global access rule
              </Button>
            ) : null}
          </div>
        ))}
      </Panel>
    </Tray>
  );
}

function HowItWorks() {
  return (
    <Panel variant="pad">
      <Disclosure id="how" summary="How global access rules work">
        <p>
          A request is allowed when one credential access rule of the credential matches it and,
          when the caller&apos;s issuer has any global access rule, one enabled, unexpired global
          access rule of that issuer also holds for it. A global access rule never lets a request in
          by itself.
        </p>
        <p>
          A disabled or expired global access rule still exists: while no other global access rule
          of its issuer holds, the credential access rules of that issuer admit nothing. To lift a
          ceiling, delete the rule.
        </p>
        <p>
          Limits apply to every credential of the issuer. An operations limit such as POST
          /chat.postMessage on GitHub&apos;s issuer also blocks that issuer&apos;s rules for other
          credentials, which may be different APIs.
        </p>
      </Disclosure>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail

export interface GlobalPageModel {
  rule: GlobalAccessRule;
  /** Every other global access rule of the issuer key. */
  siblings: GlobalAccessRule[];
  affected: AffectedRule[];
  /** Pin values with their labels, for display. */
  tenantLabels: Map<string, string>;
  history: Array<{ ts: number; actor: string; summary: string }>;
  edit: GlobalRuleFormModel | null;
  editOpen: boolean;
}

export function GlobalRuleHeader(props: { model: GlobalPageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { rule } = model;
  return (
    <PageHeader
      crumbs={[{ label: 'Global access rules', href: paths.globalRules() }, { label: rule.name }]}
      identity={
        <Identity
          logo={issuerLogo({ ...rule, enabled: rule.enabled })}
          title={rule.name}
          status={<StateBadge rule={rule} now={ctx.now} />}
          entityId={{ value: rule.id, kind: 'Global access rule' }}
          facts={[
            `For ${rule.issuer}`,
            `Created ${formatTime(new Date(rule.created_at), 'date')}${rule.created_by ? ` by ${rule.created_by}` : ''}`,
          ]}
        />
      }
      actions={
        ctx.can('access_rules:global') && !model.editOpen ? (
          <Button variant="primary" href={paths.globalRule(rule.id, { open: 'edit' })}>
            Change this rule
          </Button>
        ) : undefined
      }
    />
  );
}

export function GlobalRulePage(props: { model: GlobalPageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { rule } = model;
  const canWrite = ctx.can('access_rules:global');
  const last = model.siblings.length === 0;
  const issuer = rule.issuer;
  const deleteDialog: ConfirmDialogProps = {
    id: 'delete-global',
    trigger: 'Delete this rule…',
    triggerContext: rule.name,
    title: `Delete ${rule.name}?`,
    body: last
      ? `This is the last global access rule of ${issuer}. After you delete it, its credential access rules are no longer limited by a global access rule.`
      : 'You cannot undo this. The other global access rules of the issuer keep capping its credential access rules.',
    confirmLabel: `Delete ${rule.name}`,
    danger: true,
    variant: 'standalone',
    action: `${paths.globalRule(rule.id)}/delete`,
    csrf: ctx.csrf,
    fields: {
      expected_updated_at: String(rule.updated_at),
      ...(last ? { confirm_widening: '1' } : {}),
    },
  };
  return (
    <>
      <DetailLayout
        railLabel="Global access rule state"
        rail={<GlobalRuleRail model={model} ctx={ctx} />}
      >
        {canWrite && model.edit && model.editOpen ? (
          <Tray
            id="edit"
            title="Change this rule"
            description="The issuer and the issuer type stay. A change that lets more requests in asks for a confirmation."
          >
            <Panel variant="pad">
              <GlobalRuleFormView model={model.edit} />
            </Panel>
          </Tray>
        ) : (
          <>
            <Tray id="limits" title="Limits">
              <Panel variant="pad">
                <KeyValue items={limitItems(model)} />
              </Panel>
            </Tray>
            <Tray
              id="affected"
              title="Affected credential access rules"
              description="The credential access rules of this issuer, with their status for this rule and for every global access rule of the issuer."
            >
              <Panel variant="flush">
                {model.affected.length === 0 ? (
                  <Panel variant="pad">
                    <p class="hint">
                      No credential access rule uses this issuer yet. This global access rule limits
                      only rules whose issuer is <Mono>{rule.issuer_key}</Mono>.
                    </p>
                  </Panel>
                ) : (
                  <Table
                    id="affected-list"
                    labelledBy="affected-h"
                    stackable
                    columns={[
                      { label: 'Credential access rule' },
                      { label: 'Credential' },
                      { label: 'This rule' },
                      { label: 'Overall' },
                    ]}
                  >
                    {model.affected.map((item) => (
                      <Row>
                        <RowHeader>
                          <a href={paths.accessRule(item.rule.id)}>{item.rule.name}</a>
                        </RowHeader>
                        <Cell label="Credential">
                          {item.credential ? (
                            <Entity
                              logo={tokenLogo(item.credential)}
                              logoSize="sm"
                              name={item.credential.name}
                            />
                          ) : (
                            'Deleted credential'
                          )}
                        </Cell>
                        <Cell label="This rule">{VERDICT[item.own]}</Cell>
                        <Cell label="Overall">{VERDICT[item.overall]}</Cell>
                      </Row>
                    ))}
                  </Table>
                )}
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
                  description={
                    last
                      ? 'The last global access rule of this issuer: deleting it lifts the ceiling.'
                      : 'Disable keeps it and caps the issuer still. Delete removes it for good; its history stays in the audit log.'
                  }
                  action={<ConfirmTrigger {...deleteDialog} />}
                />
              </DangerZone>
            ) : null}
          </>
        )}
      </DetailLayout>
      {canWrite ? <ConfirmBox {...deleteDialog} /> : null}
    </>
  );
}

const VERDICT: Readonly<Record<GlobalStatus['kind'], string>> = {
  not_limited: 'Not limited',
  within: 'Within',
  limited: 'Limited',
  blocked: 'Blocked',
};

function limitItems(model: GlobalPageModel): KeyValueItem[] {
  const { rule } = model;
  const items: KeyValueItem[] = [];
  const unset: string[] = [];
  const add = (set: boolean, label: string, value: () => KeyValueItem['value']) => {
    if (set) items.push({ label, value: value() });
    else unset.push(label === 'JWKS URI' ? label : label.toLowerCase());
  };
  add(rule.tenant_pin !== null, 'Tenants', () => (
    <ul class="con-pins">
      {(rule.tenant_pin ?? []).map((condition) => (
        <li>
          <code>{condition?.claim}</code> is{' '}
          {(condition?.values ?? [])
            .map((value) => {
              const label = model.tenantLabels.get(value);
              return label ? `${label} (${value})` : value;
            })
            .join(' or ')}
        </li>
      ))}
    </ul>
  ));
  add(rule.conditions !== null, 'Jobs', () => (
    <CodeBlock label="Conditions">{formatConditions(rule.conditions ?? [])}</CodeBlock>
  ));
  add(rule.rules !== null, 'Operations', () => (
    <ul class="operations">
      {(rule.rules ?? []).map((item) => (
        <li>
          <code>
            {item?.methods?.join(', ')} {item?.path}
          </code>
        </li>
      ))}
    </ul>
  ));
  add(rule.anchor_claims !== null, 'Anchors', () => (rule.anchor_claims ?? []).join(', '));
  add(rule.audience !== null, 'Audience', () => <Mono>{rule.audience}</Mono>);
  add(rule.jwks_uri !== null, 'JWKS URI', () => <Breakable text={rule.jwks_uri ?? ''} />);
  add(rule.allowed_algs !== null, 'Algorithms', () => (rule.allowed_algs ?? []).join(', '));
  add(
    rule.max_token_age_seconds !== null,
    'Maximum token age',
    () => `${rule.max_token_age_seconds} s`,
  );
  if (unset.length > 0) {
    items.push({ label: 'Not limited', value: unset.join(', ') });
  }
  return items;
}

function GlobalRuleRail(props: { model: GlobalPageModel; ctx: ViewContext }) {
  const { model, ctx } = props;
  const { rule } = model;
  const canWrite = ctx.can('access_rules:global');
  const issuer = rule.issuer;
  const lastEnabled = rule.enabled && !model.siblings.some((other) => other.enabled);
  const enableDialog: ConfirmDialogProps = {
    id: 'enable-global',
    trigger: 'Enable…',
    triggerContext: rule.name,
    title: `Enable ${rule.name}?`,
    body: `This lets more requests in. Every credential access rule of ${issuer} may again allow what this change no longer limits, on every credential.`,
    confirmLabel: `Enable ${rule.name}`,
    variant: 'standalone',
    action: `${paths.globalRule(rule.id)}/toggle`,
    csrf: ctx.csrf,
    fields: {
      enabled: '1',
      confirm_widening: '1',
      expected_updated_at: String(rule.updated_at),
    },
  };
  const disableDialog: ConfirmDialogProps = {
    id: 'disable-global',
    trigger: 'Disable…',
    triggerContext: rule.name,
    title: `Disable ${rule.name}?`,
    body: `While no global access rule of ${issuer} is enabled, its credential access rules admit nothing.`,
    confirmLabel: `Disable ${rule.name}`,
    danger: true,
    variant: 'standalone',
    action: `${paths.globalRule(rule.id)}/toggle`,
    csrf: ctx.csrf,
    fields: {
      enabled: '0',
      confirm_last_disable: '1',
      expected_updated_at: String(rule.updated_at),
    },
  };
  return (
    <>
      <Tray id="state" title="State">
        <Panel>
          <RailKeyValue
            items={[
              { label: 'State', value: <StateBadge rule={rule} now={ctx.now} /> },
              { label: 'Issuer', value: <Breakable text={rule.issuer} />, mono: true },
              { label: 'Issuer key', value: rule.issuer_key, mono: true },
              {
                label: 'Expires',
                value:
                  rule.expires_at === null
                    ? 'Never'
                    : `${formatTime(new Date(rule.expires_at), 'date')} (${relativeTime(rule.expires_at, ctx.now)})`,
              },
              {
                label: 'Other global rules',
                value:
                  model.siblings.length === 0
                    ? 'None: this is the only one of the issuer'
                    : `${model.siblings.length} (${model.siblings.filter((s) => s.enabled).length} enabled)`,
              },
            ]}
          />
        </Panel>
      </Tray>
      {canWrite ? (
        <Tray id="toggle" title={rule.enabled ? 'Disable' : 'Enable'}>
          <Panel variant="pad">
            {rule.enabled ? (
              lastEnabled ? (
                <>
                  <p class="hint">
                    This is the last enabled global access rule of {issuerHost(issuer)}.
                  </p>
                  <ConfirmTrigger {...disableDialog} />
                </>
              ) : (
                <ActionButton
                  action={`${paths.globalRule(rule.id)}/toggle`}
                  csrf={ctx.csrf}
                  label="Disable"
                  context={rule.name}
                  fields={{ enabled: '0', expected_updated_at: String(rule.updated_at) }}
                  returnTo="detail"
                />
              )
            ) : (
              <ConfirmTrigger {...enableDialog} />
            )}
          </Panel>
        </Tray>
      ) : null}
      {canWrite && !rule.enabled ? <ConfirmBox {...enableDialog} /> : null}
      {canWrite && lastEnabled ? <ConfirmBox {...disableDialog} /> : null}
    </>
  );
}
