import { Panel, Tray } from '@tokengate/ui';
import { resolveToken } from '../tokens';
import type { Foundation } from './types';

interface Row {
  token: string;
  use: string;
}

const GROUPS: ReadonlyArray<{ id: string; title: string; description: string; rows: Row[] }> = [
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
      'One violet accent: the primary button, the active tab, selection, links and focus.',
    rows: [
      { token: 'accent', use: 'Primary button, active tab bar, selection' },
      { token: 'accent-hover', use: 'Primary button hover' },
      { token: 'on-accent', use: 'Text on the accent' },
      { token: 'accent-text', use: 'Links' },
      { token: 'accent-soft', use: 'Selected rows and cards, active filter chips, count pills' },
      { token: 'accent-soft-text', use: 'Text on accent-soft' },
      { token: 'focus', use: 'Focus ring (3px solid, 2px offset)' },
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
      { token: 'bad-dot', use: 'Bad dot, denied bars' },
      { token: 'info', use: 'Notes (text, dot)' },
      { token: 'info-bg', use: 'Info badge and callout fill' },
      { token: 'danger', use: 'Solid danger: the confirm button inside a dialog only' },
      { token: 'on-danger', use: 'Text on danger' },
    ],
  },
  {
    id: 'charts',
    title: 'Charts and wires',
    description:
      'Bars, swatches and the connections map. Patterns, not only color, tell series apart.',
    rows: [
      { token: 'chart-allowed', use: 'Allowed bars and swatches' },
      { token: 'chart-denied', use: 'Denied bars (with the hatch pattern)' },
      { token: 'chart-error', use: 'Upstream error bars (with the dots pattern)' },
      { token: 'wire', use: 'Active wire in the connections map' },
      { token: 'wire-warn', use: 'Expiring wire' },
      { token: 'wire-on', use: 'Focused wire' },
    ],
  },
];

function Hex(props: { value?: string }) {
  return props.value ? <span class="dx-hex">{props.value}</span> : <span class="faint">—</span>;
}

function TokenTable(props: { id: string; rows: Row[] }) {
  return (
    <div class="scroll" role="region" tabindex={0} aria-labelledby={`dx-c-${props.id}-h`}>
      <table class="tbl stackable">
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
            return (
              <tr>
                <th scope="row" class="dx-name">
                  <code>--{row.token}</code>
                </th>
                <td data-label="Swatch">
                  <span class="dx-sw" data-token={row.token} aria-hidden="true" />
                </td>
                <td data-label="Light">
                  <Hex value={value.light} />
                </td>
                <td data-label="Dark">
                  <Hex value={value.dark} />
                </td>
                <td class="dx-cell" data-label="Use">
                  {row.use}
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
    </>
  ),
};
