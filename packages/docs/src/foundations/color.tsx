import { Badge, Panel, Tray } from '@tokengate/ui';
import { COLOR_TOKENS, resolveToken } from '../tokens';
import { CONTRAST_PAIRS, measure } from './contrast';
import type { Foundation } from './types';

interface Row {
  token: string;
  use: string;
}

export const GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  description: string;
  rows: Row[];
}> = [
  {
    id: 'surfaces',
    title: 'Surfaces',
    description: 'Page → tray → panel: three surfaces, never a tray inside a panel.',
    rows: [
      { token: 'page-bg', use: 'Main column (.main)' },
      { token: 'tray-bg', use: 'Tray shell (.tray, .cat-list)' },
      { token: 'panel-bg', use: 'Panel inside a tray; nodes, stages, KPI tiles, radio cards' },
      { token: 'panel-sub', use: 'Table header, group rows, code' },
      { token: 'nav-bg', use: 'Sidebar' },
      { token: 'bg', use: 'Body, outside the app' },
      { token: 'surface', use: 'Base surface: menus, kbd' },
      { token: 'surface-2', use: 'Chips, ID chips, hover fills' },
      { token: 'surface-3', use: 'Active nav item, avatar' },
      { token: 'input-bg', use: 'Inputs and selects' },
      { token: 'btn-bg', use: 'Secondary buttons, picks, quick links' },
      { token: 'row-hover', use: 'Row hover (decorative)' },
    ],
  },
  {
    id: 'text',
    title: 'Text and lines',
    description: 'Every text pair meets 4.5:1 on the surfaces above; control borders meet 3:1.',
    rows: [
      { token: 'text', use: 'Body text, titles' },
      { token: 'text-2', use: 'Secondary text, hints, descriptions' },
      { token: 'text-3', use: 'Counts, placeholders, separators' },
      { token: 'line', use: 'Decorative dividers' },
      { token: 'line-strong', use: 'Card borders (decorative)' },
      { token: 'control-border', use: 'Inputs, secondary buttons, picks (≥ 3:1)' },
    ],
  },
  {
    id: 'accent',
    title: 'Accent',
    description:
      'One petrol accent, only on what you can act on: the primary button, links, the active tab, selection, the current step and focus. Labels, counts and highlights are neutral.',
    rows: [
      { token: 'accent', use: 'Primary button, active tab bar, selection' },
      { token: 'accent-hover', use: 'Primary button hover' },
      { token: 'on-accent', use: 'Text on the accent' },
      {
        token: 'accent-text',
        use: 'Links (underlined), ghost buttons; lighter than the fill in dark',
      },
      {
        token: 'accent-soft',
        use: 'Selected rows and cards, active filter chips, hover of actions',
      },
      { token: 'accent-soft-text', use: 'Text on accent-soft' },
      { token: 'focus', use: 'Focus ring (3px solid, 2px offset); same value as accent-text' },
    ],
  },
  {
    id: 'status',
    title: 'Status',
    description:
      'Text, background and dot per tone. The word carries the meaning; color only adds.',
    rows: [
      { token: 'ok', use: 'Active, allowed, passed (text)' },
      { token: 'ok-bg', use: 'OK badge and callout fill' },
      { token: 'ok-dot', use: 'OK dot' },
      { token: 'warn', use: 'Expiring, risk, errors (text)' },
      { token: 'warn-bg', use: 'Warn badge and callout fill' },
      { token: 'warn-dot', use: 'Warn dot, expiring wire' },
      { token: 'bad', use: 'Denied, expired, failed (text)' },
      { token: 'bad-bg', use: 'Bad badge and callout fill' },
      { token: 'bad-dot', use: 'Bad dot: what needs action' },
      { token: 'bad-muted', use: 'Routine denials: the denied chart series' },
      { token: 'info', use: 'Notes (neutral): text, dot, callout bar' },
      { token: 'info-bg', use: 'Info badge and callout fill' },
      { token: 'pending', use: 'Waiting on someone: Pending approval, Invited (text, dot)' },
      { token: 'pending-bg', use: 'Pending badge fill' },
      { token: 'danger', use: 'Solid danger: the confirm button inside a dialog only' },
      { token: 'on-danger', use: 'Text on danger' },
    ],
  },
  {
    id: 'nav',
    title: 'Navigation',
    description:
      'The sidebar follows the scheme (light in light, dark in dark); its tokens are aliases of the ones above.',
    rows: [
      { token: 'nav-text', use: 'Sidebar items' },
      { token: 'nav-muted', use: 'Counts in the sidebar' },
      { token: 'nav-hover-bg', use: 'Sidebar item hover' },
      { token: 'nav-active-bg', use: 'Current sidebar item' },
      { token: 'nav-active-text', use: 'Current sidebar item text' },
      { token: 'nav-active-bar', use: 'Bar of the current sub-item' },
    ],
  },
  {
    id: 'charts',
    title: 'Charts and wires',
    description:
      'Bars, swatches and the connections map. Patterns, not only color, tell series apart.',
    rows: [
      { token: 'chart-allowed', use: 'Allowed bars and swatches' },
      { token: 'chart-denied', use: 'Denied bars, hatched; routine denials' },
      { token: 'chart-error', use: 'Upstream error bars (with the dots pattern)' },
      { token: 'wire', use: 'Active wire in the connections map' },
      { token: 'wire-warn', use: 'Expiring wire' },
      { token: 'wire-on', use: 'Focused wire' },
    ],
  },
];

