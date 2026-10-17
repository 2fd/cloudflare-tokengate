import { Panel, Tray } from '@tokengate/ui';
import type { Foundation } from './types';

export const layout: Foundation = {
  slug: 'layout',
  title: 'Layout',
  summary:
    'A fixed sidebar on the left and one content column centered on the whole window, not on the space next to the sidebar. Every block on a page shares the column’s left edge.',
  render: () => (
    <>
      <Tray id="dx-l-column" title="The centered column">
        <Panel variant="pad">
          <div
            class="dx-colmap"
            role="img"
            aria-label="Diagram: sidebar 15rem on the left, then free space, the content column of at most 76rem centered on the window, and free space on the right that is as wide as the sidebar plus the free space on the left"
          >
            <div class="dx-side">sidebar 15rem</div>
            <div class="dx-mainarea">
              <div class="dx-gut">free</div>
              <div class="dx-col">.page · max 76rem + gutters · centered on the window</div>
              <div class="dx-gut">free</div>
            </div>
          </div>
          <div class="dx-prose">
            <p>
              The column is centered on the whole shell (the window in the app), so its center is
              the window’s center at every width the sidebar is visible from 1440px up. Its width is
              the smallest of: the page width (76rem plus the gutters, or the form measure), the
              window minus one sidebar width on each side, and the main area. It never goes below
              60rem (<code>--w-col-min</code>); on windows narrower than about 1440px it then starts
              at the sidebar edge instead of sliding under it. Below 40rem the sidebar becomes a top
              bar and the column simply spans the window.
            </p>
            <p>
              The CSS uses container units: <code>.app</code> is the size container, and{' '}
              <code>100cqi</code> is its width, so the same rule also centers an AppShell drawn
              inside a docs example. Breadcrumb, H1, description, tabs, trays, tables and forms all
              start at the column’s left edge. The column stops growing at 76rem, so dense rows and
              7-column tables keep their proportions on wide screens.
            </p>
          </div>
        </Panel>
      </Tray>
      <Tray id="dx-l-pages" title="Page types">
        <Panel variant="pad">
          <ul class="dx-list">
            <li>
              <b>List and overview pages</b> use the full column.
            </li>
            <li>
              <b>Form pages</b> (a <code>.form-layout</code> directly inside <code>.page</code>)
              narrow the whole page, header included, to the form measure and keep it centered:
              40rem, plus a 24rem summary rail at ≥ 80rem. The header, any prefill callout and the
              form share one left edge. A form inside a tray keeps the full column.
            </li>
            <li>
              <b>Detail pages</b> (<code>.detail</code>) are main + a 20rem right rail at ≥ 80rem;
              below that the rail goes under the main column.
            </li>
            <li>
              The error-level health strip (<code>.hstrip</code>) keeps its full-width background;
              its text lines up with the column edge.
            </li>
          </ul>
        </Panel>
      </Tray>
      <Tray id="dx-l-hierarchy" title="Hierarchy and density">
        <Panel variant="pad">
          <ul class="dx-list">
            <li>
              Three levels: page header (H1 24px) → tray (gray shell, title 16px) → panel (white
              content). Never put a tray inside a panel.
            </li>
            <li>
              Dense but calm: 44px table rows (36px for logs), 40px controls, 3–7 table columns,
              second facts in a 13px meta line instead of extra columns.
            </li>
            <li>One primary button per page header, top right. Everything else is secondary.</li>
          </ul>
        </Panel>
      </Tray>
      <Tray id="dx-l-breakpoints" title="Breakpoints">
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-l-breakpoints-h">
            <table class="tbl stackable">
              <thead>
                <tr>
                  <th scope="col">Width</th>
                  <th scope="col">Gutter</th>
                  <th scope="col">What changes</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">≥ 80rem (1280px)</th>
                  <td data-label="Gutter">32px</td>
                  <td class="dx-cell" data-label="What changes">
                    Detail rail and form summary rail sit beside the main column.
                  </td>
                </tr>
                <tr>
                  <th scope="row">64–80rem</th>
                  <td data-label="Gutter">32px</td>
                  <td class="dx-cell" data-label="What changes">
                    Rails go under the main column; 12-column spans become full width.
                  </td>
                </tr>
                <tr>
                  <th scope="row">40–64rem</th>
                  <td data-label="Gutter">24px</td>
                  <td class="dx-cell" data-label="What changes">
                    Pipeline and trace go to two columns; the connections map drops its wires.
                  </td>
                </tr>
                <tr>
                  <th scope="row">&lt; 48rem</th>
                  <td data-label="Gutter">24px</td>
                  <td class="dx-cell" data-label="What changes">
                    Stackable tables become one card per row; key-value lists stack.
                  </td>
                </tr>
                <tr>
                  <th scope="row">&lt; 40rem (640px)</th>
                  <td data-label="Gutter">16px</td>
                  <td class="dx-cell" data-label="What changes">
                    The sidebar becomes a top bar with a Menu button; everything is one column. No
                    horizontal page scroll down to 320px.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </Tray>
    </>
  ),
};
