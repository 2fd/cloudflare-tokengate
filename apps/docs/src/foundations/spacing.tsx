import { Panel, Tray } from '@tokengate/ui';
import type { Foundation } from './types';

const SPACE: ReadonlyArray<[string, number, string]> = [
  ['1', 4, 'Icon to text, badge padding'],
  ['2', 8, 'Label → hint → input; button gaps'],
  ['3', 12, 'Row padding, chip gaps'],
  ['4', 16, 'Between header rows; tray header padding'],
  ['5', 20, 'Panel padding'],
  ['6', 24, 'Between form fields; grid gaps'],
  ['7', 32, 'Between top-level blocks; desktop gutter'],
  ['8', 40, ''],
  ['9', 48, ''],
  ['10', 64, 'Bottom of the page'],
];

const SIZES: ReadonlyArray<[string, string, string]> = [
  ['--h-control', '40', 'Inputs, selects, buttons'],
  ['--h-control-sm', '32', 'Small buttons (row actions, tray actions)'],
  ['--h-chip', '28', 'Relationship chips'],
  ['--h-badge', '22', 'Badges, ID chips'],
  ['--h-row', '44', 'Table rows'],
  ['--h-row-dense', '36', 'Log rows (.tbl.dense)'],
  ['--h-node', '56', 'Connections map nodes (64px pitch with the 8px gap)'],
  ['--w-sidebar', '240', 'Sidebar (15rem)'],
  ['--w-content-max', '1216', 'Centered content column (76rem), plus the gutters'],
  ['--w-form', '640', 'Form measure (40rem)'],
  ['--w-rail', '320', 'Right rail on detail pages (20rem)'],
  ['--w-rail-form', '384', 'Summary rail on form pages (24rem)'],
];

export const spacing: Foundation = {
  slug: 'spacing',
  title: 'Spacing and sizes',
  summary:
    'A 4px base, ten spacing steps, five radii and fixed control heights. Only these values appear in the CSS.',
  render: () => (
    <>
      <Tray id="dx-s-space" title="Spacing" description="--sp-1 to --sp-10, in px.">
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-s-space-h">
            <table class="tbl stackable">
              <thead>
                <tr>
                  <th scope="col">Token</th>
                  <th scope="col" class="num">
                    px
                  </th>
                  <th scope="col">Scale</th>
                  <th scope="col">Typical use</th>
                </tr>
              </thead>
              <tbody>
                {SPACE.map(([key, px, use]) => (
                  <tr>
                    <th scope="row" class="dx-name">
                      <code>--sp-{key}</code>
                    </th>
                    <td class="num" data-label="px">
                      {px}
                    </td>
                    <td data-label="Scale">
                      <span class="dx-bar" data-sp={key} aria-hidden="true" />
                    </td>
                    <td class="dx-cell" data-label="Typical use">
                      {use || <span class="faint">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </Tray>
      <Tray id="dx-s-rhythm" title="Rhythm">
        <Panel variant="pad">
          <ul class="dx-list">
            <li>
              32px between top-level blocks: header → first tray, tray → tray (<code>.page</code>,{' '}
              <code>.stack</code>).
            </li>
            <li>
              16px between the rows of a page header (<code>.ph</code>).
            </li>
            <li>
              24px between form fields (<code>.fields</code>); 8px from a label to its hint and
              input (<code>.field</code>).
            </li>
            <li>4px between panels stacked in one tray.</li>
          </ul>
        </Panel>
      </Tray>
      <Tray id="dx-s-radius" title="Radius">
        <Panel variant="pad">
          <ul class="dx-radii">
            <li>
              <span class="dx-radius" data-r="1" aria-hidden="true" />
              --r-1 4 · badges, chips
            </li>
            <li>
              <span class="dx-radius" data-r="2" aria-hidden="true" />
              --r-2 6 · controls, logos
            </li>
            <li>
              <span class="dx-radius" data-r="3" aria-hidden="true" />
              --r-3 8 · panels, cards
            </li>
            <li>
              <span class="dx-radius" data-r="4" aria-hidden="true" />
              --r-4 12 · trays, dialogs
            </li>
            <li>
              <span class="dx-radius" data-r="pill" aria-hidden="true" />
              --r-pill
            </li>
          </ul>
        </Panel>
      </Tray>
      <Tray id="dx-s-sizes" title="Heights and widths">
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-s-sizes-h">
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
                {SIZES.map(([token, px, use]) => (
                  <tr>
                    <th scope="row" class="dx-name">
                      <code>{token}</code>
                    </th>
                    <td class="num" data-label="px">
                      {px}
                    </td>
                    <td class="dx-cell" data-label="Use">
                      {use}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </Tray>
    </>
  ),
};
