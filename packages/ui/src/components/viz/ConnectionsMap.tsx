import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import type { Tone } from '../../lib/props';
import { Icon } from '../base/Icon';
import { LogoTile, dimLogo, type LogoSpec } from '../base/Logo';
import { ArrowRow } from './ArrowRow';
import { Legend } from './Legend';
import { fmt, plural } from './parts';

export interface MapConsumer {
  /** Stable id, used in the links (`?consumer=`, `?focus=`). */
  id: string;
  name: string;
  /** Second line: "org acme (1234567)", "Generic OIDC · idle 41 days". */
  line?: Child;
  logo: LogoSpec;
  /** Idle consumer: dashed node, gray logo. */
  idle?: boolean;
  /** Busyness for the scale rule; defaults to its number of accesses. */
  weight?: number;
}

export interface MapToken {
  id: string;
  name: string;
  /** Proxy slug, shown after the name on wide screens. */
  slug?: string;
  /** Status line: "⌛ Secret expires in 6 days", "2 consumers". */
  line?: Child;
  /** Colors the status line. */
  lineTone?: 'warn' | 'bad';
  logo: LogoSpec;
  /** Requests in the range (`rangeLabel`); also the token's busyness for the scale rule. */
  requests: number;
  denied: number;
  errors: number;
  /** Links on the numbers: the requests log filtered to the token (and to denied or errors). */
  hrefs?: { requests?: string; denied?: string; errors?: string };
  /** "1 min ago". */
  lastUsed: string;
  /** Idle or disabled token: dashed node, gray logo. */
  idle?: boolean;
  /** Label on the node edge ("1 idle token"). */
  tag?: string;
}

export interface MapAccess {
  /** `MapConsumer.id`. */
  consumer: string;
  /** `MapToken.id`. */
  token: string;
  /** `ok` (default) active, `warn`/`bad` need attention, `off` inactive (dashed). */
  tone?: Tone;
  /** Status word for the list form ("Active", "Expires in 9 days"). */
  status: string;
  /** Consumer side in the list form; defaults to the consumer name ("… › acme/api"). */
  consumerLabel?: Child;
  /** Constraint in the list form ("branch main"). */
  context?: Child;
  /** Operation in the list form ("Post messages"). */
  operation?: Child;
  /** The access page. */
  href?: string;
}

export interface ConnectionsMapProps {
  /** Prefix of the ids inside the map. Unique on the page. */
  id: string;
  consumers: readonly MapConsumer[];
  tokens: readonly MapToken[];
  accesses: readonly MapAccess[];
  /** `?focus=` consumer id: its node and tokens light up, the rest dims. */
  focus?: string;
  /**
   * A token id (the page is filtered to one token): its node, its wires and the consumers that
   * can use it light up, the rest dims, and the focus bar gives way. Ignored with `focus`.
   */
  focusToken?: string;
  /** The access page every link points at, with query parameters. Default `/admin/issuer-access-rules`. */
  baseHref?: string;
  /**
   * Base of the focus bar and `?focus=` links, so a map on another page keeps its focus there
   * (the Overview: `/admin`). Default `baseHref`.
   */
  focusHref?: string;
  /**
   * The range of the token numbers: the column header (`short`) and the words read after each
   * request count (`long`). Default `{ short: 'Req 24 h', long: 'requests in 24 hours' }`.
   */
  rangeLabel?: { short: string; long: string };
  /** Most rows per side (scale rule). Above it: the busiest `maxRows - 1` and one group node. */
  maxRows?: number;
  /** Consumers offered in the focus bar, busiest first. Default 3; 0 hides the bar. */
  focusLinks?: number;
  /**
   * Name of the focus bar landmark. Default "Focus on a credential access rule"; give a second map on the same
   * page its own name.
   */
  focusLabel?: string;
  /** Facts at the start of the footer ("Refused before a token was chosen: 182"). */
  footer?: Child;
  class?: string;
}

