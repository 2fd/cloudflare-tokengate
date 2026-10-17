import { Panel, Tray } from '@tokengate/ui';
import type { Foundation } from './types';

const SCALE: ReadonlyArray<{ key: string; size: string; use: string; sample: string }> = [
  { key: '4xl', size: '30 / 36', use: 'KPI and pipeline numbers', sample: '8,214' },
  { key: '3xl', size: '24 / 32', use: 'Page H1', sample: 'Credentials' },
  { key: '2xl', size: '20 / 28', use: 'Entity H1 on detail pages', sample: 'Slack' },
  {
    key: 'xl',
    size: '18 / 26',
    use: 'Dialog titles',
    sample: 'Delete Slack and its 3 issuer access rules?',
  },
  { key: 'lg', size: '16 / 24', use: 'Tray titles, step titles', sample: 'Who can use it' },
  {
    key: 'md',
    size: '14 / 20',
    use: 'Body, tables, labels, buttons',
    sample: 'GitHub Actions (acme) can use 4 tokens.',
  },
  {
    key: 'sm',
    size: '13 / 18',
    use: 'Hints, second lines, breadcrumb',
    sample: 'Owner/name and the numeric ID in brackets.',
  },
  { key: 'xs', size: '12 / 16', use: 'Badges, table headers, meta', sample: 'Requests 24 h' },
];

export const typography: Foundation = {
  slug: 'typography',
  title: 'Typography',
  summary:
    'System fonts only, eight sizes and two weights. Hierarchy comes from size and color, not from bold.',
  render: () => (
    <>
      <Tray
        id="dx-t-scale"
        title="Type scale"
        description="Token, size / line height in px, and where it is used."
      >
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-t-scale-h">
            <table class="tbl stackable dx-type">
              <thead>
                <tr>
                  <th scope="col">Token</th>
                  <th scope="col">Size</th>
                  <th scope="col">Sample</th>
                  <th scope="col">Use</th>
                </tr>
              </thead>
              <tbody>
                {SCALE.map((row) => (
                  <tr>
                    <th scope="row" class="dx-name">
                      <code>--fs-{row.key}</code>
                    </th>
                    <td class="dx-hex" data-label="Size">
                      {row.size}
                    </td>
                    <td class="dx-sample" data-label="Sample">
                      <span class="dx-fs" data-fs={row.key}>
                        {row.sample}
                      </span>
                    </td>
                    <td class="dx-cell" data-label="Use">
                      {row.use}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" class="dx-name">
                    <code>--font-mono</code>
                  </th>
                  <td class="dx-hex" data-label="Size">
                    0.92em
                  </td>
                  <td class="dx-sample" data-label="Sample">
                    <span class="dx-fs" data-fs="mono">
                      svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C
                    </span>
                  </td>
                  <td class="dx-cell" data-label="Use">
                    IDs, slugs, secrets, URLs, code
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </Tray>
      <Tray id="dx-t-rules" title="Rules">
        <Panel variant="pad">
          <ul class="dx-list">
            <li>
              Fonts: <code>--font-sans</code> and <code>--font-mono</code> are system stacks. No web
              fonts: nothing to download, nothing for the CSP to allow.
            </li>
            <li>
              Weights: 400 (<code>--fw-regular</code>) and 500 (<code>--fw-medium</code>) only. The
              one exception is 600 for the bold first sentence of a callout and for logo letters.
            </li>
            <li>
              Headings step down in size: page H1 24, tray title 16, panel content 14. Nothing
              important is muted and nothing trivial is bold.
            </li>
            <li>
              Numbers in tables and KPIs are tabular (<code>.num</code>) and right-aligned, so
              columns line up.
            </li>
            <li>
              IDs are mono and shown in full in an ID chip (<code>.idchip</code>, selectable as a
              whole); CSS ellipsis handles narrow widths.
            </li>
            <li>Text measure: descriptions stop at 70ch; prose at 72ch.</li>
          </ul>
        </Panel>
      </Tray>
    </>
  ),
};