/** The token an alias ends at (`--nav-text` → `text-2`): the one with a swatch rule. */
function finalToken(name: string): string {
  let current = name;
  for (let hops = 0; hops < 4; hops++) {
    const alias = COLOR_TOKENS.get(current)?.alias;
    if (!alias) break;
    current = alias;
  }
  return current;
}

function Ratio(props: { value?: number; min: number }) {
  if (props.value === undefined) return <span class="faint">—</span>;
  const pass = props.value >= props.min;
  return (
    <span class={pass ? 'dx-hex' : 't-bad'}>
      {props.value.toFixed(2)}:1{pass ? null : ' (fails)'}
    </span>
  );
}

function ContrastTable() {
  const results = CONTRAST_PAIRS.map(measure);
  return (
    <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-c-contrast-h">
      <table class="tbl dx-pairs">
        <thead>
          <tr>
            <th scope="col">Foreground on background</th>
            <th scope="col" class="num">
              Light
            </th>
            <th scope="col" class="num">
              Dark
            </th>
            <th scope="col">Needs</th>
            <th scope="col">Result</th>
            <th scope="col">Where</th>
          </tr>
        </thead>
        <tbody>
          {results.map((pair) => (
            <tr>
              <th scope="row" class="dx-name">
                <span class="dx-sw" data-token={finalToken(pair.fg)} aria-hidden="true" />{' '}
                <code>--{pair.fg}</code> on <code>--{pair.bg}</code>
              </th>
              <td class="num" data-label="Light">
                <Ratio value={pair.light} min={pair.min} />
              </td>
              <td class="num" data-label="Dark">
                <Ratio value={pair.dark} min={pair.min} />
              </td>
              <td data-label="Needs">{pair.min === 3 ? '3:1 non-text' : '4.5:1 text'}</td>
              <td data-label="Result">
                {pair.pass ? (
                  <Badge status="active">Passes AA</Badge>
                ) : (
                  <Badge status="expired">Fails</Badge>
                )}
              </td>
              <td class="dx-cell" data-label="Where">
                {pair.use}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hex(props: { value?: string }) {
  return props.value ? <span class="dx-hex">{props.value}</span> : <span class="faint">—</span>;
}

function TokenTable(props: { id: string; rows: Row[] }) {
  return (
    <div class="scroll" role="region" tabindex={0} aria-labelledby={`dx-c-${props.id}-h`}>
      {/* not .stackable: on phones each token is a compact two-line row (dx-tokens), not a card */}
      <table class="tbl dx-tokens">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Swatch</th>
            <th scope="col">Light</th>
            <th scope="col">Dark</th>
            <th scope="col">Use</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const value = resolveToken(row.token);
            const alias = COLOR_TOKENS.get(row.token)?.alias;
            return (
              <tr>
                <th scope="row" class="dx-name">
                  <code>--{row.token}</code>
                </th>
                <td data-label="Swatch">
                  <span class="dx-sw" data-token={finalToken(row.token)} aria-hidden="true" />
                </td>
                <td data-label="Light">
                  <Hex value={value.light} />
                </td>
                <td data-label="Dark">
                  <Hex value={value.dark} />
                </td>
                <td class="dx-cell" data-label="Use">
                  {row.use}
                  {alias ? (
                    <>
                      {' '}
                      <span class="faint">
                        (alias of <code>--{alias}</code>)
                      </span>
                    </>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const color: Foundation = {
  slug: 'color',
  title: 'Color',
  summary:
    'One token block on :root. Every color is light-dark(light, dark), so the page follows the operating system and dark values live nowhere else.',
  render: () => (
    <>
      <Tray id="dx-c-how" title="How color works">
        <Panel variant="pad">
          <div class="dx-prose">
            <p>
              <code>:root</code> sets <code>color-scheme: light dark</code> and defines each color
              as <code>light-dark(light, dark)</code>. The browser picks the value for the scheme in
              use. To force a scheme, set <code>color-scheme</code> on <code>:root</code>; never
              write a dark value anywhere else.
            </p>
            <p>
              Components use tokens only. A hard-coded color outside the token block is a bug,
              except the brand logo tiles. The values below are read from the served{' '}
              <code>ui.css</code>, so they are always current.
            </p>
          </div>
        </Panel>
      </Tray>
      {GROUPS.map((group) => (
        <Tray id={`dx-c-${group.id}`} title={group.title} description={group.description}>
          <Panel variant="flush">
            <TokenTable id={group.id} rows={group.rows} />
          </Panel>
        </Tray>
      ))}
      <Tray
        id="dx-c-contrast"
        title="Contrast"
        count={CONTRAST_PAIRS.length}
        description="WCAG 2.2 AA ratios of the pairs the components use, computed from the values above in both schemes."
      >
        <Panel variant="flush">
          <ContrastTable />
        </Panel>
      </Tray>
    </>
  ),
};
