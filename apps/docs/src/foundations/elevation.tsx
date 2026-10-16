import { Button, Dialog, Logo, Panel, Tray } from '@tokengate/ui';
import { uiCss } from '@tokengate/ui/css';
import type { Foundation } from './types';

const RADII: ReadonlyArray<{ key: string; px: string; use: string }> = [
  { key: '1', px: '4', use: 'Badges, chips, ID chips, masked secrets, kbd' },
  { key: '2', px: '6', use: 'Buttons, inputs, selects, logo tiles (md)' },
  { key: '3', px: '8', use: 'Panels, cards, map nodes, callouts, code blocks, logo tiles (lg)' },
  { key: '4', px: '12', use: 'Trays, dialogs' },
  { key: 'pill', px: '999', use: 'Count pills, the pending pill in the sidebar' },
];

const ELEVATION: ReadonlyArray<{ token: string; level: string; use: string }> = [
  { token: 'tray-ring', level: '0 · flat', use: 'Tray shell: a 1px line, no shadow' },
  { token: 'panel-ring', level: '1 · resting', use: 'Panels, cards, KPI tiles, map nodes, stages' },
  { token: 'shadow-raised', level: '1 · resting', use: 'Secondary buttons, the segmented control' },
  { token: 'primary-shadow', level: '1 · resting', use: 'Primary button, the shield mark' },
  {
    token: 'logo-ring',
    level: '—',
    use: 'Inner ring that keeps a logo tile visible on any surface',
  },
  {
    token: 'shadow-dialog',
    level: '2 · floating',
    use: 'Dialogs, the account menu, filter popovers',
  },
  { token: 'backdrop', level: '2 · floating', use: 'Behind a modal dialog' },
];

/** The value of a custom property in the served ui.css, as written. */
function tokenValue(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(uiCss.text);
  return m?.[1]?.trim().replace(/\s+/g, ' ') ?? '—';
}

export const elevation: Foundation = {
  slug: 'elevation',
  title: 'Radius and elevation',
  summary:
    'Five radii that grow with the size of the surface, and three elevation levels made of 1px rings and soft shadows. Dark mode drops the shadows and keeps the rings.',
  render: () => (
    <>
      <Tray
        id="dx-e-radius"
        title="Radius"
        description="Small things are 4px, controls 6px, panels 8px, trays and dialogs 12px."
      >
        <Panel variant="pad">
          <ul class="dx-radii">
            {RADII.map((r) => (
              <li>
                <span class="dx-radius" data-r={r.key} aria-hidden="true" />
                --r-{r.key} {r.px}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-e-radius-h">
            <table class="tbl stackable">
              <thead>
                <tr>
                  <th scope="col">Token</th>
                  <th scope="col" class="num">
                    px
                  </th>
                  <th scope="col">Use</th>
                </tr>
              </thead>
              <tbody>
                {RADII.map((r) => (
                  <tr>
                    <th scope="row" class="dx-name">
                      <code>--r-{r.key}</code>
                    </th>
                    <td class="num" data-label="px">
                      {r.px}
                    </td>
                    <td class="dx-cell" data-label="Use">
                      {r.use}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </Tray>
      <Tray
        id="dx-e-levels"
        title="Elevation"
        description="Values read from the served ui.css. Shadows use light-dark(): in dark mode they are transparent and the rings carry the edge."
      >
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-e-levels-h">
            <table class="tbl stackable dx-props">
              <thead>
                <tr>
                  <th scope="col">Token</th>
                  <th scope="col">Level</th>
                  <th scope="col">Value</th>
                  <th scope="col">Use</th>
                </tr>
              </thead>
              <tbody>
                {ELEVATION.map((row) => (
                  <tr>
                    <th scope="row" class="dx-name">
                      <code>--{row.token}</code>
                    </th>
                    <td class="nowrap" data-label="Level">
                      {row.level}
                    </td>
                    <td class="dx-type" data-label="Value">
                      {tokenValue(row.token)}
                    </td>
                    <td class="dx-cell" data-label="Use">
                      {row.use}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </Tray>
      <Tray
        id="dx-e-samples"
        title="On real components"
        description="This tray is level 0; the panels in it are level 1."
      >
        <Panel variant="pad">
          <div class="dx-row">
            <div class="panel pad">Panel · --panel-ring</div>
            <Button>Secondary · --shadow-raised</Button>
            <Button variant="primary">Primary · --primary-shadow</Button>
            <span class="dx-row">
              <Logo brand="oidc" />
              <Logo brand="openai" />
              Logo tiles · --logo-ring
            </span>
          </div>
        </Panel>
        <Panel variant="pad">
          <Dialog
            id="dx-e-dialog"
            open
            title="Dialog · --shadow-dialog"
            description={
              <>
                Drawn open in the page here. A real dialog floats above the page, over{' '}
                <code>--backdrop</code>; menus and filter popovers use the same shadow.
              </>
            }
            footer={<Button href="/docs/components/layout/dialog">Open the Dialog page</Button>}
          />
        </Panel>
        <Panel variant="pad">
          <ul class="dx-list">
            <li>
              Elevation is for structure, not decoration: a tray groups, a panel holds content, a
              floating surface (dialog, menu, popover) sits above the page.
            </li>
            <li>
              Edges never depend on a shadow alone: every level has a 1px ring, so it stays visible
              in dark mode, where shadows are transparent, and in forced colors, where a border
              replaces the ring.
            </li>
            <li>
              Floating surfaces only open from a button (<code>command</code>,{' '}
              <code>popovertarget</code>) or a <code>details</code>: no hover cards.
            </li>
          </ul>
        </Panel>
      </Tray>
    </>
  ),
};
