import { Badge, Panel, Tray } from '@tokengate/ui';
import type { Foundation } from './types';

export const status: Foundation = {
  slug: 'status',
  title: 'Status vocabulary',
  summary:
    'Status is always a word. A glyph and a color only add to it, so it reads the same in both schemes, in forced colors and to a screen reader.',
  render: () => (
    <>
      <Tray id="dx-st-table" title="Words, badges and dense rows">
        <Panel variant="flush">
          <div class="scroll" role="region" tabindex={0} aria-labelledby="dx-st-table-h">
            <table class="tbl stackable">
              <thead>
                <tr>
                  <th scope="col">Meaning</th>
                  <th scope="col">Badge</th>
                  <th scope="col">Dense row</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Active</th>
                  <td data-label="Badge">
                    <Badge tone="ok" glyph="✓">
                      Active
                    </Badge>
                  </td>
                  <td data-label="Dense row">
                    <span class="st">Active</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Expires soon</th>
                  <td data-label="Badge">
                    <Badge tone="warn" glyph="⌛">
                      Expires in 6 days
                    </Badge>
                  </td>
                  <td data-label="Dense row">
                    <span class="st warn">Expires in 6 days</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Expired</th>
                  <td data-label="Badge">
                    <Badge tone="bad" glyph="✕">
                      Expired
                    </Badge>
                  </td>
                  <td data-label="Dense row">
                    <span class="st bad">Expired</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Risk accepted</th>
                  <td data-label="Badge">
                    <Badge tone="warn" glyph="⚠">
                      Risk accepted
                    </Badge>
                  </td>
                  <td data-label="Dense row">
                    <span class="st warn">Risk accepted</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Pending approval</th>
                  <td data-label="Badge">
                    <Badge tone="info" glyph="◐">
                      Pending approval
                    </Badge>
                  </td>
                  <td data-label="Dense row">
                    <span class="st info">Pending approval</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Disabled</th>
                  <td data-label="Badge">
                    <Badge tone="off" glyph="⏸">
                      Disabled
                    </Badge>
                  </td>
                  <td data-label="Dense row">
                    <span class="st off">Disabled</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">No secret</th>
                  <td data-label="Badge">
                    <Badge tone="bad" glyph="–">
                      No secret
                    </Badge>
                  </td>
                  <td data-label="Dense row">
                    <span class="faint">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </Tray>
      <Tray id="dx-st-labels" title="Labels">
        <Panel variant="pad">
          <p class="dx-row">
            <Badge tone="accent">Most used</Badge> <Badge>Owner</Badge>{' '}
            <Badge tone="outline">You</Badge> <span class="risktag">⚠ Risk</span>
          </p>
          <ul class="dx-list">
            <li>Labels are facts about an item, not a status: “Most used”, “Owner”, “You”.</li>
            <li>The risk tag marks an option that needs an explicit acceptance before submit.</li>
          </ul>
        </Panel>
      </Tray>
      <Tray id="dx-st-rules" title="Rules">
        <Panel variant="pad">
          <ul class="dx-list">
            <li>
              Always the word. A dot (<code>.st</code>, <code>.dot</code>) never stands alone.
            </li>
            <li>
              Glyphs are text: <code>aria-hidden="true"</code> on a standalone glyph span, and the
              word stays for assistive tech.
            </li>
            <li>
              Badges for a status in a header or a card; the dot + text form in dense rows and
              tables.
            </li>
            <li>
              Only the worst KPI takes a tone. Inactive things are dashed (<code>.off</code>), not
              just gray.
            </li>
            <li>Use these exact words. Do not invent synonyms (“Live”, “Revoked”, “Error”).</li>
          </ul>
        </Panel>
      </Tray>
    </>
  ),
};
