import { Badge, Button, ICON_NAMES, Icon, Logo, Panel, Tray, type IconName } from '@tokengate/ui';
import type { Foundation } from './types';

const USE: Record<IconName, string> = {
  gate: 'tokengate itself: the shield mark, “tokengate checks the call”',
  monitoring: 'Sidebar: Monitoring',
  token: 'Sidebar: Credentials; the OIDC logo tile',
  consumer: 'Sidebar: Credential access rules; empty issuer access rules',
  users: 'Sidebar: Users',
  user: 'One person: empty people list',
  search: 'Search fields, “Find a request”',
  'arrow-right': '“Continue” links, consumer → token',
  system: 'System actors (hourly jobs) in the feed',
  home: 'Docs: Overview',
  palette: 'Docs: Foundations',
  component: 'Docs: Base components',
  form: 'Docs: Forms',
  layout: 'Docs: Layout',
  table: 'Docs: Data, tables',
  chart: 'Docs: Visualization, charts',
  help: 'Sidebar: FAQ',
};

const GLYPHS: ReadonlyArray<[string, string]> = [
  ['✓', 'Active, passed, done'],
  ['⌛', 'Expires soon'],
  ['✕', 'Expired, denied, failed'],
  ['⚠', 'Risk, risk accepted, inactive relation'],
  ['◐', 'Pending approval'],
  ['⏸', 'Disabled'],
  ['–', 'No secret'],
  ['i', 'Note (info callout)'],
  ['+', 'Create actions (“+ Add credential”)'],
  ['→', 'Goes to, can use'],
  ['▾', 'Opens a menu'],
];

export const iconography: Foundation = {
  slug: 'iconography',
  title: 'Iconography',
  summary:
    'One small set of inline-SVG outline icons, text glyphs for status, and letter tiles for brands. None of them carries meaning alone.',
  render: () => (
    <>
      <Tray
        id="dx-i-set"
        title="Icon set"
        count={ICON_NAMES.length}
        description="Icon component: 16px, 24-unit grid, stroke 1.6 in currentColor, round caps and joins, no fills."
      >
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-i-set-h">
            <table class="tbl stackable">
              <thead>
                <tr>
                  <th scope="col">Icon</th>
                  <th scope="col">Name</th>
                  <th scope="col">Use</th>
                </tr>
              </thead>
              <tbody>
                {ICON_NAMES.map((name) => (
                  <tr>
                    <td data-label="Icon">
                      <Icon name={name} />
                    </td>
                    <th scope="row" class="dx-name">
                      <code>{name}</code>
                    </th>
                    <td class="dx-cell" data-label="Use">
                      {USE[name]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel variant="pad">
          <div class="dx-row">
            <Button icon="search">Find a request</Button>
            <Button variant="primary" icon="token">
              Add credential
            </Button>
            <span class="t-warn dx-row">
              <Icon name="monitoring" />
              Takes the color of its text
            </span>
          </div>
        </Panel>
      </Tray>
      <Tray
        id="dx-i-glyphs"
        title="Status glyphs"
        description="Text characters, not icons: they scale with the type and survive forced colors. Always aria-hidden, always next to the word."
      >
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-i-glyphs-h">
            <table class="tbl stackable">
              <thead>
                <tr>
                  <th scope="col">Glyph</th>
                  <th scope="col">Means</th>
                </tr>
              </thead>
              <tbody>
                {GLYPHS.map(([glyph, means]) => (
                  <tr>
                    <th scope="row" class="dx-fs" data-fs="lg">
                      <span aria-hidden="true">{glyph}</span>
                      <span class="vh">{means}</span>
                    </th>
                    <td class="dx-cell" data-label="Means">
                      {means}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel variant="pad">
          <div class="dx-row">
            <Badge status="active" />
            <Badge status="expiring">Expires in 6 days</Badge>
            <Badge status="expired" />
            <Badge status="pending" />
            <Badge status="disabled" />
          </div>
        </Panel>
      </Tray>
      <Tray
        id="dx-i-logos"
        title="Brand tiles"
        description="Upstream credentials and CI systems are letter tiles in the brand color (Logo), never images from another origin."
      >
        <Panel variant="pad">
          <div class="dx-row">
            <Logo brand="slack" />
            <Logo brand="openai" />
            <Logo brand="anthropic" />
            <Logo brand="github" />
            <Logo brand="discord" />
            <Logo brand="gitlab" />
            <Logo brand="buildkite" />
            <Logo brand="oidc" />
            <Logo brand="custom" />
            <Logo brand="slack" disabled />
          </div>
        </Panel>
      </Tray>
      <Tray id="dx-i-rules" title="Rules">
        <Panel variant="pad">
          <ul class="dx-list">
            <li>Every icon sits next to a word. There are no icon-only buttons or links.</li>
            <li>
              Icons are decorative (<code>aria-hidden</code>). Give <code>label</code> only when the
              icon stands for a word that is not on screen.
            </li>
            <li>
              Icons are inline SVG from <code>Icon</code>: no sprite, no icon font, no external
              file, nothing for the CSP to block. A new icon is added to the set, not pasted into a
              page.
            </li>
            <li>
              Status is a glyph + a word + a color; the glyph never replaces the word (see{' '}
              <a href="/docs/foundations/status">Status vocabulary</a>).
            </li>
          </ul>
        </Panel>
      </Tray>
    </>
  ),
};