/** Row pitch of the server-drawn wires: node 56 + gap 8 (ui.css `.nodes`). */
export const MAP_PITCH = 64;
const NODE_HALF = 28;
const MAX_SPAN = 4;

interface Row<T> {
  node: T | null; // null: the group node
  span: number;
  center: number;
}

function link(base: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  if (!query) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

/** Busiest first, keeping `must` ids; above `max` the rest goes into the group node. */
function pick<T extends { id: string }>(
  sorted: readonly T[],
  max: number,
  must: ReadonlySet<string>,
): { shown: T[]; hidden: T[] } {
  if (sorted.length <= max) return { shown: [...sorted], hidden: [] };
  const chosen = new Set(sorted.filter((node) => must.has(node.id)).map((node) => node.id));
  for (const node of sorted) {
    if (chosen.size >= max - 1) break;
    chosen.add(node.id);
  }
  return {
    shown: sorted.filter((node) => chosen.has(node.id)),
    hidden: sorted.filter((node) => !chosen.has(node.id)),
  };
}

/**
 * Lays one column out on `rows` grid rows. The shorter column spreads its extra rows over the
 * nodes with the most partners first (up to 4 rows each, `.rs2`–`.rs4`), so a busy consumer sits
 * across from its tokens. Centers follow the geometry rule: row i is at i * 64 + 28.
 */
function layout<T>(
  nodes: readonly (T | null)[],
  rows: number,
  partners: (node: T | null) => number,
): Row<T>[] {
  const spans = nodes.map(() => 1);
  let extra = rows - nodes.length;
  const order = nodes
    .map((node, index) => ({ index, weight: partners(node) }))
    .sort((a, b) => b.weight - a.weight);
  for (const { index, weight } of order) {
    if (extra <= 0) break;
    const add = Math.min(extra, Math.min(MAX_SPAN, Math.max(1, weight)) - 1);
    spans[index] = 1 + add;
    extra -= add;
  }
  let start = 0;
  return nodes.map((node, index) => {
    const span = spans[index] ?? 1;
    const center = (start * MAP_PITCH + (start + span - 1) * MAP_PITCH) / 2 + NODE_HALF;
    start += span;
    return { node, span, center };
  });
}

const RANK: Record<Tone, number> = { off: 0, ok: 1, info: 1, warn: 2, bad: 2 };

/** A token number with its hidden words, as a link when the page gives one (`MapToken.hrefs`). */
function Num(props: { href: string | undefined; children: Child }) {
  return props.href ? <a href={props.href}>{props.children}</a> : <>{props.children}</>;
}

/**
 * The connections map (`.cmap`): credential access rules on the left, credentials on the right,
 * one server-drawn SVG wire per consumer–token pair. Applies the scale rule (at most `maxRows`
 * rows per side, the rest in a group node that opens the matrix) and the focus rule (`?focus=`).
 * Below 64rem the wires drop out and the sides stack as lists. A text list of every access
 * follows in a disclosure.
 *
 * Renders the body of a tray: focus bar, scale note, the map, the footer (`.tray-f`) and the list
 * panel. Put it in a `Tray` whose actions hold the Map | Matrix switch.
 */
export function ConnectionsMap(props: ConnectionsMapProps) {
  const base = props.baseHref ?? '/admin/issuer-access-rules';
  const focusBase = props.focusHref ?? base;
  const range = props.rangeLabel ?? { short: 'Req 24 h', long: 'requests in 24 hours' };
  // the narrow-screen unit stays outside a count link
  const unit = (
    <span class="u" aria-hidden="true">
      {' '}
      req
    </span>
  );
  const maxRows = Math.max(2, props.maxRows ?? 7);
  const focusLinks = props.focusLinks ?? 3;
  const { accesses } = props;

  const accessCount = (key: 'consumer' | 'token', id: string) =>
    accesses.filter((access) => access[key] === id).length;
  const consumers = [...props.consumers].sort(
    (a, b) =>
      (b.weight ?? accessCount('consumer', b.id)) - (a.weight ?? accessCount('consumer', a.id)),
  );
  const tokens = [...props.tokens].sort((a, b) => b.requests - a.requests);
  const focused = props.focus ? consumers.find((c) => c.id === props.focus) : undefined;
  const focusTokens = new Set(
    focused ? accesses.filter((a) => a.consumer === focused.id).map((a) => a.token) : [],
  );

  const focusedToken =
    !focused && props.focusToken ? tokens.find((t) => t.id === props.focusToken) : undefined;
  const tokenConsumers = new Set(
    focusedToken ? accesses.filter((a) => a.token === focusedToken.id).map((a) => a.consumer) : [],
  );
  const lit = focused !== undefined || focusedToken !== undefined;

  const left = pick(consumers, maxRows, focused ? new Set([focused.id]) : tokenConsumers);
  const right = pick(tokens, maxRows, focusedToken ? new Set([focusedToken.id]) : focusTokens);
  const leftNodes: (MapConsumer | null)[] = [...left.shown, ...(left.hidden.length ? [null] : [])];
  const rightNodes: (MapToken | null)[] = [...right.shown, ...(right.hidden.length ? [null] : [])];
  const rows = Math.max(leftNodes.length, rightNodes.length, 1);

  const shownLeft = new Set(left.shown.map((c) => c.id));
  const shownRight = new Set(right.shown.map((t) => t.id));
  const leftKey = (id: string) => (shownLeft.has(id) ? id : '');
  const rightKey = (id: string) => (shownRight.has(id) ? id : '');
  const partnersOf = (side: 'consumer' | 'token', node: { id: string } | null) => {
    const ids = new Set<string>();
    for (const access of accesses) {
      const own = side === 'consumer' ? leftKey(access.consumer) : rightKey(access.token);
      if (own !== (node ? node.id : '')) continue;
      ids.add(side === 'consumer' ? rightKey(access.token) : leftKey(access.consumer));
    }
    return ids.size;
  };
  const leftRows = layout(leftNodes, rows, (node) => partnersOf('consumer', node));
  const rightRows = layout(rightNodes, rows, (node) => partnersOf('token', node));
  const centerOf = <T extends { id: string }>(list: Row<T>[], key: string) =>
    list.find((row) => (row.node ? row.node.id : '') === key)?.center ?? NODE_HALF;

  // One wire per pair of drawn nodes; its tone is the worst of the accesses it stands for.
  const wires = new Map<string, { y1: number; y2: number; rank: number; on: boolean }>();
  for (const access of accesses) {
    const l = leftKey(access.consumer);
    const r = rightKey(access.token);
    const key = `${l}\u0000${r}`;
    const rank = RANK[access.tone ?? 'ok'];
    const on = focused
      ? access.consumer === focused.id
      : focusedToken !== undefined && access.token === focusedToken.id;
    const wire = wires.get(key);
    if (wire) {
      wire.rank = Math.max(wire.rank, rank);
      wire.on ||= on;
    } else {
      wires.set(key, { y1: centerOf(leftRows, l), y2: centerOf(rightRows, r), rank, on });
    }
  }
  const drawn = [...wires.values()].sort((a, b) => Number(a.on) - Number(b.on));
  const height = rows * MAP_PITCH - 8;

  const consumerHref = (c: MapConsumer) =>
    focused && c.id !== focused.id
      ? link(focusBase, { focus: c.id })
      : link(base, { consumer: c.id });
  const tokenHref = (t: MapToken) => link(base, { token: t.id });
  const matrixHref = link(base, { view: 'matrix' });
  const usedBy = (t: MapToken) => {
    const names = [
      ...new Set(
        accesses
          .filter((a) => a.token === t.id)
          .map((a) => consumers.find((c) => c.id === a.consumer)?.name ?? a.consumer),
      ),
    ];
    if (names.length === 0) return '';
    if (names.length === 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };
  const hiddenAccesses = (side: 'consumer' | 'token', hidden: readonly { id: string }[]) => {
    const ids = new Set(hidden.map((node) => node.id));
    return accesses.filter((access) => ids.has(access[side])).length;
  };

  // Focus bar: the busiest consumers; the focused one takes the last slot when it is not among them,
  // in busiest-first order, so the bar never grows.
  const barConsumers = consumers.slice(0, focusLinks);
  if (focused && focusLinks > 0 && !barConsumers.includes(focused)) {
    barConsumers.pop();
    barConsumers.push(focused);
  }
  const barRest = consumers.length - barConsumers.length;
  const truncated = [left.hidden.length > 0 && 'consumers', right.hidden.length > 0 && 'tokens'];
  const busiest =
    truncated[0] && truncated[1]
      ? `the ${maxRows - 1} busiest on each side`
      : `the ${maxRows - 1} busiest ${truncated[0] || truncated[1]}`;
  const listed = focused
    ? accesses.filter((a) => a.consumer === focused.id)
    : focusedToken
      ? accesses.filter((a) => a.token === focusedToken.id)
      : accesses;
  const toToken = (id: string) =>
    accesses.filter((a) => a.consumer === id && a.token === focusedToken?.id).length;

  return (
    <>
      {focusLinks > 0 && !focusedToken ? (
        <div class="cmap-bar">
          <nav class="qlinks" aria-label={props.focusLabel ?? 'Focus on a credential access rule'}>
            <a class="ql" href={focusBase} aria-current={focused ? undefined : 'true'}>
              All credential access rules
            </a>
            {barConsumers.map((c) => (
              <a
                class="ql"
                href={link(focusBase, { focus: c.id })}
                aria-current={focused?.id === c.id ? 'true' : undefined}
              >
                {c.name} <span class="n">{fmt(accessCount('consumer', c.id))}</span>
              </a>
            ))}
            {barRest > 0 ? (
              <a class="ql" href={matrixHref}>
                {fmt(barRest)} more in the matrix
              </a>
            ) : null}
          </nav>
          {focused ? (
            <a class="sm" href={focusBase}>
              Clear focus
            </a>
          ) : null}
        </div>
      ) : null}
      {truncated[0] || truncated[1] ? (
        <p class="cmap-note">
          <b>
            {plural(consumers.length, 'credential access rule', 'credential access rules')},{' '}
            {plural(tokens.length, 'credential', 'credentials')}.
          </b>{' '}
          The map draws {busiest} and groups the rest. <a href={matrixHref}>Open the matrix</a> to
          see all {plural(accesses.length, 'access', 'accesses')}.
        </p>
      ) : null}
      <div
        class={cx('cmap', props.class)}
        id={props.id}
        role="group"
        aria-label={
          focused
            ? `Connections map focused on ${focused.name}. Its accesses are also listed as text below.`
            : focusedToken
              ? `Connections map focused on ${focusedToken.name}. Its accesses are also listed as text below.`
              : 'Connections map. Every line is also listed as text below.'
        }
      >
        <div class="cmap-col">
          <div class="cmap-h">
            Credential access rules <span class="n">{fmt(consumers.length)}</span>
          </div>
          <ul class="nodes">
            {leftRows.map(({ node, span }) => {
              const spanCls = span > 1 ? `rs${span}` : undefined;
              if (!node) {
                return (
                  <li class={cx('node group', spanCls)}>
                    <a class="id" href={link(base, { view: 'matrix', consumers: 'rest' })}>
                      <span class="nm">
                        +{' '}
                        {plural(
                          left.hidden.length,
                          'more credential access rule',
                          'more credential access rules',
                        )}
                      </span>
                      <span class="nl">
                        {plural(hiddenAccesses('consumer', left.hidden), 'access', 'accesses')} ·
                        open in the matrix
                      </span>
                    </a>
                  </li>
                );
              }
              const isFocus = focused?.id === node.id;
              const count = focusedToken ? toToken(node.id) : accessCount('consumer', node.id);
              const tokenLine = focusedToken
                ? count === 0
                  ? `No access to ${focusedToken.name}`
                  : `${plural(count, 'access', 'accesses')} to ${focusedToken.name}`
                : undefined;
              return (
                <li
                  class={cx(
                    'node cnode',
                    spanCls,
                    node.idle && 'idle',
                    focused && (isFocus ? 'is-on' : 'dim'),
                    focusedToken && (tokenConsumers.has(node.id) ? 'is-on' : 'dim'),
                  )}
                >
                  <LogoTile logo={node.logo} disabled={node.idle} />
                  <a
                    class="id"
                    href={consumerHref(node)}
                    aria-current={isFocus ? 'true' : undefined}
                  >
                    <span class="nm">{node.name}</span>
                    {tokenLine !== undefined ? (
                      <span class="nl">{tokenLine}</span>
                    ) : isFocus || node.line !== undefined ? (
                      <span class="nl">
                        {isFocus ? 'Focused' : null}
                        {isFocus && node.line !== undefined ? ' · ' : null}
                        {node.line}
                      </span>
                    ) : null}
                  </a>
                  <span class="cnt">
                    {fmt(count)}
                    <span class="vh">{count === 1 ? ' access' : ' accesses'}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <div class="cmap-mid" aria-hidden="true">
          <div class="cmap-h">
            <span class="hub">
              <span class="mark" aria-hidden="true">
                <Icon name="gate" />
              </span>
              {plural(accesses.length, 'access', 'accesses')}
            </span>
          </div>
          <svg
            class="wires"
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            height={height}
            focusable="false"
          >
            {drawn.map((wire) => (
              <path
                class={cx(
                  'wire',
                  wire.rank === 2 && 'warn',
                  wire.rank === 0 && 'off',
                  lit && (wire.on ? 'on' : 'dim'),
                )}
                d={`M0 ${wire.y1} C50 ${wire.y1} 50 ${wire.y2} 100 ${wire.y2}`}
              />
            ))}
          </svg>
        </div>
        <div class="cmap-col">
          <div class="cmap-h tok-h">
            <span>
              Credentials <span class="n">{fmt(tokens.length)}</span>
            </span>
            <span />
            <span class="keep">{range.short}</span>
            <span>Denied</span>
            <span class="x">Errors</span>
            <span class="x">Last used</span>
          </div>
          <ul class="nodes">
            {rightRows.map(({ node, span }) => {
              const spanCls = span > 1 ? `rs${span}` : undefined;
              if (!node) {
                return (
                  <li class={cx('node group', spanCls)}>
                    <a class="id" href={link(base, { view: 'matrix', tokens: 'rest' })}>
                      <span class="nm">
                        + {plural(right.hidden.length, 'more credential', 'more credentials')}
                      </span>
                      <span class="nl">
                        {plural(hiddenAccesses('token', right.hidden), 'access', 'accesses')} · open
                        in the matrix
                      </span>
                    </a>
                  </li>
                );
              }
              const count = accessCount('token', node.id);
              const users = usedBy(node);
              return (
                <li
                  class={cx(
                    'node tnode',
                    spanCls,
                    node.idle && 'idle',
                    focused && (focusTokens.has(node.id) ? 'is-on' : 'dim'),
                    focusedToken && (node.id === focusedToken.id ? 'is-on' : 'dim'),
                  )}
                >
                  {node.tag ? <span class="tag">{node.tag}</span> : null}
                  <span class="cnt">
                    {fmt(count)}
                    <span class="vh">{count === 1 ? ' access' : ' accesses'}</span>
                  </span>
                  <span class="idw">
                    <LogoTile logo={node.logo} disabled={node.idle} />
                    <a class="id" href={tokenHref(node)}>
                      <span class="nm">
                        {node.name}
                        {node.slug ? (
                          <>
                            {' '}
                            <span class="slug">{node.slug}</span>
                          </>
                        ) : null}
                      </span>
                      {node.line !== undefined ? (
                        <span class="nl">
                          {node.lineTone ? (
                            <span class={`t-${node.lineTone}`}>{node.line}</span>
                          ) : (
                            node.line
                          )}
                        </span>
                      ) : null}
                    </a>
                  </span>
                  <span class={cx('m keep', node.requests === 0 && 'zero')}>
                    {node.hrefs?.requests ? (
                      <>
                        <a href={node.hrefs.requests}>
                          {fmt(node.requests)}
                          <span class="vh">{` ${range.long}`}</span>
                        </a>
                        {unit}
                      </>
                    ) : (
                      <>
                        {fmt(node.requests)}
                        {unit}
                        <span class="vh">{` ${range.long}`}</span>
                      </>
                    )}
                  </span>
                  <span class={cx('m', node.denied > 0 ? 'bad' : 'z')}>
                    <Num href={node.hrefs?.denied}>
                      {fmt(node.denied)}
                      <span class="vh"> denied</span>
                    </Num>
                  </span>
                  <span class={cx('m', node.errors > 0 ? 'warn' : 'z', 'x')}>
                    <Num href={node.hrefs?.errors}>
                      {fmt(node.errors)}
                      <span class="vh">{node.errors === 1 ? ' error' : ' errors'}</span>
                    </Num>
                  </span>
                  <span class="m x">
                    <span class="vh">last used </span>
                    {node.lastUsed}
                  </span>
                  {users ? <span class="vh">{`. Used by ${users}`}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div class="tray-f">
        {props.footer !== undefined ? <span>{props.footer}</span> : null}
        {focusedToken ? (
          <Legend
            items={[
              { mark: 'wire-on', label: `Lines to ${focusedToken.name}` },
              { mark: 'wire-dim', label: 'Other lines' },
            ]}
          />
        ) : focused ? (
          <>
            <Legend
              items={[
                { mark: 'wire-on', label: 'Focused credential access rule' },
                { mark: 'wire-dim', label: 'Other credential access rules' },
                ...(left.hidden.length || right.hidden.length
                  ? [
                      {
                        mark: 'cell-off' as const,
                        label: 'Group: opens the matrix filtered to the rest',
                      },
                    ]
                  : []),
              ]}
            />
            <span>Its tokens are always drawn, even outside the {maxRows - 1} busiest.</span>
          </>
        ) : (
          <>
            <Legend
              items={[
                { mark: 'wire', label: 'Active' },
                { mark: 'wire-warn', label: 'Needs attention (the credential says why)' },
                { mark: 'wire-off', label: 'Inactive' },
              ]}
            />
            <span>
              Above {maxRows} per side the map shows the {maxRows - 1} busiest and groups the rest;{' '}
              <a href={matrixHref}>the matrix</a> shows all.
            </span>
          </>
        )}
      </div>
      <div class="panel">
        <details class="numbers">
          <summary>
            {focused ? `Show ${focused.name} as a list` : 'Show the map as a list'} (
            {plural(listed.length, 'access', 'accesses')})
          </summary>
          <ul class="cmap-list">
            {listed.map((access) => {
              const consumer = consumers.find((c) => c.id === access.consumer);
              const token = tokens.find((t) => t.id === access.token);
              const tone = access.tone ?? 'ok';
              return (
                <li>
                  <ArrowRow
                    href={access.href}
                    consumer={{
                      name: access.consumerLabel ?? consumer?.name ?? access.consumer,
                      logo: consumer?.logo,
                      context: access.context,
                    }}
                    token={{
                      name: token?.name ?? access.token,
                      logo: token ? dimLogo(token.logo, token.idle) : undefined,
                      context: access.operation,
                    }}
                  />
                  <span class={cx('st', tone !== 'ok' && tone)}>{access.status}</span>
                </li>
              );
            })}
          </ul>
        </details>
      </div>
    </>
  );
}
